import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, addPlan, planInEffect, planTotals, planEmergencyTarget, cutoffFor, planProgress } from "../src/model/index.js";
import { makeState, account, tx, entry, commit } from "./fixtures.js";

// Invented numbers only, in centavos. Each payday's lines add up to its income exactly.
const base = () => ({
  schema: 2, units: "centavos", effective_from: "2026-10-01",
  paydays: [{ label: "1st", day: 15, income: 1000000 }, { day: "last", income: 2400000 }],
  lines: [
    { name: "Daily spending", kind: "expense", first: 600000, second: 600000, categories: [{ name: "Food", monthly: 800000 }, { name: "Shopping", monthly: 400000 }] },
    { name: "Rent", kind: "expense", first: 0, second: 500000 },
    { name: "Apartment Fund", kind: "goal", first: 400000, second: 1300000 },
  ],
  emergency: { months: 3, basis: ["rent", "FOOD"] },
});
const file = (edit) => { const o = base(); edit?.(o); return JSON.stringify(o); };

test("a plan loads, names the paydays, and the emergency target uses the basis names' monthly amounts", () => {
  const r = parsePlan(file());
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.paydays.map((p) => [p.label, p.day]), [["1st", 15], ["2nd payday", "last"]]);
  assert.deepEqual(planTotals(r.plan), { first: 1000000, second: 2400000, month: 3400000 });
  assert.deepEqual(r.plan.emergency.basis, ["Rent", "Food"], "names take the plan's own spelling");
  assert.equal(planEmergencyTarget(r.plan), 3 * (500000 + 800000), "Food is a category inside Daily spending; Rent is a whole line");
  assert.equal(planEmergencyTarget(parsePlan(file((o) => delete o.emergency)).plan), null);
});
test("the basis must be spelled out: leaving a name out changes the target", () => {
  const withEss = parsePlan(file((o) => { o.emergency.basis = ["Rent", "Food", "Shopping"]; })).plan;
  assert.equal(planEmergencyTarget(withEss), 3 * (500000 + 800000 + 400000));
});
test("each payday's lines must sum to its income exactly, and the error says by how much", () => {
  let r = parsePlan(file((o) => { o.lines[1].second = 500001; }));
  assert.equal(r.ok, false);
  assert.match(r.error, /2nd payday add up to 2400001 centavos but its income is 2400000 \(over by 1\)/);
  r = parsePlan(file((o) => { o.paydays[0].income = 1000100; }));
  assert.match(r.error, /1st add up to 1000000 centavos but its income is 1000100 \(short by 100\)/);
});
test("units are declared, never guessed", () => {
  assert.match(parsePlan(file((o) => delete o.units)).error, /centavos/);
  assert.match(parsePlan(file((o) => { o.units = "pesos"; })).error, /centavos/);
  assert.match(parsePlan(file((o) => { o.lines[1].second = 5000.5; })).error, /whole-centavo/, "a decimal cannot be centavos");
});
test("a plan is dated, and the 2nd payday can be the last day of the month", () => {
  assert.match(parsePlan(file((o) => delete o.effective_from)).error, /effective_from/);
  assert.match(parsePlan(file((o) => { o.effective_from = "2026-13-01"; })).error, /effective_from/);
  assert.equal(parsePlan(file((o) => { o.paydays[1].day = 30; })).ok, false, "30 is not accepted: use \"last\"");
  assert.equal(parsePlan(file((o) => { o.paydays[1].day = 28; })).ok, true);
  assert.equal(parsePlan(file((o) => { o.paydays[0].day = 29; })).ok, false);
});
test("a bad plan file is refused in plain words, never thrown", () => {
  const bad = [
    ["not json", "{", /could not be read/], ["schema", file((o) => { o.schema = 1; }), /schema 2/],
    ["one payday", file((o) => { o.paydays.pop(); }), /two paydays/], ["2nd before 1st", file((o) => { o.paydays[1].day = 10; }), /2nd payday day/],
    ["no income", file((o) => { delete o.paydays[0].income; }), /income/], ["no lines", file((o) => { o.lines = []; }), /1 and 60/],
    ["duplicate line", file((o) => { o.lines[1].name = "daily SPENDING"; }), /twice/], ["category named like a line", file((o) => { o.lines[0].categories[0].name = "Rent"; }), /twice/],
    ["negative", file((o) => { o.lines[1].first = -1; }), /whole-centavo/], ["bad kind", file((o) => { o.lines[1].kind = "x"; }), /unknown kind/],
    ["categories on a goal", file((o) => { o.lines[2].categories = [{ name: "X", monthly: 1 }]; }), /Only an expense line/],
    ["categories do not add up", file((o) => { o.lines[0].categories[0].monthly = 1; }), /add up to 400001 centavos a month, but the line is 1200000/],
    ["basis not in plan", file((o) => { o.emergency.basis = ["Nope"]; }), /basis/], ["basis twice", file((o) => { o.emergency.basis = ["Rent", "rent"]; }), /twice/],
    ["months", file((o) => { o.emergency.months = 0; }), /1 to 24/],
  ];
  for (const [name, text, re] of bad) { const r = parsePlan(text); assert.equal(r.ok, false, name); assert.match(r.error, re, name); }
});
test("plans are append-only and dated; the one in effect is the latest that has started", () => {
  const p1 = parsePlan(file()).plan, p2 = parsePlan(file((o) => { o.effective_from = "2027-01-01"; })).plan;
  let r = addPlan([], p1); assert.equal(r.ok, true);
  r = addPlan(r.plans, p2); assert.equal(r.plans.length, 2);
  assert.equal(planInEffect(r.plans, "2026-09-30"), null, "before the first plan starts there is none");
  assert.equal(planInEffect(r.plans, "2026-12-31").effective_from, "2026-10-01");
  assert.equal(planInEffect(r.plans, "2027-01-01").effective_from, "2027-01-01");
  assert.equal(addPlan(r.plans, p1).unchanged, true, "loading the same plan again changes nothing");
  const edited = parsePlan(file((o) => { o.lines[1].second = 400000; o.lines[2].second = 1400000; })).plan;
  const refused = addPlan(r.plans, edited);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /never edited/);
});
test("a date belongs to the cutoff that started on the last payday, with month end resolved per month", () => {
  const plan = parsePlan(file()).plan;   // paydays: the 15th and the last day
  assert.deepEqual(cutoffFor(plan, "2026-10-20"), { index: 1, start: "2026-10-15", end: "2026-10-30" });
  assert.deepEqual(cutoffFor(plan, "2026-10-31"), { index: 2, start: "2026-10-31", end: "2026-11-14" }, "31-day month: pays on the 31st");
  assert.deepEqual(cutoffFor(plan, "2026-11-20"), { index: 1, start: "2026-11-15", end: "2026-11-29" }, "30-day month");
  assert.deepEqual(cutoffFor(plan, "2026-11-30"), { index: 2, start: "2026-11-30", end: "2026-12-14" });
  assert.deepEqual(cutoffFor(plan, "2027-02-20"), { index: 1, start: "2027-02-15", end: "2027-02-27" }, "February has 28 days");
  assert.deepEqual(cutoffFor(plan, "2027-02-28"), { index: 2, start: "2027-02-28", end: "2027-03-14" }, "and pays on the 28th");
  assert.deepEqual(cutoffFor(plan, "2028-02-29"), { index: 2, start: "2028-02-29", end: "2028-03-14" }, "leap year");
  assert.deepEqual(cutoffFor(plan, "2027-01-03"), { index: 2, start: "2026-12-31", end: "2027-01-14" }, "crosses the year");
});
test("progress sums a line's categories, counts verified spending in the cutoff only, and flags what it cannot match", () => {
  const s = makeState();
  s.categories.push({ id: "shop", name: "Shopping", kind: "expense" }, { id: "rent", name: "Rent", kind: "expense" });
  s.accounts.push(account({ id: "cash", name: "Test Cash", class: "asset", opening_balance: 10000000 }));
  const spend = (id, date, cat, amt, extra) => commit(s, { transaction: tx({ id, date, status: "verified", verified_at: date + "T08:00:00.000+08:00", ...extra }), entries: [entry({ transaction_id: id, category_id: cat, amount: amt }), entry({ transaction_id: id, account_id: "cash", amount: -amt })] });
  spend("a", "2026-10-16", "food", 500000);
  spend("b", "2026-10-17", "shop", 150000);
  spend("c", "2026-10-18", "food", 5000, { status: "draft", verified_at: undefined });
  spend("d", "2026-10-31", "food", 99900);   // the next cutoff
  const p = planProgress(s, parsePlan(file()).plan, "2026-10-20");
  assert.equal(p.period.index, 1);
  const daily = p.rows.find((r) => r.name === "Daily spending");
  assert.deepEqual([daily.planned, daily.spent, daily.remaining], [600000, 650000, -50000], "over is a negative number, shown plainly");
  assert.equal(p.rows.find((r) => r.name === "Rent").spent, 0);
  assert.equal(p.rows.find((r) => r.name === "Apartment Fund").spent, null, "goal lines are plans only");
  const odd = planProgress(s, parsePlan(file((o) => { o.lines[0].categories[1].name = "Mystery"; })).plan, "2026-10-20");
  assert.deepEqual([odd.rows[0].matched, odd.rows[0].missing], [false, ["Mystery"]]);
});
