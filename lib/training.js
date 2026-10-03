import { addDays, isoDate, parseDKDate } from "./dates.js";
import { splitLine } from "./transactions.js";

// ---------------- Træning ----------------
// Upper/lower split on fixed weekdays (0 = søndag). Each training day gets the next session in the split.
const DEFAULT_TRAINING = { days: [1, 2, 4, 5], split: ["Upper A", "Lower A", "Upper B", "Lower B"], log: {}, weights: [], lifts: [] };
const LIFTS = ["Bænkpres", "Squat", "Dødløft", "Skulderpres", "Rows", "Pull-ups", "Incline bænk", "Rumænsk dødløft", "Leg press", "Bicepscurl", "Triceps pushdown", "Lat pulldown"];

// Which session is planned on a date: the n-th training weekday of the week gets split[n].
function sessionFor(training, date) {
  const t = { ...DEFAULT_TRAINING, ...(training || {}) }, wd = parseDKDate(date).getDay();
  const days = [...t.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday first
  const i = days.indexOf(wd);
  return i < 0 ? null : t.split[i % t.split.length];
}
const mondayOf = (date) => { const d = parseDKDate(date); return addDays(date, -((d.getDay() + 6) % 7)); };
// Sessions done this week (Monday–Sunday) and the target.
function weekProgress(training, date = isoDate(new Date())) {
  const t = { ...DEFAULT_TRAINING, ...(training || {}) }, mon = mondayOf(date);
  const done = Object.keys(t.log || {}).filter(d => d >= mon && d <= addDays(mon, 6) && t.log[d]).length;
  return { done, target: t.days.length };
}
// Weeks in a row (ending last week, plus this week if already reached) with the target met.
function weekStreak(training, date = isoDate(new Date())) {
  let n = 0, mon = mondayOf(date);
  const { done, target } = weekProgress(training, date);
  if (done >= target) n++;
  for (let k = 1; k < 104; k++) { const w = weekProgress(training, addDays(mon, -7 * k)); if (w.done >= w.target) n++; else break; }
  return n;
}
// Estimated one-rep max (Epley).
const e1rm = (kg, reps) => reps <= 1 ? +kg : Math.round(kg * (1 + reps / 30) * 10) / 10;

// A workout export (CSV) from Gravitus or a spreadsheet: finds the date, exercise, weight and reps columns.
function parseWorkoutCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const sep = [";", ",", "\t"].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const head = splitLine(lines[0], sep).map(h => h.toLowerCase().trim());
  const col = (re) => head.findIndex(h => re.test(h));
  const ci = { date: col(/dato|date|day|tid|time/), ex: col(/øvelse|exercise|name|navn/), kg: col(/kg|weight|vægt|load/), reps: col(/rep/) };
  if (ci.date < 0 || ci.ex < 0 || ci.kg < 0 || ci.reps < 0) return [];
  const out = [];
  for (const l of lines.slice(1)) {
    const c = splitLine(l, sep), raw = (c[ci.date] || "").trim();
    const m = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})/) || raw.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
    if (!m) continue;
    const d = m[1].length === 4 ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    const kg = parseFloat(String(c[ci.kg]).replace(",", ".")), reps = parseInt(c[ci.reps]);
    const ex = (c[ci.ex] || "").trim();
    if (ex && kg > 0 && reps > 0) out.push({ d, ex, kg, reps });
  }
  return out;
}
// Per exercise: the best estimated max overall, the latest set, and the change against four weeks earlier.
function liftSummary(lifts, today = isoDate(new Date())) {
  const by = {};
  for (const l of lifts || []) (by[l.ex] ||= []).push(l);
  return Object.entries(by).map(([ex, ls]) => {
    ls.sort((a, b) => a.d.localeCompare(b.d));
    const best = Math.max(...ls.map(l => e1rm(l.kg, l.reps))), last = ls[ls.length - 1];
    const before = ls.filter(l => l.d <= addDays(today, -28)), then = before.length ? Math.max(...before.map(l => e1rm(l.kg, l.reps))) : null;
    return { ex, best, last, change: then ? Math.round((best - then) * 10) / 10 : null, count: ls.length };
  }).sort((a, b) => b.last.d.localeCompare(a.last.d));
}

export { DEFAULT_TRAINING, LIFTS, sessionFor, mondayOf, weekProgress, weekStreak, e1rm, parseWorkoutCsv, liftSummary };
