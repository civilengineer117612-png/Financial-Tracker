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
test("without the roles on any category the default basis is empty and the status is null; the words Rent and Food alone find nothing", () => {
  const s = ledger(0); s.categories = s.categories.map((c) => ({ ...c, role: undefined }));
  assert.equal(emergencyFundStatus(s, raw().plan, s.goals[0]), null);
  const only = ledger(0); only.categories = only.categories.filter((c) => c.role !== "rent");
  const e = emergencyFundStatus(only, raw().plan, only.goals[0]);
  assert.equal(e.target, 3 * (250000 + 120000), "a role with no category is left out");
});
