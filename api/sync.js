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
   strategy: "xceed"  -> sitemap + meta tag OG delle pagine evento
             "jsonld" -> dati strutturati schema.org/Event nella pagina
   defaultPromoter: usato quando non si ricava dal venue
   ============================================================ */
const SOURCES = [
  { name:"Xceed Tenerife",    strategy:"xceed",  url:"https://xceed.me/sitemap.xml", defaultPromoter:"indie" },
  { name:"Resident Advisor",  strategy:"jsonld", url:"https://es.ra.co/events/es/canaryislands/techno", defaultPromoter:"indie" },
  { name:"Noctámbula",        strategy:"jsonld", url:"https://www.noctambulatenerife.com", defaultPromoter:"noctambula" },
  { name:"La Central",        strategy:"jsonld", url:"https://lacentraldiscoteca.com/events/", defaultPromoter:"central" },
  { name:"Kendo (TicketLop)", strategy:"jsonld", url:"https://entradas.ticketlop.es/organizers/kendo-lounge-bar", defaultPromoter:"kendo" },
  { name:"Wild Tenerife",     strategy:"jsonld", url:"https://wildtenerife.es", defaultPromoter:"wild" },
  { name:"Farra World",       strategy:"jsonld", url:"https://farra.world", defaultPromoter:"farra" },
  { name:"GreenWorld",        strategy:"jsonld", url:"https://greenworldfestival.eu", defaultPromoter:"greenworld" },
  { name:"NRG",               strategy:"jsonld", url:"https://www.nrg-raves.com", defaultPromoter:"nrg" },
  { name:"Achamán",           strategy:"jsonld", url:"https://achamandisco.com", defaultPromoter:"achaman" },
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
        promoter: source.defaultPromoter,
        giorno, mese, anno: 2026,
        genere: "", location: loc, artisti: "",
        link: it.url || source.url, instagram: "", stato: ""
      });
    }
  });
  return out;
}

/* ---- Xceed: sitemap -> pagine evento -> meta tag OG ---- */
async function parseXceed(source) {
  let urls = [];
  try {
    const sm = await fetchText(source.url);
    const all = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    // sitemap index: scendi nei sub-sitemap che parlano di tenerife/eventi
    const subs = all.filter(u => /event|tenerife/i.test(u) && u.endsWith(".xml"));
    for (const s of subs.slice(0, 5)) {
      try { const x = await fetchText(s);
            urls.push(...[...x.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])); } catch {}
    }
    if (!urls.length) urls = all;
  } catch (e) { console.error("Xceed sitemap KO:", e.message); return []; }

  urls = urls.filter(u => /\/tenerife\/event\//.test(u)).slice(0, MAX_PER_SOURCE);
  const out = [];
  for (const u of urls) {
    try {
      const html = await fetchText(u);
      const $ = cheerio.load(html);
      const og = n => $(`meta[property="og:${n}"]`).attr("content") || $(`meta[name="twitter:${n}"]`).attr("content") || "";
      const title = og("title"); const desc = og("description");
      const venue = (desc.match(/\bat ([^.]+?)(?:\son\b|\.|$)/i) || [])[1] || "";
      const { giorno, mese } = fromText(title + " " + desc);
      const genere = (desc.match(/A great ([^.]+?) event/i) || [])[1] || "";
      if (title) out.push({
        nome: title.replace(/\s·\s(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b.*$/i, "").trim(),
        promoter: venueToPromoter(venue, source.defaultPromoter),
        giorno, mese, anno: 2026, genere,
        location: venue.trim(), artisti: "", link: u, instagram: "", stato: ""
      });
    } catch (e) { console.error("evento KO:", u, e.message); }
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
    for (const s of SOURCES) {
      try {
        const evs = s.strategy === "xceed" ? await parseXceed(s)
                                            : parseJsonLd(await fetchText(s.url), s);
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
