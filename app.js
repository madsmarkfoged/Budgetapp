import React, { useState, useEffect, useRef } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
import { PAYDAY_CUTOFF, MONTHS_DA, budgetMonth, isoDate, addDays, monthEnd, addMonths, lastRentMonth, monthLabel, monthName, currentBudgetMonth, prevMonth, parseDKDate, prettyDate, easter, isBankClosed, paydayIn, nextPayday, WEEKDAYS } from "./lib/dates.js";
import { uid, randomBytes, toB64, fromB64 } from "./lib/util.js";
import { INCOME_CATS, CATEGORIES, CAT_COLORS, SHORT_CAT, EXCLUDED, RENT_TEXT, guessCategory, splitLine, DATE_RE, parseCSV, DEFAULT_BUDGETS, STUDENT_BUDGET, eff, monthIncomeExpense, subKey, prettyName, detectRecurring, detectSubscriptions, guessShare } from "./lib/transactions.js";
import { DEFAULT_TRAINING, LIFTS, sessionFor, weekProgress, weekStreak, e1rm, parseWorkoutCsv, liftSummary } from "./lib/training.js";
import { AWAY_WORDS, NOT_AWAY, calendarAway, icsEsc, icsDate, buildIcs } from "./lib/calendar.js";
import { te, td, syncCryptoKey, gz, sealData, openData, deviceName } from "./lib/sync.js";
import { TJEK_SEARCH, CHAINS, AARHUS, STAPLES, DEFAULT_SHOP, kr, chainOf, usualStores, searchOffers, MEAL_TEMPLATES, INGREDIENT_GROUPS, MEAL_STEPS, MEAL_SOURCE, VALDEMARSRO, VR_URL, VR_TAGS, MEAL_EXTRAS, OFFER_EXCLUDE, OFFER_ALIASES, OFFER_EXCLUDE_ALL, offerFits, NORMAL_PRICES, normalPrice, MEAL_AMOUNTS, ING, EXTRA_ING, REMA_DATA, PIECE_G, UNITS, UNIT_G, toGrams, mealServings, mealAmounts, perPortion, mealMacros, mealProtein, nice, fmtAmount, BASICS, KNOWN_TERMS, LINE_UNITS, SKIP_LINES, parseIngredientLine, mealFromRecipe, covers, AISLES, aisleOf, packsFor, planCost, planWeek } from "./lib/food.js";

const html = htm.bind(React.createElement);

// ---------------- constants ----------------

const CURRENCIES = ["DKK","USD","EUR","GBP","SEK","NOK"];
const DEFAULT_FX = {EUR:7.46, USD:6.85, GBP:8.70, SEK:0.66, NOK:0.65};
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

// Privacy mode: set by App on every render; while on, amounts render as dots (for using the app in public).
let HIDE_AMOUNTS = false;
const fmtKr = (n) => new Intl.NumberFormat("da-DK",{style:"currency",currency:"DKK",maximumFractionDigits:0}).format(n);
const fmt = (n) => HIDE_AMOUNTS ? "••• kr." : fmtKr(n);
const fmtShort = (n) => HIDE_AMOUNTS ? "•••" : new Intl.NumberFormat("da-DK",{maximumFractionDigits:0}).format(n);
const numf = (n) => new Intl.NumberFormat("da-DK",{maximumFractionDigits:2}).format(n);
const pctf = (n) => new Intl.NumberFormat("da-DK",{maximumFractionDigits:1,signDisplay:"always"}).format(n) + " %";
const DEFAULT_RENT = { amount: 4982, assetId: null, auto: true, paidThrough: null };
// Travel fund shared with the user's sister: each saves `goal`; trip costs are split 50/50.
const DEFAULT_REJSE = { saved: 0, goal: 100000, accountId: null, trips: [] };
function syncTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  return isoDate(d) === isoDate(new Date()) ? hm : `${d.getDate()}/${d.getMonth()+1} ${hm}`;
}
const syncLabel = (ts) => ts ? `Synkroniseret ${syncTime(ts)}` : null;

const SAXO_SEED_NAMES = ["Amundi Prime All Country World ETF Acc","Sparindex INDEX Globale Aktier KL","Microsoft Corp.","Amazon.com Inc.","ALK-Abelló B A/S","Zealand Pharma A/S","Rheinmetall AG"];

// ---------------- Saxo ledger: deposits, trades, dividends and costs ----------------
// Saxo's report endpoints allow calls from the app's origin, so these go straight from the browser with the
// user's own (read-only) login; the worker isn't involved. The token works on live or sim, not both.
const SAXO_GATEWAYS = ["https://gateway.saxobank.com/openapi", "https://gateway.saxobank.com/sim/openapi"];
const BOOKING_LABEL = {
  "Cash Amount": "Indbetaling", "Share Amount": "Handel", "Commission": "Kurtage", "Interest": "Rente",
  "Corporate Actions - Cash Dividends": "Udbytte", "Corporate Actions - Withholding Tax": "Udbytteskat",
};
async function fetchSaxoLedger(token) {
  const get = async (base, path) => {
    const r = await fetch(base + path, { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) throw Object.assign(new Error(`Saxo svarede ${r.status}`), { status: r.status });
    return r.json();
  };
  let base = null, me = null;
  for (const b of SAXO_GATEWAYS) { try { me = await get(b, "/port/v1/clients/me"); base = b; break; } catch (e) { if (e.status !== 401) throw e; } }
  if (!base) throw new Error("Saxo-login er udløbet.");
  const q = new URLSearchParams({ FromDate: "2010-01-01", ToDate: isoDate(new Date()) });
  const r = await get(base, `/cs/v1/reports/bookings/${encodeURIComponent(me.ClientKey)}?${q}`);
  const rows = (r.Data || []).map(b => ({
    date: (b.Date || "").slice(0, 10), type: b.BkAmountType, label: BOOKING_LABEL[b.BkAmountType] || b.BkAmountType,
    name: b.InstrumentDescription || "", amount: +(b.AmountAccountCurrency ?? b.Amount) || 0, account: b.AccountCurrency || "DKK", accountId: b.AccountId || null,
  })).sort((a, b) => b.date.localeCompare(a.date));
  const sum = (type) => rows.filter(x => x.type === type).reduce((s, x) => s + x.amount, 0);
  return {
    fetched: new Date().toISOString(), rows,
    deposits: sum("Cash Amount"), trades: sum("Share Amount"), commission: sum("Commission"),
    dividends: sum("Corporate Actions - Cash Dividends"), tax: sum("Corporate Actions - Withholding Tax"), interest: sum("Interest"),
  };
}

// Today's price change per position (Saxo's change since the previous close), straight from the browser
// like the ledger. Keyed by NetPositionId, the same id the worker's /saxo/portfolio returns.
async function fetchSaxoDay(token) {
  for (const base of SAXO_GATEWAYS) {
    const r = await fetch(base + "/port/v1/netpositions/me?FieldGroups=NetPositionView&$top=500", { headers: { Authorization: "Bearer " + token } });
    if (r.status === 401) continue;
    if (!r.ok) throw new Error(`Saxo svarede ${r.status}`);
    const out = {};
    for (const p of (await r.json()).Data || []) {
      const v = p.NetPositionView || {};
      if (typeof v.InstrumentPriceDayPercentChange === "number") out[p.NetPositionId] = v.InstrumentPriceDayPercentChange;
    }
    return out;
  }
  return null;
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
  if (d.subsNames && typeof d.subsNames === "object") out.subsNames = d.subsNames;
  if (d.prefs && typeof d.prefs === "object") out.prefs = d.prefs;
  if (d.savedAt) out.savedAt = d.savedAt;
  if (d.shop) out.shop = {...DEFAULT_SHOP, ...d.shop};
  if (Array.isArray(d.invHistory)) out.invHistory = d.invHistory;
  if (d.saxoLedger) out.saxoLedger = d.saxoLedger;
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
  // Give up after 25 seconds, so a bad connection never leaves a button spinning forever.
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
  try {
    res = await fetch(b.url.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Secret": b.secret },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "Din worker svarede ikke i tide. Prøv igen om lidt." : "Kunne ikke nå din worker. Tjek adressen og din internetforbindelse.");
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data?.error || `Worker svarede ${res.status}`); e.status = res.status; e.code = data?.code; throw e; }
  return data;
}

const redirectUrl = () => location.origin + location.pathname;
const CAL_KEY = "cal_cache";         // the user's calendar events (this device only)

// ---------------- Face ID lock (WebAuthn passkey on this device) ----------------
// A privacy curtain: the app asks for Face ID/Touch ID before showing anything. The passkey never leaves the
// device; the data itself isn't encrypted by it (that's what the phone's own lock is for).
const LOCK_KEY = "app_lock";        // {credId, on, after (minutes in background before locking)}
async function createLockCredential() {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: randomBytes(32), rp: { name: "Økonomi" },
    user: { id: randomBytes(16), name: "okonomi-app", displayName: "Økonomi-appen" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" }, timeout: 60000,
  } });
  return toB64(cred.rawId);
}
async function verifyLock(credId) {
  await navigator.credentials.get({ publicKey: { challenge: randomBytes(32), allowCredentials: [{ type: "public-key", id: fromB64(credId) }], userVerification: "required", timeout: 60000 } });
}
const PUSH_KEY = "push_on";         // this device has turned notifications on
const urlB64ToBytes = (s) => fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
// The app scrolls inside #root (see styles.css), not the window.
const scrollToTop = () => document.getElementById("root")?.scrollTo(0, 0);

// ---------------- sync between devices ----------------
// The data is gzipped and encrypted (AES-GCM, key derived from the worker password) in the browser; the
// worker only keeps the opaque blob in KV. Newest save wins; the other copy is kept as a local backup.
const SYNC_META_KEY = "sync_meta";   // {at: time of the copy this device last sent/received}
const SYNC_BACKUP_KEY = "budget_data_sync_backup";
function beginOAuth(provider) {
  const nonce = uid().replace(/-/g, "");
  store.setJson(OAUTH_KEY, { provider, nonce, at: Date.now() });
  return `${provider}.${nonce}`;
}

// ---------------- app ----------------

const PAGES = [
  { id: "start", label: "Hjem", icon: "home" },
  { id: "home", label: "Overblik", icon: "wallet" },
  { id: "budget", label: "Budget", icon: "donut" },
  { id: "invest", label: "Invest.", icon: "trend" },
  { id: "food", label: "Mad", icon: "food" },
  { id: "more", label: "Mere", icon: "dots" },
];

const MORE_PAGES = [
  { id: "wealth", label: "Formue og gæld", icon: "wallet", sub: "Konti og gæld" },
  { id: "trips", label: "Rejsepulje", icon: "plane", sub: "Ferieopsparing og rejser med søs" },
  { id: "subs", label: "Abonnementer", icon: "repeat", sub: "Faste træk hver måned" },
  { id: "report", label: "Månedsrapport", icon: "donut", sub: "Måneden opsummeret" },
  { id: "trends", label: "Udvikling", icon: "trend", sub: "Kategorierne over de sidste måneder" },
  { id: "su", label: "SU-fribeløb", icon: "school", sub: "Hvor meget du må tjene ved siden af" },
  { id: "shared", label: "Delte udgifter", icon: "arrows", sub: "Hvem skylder hvem" },
  { id: "notify", label: "Notifikationer", icon: "bulb", sub: "Løn, madplan og nye tilbud" },
  { id: "calendar", label: "Kalender", icon: "ticket", sub: "Google Calendar og madplanen" },
  { id: "training", label: "Træning", icon: "heart", sub: "Program, vægt og løft" },
  { id: "connections", label: "Bankforbindelser", icon: "bank", sub: "Sparekassen Kronjylland og Saxo" },
  { id: "ai", label: "AI-analyse", icon: "spark", sub: "Råd baseret på dine tal" },
  { id: "import", label: "Import og værktøjer", icon: "upload", sub: "CSV, fast husleje, kategorier" },
  { id: "appearance", label: "Udseende og lås", icon: "sun", sub: "Mørk/lys og Face ID-lås" },
  { id: "apikey", label: "Claude API-nøgle", icon: "key", sub: "Til AI-analyse og kurser" },
  { id: "data", label: "Data og backup", icon: "db", sub: "Eksportér og importér" },
];

const RANGES = { "1M": 31, "3M": 92, "1Å": 366 };
const HOLD_PERIODS = { "I dag": 1, "1U": 7, "1M": 31, "1Å": 366 };
// SU-fribeløb per month (su.dk, videregående uddannelse, før skat men efter AM-bidrag): with SU, enrolled
// without SU, and not studying. The year's fribeløb is the sum over the months.
const SU_FRIBELOB = { 2026: { su: 20749, noSu: 23598, out: 45420 } };
// Aktiesparekonto: deposit cap per year (skat.dk) and the flat tax on each year's gain (lagerbeskatning).
const ASK_CAP = { 2025: 166200, 2026: 174200 };
const ASK_TAX = 0.17;
const isAskAccount = (a) => /aktiespare|askonto|\bask\b/i.test(`${a.name || ""} ${a.subType || ""} ${a.type || ""}`);

function App() {
  const initial = useRef(null);
  if (initial.current === null) initial.current = readStored();
  const init = initial.current;

  const [page, setPage] = useState("start");
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
  const [subsNames, setSubsNames] = useState(init.subsNames || {}); // subKey -> the user's own name ("iCloud+")
  const [prefs, setPrefs] = useState(init.prefs || {}); // su {limit, gross}, ask {accountId, jan1, deposits}, saxoAccounts
  const [syncState, setSyncState] = useState({ status: "idle" }); // idle | busy | ok | off | error, with at/msg
  const [syncChoice, setSyncChoice] = useState(null);  // first sync on a device that already has data
  const [affordOpen, setAffordOpen] = useState(false);
  const [affordAmt, setAffordAmt] = useState("");
  const [reportMonth, setReportMonth] = useState(null);
  const [lock, setLock] = useState(() => store.json(LOCK_KEY) || {});
  const [locked, setLocked] = useState(() => !!store.json(LOCK_KEY)?.on);
  const [lockMsg, setLockMsg] = useState("");
  const [lockSecret, setLockSecret] = useState("");
  const [pushInfo, setPushInfo] = useState(() => ({ on: store.get(PUSH_KEY) === "1", msg: "" }));
  const [quick, setQuick] = useState(null);           // quick expense sheet: {amt, cat, note, kind}
  const [shareDraft, setShareDraft] = useState({ who: "", desc: "", amt: "", paidBy: "me", split: "half" });
  const [shareFor, setShareFor] = useState(null);     // transaction id being shared from Poster
  const [calCache, setCalCache] = useState(() => store.json(CAL_KEY));
  const [calDraft, setCalDraft] = useState("");
  const [weightDraft, setWeightDraft] = useState("");
  const [liftDraft, setLiftDraft] = useState({ ex: "", kg: "", reps: "" });
  const [renameSub, setRenameSub] = useState(null);
  const [shop, setShop] = useState(init.shop || DEFAULT_SHOP);
  const [offers, setOffers] = useState({}); // itemId -> {loading, error, list}
  const [shopDraft, setShopDraft] = useState("");
  const [foodTab, setFoodTab] = useState("plan");
  const [mealDraft, setMealDraft] = useState({ name: "", ingredients: "", url: "", items: [] });
  const [ingGroup, setIngGroup] = useState(null); // open category in the ingredient picker
  const [planBusy, setPlanBusy] = useState(false);
  const [stapleDraft, setStapleDraft] = useState("");
  const [pickMeal, setPickMeal] = useState(null);
  const [ingFor, setIngFor] = useState(null);   // name of the meal whose ingredient picker is open (a starter meal gets an id only once edited)
  const [ingSearch, setIngSearch] = useState(""); // index of the plan meal whose "Vælg selv" list is open
  const [foodBudgetEdit, setFoodBudgetEdit] = useState(false);
  const [showFoodTx, setShowFoodTx] = useState(false);
  const [doneFor, setDoneFor] = useState(null);        // index of the plan meal whose "Lavet" panel is open
  const [doneDraft, setDoneDraft] = useState({ rate: 0, note: "", freeze: 0 });
  const [openRecipe, setOpenRecipe] = useState(null);  // name of the meal whose amounts are open
  const [viewServings, setViewServings] = useState({});
  const [importUrl, setImportUrl] = useState("");
  const [importBusy, setImportBusy] = useState(null);
  const [vrBusy, setVrBusy] = useState(null);         // {done, total} while adding Valdemarsro dinners
  const [vrOpen, setVrOpen] = useState(false);
  const [vrTag, setVrTag] = useState(null);
  const [cookFor, setCookFor] = useState(null);       // name of the meal shown in "Se opskrift"
  const [cookDone, setCookDone] = useState([]);       // ticked steps
  const [cookLoading, setCookLoading] = useState(false);
  const [cookPortions, setCookPortions] = useState(null); // portions from the plan, to scale the ingredients
  const [pantryDraft, setPantryDraft] = useState("");
  const [freezerDraft, setFreezerDraft] = useState({ name: "", portions: 2 });
  const [invHistory, setInvHistory] = useState(init.invHistory || []);
  const [saxoLedger, setSaxoLedger] = useState(init.saxoLedger || null);
  const [showLedger, setShowLedger] = useState(false);
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
  // Holdings list: which change to show (I dag/1U/1M/1Å/Samlet), in % or kr., and the sort order. Per device.
  const [holdView, setHoldViewState] = useState(() => store.json("hold_view") || { per: "Samlet", unit: "pct", sort: "value" });
  const setHoldView = (patch) => setHoldViewState(v => { const n = { ...v, ...patch }; store.set("hold_view", JSON.stringify(n)); return n; });
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
    if (d.subsNames) setSubsNames(d.subsNames);
    if (d.prefs) setPrefs(d.prefs);
    if (d.shop) setShop(d.shop);
    if (d.invHistory) setInvHistory(d.invHistory);
    if (d.saxoLedger) setSaxoLedger(d.saxoLedger);
  };
  const loadData = () => applyData(readStored());

  // Every save is stamped with when it happened, so devices can tell which copy is newest. The first run after
  // loading keeps the stored stamp, and a copy just received from another device keeps that device's stamp.
  const savedAtRef = useRef(init.savedAt || 0), firstSaveRef = useRef(true), remoteAtRef = useRef(null);
  const syncPayload = () => ({version:DATA_VERSION,transactions,budgets,assets,liabilities,holdings,fxRates,cash,rejse,sync,history,rent,subsHidden,subsShare,subsNames,prefs,invHistory,shop,saxoLedger});
  useEffect(() => {
    const at = remoteAtRef.current || (firstSaveRef.current ? savedAtRef.current : Date.now());
    remoteAtRef.current = null; firstSaveRef.current = false; savedAtRef.current = at;
    const ok = store.set(STORAGE_KEY, JSON.stringify({...syncPayload(), savedAt: at}));
    setSaveError(!ok);
  }, [transactions, budgets, assets, liabilities, holdings, fxRates, cash, rejse, sync, history, rent, subsHidden, subsShare, subsNames, prefs, invHistory, shop, saxoLedger]);

  // ---------- sync between devices ----------
  const syncMeta = () => store.json(SYNC_META_KEY) || { at: 0 };
  const dirtyAtLoad = useRef((init.savedAt || 0) > (store.json(SYNC_META_KEY)?.at || 0));
  const syncReady = useRef(false), syncBusy = useRef(false);
  const applyRemote = (d, at) => {
    store.set(SYNC_BACKUP_KEY, store.get(STORAGE_KEY) || "");
    remoteAtRef.current = at;
    applyData(normalizeData(d));
    store.setJson(SYNC_META_KEY, { at });
  };
  const pushSync = async (force = false) => {
    const b = store.json(BRIDGE_KEY);
    if (!b?.secret || syncBusy.current) return;
    syncBusy.current = true;
    try {
      const at = savedAtRef.current || Date.now();
      const sealed = await sealData({...syncPayload(), savedAt: at}, b.secret);
      const r = await callBridge("/sync/put", { ...sealed, at, device: deviceName(), force });
      if (r.ok) { store.setJson(SYNC_META_KEY, { at }); setSyncState({ status: "ok", at: Date.now() }); }
      else if (r.conflict) { syncBusy.current = false; return pullSync(true); }
    } catch (e) { setSyncState(e.code === "no_kv" ? { status: "off" } : { status: "error", msg: e.message }); }
    finally { syncBusy.current = false; }
  };
  // Fetch the shared copy. A newer one replaces this device's data, unless this device has its own unsent
  // changes from before – then the newest wins and the other is kept as a backup.
  const pullSync = async (afterConflict = false) => {
    const b = store.json(BRIDGE_KEY);
    if (!b?.secret || syncBusy.current) return;
    syncBusy.current = true; setSyncState(s => ({ ...s, status: "busy" }));
    try {
      const r = await callBridge("/sync/get", {});
      const meta = syncMeta();
      if (r.empty) { syncReady.current = true; syncBusy.current = false; return pushSync(); }
      if (r.at <= meta.at) {
        syncReady.current = true; setSyncState({ status: "ok", at: Date.now() });
        if (savedAtRef.current > meta.at) { syncBusy.current = false; return pushSync(); }
        return;
      }
      const remote = await openData(r, b.secret);
      if (!meta.at && transactions.length && !afterConflict) { setSyncChoice({ at: r.at, device: r.device, count: (remote.transactions || []).length }); setSyncState({ status: "ok", at: Date.now() }); return; }
      const localNewer = dirtyAtLoad.current && savedAtRef.current > r.at;
      if (localNewer) { syncReady.current = true; syncBusy.current = false; dirtyAtLoad.current = false; return pushSync(true); }
      applyRemote(remote, r.at); dirtyAtLoad.current = false; syncReady.current = true;
      setSyncState({ status: "ok", at: Date.now(), received: r.device || "en anden enhed" });
    } catch (e) {
      setSyncState(e.code === "no_kv" ? { status: "off" } : e instanceof NoBridgeError ? { status: "nobridge" } : { status: "error", msg: e.message });
    } finally { syncBusy.current = false; }
  };
  useEffect(() => {
    pullSync();
    const onVis = () => { if (document.visibilityState === "visible") pullSync(); else if (syncReady.current && savedAtRef.current > syncMeta().at) pushSync(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  // Send changes 15 seconds after the last one (KV allows about 1.000 writes a day on the free plan).
  useEffect(() => {
    if (!syncReady.current || savedAtRef.current <= syncMeta().at) return;
    const t = setTimeout(() => pushSync(), 15000);
    return () => clearTimeout(t);
  }, [transactions, budgets, assets, liabilities, holdings, fxRates, cash, rejse, sync, history, rent, subsHidden, subsShare, subsNames, prefs, invHistory, shop, saxoLedger]);
  const chooseSync = async (useRemote) => {
    const b = store.json(BRIDGE_KEY);
    setSyncChoice(null);
    if (useRemote) {
      const r = await callBridge("/sync/get", {});
      applyRemote(await openData(r, b.secret), r.at); syncReady.current = true; setSyncState({ status: "ok", at: Date.now(), received: r.device });
    } else { syncReady.current = true; savedAtRef.current = Date.now(); await pushSync(true); }
  };

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
  // What was actually put in: Saxo's deposits when we have them. The cost basis of current holdings
  // misses closed trades (and their losses), so it can be off by thousands.
  const invPutIn = saxoLedger?.deposits > 0 ? saxoLedger.deposits : null;
  const invGain = invPutIn != null ? invSecurities + (+cash || 0) - invPutIn : invSecurities - invCost;
  const invBasis = invPutIn ?? invCost;
  // Aktiesparekonto: the Saxo account that looks like one (or the one the user picked), its value and deposits.
  const saxoAccounts = prefs.saxoAccounts || [];
  const askId = prefs.ask?.accountId || saxoAccounts.find(isAskAccount)?.id || null;
  const askHoldings = askId ? holdings.filter(h => h.accountId === askId) : [];
  const askValue = askHoldings.length ? askHoldings.reduce((s, h) => s + holdingValue(h), 0) : null;
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
    // `p`: each holding's price (in its own currency) so the list can show change over a period.
    const px = {}; for (const h of holdings) if (+h.price > 0) px[h.id] = +h.price;
    const p = { d: today, v: Math.round(invValue), c: Math.round(invPutIn ?? (invCost + (+cash || 0))), ...(askValue != null ? { a: Math.round(askValue) } : {}), p: px };
    setInvHistory(h => {
      const last = h[h.length-1];
      if (last && last.d === today) return last.v === p.v && last.c === p.c && last.a === p.a && JSON.stringify(last.p) === JSON.stringify(px) ? h : [...h.slice(0,-1), p];
      return [...h, p].slice(-1500);
    });
  }, [invValue, invCost, invPutIn, askValue, holdings]);

  // ---------- Face ID lock ----------
  const unlock = async () => {
    setLockMsg("");
    try { await verifyLock(lock.credId); setLocked(false); }
    catch (e) { setLockMsg(e?.name === "NotAllowedError" ? "Ikke låst op. Prøv igen." : "Face ID kunne ikke bruges: " + (e.message || e)); }
  };
  useEffect(() => {
    if (!lock.on) return;
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > (lock.after ?? 1) * 60000) setLocked(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [lock.on, lock.after]);
  const setLockOn = async (on) => {
    if (!on) { store.remove(LOCK_KEY); setLock({}); flash("lock", "Låsen er slået fra på denne enhed."); return; }
    try {
      const credId = await createLockCredential();
      const l = { credId, on: true, after: 1 };
      store.setJson(LOCK_KEY, l); setLock(l); flash("lock", "Låsen er slået til. Appen beder om Face ID, når den har været lukket i mere end et minut.");
    } catch (e) { flash("lock", "Fejl: Face ID kunne ikke sættes op (" + (e.message || e.name) + ").", 9000); }
  };
  // Opening the app with ?add=1 (a home-screen shortcut) goes straight to a quick expense.
  useEffect(() => { if (new URLSearchParams(location.search).get("add")) setQuick({ amt: "", cat: "Mad & dagligvarer", note: "", kind: "out" }); }, []);

  // The same bank account added twice (one bank connection per device before IBAN matching): keep the first.
  useEffect(() => {
    const seen = new Set();
    const next = assets.filter(a => { if (a.source !== "bank" || !a.iban) return true; if (seen.has(a.iban)) return false; seen.add(a.iban); return true; });
    if (next.length !== assets.length) setAssets(next);
  }, [assets]);

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
    if (page === "food") shop.items.filter(i => !i.done && !i.snap && !offers[i.id]).forEach(loadOffers);
  }, [page, foodTab, shop.items.length, shop.lat, shop.lng]);

  const subscriptions = subscriptionsRaw.map(x => {
    const pick = subsShare[x.key];
    const share = pick === "none" ? null : pick ? recurringIn.find(i => i.key === pick) || null : guessShare(x, recurringIn);
    const back = share ? Math.min(share.monthly, x.monthly) : 0;
    return { ...x, name: subsNames[x.key] || x.name, share, net: x.monthly - back };
  });
  // Card purchases the guesser now recognises (new grocery chains, Apple, ferries …) leave "Andet" by
  // themselves; a category the user picked is never touched.
  useEffect(() => {
    let n = 0;
    const next = transactions.map(t => {
      // Wolt counts as food (the user's choice), also for purchases already filed under Café.
      const wolt = t.category === "Restaurant & café" && /wolt/i.test(t.description || "");
      if ((t.category !== "Andet" && !wolt) || t.manualCategory) return t;
      const g = guessCategory(t.description);
      if (g === "Andet" || INCOME_CATS.includes(g) || (g === "Intern overførsel")) return t;
      n++; return {...t, category: g};
    });
    if (n) setTransactions(next);
  }, [transactions.length]);
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
      // Each device has its own bank connection, and each connection gives the account a new uid – so the
      // same account (same IBAN) is matched on the IBAN too, and keeps the id it already has.
      const i = nextAssets.findIndex(a => a.id === id || (meta.iban && a.source === "bank" && a.iban === meta.iban));
      const entry = { id: i >= 0 ? nextAssets[i].id : id, name: i >= 0 ? nextAssets[i].name : name, value: Math.round(acc.balance * 100) / 100, source: "bank", iban: meta.iban || null };
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

  const applySaxoPortfolio = (p, day) => {
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
      shares: x.amount, avgCost: x.avgPrice, price: x.price, type: x.assetType || null, source: "saxo", accountId: x.accountId || null,
      ...(day && day[x.id] != null ? { dayPct: day[x.id], dayAt: isoDate(new Date()) } : {}),
    }));
    setHoldings([...fromSaxo, ...keep]);
    if (p.accounts?.length) setPrefs(pr => ({ ...pr, saxoAccounts: p.accounts }));
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
    const day = await fetchSaxoDay(t.access).catch(() => null);
    const r = applySaxoPortfolio(p, day);
    try { setSaxoLedger(await fetchSaxoLedger(t.access)); } catch {}
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
    const data = {version:DATA_VERSION,transactions,budgets,assets,liabilities,holdings,fxRates,cash,rejse,sync,history,rent,subsHidden,subsShare,subsNames,prefs,invHistory,shop,saxoLedger,exported:new Date().toISOString()};
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
  const goSub = (id) => { setPage("more"); setSub(id); scrollToTop(); };
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
        ${t.amount < 0 && (shareFor === t.id ? SharedForm(t) : html`<button className="btn soft" onClick=${()=>{ setShareFor(t.id); setShareDraft({ who: "", desc: prettyName(t.description), amt: String(Math.abs(t.amount)), paidBy: "me", split: "half" }); }}>Del med en ven</button>`)}
        <${Msg} k="tx" />
        <div className="btns"><button className="btn danger" onClick=${()=>deleteTx(t.id)}><${Icon} name="trash" /> Slet</button><button className="btn" onClick=${()=>setOpenTx(null)}>Luk</button></div>
      </div>`}
    </div>`;
  };

  // ================= pages =================

  // Startside: where the app opens – pick where to go instead of landing on the net worth.
  const StartPage = () => {
    const ym = currentBudgetMonth(), st = monthStats(ym), left = totalBudget - st.exp, pay = nextPayday();
    const go = (pg, sb = null) => { setPage(pg); setSub(sb); scrollToTop(); };
    const now = new Date(), today = isoDate(now), tomorrow = addDays(today, 1);
    const hour = now.getHours();
    const dateText = `${WEEKDAYS[now.getDay()]} ${now.getDate()}. ${MONTHS_DA[now.getMonth()]}`;
    // Budget month runs from the last payday to the next; the tempo mark shows how much "should" be spent by now.
    const prevPay = paydayIn(pay.date.getFullYear(), pay.date.getMonth() - 1);
    const monthDays = Math.max(1, Math.round((pay.date - prevPay) / 86400e3));
    const elapsed = Math.min(1, Math.max(0, (monthDays - pay.days) / monthDays));
    const used = totalBudget > 0 ? Math.min(1, st.exp / totalBudget) : 0;
    const perDay = left / Math.max(1, pay.days);
    const onTrack = used <= elapsed + 0.03;
    const foodLeft = (+budgets["Mad & dagligvarer"] || 0) - (st.byCat["Mad & dagligvarer"] || 0);
    const owed = sharedPeople.map(w => [w, owedBy(w)]).filter(([, v]) => Math.abs(v) >= 1);
    const fresh = holdings.filter(h => h.dayPct != null && h.dayAt >= addDays(today, -3));
    const dayKr = fresh.reduce((s, h) => { const v = holdingValue(h); return s + v - v / (1 + h.dayPct / 100); }, 0);

    // Today: calendar, dinner and training in one list.
    const todayMeal = shop.plan?.meals?.find((m, i) => mealState(i) === "now" && !m.done);
    const away = awayFor(today);
    const session = sessionFor(training, today), trained = training.log?.[today];
    const evs = (calCache?.events || []).filter(e => e.end > today && e.start < addDays(today, 2));
    const agenda = [];
    for (const e of evs) agenda.push({ when: e.start.slice(0, 10) <= today ? "I dag" : "I morgen", time: e.allDay ? "" : e.start.slice(11, 16), title: e.title, sort: (e.start.slice(0, 10) <= today ? "0" : "2") + (e.allDay ? "00:00" : e.start.slice(11, 16)) });
    const todayList = agenda.filter(a => a.when === "I dag"), tomorrowList = agenda.filter(a => a.when === "I morgen");

    // Coming money events in the next 10 days: payday, rent and expected subscription charges.
    const upcoming = [];
    const within = (d) => d >= today && d <= addDays(today, 10);
    if (within(isoDate(pay.date))) upcoming.push({ d: isoDate(pay.date), icon: "coins", color: "#1D9E75", title: "Løn og SU", amount: null });
    const rentDay = monthEnd(today.slice(0, 7));
    if (rent?.amount && within(rentDay)) upcoming.push({ d: rentDay, icon: "home", color: "#378ADD", title: "Husleje", amount: -rent.amount });
    for (const s of subscriptions) {
      const [y, m, d] = s.last.split("-").map(Number);
      let next = isoDate(new Date(y, m, Math.min(d, 28)));
      if (next < today) next = isoDate(new Date(y, m + 1, Math.min(d, 28)));
      if (within(next)) upcoming.push({ d: next, icon: "repeat", color: "#534AB7", title: s.name, amount: -s.net });
    }
    upcoming.sort((a, b) => a.d.localeCompare(b.d));
    const dayLabel = (d) => d === today ? "I dag" : d === tomorrow ? "I morgen" : `${WEEKDAYS[new Date(d + "T12:00").getDay()].slice(0, 3)} ${+d.slice(8)}/${+d.slice(5, 7)}`;

    // Things that need a tap.
    const todo = [];
    if (syncChoice) todo.push({ icon: "refresh", text: "Der er data fra en anden enhed – vælg hvilke", on: () => go("home") });
    if (ebSession?.status && ebSession.status !== "AUTHORIZED") todo.push({ icon: "bank", text: "Adgangen til banken skal fornyes", on: startBankLink });
    if (saxoNeedsLogin && store.json(BRIDGE_KEY)) todo.push({ icon: "trend", text: "Log ind på Saxo for at opdatere depotet", on: startSaxoLogin });
    if (planEnded) todo.push({ icon: "food", text: "Madplanen er slut – lav en ny", on: () => { go("food"); setFoodTab("plan"); } });
    else if (foodBadge) todo.push({ icon: "cart", text: "Nye tilbudsaviser", on: () => { go("food"); setFoodTab("plan"); } });
    for (const [w, v] of owed) if (v > 0) todo.push({ icon: "arrows", text: `${w} skylder dig ${fmt(v)}`, on: () => go("more", "shared") });

    const row = (icon, color, body, onClick, end = null, key) => html`<button key=${key} className="dash-row" onClick=${onClick}>
      <div className="sq sm" style=${{background: color + "2e", color: tint(color, 0.45)}}><${Icon} name=${icon} /></div>
      <div className="grow">${body}</div>${end}</button>`;
    const shortcut = (icon, color, label, onClick) => html`<button key=${label} className="dash-short" onClick=${onClick}>
      <div className="si" style=${{background: color + "2e", color: tint(color, 0.45)}}><${Icon} name=${icon} /></div><span>${label}</span></button>`;

    return html`<div className="dash">
      <div className="small muted" style=${{padding:"2px 2px 10px"}}>${dateText}</div>

      <button className="hero dash-hero" onClick=${()=>go("budget")}>
        <div className="label">Tilbage at bruge</div>
        <div className="big"><${CountUp} value=${Math.round(left)} /></div>
        <div className="dash-bar"><div className="fill" style=${{width: `${used * 100}%`}}></div><div className="mark" style=${{left: `${elapsed * 100}%`}}></div></div>
        <div className="hero-row">
          <span className=${"chip " + (onTrack ? "up" : "down")}>${onTrack ? "På sporet" : "Over tempo"}</span>
          <span className="hm">${left > 0 ? `${fmt(perDay)} pr. dag · ` : ""}løn ${pay.days === 0 ? "i dag" : pay.days === 1 ? "i morgen" : `om ${pay.days} dage`}</span>
        </div>
      </button>

      <div className="dash-stats">
        <button onClick=${()=>go("food")}><span className="k">Mad</span><span className=${"v " + (foodLeft < 0 ? "neg" : "")}>${fmt(foodLeft)}</span><span className="s">tilbage</span></button>
        <button onClick=${()=>go("invest")}><span className="k">Depot</span><span className="v">${fmtShort(invValue)}</span><span className=${"s " + (fresh.length ? (dayKr >= 0 ? "pos" : "neg") : "")}>${fresh.length ? `${dayKr >= 0 ? "+" : ""}${fmtShort(dayKr)} i dag` : "kr."}</span></button>
        <button onClick=${()=>go("home")}><span className="k">Formue</span><span className="v">${fmtShort(netWorth)}</span><span className="s">kr.</span></button>
      </div>

      ${todo.length > 0 && html`<div className="section"><div className="list">${todo.map((t, i) => row(t.icon, "#EF9F27", t.text, t.on, html`<${Icon} name="chevron" />`, "t" + i))}</div></div>`}

      <div className="section">
        <div className="section-head"><h2>I dag</h2></div>
        <div className="list">
          ${row("food", "#D85A30", away.away
              ? html`<div className="title">Du laver ikke mad</div><div className="sub">${away.reason && away.reason !== "markeret" ? away.reason : "Markeret i madplanen"}</div>`
              : todayMeal ? html`<div className="title">${todayMeal.name}</div><div className="sub">Aftensmad · tryk for madplanen</div>`
              : html`<div className="title">Ingen ret planlagt</div><div className="sub">Lav en madplan</div>`,
            () => { go("food"); setFoodTab("plan"); }, null, "meal")}
          ${row("heart", "#1D9E75", html`<div className="title">${session ? session : "Hviledag"}</div><div className="sub">Træning · ${weekProgress(training).done}/${weekProgress(training).target} denne uge</div>`,
            () => go("more", "training"),
            session ? html`<span className=${"chip " + (trained ? "up" : "")} onClick=${e=>{ e.stopPropagation(); setTraining(t => { const log = { ...(t.log || {}) }; if (log[today]) delete log[today]; else log[today] = session; return { log }; }); }}>${trained ? "✓ Trænet" : "Marker"}</span>` : null, "gym")}
          ${todayList.map((a, i) => row("sun", "#378ADD", html`<div className="title">${a.title}</div><div className="sub">${a.time || "Hele dagen"}</div>`, () => go("more", "calendar"), null, "e" + i))}
        </div>
        ${tomorrowList.length > 0 && html`<div className="small muted" style=${{margin:"8px 4px 0"}}>I morgen: ${tomorrowList.slice(0, 3).map(a => `${a.time ? a.time + " " : ""}${a.title}`).join(" · ")}</div>`}
      </div>

      ${upcoming.length > 0 && html`<div className="section">
        <div className="section-head"><h2>Næste 10 dage</h2></div>
        <div className="list">${upcoming.slice(0, 6).map((u, i) => row(u.icon, u.color,
          html`<div className="title">${u.title}</div><div className="sub">${dayLabel(u.d)}</div>`,
          () => u.icon === "repeat" ? go("more", "subs") : go("budget"),
          u.amount != null ? html`<div className="num">${fmt(u.amount)}</div>` : null, "u" + i))}</div>
      </div>`}

      <div className="section">
        <div className="section-head"><h2>Genveje</h2></div>
        <div className="dash-shorts">
          ${shortcut("list", "#7F77DD", "Poster", () => go("tx"))}
          ${shortcut("donut", "#639922", "Budget", () => go("budget"))}
          ${shortcut("plane", "#EF9F27", "Rejser", () => go("more", "trips"))}
          ${shortcut("repeat", "#534AB7", "Abonnem.", () => go("more", "subs"))}
          ${shortcut("arrows", "#D4537E", "Delte", () => go("more", "shared"))}
          ${shortcut("donut", "#185FA5", "Rapport", () => { setReportMonth(null); go("more", "report"); })}
          ${shortcut("school", "#3B8A6E", "SU", () => go("more", "su"))}
          ${shortcut("dots", "#888780", "Mere", () => go("more"))}
        </div>
      </div>
    </div>`;
  };

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
        <button className="tile" style=${{textAlign:"left", font:"inherit", color:"inherit", cursor:"pointer"}} aria-expanded=${affordOpen} onClick=${()=>setAffordOpen(!affordOpen)}>
          <div className="label">${left >= 0 ? "Tilbage at bruge" : "Over budget"}</div>
          <div className=${"value " + (left >= 0 ? "pos" : "neg")}><${CountUp} value=${Math.round(Math.abs(left))} /></div>
          <div className="foot">${left >= 0 ? `${fmt(perDay)} pr. dag til lønnen` : `i ${MONTHS_DA[+ym.slice(5)-1]}`}</div>
          <div className="foot" style=${{color:"var(--accent)", marginTop:4}}>Har jeg råd? ›</div>
        </button>
      </div>
      ${affordOpen && (() => {
        const amt = parseFloat((affordAmt || "").replace(/\./g, "").replace(",", ".")) || 0, after = left - amt, days = Math.max(1, pay.days);
        return html`<div className="card stack" style=${{marginTop:10}}>
          <form style=${{display:"flex", gap:8}} onSubmit=${e=>e.preventDefault()}>
            <input className="input" style=${{flex:1}} type="text" inputMode="decimal" autoFocus value=${affordAmt} onChange=${e=>setAffordAmt(e.target.value)} placeholder="Hvad koster det? fx 800" aria-label="Beløb" />
            <button className="btn soft" type="button" onClick=${()=>{ setAffordOpen(false); setAffordAmt(""); }}>Luk</button>
          </form>
          ${amt > 0 && html`<div style=${{fontSize:15}} className=${after < 0 ? "neg" : ""}>${after >= 0
            ? html`<b className="pos">Ja.</b> Så har du ${fmt(after)} tilbage – <b>${fmt(after / days)} pr. dag</b> i ${days} dage til lønnen (i stedet for ${fmt(perDay)}).`
            : html`<b>Det går over budgettet</b> med ${fmt(-after)}. Du skal spare ${fmt(-after / days)} pr. dag frem til lønnen, eller vente til efter lønningsdagen (om ${pay.days} dage).`}</div>`}
          <div className="small faint">Regnet ud fra dit samlede budget for ${MONTHS_DA[+ym.slice(5)-1]}, minus det du allerede har brugt.</div>
        </div>`; })()}

      ${syncChoice && html`<div className="card stack" style=${{marginTop:12, borderLeft:"3px solid var(--accent)"}}>
        <div><b>Der er data fra en anden enhed</b> (${syncChoice.device || "ukendt"}, gemt ${new Date(syncChoice.at).toLocaleString("da-DK", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })}, ${syncChoice.count} poster). Denne enhed har ${transactions.length} poster. Hvilke skal begge enheder bruge?</div>
        <div className="btns"><button className="btn primary" onClick=${()=>chooseSync(true)}>Brug den anden enheds data</button><button className="btn" onClick=${()=>chooseSync(false)}>Brug denne enheds data</button></div>
        <div className="small faint">Det, du ikke vælger, gemmes som en backup på denne enhed.</div>
      </div>`}
      ${(() => { const d = new Date(), lastPay = paydayIn(d.getFullYear(), d.getMonth()) <= d ? paydayIn(d.getFullYear(), d.getMonth()) : paydayIn(d.getMonth() ? d.getFullYear() : d.getFullYear() - 1, (d.getMonth() + 11) % 12);
        const since = Math.floor((d - lastPay) / 864e5); const rm = prevMonth(currentBudgetMonth());
        return since >= 0 && since <= 5 && monthStats(rm).count > 0 && html`<button className="tip tap" style=${{width:"100%", textAlign:"left", font:"inherit", color:"inherit"}} onClick=${()=>{ setReportMonth(rm); setPage("more"); setSub("report"); scrollToTop(); }}>
          <div className="sq sm" style=${{background:"var(--accent-bg)", color:"var(--accent)"}}><${Icon} name="donut" /></div>
          <div>Din rapport for <b>${monthName(rm).toLowerCase()}</b> er klar. Tryk for at se, hvordan måneden gik.</div></button>`; })()}
      ${subscriptions.filter(x => x.rose && x.rose.date >= addDays(isoDate(new Date()), -45)).map(x => html`<div key=${x.key} className="tip">
        <div className="sq sm" style=${{background:"var(--neg-bg)", color:"var(--neg)"}}><${Icon} name="alert" /></div>
        <div><b>${x.name}</b> er steget fra ${fmt(x.rose.from)} til ${fmt(x.rose.to)} om måneden (${fmt((x.rose.to - x.rose.from) * 12)} mere om året).</div>
      </div>`)}
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

  // Aktiesparekonto and tax: how much of the cap is used, and roughly what this year's gain costs in tax.
  const AskBlock = () => {
    const year = new Date().getFullYear(), cap = ASK_CAP[year] || ASK_CAP[Math.max(...Object.keys(ASK_CAP).map(Number))];
    const ask = prefs.ask || {}, setAsk = (patch) => setPrefs(pr => ({ ...pr, ask: { ...(pr.ask || {}), ...patch } }));
    const rows = (saxoLedger?.rows || []).filter(r => r.type === "Cash Amount" && askId && r.accountId === askId);
    const ledgerKnows = rows.length > 0;
    const deposits = ledgerKnows ? rows.reduce((s, r) => s + r.amount, 0) : (+ask.deposits || null);
    const depYear = ledgerKnows ? rows.filter(r => r.date >= `${year}-01-01`).reduce((s, r) => s + r.amount, 0) : null;
    const firstDeposit = ledgerKnows ? rows.map(r => r.date).sort()[0] : null;
    const hist = invHistory.filter(x => x.a != null && x.d < `${year}-01-01`).pop();
    const jan1 = ask.jan1 != null && ask.jan1 !== "" ? +ask.jan1 : hist ? hist.a : firstDeposit && firstDeposit >= `${year}-01-01` ? 0 : null;
    const gain = askValue != null && jan1 != null && depYear != null ? askValue - jan1 - depYear : null;
    const other = invValue - (askValue || 0);
    if (!holdings.length) return null;
    return html`<div className="section">
      <div className="section-head"><h2>Aktiesparekonto og skat</h2></div>
      <div className="card stack">
        ${!saxoAccounts.length ? html`<div className="small muted">Synkronisér Saxo (log ind under Invest.), så kan appen se, hvilke beholdninger der ligger på din aktiesparekonto.</div>` : html`
          ${!saxoAccounts.some(isAskAccount) && html`<label className="field">Hvilken konto er din aktiesparekonto?<select className="input" value=${askId || ""} onChange=${e=>setAsk({ accountId: e.target.value || null })}>
            <option value="">Vælg konto</option>${saxoAccounts.map(a => html`<option key=${a.id} value=${a.id}>${a.name}${a.subType ? ` (${a.subType})` : ""}</option>`)}</select></label>`}
          ${askId && html`<div>
            <div style=${{display:"flex", justifyContent:"space-between", gap:12}}><span className="small muted">Værdi på aktiesparekontoen</span><b className="num">${askValue != null ? fmt(askValue) : "–"}</b></div>
            ${deposits != null && html`<div style=${{marginTop:10}}>
              <div style=${{display:"flex", justifyContent:"space-between", gap:12}} className="small"><span>Indbetalt ${fmt(deposits)} af loftet ${fmt(cap)}</span><span className=${deposits >= cap ? "pos" : ""}>${deposits >= cap ? "Fuldt indbetalt" : `${fmt(cap - deposits)} tilbage`}</span></div>
              <div className="bar" style=${{height:6}}><div style=${{width:`${Math.min(100, deposits / cap * 100)}%`, background:"var(--accent)"}}></div></div>
            </div>`}
            ${gain != null ? html`<div className="small" style=${{marginTop:10}}>Afkast i ${year} indtil nu: <b className=${gain >= 0 ? "pos" : "neg"}>${gain >= 0 ? "+" : ""}${fmt(gain)}</b> → skat ca. <b>${fmt(Math.max(0, gain * ASK_TAX))}</b> (17 %).${gain < 0 ? " Et tab kan modregnes i senere års gevinst på kontoen." : ""}</div>`
              : html`<div className="small muted" style=${{marginTop:10}}>For at beregne skatten mangler appen værdien 1. januar ${year}${deposits == null ? " og hvor meget du har indbetalt" : ""}.</div>`}
            ${(!ledgerKnows || (jan1 == null && !hist)) && html`<div style=${{display:"flex", gap:8, flexWrap:"wrap", marginTop:8}}>
              ${!ledgerKnows && html`<label className="field" style=${{flex:1, minWidth:140}}>Indbetalt i alt (kr.)<input className="input privacy" type="number" inputMode="decimal" value=${ask.deposits ?? ""} onChange=${e=>setAsk({ deposits: e.target.value })} /></label>`}
              <label className="field" style=${{flex:1, minWidth:140}}>Værdi 1. januar (kr.)<input className="input privacy" type="number" inputMode="decimal" value=${ask.jan1 ?? ""} placeholder=${jan1 != null ? String(Math.round(jan1)) : ""} onChange=${e=>setAsk({ jan1: e.target.value })} /></label>
            </div>`}
          </div>`}
        `}
        <div className="small faint">Aktiesparekontoen lagerbeskattes med 17 % af årets værdistigning, også selvom du ikke sælger. Skatten trækkes normalt automatisk fra kontoen i starten af næste år. Loftet for ${year} er ${fmt(cap)} (skat.dk).</div>
        ${other > 0 && html`<div className="small faint">Resten af depotet (ca. ${fmt(other)}) beskattes som aktieindkomst: 27 % op til progressionsgrænsen og 42 % derover. Aktier beskattes, når du sælger. Nogle ETF'er beskattes hvert år af værdistigningen – se SKAT's liste over aktiebaserede investeringsselskaber. Beløbene er skøn, ikke rådgivning.</div>`}
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
    // Change for one holding over the chosen period: { pct, kr } or null when there's nothing to compare with.
    const today = isoDate(new Date());
    const priceThen = (h, maxDate) => { for (let i = invHistory.length - 1; i >= 0; i--) { const x = invHistory[i]; if (x.d <= maxDate && x.p?.[h.id] > 0) return x.p[h.id]; } return null; };
    const change = (h, per) => {
      const val = holdingValue(h);
      if (per === "Samlet") { const cost = holdingCost(h); return cost > 0 ? { pct: (val - cost) / cost * 100, kr: val - cost } : null; }
      let pct = null;
      if (per === "I dag" && h.dayPct != null && h.dayAt >= addDays(today, -3)) pct = h.dayPct;
      else {
        const then = priceThen(h, per === "I dag" ? addDays(today, -1) : addDays(today, -HOLD_PERIODS[per]));
        if (then) pct = ((+h.price || 0) / then - 1) * 100;
      }
      return pct == null ? null : { pct, kr: val - val / (1 + pct / 100) };
    };
    const per = holdView.per;
    const changes = Object.fromEntries(holdings.map(h => [h.id, change(h, per)]));
    const withChg = holdings.filter(h => changes[h.id]);
    const totKr = withChg.reduce((s, h) => s + changes[h.id].kr, 0);
    const totBase = withChg.reduce((s, h) => s + holdingValue(h), 0) - totKr;
    const day = holdings.map(h => change(h, "I dag")).filter(Boolean);
    const dayKr = day.reduce((s, c) => s + c.kr, 0);
    const holdTotal = holdings.reduce((s, h) => s + holdingValue(h), 0);
    const sorted = holdings.slice().sort(holdView.sort === "change"
      ? (a, b) => (changes[b.id]?.pct ?? -1e9) - (changes[a.id]?.pct ?? -1e9)
      : (a, b) => holdingValue(b) - holdingValue(a));
    const chgText = (c) => holdView.unit === "kr" ? `${c.kr >= 0 ? "+" : ""}${fmt(c.kr)}` : pctf(c.pct);
    return html`<div>
      <div className="hero invest">
        <div className="label">${sync.saxo ? "Depot hos Saxo" : "Depotværdi"}</div>
        <div className="big"><${CountUp} value=${Math.round(invValue)} /></div>
        <div className="hero-row">
          ${invBasis > 0 && html`<span className=${"chip " + (invGain >= 0 ? "up" : "down")}>${pctf(invGain/invBasis*100)}</span>`}
          <span className="hm">${invGain >= 0 ? "+" : ""}${fmt(invGain)} i alt${invPutIn != null ? ` · indsat ${fmt(invPutIn)}` : ""}</span>
        </div>
        ${day.length > 0 && html`<div className="hero-row" style=${{marginTop:6}}>
          <span className=${"chip " + (dayKr >= 0 ? "up" : "down")}>I dag ${dayKr >= 0 ? "+" : ""}${fmt(dayKr)}</span>
        </div>`}
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
              <span className="muted"><span style=${{display:"inline-block",width:14,borderTop:"2px dashed var(--text-2)",verticalAlign:"middle",marginRight:6}}></span>${invPutIn != null ? "Indsat" : "Indskudt"} ${fmt(invPutIn ?? (invCost + (+cash || 0)))}</span>
              ${ret != null && html`<span>Afkast i perioden <b className=${ret >= 0 ? "pos" : "neg"}>${ret >= 0 ? "+" : ""}${fmt(ret)}</b></span>`}
            </div>
          </div>
        </div>`;
      })()}

      ${saxoLedger && html`<div className="section">
        <div className="section-head"><h2>Indbetalinger og handler</h2><span className="small faint">fra Saxo ${shortDate(saxoLedger.fetched.slice(0, 10))}</span></div>
        <div className="card stack" style=${{gap:4}}>
          ${kv("Indsat", fmt(saxoLedger.deposits))}
          ${kv("Købt og solgt for", fmt(saxoLedger.trades))}
          ${kv("Kurtage", fmt(saxoLedger.commission))}
          ${saxoLedger.dividends !== 0 && kv("Udbytte", fmt(saxoLedger.dividends), "pos")}
          ${saxoLedger.tax !== 0 && kv("Udbytteskat", fmt(saxoLedger.tax))}
          ${saxoLedger.interest !== 0 && kv("Renter", fmt(saxoLedger.interest))}
          <div style=${{borderTop:"0.5px solid var(--border)", margin:"4px 0"}}></div>
          ${kv("Afkast (værdi nu − indsat)", `${invGain >= 0 ? "+" : ""}${fmt(invGain)}`, invGain >= 0 ? "pos" : "neg")}
          <button className="link-btn small" style=${{alignSelf:"flex-start", marginTop:6}} onClick=${()=>setShowLedger(!showLedger)}>${showLedger ? "Skjul" : `Se alle ${saxoLedger.rows.length} posteringer`}</button>
        </div>
        ${showLedger && html`<div className="list" style=${{marginTop:8}}>${saxoLedger.rows.map((x, i) => html`<div key=${i} className="row" style=${{minHeight:46}}>
          <div className="main"><div className="title">${x.label}${x.name ? ` · ${x.name}` : ""}</div><div className="sub">${shortDate(x.date)} ${x.date.slice(0, 4)}</div></div>
          <div className=${"end " + amountClass(x.amount)}>${fmt(x.amount)}</div>
        </div>`)}</div>`}
      </div>`}

      ${AskBlock()}
      <div className="section">
        <div className="section-head"><h2>Beholdninger</h2><button className="link-btn" onClick=${()=>{ const h = {id:uid(),name:"Ny beholdning",ticker:"",currency:"DKK",shares:0,avgCost:0,price:0}; setHoldings([...holdings, h]); setOpenHolding(h.id); }}>+ Manuel</button></div>
        ${holdings.length > 0 && html`<div className="hold-bar">
          <div className="ranges plain">${Object.keys(HOLD_PERIODS).concat("Samlet").map(r => html`<button key=${r} className=${per === r ? "on" : ""} onClick=${()=>setHoldView({ per: r })}>${r}</button>`)}</div>
          <div className="hold-tools">
            <button className="link-btn small" onClick=${()=>setHoldView({ unit: holdView.unit === "kr" ? "pct" : "kr" })}>${holdView.unit === "kr" ? "Vis %" : "Vis kr."}</button>
            <button className="link-btn small" onClick=${()=>setHoldView({ sort: holdView.sort === "change" ? "value" : "change" })}>Sortér: ${holdView.sort === "change" ? "ændring" : "værdi"}</button>
          </div>
        </div>
        <div className="small muted" style=${{margin:"-2px 2px 8px"}}>${withChg.length
          ? html`${per === "Samlet" ? "Gevinst i alt" : per === "I dag" ? "I dag" : `Seneste ${per.toLowerCase()}`}: <b className=${totKr >= 0 ? "pos" : "neg"}>${totKr >= 0 ? "+" : ""}${fmt(totKr)}${totBase > 0 ? ` (${pctf(totKr / totBase * 100)})` : ""}</b>${withChg.length < holdings.length ? ` · ${holdings.length - withChg.length} uden data` : ""}`
          : per === "I dag" ? "Ingen dagsændring endnu – tryk Opdater ved Saxo." : `Appen gemmer kurserne én gang om dagen, så ${per} kan vises, når der er gået ${per === "1U" ? "en uge" : per === "1M" ? "en måned" : "et år"}.`}</div>`}
        ${holdings.length === 0 ? html`<div className="card empty">Ingen beholdninger. Forbind Saxo, eller tilføj manuelt.</div>` : html`
          <div className="list stagger">
            ${sorted.map((h, i) => {
              const cur = h.currency || "DKK";
              const val = holdingValue(h), cost = holdingCost(h);
              const c = changes[h.id];
              const open = openHolding === h.id;
              const color = TYPE_COLOR[holdingType(h)] || TYPE_COLOR.Andet;
              const setH = (patch) => setHoldings(holdings.map(x=>x.id===h.id?{...x,...patch}:x));
              return html`<div key=${h.id} style=${stag(i)}>
                <button className="row" onClick=${()=>setOpenHolding(open ? null : h.id)}>
                  ${badge((h.ticker || h.name || "?").replace(/[^A-Za-z0-9ÆØÅæøå]/g,"").slice(0,3).toUpperCase(), color + "33", tint(color, 0.35))}
                  <div className="main"><div className="title">${h.name}</div><div className="sub">${numf(+h.shares||0)} stk. · ${numf(+h.price||0)} ${cur}${holdTotal > 0 ? ` · ${Math.round(val / holdTotal * 100)} %` : ""}</div></div>
                  <div className="end"><div className="num">${fmt(val)}</div>${c ? html`<div className=${"num small " + (c.pct >= 0 ? "pos" : "neg")}>${chgText(c)}</div>` : html`<div className="num small faint">–</div>`}</div>
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
    <div className="small muted" style=${{margin:"12px 2px"}}>Fundet ud fra poster, der kommer ca. én gang om måneden med næsten samme beløb. Får du fast penge tilbage fra andre, trækkes de fra. Husleje, opsparing og rejser er ikke med.${subscriptions.some(x => /apple/i.test(x.raw || "")) ? " Apple trækker hvert abonnement for sig – se hvilke under Indstillinger → dit navn → Abonnementer på iPhone, og tryk Omdøb." : ""}</div>
    ${subscriptions.length === 0
      ? html`<div className="card empty">Ingen faste træk fundet endnu. Der skal være poster fra mindst 2–3 måneder.</div>`
      : html`<div className="list stagger">${subscriptions.map((x, i) => html`<div key=${x.key} className="row" style=${{...stag(i), alignItems:"flex-start", flexWrap:"wrap"}}>
          <${CatIcon} cat=${x.category} />
          <div className="main">
            ${renameSub === x.key
              ? html`<form style=${{display:"flex", gap:6}} onSubmit=${e=>{ e.preventDefault(); const v = e.target.elements.n.value.trim(); setSubsNames(m => { const o = {...m}; if (v) o[x.key] = v; else delete o[x.key]; return o; }); setRenameSub(null); }}>
                  <input name="n" className="input sm" style=${{flex:1}} defaultValue=${subsNames[x.key] || ""} placeholder="Fx iCloud+" aria-label="Navn på abonnementet" autoFocus />
                  <button className="btn soft" type="submit">Gem</button></form>`
              : html`<div className="title">${x.name} <button className="link-btn small" onClick=${()=>setRenameSub(x.key)}>Omdøb</button></div>`}
            ${x.rose && html`<div className="small neg" style=${{marginTop:2}}>Steget fra ${fmt(x.rose.from)} til ${fmt(x.rose.to)} (${shortDate(x.rose.date)})</div>`}
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

  // ---------- Månedsrapport ----------
  const ReportPage = () => {
    const ym = reportMonth || prevMonth(currentBudgetMonth()), pm = prevMonth(ym);
    const st = monthStats(ym), pv = monthStats(pm), cur = currentBudgetMonth();
    const save = st.inc - st.exp, saveP = pv.inc - pv.exp;
    const delta = (a, b, invert) => { const d = a - b; if (!b || Math.abs(d) < 1) return null; const good = invert ? d < 0 : d > 0;
      return html`<span className=${"small " + (good ? "pos" : "neg")}>${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}</span>`; };
    const cats = budgetCats.map(c => ({ c, v: st.byCat[c] || 0, p: pv.byCat[c] || 0, b: +budgets[c] || 0 })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
    const big = transactions.filter(t => t.amount < 0 && !t.trip && !EXCLUDED.includes(t.category) && budgetMonth(t.date, t.amount, t.category) === ym)
      .sort((a, b) => a.amount - b.amount).slice(0, 5);
    const food = cats.find(x => x.c === "Mad & dagligvarer");
    const over = cats.filter(x => x.b > 0 && x.v > x.b);
    const name = monthName(ym), pname = monthName(pm).toLowerCase();
    return html`<div>
      <div style=${{display:"flex", alignItems:"center", gap:10, marginBottom:12}}>
        <button className="icon-btn" aria-label="Forrige måned" onClick=${()=>setReportMonth(pm)}>‹</button>
        <div style=${{flex:1, textAlign:"center", fontWeight:650, fontSize:18}}>${monthLabel(ym)}</div>
        <button className="icon-btn" aria-label="Næste måned" disabled=${ym >= cur} onClick=${()=>setReportMonth(addMonths(ym, 1))}>›</button>
      </div>
      <div className="card" style=${{fontSize:15, lineHeight:1.55}}>
        I ${name.toLowerCase()} brugte du <b>${fmt(st.exp)}</b>${pv.exp ? html` – ${st.exp <= pv.exp ? html`<b className="pos">${fmt(pv.exp - st.exp)} mindre</b>` : html`<b className="neg">${fmt(st.exp - pv.exp)} mere</b>`} end i ${pname}` : ""}.
        ${st.inc > 0 && html` Du fik <b>${fmt(st.inc)}</b> ind, så du ${save >= 0 ? html`havde <b className="pos">${fmt(save)}</b> til overs` : html`brugte <b className="neg">${fmt(-save)}</b> mere end du tjente`}.`}
        ${food && food.b > 0 && html` Madbudgettet ${food.v <= food.b ? html`holdt med <b className="pos">${fmt(food.b - food.v)}</b> til overs` : html`blev overskredet med <b className="neg">${fmt(food.v - food.b)}</b>`}.`}
        ${over.length > 0 && html` Over budget: ${over.map(x => x.c.toLowerCase()).join(", ")}.`}
      </div>
      <div className="stats" style=${{marginTop:12}}>
        <div className="stat"><div className="label">Indkomst</div><div className="value pos">${fmt(st.inc)}</div>${delta(st.inc, pv.inc)}</div>
        <div className="stat"><div className="label">Udgifter</div><div className="value">${fmt(st.exp)}</div>${delta(st.exp, pv.exp, true)}</div>
        <div className="stat"><div className="label">Overskud</div><div className=${"value " + (save >= 0 ? "pos" : "neg")}>${fmt(save)}</div>${delta(save, saveP)}</div>
      </div>
      <div className="section">
        <div className="section-head"><h2>Kategorier</h2><span className="small faint">mod ${pname}</span></div>
        <div className="list">${cats.map(x => html`<div key=${x.c} className="row" style=${{minHeight:50}}>
          <${CatIcon} cat=${x.c} small />
          <div className="main"><div className="title">${x.c}</div>${x.b > 0 && html`<div className="bar" style=${{height:4, marginTop:5}}><div style=${{width:`${Math.min(100, x.v / x.b * 100)}%`, background: x.v > x.b ? "var(--neg)" : CAT_COLORS[x.c]}}></div></div>`}</div>
          <div className="end"><div className="num">${fmt(x.v)}</div>${delta(x.v, x.p, true)}</div>
        </div>`)}</div>
      </div>
      ${big.length > 0 && html`<div className="section">
        <div className="section-head"><h2>Største udgifter</h2></div>
        <div className="list">${big.map(t => html`<div key=${t.id} className="row" style=${{minHeight:46}}>
          <div className="main"><div className="title">${prettyName(t.description)}</div><div className="sub">${shortDate(t.date)} · ${t.category}</div></div>
          <div className="end num">${fmt(t.amount)}</div>
        </div>`)}</div>
      </div>`}
      <div className="small faint" style=${{marginTop:12}}>Faste abonnementer koster dig ca. ${fmt(subsMonthly)} om måneden.</div>
    </div>`;
  };

  // ---------- Udvikling: categories over the last six months ----------
  const TrendsPage = () => {
    const cur = currentBudgetMonth(), months = [5, 4, 3, 2, 1, 0].map(n => addMonths(cur, -n));
    const stats = months.map(m => monthStats(m));
    const done = months.slice(0, -1); // the running month isn't over, so averages use the five before it
    const rows = budgetCats.map(c => {
      const vals = stats.map(st => st.byCat[c] || 0), avg = vals.slice(0, -1).reduce((s, v) => s + v, 0) / done.length;
      const last = vals[vals.length - 2];
      return { c, vals, avg, last, change: avg > 0 ? (last - avg) / avg : null };
    }).filter(r => r.vals.some(v => v > 0)).sort((a, b) => b.avg - a.avg);
    const totals = stats.map(st => st.exp), maxT = Math.max(1, ...totals);
    return html`<div>
      <div className="card stack">
        <div className="small muted">Udgifter pr. måned. Den sidste søjle er den løbende måned.</div>
        <div className="trend-bars">${totals.map((v, i) => html`<div key=${i}><div className="tb" style=${{height:`${Math.max(3, v / maxT * 100)}%`, opacity: i === totals.length - 1 ? .5 : 1}}></div><span>${MONTHS_DA[+months[i].slice(5) - 1].slice(0, 3)}</span><b>${fmtShort(v)}</b></div>`)}</div>
      </div>
      <div className="section">
        <div className="section-head"><h2>Kategorier</h2><span className="small faint">${MONTHS_DA[+months[4].slice(5) - 1]} mod gennemsnit</span></div>
        <div className="list">${rows.map(r => { const mx = Math.max(1, ...r.vals); return html`<div key=${r.c} className="row" style=${{minHeight:58}}>
          <${CatIcon} cat=${r.c} small />
          <div className="main"><div className="title">${r.c}</div><div className="sub">snit ${fmt(r.avg)} pr. måned</div></div>
          <div className="mini-bars" aria-hidden="true">${r.vals.map((v, i) => html`<i key=${i} style=${{height:`${Math.max(2, v / mx * 100)}%`, background: CAT_COLORS[r.c], opacity: i === r.vals.length - 1 ? .45 : 1}}></i>`)}</div>
          <div className="end" style=${{minWidth:58}}>${r.change == null ? html`<span className="small faint">–</span>` : html`<span className=${"small " + (r.change > 0.15 ? "neg" : r.change < -0.15 ? "pos" : "muted")}>${r.change > 0 ? "+" : ""}${Math.round(r.change * 100)} %</span>`}</div>
        </div>`; })}</div>
      </div>
    </div>`;
  };

  // ---------- SU-fribeløb ----------
  // Uses the salary that actually lands on the account: SU counts "personlig indkomst" (pay before tax minus
  // AM-bidrag), which is the payout divided by (1 − trækprocent). Rest of the year = the recent average.
  const SuPage = () => {
    const su = prefs.su || {}, setSu = (patch) => setPrefs(pr => ({ ...pr, su: { ...(pr.su || {}), ...patch } }));
    const year = new Date().getFullYear(), rate = Math.min(60, Math.max(0, +su.rate || 38)) / 100;
    const sats = SU_FRIBELOB[year] || SU_FRIBELOB[Math.max(...Object.keys(SU_FRIBELOB).map(Number))];
    // SU is paid on the last bank day for the next month, so a payment on 30/12 is January's SU.
    const suMonths = new Set(transactions.filter(t => t.category === "SU" && t.amount > 0).map(t => budgetMonth(t.date, t.amount, t.category)).filter(m => m.startsWith(String(year))));
    const curM = currentBudgetMonth(), stillSu = suMonths.has(curM) || suMonths.has(prevMonth(curM));
    const restMonths = [...Array(12).keys()].map(i => `${year}-${String(i + 1).padStart(2, "0")}`).filter(m => m > curM && !suMonths.has(m));
    // No SU payments on the account (yet): assume SU all year rather than none.
    const withSu = suMonths.size ? suMonths.size + (stillSu ? restMonths.length : 0) : 12, without = 12 - withSu;
    const autoLimit = withSu * sats.su + without * sats.noSu;
    const limit = +su.limit || autoLimit;
    const byMonth = {};
    for (const t of transactions) if (t.category === "Løn" && t.amount > 0 && (t.date || "").startsWith(String(year))) byMonth[t.date.slice(0, 7)] = (byMonth[t.date.slice(0, 7)] || 0) + t.amount;
    const months = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([m, net]) => ({ m, net, pi: net / (1 - rate) }));
    const sofar = months.reduce((s, x) => s + x.pi, 0);
    const recent = months.slice(-6), avg = recent.length ? recent.reduce((s, x) => s + x.pi, 0) / recent.length : 0;
    const thisMonth = isoDate(new Date()).slice(0, 7), monthsLeft = 12 - new Date().getMonth() - (byMonth[thisMonth] ? 1 : 0);
    const forecast = sofar + avg * Math.max(0, monthsLeft);
    return html`<div>
      <div className="card stack">
        <div className="small muted">Så meget må du tjene ved siden af SU i ${year} – regnet ud fra su.dk's satser og de måneder, du får SU.</div>
        <div style=${{fontSize:26, fontWeight:700}}>${fmt(limit)}</div>
        <div className="small muted">${withSu} ${withSu === 1 ? "måned" : "måneder"} med SU × ${fmt(sats.su)}${without ? ` + ${without} uden SU × ${fmt(sats.noSu)}` : ""}${su.limit ? " (du har selv rettet beløbet)" : ""}${!suMonths.size ? " – fandt ingen SU-udbetalinger, så der regnes med SU hele året" : ""}</div>
        <div className="bar" style=${{height:8}}><div style=${{width:`${Math.min(100, forecast / limit * 100)}%`, background: forecast > limit ? "var(--neg)" : forecast > limit * 0.85 ? "var(--warn, #EF9F27)" : "var(--pos)"}}></div></div>
        <div style=${{display:"flex", justifyContent:"space-between", gap:12}}><span className="small muted">Tjent indtil nu</span><b className="num">${fmt(sofar)}</b></div>
        <div style=${{display:"flex", justifyContent:"space-between", gap:12}}><span className="small muted">Forventet for hele året</span><b className="num">${fmt(forecast)}</b></div>
        <div className=${forecast > limit ? "neg" : ""} style=${{fontSize:15}}>${forecast > limit
          ? html`Du ser ud til at tjene <b>${fmt(forecast - limit)}</b> for meget i ${year}. Du kan fravælge SU for nogle måneder (så stiger fribeløbet) eller betale overskydende SU tilbage.`
          : html`Du kan tjene ca. <b className="pos">${fmt(limit - forecast)}</b> mere i ${year}, før du skal betale SU tilbage.`}</div>
        ${avg > 0 && html`<div className="small muted">Resten af året er regnet med dit snit for de seneste ${recent.length} måneder: ca. ${fmt(avg)} pr. måned.</div>`}
      </div>
      <div className="card stack" style=${{marginTop:12}}>
        <label className="field">Trækprocent på lønnen (%)<input className="input" type="number" inputMode="decimal" value=${su.rate ?? ""} placeholder="38" onChange=${e=>setSu({ rate: e.target.value })} /></label>
        <div className="small faint">Står på din lønseddel eller forskudsopgørelse. Bruges til at regne udbetalingen om til løn før skat (efter AM-bidrag), som er det, SU tæller.</div>
        <details className="small"><summary>Ret fribeløbet selv</summary>
          <label className="field" style=${{marginTop:8}}>Fribeløb for ${year} (tom = beregn selv)<input className="input privacy" type="number" inputMode="decimal" value=${su.limit ?? ""} placeholder=${String(autoLimit)} onChange=${e=>setSu({ limit: e.target.value })} /></label>
        </details>
      </div>
      ${months.length > 0 && html`<div className="section">
        <div className="section-head"><h2>Løn i ${year}</h2><span className="small faint">udbetalt → tæller for SU</span></div>
        <div className="list">${months.slice().reverse().map(x => html`<div key=${x.m} className="row" style=${{minHeight:44}}>
          <div className="main"><div className="title">${monthName(x.m)}</div></div>
          <div className="end"><span className="small muted num">${fmt(x.net)} → </span><b className="num">${fmt(x.pi)}</b></div>
        </div>`)}</div>
      </div>`}
      <div className="small faint" style=${{marginTop:12}}>Satser fra su.dk (${year}): ${fmt(sats.su)} pr. måned med SU, ${fmt(sats.noSu)} uden SU, ${fmt(sats.out)} når du ikke er under uddannelse. SU'en selv tæller ikke med. Kun et skøn – SU's opgørelse bygger på din årsopgørelse.</div>
    </div>`;
  };

  // ---------- Notifikationer ----------
  const enablePush = async () => {
    setPushInfo(p => ({ ...p, msg: "" }));
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error(/iPhone|iPad/.test(navigator.userAgent) ? "Åbn appen fra ikonet på hjemmeskærmen (ikke i Safari) – så kan den få notifikationer." : "Denne browser understøtter ikke notifikationer.");
      if (await Notification.requestPermission() !== "granted") throw new Error("Du skal tillade notifikationer, når telefonen spørger.");
      const { key } = await callBridge("/push/key", {});
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(key) });
      await callBridge("/push/subscribe", { subscription: sub.toJSON(), device: deviceName() });
      store.set(PUSH_KEY, "1"); store.remove("push_sched");
      setPushInfo({ on: true, msg: "Notifikationer er slået til på denne enhed." });
    } catch (e) { setPushInfo(p => ({ ...p, msg: "Fejl: " + (e.code === "no_vapid" ? "workeren mangler nøglen til notifikationer (VAPID_PRIVATE)." : e.message || e) })); }
  };
  const disablePush = async () => {
    try { const reg = await navigator.serviceWorker.ready; await (await reg.pushManager.getSubscription())?.unsubscribe(); } catch {}
    store.remove(PUSH_KEY); setPushInfo({ on: false, msg: "Notifikationer er slået fra på denne enhed." });
  };
  const NotifyPage = () => html`<div className="card stack">
    <div className="small muted">Få en besked på telefonen, når lønnen kommer, når madplanen er slut, og når der er nye tilbudsaviser i dine butikker. På iPhone virker det kun, når appen er åbnet fra ikonet på hjemmeskærmen.</div>
    ${pushInfo.on
      ? html`<div className="small pos">Slået til på denne enhed.</div>
          <div className="btns"><button className="btn soft" onClick=${async ()=>{ try { const r = await callBridge("/push/test", {}); setPushInfo(p => ({ ...p, msg: `Testbesked sendt til ${r.sent} ${r.sent === 1 ? "enhed" : "enheder"}.` })); } catch (e) { setPushInfo(p => ({ ...p, msg: "Fejl: " + e.message })); } }}>Send en test</button>
          <button className="btn" onClick=${disablePush}>Slå fra</button></div>`
      : html`<button className="btn primary" onClick=${enablePush}>Slå notifikationer til</button>`}
    ${pushInfo.msg && html`<div className=${"small " + (pushInfo.msg.startsWith("Fejl") ? "neg" : "")}>${pushInfo.msg}</div>`}
    <div className="small faint">Beskederne sendes af din worker en gang i timen. Den kender kun tidspunkt og tekst – ikke dine tal.</div>
  </div>`;

  // ---------- Delte udgifter ----------
  const shared = prefs.shared || { items: [] };
  const setShared = (items) => setPrefs(pr => ({ ...pr, shared: { ...(pr.shared || {}), items } }));
  const sharedPeople = [...new Set(shared.items.map(x => x.who))];
  const owedBy = (who) => shared.items.filter(x => x.who === who && !x.settled).reduce((s, x) => s + x.amount, 0); // + = they owe me
  const addShared = (d, tx = null) => {
    const amt = Math.abs(parseFloat(String(d.amt).replace(",", ".")) || 0), who = d.who.trim();
    if (!who || !amt) return false;
    const part = d.split === "half" ? amt / 2 : amt;
    const item = { id: uid(), who, desc: d.desc.trim() || "Udlæg", amount: d.paidBy === "me" ? part : -part, date: tx?.date || isoDate(new Date()), txId: tx?.id || null, settled: false };
    setShared([item, ...shared.items]);
    if (tx && d.paidBy === "me" && d.split === "half") editTx(tx.id, { delt: true });
    setShareDraft({ who, desc: "", amt: "", paidBy: "me", split: "half" });
    return true;
  };
  const shareRequest = async (who) => {
    const open = shared.items.filter(x => x.who === who && !x.settled), sum = owedBy(who);
    const text = `Hej ${who}! ${sum >= 0 ? `Du skylder mig ${fmtKr(sum)}` : `Jeg skylder dig ${fmtKr(-sum)}`}:\n` + open.map(x => `- ${x.desc} (${shortDate(x.date)}): ${fmtKr(Math.abs(x.amount))}`).join("\n") + (sum > 0 ? "\n\nSend gerne på MobilePay 🙏" : "");
    try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); flash("shared", "Beskeden er kopieret."); } } catch {}
  };
  const SharedPage = () => {
    // A recent payment in whose text has the person's name and the open amount: probably them paying back.
    const paidBack = (who) => { const sum = owedBy(who); if (sum <= 0) return null; const n = who.toLowerCase().split(" ")[0];
      return transactions.find(t => t.amount > 0 && t.date >= addDays(isoDate(new Date()), -45) && (t.description || "").toLowerCase().includes(n) && Math.abs(t.amount - sum) <= Math.max(5, sum * 0.05)); };
    return html`<div>
      ${sharedPeople.filter(w => Math.abs(owedBy(w)) >= 0.5).length === 0 && html`<div className="card empty">Ingen åbne udlæg. Tilføj et nedenfor, eller tryk <b>Del med en ven</b> på en post under Poster.</div>`}
      <div className="stack-gap">${sharedPeople.map(who => { const sum = owedBy(who), open = shared.items.filter(x => x.who === who && !x.settled); if (!open.length) return null; const pb = paidBack(who);
        return html`<div key=${who} className="card stack">
          <div style=${{display:"flex", alignItems:"baseline", gap:8}}><b style=${{flex:1, fontSize:17}}>${who}</b><span className=${"num " + (sum >= 0 ? "pos" : "neg")} style=${{fontWeight:650}}>${sum >= 0 ? `skylder dig ${fmt(sum)}` : `du skylder ${fmt(-sum)}`}</span></div>
          <div className="list">${open.map(x => html`<div key=${x.id} className="row" style=${{minHeight:42}}>
            <div className="main"><div className="title" style=${{whiteSpace:"normal"}}>${x.desc}</div><div className="sub">${shortDate(x.date)} · ${x.amount >= 0 ? "du lagde ud" : `${who} lagde ud`}</div></div>
            <div className="end"><span className="num">${fmt(Math.abs(x.amount))}</span> <button className="link-btn small" aria-label=${`Fjern ${x.desc}`} onClick=${()=>setShared(shared.items.filter(y => y.id !== x.id))}>✕</button></div>
          </div>`)}</div>
          ${pb && html`<div className="small">Betalt? ${fmt(pb.amount)} fra "${prettyName(pb.description)}" d. ${shortDate(pb.date)}.</div>`}
          <div className="btns"><button className="btn soft" onClick=${()=>shareRequest(who)}>${sum >= 0 ? "Anmod" : "Del oversigt"}</button><button className="btn" onClick=${()=>setShared(shared.items.map(x => x.who === who ? { ...x, settled: true } : x))}>Markér som afregnet</button></div>
        </div>`; })}</div>
      <${Msg} k="shared" />
      <div className="section">
        <div className="section-head"><h2>Nyt udlæg</h2></div>
        ${SharedForm(null)}
      </div>
    </div>`;
  };
  const SharedForm = (tx) => html`<form className="card stack" onSubmit=${e=>{ e.preventDefault(); if (addShared(shareDraft, tx)) { setShareFor(null); flash(tx ? "tx" : "shared", "Udlægget er gemt under Mere → Delte udgifter."); } }}>
    <input className="input" list="shared-people" value=${shareDraft.who} onChange=${e=>setShareDraft({...shareDraft, who: e.target.value})} placeholder="Hvem? fx Jens" aria-label="Person" />
    <datalist id="shared-people">${sharedPeople.map(w => html`<option key=${w} value=${w} />`)}</datalist>
    ${!tx && html`<div className="grid2">
      <input className="input" value=${shareDraft.desc} onChange=${e=>setShareDraft({...shareDraft, desc: e.target.value})} placeholder="Hvad? fx pizza" aria-label="Beskrivelse" />
      <input className="input" inputMode="decimal" value=${shareDraft.amt} onChange=${e=>setShareDraft({...shareDraft, amt: e.target.value})} placeholder="Beløb i alt" aria-label="Beløb" />
    </div>`}
    <div className="seg">${[["me", "Jeg lagde ud"], ["them", "De lagde ud"]].map(([v, l]) => html`<button key=${v} type="button" className=${shareDraft.paidBy === v ? "on" : ""} onClick=${()=>setShareDraft({...shareDraft, paidBy: v})}>${l}</button>`)}</div>
    <div className="seg">${[["half", "Del lige"], ["all", "Hele beløbet"]].map(([v, l]) => html`<button key=${v} type="button" className=${shareDraft.split === v ? "on" : ""} onClick=${()=>setShareDraft({...shareDraft, split: v})}>${l}</button>`)}</div>
    <button className="btn primary" type="submit" disabled=${!shareDraft.who.trim() || !(tx || parseFloat(shareDraft.amt))}>Gem udlæg</button>
  </form>`;

  // ---------- Hurtig udgift ----------
  const QUICK_CATS = ["Mad & dagligvarer", "Restaurant & café", "Transport", "Shopping", "Underholdning", "Sundhed & fitness", "Andet"];
  const saveQuick = () => {
    const amt = Math.abs(parseFloat(String(quick.amt).replace(/\./g, "").replace(",", ".")) || 0);
    if (!amt) return;
    const t = { id: uid(), date: isoDate(new Date()), description: quick.note.trim() || (quick.kind === "in" ? "Indbetaling (kontant)" : `${quick.cat} (kontant)`), amount: quick.kind === "in" ? amt : -amt,
      category: quick.kind === "in" ? "Anden indkomst" : quick.cat, manualCategory: true, localDate: true, source: "manual" };
    setTransactions([t, ...transactions]); setQuick(null);
    if (new URLSearchParams(location.search).get("add")) history.replaceState(null, "", location.pathname);
    flash("quick", `${fmt(t.amount)} er gemt under ${t.category}.`);
  };
  const QuickSheet = () => html`<div className="sheet-backdrop" onClick=${e=>{ if (e.target === e.currentTarget) setQuick(null); }}>
    <form className="sheet" onSubmit=${e=>{ e.preventDefault(); saveQuick(); }}>
      <div style=${{display:"flex", alignItems:"center"}}><b style=${{flex:1, fontSize:18}}>Hurtig ${quick.kind === "in" ? "indbetaling" : "udgift"}</b><button type="button" className="icon-btn" aria-label="Luk" onClick=${()=>setQuick(null)}>✕</button></div>
      <input className="input quick-amt" inputMode="decimal" autoFocus value=${quick.amt} onChange=${e=>setQuick({...quick, amt: e.target.value})} placeholder="0 kr." aria-label="Beløb" />
      <div className="seg">${[["out", "Udgift"], ["in", "Indbetaling"]].map(([v, l]) => html`<button key=${v} type="button" className=${quick.kind === v ? "on" : ""} onClick=${()=>setQuick({...quick, kind: v})}>${l}</button>`)}</div>
      ${quick.kind === "out" && html`<div style=${{display:"flex", flexWrap:"wrap", gap:6}}>${QUICK_CATS.map(c => html`<button key=${c} type="button" className=${"chip " + (quick.cat === c ? "info" : "")} style=${quick.cat === c ? {} : {border:"1px solid var(--border)"}} onClick=${()=>setQuick({...quick, cat: c})}>${SHORT_CAT[c] || c}</button>`)}</div>`}
      <input className="input" value=${quick.note} onChange=${e=>setQuick({...quick, note: e.target.value})} placeholder="Note (valgfri), fx kaffe" aria-label="Note" />
      <button className="btn primary block" type="submit" disabled=${!parseFloat(String(quick.amt).replace(",", "."))}>Gem</button>
      <div className="small faint">Til kontantkøb. Køb med kort og MobilePay kommer selv fra banken.</div>
    </form>
  </div>`;

  // ---------- Træning ----------
  const training = { ...DEFAULT_TRAINING, ...(prefs.training || {}) };
  const setTraining = (patch) => setPrefs(pr => ({ ...pr, training: { ...DEFAULT_TRAINING, ...(pr.training || {}), ...(typeof patch === "function" ? patch({ ...DEFAULT_TRAINING, ...(pr.training || {}) }) : patch) } }));
  const TrainingPage = () => {
    const today = isoDate(new Date()), session = sessionFor(training, today), done = !!training.log?.[today];
    const wk = weekProgress(training), streak = weekStreak(training);
    const ws = (training.weights || []).slice().sort((a, b) => a.d.localeCompare(b.d)), lastW = ws[ws.length - 1];
    const avg7 = (() => { const r = ws.filter(w => w.d > addDays(today, -7)); return r.length ? r.reduce((s, w) => s + w.kg, 0) / r.length : null; })();
    const w30 = ws.filter(w => w.d <= addDays(today, -28)).pop();
    const chart = ws.filter(w => w.d >= addDays(today, -120));
    const lifts = liftSummary(training.lifts);
    const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
    const addWeight = () => { const kg = parseFloat(weightDraft.replace(",", ".")); if (!(kg > 30 && kg < 300)) return; setTraining(t => ({ weights: [...(t.weights || []).filter(w => w.d !== today), { d: today, kg }] })); setWeightDraft(""); };
    const addLift = () => { const kg = parseFloat(String(liftDraft.kg).replace(",", ".")), reps = parseInt(liftDraft.reps), ex = liftDraft.ex.trim();
      if (!ex || !(kg > 0) || !(reps > 0)) return; setTraining(t => ({ lifts: [...(t.lifts || []), { d: today, ex, kg, reps }] })); setLiftDraft({ ex, kg: "", reps: "" }); };
    const importCsv = async (file) => {
      const rows = parseWorkoutCsv(await file.text());
      if (!rows.length) { flash("training", "Fejl: fandt ingen sæt i filen (den skal have kolonner for dato, øvelse, vægt og reps)."); return; }
      setTraining(t => { const key = (x) => `${x.d}|${x.ex}|${x.kg}|${x.reps}`, have = new Set((t.lifts || []).map(key));
        const add = rows.filter(r => !have.has(key(r))), log = { ...(t.log || {}) }; for (const r of add) log[r.d] ||= true;
        return { lifts: [...(t.lifts || []), ...add], log }; });
      flash("training", `${rows.length} sæt læst fra filen.`);
    };
    // Simple weight chart (last four months).
    const W = 300, H = 90, vals = chart.map(w => w.kg), mn = Math.min(...vals) - 0.5, mx = Math.max(...vals) + 0.5;
    const pts = chart.map((w, i) => [chart.length > 1 ? i / (chart.length - 1) * W : W / 2, H - 8 - (w.kg - mn) / (mx - mn || 1) * (H - 16)]);
    return html`<div>
      <div className="card stack">
        <div style=${{display:"flex", alignItems:"center", gap:12}}>
          <div style=${{flex:1}}><div className="small muted">I dag</div><div style=${{fontSize:24, fontWeight:700}}>${session || "Hviledag"}</div></div>
          <a className="btn soft" href="https://gravitus.com/" target="_blank" rel="noopener">Åbn Gravitus</a>
        </div>
        ${session || done ? html`<button className=${"btn block " + (done ? "soft" : "primary")} onClick=${()=>setTraining(t => { const log = { ...(t.log || {}) }; if (log[today]) delete log[today]; else log[today] = session || "Ekstra"; return { log }; })}>${done ? "✓ Trænet i dag (fortryd)" : "Markér som trænet"}</button>`
          : html`<button className="btn block soft" onClick=${()=>setTraining(t => ({ log: { ...(t.log || {}), [today]: "Ekstra" } }))}>Jeg trænede alligevel</button>`}
        <div style=${{display:"flex", alignItems:"center", gap:10}}>
          <div style=${{display:"flex", gap:6}}>${[...Array(wk.target).keys()].map(i => html`<span key=${i} className=${"wk-dot" + (i < wk.done ? " on" : "")}></span>`)}</div>
          <span className="small">${wk.done} af ${wk.target} denne uge</span>
          ${streak > 0 && html`<span className="small" style=${{marginLeft:"auto"}}>🔥 ${streak} ${streak === 1 ? "uge" : "uger"} i træk</span>`}
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Program</h2><span className="small faint">${training.days.length} gange om ugen</span></div>
        <div className="card stack">
          <div className="day-chips">${DAY_ORDER.map(d => { const on = training.days.includes(d), name = on ? sessionFor(training, addDays(today, ((d - new Date().getDay()) + 7) % 7)) : null;
            return html`<button key=${d} className=${"day-chip " + (on ? "" : "away")} aria-pressed=${on} onClick=${()=>setTraining(t => ({ days: on ? t.days.filter(x => x !== d) : [...t.days, d] }))}>
              <b>${WEEKDAYS[d].slice(0, 3)}</b><i>${on ? name : "hvile"}</i></button>`; })}</div>
          <label className="field">Pas i rækkefølge (adskilt af komma)<input className="input" value=${training.split.join(", ")} onChange=${e=>setTraining({ split: e.target.value.split(",").map(x => x.trim()).filter(Boolean) })} /></label>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Vægt</h2>${lastW && html`<span className="small faint">senest ${shortDate(lastW.d)}</span>`}</div>
        <div className="card stack">
          <form style=${{display:"flex", gap:8}} onSubmit=${e=>{ e.preventDefault(); addWeight(); }}>
            <input className="input" style=${{flex:1}} inputMode="decimal" value=${weightDraft} onChange=${e=>setWeightDraft(e.target.value)} placeholder=${lastW ? `fx ${String(lastW.kg).replace(".", ",")}` : "Din vægt i kg"} aria-label="Vægt i kg" />
            <button className="btn primary" type="submit" disabled=${!weightDraft.trim()}>Gem i dag</button>
          </form>
          ${chart.length > 1 && html`<svg viewBox=${`0 0 ${W} ${H}`} className="weight-chart" preserveAspectRatio="none" aria-hidden="true">
            <path d=${pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} />
            ${pts.length && html`<circle cx=${pts[pts.length - 1][0]} cy=${pts[pts.length - 1][1]} r="3.5" />`}
          </svg>`}
          ${lastW && html`<div className="stats" style=${{marginTop:0}}>
            <div className="stat"><div className="label">Nu</div><div className="value">${String(lastW.kg).replace(".", ",")} kg</div></div>
            <div className="stat"><div className="label">Snit 7 dage</div><div className="value">${avg7 ? avg7.toFixed(1).replace(".", ",") : "–"} kg</div></div>
            <div className="stat"><div className="label">4 uger</div><div className="value">${w30 ? `${lastW.kg - w30.kg >= 0 ? "+" : ""}${(lastW.kg - w30.kg).toFixed(1).replace(".", ",")}` : "–"} kg</div></div>
          </div>`}
          ${lastW && html`<div className="small">Til muskelopbygning anbefales ca. 1,6–2,2 g protein pr. kg – for dig ca. <b>${Math.round(lastW.kg * 1.8)} g</b> om dagen.
            ${+prefs.proteinGoal !== Math.round(lastW.kg * 1.8) && html` <button className="link-btn small" onClick=${()=>setPrefs(pr => ({ ...pr, proteinGoal: String(Math.round(lastW.kg * 1.8)) }))}>Brug som proteinmål i madplanen</button>`}</div>`}
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Løft</h2><label className="link-btn small" style=${{cursor:"pointer"}}>Importér fra Gravitus (CSV)<input type="file" accept=".csv,text/csv" style=${{display:"none"}} onChange=${e=>{ e.target.files[0] && importCsv(e.target.files[0]); e.target.value = ""; }} /></label></div>
        <form className="card stack" onSubmit=${e=>{ e.preventDefault(); addLift(); }}>
          <input className="input" list="lift-names" value=${liftDraft.ex} onChange=${e=>setLiftDraft({...liftDraft, ex: e.target.value})} placeholder="Øvelse, fx Bænkpres" aria-label="Øvelse" />
          <datalist id="lift-names">${[...new Set([...LIFTS, ...lifts.map(l => l.ex)])].map(x => html`<option key=${x} value=${x} />`)}</datalist>
          <div style=${{display:"flex", gap:8}}>
            <input className="input" style=${{flex:1}} inputMode="decimal" value=${liftDraft.kg} onChange=${e=>setLiftDraft({...liftDraft, kg: e.target.value})} placeholder="kg" aria-label="Kilo" />
            <input className="input" style=${{flex:1}} inputMode="numeric" value=${liftDraft.reps} onChange=${e=>setLiftDraft({...liftDraft, reps: e.target.value})} placeholder="reps" aria-label="Gentagelser" />
            <button className="btn primary" type="submit">Gem sæt</button>
          </div>
          <${Msg} k="training" />
        </form>
        ${lifts.length > 0 && html`<div className="list" style=${{marginTop:10}}>${lifts.map(l => html`<div key=${l.ex} className="row" style=${{minHeight:52}}>
          <div className="main"><div className="title">${l.ex}</div><div className="sub">${String(l.last.kg).replace(".", ",")} kg × ${l.last.reps} · ${shortDate(l.last.d)}</div></div>
          <div className="end"><div className="num" style=${{fontWeight:650}}>${String(l.best).replace(".", ",")} kg</div><div className=${"small " + (l.change > 0 ? "pos" : l.change < 0 ? "neg" : "muted")}>${l.change != null ? `${l.change > 0 ? "+" : ""}${String(l.change).replace(".", ",")} kg på 4 uger` : "anslået maks"}</div></div>
        </div>`)}</div>`}
        <div className="small faint" style=${{marginTop:8}}>Maks er anslået ud fra dit bedste sæt (Epley). Gravitus har ingen åben forbindelse, men kan du eksportere dine træninger som CSV, kan de importeres her.</div>
      </div>
    </div>`;
  };

  // ---------- Kalender ----------
  const calFeedUrl = () => { const b = store.json(BRIDGE_KEY); return b?.url && prefs.calToken ? `${b.url.replace(/\/+$/, "")}/cal/${prefs.calToken}.ics` : null; };
  const CalendarPage = () => {
    const evs = calCache?.events || [], upcoming = evs.filter(e => e.end >= isoDate(new Date())).slice(0, 8);
    const feed = calFeedUrl();
    const fmtEv = (e) => { const d = parseDKDate(e.start.slice(0, 10)); return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${d.getDate()}/${d.getMonth() + 1}${e.allDay ? "" : " " + e.start.slice(11, 16)}`; };
    return html`<div>
      <div className="card stack">
        <div style=${{fontWeight:600}}>Læs din Google Calendar</div>
        <div className="small muted">Så ved madplanen, hvornår du ikke er hjemme til aftensmad, fx middage, fester og ture.</div>
        ${prefs.calUrl ? html`
          <div className="small pos">Forbundet${calCache?.fetched ? ` · hentet ${new Date(calCache.fetched).toLocaleTimeString("da-DK", { hour:"2-digit", minute:"2-digit" })}` : ""} · ${evs.length} aftaler de næste 6 uger.</div>
          <div className="btns"><button className="btn soft" onClick=${()=>refreshCalendar(true)}>Hent nu</button><button className="btn" onClick=${()=>{ setPrefs(pr => ({ ...pr, calUrl: null })); store.remove(CAL_KEY); setCalCache(null); }}>Fjern</button></div>`
        : html`
          <ol className="small" style=${{margin:0, paddingLeft:18, display:"flex", flexDirection:"column", gap:4}}>
            <li>Åbn <b>calendar.google.com</b> på en computer.</li>
            <li>Tryk på tandhjulet → <b>Indstillinger</b>, og vælg din kalender i venstre side.</li>
            <li>Rul ned til <b>Integrer kalender</b>, og kopiér <b>Hemmelig adresse i iCal-format</b>.</li>
            <li>Sæt den ind her.</li>
          </ol>
          <form style=${{display:"flex", gap:8}} onSubmit=${e=>{ e.preventDefault(); const u = calDraft.trim(); if (/^(https|webcal):\/\//.test(u)) { setPrefs(pr => ({ ...pr, calUrl: u })); setCalDraft(""); } else flash("cal", "Fejl: adressen skal starte med https://"); }}>
            <input className="input privacy" style=${{flex:1}} value=${calDraft} onChange=${e=>setCalDraft(e.target.value)} placeholder="https://calendar.google.com/…/basic.ics" aria-label="Hemmelig iCal-adresse" />
            <button className="btn primary" type="submit" disabled=${!calDraft.trim()}>Gem</button>
          </form>`}
        <${Msg} k="cal" />
        ${upcoming.length > 0 && html`<div className="list">${upcoming.map((e, i) => { const away = !e.allDay || (Date.parse(e.end) - Date.parse(e.start)) >= 2 * 864e5 ? calendarAway([e], e.start.slice(0, 10)) : calendarAway([e], e.start.slice(0, 10));
          return html`<div key=${i} className="row" style=${{minHeight:44}}><div className="main"><div className="title" style=${{whiteSpace:"normal"}}>${e.title}</div><div className="sub">${fmtEv(e)}${e.location ? ` · ${e.location}` : ""}</div></div>${away && html`<span className="small muted">ude til aftensmad</span>`}</div>`; })}</div>`}
      </div>
      <div className="card stack" style=${{marginTop:12}}>
        <div style=${{fontWeight:600}}>Vis appen i Google Calendar</div>
        <div className="small muted">En kalender "Økonomi" med madplanens retter, lønningsdage, husleje og dine rejser – uden beløb. Google opdaterer den selv nogle gange i døgnet.</div>
        ${feed ? html`
          <div className="code" style=${{wordBreak:"break-all", fontSize:12}}>${feed}</div>
          <button className="btn soft" onClick=${async ()=>{ try { await navigator.clipboard.writeText(feed); flash("calpub", "Adressen er kopieret."); } catch { flash("calpub", "Markér og kopiér adressen ovenfor."); } }}>Kopiér adressen</button>
          <ol className="small" style=${{margin:0, paddingLeft:18, display:"flex", flexDirection:"column", gap:4}}>
            <li>Åbn <b>calendar.google.com</b> på en computer.</li>
            <li>Ved <b>Andre kalendere</b> i venstre side: tryk <b>+</b> → <b>Fra webadresse</b>.</li>
            <li>Sæt adressen ind, og tryk <b>Tilføj kalender</b>.</li>
          </ol>
          <div className="small faint">Del ikke adressen – alle med den kan se kalenderen.</div>`
        : html`<button className="btn primary" disabled=${!store.json(BRIDGE_KEY)} onClick=${()=>setPrefs(pr => ({ ...pr, calToken: toB64(randomBytes(24)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }))}>Lav kalenderen</button>`}
        <${Msg} k="calpub" />
      </div>
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
    const setItems = (items) => setShop(s => ({...s, items}));
    const inStores = (list) => (list || []).filter(o => stores.includes(o.store));
    const load = loadOffers;
    const add = (name) => {
      const n = name.trim();
      if (!n || shop.items.some(i => i.name.toLowerCase() === n.toLowerCase())) return;
      const item = { id: uid(), name: n, done: false, pick: null };
      setItems([...shop.items, item]); setShopDraft(""); load(item);
    };
    const refreshAll = () => shop.items.filter(i => !i.done).forEach(load);
    // Items from the madplan carry a copy of their offer, so the list also works in the shop without net.
    // Others: the offer the user tapped, else the best match in their stores.
    const chosen = (item) => {
      if (item.snap && !item.picked) return item.snap;
      const l = inStores(offers[item.id]?.list);
      return l.find(o => o.id === item.pick) || l.find(o => offerFits(item.name, o.heading)) || l[0] || item.snap || null;
    };
    const groups = {};
    for (const it of shop.items) { const o = chosen(it); const k = o ? o.store : "Uden tilbud"; (groups[k] ||= []).push({ it, o, aisle: aisleOf(it.name) }); }
    for (const g of Object.values(groups)) g.sort((x, y) => AISLES.indexOf(x.aisle) - AISLES.indexOf(y.aisle));
    const order = Object.keys(groups).sort((a, b) => (a === "Uden tilbud") - (b === "Uden tilbud") || groups[b].length - groups[a].length);
    const total = shop.items.filter(i => !i.done).reduce((s, i) => s + (chosen(i)?.price || 0), 0);
    const till = (o) => o.till ? `til ${shortDate(isoDate(new Date(o.till)))}` : "";
    const share = async () => {
      const text = order.map(st => `${st}\n` + groups[st].filter(x => !x.it.done).map(x => `- ${x.it.name}${x.it.qty ? ` (${x.it.qty})` : ""}`).join("\n")).join("\n\n");
      try { if (navigator.share) await navigator.share({ title: "Indkøbsliste", text }); else { await navigator.clipboard.writeText(text); flash("shop", "Listen er kopieret."); } } catch {}
    };
    return html`<div>
      <div className="card stack">
        <div className="small muted">Skriv det, du mangler, eller læg madplanen på listen. Listen er sorteret efter butik og afdeling, og den virker også uden net i butikken.</div>
        <form style=${{display:"flex", gap:8}} onSubmit=${e=>{ e.preventDefault(); add(shopDraft); }}>
          <input className="input" style=${{flex:1}} value=${shopDraft} onChange=${e=>setShopDraft(e.target.value)} placeholder="Fx kaffe, kylling, pasta" aria-label="Vare" />
          <button className="btn primary" type="submit" disabled=${!shopDraft.trim()}>Tilføj</button>
        </form>
        <div style=${{display:"flex", flexWrap:"wrap", gap:6}}>${STAPLES.filter(x => !shop.items.some(i => i.name.toLowerCase() === x.toLowerCase())).map(x => html`<button key=${x} className="chip info" onClick=${()=>add(x)}>+ ${x}</button>`)}</div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Varer</h2>${shop.items.length > 0 && html`<div style=${{display:"flex", gap:14}}><button className="link-btn" onClick=${share}>Del</button><button className="link-btn" onClick=${refreshAll}>Opdater tilbud</button></div>`}</div>
        ${shop.items.length === 0 ? html`<div className="card empty">Listen er tom. Tilføj varer ovenfor, eller tryk <b>Læg det hele på indkøbslisten</b> under Madplan.</div>` : html`
          ${total > 0 && html`<div className="tip" style=${{marginTop:0, marginBottom:10}}><div className="sq sm" style=${{background:"var(--pos-bg)", color:"var(--pos)"}}><${Icon} name="cart" /></div><div>Det, du mangler, koster ca. <b>${kr(Math.round(total))}</b></div></div>`}
          <div className="stack-gap">${order.map(store => html`<div key=${store}>
            <div className="small muted" style=${{margin:"4px 2px 6px", fontWeight:600}}>${store}</div>
            <div className="list">${groups[store].map(({ it, o, aisle }, k) => {
              const st = offers[it.id] || {}, alts = inStores(st.list).slice(0, 6);
              const head = k === 0 || groups[store][k - 1].aisle !== aisle;
              return html`<div key=${it.id}>${head && html`<div className="small faint" style=${{padding:"8px 14px 0"}}>${aisle}</div>`}<div className="row" style=${{alignItems:"flex-start", flexWrap:"wrap", opacity: it.done ? .5 : 1}}>
                <input type="checkbox" style=${{width:22, height:22, marginTop:4, accentColor:"var(--accent)"}} checked=${it.done} aria-label=${`${it.name} er købt`} onChange=${()=>setItems(shop.items.map(x => x.id === it.id ? {...x, done: !x.done} : x))} />
                ${o?.image ? html`<img src=${o.image} alt="" loading="lazy" style=${{width:44, height:44, objectFit:"contain", borderRadius:8, background:"#fff"}} />` : null}
                <div className="main">
                  <div className="title" style=${{whiteSpace:"normal", textDecoration: it.done ? "line-through" : "none"}}>${it.name}${it.qty ? html` <span className="small muted" style=${{fontWeight:400}}>· ${it.qty}</span>` : null}</div>
                  <div className="sub" style=${{whiteSpace:"normal"}}>${o?.normal ? "Normalpris (skøn)" : st.loading ? "Finder tilbud…" : st.error && !o ? st.error : o ? `${o.heading} · ${till(o)}` : st.list ? "Ingen tilbud i dine butikker lige nu" : "Tryk Opdater tilbud"}</div>
                  ${alts.length > 1 && html`<select className="input sm" style=${{marginTop:6, maxWidth:"100%"}} aria-label=${`Vælg tilbud for ${it.name}`} value=${o?.id || ""} onChange=${e=>setItems(shop.items.map(x => x.id === it.id ? {...x, pick: e.target.value, picked: true} : x))}>
                    ${alts.map(a => html`<option key=${a.id} value=${a.id}>${a.store}: ${kr(a.price)} – ${a.heading.slice(0, 40)}</option>`)}
                  </select>`}
                </div>
                <div className="end">
                  ${o && html`<div className="num" style=${{fontWeight:600}}>${o.normal ? "ca. " : ""}${kr(Math.round(o.price * 100) / 100)}</div>${o.before ? html`<div className="small faint" style=${{textDecoration:"line-through"}}>${kr(o.before)}</div>` : null}`}
                  <button className="link-btn small" aria-label=${`Fjern ${it.name}`} onClick=${()=>{ const prev = shop.items; setItems(shop.items.filter(x => x.id !== it.id)); showUndo(`${it.name} er fjernet`, () => setItems(prev)); }}>Fjern</button>
                </div>
              </div></div>`;
            })}</div>
          </div>`)}</div>
          ${shop.items.some(i => i.done) && html`<button className="btn soft block" style=${{marginTop:12}} onClick=${()=>setItems(shop.items.filter(i => !i.done))}>Ryd købte varer</button>`}`}
        <${Msg} k="shop" />
      </div>
      ${StoresBlock()}
    </div>`;
  };

  // All dinners the planner may use: the starter meals (with the user's edits) plus their own, minus any skipped.
  const allMeals = [
    ...MEAL_TEMPLATES.map(([name, ingredients]) => (shop.meals || []).find(m => m.name === name) || { id: "tpl:" + name, name, ingredients, template: true, url: MEAL_SOURCE[name]?.url || null }),
    ...(shop.meals || []).filter(m => !MEAL_TEMPLATES.some(([n]) => n === m.name)),
  ];
  const mealPool = allMeals.filter(m => !m.skip && m.ingredients?.length);
  const favMeals = mealPool.filter(m => m.fav);
  const nights = Math.max(1, +shop.days || 6), cookDays = Math.max(1, +shop.cookDays || 3), perNight = Math.max(1, +shop.perNight || 1);
  const staples = shop.staples ?? ["græsk yoghurt"];
  const pantry = shop.pantry ?? BASICS.map(term => ({ term, always: true }));
  const freezer = shop.freezer || [];
  const freezerTotal = freezer.reduce((s, f) => s + (+f.portions || 0), 0);
  // Templates only get a stored entry once the user changes something about them.
  const mealPatch = (meals = [], m, patch) => {
    const stored = meals.find(x => x.id === m.id || x.name === m.name);
    return stored ? meals.map(x => x === stored ? {...x, ...patch} : x) : [...meals, { id: uid(), name: m.name, ingredients: m.ingredients, url: m.url || null, ...patch }];
  };
  const updateMeal = (m, patch) => setShop(s => ({...s, meals: mealPatch(s.meals, m, patch)}));

  // #6 + #9: twice a day, look up the weekly staples (plus two probes) to spot staples on sale and new weekly offers.
  useEffect(() => {
    if (!navigator.onLine || Date.now() - (shop.offerCheck?.at || 0) < 6 * 3600e3) return;
    let gone = false;
    (async () => {
      const watch = [...new Set([...staples, "kylling", "hakket oksekød"])].slice(0, 8);
      const lists = await Promise.all(watch.map(t => searchOffers(t, shop).catch(() => [])));
      if (gone) return;
      const now = Date.now(), rejected = shop.rejected || [];
      let newest = null; const deals = [];
      watch.forEach((t, k) => {
        const mine = lists[k].filter(o => shopStores.includes(o.store));
        for (const o of mine) if (o.from && Date.parse(o.from) <= now && (!newest || Date.parse(o.from) > Date.parse(newest))) newest = o.from;
        if (!staples.includes(t)) return;
        const n = normalPrice(t, lists[k]);
        const o = mine.filter(o => offerFits(t, o.heading) && !rejected.includes(o.heading.toLowerCase())).sort((a, b) => a.price - b.price)[0];
        if (o && o.price <= n * 0.8) deals.push({ term: t, id: o.id, heading: o.heading, store: o.store, price: o.price, normal: n, till: o.till, image: o.image });
      });
      setShop(s => ({...s, offerCheck: { at: Date.now(), newest, deals }}));
    })();
    return () => { gone = true; };
  }, [page, staples.join(","), shopStores.join(","), shop.lat]);
  const newOffers = !!(shop.plan?.created && shop.offerCheck?.newest && isoDate(new Date(shop.offerCheck.newest)) > shop.plan.created);
  // Where today falls in the plan: day 0 is the day it was made; each meal covers cookDays days.
  // ---------- calendar ----------
  const refreshCalendar = async (force) => {
    const cur = store.json(CAL_KEY);
    if (!prefs.calUrl) return cur?.events || [];
    if (!force && cur && Date.now() - Date.parse(cur.fetched) < 3600e3) return cur.events;
    try { const r = await callBridge("/calendar/events", { url: prefs.calUrl }); store.setJson(CAL_KEY, r); setCalCache(r); return r.events; }
    catch (e) { if (force) flash("cal", "Fejl: " + e.message, 9000); return cur?.events || []; }
  };
  useEffect(() => { refreshCalendar(false); }, [prefs.calUrl]);
  // Away for dinner on a date: the user's own mark wins, else the calendar.
  const awayFor = (date, evs = calCache?.events) => {
    const own = prefs.away?.[date];
    const ev = calendarAway(evs, date);
    return own != null ? { away: own, reason: own ? (ev?.title || "markeret") : null, own: true } : { away: !!ev, reason: ev?.title || null, own: false };
  };
  // Tap a day: "laver ikke mad" on/off. A mark that matches what the calendar says is removed again.
  const toggleAway = (date) => setPrefs(pr => {
    const auto = !!calendarAway(calCache?.events, date), cur = pr.away?.[date] ?? auto, away = { ...(pr.away || {}) };
    if (!cur === auto) delete away[date]; else away[date] = !cur;
    for (const d of Object.keys(away)) if (d < isoDate(new Date())) delete away[d];
    return { ...pr, away };
  });

  const planDay = shop.plan?.created ? Math.round((parseDKDate(isoDate(new Date())) - parseDKDate(shop.plan.created)) / 864e5) : 0;
  // The days (counted from the day the plan was made) the user eats at home; older plans: consecutive days.
  // Days already behind us stay as planned; the rest are laid out again from today, skipping evenings out –
  // so marking "laver ikke mad" (or a new calendar event) pushes the remaining meals a day on.
  const planDays = (() => {
    if (!shop.plan) return [];
    const base = shop.plan.days || [...Array(shop.plan.cookNights ?? shop.plan.nights).keys()];
    const past = base.filter(d => d < planDay), fut = [];
    for (let k = Math.max(0, planDay); fut.length < base.length - past.length && k < planDay + 60; k++)
      if (!awayFor(addDays(shop.plan.created, k)).away) fut.push(k);
    return [...past, ...fut];
  })();
  const planLen = planDays.length ? planDays[planDays.length - 1] + 1 : 0;
  const mealDays = (i) => planDays.slice(i * (shop.plan?.cookDays || 1), (i + 1) * (shop.plan?.cookDays || 1));
  const mealState = (i) => {
    const d = mealDays(i);
    if (!d.length) return "future";
    return d[d.length - 1] < planDay ? "past" : d[0] > planDay ? "future" : "now";
  };
  const planEnded = !!(shop.plan?.buy && shop.plan.meals?.length && planDay >= planLen);
  const foodBadge = newOffers || planEnded;
  // What to be told about, worked out here (the worker can't read the data) and sent to the worker, which
  // delivers each one when it's due: payday at 8, the morning after the madplan ends, plus new weekly offers.
  useEffect(() => {
    if (store.get(PUSH_KEY) !== "1") return;
    const items = [];
    const at = (d, h) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x.getTime(); };
    for (const k of [0, 1]) {
      const n = new Date(); const pd = paydayIn(n.getFullYear(), n.getMonth() + k);
      if (at(pd, 8) > Date.now()) items.push({ id: `pay-${isoDate(pd)}`, at: at(pd, 8), title: "Løn i dag 💰", body: `Rapporten for ${MONTHS_DA[pd.getMonth()]} er klar i appen, og budgettet starter forfra.` });
    }
    if (shop.plan?.created && shop.plan.meals?.length) {
      const end = parseDKDate(addDays(shop.plan.created, planLen));
      if (at(end, 10) > Date.now()) items.push({ id: `plan-${shop.plan.created}`, at: at(end, 10), title: "Madplanen er slut 🍽", body: "Tryk for at lave en ny madplan ud fra ugens tilbud." });
    }
    const watch = { term: (shop.staples || [])[0] || "kylling", stores: shopStores, lat: shop.lat, lng: shop.lng };
    const sig = JSON.stringify({ items, watch });
    if (store.get("push_sched") === sig) return;
    callBridge("/push/schedule", { items, watch }).then(() => store.set("push_sched", sig)).catch(() => {});
  }, [shop.plan?.created, planLen, shopStores.join(","), pushInfo.on]);

  // The "Økonomi" calendar for Google: madplan dinners, paydays, rent and trips (titles only, no amounts).
  // Sent to the worker whenever it changes; Google fetches it from /cal/<token>.ics.
  useEffect(() => {
    if (!prefs.calToken || !store.json(BRIDGE_KEY)) return;
    const items = [], now = new Date();
    for (let k = 0; k < 3; k++) {
      const pd = paydayIn(now.getFullYear(), now.getMonth() + k), d = isoDate(pd);
      items.push({ uid: `pay-${d}`, date: d, title: "💰 Løn og SU" });
      const end = isoDate(new Date(now.getFullYear(), now.getMonth() + k + 1, 0));
      if (rent?.amount) items.push({ uid: `rent-${end}`, date: end, title: "🏠 Husleje" });
    }
    if (shop.plan?.meals?.length) shop.plan.meals.forEach((m, i) => mealDays(i).forEach((k, j) => {
      const d = addDays(shop.plan.created, k);
      items.push({ uid: `meal-${d}`, date: d, time: "18:00", title: `🍽 ${m.name}`, desc: j === 0 ? `Lav til ${mealDays(i).length} ${mealDays(i).length === 1 ? "dag" : "dage"}. Se opskriften i appen.` : "Rester fra tidligere i ugen." });
    }));
    for (const t of rejse.trips || []) if (t.from) items.push({ uid: `trip-${t.id}`, date: t.from, endDate: t.to || t.from, title: `✈️ ${t.name}` });
    for (let k = 0; k < 14; k++) { const d = addDays(isoDate(now), k), s = sessionFor(training, d); if (s) items.push({ uid: `gym-${d}`, date: d, title: `🏋️ ${s}` }); }
    const ics = buildIcs(items), sig = ics.replace(/DTSTAMP:\S+/g, "");
    if (store.get("cal_pub_sig") === sig) return;
    callBridge("/calendar/publish", { token: prefs.calToken, ics }).then(() => store.set("cal_pub_sig", sig)).catch(() => {});
  }, [prefs.calToken, shop.plan?.created, planDays.join(","), rent?.amount, (rejse.trips || []).length, training.days.join(","), training.split.join(",")]);
  const deals = (shop.offerCheck?.deals || []).filter(d => (!d.till || Date.parse(d.till) >= Date.now()) && !shop.items.some(i => !i.done && i.name.toLowerCase() === d.term));
  useEffect(() => { try { foodBadge ? navigator.setAppBadge?.() : navigator.clearAppBadge?.(); } catch {} }, [foodBadge]);

  const makePlan = async () => {
    setPlanBusy(true);
    try {
      // Evenings out (calendar or the user's own marks) are skipped: no dinner to cook then.
      const evs = await refreshCalendar(false), today = isoDate(new Date());
      const home = [...Array(nights).keys()].filter(k => !awayFor(addDays(today, k), evs).away);
      const fromFreezer = shop.useFreezer !== false ? Math.min(freezerTotal, home.length * perNight) : 0;
      const cookNights = Math.max(0, home.length - Math.floor(fromFreezer / perNight));
      const days = home.slice(0, cookNights);
      const terms = [...new Set([...staples, ...mealPool.flatMap(m => m.ingredients)])];
      const lists = {};
      for (let i = 0; i < terms.length; i += 6) {
        const chunk = terms.slice(i, i + 6);
        (await Promise.all(chunk.map(offersFor))).forEach((l, k) => { lists[chunk[k]] = l; });
      }
      // Meals from the last plan the user chose to carry over: already bought, so they come first and cost nothing.
      const carried = (shop.plan?.meals || []).filter(m => !m.done && (shop.carry || []).includes(m.name))
        .map(m => ({ ...m, done: false, rate: undefined, carried: true, items: m.items.map(it => ({ ...it, offer: null, have: true, fresh: false })) }));
      const count = Math.max(0, Math.ceil(cookNights / cookDays) - carried.length);
      const r0 = planWeek(mealPool.filter(m => !carried.some(c => c.name === m.name)), lists, shopStores, count,
        { staples, rejected: shop.rejected || [], pantry, portions: cookDays * perNight, protein: shop.preferProtein !== false });
      const r = { ...r0, meals: [...carried, ...r0.meals] };
      let left = fromFreezer; const fz = [];
      for (const f of freezer) { if (left <= 0) break; const n = Math.min(left, +f.portions || 0); if (n) fz.push({ id: f.id, name: f.name, portions: n }); left -= n; }
      setShop(s => ({...s, carry: [], plan: { created: today, nights, cookDays, perNight, cookNights, days, freezer: fz, ...r }}));
    } finally { setPlanBusy(false); }
  };

  // Replace meal i with alternative k (default: the best one not in the plan); the old meal goes to the
  // back of the queue. Every alternative is already priced with this plan's stores.
  const replaceMeal = (i, k = 0) => {
    const plan = shop.plan;
    if (!plan?.alts?.[k]) return;
    const meals = plan.meals.slice(), next = { ...plan.alts[k], portions: meals[i].portions }, rest = plan.alts.filter((_, j) => j !== k);
    const old = meals[i]; meals[i] = next;
    // The store comparison was for the original meals, so it no longer applies after a swap.
    setShop(s => ({...s, plan: {...plan, meals, alts: [...rest, old], swapped: true, ...planCost(meals, plan.staples || [])}}));
    setPickMeal(null);
  };
  const setPortions = (i, n) => {
    const plan = shop.plan, meals = plan.meals.map((m, k) => k === i ? {...m, portions: n} : m);
    setShop(s => ({...s, plan: {...plan, meals, ...planCost(meals, plan.staples || [])}}));
  };
  // "Ikke det her": buy that item at normal price instead, and never suggest that product again.
  const rejectOffer = (heading) => {
    const plan = shop.plan, h = (heading || "").toLowerCase();
    const strip = (it) => it.offer && (it.offer.heading || "").toLowerCase() === h ? { ...it, offer: null } : it;
    const meals = plan.meals.map(m => ({ ...m, items: m.items.map(strip) })), fixed = (plan.staples || []).map(strip);
    setShop(s => ({...s, rejected: [...new Set([...(s.rejected || []), h])], plan: {...plan, meals, staples: fixed, ...planCost(meals, fixed)}}));
    flash("plan", `"${heading}" bliver ikke foreslået igen.`);
  };
  const randomMeal = (i) => { const n = shop.plan?.alts?.length || 0; if (n) replaceMeal(i, Math.floor(Math.random() * n)); };
  // "Lavet": rate the meal, note what to change next time, freeze leftovers and use up what was in the fridge.
  const finishMeal = (i) => {
    const m = shop.plan.meals[i], d = doneDraft;
    setShop(s => {
      const base = allMeals.find(x => x.name === m.name) || { name: m.name, ingredients: m.items.map(x => x.term) };
      const stored = (s.meals || []).find(x => x.name === m.name) || {};
      const note = d.note.trim();
      const patch = { up: (stored.up || 0) + (d.rate > 0 ? 1 : 0), down: (stored.down || 0) + (d.rate < 0 ? 1 : 0),
        notes: note ? [...(stored.notes || []), { date: isoDate(new Date()), text: note }] : stored.notes || [] };
      const usedFresh = m.items.filter(x => x.fresh).map(x => x.term);
      const pantryNow = (s.pantry ?? pantry).filter(p => p.always || !usedFresh.some(t => covers(p.term, t)));
      const freezerNow = d.freeze > 0 ? [...(s.freezer || []), { id: uid(), name: m.name, portions: d.freeze, date: isoDate(new Date()) }] : s.freezer || [];
      const meals = s.plan.meals.map((x, k) => k === i ? {...x, done: true, rate: d.rate} : x);
      return {...s, meals: mealPatch(s.meals, base, patch), pantry: pantryNow, freezer: freezerNow, plan: {...s.plan, meals}};
    });
    setDoneFor(null);
    flash("plan", d.freeze > 0 ? `${m.name} er gemt, og ${d.freeze} portioner ligger i fryseren.` : `${m.name} er gemt.`);
  };
  const stepper = (label, value, min, max, onSet) => html`<div style=${{display:"flex", alignItems:"center", gap:10}}>
    <span className="small" style=${{flex:1}}>${label}</span>
    <button className="icon-btn" aria-label=${`${label}: færre`} disabled=${value <= min} onClick=${()=>onSet(value - 1)}>−</button>
    <span className="num" style=${{minWidth:22, textAlign:"center", fontWeight:600}}>${value}</span>
    <button className="icon-btn" aria-label=${`${label}: flere`} disabled=${value >= max} onClick=${()=>onSet(value + 1)}>+</button>
  </div>`;
  const macroLine = (mc) => mc && mc.kcal ? html`<div className="small muted" style=${{marginTop:2}}>ca. ${mc.kcal} kcal · ${mc.p} g protein${+prefs.proteinGoal ? ` (${Math.round(mc.p / +prefs.proteinGoal * 100)} % af dagsmålet)` : ""} · ${mc.f} g fedt · ${mc.c} g kulhydrat pr. portion</div>` : null;
  const proteinChip = (p) => p == null ? null : html` <span className=${"chip " + (p >= 30 ? "info" : "")} style=${{fontSize:11, padding:"1px 7px", ...(p >= 30 ? {} : {border:"1px solid var(--border)"})}}>${p >= 30 ? "Proteinrig · " : ""}${p} g protein</span>`;
  const amountOf = (it, portions) => it.amt ? fmtAmount(it.amt[0] * portions, it.amt[1]) : it.per ? fmtAmount(it.per * portions, "g") : "";
  const qtyText = (b) => `${b.packs} ${b.packs === 1 ? "pakke" : "pakker"}${b.u && b.q ? ` · ${fmtAmount(b.q, b.u)}` : b.g ? ` · ca. ${fmtAmount(b.g, "g")}` : ""}`;

  const PlanTab = () => {
    const plan = shop.plan;
    // "Lør–Man", or "Fre, Søn–Man" when an evening out splits the days.
    const span = (i) => {
      if (!plan) return "";
      const start = new Date(plan.created + "T12:00:00"), day = (n) => WEEKDAYS[(start.getDay() + n) % 7].slice(0, 3);
      const runs = [];
      for (const d of mealDays(i)) { const r = runs[runs.length - 1]; if (r && d === r[1] + 1) r[1] = d; else runs.push([d, d]); }
      return runs.map(([a, b]) => a === b ? day(a) : `${day(a)}–${day(b)}`).join(", ");
    };
    const old = plan && !plan.buy; // a plan made before amounts and packs
    const shopping = {};
    if (plan && !old) for (const b of plan.buy) (shopping[b.offer ? b.offer.store : "Normalpris"] ||= []).push(b);
    const addToList = () => {
      const have = new Set(shop.items.map(i => i.name.toLowerCase()));
      const add = plan.buy.filter(b => !have.has(b.term.toLowerCase())).map(b => ({
        id: uid(), name: b.term, done: false, pick: b.offer?.id || null, qty: qtyText(b),
        snap: b.offer ? { id: b.offer.id, store: b.offer.store, price: b.offer.price * b.packs, heading: b.offer.heading, image: b.offer.image, till: b.offer.till }
          : { store: plan.stores[0], price: b.normal * b.packs, heading: "Normalpris", normal: true },
      }));
      setShop(s => ({...s, items: [...s.items, ...add]}));
      flash("plan", add.length ? `${add.length} varer lagt på indkøbslisten.` : "Alle varerne står allerede på listen.");
    };
    // What the card actually paid for food since the plan was made, against what the plan expected.
    const bought = plan && !old ? transactions.filter(t => t.category === FOOD_CAT && !t.trip && t.amount < 0 && t.date >= plan.created && t.date <= addDays(plan.created, plan.nights)) : [];
    const spent = -bought.reduce((s, t) => s + t.amount, 0);
    const chip = (it, portions) => html`<span key=${it.term} className=${"chip " + (it.offer ? "pos" : "")} style=${it.offer ? {} : {border: `1px ${it.have || it.staple ? "dashed" : "solid"} var(--border)`}}>${it.term}${amountOf(it, portions) ? ` ${amountOf(it, portions)}` : ""}${it.staple ? " · fast vare" : it.have ? " · har" : it.offer ? " · tilbud" : ""}</span>`;
    return html`<div>
      ${planEnded && (() => {
        const lastDay = WEEKDAYS[parseDKDate(addDays(plan.created, planLen - 1)).getDay()].toLowerCase();
        const unmade = plan.meals.filter(m => !m.done), carry = shop.carry || [];
        return html`<div className="card stack" style=${{marginBottom:12, borderLeft:"3px solid var(--accent)"}}>
          <div><b>Madplanen sluttede ${lastDay}.</b> Lav en ny for de næste ${nights} dage${newOffers ? " – der er også kommet nye tilbudsaviser" : ""}.</div>
          ${unmade.length > 0 && html`<div>
            <div className="small muted" style=${{marginBottom:6}}>Ikke markeret som lavet. Har du stadig ingredienserne, så tryk på retten – så kommer den med igen og købes ikke en gang til:</div>
            <div style=${{display:"flex", flexWrap:"wrap", gap:6}}>${unmade.map(m => { const on = carry.includes(m.name); return html`<button key=${m.name} className=${"chip " + (on ? "pos" : "")} style=${on ? {} : {border:"1px solid var(--border)"}} aria-pressed=${on}
              onClick=${()=>setShop(s => ({...s, carry: on ? carry.filter(x => x !== m.name) : [...carry, m.name]}))}>${on ? "✓ " : "+ "}${m.name}</button>`; })}</div>
          </div>`}
          <button className="btn primary block" disabled=${planBusy} onClick=${makePlan}>${planBusy ? "Finder tilbud…" : "Lav ny madplan"}</button>
        </div>`; })()}
      ${newOffers && !planEnded && html`<div className="tip tap" style=${{marginTop:0, marginBottom:12}} onClick=${makePlan}>
        <div className="sq sm" style=${{background:"var(--info-bg, var(--pos-bg))", color:"var(--info, var(--pos))"}}><${Icon} name="cart" /></div>
        <div>Der er kommet <b>nye tilbudsaviser</b> siden din madplan. Tryk her for at lave en ny.</div></div>`}
      <div className="card stack">
        <div className="small muted">Aftensmad ud fra ugens tilbud. Dine ♥-retter og dem, du har givet 👍, vælges oftere. Det, du har hjemme, bruges først.</div>
        ${stepper("Aftener", nights, 1, 14, v => setShop(s => ({...s, days: v})))}
        ${stepper("Dage pr. ret", cookDays, 1, 5, v => setShop(s => ({...s, cookDays: v})))}
        ${stepper("Portioner pr. aften", perNight, 1, 6, v => setShop(s => ({...s, perNight: v})))}
        <div>
          <div className="small" style=${{marginBottom:6}}>Laver du mad? <span className="faint">Tryk på en dag, hvor du ikke laver mad</span></div>
          <div className="day-chips">${[...Array(Math.max(7, nights)).keys()].map(k => { const date = addDays(isoDate(new Date()), k), a = awayFor(date), d = parseDKDate(date);
            return html`<button key=${date} className=${"day-chip " + (a.away ? "away" : "")} aria-pressed=${!a.away} title=${a.reason || ""} onClick=${()=>toggleAway(date)}>
              <b>${k === 0 ? "I dag" : k === 1 ? "I morgen" : WEEKDAYS[d.getDay()].slice(0, 3)}</b><span>${d.getDate()}/${d.getMonth() + 1}</span><i>${a.away ? (a.own ? "ude" : "📅 ude") : "🍽"}</i></button>`; })}</div>
          ${(() => { const out = [...Array(Math.max(7, nights)).keys()].map(k => addDays(isoDate(new Date()), k)).map(d => [d, awayFor(d)]).filter(([, a]) => a.away && a.reason && !a.own);
            return out.length > 0 && html`<div className="small faint" style=${{marginTop:6}}>Fra kalenderen: ${out.map(([d, a]) => `${WEEKDAYS[parseDKDate(d).getDay()].slice(0, 3).toLowerCase()} (${a.reason})`).join(", ")}.</div>`; })()}
          ${!prefs.calUrl && html`<div className="small faint" style=${{marginTop:6}}><button className="link-btn small" onClick=${()=>{ setPage("more"); setSub("calendar"); scrollToTop(); }}>Forbind din kalender</button>, så finder appen selv dage, hvor du ikke er hjemme.</div>`}
        </div>
        <div className="small faint">Hver ret laves til ${cookDays * perNight} ${cookDays * perNight === 1 ? "portion" : "portioner"}.${freezerTotal > 0 && shop.useFreezer !== false ? ` ${freezerTotal} ${freezerTotal === 1 ? "portion" : "portioner"} fra fryseren bruges først.` : ""}</div>
        <label style=${{display:"flex", alignItems:"center", gap:10}} className="small">
          <input type="checkbox" style=${{width:20, height:20, accentColor:"var(--accent)"}} checked=${shop.preferProtein !== false} onChange=${e=>setShop(s => ({...s, preferProtein: e.target.checked}))} />
          Vælg helst proteinrige retter
        </label>
        <label style=${{display:"flex", alignItems:"center", gap:10}} className="small">
          <span style=${{flex:1}}>Dagligt proteinmål</span>
          <input className="input sm" style=${{width:80, textAlign:"right"}} type="number" inputMode="numeric" value=${prefs.proteinGoal ?? ""} placeholder="fx 150" onChange=${e=>setPrefs(pr => ({ ...pr, proteinGoal: e.target.value }))} aria-label="Dagligt proteinmål i gram" /> g
        </label>
        <div>
          <div className="small" style=${{marginBottom:6}}>Faste varer hver uge</div>
          <div style=${{display:"flex", flexWrap:"wrap", gap:6, alignItems:"center"}}>
            ${staples.map(t => html`<button key=${t} className="chip info" aria-label=${`Fjern ${t} fra faste varer`} onClick=${()=>setShop(s => ({...s, staples: staples.filter(x => x !== t)}))}>${t} ✕</button>`)}
            <form style=${{display:"flex", gap:6}} onSubmit=${e=>{ e.preventDefault(); const t = stapleDraft.trim().toLowerCase(); if (t && !staples.includes(t)) setShop(s => ({...s, staples: [...staples, t], offerCheck: null})); setStapleDraft(""); }}>
              <input className="input sm" style=${{width:130}} value=${stapleDraft} onChange=${e=>setStapleDraft(e.target.value)} placeholder="+ fx skyr" aria-label="Tilføj fast vare" />
            </form>
          </div>
        </div>
        ${(shop.rejected || []).length > 0 && html`<div className="small faint">${shop.rejected.length} tilbud er fravalgt. <button className="link-btn small" onClick=${()=>setShop(s => ({...s, rejected: []}))}>Nulstil</button></div>`}
        <button className="btn primary block" disabled=${planBusy || !mealPool.length} onClick=${makePlan}>${planBusy ? "Finder tilbud…" : plan ? "Lav ny madplan" : "Lav madplan"}</button>
      </div>

      ${plan && !old && html`<div>
        <div className="tip" style=${{marginTop:12}}>
          <div className="sq sm" style=${{background:"var(--pos-bg)", color:"var(--pos)"}}><${Icon} name="cart" /></div>
          <div>${plan.meals.length ? html`Gå i <b>${plan.stores.join(" og ")}</b>. Indkøbet koster ca. <b>${kr(Math.round(plan.total))}</b>${plan.normal > plan.total ? html` – du sparer ca. <b className="pos">${kr(Math.round(plan.normal - plan.total))}</b> mod normalpris` : ""}` : "Fryseren rækker til alle aftenerne – du skal ikke købe ind til aftensmad."}</div>
        </div>
        ${(() => { const goal = +prefs.proteinGoal || 0, ps = plan.meals.map(m => m.macros?.p ?? m.protein).filter(x => x > 0);
          if (!goal || !ps.length) return null;
          const avg = Math.round(ps.reduce((a, b) => a + b, 0) / ps.length), rest = Math.max(0, goal - avg), pct = Math.min(100, avg / goal * 100);
          return html`<div className="card stack" style=${{marginTop:8, gap:8}}>
            <div style=${{display:"flex", justifyContent:"space-between", gap:10}} className="small"><span>Aftensmaden giver i snit <b>${avg} g protein</b> om dagen</span><span className="muted">mål ${goal} g</span></div>
            <div className="bar" style=${{height:8}}><div style=${{width:`${pct}%`, background:"var(--accent)"}}></div></div>
            <div className="small muted">${rest > 0 ? html`Du mangler ca. <b>${rest} g</b> fra morgenmad, frokost og mellemmåltider – fx 250 g skyr (25 g), 100 g kyllingepålæg (23 g), 3 æg (19 g) eller 100 g hytteost (13 g).` : "Aftensmaden dækker hele dit mål. 💪"}</div>
          </div>`; })()}
        ${bought.length > 0 && html`<div className="small" style=${{margin:"8px 2px 0"}}>Siden ${shortDate(plan.created)} har du købt mad for <b className=${spent > plan.total * 1.15 ? "neg" : ""}>${fmt(spent)}</b> (${bought.length} køb) – planen regnede med ca. ${fmt(Math.round(plan.total))}</div>`}
        ${plan.swapped && html`<div className="small faint" style=${{margin:"8px 2px 0"}}>Du har ændret planen. Tryk <b>Lav ny madplan</b> for at sammenligne butikkerne igen.</div>`}
        ${plan.compare?.length > 1 && !plan.swapped && html`<div className="card" style=${{marginTop:8}}>
          <div className="small muted" style=${{marginBottom:6}}>Hele indkøbet inkl. varer til normalpris</div>
          <div className="stack" style=${{gap:4}}>${plan.compare.map((c, i) => html`<div key=${i} style=${{display:"flex", justifyContent:"space-between", gap:12, fontWeight: i === 0 ? 600 : 400}}>
            <span>${i === 0 ? "✓ " : ""}${c.stores.join(" + ")}</span><span className="num">ca. ${kr(Math.round(c.total))}</span></div>`)}</div>
        </div>`}

        <div className="section">
          <div className="section-head"><h2>Madplan</h2><span className="small faint">lavet ${shortDate(plan.created)}</span></div>
          <div className="list">${plan.staples?.length > 0 && html`<div className="row" style=${{alignItems:"flex-start"}}>
            <div style=${{width:76, flexShrink:0, fontWeight:600, paddingTop:2}}>Fast</div>
            <div className="main"><div style=${{display:"flex", flexWrap:"wrap", gap:4}}>${plan.staples.map(it => html`<span key=${it.term} className=${"chip " + (it.offer ? "pos" : "")} style=${it.offer ? {} : {border:"1px solid var(--border)"}}>${it.term} · ${it.offer ? kr(it.offer.price) : `ca. ${kr(it.normal)}`}</span>`)}</div></div>
          </div>`}${plan.meals.map((m, i) => {
            const rec = allMeals.find(x => x.name === m.name), lastNote = rec?.notes?.[rec.notes.length - 1];
            const st = mealState(i);
            return html`<div key=${i} className="row" style=${{alignItems:"flex-start", opacity: m.done || st === "past" ? .55 : 1}}>
            <div style=${{width:76, flexShrink:0, fontWeight:600, paddingTop:2}}>${span(i)}${st === "now" && !planEnded ? html`<div><span className="chip info" style=${{fontSize:11, padding:"1px 8px", marginTop:4, display:"inline-block"}}>I dag</span></div>` : null}</div>
            <div className="main">
              <div className="title" style=${{whiteSpace:"normal"}}>${m.done ? "✓ " : m.fav ? "♥ " : ""}${m.name}${proteinChip(m.protein)}</div>
              ${macroLine(m.macros)}
              <div className="small muted" style=${{marginTop:2}}>${m.carried ? "Fra sidste plan · " : ""}${m.portions} portioner${m.done ? ` · lavet${m.rate > 0 ? " 👍" : m.rate < 0 ? " 👎" : ""}` : ""}</div>
              ${lastNote && html`<div className="small" style=${{marginTop:4}}>📝 Næste gang: ${lastNote.text}</div>`}
              <div style=${{display:"flex", flexWrap:"wrap", gap:4, marginTop:6}}>${m.items.map(it => chip(it, m.portions))}</div>
              ${!m.done && html`<div style=${{display:"flex", flexWrap:"wrap", gap:14, marginTop:6, alignItems:"center"}}>
                ${plan.alts?.length > 0 && html`<button className="link-btn small" onClick=${()=>replaceMeal(i)}>Byt</button>
                <button className="link-btn small" onClick=${()=>randomMeal(i)}>Tilfældig</button>
                <button className="link-btn small" aria-expanded=${pickMeal === i} onClick=${()=>setPickMeal(pickMeal === i ? null : i)}>${pickMeal === i ? "Luk" : "Vælg selv"}</button>`}
                <span style=${{display:"inline-flex", alignItems:"center", gap:4}}>
                  <button className="icon-btn" style=${{width:30, height:30}} aria-label="Færre portioner" disabled=${m.portions <= 1} onClick=${()=>setPortions(i, m.portions - 1)}>−</button>
                  <span className="small num">${m.portions} port.</span>
                  <button className="icon-btn" style=${{width:30, height:30}} aria-label="Flere portioner" disabled=${m.portions >= 16} onClick=${()=>setPortions(i, m.portions + 1)}>+</button>
                </span>
                ${(rec?.url || m.url || MEAL_STEPS[m.name]) && html`<button className="link-btn small" style=${{fontWeight:600}} onClick=${()=>openCook(rec || { name: m.name, url: m.url, ingredients: m.items.map(x => x.term) }, m.portions)}>Se opskrift</button>`}
                <button className="link-btn small" aria-expanded=${doneFor === i} onClick=${()=>{ setDoneFor(doneFor === i ? null : i); setDoneDraft({ rate: 0, note: "", freeze: Math.max(0, m.portions - plan.cookDays * (plan.perNight || 1)) }); }}>${doneFor === i ? "Luk" : "Lavet ✓"}</button>
              </div>`}
              ${doneFor === i && html`<div className="card stack" style=${{marginTop:8, padding:12, background:"var(--surface-2, var(--bg))"}}>
                <div className="small">Hvordan var den?</div>
                <div style=${{display:"flex", gap:8}}>
                  <button className=${"chip " + (doneDraft.rate > 0 ? "pos" : "")} style=${doneDraft.rate > 0 ? {} : {border:"1px solid var(--border)"}} aria-pressed=${doneDraft.rate > 0} onClick=${()=>setDoneDraft({...doneDraft, rate: doneDraft.rate > 0 ? 0 : 1})}>👍 Lav den igen</button>
                  <button className=${"chip " + (doneDraft.rate < 0 ? "neg" : "")} style=${doneDraft.rate < 0 ? {} : {border:"1px solid var(--border)"}} aria-pressed=${doneDraft.rate < 0} onClick=${()=>setDoneDraft({...doneDraft, rate: doneDraft.rate < 0 ? 0 : -1})}>👎 Sjældnere</button>
                </div>
                <input className="input sm" value=${doneDraft.note} onChange=${e=>setDoneDraft({...doneDraft, note: e.target.value})} placeholder="Næste gang: fx mere chili, dobbelt op på kylling" aria-label="Note til næste gang" />
                ${stepper("Portioner i fryseren", doneDraft.freeze, 0, m.portions, v => setDoneDraft({...doneDraft, freeze: v}))}
                ${m.items.some(x => x.fresh) && html`<div className="small faint">${m.items.filter(x => x.fresh).map(x => x.term).join(", ")} fjernes fra "Har lige nu".</div>`}
                <button className="btn primary" onClick=${()=>finishMeal(i)}>Gem</button>
              </div>`}
              ${pickMeal === i && html`<div className="list" style=${{marginTop:8}}>${plan.alts
                .map((a, k) => ({ a, k, hits: a.items.filter(x => x.offer).length }))
                .sort((x, y) => (y.a.fav - x.a.fav) || x.a.name.localeCompare(y.a.name, "da"))
                .map(({ a, k, hits }) => html`<button key=${a.mealId || a.name} className="row" style=${{minHeight:44}} onClick=${()=>replaceMeal(i, k)}>
                  <div className="main"><div className="title" style=${{whiteSpace:"normal"}}>${a.fav ? "♥ " : ""}${a.name}</div>${a.protein != null && html`<div className="sub">${a.protein} g protein</div>`}</div>
                  <div className=${"end small " + (hits ? "pos" : "muted")}>${hits}/${a.items.length} på tilbud</div>
                </button>`)}</div>`}
            </div>
          </div>`; })}${plan.freezer?.length > 0 && html`<div className="row" style=${{alignItems:"flex-start"}}>
            <div style=${{width:76, flexShrink:0, fontWeight:600, paddingTop:2}}>Fryser</div>
            <div className="main"><div className="title" style=${{whiteSpace:"normal"}}>${plan.freezer.map(f => `${f.portions}× ${f.name}`).join(", ")}</div><div className="sub" style=${{whiteSpace:"normal"}}>Tryk <b>Spist én</b> under Hjemme, når du tager en portion.</div></div>
          </div>`}</div>
        </div>

        ${plan.buy.length > 0 && html`<div className="section">
          <div className="section-head"><h2>Det skal du købe</h2></div>
          <div className="stack-gap">${Object.entries(shopping).sort(([x], [y]) => (x === "Normalpris") - (y === "Normalpris")).map(([store, items]) => html`<div key=${store}>
            <div className="small muted" style=${{margin:"4px 2px 6px", fontWeight:600}}>${store === "Normalpris" ? `Normalpris – køb i ${plan.stores[0]}` : `${store} – tilbud`}</div>
            <div className="list">${items.map(it => html`<div key=${it.term} className="row" style=${{minHeight:48}}>
              ${it.offer?.image ? html`<img src=${it.offer.image} alt="" loading="lazy" style=${{width:36, height:36, objectFit:"contain", borderRadius:6, background:"#fff"}} />` : null}
              <div className="main"><div className="title" style=${{whiteSpace:"normal"}}>${it.term} <span className="small muted" style=${{fontWeight:400}}>· ${qtyText(it)}</span></div>${it.offer && html`<div className="sub" style=${{whiteSpace:"normal"}}>${it.offer.heading}${it.packs > 1 ? ` · ${kr(it.offer.price)} stk.` : ""}</div>`}</div>
              <div className="end"><div className="num">${it.offer ? kr(Math.round(it.offer.price * it.packs * 100) / 100) : `ca. ${kr(it.normal * it.packs)}`}</div>
                ${it.offer && html`<button className="link-btn small" onClick=${()=>rejectOffer(it.offer.heading)}>Ikke det her</button>`}</div>
            </div>`)}</div>
          </div>`)}</div>
          <div className="small faint" style=${{marginTop:8}}>Mængderne lægges sammen på tværs af retterne og rundes op til hele pakker (pakkestørrelser og normalpriser er skøn). Det, du har hjemme, er trukket fra.</div>
          <button className="btn soft block" style=${{marginTop:12}} onClick=${addToList}><${Icon} name="plus" /> Læg det hele på indkøbslisten</button>
        </div>`}
        <${Msg} k="plan" />
      </div>`}
      ${old && html`<div className="card empty" style=${{marginTop:12}}>Madplanen er lavet om. Tryk <b>Lav ny madplan</b>.</div>`}
      ${StoresBlock()}
    </div>`;
  };

  // Fetch a recipe through the worker and add it as a meal (or refresh the meal with the same link).
  const fetchMeal = async (u) => {
    const m = mealFromRecipe(await callBridge("/recipe", { url: u }), u);
    if (!m.ingredients.length) throw new Error("Fandt ingen ingredienser i opskriften.");
    return m;
  };
  const storeMeal = (m, into) => setShop(s => {
    const meals = s.meals || [], same = into || meals.find(x => x.url === m.url) || allMeals.find(x => x.url === m.url);
    const patch = { ingredients: m.ingredients, amounts: m.amounts, servings: m.servings, url: m.url, lines: m.lines, steps: m.steps, minutes: m.minutes, image: m.image };
    if (same) return {...s, meals: mealPatch(meals, same, patch)};
    const name = allMeals.some(x => x.name === m.name) ? `${m.name} (Valdemarsro)` : m.name;
    return {...s, meals: [...meals, { id: uid(), fav: false, ...m, name }]};
  });
  const importRecipe = async (url, into) => {
    const u = (url || "").trim();
    if (!/^https?:\/\//.test(u)) { flash("meals", "Fejl: indsæt hele linket, fx https://www.valdemarsro.dk/dhal/"); return; }
    setImportBusy(into?.name || "new");
    try {
      const m = await fetchMeal(u);
      storeMeal(m, into);
      flash("meals", `${into ? "Opdateret" : "Tilføjet"}: ${m.name} – ${m.ingredients.length} ingredienser til ${m.servings} portioner. Tjek dem under Mængder.`, 8000);
      setImportUrl(""); setOpenRecipe(into?.name || m.name);
    } catch (e) { flash("meals", "Fejl: " + (e.message || e), 9000); }
    finally { setImportBusy(null); }
  };
  // Add several Valdemarsro dinners in a row (one request at a time, so the site isn't hammered).
  const addValdemarsro = async (list) => {
    let ok = 0, fail = 0;
    for (let i = 0; i < list.length; i++) {
      setVrBusy({ done: i, total: list.length });
      try { storeMeal(await fetchMeal(VR_URL(list[i][0]))); ok++; } catch (e) { fail++; if (e.status === 401 || e.code === "secret" || e instanceof NoBridgeError) { flash("meals", "Fejl: " + e.message, 9000); break; } }
      await new Promise(r => setTimeout(r, 400));
    }
    setVrBusy(null);
    flash("meals", `${ok} ${ok === 1 ? "ret" : "retter"} fra Valdemarsro er tilføjet${fail ? `, ${fail} kunne ikke hentes` : ""}. Tryk ♥ ved dem, du vil have oftere.`, 9000);
  };
  // "Se opskrift": the method is fetched the first time and kept with the meal (on this device only).
  const openCook = async (m, portions = null) => {
    setCookFor(m.name); setCookDone([]); setCookPortions(portions);
    if (m.steps?.length || !m.url || MEAL_STEPS[m.name]) return;
    setCookLoading(true);
    try { storeMeal(await fetchMeal(m.url), m); }
    catch (e) { flash("cook", "Fejl: " + (e.message || e), 9000); }
    finally { setCookLoading(false); }
  };
  useEffect(() => {
    if (!cookFor || !navigator.wakeLock) return;
    let lock = null; navigator.wakeLock.request("screen").then(l => { lock = l; }).catch(() => {});
    return () => { lock?.release?.().catch(() => {}); };
  }, [cookFor]);

  const CookView = () => {
    const m = allMeals.find(x => x.name === cookFor);
    if (!m) return null;
    const own = MEAL_STEPS[m.name], steps = m.steps?.length ? m.steps : own?.[1] || [], am = mealAmounts(m), base = mealServings(m);
    const por = cookPortions || base, k = por / base, minutes = m.minutes || own?.[0];
    let n = 0;
    return html`<div className="cook-sheet" role="dialog" aria-modal="true" aria-label=${m.name}>
      <div className="cook-inner">
        <div style=${{display:"flex", alignItems:"flex-start", gap:10}}>
          <div style=${{flex:1}}>
            <div style=${{fontSize:22, fontWeight:700, lineHeight:1.2}}>${m.name}</div>
            <div className="small muted" style=${{marginTop:4}}>${m.lines?.length ? base : por} portioner${minutes ? ` · ca. ${minutes} min.` : ""}${m.url ? html` · <a href=${m.url} target="_blank" rel="noopener" className="link-btn small">Original opskrift ↗</a>` : ""}</div>
          </div>
          <button className="icon-btn" aria-label="Luk opskriften" onClick=${()=>setCookFor(null)}>✕</button>
        </div>
        ${macroLine(mealMacros(m))}
        <div className="section-head" style=${{marginTop:18}}><h2>Ingredienser</h2></div>
        ${m.lines?.length && por !== base ? html`<div className="small muted" style=${{marginBottom:6}}>Opskriften er til ${base} portioner – du laver ${por}, så gang mængderne med ${String(Math.round(k * 100) / 100).replace(".", ",")}.</div>` : null}
        <ul className="cook-ings">${(m.lines?.length ? m.lines : m.ingredients.map(t => `${am[t] ? fmtAmount(am[t][0] * k, am[t][1]) + " " : ""}${t}`)).map((l, i) => html`<li key=${i}>${l}</li>`)}</ul>
        <div className="section-head" style=${{marginTop:18}}><h2>Sådan gør du</h2>${steps.length > 0 && html`<span className="small faint">Tryk på et trin, når det er klaret</span>`}</div>
        ${cookLoading ? html`<div className="card empty">Henter fremgangsmåden…</div>`
          : steps.length ? html`<ol className="cook-steps">${steps.map((st, i) => st.startsWith("## ")
              ? html`<li key=${i} className="sub">${st.slice(3)}</li>`
              : html`<li key=${i} className=${cookDone.includes(i) ? "done" : ""} onClick=${()=>setCookDone(cookDone.includes(i) ? cookDone.filter(x => x !== i) : [...cookDone, i])}><span className="n">${++n}</span><span>${st}</span></li>`)}</ol>`
          : html`<div className="card empty">${m.url ? "Fremgangsmåden kunne ikke hentes. Opdater workeren i Cloudflare, eller åbn den originale opskrift." : "Retten har ikke noget link til en opskrift. Tilføj et under Retter, eller vælg en ret fra Valdemarsro."}</div>`}
        <${Msg} k="cook" />
        ${m.url?.includes("valdemarsro") && html`<div className="small faint" style=${{marginTop:16}}>Opskrift fra Valdemarsro.dk – vist til eget brug. Se den originale opskrift for billeder og tips.</div>`}
        ${MEAL_SOURCE[m.name] && html`<div className="small faint" style=${{marginTop:16}}>Baseret på en opskrift fra ${MEAL_SOURCE[m.name].site}. Fremgangsmåden er skrevet kort her – se den originale opskrift for alle detaljer.</div>`}
      </div>
    </div>`;
  };

  const MealsTab = () => {
    const meals = shop.meals || [];
    const parse = (txt) => txt.split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
    const update = updateMeal;
    const addOwn = () => {
      const name = mealDraft.name.trim(), ingredients = mealDraft.items || [];
      if (!name || !ingredients.length) return;
      const url = /^https?:\/\//.test(mealDraft.url.trim()) ? mealDraft.url.trim() : null;
      setShop(s => ({...s, meals: [...(s.meals || []), { id: uid(), name, ingredients, fav: true, url }]})); setMealDraft({ name: "", ingredients: "", url: "", items: [] }); setIngSearch(""); setIngGroup(null);
    };
    // Pick ingredients by category (tabs like the shop's departments), or search across all of them.
    const Picker = (haveList, onAdd, extras = [], extrasLabel = "") => {
      const have = new Set(haveList);
      const add = (t) => { const v = t.trim().toLowerCase(); if (v && !have.has(v)) onAdd(v); };
      const q = ingSearch.trim().toLowerCase();
      const chip = (t) => html`<button key=${t} className="chip info" onClick=${()=>add(t)}>+ ${t}</button>`;
      const ex = extras.filter(t => !have.has(t));
      const known = INGREDIENT_GROUPS.some(([, l]) => l.includes(q));
      const hits = q ? INGREDIENT_GROUPS.flatMap(([, l]) => l).filter(t => !have.has(t) && t.includes(q)) : [];
      const open = INGREDIENT_GROUPS.find(([g]) => g === ingGroup);
      return html`<div className="card stack" style=${{marginTop:8, padding:12, background:"var(--surface-2, var(--bg))"}}>
        <form onSubmit=${e=>{ e.preventDefault(); if (q) { add(q); setIngSearch(""); } }}>
          <input className="input sm" value=${ingSearch} onChange=${e=>setIngSearch(e.target.value)} placeholder="Søg i alle varer" aria-label="Søg ingrediens" />
        </form>
        ${q ? html`<div style=${{display:"flex", flexWrap:"wrap", gap:5}}>${hits.map(chip)}${!known && !have.has(q) && html`<button className="chip" style=${{border:"1px dashed var(--border)"}} onClick=${()=>{ add(q); setIngSearch(""); }}>+ Tilføj "${q}"</button>`}</div>` : html`
          <div className="cat-tabs" role="tablist">${INGREDIENT_GROUPS.map(([g]) => html`<button key=${g} role="tab" aria-selected=${ingGroup === g} className=${ingGroup === g ? "on" : ""} onClick=${e=>{ setIngGroup(ingGroup === g ? null : g); e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" }); }}>${g}</button>`)}</div>
          ${open ? html`<div style=${{display:"flex", flexWrap:"wrap", gap:5}}>${open[1].filter(t => !have.has(t)).map(chip)}</div>`
            : ex.length > 0 ? html`<div><div className="small muted" style=${{marginBottom:5}}>${extrasLabel}</div><div style=${{display:"flex", flexWrap:"wrap", gap:5}}>${ex.map(chip)}</div></div>`
            : html`<div className="small faint">Vælg en kategori ovenfor.</div>`}`}
      </div>`;
    };
    const IngredientPicker = (m) => Picker(m.ingredients, (v) => update(m, { ingredients: [...m.ingredients, v] }), MEAL_EXTRAS[m.name] || [], `Forslag til ${m.name.toLowerCase()}`);
    // Amounts, scaled to the number of portions shown; an edited number is stored for the recipe's own servings.
    const RecipeView = (m) => {
      const base = mealServings(m), view = viewServings[m.name] || base, k = view / base, am = mealAmounts(m), prot = mealProtein(m);
      const setAmt = (t, q, u) => update(m, { servings: base, amounts: {...am, [t]: [q / k, u]} });
      return html`<div className="card stack" style=${{marginTop:8, padding:12, background:"var(--surface-2, var(--bg))"}}>
        ${stepper("Portioner", view, 1, 16, v => setViewServings({...viewServings, [m.name]: v}))}
        ${(() => { const mc = mealMacros(m); return mc && html`<div className="macro-grid">
          <div><b>${mc.kcal}</b><span>kcal</span></div><div><b>${mc.p} g</b><span>protein</span></div><div><b>${mc.f} g</b><span>fedt</span></div><div><b>${mc.c} g</b><span>kulhydrat</span></div>
        </div>`; })()}
        ${prot != null && html`<div className="small faint">Pr. portion. Næringsindhold fra REMA 1000's varedeklarationer, grønt og krydderier er standardværdier.</div>`}
        <div className="stack" style=${{gap:6}}>${m.ingredients.map(t => html`<div key=${t} style=${{display:"flex", alignItems:"center", gap:6}}>
          <span className="small" style=${{flex:1, minWidth:0}}>${t}</span>
          <input key=${t + view + (am[t] || []).join()} className="input sm" style=${{width:72, textAlign:"right"}} inputMode="decimal" defaultValue=${am[t] ? String(nice(am[t][0] * k)).replace(".", ",") : ""} placeholder="?" aria-label=${`Mængde ${t}`}
            onKeyDown=${e=>{ if (e.key === "Enter") e.target.blur(); }}
            onBlur=${e=>{ const v = parseFloat(e.target.value.replace(",", ".")); if (v > 0 && v !== nice((am[t]?.[0] || 0) * k)) setAmt(t, v, am[t]?.[1] || "g"); }} />
          <select className="input sm" style=${{width:92}} value=${am[t]?.[1] || "g"} aria-label=${`Enhed ${t}`} onChange=${e=>setAmt(t, (am[t]?.[0] || 0) * k, e.target.value)}>
            ${UNITS.map(u => html`<option key=${u} value=${u}>${u}</option>`)}</select>
        </div>`)}</div>
        <div className="small faint">Mængderne er til ${view} ${view === 1 ? "portion" : "portioner"}. Ret et tal, så gemmes det.${m.url && !m.amounts ? "" : ""}</div>
        ${m.url && html`<button className="btn soft" disabled=${!!importBusy} onClick=${()=>importRecipe(m.url, m)}>${importBusy === m.name ? "Henter…" : m.amounts ? "Hent mængder fra opskriften igen" : "Hent mængder fra opskriften"}</button>`}
        ${m.notes?.length > 0 && html`<div><div className="small muted" style=${{marginBottom:4}}>Dine noter</div>${m.notes.slice(-5).reverse().map((n, j) => html`<div key=${j} className="small">📝 ${shortDate(n.date)}: ${n.text}</div>`)}</div>`}
      </div>`;
    };
    return html`<div>
      <div className="card stack" style=${{marginBottom:12}}>
        <div className="small muted">Hent en opskrift fra et link (fx Valdemarsro). Appen laver retten med ingredienser og mængder.</div>
        <form style=${{display:"flex", gap:8}} onSubmit=${e=>{ e.preventDefault(); importRecipe(importUrl); }}>
          <input className="input" style=${{flex:1}} type="url" value=${importUrl} onChange=${e=>setImportUrl(e.target.value)} placeholder="https://www.valdemarsro.dk/…" aria-label="Link til opskrift" />
          <button className="btn primary" type="submit" disabled=${!importUrl.trim() || !!importBusy}>${importBusy === "new" ? "Henter…" : "Hent"}</button>
        </form>
        <${Msg} k="meals" />
      </div>
      ${(() => {
        const have = new Set(allMeals.map(m => m.url).filter(Boolean));
        const list = VALDEMARSRO.filter(([, , tag]) => !vrTag || tag === vrTag), missing = list.filter(([slug]) => !have.has(VR_URL(slug)));
        return html`<div className="card stack" style=${{marginBottom:12}}>
          <button className="row" style=${{padding:0, minHeight:0, background:"none", border:0, color:"inherit", textAlign:"left"}} aria-expanded=${vrOpen} onClick=${()=>setVrOpen(!vrOpen)}>
            <div className="main"><div className="title">Retter fra Valdemarsro</div><div className="sub">${VALDEMARSRO.length} aftensretter · ${VALDEMARSRO.filter(([slug]) => have.has(VR_URL(slug))).length} tilføjet</div></div>
            <div className="end small link-btn">${vrOpen ? "Skjul" : "Vis"}</div>
          </button>
          ${vrOpen && html`<div className="stack" style=${{gap:10}}>
            <div className="cat-tabs">${VR_TAGS.map(t => html`<button key=${t} className=${vrTag === t ? "on" : ""} aria-pressed=${vrTag === t} onClick=${()=>setVrTag(vrTag === t ? null : t)}>${t}</button>`)}</div>
            ${vrBusy ? html`<div className="small">Henter ${vrBusy.done + 1} af ${vrBusy.total}…</div><div className="bar" style=${{height:6}}><div style=${{width:`${vrBusy.done / vrBusy.total * 100}%`, background:"var(--accent)"}}></div></div>`
              : missing.length > 0 && html`<button className="btn soft block" onClick=${()=>addValdemarsro(missing)}>Tilføj ${missing.length === list.length ? "alle" : "de"} ${missing.length}${vrTag ? ` ${vrTag.toLowerCase()}-retter` : ""}</button>`}
            <div className="list">${list.map(([slug, name, tag]) => { const added = have.has(VR_URL(slug)); return html`<div key=${slug} className="row" style=${{minHeight:46}}>
              <div className="main"><div className="title" style=${{whiteSpace:"normal"}}>${name}</div><div className="sub">${tag}</div></div>
              <div className="end">${added ? html`<span className="small pos">✓ Tilføjet</span>` : html`<button className="link-btn small" disabled=${!!vrBusy} onClick=${()=>addValdemarsro([[slug, name, tag]])}>Tilføj</button>`}</div>
            </div>`; })}</div>
            <div className="small faint">Ingredienser og mængder hentes fra valdemarsro.dk, når du tilføjer en ret. Fremgangsmåden ser du under <b>Se opskrift</b>.</div>
          </div>`}
        </div>`; })()}
      <div className="small muted" style=${{margin:"0 2px 10px"}}>♥ = vælges oftere. <b>Gider ikke</b> = kommer aldrig med i madplanen. Tryk ✕ for at fjerne en ingrediens, <b>+ Ingrediens</b> for at tilføje og <b>Mængder</b> for gram og portioner.</div>
      <div className="list">${allMeals.map(m => html`<div key=${m.id} className="row" style=${{alignItems:"flex-start", flexWrap:"wrap", opacity: m.skip ? .45 : 1}}>
        <button className="icon-btn" style=${{color: m.fav ? "var(--neg)" : "var(--text-3)", fontSize:20}} aria-pressed=${!!m.fav} aria-label=${`${m.name}: yndlingsret`} disabled=${m.skip}
          onClick=${()=>update(m, { fav: !m.fav })}>${m.fav ? "♥" : "♡"}</button>
        <div className="main">
          <div className="title" style=${{whiteSpace:"normal"}}>${m.name}${proteinChip(mealProtein(m))}${(m.up || m.down) ? html` <span className="small muted" style=${{fontWeight:400}}>${m.up ? ` 👍${m.up}` : ""}${m.down ? ` 👎${m.down}` : ""}</span>` : null}${m.minutes ? html` <span className="small muted" style=${{fontWeight:400}}>· ${m.minutes} min.</span>` : null}${MEAL_SOURCE[m.name] ? html` <span className="small muted" style=${{fontWeight:400}}>· ${MEAL_SOURCE[m.name].site}</span>` : m.url?.includes("valdemarsro") ? html` <span className="small muted" style=${{fontWeight:400}}>· Valdemarsro</span>` : null}</div>
          ${m.skip
            ? html`<div className="sub">Kommer ikke med i madplanen</div>`
            : html`<div style=${{display:"flex", flexWrap:"wrap", gap:5, marginTop:6}}>
                ${m.ingredients.map(t => html`<button key=${t} className="chip" style=${{border:"1px solid var(--border)"}} aria-label=${`Fjern ${t} fra ${m.name}`}
                  onClick=${()=>{ if (m.ingredients.length > 1) update(m, { ingredients: m.ingredients.filter(x => x !== t) }); }}>${t}${m.ingredients.length > 1 ? " ✕" : ""}</button>`)}
                <button className="chip info" aria-expanded=${ingFor === m.name} onClick=${()=>{ setIngFor(ingFor === m.name ? null : m.name); setIngSearch(""); }}>${ingFor === m.name ? "Færdig" : "+ Ingrediens"}</button>
              </div>
`}
        </div>
        <div className="end" style=${{display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4}}>
          ${(m.url || MEAL_STEPS[m.name]) && !m.skip && html`<button className="link-btn small" style=${{fontWeight:600}} onClick=${()=>openCook(m)}>Se opskrift</button>`}
          ${!m.skip && html`<button className="link-btn small" aria-expanded=${openRecipe === m.name} onClick=${()=>setOpenRecipe(openRecipe === m.name ? null : m.name)}>${openRecipe === m.name ? "Luk" : "Mængder"}</button>`}
          <button className="link-btn small" onClick=${()=>update(m, { skip: !m.skip, fav: false })}>${m.skip ? "Brug igen" : "Gider ikke"}</button>
          ${!m.template && !MEAL_TEMPLATES.some(([n]) => n === m.name) && html`<button className="link-btn small" onClick=${()=>{ const prev = meals; setShop(s => ({...s, meals: (s.meals || []).filter(x => x.id !== m.id)})); showUndo(`${m.name} er slettet`, () => setShop(s => ({...s, meals: prev}))); }}>Slet</button>`}
        </div>
        ${!m.skip && (ingFor === m.name || openRecipe === m.name) && html`<div style=${{flexBasis:"100%", minWidth:0}}>
          ${ingFor === m.name && IngredientPicker(m)}
          ${openRecipe === m.name && RecipeView(m)}
        </div>`}
      </div>`)}</div>
      <div className="section">
        <div className="section-head"><h2>Tilføj din egen ret</h2></div>
        <div className="card stack">
          <input className="input" placeholder="Navn, fx Mormors boller i karry" value=${mealDraft.name} onChange=${e=>setMealDraft({...mealDraft, name: e.target.value})} aria-label="Rettens navn" />
          <div>
            <div className="small muted" style=${{marginBottom:6}}>Ingredienser ${(mealDraft.items || []).length ? "– tryk for at fjerne. Den første er hovedingrediensen." : ""}</div>
            <div style=${{display:"flex", flexWrap:"wrap", gap:5}}>${(mealDraft.items || []).length
              ? mealDraft.items.map(t => html`<button key=${t} className="chip" style=${{border:"1px solid var(--border)"}} aria-label=${`Fjern ${t}`} onClick=${()=>setMealDraft({...mealDraft, items: mealDraft.items.filter(x => x !== t)})}>${t} ✕</button>`)
              : html`<span className="small faint">Ingen endnu – vælg nedenfor.</span>`}</div>
            ${ingFor === null && Picker(mealDraft.items || [], (v) => setMealDraft(d => ({...d, items: [...(d.items || []), v]})))}
          </div>
          <input className="input" type="url" placeholder="Link til opskriften (valgfrit)" value=${mealDraft.url} onChange=${e=>setMealDraft({...mealDraft, url: e.target.value})} aria-label="Link til opskriften" />
          <button className="btn primary" disabled=${!mealDraft.name.trim() || !(mealDraft.items || []).length} onClick=${addOwn}>Tilføj ret</button>
        </div>
      </div>
    </div>`;
  };

  // What's at home: the fridge/cupboard (used first by the plan, never bought) and the freezer.
  const HomeTab = () => {
    const setPantry = (p) => setShop(s => ({...s, pantry: p}));
    const addP = (t, always) => { const v = t.trim().toLowerCase(); if (v) setPantry([...pantry.filter(p => p.term !== v), { term: v, always }]); setPantryDraft(""); };
    const q = pantryDraft.trim().toLowerCase();
    const quick = ["løg", "hvidløg", "kartofler", "ris", "pasta", "æg", "ost", "gulerødder", "fløde", "hakkede tomater", "spinat", "citron", "kokosmælk", "røde linser"];
    const sugg = (q ? KNOWN_TERMS.filter(t => t.includes(q)) : quick).filter(t => !pantry.some(p => p.term === t)).slice(0, 12);
    const now = pantry.filter(p => !p.always), always = pantry.filter(p => p.always);
    const setFreezer = (f) => setShop(s => ({...s, freezer: f}));
    const pchip = (p) => html`<button key=${p.term} className=${"chip " + (p.always ? "" : "info")} style=${p.always ? {border:"1px solid var(--border)"} : {}} aria-label=${`Fjern ${p.term}`} onClick=${()=>setPantry(pantry.filter(x => x !== p))}>${p.term} ✕</button>`;
    return html`<div>
      <div className="card stack">
        <div><div style=${{fontWeight:600}}>Har lige nu</div>
          <div className="small muted">Madplanen vælger helst retter, der bruger det, og det kommer ikke på indkøbslisten. Det forsvinder herfra, når du trykker <b>Lavet ✓</b> på retten.</div></div>
        <div style=${{display:"flex", flexWrap:"wrap", gap:6}}>${now.length ? now.map(pchip) : html`<span className="small faint">Intet endnu.</span>`}</div>
        <form style=${{display:"flex", gap:8}} onSubmit=${e=>{ e.preventDefault(); addP(pantryDraft, false); }}>
          <input className="input" style=${{flex:1}} value=${pantryDraft} onChange=${e=>setPantryDraft(e.target.value)} placeholder="Fx halv pose ris, løg" aria-label="Det har jeg" />
          <button className="btn primary" type="submit" disabled=${!q}>Tilføj</button>
        </form>
        <div style=${{display:"flex", flexWrap:"wrap", gap:6}}>${sugg.map(t => html`<button key=${t} className="chip info" onClick=${()=>addP(t, false)}>+ ${t}</button>`)}</div>
        ${q && html`<button className="link-btn small" style=${{alignSelf:"flex-start"}} onClick=${()=>addP(pantryDraft, true)}>Læg "${q}" under Har altid i stedet</button>`}
      </div>

      <div className="section">
        <div className="section-head"><h2>Fryseren</h2>${freezerTotal > 0 && html`<span className="small faint">${freezerTotal} portioner</span>`}</div>
        ${freezer.length === 0 ? html`<div className="card empty">Tom. Når du trykker <b>Lavet ✓</b> på en ret, kan du lægge portioner i fryseren.</div>` : html`<div className="list">${freezer.map(f => html`<div key=${f.id} className="row" style=${{minHeight:52}}>
          <div className="main"><div className="title" style=${{whiteSpace:"normal"}}>${f.name}</div><div className="sub">${f.portions} ${f.portions === 1 ? "portion" : "portioner"}${f.date ? ` · frosset ${shortDate(f.date)}` : ""}</div></div>
          <div className="end" style=${{display:"flex", gap:12, alignItems:"center"}}>
            <button className="link-btn small" onClick=${()=>setFreezer(f.portions > 1 ? freezer.map(x => x.id === f.id ? {...x, portions: x.portions - 1} : x) : freezer.filter(x => x.id !== f.id))}>Spist én</button>
            <button className="icon-btn" style=${{width:30, height:30}} aria-label=${`Én portion mere ${f.name}`} onClick=${()=>setFreezer(freezer.map(x => x.id === f.id ? {...x, portions: x.portions + 1} : x))}>+</button>
          </div>
        </div>`)}</div>`}
        <form className="card" style=${{display:"flex", gap:8, marginTop:8}} onSubmit=${e=>{ e.preventDefault(); const n = freezerDraft.name.trim(); if (n) { setFreezer([...freezer, { id: uid(), name: n, portions: Math.max(1, +freezerDraft.portions || 1), date: isoDate(new Date()) }]); setFreezerDraft({ name: "", portions: 2 }); } }}>
          <input className="input" style=${{flex:1, minWidth:0}} list="meal-names" value=${freezerDraft.name} onChange=${e=>setFreezerDraft({...freezerDraft, name: e.target.value})} placeholder="Ret, fx dhal" aria-label="Ret i fryseren" />
          <datalist id="meal-names">${allMeals.map(m => html`<option key=${m.name} value=${m.name} />`)}</datalist>
          <input className="input" style=${{width:60}} type="number" min="1" inputMode="numeric" value=${freezerDraft.portions} onChange=${e=>setFreezerDraft({...freezerDraft, portions: e.target.value})} aria-label="Portioner" />
          <button className="btn soft" type="submit" disabled=${!freezerDraft.name.trim()}>Læg i</button>
        </form>
        <label style=${{display:"flex", alignItems:"center", gap:10, marginTop:10}} className="small">
          <input type="checkbox" style=${{width:20, height:20, accentColor:"var(--accent)"}} checked=${shop.useFreezer !== false} onChange=${e=>setShop(s => ({...s, useFreezer: e.target.checked}))} />
          Brug portionerne i fryseren i madplanen
        </label>
      </div>

      <div className="section">
        <div className="section-head"><h2>Har altid</h2><button className="link-btn small" onClick=${()=>setPantry([...now, ...BASICS.map(term => ({ term, always: true }))])}>Nulstil</button></div>
        <div className="card stack">
          <div className="small muted">Krydderier, olie og andet, du altid har. Det købes aldrig ind til madplanen.</div>
          <div style=${{display:"flex", flexWrap:"wrap", gap:6}}>${always.map(pchip)}</div>
        </div>
      </div>
    </div>`;
  };

  // Food budget for the running budget month: same numbers as the Budget page ("Mad & dagligvarer").
  const FOOD_CAT = "Mad & dagligvarer";
  const FoodBudget = () => {
    const ym = currentBudgetMonth(), st = monthStats(ym), pay = nextPayday();
    const budget = +budgets[FOOD_CAT] || 0, spent = st.byCat[FOOD_CAT] || 0, left = budget - spent;
    const pct = budget > 0 ? Math.min(100, spent / budget * 100) : 0;
    const planTotal = shop.plan?.compare && shop.plan.created >= addDays(isoDate(new Date()), -7) ? shop.plan.total : null;
    const after = planTotal != null ? left - planTotal : null;
    const buys = transactions.filter(t => t.category === FOOD_CAT && !t.trip && t.amount < 0 && budgetMonth(t.date, t.amount, t.category) === ym)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    // The month in weeks (Monday–Sunday, cut at the month's ends): what each week got, and what's left for
    // the weeks after the current madplan. Offers are only known a week ahead, so later weeks get a budget
    // rather than a plan.
    const today = isoDate(new Date()), mEnd = monthEnd(ym), totalDays = +mEnd.slice(8);
    const weeks = [];
    for (let d = `${ym}-01`; d <= mEnd; ) {
      const end = [addDays(d, 6 - (parseDKDate(d).getDay() + 6) % 7), mEnd].sort()[0];
      const days = Math.round((parseDKDate(end) - parseDKDate(d)) / 864e5) + 1;
      const spentW = -buys.filter(t => t.date >= d && t.date <= end).reduce((s, t) => s + t.amount, 0);
      weeks.push({ from: d, to: end, days, spent: spentW, budget: budget * days / totalDays, state: end < today ? "past" : d > today ? "future" : "now" });
      d = addDays(end, 1);
    }
    const daysLeft = today > mEnd ? 0 : Math.round((parseDKDate(mEnd) - parseDKDate(today)) / 864e5) + 1;
    const planDays = planTotal != null ? Math.max(0, Math.min(daysLeft, Math.round((parseDKDate(addDays(shop.plan.created, shop.plan.nights)) - parseDKDate(today)) / 864e5))) : 0;
    const restDays = daysLeft - planDays, perDayRest = restDays > 0 ? Math.max(0, (after ?? left)) / restDays : 0;
    const weekNo = (iso) => { const t = parseDKDate(iso); t.setDate(t.getDate() + 3 - (t.getDay() + 6) % 7); const y1 = new Date(t.getFullYear(), 0, 4); return 1 + Math.round(((t - y1) / 864e5 - 3 + (y1.getDay() + 6) % 7) / 7); };
    // Pace: how much of the budget "should" be gone by today (Monzo/Copilot style marker on the bar).
    const elapsed = totalDays - daysLeft + 1, expected = budget * Math.min(1, elapsed / totalDays), ahead = spent - expected;
    const planPct = planTotal != null && budget > 0 ? Math.max(0, Math.min(100 - pct, planTotal / budget * 100)) : 0;
    const perDay = daysLeft > 0 ? Math.max(0, left) / daysLeft : 0;
    return html`<div className="card stack" style=${{marginBottom:12, gap:14}}>
      <div style=${{display:"flex", alignItems:"flex-start", gap:8}}>
        <div style=${{flex:1}}>
          <div className="small muted">Madbudget · ${monthName(ym).toLowerCase()}</div>
          <div style=${{fontSize:30, fontWeight:700, letterSpacing:"-.5px", lineHeight:1.15, marginTop:2}} className=${left < 0 ? "neg" : ""}>${fmt(Math.abs(left))}</div>
          <div className="small muted">${left < 0 ? "over budgettet" : `tilbage af ${fmt(budget)}`}</div>
        </div>
        <button className="link-btn small" onClick=${()=>setFoodBudgetEdit(!foodBudgetEdit)}>${foodBudgetEdit ? "Færdig" : "Ret"}</button>
      </div>
      ${foodBudgetEdit && html`<label className="field">Budget til mad og dagligvarer pr. måned (kr.)<input className="input" type="number" inputMode="decimal" value=${budget} onChange=${e=>setBudgets({...budgets, [FOOD_CAT]: +e.target.value})} /></label>`}
      ${budget > 0 && html`<div>
        <div className="fb-bar" aria-hidden="true">
          <div style=${{width:`${pct}%`, background: left < 0 ? "var(--neg)" : CAT_COLORS[FOOD_CAT]}}></div>
          ${planPct > 0 && html`<div className="fb-plan" style=${{width:`${planPct}%`}}></div>`}
          ${daysLeft > 0 && html`<span className="fb-pace" style=${{left:`${Math.min(100, expected / budget * 100)}%`}}></span>`}
        </div>
        <div style=${{display:"flex", flexWrap:"wrap", gap:6, marginTop:10}}>
          ${daysLeft > 0 && html`<span className="fb-pill">${fmt(perDay)} pr. dag</span>`}
          ${daysLeft > 0 && html`<span className=${"fb-pill " + (ahead > budget * 0.05 ? "neg" : "pos")}>${ahead > budget * 0.05 ? `${fmt(ahead)} over tempo` : "På sporet"}</span>`}
          ${planTotal != null && html`<span className="fb-pill"><i className="fb-dot"></i>Madplan ${fmt(Math.round(planTotal))}</span>`}
        </div>
      </div>`}
      ${budget > 0 && html`<div>
        <div className="fb-weeks" style=${{gridTemplateColumns:`repeat(${weeks.length}, 1fr)`}}>${weeks.map(w => {
          // The plan's cost is spread over the days it covers, so it lands in the weeks those days fall in.
          const pFrom = [today, w.from].sort()[1], pTo = [addDays(today, planDays - 1), w.to].sort()[0];
          const pDays = planDays > 0 && pFrom <= pTo ? Math.round((parseDKDate(pTo) - parseDKDate(pFrom)) / 864e5) + 1 : 0;
          const planHere = pDays * (planTotal || 0) / Math.max(1, planDays);
          const avail = w.state === "future" ? perDayRest * (w.days - pDays) : null;
          const used = (w.spent + planHere) / Math.max(1, w.budget), over = used > 1;
          return html`<div key=${w.from} className=${"fb-week " + w.state}>
            <div className="fb-col">${w.state !== "future" && html`
              ${planHere > 0 && html`<div className="fb-plan" style=${{height:`${Math.min(100, planHere / Math.max(1, w.budget) * 100)}%`}}></div>`}
              <div style=${{height:`${Math.min(100, w.spent / Math.max(1, w.budget) * 100)}%`, background: over ? "var(--neg)" : CAT_COLORS[FOOD_CAT]}}></div>`}
              ${w.state === "future" && planHere > 0 && html`<div className="fb-plan" style=${{height:`${Math.min(100, planHere / Math.max(1, w.budget) * 100)}%`}}></div>`}</div>
            <div className="fb-wl">${w.state === "now" ? "Nu" : `Uge ${weekNo(w.from)}`}</div>
            <div className=${"fb-wv num " + (over && w.state !== "future" ? "neg" : "")}>${w.state === "future" ? fmtShort(avail + planHere) : fmtShort(w.spent + planHere)}</div>
          </div>`; })}</div>
        <div className="small muted" style=${{marginTop:10}}>${planTotal != null && planDays > 0
          ? `Madplanen dækker de næste ${planDays} dage. Derefter har du ca. ${fmt(perDayRest * 7)} pr. uge.`
          : `Du har ca. ${fmt(perDayRest * 7)} pr. uge resten af måneden.`} Stiplede uger viser, hvad du har til rådighed.</div>
      </div>`}
      ${buys.length > 0 && html`<button className="link-btn small" style=${{alignSelf:"flex-start"}} onClick=${()=>setShowFoodTx(!showFoodTx)}>${showFoodTx ? "Skjul køb" : `Se ${buys.length} køb i ${monthName(ym).toLowerCase()}`}</button>`}
      ${showFoodTx && html`<div className="list">${buys.map(t => html`<div key=${t.id} className="row" style=${{minHeight:44}}>
        <div className="main"><div className="title">${prettyName(t.description)}</div><div className="sub">${shortDate(t.date)}</div></div>
        <div className="end num">${fmt(t.amount)}</div>
      </div>`)}</div>`}
    </div>`;
  };

  const FoodPage = () => html`<div>
    ${FoodBudget()}
    ${deals.length > 0 && html`<div className="tip" style=${{marginTop:0, marginBottom:12, alignItems:"flex-start"}}>
      <div className="sq sm" style=${{background:"var(--pos-bg)", color:"var(--pos)"}}><${Icon} name="cart" /></div>
      <div className="stack" style=${{gap:6, flex:1}}>${deals.map(d => html`<div key=${d.term}>
        <b>${d.term}</b> er på tilbud i ${d.store}: <b>${kr(d.price)}</b> (normalt ca. ${kr(d.normal)})${d.till ? ` til ${shortDate(isoDate(new Date(d.till)))}` : "."} Køb gerne til et par uger.
        <button className="link-btn small" onClick=${()=>{ setShop(s => ({...s, items: [...s.items, { id: uid(), name: d.term, done: false, pick: d.id, qty: "", snap: { id: d.id, store: d.store, price: d.price, heading: d.heading, image: d.image, till: d.till } }]})); flash("shop", `${d.term} er lagt på indkøbslisten.`); }}>+ Indkøbsliste</button>
      </div>`)}</div>
    </div>`}
    <div className="seg" role="tablist">${[["plan", "Madplan"], ["list", `Indkøb${shop.items.filter(i => !i.done).length ? ` (${shop.items.filter(i => !i.done).length})` : ""}`], ["meals", "Retter"], ["home", "Hjemme"]].map(([id, label]) =>
      html`<button key=${id} role="tab" aria-selected=${foodTab === id} className=${foodTab === id ? "on" : ""} onClick=${()=>setFoodTab(id)}>${label}</button>`)}</div>
    ${foodTab === "plan" ? PlanTab() : foodTab === "list" ? ShopPage() : foodTab === "home" ? HomeTab() : MealsTab()}
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

  const AppearancePage = () => html`<div>
    <div className="list">
    ${[["dark","Mørk"],["light","Lys"],["system","Følg systemet"]].map(([v,l]) => html`<button key=${v} className="row" onClick=${()=>setTheme(v)}>
      <div className="main"><div className="title">${l}</div></div>
      ${theme === v && html`<span className="chip info">Valgt</span>`}
    </button>`)}
    </div>
    <div className="section">
      <div className="section-head"><h2>Lås med Face ID</h2></div>
      <div className="card stack">
        <div className="small muted">Appen beder om Face ID (eller Touch ID), når den har været lukket. Gælder kun denne enhed. iPhone spørger måske, om adgangsnøglen skal gemmes – sig ja.</div>
        ${!window.PublicKeyCredential ? html`<div className="small neg">Denne browser kan ikke bruge Face ID.</div>` : lock.on
          ? html`<label className="field">Lås efter<select className="input" value=${lock.after ?? 1} onChange=${e=>{ const l = { ...lock, after: +e.target.value }; store.setJson(LOCK_KEY, l); setLock(l); }}>
              ${[[0, "Med det samme"], [1, "1 minut"], [5, "5 minutter"], [15, "15 minutter"], [60, "1 time"]].map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select></label>
              <button className="btn" onClick=${()=>setLockOn(false)}>Slå låsen fra</button>`
          : html`<button className="btn primary" onClick=${()=>setLockOn(true)}>Slå Face ID-lås til</button>`}
        <${Msg} k="lock" />
      </div>
    </div>
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

  const DataPage = () => html`<div>
    <div className="card stack" style=${{marginBottom:12}}>
      <div style=${{fontWeight:600}}>Synkronisering mellem enheder</div>
      <div className="small muted">Telefon og computer deler de samme data via din worker. Data krypteres på enheden med din worker-adgangskode, før de sendes, og den nyeste ændring vinder.</div>
      <div className=${"small " + (syncState.status === "error" ? "neg" : syncState.status === "ok" ? "pos" : "")}>${
        syncState.status === "ok" ? `Synkroniseret ${new Date(syncState.at).toLocaleTimeString("da-DK", { hour:"2-digit", minute:"2-digit" })}${syncState.received ? ` – hentede data fra ${syncState.received}` : ""}.`
        : syncState.status === "busy" ? "Synkroniserer…"
        : syncState.status === "off" ? "Ikke sat op endnu: workeren mangler en KV-binding ved navn SYNC (se SETUP.md)."
        : syncState.status === "nobridge" ? "Kræver forbindelsen til din worker (Mere → Bankforbindelser)."
        : syncState.status === "error" ? `Fejl: ${syncState.msg}` : "Venter…"}</div>
      <button className="btn soft" disabled=${syncState.status === "busy"} onClick=${async ()=>{ await pullSync(); if (savedAtRef.current > syncMeta().at) await pushSync(); }}>Synkronisér nu</button>
    </div>
    <div className="card stack">
    <div className="small muted">Alt gemmes lokalt på denne enhed (og deles via synkroniseringen ovenfor). Du kan også flytte data med eksport/import. Backups fra claude.ai-versionen kan også importeres. Nøgler og bankadgang er ikke med i backuppen.</div>
    <div className="btns">
      <button className="btn primary" onClick=${exportData}>Eksportér backup</button>
      <button className="btn" onClick=${()=>importRef.current && importRef.current.click()}>Importér backup</button>
    </div>
    <${Msg} k="backup" />
    <div className="small faint">${transactions.length} poster · ${holdings.length} beholdninger · ${assets.length} aktiver</div>
    </div>
  </div>`;

  const MorePage = () => {
    if (sub) {
      const Sub = { wealth: WealthPage, trips: TripsPage, subs: SubsPage, report: ReportPage, trends: TrendsPage, su: SuPage, shared: SharedPage, notify: NotifyPage, calendar: CalendarPage, training: TrainingPage, connections: ConnectionsPage, ai: AiPage, import: ImportPage, appearance: AppearancePage, apikey: ApiKeyPage, data: DataPage }[sub];
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
      ${pages.map((p, i) => html`<button key=${p.id} style=${stag(i)} className="row" onClick=${()=>{ setSub(p.id); scrollToTop(); }}>
        <div className="sq" style=${{background:"var(--accent-bg)", color:"var(--accent)"}}><${Icon} name=${p.icon} /></div>
        <div className="main"><div className="title">${p.label}</div><div className=${"sub" + (p.id === "data" && backupStale ? " neg" : "")}>${p.id === "data" ? backupText : p.sub}</div></div>
        <span className="faint"><${Icon} name="chevron" /></span>
      </button>`)}
      </div>
      ${!apiKey && html`<button className="link-btn small" style=${{display:"block", margin:"14px auto 0", color:"var(--text-2)"}} onClick=${()=>{ setSub("apikey"); scrollToTop(); }}>Slå AI-funktioner til (kræver Claude API-nøgle)</button>`}
    </div>`;
  };

  // ================= shell =================

  const hour = new Date().getHours();
  const pageTitle = page === "start" ? (hour < 10 ? "God morgen" : hour < 17 ? "Hej" : "God aften")
    : page === "home" ? "Overblik"
    : page === "more" && sub ? MORE_PAGES.find(p => p.id === sub)?.label
    : page === "invest" ? "Investeringer"
    : page === "food" ? "Mad og tilbud"
    : page === "budget" ? monthName(budgetMonthSel)
    : PAGES.find(p => p.id === page)?.label;
  const lastSync = [sync.bank, sync.saxo].filter(Boolean).sort().pop();
  const canSync = Boolean(ebSession?.session_id) || Boolean(saxoTokens);
  const body = { start: StartPage, home: HomePage, tx: TxPage, budget: BudgetPage, invest: InvestPage, food: FoodPage, more: MorePage }[page] || StartPage;

  if (locked && lock.on) return html`<div className="lock-screen">
    <div className="lock-inner">
      <div className="lock-icon"><${Icon} name="shield" /></div>
      <div style=${{fontSize:22, fontWeight:700}}>Økonomi er låst</div>
      <button className="btn primary block" onClick=${unlock}>Lås op med Face ID</button>
      ${lockMsg && html`<div className="small neg">${lockMsg}</div>`}
      <details className="small muted" style=${{marginTop:18}}><summary>Virker Face ID ikke?</summary>
        <div className="stack" style=${{marginTop:8}}>
          <div>Skriv adgangskoden til din worker (APP_SECRET) for at låse op og slå låsen fra.</div>
          <form style=${{display:"flex", gap:8}} onSubmit=${e=>{ e.preventDefault(); const b = store.json(BRIDGE_KEY); if (b?.secret ? lockSecret === b.secret : true) { store.remove(LOCK_KEY); setLock({}); setLocked(false); setLockSecret(""); } else setLockMsg("Forkert adgangskode."); }}>
            <input className="input" type="password" value=${lockSecret} onChange=${e=>setLockSecret(e.target.value)} placeholder="Adgangskode" aria-label="Adgangskode til workeren" />
            <button className="btn" type="submit">Lås op</button>
          </form>
        </div>
      </details>
    </div>
  </div>`;

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
      <${PageBoundary} key=${page + (sub || "")}><${Render} fn=${body} /></${PageBoundary}>
    </main>
    ${toast && html`<div className="toast" role="status">
      <span>${toast.text}</span>
      <button onClick=${()=>{ toast.restore(); setToast(null); clearTimeout(toastTimer.current); }}>Fortryd</button>
    </div>`}
    ${cookFor && CookView()}
    ${quick && QuickSheet()}
    ${(page === "home" || page === "tx") && !quick && html`<button className="fab" aria-label="Hurtig udgift" onClick=${()=>setQuick({ amt: "", cat: "Mad & dagligvarer", note: "", kind: "out" })}><${Icon} name="plus" /></button>`}
    ${msgs.quick && html`<div className="toast" role="status"><span>${msgs.quick}</span></div>`}
    <nav className="nav"><div className="nav-inner">
      ${PAGES.map(p => html`<button key=${p.id} className=${page === p.id || (p.id === "home" && page === "tx") ? "on" : ""} aria-current=${page === p.id ? "page" : null} onClick=${()=>{ setPage(p.id); if (p.id === "more" && page === "more") setSub(null); scrollToTop(); }}><${Icon} name=${p.icon} />${p.label}${p.id === "food" && foodBadge ? html`<span className="nav-dot" aria-label=${planEnded ? "Madplanen er slut" : "Nye tilbud"}></span>` : null}</button>`)}
    </div></nav>
  </div>`;
}

// If anything in the UI throws, show a way out instead of a blank page. Stored data is untouched.
// One page failing shows a message on that page only; the menu and the other pages keep working.
const Render = ({ fn }) => fn();
class PageBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error(error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return html`<div className="card stack">
      <div style=${{fontWeight:600}}>Siden kunne ikke vises</div>
      <div className="small muted">Dine data er ikke rørt. Prøv igen, eller gå til en anden side.</div>
      <div className="code small">${String(this.state.error?.message || this.state.error)}</div>
      <button className="btn soft" onClick=${() => this.setState({ error: null })}>Prøv igen</button>
    </div>`;
  }
}

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
