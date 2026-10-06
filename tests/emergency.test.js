import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, emergencyFundStatus } from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

// Invented numbers, whole pesos. Rent 4,000 + Food 2,500 + Essentials 1,200 = 7,700 a month.
const raw = (edit) => {
  const o = {
    schema_version: 1, unit: "PHP_whole_pesos", effective_from: "2026-10-15",
    paydays: [{ id: "a", label: "1st", day: 15, expected_income: 6000 }, { id: "b", day: "last", expected_income: 6000 }],
    lines: [
      { name: "Rent", kind: "expense", first: 0, second: 4000 }, { name: "Food", kind: "expense", first: 1250, second: 1250 },
      { name: "Essentials", kind: "expense", first: 600, second: 600 }, { name: "Emergency Fund", kind: "goal", first: 1000, second: 1000 },
      { name: "Fun", kind: "expense", first: 3150, second: 150 },
    ],
  };
  edit?.(o);
  o.paydays[0].expected_income = o.lines.reduce((n, l) => n + l.first, 0); o.paydays[1].expected_income = o.lines.reduce((n, l) => n + l.second, 0);   // each payday's lines add up to its income
  return parsePlan(JSON.stringify(o));
};
function ledger(balance) {
  const s = makeState();
  s.accounts.push(account({ id: "efa", name: "Test EF Pocket", class: "asset", opening_balance: balance }));
  s.categories = s.categories.map((c) => (c.id === "food" ? { ...c, role: "food" } : c));
  s.categories.push({ id: "c-rent", name: "Rent", kind: "expense", role: "rent" }, { id: "c-ess", name: "Essentials", kind: "expense", role: "essentials" });
  s.goals = [{ id: "ef", account_id: "efa", name: "Emergency Fund", hidden_by_default: true }];
  return s;
}

test("the target is 3 x (Rent + Food + Essentials) from the plan, with no number typed in", () => {
  const r = raw(); assert.ok(r.ok, r.error);
  const e = emergencyFundStatus(ledger(500000), r.plan, ledger(0).goals[0]);
  assert.equal(e.target, 3 * (400000 + 250000 + 120000));
  assert.deepEqual(e.basis, ["Rent", "Food", "Essentials"]);
  assert.deepEqual(e.missing, []);
  assert.equal(e.months, 3);
});
test("balance, monthly contribution and months to target come from the ledger and the plan", () => {
  const e = emergencyFundStatus(ledger(500000), raw().plan, ledger(0).goals[0]);
  assert.equal(e.balance, 500000);
  assert.equal(e.monthly, 200000);
  assert.equal(e.remaining, 2310000 - 500000);
  assert.equal(e.monthsToTarget, Math.ceil(1810000 / 200000));   // 10
  assert.equal(e.percent, Math.floor((500000 * 100) / 2310000));
});
test("a new plan changes the target by itself: nothing is stored", () => {
  const goal = ledger(0).goals[0], s = ledger(0);
  const before = emergencyFundStatus(s, raw().plan, goal).target;
  const after = emergencyFundStatus(s, raw((o) => { o.lines.find((l) => l.name === "Rent").second = 5000; o.lines.find((l) => l.name === "Fun").second = 0; }).plan, goal);
  assert.equal(after === null, false);
  assert.equal(after.target - before, 3 * 100000);
  assert.equal(goal.target, undefined, "the goal itself never holds a target");
});
test("the plan may set its own months and names; the default holds when it does not", () => {
  const r = raw((o) => { o.ef_target_basis = ["Rent", "Food"]; o.ef_target_months = 6; });
  assert.ok(r.ok, r.error);
  const e = emergencyFundStatus(ledger(0), r.plan, ledger(0).goals[0]);
  assert.equal(e.target, 6 * (400000 + 250000));
  assert.equal(e.months, 6);
});
test("a missing basis line is named, not silently ignored; no basis line at all gives nothing", () => {
  const r = raw((o) => { o.lines = o.lines.filter((l) => l.name !== "Essentials"); o.lines.find((l) => l.name === "Fun").first += 600; o.lines.find((l) => l.name === "Fun").second += 600; });
  assert.ok(r.ok, r.error);
  const e = emergencyFundStatus(ledger(0), r.plan, ledger(0).goals[0]);
  assert.deepEqual(e.missing, ["Essentials"]);
  assert.equal(e.target, 3 * (400000 + 250000));
  const none = raw((o) => { o.lines = o.lines.filter((l) => !["Rent", "Food", "Essentials"].includes(l.name)); });
  if (none.ok) assert.equal(emergencyFundStatus(ledger(0), none.plan, ledger(0).goals[0]), null);
  assert.equal(emergencyFundStatus(ledger(0), null, ledger(0).goals[0]), null);
});
test("reached funds show zero months; no plan contribution leaves months to target unknown", () => {
  const full = emergencyFundStatus(ledger(3000000), raw().plan, ledger(0).goals[0]);
  assert.deepEqual([full.reached, full.monthsToTarget, full.remaining, full.percent], [true, 0, 0, 100]);
  const noLine = emergencyFundStatus(ledger(0), raw((o) => { o.lines = o.lines.filter((l) => l.name !== "Emergency Fund"); o.lines.find((l) => l.name === "Fun").first += 1000; o.lines.find((l) => l.name === "Fun").second += 1000; }).plan, ledger(0).goals[0]);
  assert.equal(noLine.monthly, 0);
  assert.equal(noLine.monthsToTarget, null);
});

// ----- the target reads category ROLES, not the words Rent, Food and Essentials -----
import { oldEmergencyFundStatus } from "./old-ef.js";
import { renameCategory } from "../src/model/index.js";

test("BEFORE/AFTER: with the usual names the status is exactly what it was, and the same goes for a plan that sets its own basis", () => {
  for (const edit of [undefined, (o) => { o.ef_target_basis = ["Rent", "Food"]; o.ef_target_months = 6; }]) {
    const r = raw(edit), s = ledger(500000), goal = s.goals[0];
    assert.deepEqual(emergencyFundStatus(s, r.plan, goal), oldEmergencyFundStatus(s, r.plan, goal));
  }
  assert.equal(emergencyFundStatus(ledger(0), raw().plan, ledger(0).goals[0]).target, 3 * 770000, "3 x (4,000 + 2,500 + 1,200) pesos");
});
test("a category renamed from Food to Groceries still counts: the target follows the role, the plan line carries the category's current name", () => {
  const s = ledger(0), goal = s.goals[0];
  const renamed = renameCategory(s, "food", "Groceries");
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  const r = raw((o) => { o.lines.find((l) => l.name === "Food").name = "Groceries"; });
  assert.ok(r.ok, r.error);
  const e = emergencyFundStatus(renamed.state, r.plan, goal);
  assert.equal(e.target, 3 * 770000); assert.deepEqual(e.basis, ["Rent", "Groceries", "Essentials"]);
  assert.equal(oldEmergencyFundStatus(renamed.state, r.plan, goal).target, 3 * (400000 + 120000), "the old code found only the Rent and Essentials lines");
});
test("with no stored kinds the names are read instead (Rent, Food, Essentials count); a name that says something else is left out", () => {
  const s = ledger(0); s.categories = s.categories.map((c) => ({ ...c, role: undefined }));
  const e = emergencyFundStatus(s, raw().plan, s.goals[0]);
  assert.equal(e.target, 3 * (400000 + 250000 + 120000), "read from the names, the same three as before");
  const odd = ledger(0); odd.categories = odd.categories.map((c) => ({ ...c, role: undefined, name: c.role === "rent" ? "Lola" : c.name }));
  assert.equal(emergencyFundStatus(odd, raw().plan, odd.goals[0]).target, 3 * (250000 + 120000), "a name with no rent word is left out");
  const only = ledger(0); only.categories = only.categories.filter((c) => c.role !== "rent");
  assert.equal(emergencyFundStatus(only, raw().plan, only.goals[0]).target, 3 * (250000 + 120000), "no rent category at all: left out");
  const none = ledger(0); none.categories = none.categories.map((c) => ({ ...c, role: undefined, name: "Zz" + c.id }));
  assert.equal(emergencyFundStatus(none, raw().plan, none.goals[0]), null, "nothing reads as rent, food or essentials: no target");
});

test("a stored kind still wins over the name: a category named Food that holds the kind Fun is not counted", () => {
  const s = ledger(0); s.categories = s.categories.map((c) => (c.role === "food" ? { ...c, role: "fun" } : c));
  assert.equal(emergencyFundStatus(s, raw().plan, s.goals[0]).target, 3 * (400000 + 120000));
});

// ----- no plan: the target from the budgets of the rent, food and essentials categories -----
import { emergencyFundFromBudgets, planBudgetChange } from "../src/model/index.js";
test("with no plan the target is 3 x this month's budgets for the rent, food and essentials categories, and follows them", () => {
  let s = ledger(500000); s.rules = []; const goal = s.goals[0];
  assert.equal(emergencyFundFromBudgets(s, goal, { month: "2026-10" }), null, "no budgets, no target");
  const set = (cat, amount, id) => { s = planBudgetChange(s, { id, category_id: cat, amount, from_month: "2026-10" }, new Date()).state; };
  set("c-rent", 400000, "b1"); set("food", 250000, "b2"); set("c-ess", 120000, "b3");
  const e = emergencyFundFromBudgets(s, goal, { month: "2026-10" });
  assert.equal(e.target, 3 * 770000); assert.deepEqual(e.basis, ["Rent", "Food", "Essentials"]); assert.equal(e.source, "budgets"); assert.equal(e.monthlyBasis, 770000);
  assert.equal(e.balance, 500000); assert.equal(e.remaining, 3 * 770000 - 500000); assert.equal(e.reached, false); assert.equal(e.percent, Math.floor((500000 * 100) / (3 * 770000)));
  assert.equal(emergencyFundFromBudgets(s, goal, { month: "2026-09" }), null, "budgets of a later month do not reach back");
  set("c-rent", 450000, "b4");
  assert.equal(emergencyFundFromBudgets(s, goal, { month: "2026-10" }).target, 3 * 820000, "it follows the budgets");
  const same = emergencyFundStatus(s, raw().plan, goal);
  assert.equal(same.target, 3 * 770000, "with a plan, the plan still decides (unchanged)");
  const rentOnly = ledger(0); rentOnly.categories = rentOnly.categories.filter((c) => c.role === "rent");
  assert.equal(emergencyFundFromBudgets(rentOnly, rentOnly.goals[0], { month: "2026-10" }), null, "a role with no budget is left out; none at all is no target");
  assert.equal(emergencyFundFromBudgets(s, null, { month: "2026-10" }), null);
  const full = emergencyFundFromBudgets(ledger(5000000), goal, { month: "2026-10" });
  assert.equal(full, null, "that ledger has no budgets");
  const big = ledger(3000000); big.rules = s.rules; assert.equal(emergencyFundFromBudgets(big, big.goals[0], { month: "2026-10" }).reached, true);
});
test("the Goals screen uses the plan when there is one and the budgets when there is not", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  assert.match(app, /ef = !isEf \? null : planOf\(\) \? M\.emergencyFundStatus\(S\(\), planOf\(\), g\) : M\.emergencyFundFromBudgets\(S\(\), g, \{ month: M\.monthOf\(today\(\)\) \}\);/);
  assert.match(app, /from \$\{ef\.source === "budgets" \? "your budgets" : "your plan"\}/);
});
