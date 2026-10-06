import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, planWithBudgets, planBudgetMismatches, planBudgetRows, budgetMonthFor, budgetFor, planBudgetChange, cutoffFor, planProgress, planIncome, planTotals, renameCategory, planInEffect } from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

// Invented numbers. Whole pesos in the files, centavos everywhere else.
const TS = "2026-01-01T09:00:00.000+08:00";
function base() {
  const s = makeState();
  s.accounts = [account({ id: "chk", name: "Test Checking", class: "asset", opening_balance: 100000000 })];
  s.categories = [{ id: "food", name: "Food", kind: "expense", role: "food" }, { id: "rent", name: "Rent", kind: "expense", role: "rent" }, { id: "fun", name: "Fun", kind: "expense" },
    { id: "cat-unlogged", name: "Unlogged", kind: "expense" }, { id: "pay", name: "Pay", kind: "income" }];
  s.rules = [];
  return s;
}
const file = (edit) => {
  const o = { schema_version: 1, unit: "PHP_whole_pesos", effective_from: "2026-11-01",
    paydays: [{ day: 15, expected_income: 1000 }, { day: "last", expected_income: 2400 }],
    lines: [{ name: "Food", kind: "expense", first: 300, second: 300 }, { name: "Rent", kind: "expense", first: 0, second: 800 }, { name: "Fun", kind: "expense", first: 200, second: 100 },
      { name: "Cushion", kind: "goal", first: 500, second: 1200 }, { name: "Mystery", kind: "expense", first: 0, second: 0 }] };
  edit?.(o);
  return parsePlan(JSON.stringify(o));
};
let k = 0; const newId = () => "r" + ++k;
const run = (s, plan, o = {}) => planWithBudgets(s, o.settings ?? {}, { plan, newId, now: new Date("2026-10-06T00:00:00Z"), ...o });

test("one save writes the plan row AND the budget rules it implies, and afterwards they agree exactly", () => {
  const p = file().plan, s = base(), snap = JSON.stringify(s);
  const r = run(s, p);
  assert.equal(r.ok, true); assert.equal(JSON.stringify(s), snap, "the input is not changed");
  assert.equal(r.settings.plans.length, 1); assert.deepEqual(r.settings.plans[0], p);
  assert.deepEqual(r.changes.map((c) => [c.name, c.from, c.to]), [["Food", null, 60000], ["Rent", null, 80000], ["Fun", null, 30000]], "each is first + second, in centavos");
  assert.deepEqual(r.unmatched, ["Mystery"], "a line that matches no category is named, not guessed");
  assert.equal(r.month, "2026-11");
  assert.deepEqual(planBudgetMismatches(r.state, r.settings, "2026-11").mismatches, []);
  assert.ok(!r.state.rules.some((x) => x.subject_id === "Cushion" || x.kind !== "budget"), "goal lines are not budgets");
  assert.deepEqual(planBudgetRows(s, p).rows.map((x) => x.category_id), ["food", "rent", "fun"]);
});

test("budgets start the month the plan starts when it starts on the 1st, and the month after when it starts mid-month", () => {
  assert.equal(budgetMonthFor("2026-11-01"), "2026-11"); assert.equal(budgetMonthFor("2026-10-15"), "2026-11"); assert.equal(budgetMonthFor("2026-12-31"), "2027-01");
  const r = run(base(), file((o) => { o.effective_from = "2026-10-15"; }).plan);
  assert.equal(r.month, "2026-11"); assert.ok(r.state.rules.every((x) => x.effective_from === "2026-11-01"));
  assert.equal(budgetFor(r.state.rules, "food", "2026-10"), null, "October's budgets are untouched");
  assert.deepEqual(planBudgetMismatches(r.state, r.settings, "2026-10").mismatches, [], "October still has no plan in force on its 1st, so nothing disagrees");
  assert.deepEqual(planBudgetMismatches(r.state, r.settings, "2026-11").mismatches, []);
});

test("it is all or nothing: a refused plan or a refused budget returns the old state and settings untouched", () => {
  const first = run(base(), file().plan);
  const other = file((o) => { o.lines[0].first = 350; o.paydays[0].expected_income = 1050; }).plan;
  const dup = planWithBudgets(first.state, first.settings, { plan: other, newId, now: new Date() });
  assert.equal(dup.ok, false); assert.match(dup.message, /already saved/);
  assert.equal(dup.state, first.state); assert.equal(dup.settings, first.settings);
  const same = () => "same-id";
  const clash = planWithBudgets(base(), {}, { plan: file().plan, newId: same, now: new Date() });
  assert.equal(clash.ok, false, "two rules with one id are refused");
  assert.deepEqual(clash.settings, {}, "so the plan row was not added either");
  assert.equal(clash.state.rules.length, 0);
});

test("a budget changed by hand afterwards shows as a disagreement, and matching them again appends new rows without editing history", () => {
  const w = run(base(), file().plan);
  const edited = planBudgetChange(w.state, { id: "hand", category_id: "food", amount: 99900, from_month: "2026-12" }, new Date());
  assert.equal(edited.ok, true);
  assert.deepEqual(planBudgetMismatches(edited.state, w.settings, "2026-12").mismatches.map((m) => [m.name, m.planned, m.budget]), [["Food", 60000, 99900]]);
  assert.deepEqual(planBudgetMismatches(edited.state, w.settings, "2026-11").mismatches, [], "an earlier month is not touched by a later edit");
  const synced = planWithBudgets(edited.state, w.settings, { plan: w.settings.plans[0], newId, now: new Date(), start: "2026-12", addPlanRow: false });
  assert.equal(synced.ok, true); assert.deepEqual(synced.changes.map((c) => [c.name, c.from, c.to]), [["Food", 99900, 60000]]);
  assert.deepEqual(planBudgetMismatches(synced.state, w.settings, "2026-12").mismatches, []);
  assert.deepEqual(synced.state.rules.slice(0, edited.state.rules.length), edited.state.rules, "every old row is exactly as it was");
  assert.equal(synced.settings.plans.length, 1, "no second plan row was added");
  const unsaved = planWithBudgets(base(), {}, { plan: file().plan, newId, now: new Date(), start: "2026-12", addPlanRow: false });
  assert.deepEqual(unsaved.settings.plans, [], "with addPlanRow false a plan that was never saved is not saved now");
});

test("a later plan adds new dated rows; each month agrees with the plan that governs it; the same plan twice writes nothing", () => {
  const a = run(base(), file().plan);
  const later = file((o) => { o.effective_from = "2027-01-01"; o.lines[0].first = 400; o.paydays[0].expected_income = 1100; }).plan;
  const b = planWithBudgets(a.state, a.settings, { plan: later, newId, now: new Date() });
  assert.equal(b.ok, true); assert.deepEqual(b.changes.map((c) => [c.name, c.from, c.to]), [["Food", 60000, 70000]], "only what changed");
  assert.equal(b.settings.plans.length, 2);
  for (const [m, want] of [["2026-11", 60000], ["2026-12", 60000], ["2027-01", 70000]]) {
    assert.equal(budgetFor(b.state.rules, "food", m), want, m);
    assert.deepEqual(planBudgetMismatches(b.state, b.settings, m).mismatches, [], m + " agrees");
  }
  const again = planWithBudgets(b.state, b.settings, { plan: later, newId, now: new Date() });
  assert.equal(again.ok, true); assert.deepEqual(again.changes, []); assert.equal(again.settings.plans.length, 2);
});

test("a plan that sets a line to zero removes that budget; renamed categories are matched by their current name", () => {
  const a = run(base(), file().plan);
  const zero = planWithBudgets(a.state, a.settings, { plan: file((o) => { o.effective_from = "2027-01-01"; o.lines[2].first = 0; o.lines[2].second = 0; o.paydays[0].expected_income = 800; o.paydays[1].expected_income = 2300; }).plan, newId, now: new Date() });
  assert.deepEqual(zero.changes.map((c) => [c.name, c.to]), [["Fun", 0]]); assert.equal(budgetFor(zero.state.rules, "fun", "2027-01"), null);
  const renamed = renameCategory(base(), "food", "Groceries").state;
  assert.deepEqual(planBudgetRows(renamed, file().plan).unmatched, ["Food", "Mystery"], "the old name matches nothing now");
  const p2 = file((o) => { o.lines[0].name = "Groceries"; }).plan;
  assert.deepEqual(planBudgetRows(renamed, p2).rows.map((x) => x.category_id), ["food", "rent", "fun"]);
});

test("the agreement check is exact in centavos and counts a missing budget as zero", () => {
  const w = run(base(), file().plan);
  const none = planBudgetMismatches(base(), w.settings, "2026-11");
  assert.deepEqual(none.mismatches.map((m) => [m.name, m.budget]), [["Food", null], ["Rent", null], ["Fun", null]]);
  const off = planBudgetChange(w.state, { id: "x", category_id: "rent", amount: 80001, from_month: "2026-11" }, new Date()).state;
  assert.deepEqual(planBudgetMismatches(off, w.settings, "2026-11").mismatches.map((m) => m.name), ["Rent"], "one centavo off is a disagreement");
  assert.deepEqual(planBudgetMismatches(base(), {}, "2026-11"), { plan: null, mismatches: [], unmatched: [] }, "no plan, nothing to disagree with");
});

// ----- one payday (monthly pay) -----
const monthly = (edit) => file((o) => { o.paydays = [{ day: 5, expected_income: 2400 }]; o.lines = [{ name: "Food", kind: "expense", first: 600 }, { name: "Rent", kind: "expense", first: 800 }, { name: "Cushion", kind: "goal", first: 1000 }]; edit?.(o); });

test("a plan with ONE payday loads: everything is in the first amount, the second is zero, and the lines add up to the income exactly", () => {
  const r = monthly();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.plan.paydays.length, 1); assert.equal(r.plan.paydays[0].income, 240000);
  assert.deepEqual(r.plan.lines.map((l) => [l.first, l.second]), [[60000, 0], [80000, 0], [100000, 0]]);
  assert.deepEqual(planTotals(r.plan), { first: 240000, second: 0, month: 240000 });
  assert.equal(monthly((o) => { o.lines[0].second = 0; }).ok, true, "an explicit zero second amount is fine");
  assert.match(monthly((o) => { o.lines[0].second = 50; }).error, /second amount, but the plan has one payday/);
  assert.match(monthly((o) => { o.lines[0].first = 700; }).error, /over by 100/);
  assert.match(monthly((o) => { o.paydays[0].day = 29; }).error, /1st payday day/);
});

test("a one-payday plan's cutoff is the whole stretch from one payday to the day before the next, and progress and income follow it", () => {
  const p = monthly().plan;
  assert.deepEqual(cutoffFor(p, "2026-10-20"), { index: 1, start: "2026-10-05", end: "2026-11-04" });
  assert.deepEqual(cutoffFor(p, "2026-10-05"), { index: 1, start: "2026-10-05", end: "2026-11-04" }, "the payday itself starts it");
  assert.deepEqual(cutoffFor(p, "2026-10-04"), { index: 1, start: "2026-09-05", end: "2026-10-04" });
  assert.deepEqual(cutoffFor(p, "2027-01-02"), { index: 1, start: "2026-12-05", end: "2027-01-04" }, "across the year end");
  const s = base();
  s.transactions.push({ id: "t1", date: "2026-10-10", payee: "", memo: "", status: "verified", source: "manual", created_at: TS, verified_at: TS },
    { id: "t2", date: "2026-10-02", payee: "", memo: "", status: "verified", source: "manual", created_at: TS, verified_at: TS });
  s.entries.push({ transaction_id: "t1", category_id: "food", amount: 15000 }, { transaction_id: "t1", account_id: "chk", amount: -15000 }, { transaction_id: "t2", category_id: "food", amount: 99999 }, { transaction_id: "t2", account_id: "chk", amount: -99999 });
  const prog = planProgress(s, p, "2026-10-20");
  assert.deepEqual(prog.rows.find((r) => r.name === "Food"), { name: "Food", kind: "expense", category_id: "food", planned: 60000, spent: 15000, remaining: 45000, matched: true }, "the spending before the payday belongs to the earlier cutoff");
  assert.equal(planIncome(s, p, "2026-10-20").planned, 240000);
  assert.equal(planInEffect([p], "2026-10-01"), null, "the plan is dated, as before");
});

test("a one-payday plan written with its budgets agrees with them", () => {
  const w = run(base(), monthly().plan);
  assert.equal(w.ok, true); assert.deepEqual(w.changes.map((c) => [c.name, c.to]), [["Food", 60000], ["Rent", 80000]]);
  assert.deepEqual(planBudgetMismatches(w.state, w.settings, w.month).mismatches, []);
});
