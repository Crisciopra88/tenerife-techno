// /api/sync — Worker automatico (Vercel Cron). Niente Oxylabs, niente Instagram.
// Gira ogni notte (vedi vercel.json): legge le fonti approvate, estrae gli eventi
// e li scrive da solo nel Google Sheet. Auto-publish, dedup per nome+data.
//
// ENV richieste su Vercel:
//   SHEET_ID, SHEET_TAB(=eventi),
//   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,
//   CRON_SECRET (opzionale)

import { google } from "googleapis";
import * as cheerio from "cheerio";

const SHEET_ID  = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || "eventi";
const COLUMNS = ["nome","promoter","giorno","mese","anno","genere","location","artisti","link","instagram","stato"];
const MESI = ["Gen","Feb","Mar","Apr","Mag","Giu","Lug","Ago","Set","Ott","Nov","Dic"];
const MAX_PER_SOURCE = 60;     // tetto per non sforare il timeout della funzione

/* ============================================================
   FONTI APPROVATE
   - Xceed: API ufficiale "Open Event API" (no auth), interrogata per canale.
   - "jsonld": dati strutturati schema.org/Event nella pagina.
   defaultPromoter: usato quando non si ricava dal venue
   ============================================================ */

// Xceed — canali (promoter) di Tenerife da leggere via API ufficiale.
// "papagayo-tenerife" copre PIÙ locali (Papagayo, Anfiteatro Siam Park, Sala El Nido...).
// Per aggiungere altri promoter su Xceed, basta mettere qui il loro slug-canale.
const XCEED_CHANNELS = ["papagayo-tenerife"];
const XCEED_API = "https://events.xceed.me/v1/events";

const SOURCES = [
  { name:"Resident Advisor",  strategy:"jsonld", url:"https://es.ra.co/events/es/canaryislands/techno", defaultPromoter:"indie" },
  { name:"Noctámbula",        strategy:"jsonld", url:"https://www.noctambulatenerife.com", defaultPromoter:"noctambula" },
  { name:"La Central",        strategy:"jsonld", url:"https://lacentraldiscoteca.com/events/", defaultPromoter:"central" },
  { name:"Kendo (TicketLop)", strategy:"jsonld", url:"https://entradas.ticketlop.es/organizers/kendo-lounge-bar", defaultPromoter:"kendo" },
  { name:"Wild Tenerife",     strategy:"jsonld", url:"https://wildtenerife.es", defaultPromoter:"wild" },
  { name:"Farra World",       strategy:"jsonld", url:"https://farra.world", defaultPromoter:"farra" },
  { name:"GreenWorld",        strategy:"jsonld", url:"https://greenworldfestival.eu", defaultPromoter:"greenworld" },
  { name:"NRG",               strategy:"jsonld", url:"https://www.nrg-raves.com", defaultPromoter:"nrg" },
  { name:"Achamán",           strategy:"jsonld", url:"https://achamandisco.com", defaultPromoter:"achaman" },
  // Songkick — locali di Tenerife non presenti su Xceed (date reali via schema.org/Event)
  { name:"Songkick · Monkey Beach", strategy:"jsonld", url:"https://www.songkick.com/venues/3600314-monkey-beach-club", defaultPromoter:"indie" },
  { name:"Songkick · Magma",        strategy:"jsonld", url:"https://www.songkick.com/es/venues/1896588-magma-arte-and-congresos", defaultPromoter:"blackworks" },
  { name:"Songkick · Tenerife",     strategy:"jsonld", url:"https://www.songkick.com/es/metro-areas/28788-spain-santa-cruz-de-tenerife", defaultPromoter:"indie" },
  // Ravers è su Skiddle: conferma l'URL esatto della pagina Tenerife/Ravers se serve
  { name:"Skiddle (Ravers)",  strategy:"jsonld", url:"https://www.skiddle.com/whats-on/Tenerife/", defaultPromoter:"indie" }
  // NB: BlackWorks e Mala Mía hanno solo Instagram -> restano a mano nel foglio
];

// venue -> promoter (per Xceed, dove un solo dominio elenca più locali)
function venueToPromoter(venue, fallback) {
  const v = (venue || "").toLowerCase();
  if (v.includes("papagayo") || v.includes("el nido")) return "papagayo";
  if (v.includes("magma"))    return "blackworks";
  if (v.includes("golf"))     return "farra";
  return fallback;
}

/* ---- Google Sheets (service account) ---- */
async function sheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; TenerifeTechnoBot/1.0)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
  return res.text();
}

/* ---- date helpers ---- */
function fromISO(iso) {                       // "2026-06-28T23:00..." -> {giorno,mese}
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return fromText(iso);
  return { giorno: String(+m[3]), mese: MESI[+m[2]-1] || "" };
}
function fromText(t) {                         // "Sun. 28th June 2026" -> {giorno,mese}
  if (!t) return { giorno: "", mese: "" };
  const s = t.toLowerCase();
  const day = (s.match(/\b(\d{1,2})(st|nd|rd|th)?\b/) || [])[1] || "";
  const idx = ["jan|gen","feb","mar","apr","may|mag","jun|giu|june|junio",
               "jul|lug|july|julio","aug|ago","sep|set","oct|ott","nov","dec|dic"]
              .findIndex(p => new RegExp(p).test(s));
  return { giorno: day, mese: idx >= 0 ? MESI[idx] : "" };
}

/* ---- estrattore JSON-LD schema.org/Event ---- */
function parseJsonLd(html, source) {
  const $ = cheerio.load(html);
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let json; try { json = JSON.parse($(el).contents().text()); } catch { return; }
    const items = Array.isArray(json) ? json : (json["@graph"] || [json]);
    for (const it of items) {
      const type = it && it["@type"];
      const isEvent = type === "Event" || (Array.isArray(type) && type.includes("Event")) ||
                      (typeof type === "string" && /Event/i.test(type));
      if (!isEvent) continue;
      const { giorno, mese } = fromISO(it.startDate);
      const loc = it.location && (it.location.name || (it.location.address && it.location.address.addressLocality)) || "";
      out.push({
        nome: (it.name || "").trim(),
        promoter: venueToPromoter(loc, source.defaultPromoter),
        giorno, mese, anno: 2026,
        genere: "", location: loc, artisti: "",
        link: it.url || source.url, instagram: "", stato: ""
      });
    }
  });
  return out;
}

/* ---- Xceed: API ufficiale Open Event API (no auth) ---- */
async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; TenerifeTechnoBot/1.0)", "Accept": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
  return res.json();
}

// startingTime (UNIX, secondi) -> {giorno, mese, anno}.
// Tenerife usa fuso ~UTC (i dati Xceed riportano timezone Europe/London), quindi UTC va bene.
function fromUnix(ts) {
  if (!ts) return { giorno: "", mese: "", anno: 2026 };
  const d = new Date(ts * 1000);
  return { giorno: String(d.getUTCDate()), mese: MESI[d.getUTCMonth()] || "", anno: d.getUTCFullYear() };
}

async function parseXceed() {
  const out = [];
  const now = Math.floor(Date.now() / 1000);       // solo eventi futuri
  const limit = 100;
  for (const ch of XCEED_CHANNELS) {
    let offset = 0;
    for (let page = 0; page < 10; page++) {          // tetto: 10 pagine = 1000 eventi/canale
      let json;
      try {
        json = await fetchJson(`${XCEED_API}?channel=${encodeURIComponent(ch)}&startTime=${now}&limit=${limit}&offset=${offset}`);
      } catch (e) { console.error(`Xceed ${ch} KO:`, e.message); break; }
      const data = (json && json.data) || [];
      if (!data.length) break;
      for (const ev of data) {
        const venue   = (ev.venue && ev.venue.name) || "";
        const { giorno, mese, anno } = fromUnix(ev.startingTime);
        const genere  = (ev.musicGenres && ev.musicGenres[0] && ev.musicGenres[0].name) || "";
        const artisti = (ev.lineup || []).map(a => a && a.name).filter(Boolean).join(", ");
        const link    = (ev.slug && ev.legacyId)
          ? `https://xceed.me/en/tenerife/event/${ev.slug}/${ev.legacyId}`
          : (ev.externalSalesUrl || "");
        const nome = String(ev.name || "").split("·")[0].trim() || String(ev.name || "").trim();
        if (nome) out.push({
          nome,
          promoter: venueToPromoter(venue, "papagayo"),
          giorno, mese, anno,
          genere, location: venue.trim(), artisti,
          link, instagram: "", stato: ""
        });
      }
      if (data.length < limit) break;
      offset += limit;
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: "unauthorized" });

  try {
    const sheets = await sheetsClient();
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_TAB}!A:K` });
    const rows = existing.data.values || [];
    const hasHeader = rows.length && (rows[0][0] || "").toLowerCase() === "nome";
    const seen = new Set((hasHeader ? rows.slice(1) : rows)
      .map(r => `${(r[0]||"").toLowerCase()}|${r[2]||""}|${r[3]||""}`));

    let found = [];

    // Xceed via API ufficiale (Open Event API) — per canale, multi-locale
    try {
      const evs = await parseXceed();
      console.log(`Xceed (API): ${evs.length} eventi`);
      found = found.concat(evs);
    } catch (e) { console.error("Xceed (API) KO:", e.message); }

    // Altre fonti (JSON-LD schema.org/Event)
    for (const s of SOURCES) {
      try {
        const evs = parseJsonLd(await fetchText(s.url), s);
        console.log(`${s.name}: ${evs.length} eventi`);
        found = found.concat(evs);
      } catch (e) { console.error(`Fonte KO ${s.name}:`, e.message); }
    }

    const toAppend = [];
    for (const ev of found) {
      if (!ev.nome) continue;
      const key = `${ev.nome.toLowerCase()}|${ev.giorno||""}|${ev.mese||""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      toAppend.push(COLUMNS.map(c => ev[c] ?? ""));
    }

    if (toAppend.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${SHEET_TAB}!A:K`,
        valueInputOption: "RAW", requestBody: { values: toAppend }
      });
    }
    return res.status(200).json({ ok: true, scansionati: found.length, aggiunti: toAppend.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
