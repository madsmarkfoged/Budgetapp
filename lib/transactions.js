import { addDays, isoDate, parseDKDate } from "./dates.js";
import { uid } from "./util.js";

const INCOME_CATS = ["Løn","SU","Anden indkomst"];

const CATEGORIES = ["Løn","SU","Anden indkomst","Husleje","Mad & dagligvarer","Transport","Restaurant & café","Abonnementer","Forsikring","Sundhed & fitness","Shopping","Underholdning","Rejser","Opsparing","Investering","Intern overførsel","Udeladt","Andet"];

const CAT_COLORS = {"Løn":"#0F6E56","SU":"#127C5A","Anden indkomst":"#3B8A6E","Husleje":"#378ADD","Mad & dagligvarer":"#639922","Transport":"#BA7517","Restaurant & café":"#D85A30","Abonnementer":"#534AB7","Forsikring":"#A32D2D","Sundhed & fitness":"#1D9E75","Shopping":"#D4537E","Underholdning":"#7F77DD","Rejser":"#EF9F27","Opsparing":"#185FA5","Investering":"#3B6D11","Intern overførsel":"#B4B2A9","Udeladt":"#888780","Andet":"#5F5E5A"};

const SHORT_CAT = {"Mad & dagligvarer":"Mad","Restaurant & café":"Café","Sundhed & fitness":"Sundhed","Abonnementer":"Abonnem."};

const EXCLUDED = ["Intern overførsel","Udeladt"];

const RENT_TEXT = "Husleje (fast)";

function guessCategory(desc) {
  const d = (desc||"").toLowerCase();
  if (/løn|lønoverf|loenoverf|salary|\bgage\b/.test(d)) return "Løn";
  if (/\bsu\b|su[- ]?styr|uddannelsesstøtte|statens uddann/.test(d)) return "SU";
  if (/husleje|\bleje\b|boligselskab|udlejning|huslejekonto/.test(d)) return "Husleje";
  if (/tryg|forsikr|topdanmark|\balka\b|codan|gjensidige|gf forsikr/.test(d)) return "Forsikring";
  if (/openai|chatgpt|spotify|netflix|hbo|disney|viaplay|youtube|icloud|apple\.com\/bill|itunes|dr\.|tv\s?2|avis|blad|abonne|subscr/.test(d)) return "Abonnementer";
  if (/rema|netto|fakta|aldi|lidl|meny|fotex|føtex|bilka|daglig|supermark|groceri|coop|brugsen|kvickly|løvbjerg|loevbjerg|salling|\bspar\b|købmand|kobmand|7-eleven|kiosk|grønt|groent|bager|slagter|fiskehandl|lagkagehuset|nemlig|wolt/.test(d)) return "Mad & dagligvarer";
  if (/dsb|rejsekort|fly|tog|bus|metro|taxa|uber|parkering|benzin|shell|circle k|ok\s?tank|kombardo|molslinjen|færge|faerge|flexii/.test(d)) return "Transport";
  if (/restaurant|cafe|café|pizza|sushi|mcdo|burger|takeaway|just eat|shawarma|kebab|falafel|kanpla|kantine|compass group/.test(d)) return "Restaurant & café";
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
  if (/apple\.com\/bill|itunes/i.test(desc || "")) return "Apple";
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
    // Regular trips and shopping (Kombardo, Rejsekort, the same supermarket) repeat too, but aren't subscriptions.
    if (sign < 0 && ["Transport", "Mad & dagligvarer", "Restaurant & café", "Shopping", "Rejser"].includes(t.category)) continue;
    const k = subKey(t.description);
    if (k.length < 3) continue;
    (groups[k] ||= []).push(t);
  }
  // One merchant can bill several subscriptions (Apple: "APPLE.COM/BILL, CORK" for iCloud, apps, …):
  // when it charges more often than monthly, each recurring amount becomes its own subscription.
  for (const [k, txs] of Object.entries(groups)) {
    if (txs.length <= new Set(txs.map(t => t.date.slice(0, 7))).size * 1.5) continue;
    delete groups[k];
    for (const t of txs) (groups[`${k} ${Math.round(Math.abs(t.amount))}`] ||= []).push(t);
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
    if (median < (known ? 5 : 10) || (amounts[amounts.length - 1] - amounts[0]) / median > 0.35) continue;
    const last = txs[txs.length - 1];
    if (last.date < stale) continue;
    const split = key !== subKey(last.description);
    // Price rise: the newest charge is more than 3 % above the one before it.
    const before = txs.length > 1 ? Math.abs(txs[txs.length - 2].amount) : null;
    const rose = before && Math.abs(last.amount) > before * 1.03 ? { from: before, to: Math.abs(last.amount), date: last.date } : null;
    out.push({ key, name: prettyName(last.description) + (split ? ` (${Math.round(Math.abs(last.amount))} kr.)` : ""), raw: last.description, category: last.category, monthly: Math.abs(last.amount), last: last.date, months: months.size, rose });
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

export { INCOME_CATS, CATEGORIES, CAT_COLORS, SHORT_CAT, EXCLUDED, RENT_TEXT, guessCategory, splitLine, DATE_RE, parseCSV, DEFAULT_BUDGETS, STUDENT_BUDGET, eff, monthIncomeExpense, subKey, prettyName, detectRecurring, detectSubscriptions, guessShare };
