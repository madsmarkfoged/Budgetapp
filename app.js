import React, { useState, useEffect, useRef } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

// ---------------- constants ----------------

const INCOME_CATS = ["Løn","SU","Anden indkomst"];
const CATEGORIES = ["Løn","SU","Anden indkomst","Husleje","Mad & dagligvarer","Transport","Restaurant & café","Abonnementer","Forsikring","Sundhed & fitness","Shopping","Underholdning","Rejser","Opsparing","Investering","Intern overførsel","Udeladt","Andet"];
const CAT_COLORS = {"Løn":"#0F6E56","SU":"#127C5A","Anden indkomst":"#3B8A6E","Husleje":"#378ADD","Mad & dagligvarer":"#639922","Transport":"#BA7517","Restaurant & café":"#D85A30","Abonnementer":"#534AB7","Forsikring":"#A32D2D","Sundhed & fitness":"#1D9E75","Shopping":"#D4537E","Underholdning":"#7F77DD","Rejser":"#EF9F27","Opsparing":"#185FA5","Investering":"#3B6D11","Intern overførsel":"#B4B2A9","Udeladt":"#888780","Andet":"#5F5E5A"};
const SHORT_CAT = {"Mad & dagligvarer":"Mad","Restaurant & café":"Café","Sundhed & fitness":"Sundhed","Abonnementer":"Abonnem."};
const EXCLUDED = ["Intern overførsel","Udeladt"];
const PAYDAY_CUTOFF = 25;
const CURRENCIES = ["DKK","USD","EUR","GBP","SEK","NOK"];
const DEFAULT_FX = {EUR:7.46, USD:6.85, GBP:8.70, SEK:0.66, NOK:0.65};
const MONTHS_DA = ["januar","februar","marts","april","maj","juni","juli","august","september","oktober","november","december"];

const STORAGE_KEY = "budget_data";
const API_KEY_KEY = "anthropic_api_key";
const MODEL_KEY = "anthropic_model";
const BRIDGE_KEY = "bridge";          // {url, secret} for the Cloudflare Worker
const EB_KEY = "eb_session";          // Enable Banking session (not part of backups)
const SAXO_KEY = "saxo_tokens";       // Saxo OAuth tokens (not part of backups)
const OAUTH_KEY = "oauth_pending";    // {provider, nonce} while away at the bank/Saxo
const THEME_KEY = "theme";
const PRIVACY_KEY = "hide_amounts";
const DEFAULT_MODEL = "claude-sonnet-5";
const BACKUP_KEY = "last_backup";
// Unattended bank fetches are capped by PSD2 (typically 4 per day), so auto-sync at most every 8 hours.
const BANK_AUTO_SYNC_HOURS = 8;
const DATA_VERSION = 2;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  remove(k) { try { localStorage.removeItem(k); } catch {} },
  json(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  setJson(k, v) { return store.set(k, JSON.stringify(v)); },
};

// ---------------- helpers (budget logic) ----------------

function budgetMonth(dateStr, amount, category) {
  const d = new Date(dateStr);
  if (isNaN(d)) return (dateStr||"").slice(0,7);
  let y = d.getFullYear(), m = d.getMonth();
  const shift = (amount > 0 || category === "Husleje") && d.getDate() >= PAYDAY_CUTOFF;
  if (shift) { m += 1; if (m > 11) { m = 0; y += 1; } }
  return `${y}-${String(m+1).padStart(2,"0")}`;
}

// Privacy mode: set by App on every render; while on, amounts render as dots (for using the app in public).
let HIDE_AMOUNTS = false;
const fmtKr = (n) => new Intl.NumberFormat("da-DK",{style:"currency",currency:"DKK",maximumFractionDigits:0}).format(n);
const fmt = (n) => HIDE_AMOUNTS ? "••• kr." : fmtKr(n);
const fmtShort = (n) => HIDE_AMOUNTS ? "•••" : new Intl.NumberFormat("da-DK",{maximumFractionDigits:0}).format(n);
const numf = (n) => new Intl.NumberFormat("da-DK",{maximumFractionDigits:2}).format(n);
const pctf = (n) => new Intl.NumberFormat("da-DK",{maximumFractionDigits:1,signDisplay:"always"}).format(n) + " %";
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const addDays = (iso, n) => { const d = parseDKDate(iso); d.setDate(d.getDate()+n); return isoDate(d); };
const monthEnd = (ym) => { const [y,m] = ym.split("-").map(Number); return `${ym}-${String(new Date(y,m,0).getDate()).padStart(2,"0")}`; };
const addMonths = (ym, n) => { const [y,m] = ym.split("-").map(Number); return isoDate(new Date(y, m-1+n, 1)).slice(0,7); };
// Fixed rent is booked on the last day of the month; this is the newest month whose rent day has come.
const lastRentMonth = () => { const t = isoDate(new Date()); const ym = t.slice(0,7); return monthEnd(ym) <= t ? ym : addMonths(ym, -1); };
const RENT_TEXT = "Husleje (fast)";
const DEFAULT_RENT = { amount: 4982, assetId: null, auto: true, paidThrough: null };
// Travel fund shared with the user's sister: each saves `goal`; trip costs are split 50/50.
const DEFAULT_REJSE = { saved: 0, goal: 100000, accountId: null, trips: [] };
const monthLabel = (ym) => { const [y,m] = ym.split("-"); return `${MONTHS_DA[+m-1]} ${y}`; };
const monthName = (ym) => { const m = MONTHS_DA[+ym.split("-")[1]-1]; return m[0].toUpperCase() + m.slice(1); };
// The running budget month flips to next month on payday itself.
const currentBudgetMonth = () => {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  if (new Date(y, m, now.getDate()) >= paydayIn(y, m)) { m += 1; if (m > 11) { m = 0; y += 1; } }
  return `${y}-${String(m + 1).padStart(2, "0")}`;
};
const prevMonth = (ym) => { let [y,m] = ym.split("-").map(Number); m -= 1; if (m < 1) { m = 12; y -= 1; } return `${y}-${String(m).padStart(2,"0")}`; };

function parseDKDate(s) {
  if (!s) return null;
  const parts = s.split(/[.\/-]/);
  if (parts.length === 3) {
    let [a,b,c] = parts;
    if (c.length === 4) return new Date(+c, +b-1, +a);
    if (a.length === 4) return new Date(+a, +b-1, +c);
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function prettyDate(iso) {
  const today = isoDate(new Date());
  if (iso === today) return "I dag";
  if (iso === addDays(today, -1)) return "I går";
  const d = parseDKDate(iso);
  if (!d) return iso;
  return `${d.getDate()}. ${MONTHS_DA[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""}`;
}

function syncTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  return isoDate(d) === isoDate(new Date()) ? hm : `${d.getDate()}/${d.getMonth()+1} ${hm}`;
}
const syncLabel = (ts) => ts ? `Synkroniseret ${syncTime(ts)}` : null;

// Easter Sunday (anonymous Gregorian algorithm).
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

// Danish bank closing days: weekends, public holidays, 5 June, 24 and 31 December and the Friday after Ascension.
function isBankClosed(d) {
  if (d.getDay() === 0 || d.getDay() === 6) return true;
  const md = `${d.getMonth() + 1}-${d.getDate()}`;
  if (["1-1", "6-5", "12-24", "12-25", "12-26", "12-31"].includes(md)) return true;
  const e = easter(d.getFullYear());
  const offset = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - e) / 86400e3);
  return [-3, -2, 1, 39, 40, 50].includes(offset);
}

// Salary is paid on the last bank day of the month.
function paydayIn(y, m) {
  const d = new Date(y, m + 1, 0);
  while (isBankClosed(d)) d.setDate(d.getDate() - 1);
  return d;
}

function nextPayday(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let p = paydayIn(today.getFullYear(), today.getMonth());
  if (p < today) p = paydayIn(today.getFullYear(), today.getMonth() + 1);
  return { date: p, days: Math.round((p - today) / 86400e3) };
}

function guessCategory(desc) {
  const d = (desc||"").toLowerCase();
  if (/løn|lønoverf|loenoverf|salary|\bgage\b/.test(d)) return "Løn";
  if (/\bsu\b|su[- ]?styr|uddannelsesstøtte|statens uddann/.test(d)) return "SU";
  if (/husleje|\bleje\b|boligselskab|udlejning|huslejekonto/.test(d)) return "Husleje";
  if (/tryg|forsikr|topdanmark|\balka\b|codan|gjensidige|gf forsikr/.test(d)) return "Forsikring";
  if (/openai|chatgpt|spotify|netflix|hbo|disney|viaplay|youtube|icloud|dr\.|tv\s?2|avis|blad|abonne|subscr/.test(d)) return "Abonnementer";
  if (/rema|netto|fakta|aldi|lidl|meny|fotex|bilka|daglig|supermark|groceri|coop/.test(d)) return "Mad & dagligvarer";
  if (/dsb|rejsekort|fly|tog|bus|metro|taxa|uber|parkering|benzin|shell|circle k|ok\s?tank/.test(d)) return "Transport";
  if (/restaurant|cafe|café|pizza|sushi|mcdo|burger|takeaway|just eat|wolt/.test(d)) return "Restaurant & café";
  if (/fitness|gym|\bsport|svøm|træn|apotek|læge|tandlæge|medicin/.test(d)) return "Sundhed & fitness";
  if (/2tall|h&m|zara|zalando|tøj|\bsko\b|mode|shopping|elgiganten|jysk|ikea|silvan|normal|guldsmed/.test(d)) return "Shopping";
  if (/bio|kino|koncert|teater|event|underholdning/.test(d)) return "Underholdning";
  if (/airbnb|hotel|booking|rejse|ferie/.test(d)) return "Rejser";
  if (/overførsel til opsparing|opsparing|saving/.test(d)) return "Opsparing";
  if (/invest|aktie|etf|nordnet|saxo/.test(d)) return "Investering";
  if (/overførsel|overfoersel|egen konto|mellem konti|netbank|kontooverf/.test(d)) return "Intern overførsel";
  if (/omregnet fra|til kurs|\beur\b|\busd\b|\bgbp\b/.test(d)) return "Rejser";
  return "Andet";
}

function splitLine(line, sep) {
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === sep && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}

const DATE_RE = /^\s*"?\d{1,4}[.\/-]\d{1,2}[.\/-]\d{1,4}/;

function parseCSV(text) {
  const lines = text.replace(/\r/g,"").trim().split("\n").filter(Boolean);
  if (!lines.length) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const firstIsData = DATE_RE.test(lines[0]);
  let dateIdx, descIdx, amtIdx, startRow;
  if (firstIsData) { dateIdx = 0; descIdx = 1; amtIdx = 2; startRow = 0; }
  else {
    const headers = splitLine(lines[0], sep).map(h => h.toLowerCase());
    dateIdx = headers.findIndex(h => /dato|date/.test(h));
    descIdx = headers.findIndex(h => /tekst|beskrivelse|description|text|navn|name|modtager|afsender/.test(h));
    amtIdx = headers.findIndex(h => /beløb|amount|bel.b|sum/.test(h));
    if (dateIdx < 0) dateIdx = 0; if (descIdx < 0) descIdx = 1; if (amtIdx < 0) amtIdx = 2;
    startRow = 1;
  }
  const rows = [];
  for (let i = startRow; i < lines.length; i++) {
    const cols = splitLine(lines[i], sep);
    if (cols.length <= amtIdx) continue;
    const rawAmt = (cols[amtIdx] ?? "").replace(/\s/g,"").replace(/\.(?=\d{3}(\D|$))/g,"").replace(",",".");
    const amt = parseFloat(rawAmt);
    if (isNaN(amt)) continue;
    const desc = (cols[descIdx] || "Ukendt").replace(/\\/g," ").replace(/\s+/g," ").trim();
    const d = parseDKDate(cols[dateIdx]);
    // localDate marks rows whose date is stored correctly (see mergeRows).
    rows.push({ id: uid(), date: d ? isoDate(d) : cols[dateIdx], description: desc, amount: amt, category: guessCategory(desc), localDate: true });
  }
  return rows;
}

const DEFAULT_BUDGETS = {"Husleje":8000,"Mad & dagligvarer":3000,"Transport":1200,"Restaurant & café":1000,"Abonnementer":400,"Forsikring":500,"Sundhed & fitness":500,"Shopping":1000,"Underholdning":500,"Rejser":1000,"Opsparing":3000,"Investering":2000,"Andet":500};
const STUDENT_BUDGET = {"Husleje":5300,"Mad & dagligvarer":1800,"Transport":350,"Restaurant & café":500,"Abonnementer":300,"Forsikring":250,"Sundhed & fitness":350,"Shopping":400,"Underholdning":400,"Rejser":300,"Opsparing":500,"Investering":400,"Andet":150};
const SAXO_SEED_NAMES = ["Amundi Prime All Country World ETF Acc","Sparindex INDEX Globale Aktier KL","Microsoft Corp.","Amazon.com Inc.","ALK-Abelló B A/S","Zealand Pharma A/S","Rheinmetall AG"];

const eff = (t) => (t && t.delt) ? t.amount/2 : (t ? t.amount : 0);

function monthIncomeExpense(mtx) {
  const cn = {};
  for (const cat of CATEGORIES) cn[cat] = mtx.filter(t=>t.category===cat).reduce((s,t)=>s+eff(t),0);
  const exp = CATEGORIES.reduce((s,c)=> INCOME_CATS.includes(c)? s : s + Math.max(0,-cn[c]), 0);
  const sur = CATEGORIES.reduce((s,c)=> (!INCOME_CATS.includes(c) && cn[c]>0)? s+cn[c]:s, 0);
  const inc = INCOME_CATS.reduce((s,c)=>s+Math.max(0,cn[c]),0) + sur;
  return { inc, exp, sur, cn };
}

// Merchant key for grouping card/PBS charges: drops card words, numbers and references.
const subKey = (d) => (d || "").toLowerCase()
  .replace(/[^a-zæøå ]+/g, " ")
  .replace(/\b(dankort|visa|mastercard|mc|nota|kortkøb|købt|betalingsservice|pbs|overførsel|dk|www|com|aps|as)\b/g, " ")
  .replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");

// Readable merchant name from a bank text: drops MobilePay prefixes, addresses, note numbers and city suffixes.
function prettyName(desc) {
  let n = (desc || "").replace(/^(mob\.?\s*pay\*|mobilepay:?\s*(mobilepay\s*)?|dankort-nota\s+|pbs\s+)/i, "");
  n = n.split(/\\|,|\s+Notanr\b|\s+beløb omregnet/i)[0].trim() || desc || "";
  if (n === n.toUpperCase()) n = n.toLowerCase().replace(/(^|[\s*\-])\p{L}/gu, (m) => m.toUpperCase());
  return n;
}

// Recurring payments in the last six months: about once a month at a stable amount, still active.
// sign -1 finds charges (subscriptions), +1 finds money coming in (people paying their share).
function detectRecurring(transactions, sign, hidden = []) {
  const today = isoDate(new Date());
  const since = addDays(today, -190), stale = addDays(today, -45);
  const groups = {};
  for (const t of transactions) {
    if (!t.date || t.date < since || !(t.amount * sign > 0) || t.trip || t.description === RENT_TEXT) continue;
    if (EXCLUDED.includes(t.category) || ["Løn", "SU", "Husleje", "Opsparing", "Investering"].includes(t.category)) continue;
    const k = subKey(t.description);
    if (k.length < 3) continue;
    (groups[k] ||= []).push(t);
  }
  const out = [];
  for (const [key, txs] of Object.entries(groups)) {
    if (hidden.includes(key)) continue;
    txs.sort((a, b) => a.date.localeCompare(b.date));
    const months = new Set(txs.map(t => t.date.slice(0, 7)));
    const known = sign < 0 && txs.some(t => t.category === "Abonnementer");
    if (months.size < (known ? 2 : 3) || txs.length > months.size * 1.5) continue;
    const amounts = txs.map(t => Math.abs(t.amount)).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    if (median < 10 || (amounts[amounts.length - 1] - amounts[0]) / median > 0.35) continue;
    const last = txs[txs.length - 1];
    if (last.date < stale) continue;
    out.push({ key, name: prettyName(last.description), raw: last.description, category: last.category, monthly: Math.abs(last.amount), last: last.date, months: months.size });
  }
  return out.sort((a, b) => b.monthly - a.monthly);
}
const detectSubscriptions = (transactions, hidden) => detectRecurring(transactions, -1, hidden);

// Guess which recurring payment-in covers part of a subscription: a word from the payer's text appears in
// the merchant's text ("Fitness X - Chrisser" ↔ "FitnessX A/S"). Anything looser is left to the user.
function guessShare(sub, incoming) {
  const target = (sub.raw || "").toLowerCase().replace(/[^a-zæøå]+/g, "");
  const generic = ["mobilepay", "mobpay", "betaling", "overfoersel", "indbetaling", "fra", "til"];
  return incoming.find(i => i.key.split(" ").some(w => w.length >= 4 && !generic.includes(w) && target.includes(w))) || null;
}

// ---------------- shopping list from weekly offers (Tjek / eTilbudsavis) ----------------
// Tjek's public offer search allows calls from the app's origin and needs no key. It is not an
// official, documented API, so everything here degrades to "no offers found" if it changes.
const TJEK_SEARCH = "https://squid-api.tjek.com/v2/offers/search";
const CHAINS = ["REMA 1000", "Netto", "Lidl", "Føtex", "Bilka", "Coop 365", "SuperBrugsen", "Kvickly", "Dagli'Brugsen", "Meny", "Spar", "Løvbjerg", "Min Købmand", "Lagkagehuset", "7-Eleven"];
const AARHUS = { lat: 56.1572, lng: 10.2107, place: "Aarhus C" };
const STAPLES = ["Mælk", "Æg", "Brød", "Kaffe", "Smør", "Ost", "Kylling", "Hakket oksekød", "Pasta", "Ris", "Bananer", "Yoghurt", "Toiletpapir"];
const DEFAULT_SHOP = { items: [], stores: null, meals: [], days: 5, plan: null, ...AARHUS };
const kr = (n) => new Intl.NumberFormat("da-DK", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n) + " kr.";
const chainOf = (dealerName) => CHAINS.find(c => (dealerName || "").toLowerCase().startsWith(c.toLowerCase())) || dealerName;

// The chains the user actually shops in, from card purchases in the last 90 days (2+ visits).
function usualStores(transactions) {
  const since = addDays(isoDate(new Date()), -90), n = {};
  for (const t of transactions) {
    if (!t.date || t.date < since || !(t.amount < 0)) continue;
    const d = (t.description || "").toLowerCase();
    const c = CHAINS.find(c => d.includes(c.toLowerCase().replace(/\s+/g, " ")) || d.includes(c.toLowerCase().replace(/\s+/g, "")));
    if (c) n[c] = (n[c] || 0) + 1;
  }
  return Object.entries(n).filter(([, k]) => k >= 2).sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

async function searchOffers(query, { lat, lng }) {
  const q = new URLSearchParams({ query, r_lat: lat, r_lng: lng, r_radius: 10000, limit: 40 });
  const res = await fetch(`${TJEK_SEARCH}?${q}`);
  if (!res.ok) throw new Error(`Tilbud kunne ikke hentes (${res.status}).`);
  const now = Date.now();
  return (await res.json())
    .filter(o => o.pricing?.price != null && (!o.run_till || Date.parse(o.run_till) >= now))
    .map(o => ({
      id: o.id, heading: o.heading, description: o.description || "", price: +o.pricing.price, before: o.pricing.pre_price,
      store: chainOf(o.dealer?.name), from: o.run_from, till: o.run_till, image: o.images?.thumb || null,
    }));
  // Kept in Tjek's order (best match first): the cheapest hit for "kaffe" is often capsules, not coffee.
}

// Starter meals to pick favourites from; each ingredient is also the offer search term.
const MEAL_TEMPLATES = [
  ["Kylling i karry", ["kylling", "ris", "kokosmælk", "løg"]],
  ["Spaghetti bolognese", ["hakket oksekød", "spaghetti", "hakkede tomater", "løg"]],
  ["Chili con carne", ["hakket oksekød", "kidneybønner", "hakkede tomater", "ris"]],
  ["Tacos", ["hakket oksekød", "tortilla", "ost", "salat"]],
  ["Pasta med kylling og pesto", ["kylling", "pasta", "pesto"]],
  ["Wok med kylling", ["kylling", "nudler", "wokgrøntsager"]],
  ["Lasagne", ["hakket oksekød", "lasagneplader", "hakkede tomater", "ost"]],
  ["Laks med kartofler", ["laks", "kartofler", "broccoli"]],
  ["Frikadeller med kartofler", ["hakket svinekød", "kartofler", "æg"]],
  ["Burger", ["burgerboller", "hakket oksekød", "ost", "salat"]],
  ["Pizza", ["pizzadej", "skinke", "ost", "tomatsauce"]],
  ["Omelet med bacon", ["æg", "bacon", "ost"]],
];
const WEEKDAYS = ["Søndag", "Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag"];

// An offer fits an ingredient when every word of the ingredient starts a word in the offer heading
// ("hakket oksekød" ↔ "Hakket oksekød 8-12 %"), so "ris" doesn't match "pris".
function offerFits(term, heading) {
  const h = " " + (heading || "").toLowerCase().replace(/[^a-zæøå0-9]+/g, " ");
  return term.toLowerCase().split(/\s+/).filter(Boolean).every(w => h.includes(" " + w));
}

// Week plan from favourite meals and this week's offers: pick the 1–2 of the user's stores where most
// ingredients are on offer, then the meals with most ingredients on offer there.
function planMeals(favorites, offersByTerm, stores, count) {
  const terms = [...new Set(favorites.flatMap(m => m.ingredients))];
  // First fitting offer per store per ingredient, in Tjek's relevance order.
  const best = {};
  for (const t of terms) {
    best[t] = {};
    for (const o of offersByTerm[t] || []) if (stores.includes(o.store) && !best[t][o.store] && offerFits(t, o.heading)) best[t][o.store] = o;
  }
  const pick = (t, set) => set.map(st => best[t][st]).filter(Boolean).sort((a, b) => a.price - b.price)[0] || null;
  const score = (set) => terms.reduce((s, t) => { const o = pick(t, set); return s + (o ? 1 + Math.max(0, (o.before || 0) - o.price) / 50 : 0); }, 0);
  const singles = stores.map(st => [st]);
  const pairs = stores.flatMap((a, i) => stores.slice(i + 1).map(b => [a, b]));
  const top = (list) => list.map(set => ({ set, sc: score(set) })).sort((a, b) => b.sc - a.sc)[0];
  const one = top(singles), two = top(pairs);
  // A second store is only worth the trip if it adds at least two ingredients on offer.
  const chosen = two && one && two.sc >= one.sc + 2 ? two.set : one ? one.set : [];
  const rated = favorites.map(m => {
    const items = m.ingredients.map(t => ({ term: t, offer: pick(t, chosen) }));
    const hits = items.filter(i => i.offer).length;
    return { meal: m, items, rank: hits / Math.max(1, items.length) + hits * 0.01 };
  }).sort((a, b) => b.rank - a.rank);
  return { stores: chosen, meals: rated.slice(0, count) };
}

// Holding type for the allocation bar: Saxo tells us; for manual holdings guess from the name.
const TYPE_LABEL = { Etf: "ETF", Stock: "Aktier", MutualFund: "Fonde", Bond: "Obligationer" };
const TYPE_COLOR = { ETF: "#8B7BFF", Aktier: "#4FC3F7", Fonde: "#F2B35B", Obligationer: "#F48FB1", Andet: "#90A4AE", Kontant: "#9CF0C8" };
function holdingType(h) {
  if (h.type) return TYPE_LABEL[h.type] || "Andet";
  const n = `${h.name} ${h.ticker}`.toLowerCase();
  if (/\betf\b|ucits|ishares|xtrackers|amundi|vanguard|spdr/.test(n)) return "ETF";
  if (/index|invest |fond|\bkl\b|sparinvest|sparindex/.test(n)) return "Fonde";
  return "Aktier";
}

function normalizeData(d) {
  const toArr = (x) => Array.isArray(x) ? x : Object.entries(x||{}).map(([name,value])=>({id:uid(),name:name[0].toUpperCase()+name.slice(1),value:+value||0}));
  const out = {};
  if (Array.isArray(d.transactions)) out.transactions = d.transactions;
  if (d.budgets) out.budgets = d.budgets;
  if (d.assets) out.assets = toArr(d.assets);
  if (d.liabilities) out.liabilities = toArr(d.liabilities);
  if (Array.isArray(d.holdings)) out.holdings = d.holdings.map(h=>({currency:"DKK",...h}));
  if (d.fxRates) out.fxRates = {...DEFAULT_FX, ...d.fxRates};
  if (typeof d.cash === "number") out.cash = d.cash;
  if (d.rejse) out.rejse = {...DEFAULT_REJSE, ...d.rejse};
  if (Array.isArray(d.subsHidden)) out.subsHidden = d.subsHidden;
  if (d.subsShare && typeof d.subsShare === "object") out.subsShare = d.subsShare;
  if (d.shop) out.shop = {...DEFAULT_SHOP, ...d.shop};
  if (Array.isArray(d.invHistory)) out.invHistory = d.invHistory;
  if (d.sync) out.sync = d.sync;
  if (Array.isArray(d.history)) out.history = d.history;
  if (d.rent) out.rent = {...DEFAULT_RENT, ...d.rent};
  return out;
}

function readStored() {
  const raw = store.get(STORAGE_KEY);
  if (!raw) return {};
  try { return normalizeData(JSON.parse(raw)); } catch { return {}; }
}

// ---------------- icons ----------------

const ICONS = {
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  home: "M3 11l9-7 9 7M5 10v10h14V10",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  donut: "M12 3a9 9 0 1 0 9 9h-5a4 4 0 1 1-4-4zM15 3.5A9 9 0 0 1 20.5 9H15z",
  trend: "M3 17l6-6 4 4 8-8M15 7h6v6",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  refresh: "M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4",
  chevron: "M9 6l6 6-6 6",
  back: "M15 6l-6 6 6 6",
  plus: "M12 5v14M5 12h14",
  bank: "M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18",
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
  wallet: "M4 7h16v12H4zM16 13h1.5M4 7l12-3v3",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  sun: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  key: "M14.5 9.5a4 4 0 1 0-1.2 2.9L20 19v2h-3v-2h-2v-2h-2",
  db: "M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  plane: "M10 14l-7-3 1.5-1.5 7 1L16 5.5a1.8 1.8 0 0 1 2.5 2.5L13 13l1 7-1.5 1.5-3-7z",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z",
  flame: "M12 21a6 6 0 0 0 6-6c0-4-3-6-4-9-1.5 2-2 3.5-2 5-1-1-2-2-2-4-2 2-4 4.5-4 8a6 6 0 0 0 6 6z",
  alert: "M12 4l9 16H3zM12 10v4M12 17h.01",
  // categories
  briefcase: "M4 8h16v11H4zM9 8V5h6v3M4 13h16",
  school: "M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5",
  coins: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM14.5 9h-3.5a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 1 0 3H9.5M12 7v2M12 15v2",
  cart: "M3 4h2l2.4 11h10.2L20 8H6.2M9 20h.01M17 20h.01",
  bus: "M6 17V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v11M6 12h12M6 17h12M8 20v-3M16 20v-3M9 14.5h.01M15 14.5h.01",
  food: "M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 1-3 3-3 6v3h3v9",
  repeat: "M4 12V9a3 3 0 0 1 3-3h12l-3-3M20 12v3a3 3 0 0 1-3 3H5l3 3",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  heart: "M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z",
  bag: "M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2",
  ticket: "M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4zM14 7v10",
  jar: "M7 8h10v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2zM8 4h8v4H8zM10 13h4",
  arrows: "M4 8h14l-3-3M20 16H6l3 3",
  eyeoff: "M3 3l18 18M10.6 6.1A9 9 0 0 1 21 12a13 13 0 0 1-2.5 3.3M6.6 6.6A13 13 0 0 0 3 12s3.5 6 9 6a8.6 8.6 0 0 0 4.4-1.2",
};
const CAT_ICONS = {"Løn":"briefcase","SU":"school","Anden indkomst":"coins","Husleje":"home","Mad & dagligvarer":"cart","Transport":"bus","Restaurant & café":"food","Abonnementer":"repeat","Forsikring":"shield","Sundhed & fitness":"heart","Shopping":"bag","Underholdning":"ticket","Rejser":"plane","Opsparing":"jar","Investering":"trend","Intern overførsel":"arrows","Udeladt":"eyeoff","Andet":"dots"};

const Icon = ({ name }) => html`<svg className="ic" viewBox="0 0 24 24" aria-hidden="true" style=${name === "dots" ? {strokeWidth: 3.2} : null}><path d=${ICONS[name]} /></svg>`;

// Mix a hex color with white (amt > 0) for readable icon strokes on dark tints.
function tint(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * amt);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

const CatIcon = ({ cat, small }) => {
  const c = CAT_COLORS[cat] || "#5F5E5A";
  return html`<div className=${"sq" + (small ? " sm" : "")} style=${{ background: c + "33", color: tint(c, 0.45) }}><${Icon} name=${CAT_ICONS[cat] || "dots"} /></div>`;
};

// Animated number: counts up on mount and eases between values.
function CountUp({ value, format = fmt }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const start = from.current;
    if (reduce || start === value) { setShown(value); from.current = value; return; }
    let raf; const t0 = performance.now(); const dur = 750;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      setShown(start + (value - start) * e);
      if (k < 1) raf = requestAnimationFrame(step); else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value]);
  return format(Math.round(shown));
}

// Net-worth line for the hero card.
function Sparkline({ points }) {
  if (points.length < 2) return html`<svg className="spark" viewBox="0 0 300 64" preserveAspectRatio="none" aria-hidden="true"><path className="line" d="M0 44 L300 44" style=${{opacity:.5, strokeDasharray:"4 6", animation:"none"}} /></svg>`;
  const vals = points.map(p => p.v);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const xy = points.map((p, i) => [ (i / (points.length - 1)) * 300, 58 - ((p.v - min) / span) * 50 ]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lx, ly] = xy[xy.length - 1];
  return html`<svg className="spark" viewBox="0 0 300 64" preserveAspectRatio="none" aria-hidden="true">
    <path className="area" d=${`${line} L300 64 L0 64 Z`} />
    <path className="line" d=${line} />
    <circle cx=${lx} cy=${ly} r="3.5" fill="#B8F7D8" />
  </svg>`;
}

// Depot value (solid) against what has been put in (dashed); both lines share one scale.
function InvestChart({ points }) {
  if (points.length < 2) return html`<div className="small muted" style=${{padding:"18px 0", textAlign:"center"}}>Grafen fyldes ud fra i dag. Appen gemmer depotets værdi hver dag, du åbner den.</div>`;
  const W = 300, H = 120;
  const all = points.flatMap(p => [p.v, p.c]);
  const min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
  const x = (i) => (i / (points.length - 1)) * W, y = (v) => H - 6 - ((v - min) / span) * (H - 12);
  const path = (k) => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p[k]).toFixed(1)}`).join(" ");
  return html`<svg viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" style=${{width:"100%", height:140, display:"block", overflow:"visible"}} role="img" aria-label="Depotets værdi og indskudt beløb over tid">
    <path d=${path("c")} fill="none" stroke="var(--text-2)" strokeWidth="1.5" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
    <path d=${path("v")} fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
  </svg>`;
}

// Spending donut; segments are scaled against max(budget, spent) so the empty track is what's left.
function Donut({ segments, total, center, sub, over }) {
  const r = 76, C = 2 * Math.PI * r;
  let offset = 0;
  return html`<div className="donut-wrap"><svg className="donut" viewBox="0 0 190 190" role="img" aria-label=${`${center} ${sub}`}>
    <circle cx="95" cy="95" r=${r} fill="none" stroke="var(--track)" strokeWidth="18" />
    ${segments.map((s, i) => {
      const len = total > 0 ? (s.value / total) * C : 0;
      const gap = segments.length > 1 ? Math.min(3, len * 0.3) : 0;
      const el = html`<circle key=${s.key} className="seg" cx="95" cy="95" r=${r} fill="none" stroke=${s.color} strokeWidth="18"
        strokeDasharray=${`${Math.max(0, len - gap)} ${C}`} strokeDashoffset=${-offset} transform="rotate(-90 95 95)" style=${{animationDelay: `${i * 60}ms`}} />`;
      offset += len;
      return el;
    })}
    <text x="95" y="86" textAnchor="middle" fill="var(--text-2)" fontSize="12">${sub}</text>
    <text x="95" y="110" textAnchor="middle" fill=${over ? "var(--neg)" : "var(--text)"} fontSize="24" fontWeight="650">${center}</text>
  </svg></div>`;
}

// ---------------- Claude API ----------------

class NoKeyError extends Error {}

async function callClaude(body) {
  const key = store.get(API_KEY_KEY);
  if (!key) throw new NoKeyError("Ingen API-nøgle");
  const model = store.get(MODEL_KEY) || DEFAULT_MODEL;
  let messages = body.messages;
  for (let i = 0; i < 4; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, max_tokens: 16000, ...body, messages }),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      if (res.status === 401) throw new Error("API-nøglen blev afvist. Tjek den under Mere → Claude API-nøgle.");
      throw new Error(data?.error?.message || `HTTP ${res.status}`);
    }
    if (data.stop_reason === "refusal") throw new Error("Modellen afviste forespørgslen.");
    if (data.stop_reason === "pause_turn") { messages = [...messages, { role: "assistant", content: data.content }]; continue; }
    return data;
  }
  throw new Error("Svaret tog for mange runder – prøv igen.");
}

const textOf = (data) => (data?.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");

function extractJSON(text) {
  const clean = text.replace(/```json|```/g, "");
  const candidates = [];
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) candidates.push(m[0]);
  const last = clean.lastIndexOf('{"prices"');
  if (last >= 0) { const tail = clean.slice(last); const end = tail.lastIndexOf("}"); if (end > 0) candidates.push(tail.slice(0, end + 1)); }
  for (const c of candidates) { try { return JSON.parse(c); } catch {} }
  return {};
}

// ---------------- bridge (Cloudflare Worker) ----------------

class NoBridgeError extends Error {}

async function callBridge(path, body = {}) {
  const b = store.json(BRIDGE_KEY);
  if (!b?.url || !b?.secret) throw new NoBridgeError("Forbindelsen til din worker er ikke sat op (Mere → Bankforbindelser).");
  let res;
  try {
    res = await fetch(b.url.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Secret": b.secret },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Kunne ikke nå din worker. Tjek adressen og din internetforbindelse.");
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data?.error || `Worker svarede ${res.status}`); e.status = res.status; e.code = data?.code; throw e; }
  return data;
}

const redirectUrl = () => location.origin + location.pathname;

function beginOAuth(provider) {
  const nonce = uid().replace(/-/g, "");
  store.setJson(OAUTH_KEY, { provider, nonce, at: Date.now() });
  return `${provider}.${nonce}`;
}

// ---------------- app ----------------

const PAGES = [
  { id: "home", label: "Hjem", icon: "home" },
  { id: "tx", label: "Poster", icon: "list" },
  { id: "budget", label: "Budget", icon: "donut" },
  { id: "invest", label: "Invest.", icon: "trend" },
  { id: "food", label: "Mad", icon: "food" },
  { id: "more", label: "Mere", icon: "dots" },
];

const MORE_PAGES = [
  { id: "wealth", label: "Formue og gæld", icon: "wallet", sub: "Konti og gæld" },
  { id: "trips", label: "Rejsepulje", icon: "plane", sub: "Ferieopsparing og rejser med søs" },
  { id: "subs", label: "Abonnementer", icon: "repeat", sub: "Faste træk hver måned" },
  { id: "connections", label: "Bankforbindelser", icon: "bank", sub: "Sparekassen Kronjylland og Saxo" },
  { id: "ai", label: "AI-analyse", icon: "spark", sub: "Råd baseret på dine tal" },
  { id: "import", label: "Import og værktøjer", icon: "upload", sub: "CSV, fast husleje, kategorier" },
  { id: "appearance", label: "Udseende", icon: "sun", sub: "Mørk, lys eller system" },
  { id: "apikey", label: "Claude API-nøgle", icon: "key", sub: "Til AI-analyse og kurser" },
  { id: "data", label: "Data og backup", icon: "db", sub: "Eksportér og importér" },
];

const RANGES = { "1M": 31, "3M": 92, "1Å": 366 };

function App() {
  const initial = useRef(null);
  if (initial.current === null) initial.current = readStored();
  const init = initial.current;

  const [page, setPage] = useState("home");
  const [sub, setSub] = useState(null);
  const [transactions, setTransactions] = useState(init.transactions || []);
  const [budgets, setBudgets] = useState(init.budgets || DEFAULT_BUDGETS);
  const [assets, setAssets] = useState(init.assets || []);
  const [liabilities, setLiabilities] = useState(init.liabilities || []);
  const [holdings, setHoldings] = useState(init.holdings || []);
  const [fxRates, setFxRates] = useState(init.fxRates || DEFAULT_FX);
  const [cash, setCash] = useState(init.cash ?? 0);
  const [rejse, setRejse] = useState(init.rejse || DEFAULT_REJSE);
  const [sync, setSync] = useState(init.sync || {bank:null, saxo:null});
  const [history, setHistory] = useState(init.history || []);
  const [rent, setRent] = useState(init.rent || DEFAULT_RENT);
  const [subsHidden, setSubsHidden] = useState(init.subsHidden || []);
  const [subsShare, setSubsShare] = useState(init.subsShare || {});
  const [shop, setShop] = useState(init.shop || DEFAULT_SHOP);
  const [offers, setOffers] = useState({}); // itemId -> {loading, error, list}
  const [shopDraft, setShopDraft] = useState("");
  const [foodTab, setFoodTab] = useState("plan");
  const [mealDraft, setMealDraft] = useState({ name: "", ingredients: "", url: "" });
  const [planBusy, setPlanBusy] = useState(false);
  const [invHistory, setInvHistory] = useState(init.invHistory || []);
  const [saveError, setSaveError] = useState(false);

  // ui state
  const [search, setSearch] = useState("");
  const [filterMonth, setFilterMonth] = useState("all");
  const [filterCat, setFilterCat] = useState("all");
  const [openTx, setOpenTx] = useState(null);
  const [openHolding, setOpenHolding] = useState(null);
  const [budgetMonthSel, setBudgetMonthSel] = useState(currentBudgetMonth());
  const [editBudget, setEditBudget] = useState(false);
  const [nwRange, setNwRange] = useState("1M");
  const [invRange, setInvRange] = useState("3M");
  const [pickTrip, setPickTrip] = useState(null);
  const [csvPaste, setCsvPaste] = useState("");
  const [msgs, setMsgs] = useState({});
  const [aiMsg, setAiMsg] = useState(""); const [aiLoading, setAiLoading] = useState(false);
  const [priceLoading, setPriceLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [saxoNeedsLogin, setSaxoNeedsLogin] = useState(false);
  const [pendingCode, setPendingCode] = useState(null); // OAuth code that arrived in a context without the bridge config
  const [codePaste, setCodePaste] = useState("");

  // settings
  const [theme, setThemeState] = useState(store.get(THEME_KEY) || "dark");
  const [hideAmounts, setHideAmounts] = useState(store.get(PRIVACY_KEY) === "1");
  HIDE_AMOUNTS = hideAmounts;
  const toggleHide = () => { const v = !hideAmounts; setHideAmounts(v); if (v) store.set(PRIVACY_KEY, "1"); else store.remove(PRIVACY_KEY); };
  const [apiKey, setApiKey] = useState(store.get(API_KEY_KEY) || "");
  const [keyDraft, setKeyDraft] = useState("");
  const [model, setModel] = useState(store.get(MODEL_KEY) || DEFAULT_MODEL);
  const [bridge, setBridgeState] = useState(store.json(BRIDGE_KEY) || {url:"", secret:""});
  const [bridgeDraft, setBridgeDraft] = useState(store.json(BRIDGE_KEY) || {url:"", secret:""});
  const [ebSession, setEbSessionState] = useState(store.json(EB_KEY));
  const [saxoTokens, setSaxoTokensState] = useState(store.json(SAXO_KEY));
  const [busy, setBusy] = useState("");
  const [pingChecks, setPingChecks] = useState(null);
  const [toast, setToast] = useState(null); // {text, undo}
  const toastTimer = useRef();

  const fileRef = useRef();
  const importRef = useRef();
  const stateRef = useRef();
  stateRef.current = { transactions, assets, holdings, fxRates, sync, ebSession, saxoTokens };

  const flash = (key, text, ms = 5000) => {
    setMsgs(m => ({...m, [key]: text}));
    if (ms) setTimeout(() => setMsgs(m => m[key] === text ? {...m, [key]: ""} : m), ms);
  };
  const setEbSession = (s) => { setEbSessionState(s); if (s) store.setJson(EB_KEY, s); else store.remove(EB_KEY); };
  const setSaxoTokens = (t) => { setSaxoTokensState(t); if (t) store.setJson(SAXO_KEY, t); else store.remove(SAXO_KEY); };
  const setTheme = (t) => {
    setThemeState(t); store.set(THEME_KEY, t);
    document.documentElement.dataset.theme = t;
    const light = t === "light" || (t === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#F3F5FB" : "#0B0F1A");
  };

  const applyData = (d) => {
    if (d.transactions) setTransactions(d.transactions);
    if (d.budgets) setBudgets(d.budgets);
    if (d.assets) setAssets(d.assets);
    if (d.liabilities) setLiabilities(d.liabilities);
    if (d.holdings) setHoldings(d.holdings);
    if (d.fxRates) setFxRates(d.fxRates);
    if (typeof d.cash === "number") setCash(d.cash);
    if (d.rejse) setRejse(d.rejse);
    if (d.sync) setSync(d.sync);
    if (d.history) setHistory(d.history);
    if (d.rent) setRent(d.rent);
    if (d.subsHidden) setSubsHidden(d.subsHidden);
    if (d.subsShare) setSubsShare(d.subsShare);
    if (d.shop) setShop(d.shop);
    if (d.invHistory) setInvHistory(d.invHistory);
  };
  const loadData = () => applyData(readStored());

  useEffect(() => {
    const ok = store.set(STORAGE_KEY, JSON.stringify({version:DATA_VERSION,transactions,budgets,assets,liabilities,holdings,fxRates,cash,rejse,sync,history,rent,subsHidden,subsShare,invHistory,shop}));
    setSaveError(!ok);
  }, [transactions, budgets, assets, liabilities, holdings, fxRates, cash, rejse, sync, history, rent, subsHidden, subsShare, invHistory, shop]);

  useEffect(() => { navigator.storage?.persist?.().catch(()=>{}); }, []);
  useEffect(() => {
    const onStorage = (e) => { if (e.key === STORAGE_KEY) loadData(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // ---------- derived numbers ----------

  const months = [...new Set(transactions.map(t => budgetMonth(t.date,t.amount,t.category)))].filter(Boolean).sort().reverse();

  const monthStats = (ym) => {
    const mtx = transactions.filter(t => !EXCLUDED.includes(t.category) && !t.trip && budgetMonth(t.date,t.amount,t.category) === ym);
    const { inc, exp, cn } = monthIncomeExpense(mtx);
    const byCat = {};
    for (const c of CATEGORIES) byCat[c] = INCOME_CATS.includes(c) ? 0 : Math.max(0, -cn[c]);
    return { inc, exp, byCat, count: mtx.length };
  };

  const budgetCats = CATEGORIES.filter(c => !EXCLUDED.includes(c) && !INCOME_CATS.includes(c));
  const totalBudget = budgetCats.reduce((s,c)=>s+(+budgets[c]||0),0);

  const rate = (c) => (!c || c === "DKK") ? 1 : (fxRates[c] || 1);
  const holdingValue = (h) => (+h.shares||0)*(+h.price||0)*rate(h.currency);
  const holdingCost = (h) => (+h.shares||0)*(+h.avgCost||0)*rate(h.currency);
  const invCost = holdings.reduce((s,h)=>s+holdingCost(h),0);
  const invSecurities = holdings.reduce((s,h)=>s+holdingValue(h),0);
  const invValue = invSecurities + (+cash||0);
  const invGain = invSecurities - invCost;
  const sumAssets = assets.reduce((s,a)=>s+(+a.value||0),0);
  const sumLiab = liabilities.reduce((s,l)=>s+(+l.value||0),0);
  const netWorth = sumAssets + invValue - sumLiab;

  // One net-worth snapshot per day; drives the hero graph.
  useEffect(() => {
    const today = isoDate(new Date());
    const v = Math.round(netWorth);
    setHistory(h => {
      const last = h[h.length-1];
      if (last && last.d === today) return last.v === v ? h : [...h.slice(0,-1), {d:today, v}];
      return [...h, {d:today, v}].slice(-800);
    });
  }, [netWorth]);

  // One depot snapshot per day (value incl. cash, and cost basis) for the investment graph.
  useEffect(() => {
    if (!holdings.length || !(invValue > 0)) return;
    const today = isoDate(new Date());
    const p = { d: today, v: Math.round(invValue), c: Math.round(invCost + (+cash || 0)) };
    setInvHistory(h => {
      const last = h[h.length-1];
      if (last && last.d === today) return last.v === p.v && last.c === p.c ? h : [...h.slice(0,-1), p];
      return [...h, p].slice(-1500);
    });
  }, [invValue, invCost]);

  const recurringIn = detectRecurring(transactions, 1);
  const subscriptionsRaw = detectSubscriptions(transactions, subsHidden);
  // subsShare[subKey] is the key of the payment-in that covers part of it, or "none"; unset means guess.
  const [termOffers, setTermOffers] = useState({}); // ingredient -> offers (this session)
  const offersFor = async (term) => {
    if (termOffers[term]) return termOffers[term];
    const list = await searchOffers(term, shop).catch(() => []);
    setTermOffers(m => ({...m, [term]: list}));
    return list;
  };
  const loadOffers = async (item) => {
    setOffers(m => ({...m, [item.id]: {loading: true}}));
    try { const list = await searchOffers(item.name, shop); setOffers(m => ({...m, [item.id]: {list}})); }
    catch (e) { setOffers(m => ({...m, [item.id]: {error: e.message || "Tilbud kunne ikke hentes."}})); }
  };
  // Offers aren't stored; fetch them for the open list whenever the shopping page is shown.
  useEffect(() => {
    if (page === "food") shop.items.filter(i => !i.done && !offers[i.id]).forEach(loadOffers);
  }, [page, foodTab, shop.items.length, shop.lat, shop.lng]);

  const subscriptions = subscriptionsRaw.map(x => {
    const pick = subsShare[x.key];
    const share = pick === "none" ? null : pick ? recurringIn.find(i => i.key === pick) || null : guessShare(x, recurringIn);
    const back = share ? Math.min(share.monthly, x.monthly) : 0;
    return { ...x, share, net: x.monthly - back };
  });
  const subsMonthly = subscriptions.reduce((s, x) => s + x.net, 0);

  // Travel fund: the user and the sister each earmark `rejse.goal` (the user's part sits in savings).
  // A trip costs what both laid out; each pays half, so the one who paid more is owed the difference.
  const tripStats = (trip) => {
    const txs = transactions.filter(t => t.trip === trip.id).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const mine = txs.reduce((s, t) => s + (t.amount < 0 ? -t.amount : 0), 0);
    const hers = +trip.sisterPaid || 0;
    const total = mine + hers, half = Math.round(total / 2 * 100) / 100;
    // Money tagged to the trip coming in is the sister paying back; paidBack covers payments outside the bank.
    const repaid = txs.reduce((s, t) => s + (t.amount > 0 ? t.amount : 0), 0) + (+trip.paidBack || 0);
    const owed = Math.round((mine - half - repaid) * 100) / 100; // > 0: søs owes the user; < 0: the user owes søs
    return { txs, mine, hers, total, half, repaid, owed };
  };
  const tripsUsed = rejse.trips.reduce((s, tr) => s + tripStats(tr).half, 0);
  const rejseLeft = (+rejse.goal || 0) - tripsUsed;
  const tripsOwed = rejse.trips.reduce((s, tr) => s + Math.max(0, tripStats(tr).owed), 0);
  const earmarkAsset = assets.find(a => a.id === rejse.accountId) || (!rejse.accountId ? assets.find(a => a.source !== "bank" && /opspar/i.test(a.name)) : null) || null;

  // Month-to-date spending per category vs. the same days last month (calendar months).
  const spendingInsight = () => {
    const now = new Date();
    const dom = now.getDate();
    const thisYM = isoDate(now).slice(0,7), lastYM = prevMonth(thisYM);
    const sums = (ym) => {
      const out = {};
      for (const t of transactions) {
        if (!t.date || t.date.slice(0,7) !== ym || +t.date.slice(8,10) > dom) continue;
        if (INCOME_CATS.includes(t.category) || EXCLUDED.includes(t.category) || t.category === "Husleje" || t.trip) continue;
        if (eff(t) < 0) out[t.category] = (out[t.category] || 0) - eff(t);
      }
      return out;
    };
    const cur = sums(thisYM), prev = sums(lastYM);
    if (!Object.keys(prev).length) return null;
    let best = null;
    for (const c of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
      const a = cur[c] || 0, b = prev[c] || 0;
      if (b < 200 && a < 200) continue;
      const diff = a - b;
      const pct = b > 0 ? diff / b * 100 : 100;
      if (Math.abs(pct) < 15 || Math.abs(diff) < 100) continue;
      const score = Math.abs(diff) * (diff < 0 ? 1.2 : 1);
      if (!best || score > best.score) best = { c, pct, diff, score };
    }
    if (!best) return null;
    const lastName = MONTHS_DA[+lastYM.slice(5)-1];
    const cat = (SHORT_CAT[best.c] || best.c).toLowerCase();
    return best.diff < 0
      ? { good: true, text: html`Du har brugt <b className="pos">${Math.round(-best.pct)} % mindre</b> på ${cat} end på samme tid i ${lastName}.` }
      : { good: false, text: html`Du har brugt <b className="neg">${best.pct >= 100 && !(prev[best.c]) ? fmt(best.diff) + " mere" : Math.round(best.pct) + " % mere"}</b> på ${cat} end på samme tid i ${lastName}.` };
  };

  // Completed budget months in a row with spending at or under the total budget.
  const budgetStreak = () => {
    const cur = currentBudgetMonth();
    let m = prevMonth(cur), n = 0;
    for (let i = 0; i < 36; i++) {
      const st = monthStats(m);
      if (!st.count || st.exp > totalBudget) break;
      n++; m = prevMonth(m);
    }
    return n;
  };

  // ---------- transactions ----------

  const dayBefore = (iso) => { const d = parseDKDate(iso); if (!d) return null; d.setDate(d.getDate()-1); return isoDate(d); };
  const mergeRows = (rows) => {
    const merged = [...transactions];
    let added = 0;
    for (const row of rows) {
      const prev = dayBefore(row.date);
      const dup = merged.find(t => t.description === row.description && t.amount === row.amount && (t.date === row.date || (!t.localDate && t.date === prev)));
      if (!dup) { merged.push(row); added++; }
    }
    setTransactions(merged);
    return added;
  };

  const importCsvText = (text) => {
    const rows = parseCSV(text);
    if (!rows.length) { flash("import", "Kunne ikke læse CSV. Tjek formatet (dato;tekst;beløb)."); return; }
    const n = mergeRows(rows);
    flash("import", `${n} nye poster importeret${rows.length - n ? `, ${rows.length - n} dubletter sprunget over` : ""}.`);
  };
  const handleFile = (file) => { const r = new FileReader(); r.onload = e => importCsvText(e.target.result); r.readAsText(file, "utf-8"); };

  const addManual = () => {
    const t = {id:uid(),date:isoDate(new Date()),description:"Ny transaktion",amount:-100,category:"Andet",localDate:true};
    setTransactions([t, ...transactions]); setSearch(""); setFilterMonth("all"); setFilterCat("all"); setOpenTx(t.id);
  };
  const showUndo = (text, restore) => {
    clearTimeout(toastTimer.current);
    setToast({ text, restore });
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  };
  const deleteTx = (id) => {
    const prev = transactions;
    setTransactions(transactions.filter(t => t.id !== id)); setOpenTx(null);
    showUndo("Posten er slettet", () => setTransactions(prev));
  };
  const editTx = (id, patch) => setTransactions(transactions.map(t => t.id === id ? {...t, ...patch} : t));

  const recategorizeAll = () => {
    let n = 0;
    const next = transactions.map(t => {
      if (t.category === "Udeladt" || INCOME_CATS.includes(t.category) || t.manualCategory) return t;
      const g = guessCategory(t.description);
      if (g !== t.category) n++;
      return {...t, category: g};
    });
    setTransactions(next);
    flash("tools", n === 0 ? "Alt var allerede korrekt." : `${n} poster opdateret.`);
  };

  const rentTx = (ym) => ({id:uid(),date:monthEnd(ym),description:RENT_TEXT,amount:-Math.abs(rent.amount||0),category:"Husleje",localDate:true});

  // Back-fills rent for every month with postings, and brings existing rent postings up to the current amount.
  const genRent = () => {
    const mset = new Set(transactions.map(t=>t.date?.slice(0,7)).filter(Boolean));
    mset.add(lastRentMonth());
    const amount = -Math.abs(rent.amount||0);
    let changed = 0;
    const updated = transactions.map(t => t.description === RENT_TEXT && t.amount !== amount ? (changed++, {...t, amount}) : t);
    const additions = [...mset].sort().filter(ym => !updated.some(t => t.date === monthEnd(ym) && t.description === RENT_TEXT)).map(rentTx);
    if (additions.length || changed) {
      setTransactions([...additions, ...updated]);
      flash("tools", [additions.length && `${additions.length} huslejeposter tilføjet`, changed && `${changed} rettet til ${fmt(rent.amount)}`].filter(Boolean).join(", ").replace(/\.?$/, "."));
    }
    else flash("tools", "Allerede tilføjet for alle måneder.");
  };

  // Books the fixed rent each month and draws it from the chosen manual account (e.g. savings), once per month.
  useEffect(() => {
    if (!rent.auto || !(rent.amount > 0)) return;
    const upTo = lastRentMonth();
    if (rent.paidThrough && rent.paidThrough >= upTo) return;
    // First run: the account balance the user typed in already reflects past rent, so only post, don't draw.
    const first = !rent.paidThrough;
    const due = [];
    for (let ym = first ? upTo : addMonths(rent.paidThrough, 1); ym <= upTo; ym = addMonths(ym, 1)) due.push(ym);
    setTransactions(txs => {
      const missing = due.filter(ym => !txs.some(t => t.date === monthEnd(ym) && t.description === RENT_TEXT));
      return missing.length ? [...missing.map(rentTx), ...txs] : txs;
    });
    const assetId = rent.assetId || (first ? assets.find(a => a.source !== "bank" && /opspar/i.test(a.name))?.id : null) || null;
    if (!first && assetId) {
      setAssets(as => as.map(a => a.id === assetId ? {...a, value: Math.round(((+a.value||0) - due.length * Math.abs(rent.amount)) * 100) / 100} : a));
    }
    setRent(r => ({...r, assetId, paidThrough: upTo}));
  }, [rent]);

  // ---------- bank sync (Enable Banking via worker) ----------

  const applyBankResult = (session, result) => {
    const { transactions: txs, assets: as } = stateRef.current;
    const merged = [...txs];
    const byExt = new Set(txs.filter(t => t.extId).map(t => t.extId));
    const norm = (s) => (s||"").toLowerCase().replace(/\s+/g," ").trim();
    let added = 0;
    for (const acc of result.accounts || []) {
      for (const t of acc.transactions || []) {
        if (!t.date) continue;
        const extId = "eb:" + (t.ref || `${acc.uid}:${t.date}:${t.amount}:${norm(t.description)}`);
        if (byExt.has(extId)) continue;
        byExt.add(extId);
        // Same posting already imported by CSV/hand? Link it instead of duplicating.
        const twin = merged.find(x => !x.extId && x.amount === t.amount && (x.date === t.date || (!x.localDate && x.date === dayBefore(t.date))) && norm(x.description) === norm(t.description));
        if (twin) { twin.extId = extId; continue; }
        merged.push({ id: uid(), date: t.date, description: t.description, amount: t.amount, category: guessCategory(t.description), localDate: true, extId, source: "bank", account: acc.uid });
        added++;
      }
    }
    const nextAssets = [...as];
    for (const acc of result.accounts || []) {
      if (acc.balance == null) continue;
      const meta = (session.accounts || []).find(a => a.uid === acc.uid) || {};
      const id = "eb:" + acc.uid;
      const name = meta.name || "Konto";
      const i = nextAssets.findIndex(a => a.id === id);
      const entry = { id, name: i >= 0 ? nextAssets[i].name : name, value: Math.round(acc.balance * 100) / 100, source: "bank", iban: meta.iban || null };
      if (i >= 0) nextAssets[i] = entry; else nextAssets.push(entry);
    }
    setTransactions(merged.map(t => ({...t})));
    setAssets(nextAssets);
    return added;
  };

  const syncBank = async (interactive = true) => {
    const { ebSession: session, transactions: txs, sync: s } = stateRef.current;
    if (!session?.session_id) return null;
    let dateFrom;
    if (s.bank) dateFrom = addDays(isoDate(new Date(s.bank)), -10);
    else {
      // First sync: start after the newest existing (CSV/manual) posting to avoid overlaps, max one year back.
      const latest = txs.filter(t => t.source !== "bank" && t.description !== "Husleje (fast)" && t.date <= isoDate(new Date())).map(t => t.date).sort().pop();
      const yearAgo = addDays(isoDate(new Date()), -365);
      dateFrom = latest && latest > yearAgo ? addDays(latest, 1) : yearAgo;
    }
    const result = await callBridge("/eb/sync", { session_id: session.session_id, accounts: session.accounts.map(a => a.uid), date_from: dateFrom, interactive });
    if (result.status && result.status !== "AUTHORIZED") {
      setEbSession({ ...session, status: result.status });
      throw new Error(`Adgangen til banken er ${result.status === "EXPIRED" ? "udløbet" : "ikke længere gyldig"}. Forny den under Mere → Bankforbindelser.`);
    }
    const added = applyBankResult(session, result);
    setSync(prev => ({ ...prev, bank: new Date().toISOString() }));
    if (result.valid_until && result.valid_until !== session.valid_until) setEbSession({ ...session, valid_until: result.valid_until });
    return added;
  };

  // ---------- Saxo ----------

  const saxoAccessValid = (t) => t && t.accessExp > Date.now() + 30000;
  const saxoRefreshValid = (t) => t && t.refreshExp > Date.now() + 30000;
  const storeSaxoTokens = (r) => {
    const now = Date.now();
    const t = { access: r.access_token, accessExp: now + (r.expires_in || 1200) * 1000, refresh: r.refresh_token, refreshExp: now + (r.refresh_token_expires_in || 2400) * 1000 };
    setSaxoTokens(t);
    stateRef.current.saxoTokens = t;
    return t;
  };

  const applySaxoPortfolio = (p) => {
    const { holdings: hs, fxRates: fx } = stateRef.current;
    const fxNext = { ...fx };
    for (const pos of p.positions) {
      if (pos.currency !== "DKK" && pos.marketValue && pos.marketValueBase) {
        const r = pos.marketValueBase / pos.marketValue;
        if (r > 0 && isFinite(r)) fxNext[pos.currency] = Math.round(r * 10000) / 10000;
      }
    }
    const root = (sym) => (sym || "").split(":")[0].toUpperCase();
    const posNames = new Set(p.positions.map(x => x.name));
    const posRoots = new Set(p.positions.map(x => root(x.symbol)));
    const keep = hs.filter(h => h.source !== "saxo" && !SAXO_SEED_NAMES.includes(h.name) && !posNames.has(h.name) && !(h.ticker && posRoots.has(root(h.ticker))));
    const fromSaxo = p.positions.map(x => ({
      id: "saxo:" + x.id, name: x.name, ticker: root(x.symbol), currency: x.currency,
      shares: x.amount, avgCost: x.avgPrice, price: x.price, type: x.assetType || null, source: "saxo",
    }));
    setHoldings([...fromSaxo, ...keep]);
    setFxRates(fxNext);
    setCash(Math.round((p.cash || 0) * 100) / 100);
    setSync(prev => ({ ...prev, saxo: new Date().toISOString() }));
    return { count: fromSaxo.length, currencyWarning: p.currency && p.currency !== "DKK" ? p.currency : null };
  };

  // Returns true if synced, false if a fresh login is needed.
  const syncSaxo = async () => {
    let t = stateRef.current.saxoTokens;
    if (!t) return false;
    if (!saxoAccessValid(t)) {
      if (!saxoRefreshValid(t)) return false;
      try { t = storeSaxoTokens(await callBridge("/saxo/refresh", { refresh_token: t.refresh, redirect_uri: redirectUrl() })); }
      catch { return false; }
    }
    let p;
    try { p = await callBridge("/saxo/portfolio", { access_token: t.access }); }
    catch (e) { if (e.code === "saxo_login") { setSaxoTokens(null); return false; } throw e; }
    const r = applySaxoPortfolio(p);
    if (r.currencyWarning) flash("saxo", `Bemærk: din Saxo-konto er i ${r.currencyWarning}, ikke DKK. Kontantbeløbet er ikke omregnet.`, 10000);
    return true;
  };

  const startSaxoLogin = async () => {
    setBusy("saxo");
    try {
      const { url } = await callBridge("/saxo/start", { redirect_uri: redirectUrl(), state: beginOAuth("saxo") });
      location.href = url;
    } catch (e) { flash("saxo", e.message, 10000); setBusy(""); }
  };

  const startBankLink = async () => {
    setBusy("bank");
    try {
      const { url } = await callBridge("/eb/start", { redirect_url: redirectUrl(), state: beginOAuth("eb") });
      location.href = url;
    } catch (e) { flash("bank", e.message, 10000); setBusy(""); }
  };

  // ---------- sync all ----------

  const syncAll = async ({ auto = false } = {}) => {
    if (syncing) return;
    setSyncing(true); setSyncError("");
    const errors = [];
    let bankAdded = null;
    if (stateRef.current.ebSession?.session_id && stateRef.current.ebSession.status !== "EXPIRED") {
      try { bankAdded = await syncBank(!auto); }
      catch (e) {
        // A quiet background attempt that hit the bank's daily limit isn't worth an error banner.
        if (!(auto && e.code === "rate_limited")) errors.push("Bank: " + e.message);
      }
    }
    if (stateRef.current.saxoTokens) {
      try { const ok = await syncSaxo(); setSaxoNeedsLogin(!ok); } catch (e) { errors.push("Saxo: " + e.message); }
    } else if (!auto && store.json(BRIDGE_KEY)) {
      setSaxoNeedsLogin(true);
    }
    setSyncing(false);
    if (errors.length) setSyncError(errors.join(" · "));
    else if (!auto && bankAdded != null) flash("sync", bankAdded ? `${bankAdded} nye poster fra banken.` : "Ingen nye poster.");
  };

  // ---------- OAuth return + auto sync on open ----------

  const finishOAuth = async (provider, code) => {
    if (provider === "eb") {
      const s = await callBridge("/eb/session", { code });
      if (!s.accounts?.length) throw new Error("Banken returnerede ingen konti. Har du linket kontiene i Enable Banking-portalen?");
      const session = { session_id: s.session_id, valid_until: s.valid_until, bank: s.bank, accounts: s.accounts, status: "AUTHORIZED" };
      setEbSession(session); stateRef.current.ebSession = session;
      setSub("connections"); setPage("more");
      flash("bank", `Forbundet til ${s.bank || "banken"} med ${s.accounts.length} konti. Henter poster…`, 8000);
      const added = await syncBank();
      flash("bank", `Forbundet. ${added} poster hentet.`, 10000);
    } else if (provider === "saxo") {
      storeSaxoTokens(await callBridge("/saxo/token", { code, redirect_uri: redirectUrl() }));
      setSaxoNeedsLogin(false);
      setPage("invest");
      await syncSaxo();
      flash("saxo", "Saxo er opdateret.", 6000);
    }
  };

  const replaceUrl = () => { try { window.history.replaceState(null, "", location.pathname); } catch {} };

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get("code"), state = q.get("state"), error = q.get("error");
    if (code || error) {
      replaceUrl();
      const pending = store.json(OAUTH_KEY);
      const [provider, nonce] = (state || "").split(".");
      if (error) {
        setPage("more"); setSub("connections");
        flash(provider === "saxo" ? "saxo" : "bank", `Login blev afbrudt: ${q.get("error_description") || error}`, 10000);
        return;
      }
      if (!["eb","saxo"].includes(provider)) return;
      if (!store.json(BRIDGE_KEY)) {
        // Returned into a browser context without the app's settings (e.g. Safari vs. home-screen app on iPhone).
        setPendingCode(`${provider}.${code}`);
        return;
      }
      if (!pending || pending.nonce !== nonce) {
        setPage("more"); setSub("connections");
        flash(provider === "saxo" ? "saxo" : "bank", "Login-svaret passede ikke med en igangværende forbindelse. Prøv igen.", 10000);
        return;
      }
      store.remove(OAUTH_KEY);
      setSyncing(true);
      finishOAuth(provider, code)
        .catch(e => { setPage("more"); setSub("connections"); flash(provider === "saxo" ? "saxo" : "bank", e.message, 12000); })
        .finally(() => setSyncing(false));
      return;
    }
    const s = stateRef.current;
    const stale = !s.sync.bank || Date.now() - new Date(s.sync.bank).getTime() > BANK_AUTO_SYNC_HOURS * 3600e3;
    if (s.ebSession?.session_id && stale) syncAll({ auto: true });
    else if (s.saxoTokens && saxoRefreshValid(s.saxoTokens)) syncAll({ auto: true });
  }, []);

  const redeemPastedCode = async () => {
    const [provider, ...rest] = codePaste.trim().split(".");
    const code = rest.join(".");
    if (!["eb","saxo"].includes(provider) || !code) { flash("paste", "Koden ser ikke rigtig ud."); return; }
    setSyncing(true);
    try { await finishOAuth(provider, code); setCodePaste(""); }
    catch (e) { flash("paste", e.message, 10000); }
    setSyncing(false);
  };

  // ---------- AI ----------

  const noKeyMsg = "Tilføj din Claude API-nøgle under Mere → Claude API-nøgle for at bruge denne funktion.";

  const updatePricesAI = async () => {
    const list = holdings.filter(h => h.source !== "saxo" && (h.ticker || h.name));
    if (!list.length) { flash("price", "Der er ingen manuelle beholdninger at opdatere."); return; }
    setPriceLoading(true);
    const q = list.map(h => `${h.ticker || h.name} (${h.currency||"DKK"})`).join(", ");
    try {
      const data = await callClaude({
        tools:[{type:"web_search_20260209", name:"web_search", max_uses:10}],
        messages:[{role:"user", content:`Find den seneste kurs for hvert af disse værdipapirer i den ANGIVNE valuta (ikke omregnet): ${q}. Find også aktuelle valutakurser: antal DKK pr. 1 EUR, USD, GBP, SEK og NOK. Svar til sidst UDELUKKENDE med ét JSON-objekt på formen {"prices":{"<navn eller ticker præcis som skrevet>":kurs_tal,...},"fx":{"EUR":7.46,"USD":6.85,"GBP":8.7,"SEK":0.66,"NOK":0.65}}. Ingen forklaring, ingen markdown.`}]
      });
      const obj = extractJSON(textOf(data));
      const prices = obj.prices || {};
      const fx = {...fxRates};
      for (const [k,v] of Object.entries(obj.fx||{})) if (typeof v === "number" && v > 0) fx[k] = v;
      let n = 0;
      const next = holdings.map(h => {
        if (h.source === "saxo") return h;
        const p = prices[h.ticker] ?? prices[h.name] ?? prices[`${h.ticker || h.name} (${h.currency||"DKK"})`];
        if (typeof p === "number" && p > 0) { n++; return {...h, price: Math.round(p*100)/100}; }
        return h;
      });
      setHoldings(next); setFxRates(fx);
      flash("price", n ? `${n} kurser opdateret.` : "Kunne ikke finde kurserne – tjek ticker eller indtast manuelt.", 8000);
    } catch(e) {
      flash("price", e instanceof NoKeyError ? noKeyMsg : `Fejl ved kurshentning: ${e.message}`, 10000);
    }
    setPriceLoading(false);
  };

  const runAI = async () => {
    setAiLoading(true); setAiMsg("");
    const ym = currentBudgetMonth();
    const st = monthStats(ym);
    const allMonths = months.map(m => { const s = monthStats(m); return { måned: m, indkomst: Math.round(s.inc), udgifter: Math.round(s.exp) }; }).slice(0, 6);
    const summary = { indeværendeMåned: ym, indkomst: Math.round(st.inc), udgifter: Math.round(st.exp), udgifterPerKategori: Object.fromEntries(Object.entries(st.byCat).filter(([,v])=>v>0).map(([k,v])=>[k,Math.round(v)])), budget: budgets, seneste6Måneder: allMonths, netværdi: Math.round(netWorth), investeringer: Math.round(invValue) };
    try {
      const data = await callClaude({ system:"Du er en venlig dansk personlig økonomicoach. Analyser brugerens økonomi og giv 3-5 konkrete, handlingsorienterede råd på dansk. Vær specifik og brug tallene. Formatér svar med •-punkter og ingen markdown-overskrifter.", messages:[{role:"user",content:`Analyser min økonomi:\n${JSON.stringify(summary,null,2)}`}] });
      setAiMsg(textOf(data) || "Ingen svar.");
    } catch(e) {
      setAiMsg(e instanceof NoKeyError ? noKeyMsg : `Fejl ved kontakt til AI: ${e.message}`);
    }
    setAiLoading(false);
  };

  // ---------- backup ----------

  const exportData = () => {
    const data = {version:DATA_VERSION,transactions,budgets,assets,liabilities,holdings,fxRates,cash,rejse,sync,history,rent,subsHidden,subsShare,invHistory,shop,exported:new Date().toISOString()};
    const blob = new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `oekonomi-backup-${isoDate(new Date())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
    store.set(BACKUP_KEY, String(Date.now()));
    flash("backup", "Backup downloadet.");
  };
  const importData = (file) => {
    const r = new FileReader();
    r.onload = e => {
      try { applyData(normalizeData(JSON.parse(e.target.result))); flash("backup", "Data importeret."); }
      catch { flash("backup", "Kunne ikke læse filen."); }
    };
    r.readAsText(file);
  };

  // ================= render helpers =================

  const Msg = ({ k }) => msgs[k] ? html`<div className=${"msg " + (/Fejl|fejl|ikke|afvist|mangler|udløbet|afbrudt|passede/.test(msgs[k]) ? "neg" : "pos")}>${msgs[k]}</div>` : null;
  const badge = (text, bg, fg = "#fff") => html`<div className="badge" style=${{background: bg, color: fg}}>${text}</div>`;
  const goSub = (id) => { setPage("more"); setSub(id); window.scrollTo(0,0); };
  const amountClass = (n) => n >= 0 ? "num pos" : "num";
  const stag = (i) => ({ "--i": Math.min(i, 14) });

  const TxRow = (t, i = 0) => {
    const open = openTx === t.id;
    return html`<div key=${t.id} style=${stag(i)}>
      <button className="row" onClick=${() => setOpenTx(open ? null : t.id)}>
        <${CatIcon} cat=${t.category} />
        <div className="main"><div className="title">${t.description}</div><div className="sub">${t.category}${t.trip ? ` · ${rejse.trips.find(tr => tr.id === t.trip)?.name || "rejse"}` : ""}${t.source === "bank" ? " · bank" : ""}</div></div>
        <div className=${"end " + amountClass(t.amount)}>${fmt(t.amount)}</div>
      </button>
      ${open && html`<div className="expand stack">
        <label className="field">Tekst<input className="input" value=${t.description} onChange=${e=>editTx(t.id,{description:e.target.value})} /></label>
        <div className="grid2">
          <label className="field">Kategori<select className="input" value=${t.category} onChange=${e=>editTx(t.id,{category:e.target.value, manualCategory:true})}>${CATEGORIES.map(c=>html`<option key=${c} value=${c}>${c}</option>`)}</select></label>
          <label className="field">Beløb<input className="input" type="number" inputMode="decimal" value=${t.amount} disabled=${t.source === "bank"} onChange=${e=>editTx(t.id,{amount:+e.target.value})} /></label>
        </div>
        <div className="grid2">
          <label className="field">Dato<input className="input" type="date" value=${t.date} disabled=${t.source === "bank"} onChange=${e=>editTx(t.id,{date:e.target.value, localDate:true})} /></label>
          <label className="field">Delt udgift<select className="input" value=${t.delt ? "1" : "0"} onChange=${e=>editTx(t.id,{delt:e.target.value==="1"})}><option value="0">Nej</option><option value="1">Ja, tæl halvdelen</option></select></label>
        </div>
        ${rejse.trips.length > 0 && html`<label className="field">Rejse (deles med søs, uden for budgettet)<select className="input" value=${t.trip || ""} onChange=${e=>editTx(t.id,{trip:e.target.value || null})}>
          <option value="">Ingen</option>
          ${rejse.trips.map(tr => html`<option key=${tr.id} value=${tr.id}>${tr.name}</option>`)}
        </select></label>`}
        <div className="btns"><button className="btn danger" onClick=${()=>deleteTx(t.id)}><${Icon} name="trash" /> Slet</button><button className="btn" onClick=${()=>setOpenTx(null)}>Luk</button></div>
      </div>`}
    </div>`;
  };

  // ================= pages =================

  const HomePage = () => {
    const ym = currentBudgetMonth();
    const st = monthStats(ym);
    const left = totalBudget - st.exp;
    const pay = nextPayday();
    const perDay = left / Math.max(1, pay.days);
    const insight = spendingInsight();
    const bankAssets = assets.filter(a => a.source === "bank");
    const otherAssets = assets.filter(a => a.source !== "bank");
    const recent = transactions.slice().sort((a,b)=>(b.date||"").localeCompare(a.date||"")).slice(0,5);
    const connected = Boolean(ebSession?.session_id) || Boolean(saxoTokens);
    const since = addDays(isoDate(new Date()), -RANGES[nwRange]);
    const pts = history.filter(p => p.d >= since);
    const base = pts[0];
    const change = base && pts.length > 1 ? netWorth - base.v : null;
    const monthStart = isoDate(new Date()).slice(0,8) + "01";
    const rangeText = nwRange === "1M" ? (base && base.d >= monthStart ? "denne måned" : "seneste måned") : nwRange === "3M" ? "seneste 3 måneder" : "seneste år";
    let row = 0;
    return html`<div>
      ${saxoNeedsLogin && store.json(BRIDGE_KEY) && html`<div className="banner info"><${Icon} name="trend" /><span className="grow">Log ind på Saxo for at opdatere dine investeringer.</span><button className="btn soft" onClick=${startSaxoLogin} disabled=${busy==="saxo"}>Log ind</button></div>`}
      ${ebSession?.status && ebSession.status !== "AUTHORIZED" && html`<div className="banner warn"><${Icon} name="bank" /><span className="grow">Adgangen til banken skal fornyes.</span><button className="btn soft" onClick=${startBankLink}>Forny</button></div>`}

      <div className="hero">
        <div className="label">Samlet formue</div>
        <div className="big"><${CountUp} value=${Math.round(netWorth)} /></div>
        <div className="hero-row">
          ${change != null
            ? html`<span className=${"chip " + (change >= 0 ? "up" : "down")}>${change >= 0 ? "+" : ""}${fmt(change)}</span><span className="hm">${rangeText}</span>`
            : html`<span className="hm">Grafen fyldes ud, efterhånden som du bruger appen.</span>`}
        </div>
        <${Sparkline} points=${pts} />
        <div className="ranges">${Object.keys(RANGES).map(r => html`<button key=${r} className=${nwRange === r ? "on" : ""} onClick=${()=>setNwRange(r)}>${r}</button>`)}</div>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="label">Løn om</div>
          <div className="value">${pay.days === 0 ? "I dag" : pay.days === 1 ? "1 dag" : `${pay.days} dage`}</div>
          <div className="foot">${pay.date.getDate()}. ${MONTHS_DA[pay.date.getMonth()].slice(0,3)}.</div>
        </div>
        <div className="tile">
          <div className="label">${left >= 0 ? "Tilbage at bruge" : "Over budget"}</div>
          <div className=${"value " + (left >= 0 ? "pos" : "neg")}><${CountUp} value=${Math.round(Math.abs(left))} /></div>
          <div className="foot">${left >= 0 ? `${fmt(perDay)} pr. dag til lønnen` : `i ${MONTHS_DA[+ym.slice(5)-1]}`}</div>
        </div>
      </div>

      ${insight && html`<div className="tip">
        <div className="sq sm" style=${{background: insight.good ? "var(--pos-bg)" : "var(--neg-bg)", color: insight.good ? "var(--pos)" : "var(--neg)"}}><${Icon} name=${insight.good ? "bulb" : "alert"} /></div>
        <div>${insight.text}</div>
      </div>`}

      <div className="stats">
        <div className="stat"><div className="label">Indkomst</div><div className="value pos">${fmt(st.inc)}</div></div>
        <div className="stat"><div className="label">Udgifter</div><div className="value">${fmt(st.exp)}</div></div>
        <div className="stat"><div className="label">Overskud</div><div className=${"value " + (st.inc - st.exp >= 0 ? "pos" : "neg")}>${fmt(st.inc - st.exp)}</div></div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Konti</h2><button className="link-btn" onClick=${()=>goSub("wealth")}>Redigér</button></div>
        ${!connected && !assets.length && !holdings.length ? html`
          <div className="card">
            <div style=${{fontWeight:600}}>Forbind din bank og Saxo</div>
            <div className="small muted" style=${{margin:"4px 0 12px"}}>Så hentes poster, saldi og beholdninger automatisk.</div>
            <button className="btn primary" onClick=${()=>goSub("connections")}>Kom i gang</button>
          </div>` : html`
          <div className="list stagger">
            ${bankAssets.map(a => html`<button key=${a.id} style=${stag(row++)} className="row" onClick=${()=>setPage("tx")}>
              ${badge("SK", "#1F4E8C")}
              <div className="main"><div className="title">${a.name}</div><div className="sub">${ebSession?.bank || "Sparekassen Kronjylland"}${a.iban ? " · " + a.iban.slice(-4) : ""}</div></div>
              <div className="end num">${fmt(a.value)}</div>
            </button>`)}
            ${(holdings.length > 0 || cash > 0) && html`<button style=${stag(row++)} className="row" onClick=${()=>setPage("invest")}>
              ${badge("SX", "#6B3FA0")}
              <div className="main"><div className="title">Depot</div><div className="sub">Saxo · ${holdings.length} papirer${sync.saxo ? "" : " · manuelt"}</div></div>
              <div className="end num">${fmt(invValue)}</div>
            </button>`}
            ${otherAssets.map(a => html`<button key=${a.id} style=${stag(row++)} className="row" onClick=${()=>goSub("wealth")}>
              ${badge((a.name||"?").slice(0,2).toUpperCase(), "var(--surface-3)", "var(--text-2)")}
              ${a === earmarkAsset && rejseLeft > 0 ? (() => {
                const val = +a.value || 0, ear = Math.min(Math.max(0, rejseLeft), val);
                return html`<div className="main"><div className="title">${a.name}</div>
                  <div className="sub">Fri ${fmt(val - ear)} · <span style=${{color:"#EF9F27"}}>${fmt(ear)} til rejser</span></div>
                  <div className="bar" style=${{height:4, marginTop:6}}><div style=${{width:`${val > 0 ? ear / val * 100 : 0}%`, background:"#EF9F27"}}></div></div></div>`;
              })() : html`<div className="main"><div className="title">${a.name}</div><div className="sub">Manuel</div></div>`}
              <div className="end num">${fmt(a.value)}</div>
            </button>`)}
            ${sumLiab > 0 && html`<button style=${stag(row++)} className="row" onClick=${()=>goSub("wealth")}>
              ${badge("GÆ", "var(--neg-bg)", "var(--neg)")}
              <div className="main"><div className="title">Gæld</div><div className="sub">${liabilities.length} poster</div></div>
              <div className="end num neg">-${fmt(sumLiab)}</div>
            </button>`}
          </div>`}
      </div>

      <div className="section">
        <div className="section-head"><h2>Seneste</h2><button className="link-btn" onClick=${()=>setPage("tx")}>Se alle</button></div>
        ${recent.length ? html`<div className="list stagger">${recent.map((t, i) => TxRow(t, i))}</div>` : html`<div className="card empty">Ingen poster endnu.</div>`}
      </div>
    </div>`;
  };

  const TxPage = () => {
    const q = search.trim().toLowerCase();
    const list = transactions
      .filter(t => filterMonth === "all" || budgetMonth(t.date,t.amount,t.category) === filterMonth)
      .filter(t => filterCat === "all" || t.category === filterCat)
      .filter(t => !q || (t.description||"").toLowerCase().includes(q) || String(t.amount).includes(q))
      .sort((a,b) => (b.date||"").localeCompare(a.date||""));
    const groups = [];
    for (const t of list) {
      const g = groups[groups.length-1];
      if (g && g.date === t.date) g.items.push(t); else groups.push({ date: t.date, items: [t] });
    }
    const shown = groups.slice(0, 120);
    let i = 0;
    return html`<div>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Søg i poster" value=${search} onChange=${e=>setSearch(e.target.value)} />
        <button className="icon-btn" onClick=${addManual} aria-label="Tilføj post"><${Icon} name="plus" /></button>
      </div>
      <div className="filters">
        <select className="input sm" value=${filterMonth} onChange=${e=>setFilterMonth(e.target.value)}><option value="all">Alle måneder</option>${months.map(m=>html`<option key=${m} value=${m}>${monthLabel(m)}</option>`)}</select>
        <select className="input sm" value=${filterCat} onChange=${e=>setFilterCat(e.target.value)}><option value="all">Alle kategorier</option>${CATEGORIES.map(c=>html`<option key=${c} value=${c}>${c}</option>`)}</select>
      </div>
      <div className="small muted" style=${{margin:"8px 2px 0"}}>${list.length} poster${(filterCat!=="all"||filterMonth!=="all"||q) ? ` · ${fmt(list.reduce((s,t)=>s+t.amount,0))}` : ""}</div>
      ${shown.map(g => html`<div key=${g.date}>
        <div className="date-head">${prettyDate(g.date)}</div>
        <div className="list stagger">${g.items.map(t => TxRow(t, i++))}</div>
      </div>`)}
      ${groups.length > shown.length && html`<div className="empty small">Viser de nyeste ${shown.length} dage. Brug søgning eller filtre for at finde ældre poster.</div>`}
      ${!list.length && html`<div className="card empty" style=${{marginTop:12}}>${transactions.length ? "Ingen poster matcher." : html`Ingen poster endnu. Forbind banken under <b>Mere</b>, eller importér en CSV.`}</div>`}
    </div>`;
  };

  const BudgetPage = () => {
    const ym = budgetMonthSel;
    const st = monthStats(ym);
    const left = totalBudget - st.exp;
    const spent = budgetCats.map(c => ({ key: c, value: st.byCat[c] || 0, color: CAT_COLORS[c] })).filter(s => s.value > 0).sort((a,b) => b.value - a.value);
    const top = spent.slice(0, 6);
    const rest = spent.slice(6).reduce((s, x) => s + x.value, 0);
    if (rest > 0) top.push({ key: "Øvrige", value: rest, color: "#5F5E5A" });
    const monthOpts = [...new Set([currentBudgetMonth(), ...months])].sort().reverse();
    const chartMonths = [...months].reverse().slice(-12);
    const monthly = chartMonths.map(m => { const s = monthStats(m); return { m, inc: Math.round(s.inc), exp: Math.round(s.exp) }; });
    const maxVal = Math.max(1, ...monthly.flatMap(x=>[x.inc, x.exp]));
    const avgSave = monthly.length ? Math.round(monthly.reduce((s,x)=>s+x.inc-x.exp,0)/monthly.length) : 0;
    const streak = budgetStreak();
    const cats = budgetCats.slice().sort((a, b) => (st.byCat[b] || 0) - (st.byCat[a] || 0) || (+budgets[b]||0) - (+budgets[a]||0));
    return html`<div>
      <select className="input sm" value=${ym} onChange=${e=>setBudgetMonthSel(e.target.value)} style=${{marginBottom:6}}>${monthOpts.map(m=>html`<option key=${m} value=${m}>${monthLabel(m)}</option>`)}</select>

      <${Donut} key=${ym} segments=${top} total=${Math.max(totalBudget, st.exp)}
        center=${fmtShort(Math.abs(left))} sub=${left >= 0 ? "kr. tilbage" : "kr. over budget"} over=${left < 0} />
      <div className="small muted" style=${{textAlign:"center", marginBottom:10}}>${fmt(st.exp)} brugt af ${fmt(totalBudget)}</div>
      ${top.length > 0 && html`<div className="legend">${top.map(s => html`<span key=${s.key}><i style=${{background:s.color}}></i>${SHORT_CAT[s.key] || s.key}</span>`)}</div>`}

      ${streak > 0 && html`<div className="tip streak">
        <div className="sq sm" style=${{background:"transparent", color:"var(--pos)"}}><${Icon} name="flame" /></div>
        <div><b>${streak} ${streak === 1 ? "måned" : "måneder i træk"}</b> under budget. Bliv ved!</div>
      </div>`}
      ${subscriptions.length > 0 && html`<button className="tip tap" onClick=${()=>goSub("subs")}>
        <div className="sq sm" style=${{background:"#534AB733", color: tint("#534AB7", 0.3)}}><${Icon} name="repeat" /></div>
        <div style=${{flex:1}}><b>${fmt(subsMonthly)} om måneden</b> går til ${subscriptions.length} faste træk. Det er ${fmt(subsMonthly * 12)} om året.</div>
        <${Icon} name="chevron" />
      </button>`}

      <div className="section">
        <div className="section-head"><h2>Kategorier</h2><button className="link-btn" onClick=${()=>setEditBudget(!editBudget)}>${editBudget ? "Færdig" : "Redigér budget"}</button></div>
        ${editBudget && html`<button className="btn soft block" style=${{marginBottom:10}} onClick=${()=>setBudgets({...budgets,...STUDENT_BUDGET})}>Indlæs foreslået studiebudget</button>`}
        <div className="cat-grid stagger">
          ${cats.map((c, i) => {
            const used = st.byCat[c] || 0, b = +budgets[c] || 0;
            const over = b > 0 && used > b;
            return html`<div key=${c} className=${"cat-card" + (over ? " over" : "")} style=${stag(i)}>
              <div className="top"><${CatIcon} cat=${c} small /><span className="name">${SHORT_CAT[c] || c}</span></div>
              ${editBudget
                ? html`<input className="input sm" type="number" inputMode="decimal" value=${budgets[c]||0} onChange=${e=>setBudgets({...budgets,[c]:+e.target.value})} style=${{marginTop:8}} aria-label=${`Budget for ${c}`} />`
                : html`
                  <div className="bar"><div style=${{width:`${b > 0 ? Math.min(100, used/b*100) : used > 0 ? 100 : 0}%`, background: over ? "var(--neg)" : CAT_COLORS[c]}}></div></div>
                  <div className="left">${b > 0 ? (over ? `${fmt(used - b)} over` : `${fmt(b - used)} tilbage`) : used > 0 ? `${fmt(used)} uden budget` : "Intet budget"}</div>`}
            </div>`;
          })}
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Udvikling</h2><span className="small muted">Gns. opsparing <span className=${avgSave >= 0 ? "pos" : "neg"}>${fmt(avgSave)}</span>/md</span></div>
        <div className="card">
          ${monthly.length === 0 ? html`<div className="empty">Ingen data endnu.</div>` : html`
            <div style=${{display:"flex",gap:14,marginBottom:10,fontSize:12}} className="muted">
              <span style=${{display:"flex",alignItems:"center",gap:5}}><span style=${{width:10,height:10,borderRadius:3,background:"var(--pos)"}}></span>Indkomst</span>
              <span style=${{display:"flex",alignItems:"center",gap:5}}><span style=${{width:10,height:10,borderRadius:3,background:"var(--neg)"}}></span>Udgifter</span>
            </div>
            <div style=${{overflowX:"auto"}}><div style=${{minWidth: monthly.length * 30}}>
              <div className="chart">${monthly.map((x, i) => html`<div key=${x.m} className="col">
                <div title=${`Indkomst ${fmt(x.inc)}`} style=${{height:`${x.inc/maxVal*100}%`, background:"var(--pos)", minHeight: x.inc > 0 ? 2 : 0, animationDelay:`${i*40}ms`}}></div>
                <div title=${`Udgifter ${fmt(x.exp)}`} style=${{height:`${x.exp/maxVal*100}%`, background:"var(--neg)", minHeight: x.exp > 0 ? 2 : 0, animationDelay:`${i*40+20}ms`}}></div>
              </div>`)}</div>
              <div className="chart-x">${monthly.map(x => html`<div key=${x.m}>
                <div className="faint">${MONTHS_DA[+x.m.slice(5)-1].slice(0,3)}</div>
                <div className=${x.inc - x.exp >= 0 ? "pos" : "neg"}>${Math.round((x.inc - x.exp)/1000)}k</div>
              </div>`)}</div>
            </div></div>`}
        </div>
      </div>
    </div>`;
  };

  const InvestPage = () => {
    const saxoConnected = Boolean(saxoTokens) || Boolean(sync.saxo);
    const manual = holdings.filter(h => h.source !== "saxo");
    const groups = {};
    for (const h of holdings) { const t = holdingType(h); groups[t] = (groups[t] || 0) + holdingValue(h); }
    if ((+cash || 0) > 0) groups.Kontant = +cash;
    const alloc = Object.entries(groups).filter(([,v]) => v > 0).sort((a,b) => b[1] - a[1]);
    const allocTotal = alloc.reduce((s, [,v]) => s + v, 0);
    const sorted = holdings.slice().sort((a, b) => holdingValue(b) - holdingValue(a));
    return html`<div>
      <div className="hero invest">
        <div className="label">${sync.saxo ? "Depot hos Saxo" : "Depotværdi"}</div>
        <div className="big"><${CountUp} value=${Math.round(invValue)} /></div>
        <div className="hero-row">
          ${invCost > 0 && html`<span className=${"chip " + (invGain >= 0 ? "up" : "down")}>${pctf(invGain/invCost*100)}</span>`}
          <span className="hm">${invGain >= 0 ? "+" : ""}${fmt(invGain)} i alt</span>
        </div>
        ${allocTotal > 0 && html`
          <div className="alloc">${alloc.map(([k, v], i) => html`<div key=${k} style=${{flex: v, background: TYPE_COLOR[k] || TYPE_COLOR.Andet, animationDelay:`${i*80}ms`}}></div>`)}</div>
          <div className="alloc-legend hm">${alloc.map(([k, v]) => html`<span key=${k}>${k} ${Math.round(v / allocTotal * 100)} %</span>`)}</div>`}
      </div>

      <div className="card" style=${{display:"flex",alignItems:"center",gap:12,marginTop:10}}>
        ${badge("SX", "#6B3FA0")}
        <div style=${{flex:1,minWidth:0}}>
          <div>Saxo</div>
          <div className="small muted">${sync.saxo ? syncLabel(sync.saxo) : "Ikke forbundet"}${saxoTokens && saxoAccessValid(saxoTokens) ? " · logget ind" : ""}</div>
        </div>
        ${saxoTokens && saxoRefreshValid(saxoTokens)
          ? html`<button className="btn soft" disabled=${syncing} onClick=${()=>syncAll()}>Opdater</button>`
          : html`<button className="btn soft" disabled=${busy==="saxo"} onClick=${()=> store.json(BRIDGE_KEY) ? startSaxoLogin() : goSub("connections")}>${saxoConnected ? "Log ind" : "Forbind"}</button>`}
      </div>
      <${Msg} k="saxo" />

      ${holdings.length > 0 && (() => {
        const since = invRange === "Alt" ? "" : addDays(isoDate(new Date()), -RANGES[invRange]);
        const pts = invHistory.filter(p => p.d >= since);
        const a = pts[0], b = pts[pts.length - 1];
        // Return in the period excludes money put in or taken out: change in (value − deposited).
        const ret = a && b && pts.length > 1 ? (b.v - b.c) - (a.v - a.c) : null;
        return html`<div className="section">
          <div className="section-head"><h2>Udvikling</h2>
            <div className="ranges plain">${[...Object.keys(RANGES), "Alt"].map(r => html`<button key=${r} className=${invRange === r ? "on" : ""} onClick=${()=>setInvRange(r)}>${r}</button>`)}</div></div>
          <div className="card">
            <${InvestChart} points=${pts} />
            <div className="small" style=${{display:"flex",flexWrap:"wrap",gap:"6px 16px",marginTop:10}}>
              <span><span style=${{display:"inline-block",width:14,height:3,background:"var(--accent)",verticalAlign:"middle",marginRight:6,borderRadius:2}}></span>Værdi ${fmt(invValue)}</span>
              <span className="muted"><span style=${{display:"inline-block",width:14,borderTop:"2px dashed var(--text-2)",verticalAlign:"middle",marginRight:6}}></span>Indskudt ${fmt(invCost + (+cash || 0))}</span>
              ${ret != null && html`<span>Afkast i perioden <b className=${ret >= 0 ? "pos" : "neg"}>${ret >= 0 ? "+" : ""}${fmt(ret)}</b></span>`}
            </div>
          </div>
        </div>`;
      })()}

      <div className="section">
        <div className="section-head"><h2>Beholdninger</h2><button className="link-btn" onClick=${()=>{ const h = {id:uid(),name:"Ny beholdning",ticker:"",currency:"DKK",shares:0,avgCost:0,price:0}; setHoldings([...holdings, h]); setOpenHolding(h.id); }}>+ Manuel</button></div>
        ${holdings.length === 0 ? html`<div className="card empty">Ingen beholdninger. Forbind Saxo, eller tilføj manuelt.</div>` : html`
          <div className="list stagger">
            ${sorted.map((h, i) => {
              const cur = h.currency || "DKK";
              const val = holdingValue(h), cost = holdingCost(h);
              const gainPct = cost > 0 ? (val - cost) / cost * 100 : null;
              const open = openHolding === h.id;
              const color = TYPE_COLOR[holdingType(h)] || TYPE_COLOR.Andet;
              const setH = (patch) => setHoldings(holdings.map(x=>x.id===h.id?{...x,...patch}:x));
              return html`<div key=${h.id} style=${stag(i)}>
                <button className="row" onClick=${()=>setOpenHolding(open ? null : h.id)}>
                  ${badge((h.ticker || h.name || "?").replace(/[^A-Za-z0-9ÆØÅæøå]/g,"").slice(0,3).toUpperCase(), color + "33", tint(color, 0.35))}
                  <div className="main"><div className="title">${h.name}</div><div className="sub">${numf(+h.shares||0)} stk. · ${numf(+h.price||0)} ${cur}</div></div>
                  <div className="end"><div className="num">${fmt(val)}</div>${gainPct != null && html`<div className=${"num small " + (gainPct >= 0 ? "pos" : "neg")}>${pctf(gainPct)}</div>`}</div>
                </button>
                ${open && (h.source === "saxo" ? html`<div className="expand small muted">Hentet fra Saxo. Købskurs ${numf(+h.avgCost||0)} ${cur} · gevinst ${fmt(val - cost)}. Opdateres ved næste synkronisering.</div>` : html`<div className="expand stack">
                  <div className="grid2">
                    <label className="field">Navn<input className="input" value=${h.name} onChange=${e=>setH({name:e.target.value})} /></label>
                    <label className="field">Ticker<input className="input" value=${h.ticker} onChange=${e=>setH({ticker:e.target.value})} /></label>
                  </div>
                  <div className="grid2">
                    <label className="field">Valuta<select className="input" value=${cur} onChange=${e=>setH({currency:e.target.value})}>${CURRENCIES.map(c=>html`<option key=${c} value=${c}>${c}</option>`)}</select></label>
                    <label className="field">Antal<input className="input" type="number" inputMode="decimal" value=${h.shares} onChange=${e=>setH({shares:+e.target.value})} /></label>
                  </div>
                  <div className="grid2">
                    <label className="field">Købskurs (${cur})<input className="input" type="number" inputMode="decimal" value=${h.avgCost} onChange=${e=>setH({avgCost:+e.target.value})} /></label>
                    <label className="field">Kurs nu (${cur})<input className="input" type="number" inputMode="decimal" value=${h.price} onChange=${e=>setH({price:+e.target.value})} /></label>
                  </div>
                  <div className="btns"><button className="btn danger" onClick=${()=>{ const prev = holdings; setHoldings(holdings.filter(x=>x.id!==h.id)); setOpenHolding(null); showUndo("Beholdningen er slettet", () => setHoldings(prev)); }}><${Icon} name="trash" /> Slet</button><button className="btn" onClick=${()=>setOpenHolding(null)}>Luk</button></div>
                </div>`)}
              </div>`;
            })}
          </div>`}
      </div>

      <div className="section">
        <div className="list">
          <div className="row">
            <div className="main"><div className="title">Kontant på depot</div><div className="sub">${sync.saxo ? "Fra Saxo" : "Tæller med i formuen"}</div></div>
            <input className="input sm num" style=${{width:120,textAlign:"right"}} type="number" inputMode="decimal" value=${cash} disabled=${Boolean(sync.saxo)} onChange=${e=>setCash(+e.target.value)} aria-label="Kontant på depot" />
          </div>
        </div>
      </div>


      ${manual.length > 0 && apiKey && html`<div className="section">
        <button className="btn soft block" disabled=${priceLoading} onClick=${updatePricesAI}><${Icon} name="spark" /> ${priceLoading ? "Henter kurser…" : "Opdater manuelle kurser med AI"}</button>
        <${Msg} k="price" />
      </div>`}
      <div className="small faint" style=${{marginTop:16}}>Valutakurser: 1 EUR = ${numf(fxRates.EUR)} kr. · 1 USD = ${numf(fxRates.USD)} kr.${sync.saxo ? " (fra Saxo)" : ""}. Ikke investeringsrådgivning.</div>
    </div>`;
  };

  // ---------- "Mere" sub pages ----------

  const WealthPage = () => {
    const editableRows = (items, setItems, placeholder) => items.map(a => html`<div key=${a.id} className="row">
      <div className="main">${a.source === "bank"
        ? html`<div className="title">${a.name}</div><div className="sub">Fra banken · opdateres automatisk</div>`
        : html`<input className="input sm" value=${a.name} onChange=${e=>setItems(items.map(x=>x.id===a.id?{...x,name:e.target.value}:x))} placeholder=${placeholder} aria-label="Navn" />`}</div>
      <input className="input sm num" style=${{width:110,textAlign:"right"}} type="number" inputMode="decimal" value=${a.value} disabled=${a.source === "bank"} onChange=${e=>setItems(items.map(x=>x.id===a.id?{...x,value:+e.target.value}:x))} aria-label="Beløb" />
      <button className="icon-btn" style=${{background:"none"}} aria-label=${`Slet ${a.name}`} onClick=${()=>{ const prev = items; setItems(items.filter(x=>x.id!==a.id)); showUndo(`${a.name || "Posten"} er slettet`, () => setItems(prev)); }}><${Icon} name="trash" /></button>
    </div>`);
    return html`<div>
      <div className="hero"><div className="label">Samlet formue</div><div className="big"><${CountUp} value=${Math.round(netWorth)} /></div>
        <div className="hm">Aktiver ${fmt(sumAssets)} + depot ${fmt(invValue)} − gæld ${fmt(sumLiab)}</div></div>
      <div className="section">
        <div className="section-head"><h2>Aktiver</h2><button className="link-btn" onClick=${()=>setAssets([...assets,{id:uid(),name:"Ny konto",value:0}])}>+ Tilføj</button></div>
        ${assets.length ? html`<div className="list">${editableRows(assets, setAssets, "Navn")}</div>` : html`<div className="card empty">Ingen aktiver.</div>`}
      </div>
      <div className="section">
        <div className="section-head"><h2>Gæld</h2><button className="link-btn" onClick=${()=>setLiabilities([...liabilities,{id:uid(),name:"Ny gæld",value:0}])}>+ Tilføj</button></div>
        ${liabilities.length ? html`<div className="list">${editableRows(liabilities, setLiabilities, "Navn")}</div>` : html`<div className="card empty">Ingen gæld registreret.</div>`}
      </div>
    </div>`;
  };

  const shortDate = (d) => d ? `${+d.slice(8,10)}. ${MONTHS_DA[+d.slice(5,7)-1].slice(0,3)}.` : "";
  const kv = (label, value, cls = "") => html`<div style=${{display:"flex",justifyContent:"space-between",gap:12}}><span className="muted">${label}</span><span className=${"num " + cls}>${value}</span></div>`;

  const TripsPage = () => {
    const goal = +rejse.goal || 0;
    const pct = goal > 0 ? Math.max(0, Math.min(100, rejseLeft / goal * 100)) : 0;
    const setTrips = (trips) => setRejse({...rejse, trips});
    const setTrip = (id, patch) => setTrips(rejse.trips.map(tr => tr.id === id ? {...tr, ...patch} : tr));
    const addTrip = () => {
      const to = isoDate(new Date());
      const tr = { id: uid(), name: "Ny rejse", from: addDays(to, -14), to, sisterPaid: 0, paidBack: 0 };
      setTrips([tr, ...rejse.trips]); setPickTrip(tr.id);
    };
    const removeTrip = (tr) => {
      const prevR = rejse, prevT = transactions;
      setTrips(rejse.trips.filter(x => x.id !== tr.id));
      setTransactions(transactions.map(t => t.trip === tr.id ? {...t, trip: null} : t));
      showUndo(`${tr.name} er slettet`, () => { setRejse(prevR); setTransactions(prevT); });
    };
    const request = async (tr, s) => {
      // fmtKr() already ends in "kr.", which doubles as the full stop.
      const text = `Hej søs! ${tr.name} kostede i alt ${fmtKr(s.total)}`
        + ` Jeg lagde ${fmtKr(s.mine)} ud${s.hers > 0 ? `, og du lagde ${fmtKr(s.hers)} ud` : ""}, så vi skal hver betale ${fmtKr(s.half)}`
        + (s.repaid > 0 ? ` Du har allerede betalt ${fmtKr(s.repaid)}` : "")
        + ` Så mangler du at betale mig ${fmtKr(s.owed)} Kan du MobilePay mig?`;
      try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { if (e?.name === "AbortError") return; }
      navigator.clipboard?.writeText(text).then(() => flash("trip-" + tr.id, "Beskeden er kopieret. Sæt den ind i en besked til søs."), () => {});
    };
    return html`<div>
      <div className="card stack">
        <div style=${{display:"flex",alignItems:"center",gap:12}}>
          <div className="sq" style=${{background:"#EF9F2733", color: tint("#EF9F27", 0.3)}}><${Icon} name="plane" /></div>
          <div style=${{flex:1,minWidth:0}}><div>Tilbage af rejsepengene</div><div className="small muted">${fmt(rejseLeft)} hver af ${fmt(goal)} · ${fmt(rejseLeft * 2)} i alt</div></div>
          <div className="num" style=${{fontWeight:600}}>${Math.round(pct)} %</div>
        </div>
        <div className="bar" style=${{height:10}}><div style=${{width:`${pct}%`, background:"#EF9F27"}}></div></div>
        <div className="small muted">I har hver øremærket ${fmt(goal)} til rejser. Hver tur trækker jeres halvdel af prisen fra.${tripsUsed > 0 ? ` Brugt indtil nu: ${fmt(tripsUsed)} hver.` : ""}</div>
        <div className="grid2">
          <label className="field">Øremærket pr. person (kr.)<input className="input" type="number" inputMode="decimal" value=${rejse.goal} onChange=${e=>setRejse({...rejse, goal:+e.target.value})} /></label>
          <label className="field">Står på konto<select className="input" value=${earmarkAsset?.id || ""} onChange=${e=>setRejse({...rejse, accountId: e.target.value || "none"})}>
            <option value="">Ingen</option>
            ${assets.filter(a => a.source !== "bank").map(a => html`<option key=${a.id} value=${a.id}>${a.name}</option>`)}
          </select></label>
        </div>
        ${earmarkAsset && html`<div className="small muted">På ${earmarkAsset.name} er ${fmt(Math.min(Math.max(0, rejseLeft), +earmarkAsset.value || 0))} øremærket til rejser, og ${fmt(Math.max(0, (+earmarkAsset.value || 0) - Math.max(0, rejseLeft)))} er fri.</div>`}
        ${tripsOwed > 0 && html`<div className="tip" style=${{marginTop:0}}><div className="sq sm" style=${{background:"var(--accent-bg)", color:"var(--accent)"}}><${Icon} name="coins" /></div><div>Søs mangler at betale dig <b>${fmt(tripsOwed)}</b> i alt.</div></div>`}
      </div>

      <div className="section">
        <div className="section-head"><h2>Rejser</h2><button className="link-btn" onClick=${addTrip}>+ Ny rejse</button></div>
        ${rejse.trips.length === 0 && html`<div className="card empty">Ingen rejser endnu. Tryk <b>+ Ny rejse</b>, giv den et navn som "Italien", og vælg de poster, du har lagt ud. De tæller ikke i månedsbudgettet.</div>`}
        <div className="stack-gap">${rejse.trips.map(tr => {
          const s = tripStats(tr);
          const open = pickTrip === tr.id;
          const late = addDays(tr.to || isoDate(new Date()), 90);
          // Candidates: the trip's spending, plus money coming in afterwards (søs paying back).
          const cands = !open ? [] : transactions
            .filter(t => t.date && t.date >= tr.from && t.description !== RENT_TEXT && !EXCLUDED.includes(t.category) && ((t.amount < 0 && t.date <= tr.to) || (t.amount > 0 && t.date <= late && !INCOME_CATS.slice(0,2).includes(t.category))))
            .sort((a, b) => a.date.localeCompare(b.date));
          const subKeys = new Set(subscriptions.map(x => x.key));
          const freeSpend = cands.filter(t => t.amount < 0 && !t.trip && !subKeys.has(subKey(t.description)));
          return html`<div key=${tr.id} className="card stack">
            <input className="input" value=${tr.name} onChange=${e=>setTrip(tr.id, {name: e.target.value})} aria-label="Navn på rejsen" style=${{fontWeight:600}} />
            <div className="grid2">
              <label className="field">Fra<input className="input" type="date" value=${tr.from} onChange=${e=>setTrip(tr.id, {from: e.target.value})} /></label>
              <label className="field">Til<input className="input" type="date" value=${tr.to} onChange=${e=>setTrip(tr.id, {to: e.target.value})} /></label>
            </div>
            <label className="field">Søs har selv lagt ud (kr.)<input className="input" type="number" inputMode="decimal" value=${tr.sisterPaid || 0} onChange=${e=>setTrip(tr.id, {sisterPaid: +e.target.value})} /></label>
            <div className="stack" style=${{gap:4}}>
              ${kv(`Du har lagt ud (${s.txs.filter(t => t.amount < 0).length} poster)`, fmt(s.mine))}
              ${kv("Søs har lagt ud", fmt(s.hers))}
              ${kv("Turen i alt", fmt(s.total))}
              ${kv("Hver jeres halvdel", fmt(s.half))}
              ${s.repaid > 0 && kv("Søs har betalt tilbage", fmt(s.repaid), "pos")}
              ${s.owed > 0.5 ? kv("Søs mangler at betale dig", fmt(s.owed), "neg")
                : s.owed < -0.5 ? kv("Du mangler at betale søs", fmt(-s.owed), "neg")
                : kv("Status", s.total > 0 ? "Gjort op ✓" : "–", "pos")}
            </div>
            <div className="btns">
              <button className="btn primary" disabled=${!(s.owed > 0.5)} onClick=${()=>request(tr, s)}>Anmod søs${s.owed > 0.5 ? ` om ${fmt(s.owed)}` : ""}</button>
              <button className="btn" onClick=${()=>setPickTrip(open ? null : tr.id)}>${open ? "Færdig" : "Vælg poster"}</button>
            </div>
            <${Msg} k=${"trip-" + tr.id} />
            ${open && html`<div className="stack">
              <div className="small muted">Sæt flueben ved det, du har lagt ud på turen. Indbetalinger fra søs efter turen kan også vælges – så tæller de som hendes betaling.</div>
              ${freeSpend.length > 0 && html`<button className="btn soft" onClick=${()=>setTransactions(transactions.map(t => freeSpend.some(f => f.id === t.id) ? {...t, trip: tr.id} : t))}>Vælg alle ${freeSpend.length} udgifter i perioden</button>`}
              ${cands.length === 0 ? html`<div className="small faint">Ingen poster i perioden. Tjek datoerne.</div>` : html`<div className="list">${cands.map(t => {
                const other = t.trip && t.trip !== tr.id;
                return html`<label key=${t.id} className="row" style=${{minHeight:48, cursor: other ? "default" : "pointer", opacity: other ? .5 : 1}}>
                  <input type="checkbox" style=${{width:18, height:18, accentColor:"var(--accent)"}} checked=${t.trip === tr.id} disabled=${other} onChange=${()=>editTx(t.id, {trip: t.trip === tr.id ? null : tr.id})} />
                  <div className="main"><div className="title">${t.description}</div><div className="sub">${shortDate(t.date)}${t.amount > 0 ? " · indbetaling" : ""}${other ? " · anden rejse" : ""}</div></div>
                  <div className=${"end " + amountClass(t.amount)}>${fmt(t.amount)}</div>
                </label>`;
              })}</div>`}
              <label className="field">Søs har betalt tilbage udenom banken (kr.)<input className="input" type="number" inputMode="decimal" value=${tr.paidBack || 0} onChange=${e=>setTrip(tr.id, {paidBack: +e.target.value})} /></label>
              <div className="btns">
                ${s.owed > 0.5 && html`<button className="btn soft" onClick=${()=>setTrip(tr.id, {paidBack: (+tr.paidBack || 0) + s.owed})}>Markér resten som betalt</button>`}
                <button className="btn danger" onClick=${()=>removeTrip(tr)}><${Icon} name="trash" /> Slet rejse</button>
              </div>
            </div>`}
          </div>`;
        })}</div>
      </div>
    </div>`;
  };

  const SubsPage = () => {
    const gross = subscriptions.reduce((s, x) => s + x.monthly, 0);
    return html`<div>
    <div className="hero">
      <div className="label">Faste træk – din egen del</div>
      <div className="big"><${CountUp} value=${Math.round(subsMonthly)} /></div>
      <div className="hm">om måneden · ${fmt(subsMonthly * 12)} om året · ${subscriptions.length} stk.${gross > subsMonthly ? ` · ${fmt(gross)} før andres andel` : ""}</div>
    </div>
    <div className="small muted" style=${{margin:"12px 2px"}}>Fundet ud fra poster, der kommer ca. én gang om måneden med næsten samme beløb. Får du fast penge tilbage fra andre, trækkes de fra. Husleje, opsparing og rejser er ikke med.</div>
    ${subscriptions.length === 0
      ? html`<div className="card empty">Ingen faste træk fundet endnu. Der skal være poster fra mindst 2–3 måneder.</div>`
      : html`<div className="list stagger">${subscriptions.map((x, i) => html`<div key=${x.key} className="row" style=${{...stag(i), alignItems:"flex-start", flexWrap:"wrap"}}>
          <${CatIcon} cat=${x.category} />
          <div className="main">
            <div className="title">${x.name}</div>
            <div className="sub">${x.share ? `${fmt(x.monthly)} − ${fmt(Math.min(x.share.monthly, x.monthly))} fra ${x.share.name}` : `${fmt(x.monthly * 12)} om året`} · sidst ${shortDate(x.last)}</div>
            ${recurringIn.length > 0 && html`<select className="input sm" style=${{marginTop:6, maxWidth:"100%"}} aria-label=${`Andre betaler med på ${x.name}`} value=${x.share?.key || "none"}
              onChange=${e=>setSubsShare({...subsShare, [x.key]: e.target.value})}>
              <option value="none">Ingen betaler med</option>
              ${recurringIn.map(r => html`<option key=${r.key} value=${r.key}>${r.name} betaler ${fmt(r.monthly)}/md</option>`)}
            </select>`}
          </div>
          <div className="end"><div className="num">${fmt(x.net)}</div>
            <button className="link-btn small" onClick=${()=>{ const prev = subsHidden; setSubsHidden([...subsHidden, x.key]); showUndo(`${x.name} er skjult`, () => setSubsHidden(prev)); }}>Ikke et abonnement</button></div>
        </div>`)}</div>`}
    ${subsHidden.length > 0 && html`<button className="btn soft block" style=${{marginTop:12}} onClick=${()=>setSubsHidden([])}>Vis ${subsHidden.length} skjulte igen</button>`}
  </div>`;
  };

  const detectedStores = usualStores(transactions);
  const shopStores = shop.stores || (detectedStores.length ? detectedStores : ["REMA 1000", "Netto", "Lidl"]);
  const StoresBlock = () => {
    const toggleStore = (c) => setShop({...shop, stores: shopStores.includes(c) ? shopStores.filter(x => x !== c) : [...shopStores, c]});
    const useLocation = () => navigator.geolocation?.getCurrentPosition(
      (p) => { const lat = Math.round(p.coords.latitude * 100) / 100, lng = Math.round(p.coords.longitude * 100) / 100; setShop({...shop, lat, lng, place: "din placering"}); setOffers({}); setTermOffers({}); flash("shop", "Placering opdateret."); },
      () => flash("shop", "Placeringen blev ikke delt. Bruger Aarhus C."));
    return html`<div className="section">
      <div className="section-head"><h2>Mine butikker</h2><button className="link-btn" onClick=${useLocation}>Brug min placering</button></div>
      <div style=${{display:"flex", flexWrap:"wrap", gap:6}}>${CHAINS.map(c => html`<button key=${c} className=${"chip " + (shopStores.includes(c) ? "info" : "")} style=${shopStores.includes(c) ? {} : {border:"1px solid var(--border)"}} aria-pressed=${shopStores.includes(c)} onClick=${()=>toggleStore(c)}>${shopStores.includes(c) ? "✓ " : ""}${c}</button>`)}</div>
      <div className="small faint" style=${{marginTop:6}}>${!shop.stores && detectedStores.length > 0 ? "Valgt ud fra hvor du har handlet de sidste 3 måneder. " : ""}Tilbud inden for 10 km af ${shop.place}.</div>
      <${Msg} k="shop" />
    </div>`;
  };

  const ShopPage = () => {
    const stores = shopStores;
    const setItems = (items) => setShop({...shop, items});
    const inStores = (list) => (list || []).filter(o => stores.includes(o.store));
    const load = loadOffers;
    const add = (name) => {
      const n = name.trim();
      if (!n || shop.items.some(i => i.name.toLowerCase() === n.toLowerCase())) return;
      const item = { id: uid(), name: n, done: false, pick: null };
      setItems([...shop.items, item]); setShopDraft(""); load(item);
    };
    const refreshAll = () => shop.items.filter(i => !i.done).forEach(load);
    // Each item's chosen offer: the one the user tapped, else the best match in their stores.
    const chosen = (item) => { const l = inStores(offers[item.id]?.list); return l.find(o => o.id === item.pick) || l.find(o => offerFits(item.name, o.heading)) || l[0] || null; };
    const groups = {};
    for (const it of shop.items) { const o = chosen(it); const k = o ? o.store : "Uden tilbud"; (groups[k] ||= []).push({ it, o }); }
    const order = Object.keys(groups).sort((a, b) => (a === "Uden tilbud") - (b === "Uden tilbud") || groups[b].length - groups[a].length);
    const total = shop.items.filter(i => !i.done).reduce((s, i) => s + (chosen(i)?.price || 0), 0);
    const till = (o) => o.till ? `til ${shortDate(isoDate(new Date(o.till)))}` : "";
    return html`<div>
      <div className="card stack">
        <div className="small muted">Skriv det, du mangler, så finder appen ugens tilbud i dine butikker.</div>
        <form style=${{display:"flex", gap:8}} onSubmit=${e=>{ e.preventDefault(); add(shopDraft); }}>
          <input className="input" style=${{flex:1}} value=${shopDraft} onChange=${e=>setShopDraft(e.target.value)} placeholder="Fx kaffe, kylling, pasta" aria-label="Vare" />
          <button className="btn primary" type="submit" disabled=${!shopDraft.trim()}>Tilføj</button>
        </form>
        <div style=${{display:"flex", flexWrap:"wrap", gap:6}}>${STAPLES.filter(x => !shop.items.some(i => i.name.toLowerCase() === x.toLowerCase())).map(x => html`<button key=${x} className="chip info" onClick=${()=>add(x)}>+ ${x}</button>`)}</div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Varer</h2>${shop.items.length > 0 && html`<button className="link-btn" onClick=${refreshAll}>Opdater tilbud</button>`}</div>
        ${shop.items.length === 0 ? html`<div className="card empty">Listen er tom. Tilføj varer ovenfor.</div>` : html`
          ${total > 0 && html`<div className="tip" style=${{marginTop:0, marginBottom:10}}><div className="sq sm" style=${{background:"var(--pos-bg)", color:"var(--pos)"}}><${Icon} name="cart" /></div><div>Varer på tilbud i alt ca. <b>${kr(Math.round(total))}</b></div></div>`}
          <div className="stack-gap">${order.map(store => html`<div key=${store}>
            <div className="small muted" style=${{margin:"4px 2px 6px", fontWeight:600}}>${store}</div>
            <div className="list">${groups[store].map(({ it, o }) => {
              const st = offers[it.id] || {}, alts = inStores(st.list).slice(0, 6);
              return html`<div key=${it.id} className="row" style=${{alignItems:"flex-start", flexWrap:"wrap", opacity: it.done ? .5 : 1}}>
                <input type="checkbox" style=${{width:20, height:20, marginTop:4, accentColor:"var(--accent)"}} checked=${it.done} aria-label=${`${it.name} er købt`} onChange=${()=>setItems(shop.items.map(x => x.id === it.id ? {...x, done: !x.done} : x))} />
                ${o?.image ? html`<img src=${o.image} alt="" loading="lazy" style=${{width:44, height:44, objectFit:"contain", borderRadius:8, background:"#fff"}} />` : null}
                <div className="main">
                  <div className="title" style=${{textDecoration: it.done ? "line-through" : "none"}}>${it.name}</div>
                  <div className="sub" style=${{whiteSpace:"normal"}}>${st.loading ? "Finder tilbud…" : st.error ? st.error : o ? `${o.heading} · ${till(o)}` : st.list ? "Ingen tilbud i dine butikker lige nu" : "Tryk Opdater tilbud"}</div>
                  ${alts.length > 1 && html`<select className="input sm" style=${{marginTop:6, maxWidth:"100%"}} aria-label=${`Vælg tilbud for ${it.name}`} value=${o?.id || ""} onChange=${e=>setItems(shop.items.map(x => x.id === it.id ? {...x, pick: e.target.value} : x))}>
                    ${alts.map(a => html`<option key=${a.id} value=${a.id}>${a.store}: ${kr(a.price)} – ${a.heading.slice(0, 40)}</option>`)}
                  </select>`}
                </div>
                <div className="end">
                  ${o && html`<div className="num" style=${{fontWeight:600}}>${kr(o.price)}</div>${o.before ? html`<div className="small faint" style=${{textDecoration:"line-through"}}>${kr(o.before)}</div>` : null}`}
                  <button className="link-btn small" aria-label=${`Fjern ${it.name}`} onClick=${()=>{ const prev = shop.items; setItems(shop.items.filter(x => x.id !== it.id)); showUndo(`${it.name} er fjernet`, () => setItems(prev)); }}>Fjern</button>
                </div>
              </div>`;
            })}</div>
          </div>`)}</div>
          ${shop.items.some(i => i.done) && html`<button className="btn soft block" style=${{marginTop:12}} onClick=${()=>setItems(shop.items.filter(i => !i.done))}>Ryd købte varer</button>`}`}
      </div>
      ${StoresBlock()}
    </div>`;
  };

  const favMeals = (shop.meals || []).filter(m => m.fav);

  const makePlan = async () => {
    if (!favMeals.length) { setFoodTab("meals"); return; }
    setPlanBusy(true);
    try {
      const terms = [...new Set(favMeals.flatMap(m => m.ingredients))];
      const lists = {};
      for (let i = 0; i < terms.length; i += 6) {
        const chunk = terms.slice(i, i + 6);
        (await Promise.all(chunk.map(offersFor))).forEach((l, k) => { lists[chunk[k]] = l; });
      }
      const r = planMeals(favMeals, lists, shopStores, Math.max(1, +shop.days || 5));
      const start = new Date();
      setShop({...shop, plan: {
        created: isoDate(start), stores: r.stores,
        days: r.meals.map((x, i) => ({ day: WEEKDAYS[(start.getDay() + i) % 7], mealId: x.meal.id, name: x.meal.name, url: x.meal.url || null, items: x.items })),
      }});
    } finally { setPlanBusy(false); }
  };

  const PlanTab = () => {
    const plan = shop.plan;
    const shopping = {};
    if (plan) for (const d of plan.days) for (const it of d.items) {
      const key = it.offer ? it.offer.store : "Normalpris";
      (shopping[key] ||= {});
      shopping[key][it.term] ||= it;
    }
    const total = plan ? Object.values(shopping).flatMap(g => Object.values(g)).reduce((s, it) => s + (it.offer?.price || 0), 0) : 0;
    const addToList = () => {
      const have = new Set(shop.items.map(i => i.name.toLowerCase()));
      const add = Object.values(shopping).flatMap(g => Object.values(g)).filter(it => !have.has(it.term.toLowerCase()))
        .map(it => ({ id: uid(), name: it.term, done: false, pick: it.offer?.id || null }));
      setShop({...shop, items: [...shop.items, ...add]});
      // Reuse the offers the plan already fetched, so the list doesn't search the same words again.
      setOffers(m => ({...m, ...Object.fromEntries(add.filter(a => termOffers[a.name]).map(a => [a.id, { list: termOffers[a.name] }]))}));
      flash("plan", add.length ? `${add.length} varer lagt på indkøbslisten.` : "Alle varerne står allerede på listen.");
    };
    return html`<div>
      <div className="card stack">
        <div className="small muted">Madplanen vælger blandt dine ${favMeals.length} yndlingsretter dem, hvor flest ingredienser er på tilbud, og finder de 1–2 butikker, det kan betale sig at gå i.</div>
        <div style=${{display:"flex", alignItems:"center", gap:10}}>
          <span className="small" style=${{flex:1}}>Antal aftener</span>
          <button className="icon-btn" aria-label="Færre aftener" onClick=${()=>setShop({...shop, days: Math.max(1, (+shop.days || 5) - 1)})}>−</button>
          <span className="num" style=${{minWidth:20, textAlign:"center", fontWeight:600}}>${shop.days || 5}</span>
          <button className="icon-btn" aria-label="Flere aftener" onClick=${()=>setShop({...shop, days: Math.min(7, (+shop.days || 5) + 1)})}>+</button>
        </div>
        <button className="btn primary block" disabled=${planBusy} onClick=${makePlan}>${planBusy ? "Finder tilbud…" : favMeals.length ? (plan ? "Lav ny madplan" : "Lav madplan") : "Vælg dine yndlingsretter først"}</button>
      </div>

      ${plan && html`<div>
        <div className="tip" style=${{marginTop:12}}>
          <div className="sq sm" style=${{background:"var(--accent-bg)", color:"var(--accent)"}}><${Icon} name="cart" /></div>
          <div>${plan.stores.length ? html`Gå i <b>${plan.stores.join(" og ")}</b>. Tilbudsvarerne koster ca. <b>${kr(Math.round(total))}</b>` : "Ingen af dine butikker har tilbud på ingredienserne lige nu."}</div>
        </div>
        <div className="section">
          <div className="section-head"><h2>Ugens madplan</h2><span className="small faint">lavet ${shortDate(plan.created)}</span></div>
          <div className="list">${plan.days.map((d, i) => html`<div key=${i} className="row" style=${{alignItems:"flex-start"}}>
            <div style=${{width:64, flexShrink:0, fontWeight:600, paddingTop:2}}>${d.day}</div>
            <div className="main">
              <div className="title" style=${{whiteSpace:"normal"}}>${d.name}${d.url && html` <a href=${d.url} target="_blank" rel="noopener" className="link-btn small" style=${{whiteSpace:"nowrap"}}>Opskrift ↗</a>`}</div>
              <div style=${{display:"flex", flexWrap:"wrap", gap:4, marginTop:6}}>${d.items.map(it => html`<span key=${it.term} className=${"chip " + (it.offer ? "pos" : "")} style=${it.offer ? {} : {border:"1px solid var(--border)"}}>${it.term}${it.offer ? ` · ${kr(it.offer.price)}` : ""}</span>`)}</div>
            </div>
          </div>`)}</div>
        </div>
        <div className="section">
          <div className="section-head"><h2>Det skal du købe</h2></div>
          <div className="stack-gap">${Object.entries(shopping).sort(([a], [b]) => (a === "Normalpris") - (b === "Normalpris")).map(([store, items]) => html`<div key=${store}>
            <div className="small muted" style=${{margin:"4px 2px 6px", fontWeight:600}}>${store === "Normalpris" ? `Normalpris – køb i ${plan.stores[0] || "din butik"}` : store}</div>
            <div className="list">${Object.values(items).map(it => html`<div key=${it.term} className="row" style=${{minHeight:48}}>
              ${it.offer?.image ? html`<img src=${it.offer.image} alt="" loading="lazy" style=${{width:36, height:36, objectFit:"contain", borderRadius:6, background:"#fff"}} />` : null}
              <div className="main"><div className="title">${it.term}</div>${it.offer && html`<div className="sub">${it.offer.heading}</div>`}</div>
              <div className="end num">${it.offer ? kr(it.offer.price) : ""}</div>
            </div>`)}</div>
          </div>`)}</div>
          <button className="btn soft block" style=${{marginTop:12}} onClick=${addToList}><${Icon} name="plus" /> Læg det hele på indkøbslisten</button>
          <${Msg} k="plan" />
        </div>
      </div>`}
      ${StoresBlock()}
    </div>`;
  };

  const MealsTab = () => {
    const meals = shop.meals || [];
    const setMeals = (m) => setShop({...shop, meals: m});
    const fromTemplate = (name, ingredients) => {
      const ex = meals.find(m => m.name === name);
      setMeals(ex ? meals.map(m => m.id === ex.id ? {...m, fav: !m.fav} : m) : [...meals, { id: uid(), name, ingredients, fav: true }]);
    };
    const parse = (txt) => txt.split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
    const addOwn = () => {
      const name = mealDraft.name.trim(), ingredients = parse(mealDraft.ingredients);
      if (!name || !ingredients.length) return;
      const url = /^https?:\/\//.test(mealDraft.url.trim()) ? mealDraft.url.trim() : null;
      setMeals([...meals, { id: uid(), name, ingredients, fav: true, url }]); setMealDraft({ name: "", ingredients: "", url: "" });
    };
    const isFav = (name) => meals.some(m => m.name === name && m.fav);
    const own = meals.filter(m => !MEAL_TEMPLATES.some(([n]) => n === m.name));
    return html`<div>
      <div className="small muted" style=${{margin:"0 2px 10px"}}>Tryk på de retter, du kan lide. Du kan rette ingredienserne – de bruges til at finde tilbud.</div>
      <div className="list">${[...MEAL_TEMPLATES.map(([name, ing]) => meals.find(m => m.name === name) || { id: name, name, ingredients: ing, fav: false, template: true }), ...own].map(m => html`<div key=${m.id} className="row" style=${{alignItems:"flex-start", flexWrap:"wrap"}}>
        <button className=${"icon-btn" + (m.fav ? " on" : "")} style=${{color: m.fav ? "var(--neg)" : "var(--text-3)", fontSize:20}} aria-pressed=${!!m.fav} aria-label=${`${m.name} er ${m.fav ? "" : "ikke "}en yndlingsret`}
          onClick=${()=> m.template || MEAL_TEMPLATES.some(([n]) => n === m.name) ? fromTemplate(m.name, m.ingredients) : setMeals(meals.map(x => x.id === m.id ? {...x, fav: !x.fav} : x))}>${m.fav ? "♥" : "♡"}</button>
        <div className="main">
          <div className="title" style=${{whiteSpace:"normal"}}>${m.name}${m.url && html` <a href=${m.url} target="_blank" rel="noopener" className="link-btn small" style=${{whiteSpace:"nowrap"}}>Opskrift ↗</a>`}</div>
          ${m.fav && !m.template
            ? html`<input className="input sm" style=${{marginTop:6}} value=${m.ingredients.join(", ")} aria-label=${`Ingredienser i ${m.name}`} onChange=${e=>setMeals(meals.map(x => x.id === m.id ? {...x, ingredients: parse(e.target.value)} : x))} />`
            : html`<div className="sub" style=${{whiteSpace:"normal"}}>${m.ingredients.join(", ")}</div>`}
        </div>
        ${!MEAL_TEMPLATES.some(([n]) => n === m.name) && html`<button className="link-btn small" onClick=${()=>{ const prev = meals; setMeals(meals.filter(x => x.id !== m.id)); showUndo(`${m.name} er slettet`, () => setMeals(prev)); }}>Slet</button>`}
      </div>`)}</div>
      <div className="section">
        <div className="section-head"><h2>Tilføj din egen ret</h2></div>
        <div className="card stack">
          <input className="input" placeholder="Navn, fx Mormors boller i karry" value=${mealDraft.name} onChange=${e=>setMealDraft({...mealDraft, name: e.target.value})} aria-label="Rettens navn" />
          <input className="input" placeholder="Ingredienser adskilt af komma, fx hakket svinekød, ris, karry" value=${mealDraft.ingredients} onChange=${e=>setMealDraft({...mealDraft, ingredients: e.target.value})} aria-label="Ingredienser" />
          <input className="input" type="url" placeholder="Link til opskriften (valgfrit)" value=${mealDraft.url} onChange=${e=>setMealDraft({...mealDraft, url: e.target.value})} aria-label="Link til opskriften" />
          <button className="btn primary" disabled=${!mealDraft.name.trim() || !parse(mealDraft.ingredients).length} onClick=${addOwn}>Tilføj ret</button>
        </div>
      </div>
    </div>`;
  };

  const FoodPage = () => html`<div>
    <div className="seg" role="tablist">${[["plan", "Madplan"], ["list", `Indkøbsliste${shop.items.filter(i => !i.done).length ? ` (${shop.items.filter(i => !i.done).length})` : ""}`], ["meals", `Retter${favMeals.length ? ` (${favMeals.length})` : ""}`]].map(([id, label]) =>
      html`<button key=${id} role="tab" aria-selected=${foodTab === id} className=${foodTab === id ? "on" : ""} onClick=${()=>setFoodTab(id)}>${label}</button>`)}</div>
    ${foodTab === "plan" ? PlanTab() : foodTab === "list" ? ShopPage() : MealsTab()}
    <div className="small faint" style=${{marginTop:16}}>Tilbud fra Tjek (eTilbudsavis). Priser og gyldighed kan afvige i butikken.</div>
  </div>`;

  const ConnectionsPage = () => {
    const bridgeOk = Boolean(bridge.url && bridge.secret);
    const saveBridge = async () => {
      const b = { url: bridgeDraft.url.trim().replace(/\/+$/, ""), secret: bridgeDraft.secret.trim() };
      if (!/^https:\/\//.test(b.url)) { flash("bridge", "Adressen skal starte med https://"); return; }
      store.setJson(BRIDGE_KEY, b); setBridgeState(b);
      setBusy("ping"); setPingChecks(null);
      try {
        const r = await callBridge("/ping");
        setPingChecks(r.checks || []);
        flash("bridge", r.bank && r.saxo ? "Alt er sat op. Du kan forbinde banken og Saxo nedenfor." : "Workeren svarer, men der mangler noget – se listen.", 0);
      } catch (e) { flash("bridge", "Fejl: " + e.message, 0); }
      setBusy("");
    };
    const ebValid = ebSession?.valid_until ? new Date(ebSession.valid_until) : null;
    const daysLeft = ebValid ? Math.ceil((ebValid - Date.now()) / 86400e3) : null;
    return html`<div>
      ${pendingCode && html`<div className="banner info"><span className="grow">Du er vendt tilbage i en anden browser end appen. Kopiér koden nedenfor og indsæt den i appen under Bankforbindelser.</span></div>`}
      ${pendingCode && html`<div className="card stack"><div className="code">${pendingCode}</div><button className="btn primary" onClick=${()=>{ navigator.clipboard?.writeText(pendingCode).then(()=>flash("paste","Kopieret."), ()=>{}); }}>Kopiér kode</button><${Msg} k="paste" /></div>`}

      <div className="section" style=${{marginTop: pendingCode ? 22 : 0}}>
        <div className="section-head"><h2>1 · Din worker</h2>${bridgeOk && html`<span className="chip pos">Sat op</span>`}</div>
        <div className="card stack">
          <div className="small muted">Den lille server på Cloudflare, der holder dine bank- og Saxo-nøgler. Se SETUP.md for hvordan du opretter den.</div>
          <label className="field">Worker-adresse<input className="input" placeholder="https://budget-bridge.<navn>.workers.dev" value=${bridgeDraft.url} onChange=${e=>setBridgeDraft({...bridgeDraft,url:e.target.value})} /></label>
          <label className="field">Adgangskode (APP_SECRET)<input className="input" type="password" autoComplete="off" value=${bridgeDraft.secret} onChange=${e=>setBridgeDraft({...bridgeDraft,secret:e.target.value})} /></label>
          <div className="btns"><button className="btn primary" disabled=${busy==="ping"} onClick=${saveBridge}>${busy==="ping" ? "Tester…" : "Gem og test"}</button></div>
          <${Msg} k="bridge" />
          ${pingChecks && html`<div className="checks">${pingChecks.map(c => html`<div key=${c.id} className=${"check " + (c.ok ? "ok" : "bad")}>
            <span className="mark" aria-hidden="true">${c.ok ? "✓" : "✕"}</span><span>${c.msg}</span>
          </div>`)}</div>`}
          <div className="small faint">Redirect-URL til Enable Banking og Saxo: <span className="code" style=${{display:"inline",padding:"1px 5px"}}>${redirectUrl()}</span></div>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>2 · Sparekassen Kronjylland</h2>${ebSession?.status === "AUTHORIZED" && daysLeft > 0 && html`<span className="chip pos">Forbundet</span>`}</div>
        <div className="card stack">
          ${ebSession ? html`
            <div className="small">
              ${ebSession.accounts.length} konti · ${sync.bank ? syncLabel(sync.bank) : "ikke synkroniseret endnu"}<br/>
              ${daysLeft != null && html`<span className=${daysLeft < 14 ? "neg" : "muted"}>Adgangen udløber om ${Math.max(0,daysLeft)} dage (${ebValid.toLocaleDateString("da-DK")})</span>`}
            </div>
            <div className="btns">
              <button className="btn primary" disabled=${syncing} onClick=${()=>syncAll()}>${syncing ? "Synkroniserer…" : "Synkronisér nu"}</button>
              <button className="btn" disabled=${busy==="bank" || !bridgeOk} onClick=${startBankLink}>Forny adgang</button>
              <button className="btn danger" onClick=${()=>{ setEbSession(null); flash("bank","Forbindelsen er fjernet fra appen. Hentede poster er beholdt."); }}>Fjern</button>
            </div>` : html`
            <div className="small muted">Log ind med MitID hos banken via Enable Banking. Du bliver sendt tilbage hertil bagefter.</div>
            <button className="btn primary" disabled=${!bridgeOk || busy==="bank"} onClick=${startBankLink}>${busy==="bank" ? "Åbner banken…" : "Forbind Sparekassen"}</button>`}
          <${Msg} k="bank" />
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>3 · Saxo</h2>${saxoTokens && saxoRefreshValid(saxoTokens) && html`<span className="chip pos">Logget ind</span>`}</div>
        <div className="card stack">
          <div className="small muted">Et Saxo-login holder ca. 40 minutter. Log ind, når du vil opdatere dine beholdninger og kurser.</div>
          <div className="small">${sync.saxo ? syncLabel(sync.saxo) : "Ikke synkroniseret endnu"}</div>
          <div className="btns">
            <button className="btn primary" disabled=${!bridgeOk || busy==="saxo"} onClick=${startSaxoLogin}>${busy==="saxo" ? "Åbner Saxo…" : "Log ind på Saxo"}</button>
            ${saxoTokens && html`<button className="btn danger" onClick=${()=>setSaxoTokens(null)}>Log ud</button>`}
          </div>
          <${Msg} k="saxo" />
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Har du en kode fra en anden browser?</h2></div>
        <div className="card stack">
          <input className="input" placeholder="eb.… eller saxo.…" value=${codePaste} onChange=${e=>setCodePaste(e.target.value)} aria-label="Kode" />
          <button className="btn" disabled=${!codePaste.trim() || !bridgeOk} onClick=${redeemPastedCode}>Brug kode</button>
          <${Msg} k="paste" />
        </div>
      </div>
    </div>`;
  };

  const AiPage = () => html`<div>
    <div className="card stack">
      <div className="small muted">Claude analyserer indeværende måned, dit budget og de seneste 6 måneder og giver konkrete råd. Kun summer sendes – ikke de enkelte poster.</div>
      <button className="btn primary" disabled=${aiLoading} onClick=${runAI}><${Icon} name="spark" /> ${aiLoading ? "Analyserer…" : "Analyser min økonomi"}</button>
    </div>
    ${aiMsg && html`<div className="card ai-out" style=${{marginTop:12}}>${aiMsg}</div>`}
    ${!aiMsg && !aiLoading && !apiKey && html`<div className="small muted" style=${{marginTop:12}}>${noKeyMsg}</div>`}
  </div>`;

  const ImportPage = () => html`<div>
    <input ref=${fileRef} type="file" accept=".csv,.txt" style=${{display:"none"}} onChange=${e=>{ e.target.files[0]&&handleFile(e.target.files[0]); e.target.value=""; }} />
    <div className="section-head"><h2>CSV-import</h2></div>
    <div className="card stack">
      <div className="small muted">Til ældre poster eller andre banker. Dubletter springes over.</div>
      <button className="btn" onClick=${()=>fileRef.current && fileRef.current.click()}><${Icon} name="upload" /> Vælg CSV-fil</button>
      <textarea className="input" style=${{minHeight:90,fontFamily:"var(--font-mono)",fontSize:12}} value=${csvPaste} onChange=${e=>setCsvPaste(e.target.value)} placeholder=${"Eller indsæt her (dato;tekst;beløb)\n01.01.2025;Rema 1000;-189,50"} aria-label="CSV-tekst"></textarea>
      <button className="btn" disabled=${!csvPaste.trim()} onClick=${()=>{ importCsvText(csvPaste); setCsvPaste(""); }}>Importér indsat tekst</button>
      <${Msg} k="import" />
    </div>
    <div className="section">
      <div className="section-head"><h2>Værktøjer</h2></div>
      <div className="card stack">
        <label className="field">Fast husleje pr. måned (kr., bogføres sidste dag)<input className="input" type="number" inputMode="decimal" value=${rent.amount} onChange=${e=>setRent({...rent, amount:+e.target.value})} /></label>
        <label className="field">Betales fra<select className="input" value=${rent.assetId || ""} onChange=${e=>setRent({...rent, assetId:e.target.value || null})}>
          <option value="">Ingen konto (kun budget)</option>
          ${assets.filter(a => a.source !== "bank").map(a => html`<option key=${a.id} value=${a.id}>${a.name}</option>`)}
        </select></label>
        <label style=${{display:"flex", alignItems:"center", gap:10, cursor:"pointer"}}><input type="checkbox" style=${{width:18, height:18, accentColor:"var(--accent)"}} checked=${rent.auto} onChange=${e=>setRent({...rent, auto:e.target.checked})} /> <span>Bogfør automatisk hver måned</span></label>
        <div className="small faint">${rent.auto
          ? `Huslejen bogføres den sidste dag i måneden${rent.assetId ? " og trækkes samtidig fra kontoen ovenfor" : ""}.${rent.paidThrough ? ` Senest: ${monthLabel(rent.paidThrough)}.` : ""}`
          : "Slået fra. Brug knappen nedenfor for at tilføje huslejen selv."}</div>
        <button className="btn" onClick=${genRent}>Tilføj husleje for alle måneder</button>
        <button className="btn" onClick=${recategorizeAll}>Genkategorisér alle poster</button>
        <div className="small faint">Genkategorisering rører ikke poster, hvor du selv har valgt kategori.</div>
        <${Msg} k="tools" />
      </div>
    </div>
  </div>`;

  const AppearancePage = () => html`<div className="list">
    ${[["dark","Mørk"],["light","Lys"],["system","Følg systemet"]].map(([v,l]) => html`<button key=${v} className="row" onClick=${()=>setTheme(v)}>
      <div className="main"><div className="title">${l}</div></div>
      ${theme === v && html`<span className="chip info">Valgt</span>`}
    </button>`)}
  </div>`;

  const ApiKeyPage = () => {
    const saveKey = () => { const k = keyDraft.trim(); if (!k) return; store.set(API_KEY_KEY, k); setApiKey(k); setKeyDraft(""); flash("key", "Nøgle gemt på denne enhed."); };
    const testKey = async () => {
      setBusy("key");
      try { await callClaude({ max_tokens: 50, messages:[{role:"user",content:"Svar kun med ordet OK."}] }); flash("key", "Nøglen virker.", 6000); }
      catch(e) { flash("key", e instanceof NoKeyError ? "Gem en nøgle først." : `Fejl: ${e.message}`, 10000); }
      setBusy("");
    };
    return html`<div className="card stack">
      <div className="small muted">Bruges af AI-analyse og kursopdatering af manuelle beholdninger. Opret en nøgle på <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>. Den gemmes kun på denne enhed.</div>
      <div className="small">Status: ${apiKey ? html`<span className="pos">Nøgle gemt (…${apiKey.slice(-4)})</span>` : html`<span className="muted">Ingen nøgle</span>`}</div>
      <input className="input" type="password" autoComplete="off" value=${keyDraft} onChange=${e=>setKeyDraft(e.target.value)} onKeyDown=${e=>{ if (e.key==="Enter") saveKey(); }} placeholder=${apiKey ? "Indsæt ny nøgle for at erstatte" : "sk-ant-…"} aria-label="API-nøgle" />
      <div className="btns">
        <button className="btn primary" disabled=${!keyDraft.trim()} onClick=${saveKey}>Gem</button>
        <button className="btn" disabled=${!apiKey || busy==="key"} onClick=${testKey}>${busy==="key" ? "Tester…" : "Test"}</button>
        <button className="btn danger" disabled=${!apiKey} onClick=${()=>{ store.remove(API_KEY_KEY); setApiKey(""); flash("key","Nøgle slettet."); }}>Slet</button>
      </div>
      <${Msg} k="key" />
      <label className="field">Model<input className="input" value=${model} placeholder=${DEFAULT_MODEL} onChange=${e=>{ setModel(e.target.value); if (e.target.value.trim()) store.set(MODEL_KEY, e.target.value.trim()); else store.remove(MODEL_KEY); }} /></label>
    </div>`;
  };

  const DataPage = () => html`<div className="card stack">
    <div className="small muted">Alt gemmes lokalt på denne enhed. Flyt data mellem pc og telefon med eksport/import. Backups fra claude.ai-versionen kan også importeres. Nøgler og bankadgang er ikke med i backuppen.</div>
    <div className="btns">
      <button className="btn primary" onClick=${exportData}>Eksportér backup</button>
      <button className="btn" onClick=${()=>importRef.current && importRef.current.click()}>Importér backup</button>
    </div>
    <${Msg} k="backup" />
    <div className="small faint">${transactions.length} poster · ${holdings.length} beholdninger · ${assets.length} aktiver</div>
  </div>`;

  const MorePage = () => {
    if (sub) {
      const Sub = { wealth: WealthPage, trips: TripsPage, subs: SubsPage, connections: ConnectionsPage, ai: AiPage, import: ImportPage, appearance: AppearancePage, apikey: ApiKeyPage, data: DataPage }[sub];
      return Sub ? Sub() : null;
    }
    const lastBackup = +store.get(BACKUP_KEY) || 0;
    const backupDays = lastBackup ? Math.floor((Date.now() - lastBackup) / 86400e3) : null;
    const backupText = backupDays == null ? "Ingen backup endnu" : backupDays === 0 ? "Sidste backup: i dag" : `Sidste backup: ${backupDays} dage siden`;
    const backupStale = transactions.length > 0 && (backupDays == null || backupDays > 30);
    // AI features cost money via the user's own Claude API key; without one they stay out of the menu.
    const pages = MORE_PAGES.filter(p => apiKey || !["ai", "apikey"].includes(p.id));
    return html`<div>
      <div className="list stagger">
      ${pages.map((p, i) => html`<button key=${p.id} style=${stag(i)} className="row" onClick=${()=>{ setSub(p.id); window.scrollTo(0,0); }}>
        <div className="sq" style=${{background:"var(--accent-bg)", color:"var(--accent)"}}><${Icon} name=${p.icon} /></div>
        <div className="main"><div className="title">${p.label}</div><div className=${"sub" + (p.id === "data" && backupStale ? " neg" : "")}>${p.id === "data" ? backupText : p.sub}</div></div>
        <span className="faint"><${Icon} name="chevron" /></span>
      </button>`)}
      </div>
      ${!apiKey && html`<button className="link-btn small" style=${{display:"block", margin:"14px auto 0", color:"var(--text-2)"}} onClick=${()=>{ setSub("apikey"); window.scrollTo(0,0); }}>Slå AI-funktioner til (kræver Claude API-nøgle)</button>`}
    </div>`;
  };

  // ================= shell =================

  const pageTitle = page === "home" ? "Overblik"
    : page === "more" && sub ? MORE_PAGES.find(p => p.id === sub)?.label
    : page === "invest" ? "Investeringer"
    : page === "food" ? "Mad og tilbud"
    : page === "budget" ? monthName(budgetMonthSel)
    : PAGES.find(p => p.id === page)?.label;
  const lastSync = [sync.bank, sync.saxo].filter(Boolean).sort().pop();
  const canSync = Boolean(ebSession?.session_id) || Boolean(saxoTokens);
  const body = { home: HomePage, tx: TxPage, budget: BudgetPage, invest: InvestPage, food: FoodPage, more: MorePage }[page]();

  return html`<div className=${"app" + (hideAmounts ? " privacy" : "")}>
    <input ref=${importRef} type="file" accept=".json,application/json" style=${{display:"none"}} onChange=${e=>{ e.target.files[0]&&importData(e.target.files[0]); e.target.value=""; }} />
    <header className="topbar">
      ${page === "more" && sub && html`<button className="icon-btn" aria-label="Tilbage" onClick=${()=>setSub(null)}><${Icon} name="back" /></button>`}
      <h1>${pageTitle}</h1>
      <button className="icon-btn privacy-btn" aria-pressed=${hideAmounts} aria-label=${hideAmounts ? "Vis beløb" : "Skjul beløb"} title=${hideAmounts ? "Vis beløb" : "Skjul beløb"} onClick=${toggleHide}><${Icon} name=${hideAmounts ? "eyeoff" : "eye"} /></button>
      <button className=${"sync-chip" + (syncing ? " spin" : "")} disabled=${syncing} onClick=${()=> canSync ? syncAll() : goSub("connections")}
        aria-label=${canSync ? "Synkronisér" : "Forbind bank og Saxo"}>
        <${Icon} name="refresh" />${syncing ? "Henter…" : lastSync ? syncTime(lastSync) : canSync ? "Synkronisér" : "Forbind"}
      </button>
    </header>
    <main className="page" key=${page + (sub || "")}>
      ${saveError && html`<div className="banner err">Browseren tillader ikke at gemme data. Eksportér en backup, så du ikke mister noget.</div>`}
      ${syncError && html`<div className="banner err"><span className="grow">${syncError}</span><button className="link-btn" onClick=${()=>setSyncError("")}>Luk</button></div>`}
      ${msgs.sync && html`<div className="banner info">${msgs.sync}</div>`}
      ${pendingCode && page !== "more" && html`<div className="banner info"><span className="grow">Login gennemført i en anden browser.</span><button className="btn soft" onClick=${()=>goSub("connections")}>Vis kode</button></div>`}
      ${body}
    </main>
    ${toast && html`<div className="toast" role="status">
      <span>${toast.text}</span>
      <button onClick=${()=>{ toast.restore(); setToast(null); clearTimeout(toastTimer.current); }}>Fortryd</button>
    </div>`}
    <nav className="nav"><div className="nav-inner">
      ${PAGES.map(p => html`<button key=${p.id} className=${page === p.id ? "on" : ""} aria-current=${page === p.id ? "page" : null} onClick=${()=>{ setPage(p.id); if (p.id === "more" && page === "more") setSub(null); window.scrollTo(0,0); }}><${Icon} name=${p.icon} />${p.label}</button>`)}
    </div></nav>
  </div>`;
}

// If anything in the UI throws, show a way out instead of a blank page. Stored data is untouched.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error(error, info); }
  saveRaw() {
    const raw = store.get(STORAGE_KEY) || "{}";
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `oekonomi-nødbackup-${isoDate(new Date())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return html`<div className="app"><main className="page" style=${{paddingTop: 40}}>
      <div className="card stack">
        <div style=${{fontWeight:600, fontSize:18}}>Noget gik galt</div>
        <div className="small muted">Appen stødte på en fejl. Dine data er stadig gemt på enheden.</div>
        <div className="code">${String(this.state.error?.message || this.state.error)}</div>
        <div className="btns">
          <button className="btn primary" onClick=${() => location.reload()}>Genindlæs</button>
          <button className="btn" onClick=${() => this.saveRaw()}>Gem mine data</button>
        </div>
      </div>
    </main></div>`;
  }
}

createRoot(document.getElementById("root")).render(html`<${ErrorBoundary}><${App} /><//>`);
