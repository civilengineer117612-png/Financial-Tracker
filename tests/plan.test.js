import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, planTotals, planEmergencyTarget, cutoffFor, planProgress } from "../src/model/index.js";
import { makeState, account, tx, entry, commit } from "./fixtures.js";

// Invented numbers only.
const file = (o = {}) => JSON.stringify({ v: 1, paydays: [{ day: 30 }, { day: 15, label: "Mid" }], lines: [
  { name: "Rent", first: 0, second: 5000 }, { name: "Food", first: 1000.5, second: 2000 }, { name: "Pocket", kind: "goal", first: 300, second: 300 }],
  essentials: ["rent", "Food"], ...o });

test("a plan loads into centavos, sorts the paydays and names them", () => {
  const r = parsePlan(file());
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.paydays, [{ day: 15, label: "Mid" }, { day: 30, label: "2nd payday" }]);
  assert.deepEqual(r.plan.lines[1], { name: "Food", kind: "expense", first: 100050, second: 200000 });
  assert.deepEqual(r.plan.essentials, ["Rent", "Food"], "essentials take the line's own spelling");
  assert.deepEqual(planTotals(r.plan), { first: 130050, second: 730000, month: 860050 });
  assert.equal(planEmergencyTarget(r.plan), 3 * (500000 + 300050));
});
test("a bad plan file is refused in plain words, never thrown", () => {
  const bad = [
    ["not json", "{", /could not be read/], ["wrong version", file({ v: 2 }), /version 1/],
    ["one payday", file({ paydays: [{ day: 1 }] }), /two paydays/], ["same day", file({ paydays: [{ day: 5 }, { day: 5 }] }), /different days/],
    ["day 40", file({ paydays: [{ day: 5 }, { day: 40 }] }), /1 to 31/], ["no lines", file({ lines: [] }), /1 and 60/],
    ["duplicate", file({ lines: [{ name: "A", first: 1, second: 1 }, { name: "a", first: 1, second: 1 }] }), /twice/],
    ["negative", file({ lines: [{ name: "A", first: -1, second: 1 }] }), /two decimals/], ["three decimals", file({ lines: [{ name: "A", first: 1.234, second: 1 }] }), /two decimals/],
    ["string amount", file({ lines: [{ name: "A", first: "5", second: 1 }] }), /two decimals/], ["bad kind", file({ lines: [{ name: "A", kind: "x", first: 1, second: 1 }] }), /unknown kind/],
    ["essential not a line", file({ essentials: ["Nope"] }), /essentials/], ["months", file({ emergency_months: 0 }), /1 to 24/],
  ];
  for (const [name, text, re] of bad) { const r = parsePlan(text); assert.equal(r.ok, false, name); assert.match(r.error, re, name); }
});
test("a date belongs to the cutoff that started on the last payday", () => {
  const plan = parsePlan(file()).plan;   // paydays 15 and 30
  assert.deepEqual(cutoffFor(plan, "2026-10-20"), { index: 1, start: "2026-10-15", end: "2026-10-29" });
  assert.deepEqual(cutoffFor(plan, "2026-10-30"), { index: 2, start: "2026-10-30", end: "2026-11-14" });
  assert.deepEqual(cutoffFor(plan, "2026-11-02"), { index: 2, start: "2026-10-30", end: "2026-11-14" });
  assert.deepEqual(cutoffFor(plan, "2026-01-03"), { index: 2, start: "2025-12-30", end: "2026-01-14" }, "crosses the year");
  assert.deepEqual(cutoffFor(plan, "2026-02-28"), { index: 2, start: "2026-02-28", end: "2026-03-14" }, "payday 30 in February means the last day");
});
test("progress shows what the cutoff plans, what was verified-spent, what is left, and flags unmatched lines", () => {
  const s = makeState();
  s.categories.push({ id: "rent", name: "Rent", kind: "expense" });
  s.accounts.push(account({ id: "cash", name: "Test Cash", class: "asset", opening_balance: 1000000 }));
  const spend = (id, date, cat, amt, extra) => commit(s, { transaction: tx({ id, date, status: "verified", verified_at: date + "T08:00:00.000+08:00", ...extra }), entries: [entry({ transaction_id: id, category_id: cat, amount: amt }), entry({ transaction_id: id, account_id: "cash", amount: -amt })] });
  spend("a", "2026-10-16", "food", 120000);
  spend("b", "2026-10-17", "food", 5000, { status: "draft", verified_at: undefined });
  spend("c", "2026-10-31", "food", 99900);   // the next cutoff
  const p = planProgress(s, parsePlan(file({ paydays: [{ day: 15 }, { day: 30 }] })).plan, "2026-10-20");
  assert.equal(p.period.index, 1);
  const food = p.rows.find((r) => r.name === "Food");
  assert.deepEqual([food.planned, food.spent, food.remaining], [100050, 120000, -19950], "over is a negative number, shown plainly");
  assert.equal(p.rows.find((r) => r.name === "Rent").spent, 0);
  assert.equal(p.rows.find((r) => r.name === "Pocket").spent, null, "goal lines are plans only");
  const unmatched = planProgress(s, parsePlan(file({ lines: [{ name: "Mystery", first: 1, second: 1 }], essentials: [] })).plan, "2026-10-20");
  assert.equal(unmatched.rows[0].matched, false);
});
