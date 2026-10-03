import { addDays } from "./dates.js";

// ---------------- Calendar ----------------
// Out for dinner? An event that touches the evening (17:30–21:00) and either sounds like being away (middag,
// fest, tur, rejse …), lasts most of the evening, or is a multi-day all-day event (a trip). Birthdays shown as
// all-day reminders don't count.
const AWAY_WORDS = /middag|fest|spisning|aftensmad|restaurant|julefrokost|\bdate\b|\bbar\b|koncert|fødselsdag hos|besøg|hjem til|rejse|ferie|\btur\b|-tur|weekend|sommerhus|\bfly\b|hotel|\bude\b|overnat|tager til/i;

const NOT_AWAY = /hjemme|madlavning|fødselsdag$|birthday|helligdag|påmindelse/i;

function calendarAway(events, date) {
  const evStart = Date.parse(date + "T17:30"), evEnd = Date.parse(date + "T21:00");
  for (const e of events || []) {
    const s = Date.parse(e.start), en = Date.parse(e.end);
    if (en <= evStart || s >= evEnd || NOT_AWAY.test(e.title)) continue;
    if (e.allDay) { if ((en - s) / 864e5 >= 2 || AWAY_WORDS.test(e.title)) return e; continue; }
    const overlap = (Math.min(en, evEnd) - Math.max(s, evStart)) / 60000;
    if (AWAY_WORDS.test(e.title) || overlap >= 150 || en - s > 20 * 3600e3) return e;
  }
  return null;
}

// Calendar file (.ics) for Google Calendar to subscribe to: only dates and titles, never amounts.
const icsEsc = (t) => String(t).replace(/\\/g, "\\\\").replace(/[,;]/g, (m) => "\\" + m).replace(/\n/g, "\\n");

const icsDate = (iso) => iso.replace(/-/g, "");

function buildIcs(items) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Budgetapp//Okonomi//DA", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Økonomi", "X-WR-TIMEZONE:Europe/Copenhagen"];
  for (const e of items) {
    out.push("BEGIN:VEVENT", `UID:${e.uid}@budgetapp`, `DTSTAMP:${stamp}`);
    if (e.time) { const [h, m] = e.time.split(":"), end = e.endTime || `${String(+h + 1).padStart(2, "0")}:${m}`;
      out.push(`DTSTART;TZID=Europe/Copenhagen:${icsDate(e.date)}T${h}${m}00`, `DTEND;TZID=Europe/Copenhagen:${icsDate(e.date)}T${end.replace(":", "")}00`); }
    else out.push(`DTSTART;VALUE=DATE:${icsDate(e.date)}`, `DTEND;VALUE=DATE:${icsDate(addDays(e.endDate || e.date, 1))}`);
    out.push(`SUMMARY:${icsEsc(e.title)}`);
    if (e.desc) out.push(`DESCRIPTION:${icsEsc(e.desc)}`);
    out.push("TRANSP:TRANSPARENT", "END:VEVENT");
  }
  out.push("END:VCALENDAR");
  return out.join("\r\n") + "\r\n";
}

export { AWAY_WORDS, NOT_AWAY, calendarAway, icsEsc, icsDate, buildIcs };
