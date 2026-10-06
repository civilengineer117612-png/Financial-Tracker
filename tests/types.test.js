import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePlan, emergencyFundStatus, emergencyFundFromBudgets, suggestBudgets, categoriesByRole, categoryByRole, defaultCategories, planBudgetChange, ROLE_LABELS, CATEGORY_ROLES } from "../src/model/index.js";
import { UNLOGGED_CATEGORY_ID } from "../src/model/seed.js";
import { makeState, account } from "./fixtures.js";

// Invented numbers only. 100 centavos = 1 peso.
const cat = (id, name, role) => ({ id, name, kind: "expense", ...(role ? { role } : {}) });

test("Lakat on its own is a Fun guess (a Filipino word for going out)", async () => {
  const { guessType } = await import("../src/model/index.js");
  assert.equal(guessType("Lakat"), "fun"); assert.equal(guessType("Lakat / hangout"), "fun");
});

test("the Types are the twelve the owner chose, in that order, with their words", () => {
  assert.deepEqual(CATEGORY_ROLES.map((r) => ROLE_LABELS[r]), ["Rent", "Food", "Transport", "Utilities", "Subscription", "Shopping", "Dining out", "Fun", "Family", "Invest in yourself", "Debt payment", "Other"]);
});

test("many categories can share a Type, and the lookups return all of them (categoryByRole still gives the first)", () => {
  const cs = [cat("a", "Flat", "rent"), cat("b", "Parking space", "rent"), cat("c", "Food", "food")];
  assert.deepEqual(categoriesByRole(cs, "rent").map((x) => x.id), ["a", "b"]);
  assert.equal(categoryByRole(cs, "rent").id, "a");
  assert.deepEqual(categoriesByRole(cs, "debt"), []);
});

test("a new install's Other category has the Type Other, so nothing on it is a guess", () => {
  const other = defaultCategories().find((x) => x.id === "cat-other");
  assert.equal(other.role, "other");
});

function efState() {
  const s = makeState();
  s.accounts.push(account({ id: "efa", name: "Test EF Pocket", class: "asset", opening_balance: 0 }));
  s.categories = [cat("r1", "Flat", "rent"), cat("r2", "Garage", "rent"), cat("f1", "Groceries", "food"), cat("f2", "Eating in", "food"), cat("e1", "Basics", "essentials"), cat("x", "Fun", "fun"), { id: "pay", name: "Pay", kind: "income" }];
  s.goals = [{ id: "ef", account_id: "efa", name: "Emergency Fund", hidden_by_default: true, role: "emergency" }];
  s.rules = [];
  return s;
}
const budget = (s, id, amount) => { const r = planBudgetChange(s, { id: "rule-" + id, category_id: id, amount, from_month: "2026-10" }, new Date("2026-10-01T00:00:00Z")); assert.ok(r.ok, JSON.stringify(r.violations)); return r.state; };

test("the Emergency Fund target from the budgets sums ALL categories of the rent, food and essentials Types", () => {
  let s = efState();
  for (const [id, a] of [["r1", 400000], ["r2", 50000], ["f1", 200000], ["f2", 30000], ["e1", 120000], ["x", 999999]]) s = budget(s, id, a);
  const e = emergencyFundFromBudgets(s, s.goals[0], { month: "2026-10" });
  assert.equal(e.target, 3 * (400000 + 50000 + 200000 + 30000 + 120000));
  assert.deepEqual(e.basis.sort(), ["Basics", "Eating in", "Flat", "Garage", "Groceries"]);
});

test("the Emergency Fund target from a plan reads the lines of ALL those categories", () => {
  const s = efState();
  const o = { schema_version: 1, unit: "PHP_whole_pesos", effective_from: "2026-10-15", paydays: [{ id: "a", label: "1st", day: 15, expected_income: 0 }, { id: "b", day: "last", expected_income: 0 }],
    lines: [{ name: "Flat", kind: "expense", first: 0, second: 4000 }, { name: "Garage", kind: "expense", first: 0, second: 500 }, { name: "Groceries", kind: "expense", first: 1000, second: 1000 },
      { name: "Fun", kind: "expense", first: 500, second: 0 }, { name: "Emergency Fund", kind: "goal", first: 0, second: 0 }] };
  o.paydays[0].expected_income = o.lines.reduce((n, l) => n + l.first, 0); o.paydays[1].expected_income = o.lines.reduce((n, l) => n + l.second, 0);
  const r = parsePlan(JSON.stringify(o)); assert.ok(r.ok, r.error);
  const e = emergencyFundStatus(s, r.plan, s.goals[0]);
  assert.equal(e.target, 3 * (400000 + 50000 + 200000));
  assert.deepEqual(e.basis, ["Flat", "Garage", "Groceries"]);
});

function starter() {
  const s = makeState();
  s.accounts = [account({ id: "chk", name: "Test Checking", class: "asset", opening_balance: 100000000 })];
  s.categories = [cat("a", "Flat", "rent"), cat("b", "Garage", "rent"), cat("food", "Food", "food"), cat(UNLOGGED_CATEGORY_ID, "Unlogged"), { id: "pay", name: "Pay", kind: "income" }];
  s.payslips = []; s.payslipLines = []; s.subscriptions = []; s.goals = []; s.rules = [];
  return s;
}
const sug = (state, o = {}) => suggestBudgets({ state, today: "2026-10-05", month: "2026-10", pin: 10000000, ...o });

test("with two Rent categories the typed rent is asked once and goes on the first; neither takes a share of the needs pool", () => {
  assert.equal(sug(starter()).code, "NEEDS_RENT");
  const r = sug(starter(), { rent: 2000000 });
  assert.equal(r.ok, true);
  assert.equal(r.rows.find((x) => x.category_id === "a").amount, 2000000);
  assert.equal(r.rows.find((x) => x.category_id === "b").amount, 0);
});

test("a category with no stored Type whose name is Rent also gets the rent question (the guess counts for the budget, until confirmed)", () => {
  const s = starter(); s.categories = s.categories.filter((x) => x.id !== "a" && x.id !== "b").concat([cat("a", "Upa")]);
  assert.equal(sug(s).code, "NEEDS_RENT");
  const none = starter(); none.categories = none.categories.filter((x) => x.id !== "a" && x.id !== "b");
  assert.equal(sug(none).ok, true, "with no rent category at all nothing is asked");
});

test("the screens say Type, show Name, Type, Bucket, mark guesses, and warn about unconfirmed money with a link to the rows", () => {
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8"), help = readFileSync(new URL("../src/model/help.js", import.meta.url), "utf8");
  assert.match(app, /const catLine = \(c\) =>/);
  assert.match(app, /\\u00b7 \$\{esc\(M\.BUCKET_LABELS\[b\]\)\}/);
  assert.match(app, /" \(guess\)"/); assert.match(app, /"Type not set"/);
  assert.match(app, /Includes \$\{peso\(bk\.unconfirmed\.amount\)\} from \$\{bk\.unconfirmed\.count\} unconfirmed/);
  assert.match(app, /data-action="goto-confirm">confirm them/);
  assert.match(app, /id="bud-confirm"/);
  assert.ok(!/>Role</.test(app) && !/already has the role/.test(app), "the word Role is gone from the screens");
  assert.ok(/tap Type/.test(help) && !/tap Role/.test(help));
});
