import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetGrade, monthElapsedPercent, suggestedBudgetStart, budgetFor, planBudgetChange, budgetStatus, budgetTrend, defaultCategories, checkRulesSave } from "../src/model/index.js";
import { makeState, rule, account, tx, entry, commit } from "./fixtures.js";

const S = () => { const s = makeState(); s.categories = defaultCategories(); s.rules = []; return s; };
const NOW = new Date("2026-10-03T03:00:00Z");

// ---------- the grade ----------
test("grades step from green to red as the budget is used", () => {
  const g = (spent) => budgetGrade(spent, 10000);
  assert.deepEqual([g(0).level, g(5999).level], ["good", "good"]);
  assert.deepEqual([g(6000).level, g(8499).level], ["warning", "warning"]);
  assert.deepEqual([g(8500).level, g(9999).level], ["serious", "serious"]);
  assert.equal(g(10000).level, "serious");          // exactly the budget is used up, not over
  assert.equal(g(10001).level, "critical");         // one centavo over is red
  assert.equal(g(25000).level, "critical");
});
test("the grade carries the whole percent used, rounded down, and whether it is over", () => {
  assert.deepEqual(budgetGrade(3333, 10000), { level: "good", percent: 33, over: false });
  assert.deepEqual(budgetGrade(9999, 10000), { level: "serious", percent: 99, over: false });
  assert.deepEqual(budgetGrade(10000, 10000), { level: "serious", percent: 100, over: false });
  assert.deepEqual(budgetGrade(12500, 10000), { level: "critical", percent: 125, over: true });
});
test("a refund never makes a negative percent; no budget means no grade", () => {
  assert.deepEqual(budgetGrade(-500, 10000), { level: "good", percent: 0, over: false });
  assert.equal(budgetGrade(500, null), null);
  assert.equal(budgetGrade(500, 0), null);
  assert.equal(budgetGrade(500, undefined), null);
});

// ---------- the pace mark ----------
test("how far through the month: past months are full, future ones empty, this one by the day", () => {
  assert.equal(monthElapsedPercent("2026-09", "2026-10-03"), 100);
  assert.equal(monthElapsedPercent("2026-11", "2026-10-03"), 0);
  assert.equal(monthElapsedPercent("2026-10", "2026-10-31"), 100);
  assert.equal(monthElapsedPercent("2026-10", "2026-10-03"), 10);    // 3 of 31 days
  assert.equal(monthElapsedPercent("2026-02", "2026-02-14"), 50);    // 14 of 28
  assert.equal(monthElapsedPercent("2028-02", "2028-02-29"), 100);   // leap year
  assert.equal(monthElapsedPercent("2028-02", "2028-02-14"), 48);    // 14 of 29
});

// ---------- setting a budget ----------
test("a first budget starts this month; a change to an existing one starts next month", () => {
  assert.equal(suggestedBudgetStart([], "cat-food", "2026-10-03"), "2026-10");
  assert.equal(suggestedBudgetStart([rule({ subject_id: "cat-food" })], "cat-food", "2026-10-03"), "2026-11");
  assert.equal(suggestedBudgetStart([rule({ subject_id: "cat-food" })], "cat-rent", "2026-10-03"), "2026-10");   // another category's budget does not count
  assert.equal(suggestedBudgetStart([rule({ subject_id: "cat-food" })], "cat-food", "2026-12-20"), "2027-01");
});
test("setting a budget appends a dated row and leaves history alone", () => {
  const s = S();
  const a = planBudgetChange(s, { id: "b1", category_id: "cat-food", amount: 400000, from_month: "2026-10" }, NOW);
  assert.equal(a.ok, true);
  assert.deepEqual(a.state.rules.map((r) => [r.kind, r.subject_id, r.amount, r.effective_from]), [["budget", "cat-food", 400000, "2026-10-01"]]);
  assert.equal(s.rules.length, 0);   // the original state is untouched
  const b = planBudgetChange(a.state, { id: "b2", category_id: "cat-food", amount: 450000, from_month: "2026-11" }, NOW);
  assert.equal(b.state.rules.length, 2);
  assert.deepEqual(b.state.rules[0], a.state.rules[0]);   // the first row is exactly as it was
  assert.equal(checkRulesSave(a.state.rules, b.state.rules).ok, true);
});
test("the budget in effect follows the dates, and 0 removes a budget from its month on", () => {
  let s = S();
  s = planBudgetChange(s, { id: "b1", category_id: "cat-food", amount: 400000, from_month: "2026-10" }, NOW).state;
  s = planBudgetChange(s, { id: "b2", category_id: "cat-food", amount: 450000, from_month: "2026-12" }, NOW).state;
  s = planBudgetChange(s, { id: "b3", category_id: "cat-food", amount: 0, from_month: "2027-02" }, NOW).state;
  assert.deepEqual(["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"].map((m) => budgetFor(s.rules, "cat-food", m)),
    [null, 400000, 400000, 450000, 450000, null, null]);
});
test("a removed budget shows as no budget in the month report, with its spending still counted", () => {
  let s = S();
  s = planBudgetChange(s, { id: "b1", category_id: "cat-food", amount: 0, from_month: "2026-10" }, NOW).state;
  const row = budgetStatus(s, { rules: s.rules, month: "2026-10", asOf: "2026-10-31" });
  assert.equal(row.find((r) => r.category_id === "cat-food")?.budget ?? null, null);
});
test("bad budgets are refused, never thrown", () => {
  const s = S(), base = { id: "b", category_id: "cat-food", amount: 1000, from_month: "2026-10" };
  for (const [o, code] of [[{ amount: -1 }, "BAD_AMOUNT"], [{ amount: 10.5 }, "BAD_AMOUNT"], [{ amount: "100" }, "BAD_AMOUNT"],
    [{ from_month: "2026-13" }, "BAD_MONTH"], [{ from_month: "2026-1" }, "BAD_MONTH"], [{ from_month: undefined }, "BAD_MONTH"],
    [{ category_id: "nope" }, "UNKNOWN_CATEGORY"], [{ category_id: "cat-salary" }, "UNKNOWN_CATEGORY"], [{ category_id: "cat-unlogged" }, "UNKNOWN_CATEGORY"]]) {
    const r = planBudgetChange(s, { ...base, ...o }, NOW);
    assert.equal(r.ok, false, code);
    assert.equal(r.violations[0].code, code);
    assert.equal(r.state, s);
  }
});
test("reusing a rule id is refused so history cannot be overwritten", () => {
  let s = S();
  s = planBudgetChange(s, { id: "same", category_id: "cat-food", amount: 1000, from_month: "2026-10" }, NOW).state;
  const r = planBudgetChange(s, { id: "same", category_id: "cat-food", amount: 2000, from_month: "2026-11" }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.state, s);
});

// ---------- the monthly trend ----------
function spendOn(s, id, date, amount) {
  commit(s, { transaction: tx({ id, date, status: "verified", verified_at: date + "T08:00:00.000+08:00" }), entries: [
    entry({ transaction_id: id, category_id: "cat-food", amount }), entry({ transaction_id: id, account_id: "chk", amount: -amount })] });
}
test("the trend uses each month's own budget and shows a gap, never an error, where there is nothing", () => {
  let s = S();
  s.accounts.push(account({ id: "chk", name: "Test", class: "asset", opening_balance: 10000000 }));
  s = planBudgetChange(s, { id: "b1", category_id: "cat-food", amount: 100000, from_month: "2026-08" }, NOW).state;
  s = planBudgetChange(s, { id: "b2", category_id: "cat-food", amount: 150000, from_month: "2026-10" }, NOW).state;
  spendOn(s, "a", "2026-08-05", 30000);
  spendOn(s, "b", "2026-10-02", 20000);
  const t = budgetTrend(s, { endMonth: "2026-10", months: 5 });
  assert.deepEqual(t.map((x) => x.month), ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(t.map((x) => x.budget), [null, null, 100000, 100000, 150000], "August's budget stays August's");
  assert.deepEqual(t.map((x) => x.actual), [null, null, 30000, null, 20000], "no transactions that month is a gap, not zero");
});
