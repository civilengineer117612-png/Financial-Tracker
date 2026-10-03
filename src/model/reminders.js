// Reminders that reach BOTH phones without a server (device addendum 3).
// A web app that is closed cannot schedule notifications on iOS, and the app has no
// server by design, so reminders are built as an iCalendar (.ics) file: import it once
// and the calendar app fires the alarms on every phone signed in to that calendar.
//
// The text is deliberately generic. A calendar syncs to the cloud, so no amounts,
// payees or balances ever go into it (spec 10.3: no real financial data outside the phone).
import { phTimestamp } from "./util.js";

const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const pad = (n) => String(n).padStart(2, "0");

// RFC 5545: escape \ ; , and newlines inside text values.
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// RFC 5545: lines longer than 75 octets are folded with CRLF + one space.
// (ASCII only here, so characters equal octets.)
export function foldLine(line) {
  const parts = [];
  for (let i = 0; i < line.length; i += i === 0 ? 75 : 74) parts.push(line.slice(i, i === 0 ? 75 : i + 74));
  return parts.join("\r\n ");
}

export function validateReminder(r) {
  const out = [];
  if (!r.id || !/^[A-Za-z0-9-]+$/.test(r.id)) out.push("id must be letters, digits and dashes");
  if (!r.title || !r.title.trim()) out.push("title is required");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time ?? "")) out.push("time must be HH:MM, 24-hour");
  if (r.repeat !== "daily" && !/^weekly:(MO|TU|WE|TH|FR|SA|SU)$/.test(r.repeat ?? "")) out.push("repeat must be daily or weekly:XX");
  if (!Array.isArray(r.alarms) || r.alarms.length === 0 || !r.alarms.every((m) => Number.isInteger(m) && m >= 0 && m <= 1440)) {
    out.push("alarms must be whole minutes after the start, 0 to 1440");
  }
  return out;
}

// reminders: [{id, title, description?, time:"HH:MM", repeat:"daily"|"weekly:SU", alarms:[0,30]}]
// startDate: first day (YYYY-MM-DD, Philippine date). Re-importing the file updates the
// same events instead of duplicating them, because each UID is fixed by the reminder id.
export function buildReminderCalendar(reminders, { now = new Date(), startDate } = {}) {
  const problems = reminders.flatMap((r) => validateReminder(r).map((m) => (r.id ?? "?") + ": " + m));
  if (problems.length) throw new Error(problems[0]);
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const day = (startDate ?? phTimestamp(now).slice(0, 10)).replace(/-/g, "");

  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Financial-Tracker//Reminders//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VTIMEZONE", "TZID:Asia/Manila",
    "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0800", "TZOFFSETTO:+0800", "TZNAME:PST", "END:STANDARD",
    "END:VTIMEZONE",
  ];
  for (const r of reminders) {
    const [h, m] = r.time.split(":").map(Number);
    const end = h * 60 + m + 15;   // a 15-minute event
    const rrule = r.repeat === "daily" ? "FREQ=DAILY" : "FREQ=WEEKLY;BYDAY=" + r.repeat.split(":")[1];
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + r.id + "@financial-tracker", "DTSTAMP:" + stamp,
      "DTSTART;TZID=Asia/Manila:" + day + "T" + r.time.replace(":", "") + "00",
      "DTEND;TZID=Asia/Manila:" + day + "T" + pad(Math.floor(end / 60) % 24) + pad(end % 60) + "00",
      "RRULE:" + rrule,
      "SUMMARY:" + esc(r.title),
      ...(r.description ? ["DESCRIPTION:" + esc(r.description)] : []),
    );
    for (const mins of r.alarms) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(r.title), "TRIGGER;RELATED=START:PT" + mins + "M", "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// The set decided for this app: verify in the morning (follow-up alarms if missed), the 6pm
// cutoff, and optionally the weekly check-in on the owner's chosen day.
export function defaultReminders({ morning = "07:15", cutoff = "18:00", checkin } = {}) {
  const list = [
    { id: "verify-morning", title: "Verify yesterday's drafts", time: morning, repeat: "daily", alarms: [0, 5, 10],
      description: "Open the finance app on the iPhone and check each entry, one by one." },
    { id: "verify-cutoff", title: "Verify cutoff: finish yesterday's drafts", time: cutoff, repeat: "daily", alarms: [0, 30, 60],
      description: "Yesterday's drafts must be verified now. Open the finance app on the iPhone." },
  ];
  if (checkin) {
    if (!DAYS.includes(checkin.day)) throw new Error("check-in day must be one of " + DAYS.join(","));
    list.push({ id: "weekly-checkin", title: "Weekly check-in", time: checkin.time, repeat: "weekly:" + checkin.day, alarms: [0, 30],
      description: "Count each account and wallet in the finance app, then answer the weekly questions." });
  }
  return list;
}
