import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReminderCalendar, defaultReminders, validateReminder, foldLine } from "../src/model/index.js";

const NOW = new Date("2026-10-03T02:00:00Z");   // 10:00 on Oct 3 in Manila
const one = { id: "r1", title: "Verify, now; ok", description: "Line one\nLine two", time: "07:15", repeat: "daily", alarms: [0, 5] };
const build = (rs, o = {}) => buildReminderCalendar(rs, { now: NOW, ...o });
const lines = (s) => s.split("\r\n");

test("calendar has the required frame and CRLF line endings", () => {
  const ics = build([one]);
  const l = lines(ics);
  assert.equal(l[0], "BEGIN:VCALENDAR");
  assert.ok(l.includes("VERSION:2.0"));
  assert.equal(l.at(-2), "END:VCALENDAR");
  assert.equal(l.at(-1), "");   // trailing CRLF
  assert.ok(!ics.replace(/\r\n/g, "").includes("\n"));   // no bare newlines
});
test("times are Philippine time with an explicit zone definition", () => {
  const l = lines(build([one]));
  assert.ok(l.includes("TZID:Asia/Manila"));
  assert.ok(l.includes("TZOFFSETTO:+0800"));
  assert.ok(l.includes("DTSTART;TZID=Asia/Manila:20261003T071500"));
  assert.ok(l.includes("DTEND;TZID=Asia/Manila:20261003T073000"));
});
test("start date defaults to the Philippine date, not the UTC date", () => {
  const lateUtc = new Date("2026-10-03T20:30:00Z");   // already Oct 4 in Manila
  assert.ok(lines(buildReminderCalendar([one], { now: lateUtc })).includes("DTSTART;TZID=Asia/Manila:20261004T071500"));
  assert.ok(lines(build([one], { startDate: "2026-11-01" })).includes("DTSTART;TZID=Asia/Manila:20261101T071500"));
});
test("an event near midnight rolls its end time correctly", () => {
  assert.ok(lines(build([{ ...one, time: "23:55" }])).includes("DTEND;TZID=Asia/Manila:20261003T001000"));
});
test("daily and weekly repeat rules", () => {
  assert.ok(lines(build([one])).includes("RRULE:FREQ=DAILY"));
  assert.ok(lines(build([{ ...one, repeat: "weekly:SU" }])).includes("RRULE:FREQ=WEEKLY;BYDAY=SU"));
});
test("one alarm block per alarm, relative to the start", () => {
  const l = lines(build([one]));
  assert.equal(l.filter((x) => x === "BEGIN:VALARM").length, 2);
  assert.ok(l.includes("TRIGGER;RELATED=START:PT0M"));
  assert.ok(l.includes("TRIGGER;RELATED=START:PT5M"));
});
test("text is escaped: commas, semicolons and newlines", () => {
  const l = lines(build([one]));
  assert.ok(l.includes("SUMMARY:Verify\\, now\; ok"));
  assert.ok(l.includes("DESCRIPTION:Line one\\nLine two"));
});
test("long lines are folded at 75 characters and unfold back to the original", () => {
  const long = "SUMMARY:" + "x".repeat(200);
  const folded = foldLine(long);
  folded.split("\r\n").forEach((part, i) => assert.ok(part.length <= 75, "part " + i));
  assert.equal(folded.replace(/\r\n /g, ""), long);
  assert.equal(foldLine("short"), "short");
});
test("UIDs are fixed per reminder, so re-importing updates instead of duplicating", () => {
  const a = lines(build([one])).find((x) => x.startsWith("UID:"));
  const b = lines(buildReminderCalendar([one], { now: new Date("2027-01-01T00:00:00Z") })).find((x) => x.startsWith("UID:"));
  assert.equal(a, "UID:r1@financial-tracker");
  assert.equal(a, b);
});
test("invalid reminders are refused with the reason", () => {
  for (const [bad, text] of [
    [{ ...one, time: "7:15" }, /HH:MM/], [{ ...one, time: "24:00" }, /HH:MM/], [{ ...one, repeat: "monthly" }, /repeat/],
    [{ ...one, repeat: "weekly:XX" }, /repeat/], [{ ...one, alarms: [] }, /alarms/], [{ ...one, alarms: [-1] }, /alarms/],
    [{ ...one, alarms: [1.5] }, /alarms/], [{ ...one, title: " " }, /title/], [{ ...one, id: "a b" }, /id/],
  ]) assert.throws(() => build([bad]), text);
  assert.deepEqual(validateReminder(one), []);
});

test("default set: morning, 6pm cutoff, and a weekly check-in only when a day is chosen", () => {
  const d = defaultReminders();
  assert.deepEqual(d.map((r) => [r.id, r.time]), [["verify-morning", "07:10"], ["verify-cutoff", "18:00"]]);
  const w = defaultReminders({ checkin: { day: "SU", time: "18:30" } });
  assert.deepEqual(w.at(-1).repeat, "weekly:SU");
  assert.throws(() => defaultReminders({ checkin: { day: "Sunday", time: "18:30" } }), /check-in day/);
});
test("default set builds into a valid calendar and its alarms follow up if missed", () => {
  const ics = build(defaultReminders({ checkin: { day: "SU", time: "18:30" } }));
  assert.equal(lines(ics).filter((x) => x === "BEGIN:VEVENT").length, 3);
  assert.equal(lines(ics).filter((x) => x === "BEGIN:VALARM").length, 3 + 3 + 2);
});
test("calendar text is generic: no digits in any title or description, so no amounts can leak", () => {
  const ics = build(defaultReminders({ checkin: { day: "SU", time: "18:30" } }));
  for (const l of lines(ics).filter((x) => /^(SUMMARY|DESCRIPTION):/.test(x))) assert.ok(!/\d/.test(l), l);
});
