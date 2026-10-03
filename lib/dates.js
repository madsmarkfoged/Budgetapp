
const PAYDAY_CUTOFF = 25;

const MONTHS_DA = ["januar","februar","marts","april","maj","juni","juli","august","september","oktober","november","december"];

function budgetMonth(dateStr, amount, category) {
  const d = new Date(dateStr);
  if (isNaN(d)) return (dateStr||"").slice(0,7);
  let y = d.getFullYear(), m = d.getMonth();
  const shift = (amount > 0 || category === "Husleje") && d.getDate() >= PAYDAY_CUTOFF;
  if (shift) { m += 1; if (m > 11) { m = 0; y += 1; } }
  return `${y}-${String(m+1).padStart(2,"0")}`;
}

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

const addDays = (iso, n) => { const d = parseDKDate(iso); d.setDate(d.getDate()+n); return isoDate(d); };

const monthEnd = (ym) => { const [y,m] = ym.split("-").map(Number); return `${ym}-${String(new Date(y,m,0).getDate()).padStart(2,"0")}`; };

const addMonths = (ym, n) => { const [y,m] = ym.split("-").map(Number); return isoDate(new Date(y, m-1+n, 1)).slice(0,7); };

// Fixed rent is booked on the last day of the month; this is the newest month whose rent day has come.
const lastRentMonth = () => { const t = isoDate(new Date()); const ym = t.slice(0,7); return monthEnd(ym) <= t ? ym : addMonths(ym, -1); };

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

const WEEKDAYS = ["Søndag", "Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag"];

export { PAYDAY_CUTOFF, MONTHS_DA, budgetMonth, isoDate, addDays, monthEnd, addMonths, lastRentMonth, monthLabel, monthName, currentBudgetMonth, prevMonth, parseDKDate, prettyDate, easter, isBankClosed, paydayIn, nextPayday, WEEKDAYS };
