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
const COLUMNS = ["nome","promoter","giorno","mese","anno","genere","location","artisti","link","instagram","stato","categoria"];
const MESI = ["Gen","Feb","Mar","Apr","Mag","Giu","Lug","Ago","Set","Ott","Nov","Dic"];
const EN_MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const MAX_PER_SOURCE = 60;     // tetto per non sforare il timeout della funzione
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* ============================================================
   FONTI APPROVATE
   - Xceed: API ufficiale "Open Event API" (no auth), interrogata per canale/locale.
   - "jsonld": dati strutturati schema.org/Event nella pagina.
   - "tickettailor": elenco MuchoHype (Farra/Las Rocas) + lettura schede evento.
   - "tomaticket": pagina Música di Tomaticket (via Jina, render).
   - render:true => la pagina viene aperta da Jina (esegue JS + bypassa anti-bot).
   defaultPromoter: usato quando non si ricava dal venue
   ============================================================ */

// Xceed — API ufficiale. Interroghiamo sia per CANALE (promoter) sia per LOCALE.
const XCEED_CHANNELS = ["papagayo-tenerife"];
const XCEED_VENUES = [
  "papagayo-tenerife",
  "anfiteatro-de-siam-park",
  "magma-tenerife",
  "the-beach-at-hard-rock-hotel-tenerife",
  "centre-equestre-xanadu"
];
const XCEED_API = "https://events.xceed.me/v1/events";

const SOURCES = [
  { name:"Resident Advisor",  strategy:"jsonld", url:"https://es.ra.co/events/es/canaryislands/techno", defaultPromoter:"indie", cat:"Club" },
  { name:"Noctámbula",        strategy:"jsonld", url:"https://www.noctambulatenerife.com", defaultPromoter:"noctambula", cat:"Festival" },
  { name:"La Central",        strategy:"jsonld", url:"https://lacentraldiscoteca.com/events/", defaultPromoter:"central", cat:"Club" },
  { name:"Kendo (TicketLop)", strategy:"jsonld", url:"https://entradas.ticketlop.es/organizers/kendo-lounge-bar", defaultPromoter:"kendo", cat:"Club" },
  { name:"Wild Tenerife",     strategy:"jsonld", url:"https://wildtenerife.es", defaultPromoter:"wild", cat:"Club" },
  { name:"Farra World",       strategy:"jsonld", url:"https://farra.world", defaultPromoter:"farra", cat:"Festival" },
  { name:"GreenWorld",        strategy:"jsonld", url:"https://greenworldfestival.eu", defaultPromoter:"greenworld", cat:"Festival" },
  { name:"NRG",               strategy:"jsonld", url:"https://www.nrg-raves.com", defaultPromoter:"nrg", cat:"Festival" },
  { name:"Achamán",           strategy:"jsonld", url:"https://achamandisco.com", defaultPromoter:"achaman", cat:"Club" },

  // FARRA / LAS ROCAS — biglietteria ufficiale 2026 = Entradas.top (365top.farra.world).
  // La home elenca gli eventi ed è leggibile (no JS, no anti-bot): nome, data, locale.
  { name:"Farra / Las Rocas (365top)", strategy:"farra365", render:true, url:"https://365top.farra.world", defaultPromoter:"farra", cat:"Club" },

  // CONCERTI via Jina Reader (render JS + bypass anti-bot).
  { name:"Songkick · Tenerife", strategy:"jsonld",     render:true, url:"https://www.songkick.com/es/metro-areas/28788-spain-santa-cruz-de-tenerife", defaultPromoter:"indie", cat:"Concerto" },
  { name:"Tomaticket · Música", strategy:"tomaticket", render:true, url:"https://www.tomaticket.es/etiqueta/musica/?IdLugar=51", defaultPromoter:"indie", cat:"Concerto" },

  // Ravers è su Skiddle: conferma l'URL esatto della pagina Tenerife/Ravers se serve
  { name:"Skiddle (Ravers)",  strategy:"jsonld", url:"https://www.skiddle.com/whats-on/Tenerife/", defaultPromoter:"indie", cat:"Festival" }
  // NB: BlackWorks e Mala Mía hanno solo Instagram -> restano a mano nel foglio
];

// venue -> promoter (per Xceed/Ticket Tailor, dove un dominio elenca più locali)
function venueToPromoter(venue, fallback) {
  const v = (venue || "").toLowerCase();
  if (v.includes("papagayo") || v.includes("el nido")) return "papagayo";
  if (v.includes("magma"))    return "blackworks";
  if (v.includes("rocas") || v.includes("golf")) return "farra";
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
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
  return res.text();
}

// Jina Reader: apre la pagina come un browser (esegue il JavaScript e supera il
// blocco anti-bot) e ci restituisce l'HTML renderizzato. Gratis, senza chiave.
const JINA = "https://r.jina.ai/";
async function fetchRendered(url) {
  const res = await fetch(JINA + url, {
    headers: { "User-Agent": UA, "Accept": "text/html", "X-Return-Format": "html", "X-Timeout": "30" }
  });
  if (!res.ok) throw new Error(`Jina HTTP ${res.status} su ${url}`);
  return res.text();
}

/* ---- date helpers ---- */
function fromISO(iso) {                       // "2026-06-28T23:00..." -> {giorno,mese,anno}
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) { const t = fromText(iso); return { ...t, anno: 2026 }; }
  return { giorno: String(+m[3]), mese: MESI[+m[2]-1] || "", anno: +m[1] };
}
function fromText(t) {                         // "Sun. 28th June 2026" -> {giorno,mese}
  if (!t) return { giorno: "", mese: "" };
  const s = t.toLowerCase();
  const day = (s.match(/\b(\d{1,2})(st|nd|rd|th)?\b/) || [])[1] || "";
  const idx = ["jan|gen|enero","feb","mar","apr|abr","may|mag|mayo","jun|giu|june|junio",
               "jul|lug|july|julio","aug|ago","sep|set","oct|ott","nov","dec|dic"]
              .findIndex(p => new RegExp(p).test(s));
  return { giorno: day, mese: idx >= 0 ? MESI[idx] : "" };
}
// "Sat 23 Aug 2025" -> {giorno,mese,anno}
function fromEnDate(text) {
  const m = (text || "").match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})/i);
  if (!m) return null;
  return { giorno: String(+m[1]), mese: MESI[EN_MONTHS.indexOf(m[2].slice(0,3).toLowerCase())] || "", anno: +m[3] };
}

/* ---- estrattore JSON-LD schema.org/Event (gestisce @graph, ItemList, item) ---- */
function eventNodes(json) {
  const nodes = [];
  const visit = (n) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n !== "object") return;
    nodes.push(n);
    visit(n["@graph"]); visit(n.itemListElement); visit(n.item);
  };
  visit(json);
  return nodes;
}
function parseJsonLd(html, source) {
  const $ = cheerio.load(html);
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let json; try { json = JSON.parse($(el).contents().text()); } catch { return; }
    for (const it of eventNodes(json)) {
      const type = it && it["@type"];
      const isEvent = type === "Event" || (Array.isArray(type) && type.some(t => /Event/i.test(t))) ||
                      (typeof type === "string" && /Event/i.test(type));
      if (!isEvent || (!it.name && !it.startDate)) continue;
      const { giorno, mese, anno } = fromISO(it.startDate);
      const locRaw = it.location && (it.location.name || (it.location.address && (it.location.address.addressLocality || it.location.address)));
      const loc = typeof locRaw === "string" ? locRaw : "";
      out.push({
        nome: (it.name || "").trim(),
        promoter: venueToPromoter(loc, source.defaultPromoter),
        giorno, mese, anno: anno || 2026,
        genere: "", location: loc, artisti: "",
        link: it.url || source.url, instagram: "", stato: "",
        categoria: source.cat || "Club"
      });
    }
  });
  return out.slice(0, MAX_PER_SOURCE);
}

/* ---- Tomaticket: pagina lista (via Jina). Tiene i concerti, scarta il turismo ---- */
const TOMATICKET_JUNK = /siam park|loro parque|teide|candlelight|go.?fit|healthy nation|forestal|wildlife|warner|disney|port ?aventura|soplao|museo|visita guiada|jungle|aqualand|monkey park|tour|excursi|combo|men[uú]|brunch buffet/i;
function parseTomaticket(html, source) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href*="/entradas-"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    let nome = ($(el).attr("title") || $(el).text() || "").trim().split("\n")[0].trim();
    if (!nome || nome.length < 3) return;
    if (TOMATICKET_JUNK.test(nome) || TOMATICKET_JUNK.test(href)) return;
    const key = nome.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const link = href.startsWith("http") ? href : ("https://www.tomaticket.es" + href);
    const { giorno, mese } = fromText($(el).text());
    out.push({
      nome,
      promoter: source.defaultPromoter,
      giorno, mese, anno: 2026,
      genere: "", location: "Tenerife", artisti: "",
      link, instagram: "", stato: giorno ? "" : "ricorrente",
      categoria: "Concerto"
    });
  });
  return out.slice(0, MAX_PER_SOURCE);
}

/* ---- Ticket Tailor (MuchoHype = Farra/Las Rocas) ----
   Legge l'elenco, raccoglie i link delle schede, poi legge ogni scheda. */
async function parseTicketTailor(listingHtml, source) {
  const $ = cheerio.load(listingHtml);
  const ids = new Set();
  $('a[href*="/events/muchohype/"]').each((_, el) => {
    const m = ($(el).attr("href") || "").match(/\/events\/muchohype\/(\d+)/);
    if (m) ids.add(m[1]);
  });
  const out = [];
  let n = 0;
  for (const id of ids) {
    if (n++ >= MAX_PER_SOURCE) break;
    const url = `https://tickets.muchohype.com/events/muchohype/${id}`;
    try {
      const ev = parseTicketTailorDetail(await fetchText(url), source, url);
      if (ev && ev.nome) out.push(ev);
    } catch (e) { console.error("TicketTailor scheda KO", id, e.message); }
  }
  return out;
}
function parseTicketTailorDetail(html, source, url) {
  const $ = cheerio.load(html);
  let nome = ($('h1').first().text() || "").trim();
  if (!nome) nome = ($('meta[property="og:title"]').attr("content") || "").replace(/^Comprar entradas\s*[–-]\s*/i, "").trim();
  if (!nome) return null;
  const text = $.root().text().replace(/\s+/g, " ");
  const d = fromEnDate(text) || { giorno: "", mese: "", anno: 2026 };
  let location = "Las Rocas Beach Club";
  const lm = text.match(/([A-Za-zÁÉÍÓÚÑáéíóúñ0-9 .'&-]+?),\s*Costa Adeje/);
  if (lm) location = lm[1].trim();
  // "GORDO | El ritmo que enciende TUMBAO" -> "GORDO" (parte prima della |)
  const nomePulito = nome.split("|")[0].trim() || nome;
  return {
    nome: nomePulito,
    promoter: venueToPromoter(location, source.defaultPromoter || "farra"),
    giorno: d.giorno, mese: d.mese, anno: d.anno || 2026,
    genere: "", location, artisti: "",
    link: url, instagram: "", stato: "", categoria: source.cat || "Club"
  };
}

/* ---- Farra World (Las Rocas, Sunblast, La Misa, Brunch & Beats, ecc.) ----
   Le pagine evento di farra.world sono WordPress LEGGIBILI: la data sta nel testo
   e nell'og:description. Scopriamo le pagine (slug noti + sitemap) e le leggiamo.
   Farra usa biglietterie diverse (MuchoHype / 365top / Fourvenues): proviamo a
   ricavare il link biglietti dalla pagina, altrimenti usiamo la pagina Farra. */
const ES_MONTHS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
function fromEsDate(text) {
  const m = (text || "").toLowerCase().match(/(\d{1,2})\s*(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de\s+)?(\d{4}))?/);
  if (!m) return null;
  const idx = ES_MONTHS.indexOf(m[2] === "setiembre" ? "septiembre" : m[2]);
  if (idx < 0) return null;
  return { giorno: String(+m[1]), mese: MESI[idx] || "", anno: m[3] ? +m[3] : 2026 };
}
const FARRA_KNOWN_SLUGS = ["brunch-beats","tumbao","aguasanta","sunblast","la-misa","misa-negra","lost-nomads","bresh","elrow-xxl","ritmos-del-mundo","tenerife-music-festival"];
const FARRA_SKIP = /^(aviso-legal|condiciones|cookies|politica|privacidad|contacto|entradas|las-rocas-beach-club|backstage|golden-pass|faqs?|tienda|blog|nosotros|home)$/i;
const FARRA_FEST = /festival|sunblast|elrow|greenworld|lost nomads|la misa|misa negra|ritmos del mundo|nrg/i;
function metaContent($, prop) {
  return $(`meta[property="${prop}"]`).attr("content") || $(`meta[name="${prop}"]`).attr("content") || "";
}
function parseFarraPage(html, url) {
  const $ = cheerio.load(html);
  const ogTitle = metaContent($, "og:title");
  const ogDesc  = metaContent($, "og:description");
  const bodyTxt = $.root().text().replace(/\s+/g, " ");
  const haystack = `${ogDesc} ${bodyTxt}`;
  const d = fromEsDate(ogDesc) || fromEsDate(bodyTxt);
  if (!d || !d.giorno) return null;                 // niente data => non è una pagina-evento
  let nome = (ogTitle || $("h1").first().text() || "").replace(/\s*[-–|].*farra world.*/i, "").trim();
  if (!nome) nome = url.split("/").filter(Boolean).pop();
  let artisti = "";
  const am = ogDesc.match(/presenta\s+([A-Za-zÁÉÍÓÚÑáéíóúñ0-9 .&'-]{2,40}?)\s+(?:s[áa]bado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|\d|—|\|)/i);
  if (am) artisti = am[1].trim();
  let location = "Tenerife";
  if (/las rocas/i.test(haystack)) location = "Las Rocas Beach Club";
  else if (/golf costa adeje/i.test(haystack)) location = "Golf Costa Adeje";
  else if (/golf del sur/i.test(haystack)) location = "Golf del Sur";
  let link = url;
  const tm = haystack.match(/https?:\/\/[^\s"')]+(?:checkout|tickets|entradas)[^\s"')]*/i)
          || html.match(/https?:\/\/(?:365top\.farra\.world|tickets\.muchohype\.com|[^\s"')]*fourvenues\.com)[^\s"')]*/i);
  if (tm) link = tm[0];
  return {
    nome, promoter: "farra",
    giorno: d.giorno, mese: d.mese, anno: d.anno,
    genere: /tech house/i.test(haystack) ? "House / Tech House" : "",
    location, artisti, link, instagram: "", stato: "",
    categoria: FARRA_FEST.test(`${nome} ${haystack}`) ? "Festival" : "Club"
  };
}
async function farraSlugsFromSitemap() {
  const slugs = new Set();
  for (const sm of ["https://farra.world/wp-sitemap.xml", "https://farra.world/sitemap_index.xml"]) {
    try {
      const idx = await fetchText(sm);
      const subs = [...idx.matchAll(/<loc>([^<]+\.xml)<\/loc>/g)].map(x => x[1]).slice(0, 6);
      for (const u of (subs.length ? subs : [sm])) {
        try {
          const xml = await fetchText(u);
          for (const mm of xml.matchAll(/<loc>https?:\/\/farra\.world\/([a-z0-9-]+)\/?<\/loc>/gi)) {
            const slug = mm[1].toLowerCase();
            if (!FARRA_SKIP.test(slug)) slugs.add(slug);
          }
        } catch {}
      }
      if (slugs.size) break;
    } catch {}
  }
  return [...slugs];
}
async function parseFarraAll() {
  const slugs = new Set(FARRA_KNOWN_SLUGS);
  try { (await farraSlugsFromSitemap()).forEach(s => slugs.add(s)); } catch {}
  const urls = [...slugs].slice(0, 20).map(s => `https://farra.world/${s}/`);
  const results = await Promise.allSettled(urls.map(async u => {
    try { return parseFarraPage(await fetchText(u), u); } catch { return null; }
  }));
  return results.filter(r => r.status === "fulfilled" && r.value && r.value.nome).map(r => r.value);
}

/* ---- Farra / Las Rocas: biglietteria Entradas.top (365top.farra.world) ----
   La home elenca gli eventi; ogni scheda ha nome (alt del logo), data (gg/mm/aaaa) e locale. */
async function parse365top(listingHtml, source) {
  const urls = new Set();
  const $ = cheerio.load(listingHtml);
  $('a[href*="/events/"]').each((_, el) => {
    let href = ($(el).attr("href") || "").split("?")[0];
    if (!/\/events\/[^/]+\/checkout/.test(href)) return;
    if (!href.startsWith("http")) href = "https://365top.farra.world" + href;
    urls.add(href);
  });
  if (urls.size === 0) {                       // Jina può restituire markdown: prendi gli URL via regex
    const re = /(?:https?:\/\/365top\.farra\.world)?\/events\/[a-z0-9-]+\/checkout/gi;
    let m;
    while ((m = re.exec(listingHtml))) {
      let h = m[0].split("?")[0];
      if (!h.startsWith("http")) h = "https://365top.farra.world" + h;
      urls.add(h);
    }
  }
  console.log(`365top: ${urls.size} eventi trovati nell'elenco`);
  const out = [];
  let n = 0;
  for (const url of urls) {
    if (n++ >= MAX_PER_SOURCE) break;
    try {
      const ev = parse365topDetail(await fetchRendered(url), url, source);  // Jina anche per le schede (evita 403)
      if (ev && ev.nome) out.push(ev);
    } catch (e) { console.error("365top scheda KO", url, e.message); }
  }
  return out;
}
function parse365topDetail(html, url, source) {
  const $ = cheerio.load(html);
  let nome = ($('img[alt^="Logo"]').first().attr("alt") || "").replace(/^Logo\s+/i, "").trim();
  if (!nome) {
    const mm = html.match(/!\[Logo\s+([^\]]+)\]/i);   // caso markdown da Jina
    if (mm) nome = mm[1].trim();
  }
  if (!nome) {
    const slug = (url.match(/\/events\/([^/]+)\//) || [])[1] || "";
    nome = slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
  const text = $.root().text().replace(/\s+/g, " ");
  const dm = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);   // prima data gg/mm/aaaa
  let giorno = "", mese = "", anno = 2026;
  if (dm) { giorno = String(+dm[1]); mese = MESI[(+dm[2]) - 1] || ""; anno = +dm[3]; }
  let location = "";
  if (dm) location = text.slice(dm.index + dm[0].length)
                         .split(/ENTRADAS|ASIGNAR|PAGO|¿|Comprar|Tu pedido/)[0]
                         .split(" - ")[0].trim();
  const cat = /festival|sunblast|elrow|misa|nomads|bresh|ritmos|d[ií]a uno/i.test(nome) ? "Festival" : "Club";
  return {
    nome,
    promoter: venueToPromoter(location, source.defaultPromoter || "farra"),
    giorno, mese, anno: anno || 2026,
    genere: "", location: location || "Las Rocas Beach Club", artisti: "",
    link: url, instagram: "", stato: "", categoria: cat
  };
}

/* ---- Xceed: API ufficiale Open Event API (no auth) ---- */
async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
  return res.json();
}
function fromUnix(ts) {
  if (!ts) return { giorno: "", mese: "", anno: 2026 };
  const d = new Date(ts * 1000);
  return { giorno: String(d.getUTCDate()), mese: MESI[d.getUTCMonth()] || "", anno: d.getUTCFullYear() };
}
function mapXceedEvent(ev) {
  const venue   = (ev.venue && ev.venue.name) || "";
  const { giorno, mese, anno } = fromUnix(ev.startingTime);
  const genere  = (ev.musicGenres && ev.musicGenres[0] && ev.musicGenres[0].name) || "";
  const artisti = (ev.lineup || []).map(a => a && a.name).filter(Boolean).join(", ");
  const link    = (ev.slug && ev.legacyId)
    ? `https://xceed.me/en/tenerife/event/${ev.slug}/${ev.legacyId}`
    : (ev.externalSalesUrl || "");
  const nome = String(ev.name || "").split("·")[0].trim() || String(ev.name || "").trim();
  return {
    nome,
    promoter: venueToPromoter(venue, "papagayo"),
    giorno, mese, anno,
    genere, location: venue.trim(), artisti,
    link, instagram: "", stato: "", categoria: "Club"
  };
}
async function fetchXceedList(param, value, seenIds, out) {
  const now = Math.floor(Date.now() / 1000);
  const limit = 100;
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    let json;
    try {
      json = await fetchJson(`${XCEED_API}?${param}=${encodeURIComponent(value)}&startTime=${now}&limit=${limit}&offset=${offset}`);
    } catch (e) { console.error(`Xceed ${param}=${value} KO:`, e.message); break; }
    const data = (json && json.data) || [];
    if (!data.length) break;
    for (const ev of data) {
      if (!ev || !ev.id || seenIds.has(ev.id)) continue;
      seenIds.add(ev.id);
      const row = mapXceedEvent(ev);
      if (row.nome) out.push(row);
    }
    if (data.length < limit) break;
    offset += limit;
  }
}
async function parseXceed() {
  const out = [];
  const seenIds = new Set();
  for (const ch of XCEED_CHANNELS) await fetchXceedList("channel", ch, seenIds, out);
  for (const v of XCEED_VENUES)    await fetchXceedList("venues",  v,  seenIds, out);
  return out;
}

/* ---- dispatch per fonte ---- */
async function runSource(s) {
  const html = s.render ? await fetchRendered(s.url) : await fetchText(s.url);
  if (s.strategy === "tomaticket")   return parseTomaticket(html, s);
  if (s.strategy === "tickettailor") return await parseTicketTailor(html, s);
  if (s.strategy === "farra365")     return await parse365top(html, s);
  return parseJsonLd(html, s);
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: "unauthorized" });

  try {
    const sheets = await sheetsClient();
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_TAB}!A:L` });
    const rows = existing.data.values || [];
    const hasHeader = rows.length && (rows[0][0] || "").toLowerCase() === "nome";

    if (hasHeader && (rows[0][COLUMNS.length - 1] || "").toLowerCase() !== "categoria") {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID, range: `${SHEET_TAB}!A1:L1`,
          valueInputOption: "RAW", requestBody: { values: [COLUMNS] }
        });
      } catch (e) { console.error("Header update KO:", e.message); }
    }

    const seen = new Set((hasHeader ? rows.slice(1) : rows)
      .map(r => `${(r[0]||"").toLowerCase()}|${r[2]||""}|${r[3]||""}`));

    let found = [];
    const dettaglio = {};

    // Xceed via API ufficiale
    try {
      const evs = await parseXceed();
      dettaglio["Xceed (API)"] = evs.length;
      found = found.concat(evs);
    } catch (e) { dettaglio["Xceed (API)"] = "ERRORE: " + e.message; }

    // Altre fonti
    for (const s of SOURCES) {
      try {
        const evs = await runSource(s);
        dettaglio[s.name] = evs.length;
        found = found.concat(evs);
      } catch (e) { dettaglio[s.name] = "ERRORE: " + e.message; }
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
        spreadsheetId: SHEET_ID, range: `${SHEET_TAB}!A:L`,
        valueInputOption: "RAW", requestBody: { values: toAppend }
      });
    }
    return res.status(200).json({ ok: true, scansionati: found.length, aggiunti: toAppend.length, dettaglio });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
