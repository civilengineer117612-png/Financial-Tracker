import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, addPlan, planInEffect, planTotals, planEmergencyTarget, cutoffFor, planProgress, planIncome, planPayReceived } from "../src/model/index.js";
import { makeState, account, tx, entry, commit } from "./fixtures.js";

// Invented numbers only, in whole pesos. Each payday's lines add up to its expected income exactly.
const base = () => ({
  schema_version: 1, unit: "PHP_whole_pesos", effective_from: "2026-10-15",
  paydays: [{ id: "first", label: "1st", day: 15, expected_income: 1000 }, { id: "second", day: "last", expected_income: 2400 }],
  lines: [
    { name: "Food", kind: "expense", first: 600, second: 600 },
    { name: "Rent", kind: "expense", first: 0, second: 500 },
    { name: "Apartment Fund", kind: "goal", first: 400, second: 1300 },
  ],
  ef_target_basis: ["rent", "FOOD"], ef_target_months: 3,
});
const file = (edit) => { const o = base(); edit?.(o); return JSON.stringify(o); };

test("a plan loads into centavos, names the paydays, and the emergency target sums the basis lines", () => {
  const r = parsePlan(file());
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.paydays.map((p) => [p.label, p.day, p.income]), [["1st", 15, 100000], ["2nd payday", "last", 240000]]);
  assert.deepEqual(r.plan.lines[0], { name: "Food", kind: "expense", first: 60000, second: 60000 });
  assert.deepEqual(planTotals(r.plan), { first: 100000, second: 240000, month: 340000 });
  assert.deepEqual(r.plan.emergency, { months: 3, basis: ["Rent", "Food"] }, "names take the plan's own spelling");
  assert.equal(planEmergencyTarget(r.plan), 3 * (50000 + 120000));
  assert.equal(planEmergencyTarget(parsePlan(file((o) => { delete o.ef_target_basis; delete o.ef_target_months; })).plan), null);
});
test("the basis must be spelled out: adding a name changes the target", () => {
  const plan = parsePlan(file((o) => { o.ef_target_basis = ["Rent", "Food", "Apartment Fund"]; })).plan;
  assert.equal(planEmergencyTarget(plan), 3 * (50000 + 120000 + 170000));
});
test("each payday's lines must sum to its expected income exactly, and the error says by how much", () => {
  let r = parsePlan(file((o) => { o.lines[1].second = 501; }));
  assert.equal(r.ok, false);
  assert.match(r.error, /2nd payday add up to 2401 but its expected income is 2400 \(over by 1\)/);
  r = parsePlan(file((o) => { o.paydays[0].expected_income = 1100; }));
  assert.match(r.error, /1st add up to 1000 but its expected income is 1100 \(short by 100\)/);
});
test("the unit is declared, never guessed; centavos are accepted when declared", () => {
  assert.match(parsePlan(file((o) => delete o.unit)).error, /declare its unit/);
  assert.match(parsePlan(file((o) => { o.unit = "pesos"; })).error, /declare its unit/);
  assert.match(parsePlan(file((o) => { o.lines[1].second = 500.5; })).error, /whole peso/, "a decimal peso is not accepted");
  const c = parsePlan(JSON.stringify({ ...base(), unit: "PHP_centavos", paydays: [{ day: 15, expected_income: 1000 }, { day: "last", expected_income: 2400 }], lines: [{ name: "A", first: 1000, second: 2400 }], ef_target_basis: undefined, ef_target_months: undefined }));
  assert.equal(c.ok, true);
  assert.equal(c.plan.lines[0].first, 1000, "centavos stay centavos");
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
    ["not json", "{", /could not be read/], ["schema", file((o) => { o.schema_version = 2; }), /schema_version 1/],
    ["one payday", file((o) => { o.paydays.pop(); }), /two paydays/], ["2nd before 1st", file((o) => { o.paydays[1].day = 10; }), /2nd payday day/],
    ["no income", file((o) => { delete o.paydays[0].expected_income; }), /expected_income/], ["no lines", file((o) => { o.lines = []; }), /1 and 60/],
    ["duplicate line", file((o) => { o.lines[1].name = "FOOD"; }), /twice/],
    ["negative", file((o) => { o.lines[1].first = -1; }), /whole peso/], ["bad kind", file((o) => { o.lines[1].kind = "x"; }), /unknown kind/],
    ["basis not in plan", file((o) => { o.ef_target_basis = ["Nope"]; }), /ef_target_basis/], ["basis twice", file((o) => { o.ef_target_basis = ["Rent", "rent"]; }), /twice/],
    ["months", file((o) => { o.ef_target_months = 0; }), /1 to 24/], ["basis without months", file((o) => { delete o.ef_target_months; }), /1 to 24/],
  ];
  for (const [name, text, re] of bad) { const r = parsePlan(text); assert.equal(r.ok, false, name); assert.match(r.error, re, name); }
});
test("plans are append-only and dated; the one in effect is the latest that has started", () => {
  const p1 = parsePlan(file()).plan, p2 = parsePlan(file((o) => { o.effective_from = "2027-01-01"; })).plan;
  let r = addPlan([], p1); assert.equal(r.ok, true);
  r = addPlan(r.plans, p2); assert.equal(r.plans.length, 2);
  assert.equal(planInEffect(r.plans, "2026-10-14"), null, "before the first plan starts there is none");
  assert.equal(planInEffect(r.plans, "2026-12-31").effective_from, "2026-10-15");
  assert.equal(planInEffect(r.plans, "2027-01-01").effective_from, "2027-01-01");
  assert.equal(addPlan(r.plans, p1).unchanged, true, "loading the same plan again changes nothing");
  const edited = parsePlan(file((o) => { o.lines[1].second = 400; o.lines[2].second = 1400; })).plan;
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
test("progress counts verified spending in the cutoff only, per line, and flags what it cannot match", () => {
  const s = makeState();
  s.categories.push({ id: "rent", name: "Rent", kind: "expense" });
  s.accounts.push(account({ id: "cash", name: "Test Cash", class: "asset", opening_balance: 10000000 }));
  const spend = (id, date, cat, amt, extra) => commit(s, { transaction: tx({ id, date, status: "verified", verified_at: date + "T08:00:00.000+08:00", ...extra }), entries: [entry({ transaction_id: id, category_id: cat, amount: amt }), entry({ transaction_id: id, account_id: "cash", amount: -amt })] });
  spend("a", "2026-10-16", "food", 65000);
  spend("c", "2026-10-18", "food", 5000, { status: "draft", verified_at: undefined });
  spend("d", "2026-10-31", "food", 99900);   // the next cutoff
  const p = planProgress(s, parsePlan(file()).plan, "2026-10-20");
  assert.equal(p.period.index, 1);
  const food = p.rows.find((r) => r.name === "Food");
  assert.deepEqual([food.planned, food.spent, food.remaining], [60000, 65000, -5000], "over is a negative number, shown plainly");
  assert.equal(p.rows.find((r) => r.name === "Rent").spent, 0);
  assert.equal(p.rows.find((r) => r.name === "Apartment Fund").spent, null, "goal lines are plans only");
  const odd = planProgress(s, parsePlan(file((o) => { o.lines[1].name = "Mystery"; o.ef_target_basis = ["Food"]; })).plan, "2026-10-20");
  assert.equal(odd.rows[1].matched, false);
});

test("income variance compares the plan's planning income with the true pay received, never editing the plan", () => {
  const s = makeState();
  s.categories.push({ id: "sal", name: "Salary", kind: "income" });
  s.accounts.push(account({ id: "bank", name: "Test Bank", class: "asset" }));
  const plan = parsePlan(file()).plan;   // first payday planning income: 100000 centavos
  const rec = (id, date, amount) => planPayReceived(s, { transaction_id: id, date, amount, account_id: "bank" });
  let r = rec("p1", "2026-10-15", 99998);       // true pay 2 centavos short of the plan
  assert.equal(r.ok, true);
  Object.assign(s, r.state);
  r = rec("p2", "2026-10-20", 5000);            // an overtime payment in the same cutoff
  Object.assign(s, r.state);
  const v = planIncome(s, plan, "2026-10-20");
  assert.deepEqual([v.label, v.planned, v.actual, v.variance, v.count], ["1st", 100000, 104998, 4998, 2]);
  const next = planIncome(s, plan, "2026-10-31");
  assert.deepEqual([next.planned, next.actual, next.variance], [240000, 0, -240000], "a payday not yet received shows the whole plan as short");
  assert.equal(plan.paydays[0].income, 100000, "the plan is untouched");
});
test("pay received is refused when it makes no sense, and is saved verified when it does", () => {
  const s = makeState();
  s.categories.push({ id: "sal", name: "Salary", kind: "income" });
  s.accounts.push(account({ id: "bank", name: "Test Bank", class: "asset" }));
  const ok = planPayReceived(s, { transaction_id: "p", date: "2026-10-15", amount: 977698, account_id: "bank" });
  assert.deepEqual([ok.ok, ok.transaction.status, ok.entries.map((e) => e.amount)], [true, "verified", [977698, -977698]]);
  for (const [o, code] of [[{ amount: 0 }, "BAD_AMOUNT"], [{ amount: 1.5 }, "BAD_AMOUNT"], [{ account_id: "card" }, "UNKNOWN_ACCOUNT"], [{ category_id: "food" }, "UNKNOWN_CATEGORY"], [{ date: "10/15" }, "BAD_DATE"]]) {
    assert.equal(planPayReceived(s, { transaction_id: "p", date: "2026-10-15", amount: 100, account_id: "bank", ...o }).violations[0].code, code);
  }
});
