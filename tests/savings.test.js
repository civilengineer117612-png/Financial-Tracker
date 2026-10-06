import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitSavings, parseShares, shareableGoals, UNPLACED_NAME, suggestBudgets, shares, savedRows } from "../src/model/index.js";
import { UNLOGGED_CATEGORY_ID } from "../src/model/seed.js";
import { makeState, account } from "./fixtures.js";

// Invented numbers only. 100 centavos = 1 peso.
const g = (id, o = {}) => ({ id, name: id.toUpperCase(), ...o });
const prog = (id, { target = null, balance = 0 } = {}) => [id, { goal_id: id, balance, target, remaining: target == null ? null : Math.max(0, target - balance), reached: target != null && balance >= target }];
const split = (goals, p, o = {}) => splitSavings({ goals, progress: new Map(p), month: "2026-10", total: 100000, ...o });
const by = (r) => Object.fromEntries(r.parts.map((x) => [x.goal_id ?? x.name, x.amount]));
const sum = (r) => r.parts.reduce((n, x) => n + x.amount, 0);

test("with no goal at all the money is shown as Savings, not placed yet; nothing is lost", () => {
  const r = split([], []);
  assert.deepEqual(r.parts.map((x) => [x.name, x.amount]), [[UNPLACED_NAME, 100000]]);
  assert.match(r.parts[0].why, /no goal yet/i);
});

test("goals with no finish date, no emergency role and no typed amount share equally, exactly, the biggest taking the odd centavo", () => {
  const r = split([g("a"), g("b"), g("c")], [prog("a"), prog("b"), prog("c")], { total: 100001 });
  assert.equal(sum(r), 100001);
  assert.deepEqual(Object.values(by(r)).sort(), [33333, 33333, 33335]);
  assert.match(r.parts[0].why, /equally/);
});

test("the owner's percentages are used, exactly; a goal with none typed gets none once any are set", () => {
  const r = split([g("a"), g("b")], [prog("a"), prog("b")], { shares: { a: 7000, b: 3000 } });
  assert.deepEqual(by(r), { a: 70000, b: 30000 }); assert.match(r.parts[0].why, /percentages you set/);
  const odd = split([g("a"), g("b"), g("c")], [prog("a"), prog("b"), prog("c")], { total: 100001, shares: { a: 5000, b: 2500, c: 2500 } });
  assert.equal(sum(odd), 100001);
  const half = split([g("a"), g("b")], [prog("a"), prog("b")], { shares: { a: 10000 } });
  assert.deepEqual(by(half), { a: 100000, b: 0 });
  const zero = split([g("a"), g("b")], [prog("a"), prog("b")], { shares: { a: 0, b: 0 } });
  assert.deepEqual(by(zero), { a: 50000, b: 50000 }, "all zero: shared equally rather than lost");
});

test("a typed amount pins: that goal gets exactly it, out of the total first, and the others share the rest", () => {
  const r = split([g("a"), g("b"), g("c")], [prog("a"), prog("b"), prog("c")], { pins: { a: 40000 } });
  assert.deepEqual(by(r), { a: 40000, b: 30000, c: 30000 }); assert.equal(r.parts.find((x) => x.goal_id === "a").pinned, true);
  const more = split([g("a"), g("b")], [prog("a"), prog("b")], { pins: { a: 150000 } });
  assert.deepEqual(by(more), { a: 150000, b: 0 }, "typing more than the total is the owner's doing; the others get nothing");
  assert.equal(sum(more), 150000);
  const reached = split([g("a"), g("b")], [prog("a", { target: 1000, balance: 1000 }), prog("b")], { pins: { a: 20000 } });
  assert.deepEqual(by(reached), { a: 20000, b: 80000 }, "a typed amount counts even for a goal at its target");
  assert.equal(split([g("a")], [prog("a")], { pins: { a: 0 } }).parts[0].amount, 0, "typing 0 is a typed amount");
});

test("a goal with a finish date is sized to make it, and never takes more than what is left", () => {
  const goals = [g("trip", { deadline: "2027-01-31" }), g("b")];
  const p = [prog("trip", { target: 120000, balance: 0 }), prog("b")];
  const r = split(goals, p);   // from 2026-10 to 2027-01 is 3 months: 40000 a month
  assert.deepEqual(by(r), { trip: 40000, b: 60000 });
  const tight = split(goals, p, { total: 25000 });
  assert.deepEqual(by(tight), { trip: 25000, b: 0 });
});

test("the emergency fund takes what is left until its target, then the rest is shared; with no target it takes it all", () => {
  const goals = [g("b"), g("ef", { role: "emergency" })];
  const r = split(goals, [prog("b"), prog("ef", { target: 130000, balance: 100000 })]);
  assert.deepEqual(by(r), { ef: 30000, b: 70000 });
  const open = split(goals, [prog("b"), prog("ef")]);
  assert.deepEqual(by(open), { ef: 100000, b: 0 }, "no target set: it comes first and takes the lot (type a monthly amount to change that)");
  const full = split(goals, [prog("b"), prog("ef", { target: 130000, balance: 130000 })]);
  assert.deepEqual(by(full), { b: 100000 }, "a goal at its target gets nothing");
});

test("the order is typed amounts, then finish dates, then the emergency fund, then the others", () => {
  const goals = [g("a"), g("ef", { role: "emergency" }), g("trip", { deadline: "2026-12-31" }), g("p")];
  const p = [prog("a"), prog("ef", { target: 1000000, balance: 0 }), prog("trip", { target: 100000, balance: 0 }), prog("p")];
  const r = split(goals, p, { total: 200000, pins: { p: 50000 } });   // trip: 100000 over 2 months = 50000
  assert.deepEqual(by(r), { p: 50000, trip: 50000, ef: 100000, a: 0 });
  assert.equal(sum(r), 200000);
});

test("when every goal is full or has nothing left to take, the rest is shown as Savings, not placed yet", () => {
  const r = split([g("a")], [prog("a", { target: 100, balance: 100 })]);
  assert.deepEqual(r.parts.map((x) => [x.name, x.amount]), [[UNPLACED_NAME, 100000]]);
  assert.match(r.parts[0].why, /no open goal/i);
});

test("even a few centavos no goal can take are shown, not dropped", () => {
  const r = split([g("ef", { role: "emergency" })], [prog("ef", { target: 100000, balance: 0 })], { total: 100050 });
  assert.deepEqual(r.parts.map((x) => [x.name, x.amount]), [["EF", 100000], [UNPLACED_NAME, 50]]);
  assert.equal(sum(r), 100050);
});

test("a goal the ledger cannot show is left out", () => {
  const r = split([g("a"), g("ghost")], [prog("a")]);
  assert.deepEqual(by(r), { a: 100000 });
});

test("percentages: whole numbers that add to exactly 100", () => {
  assert.deepEqual(parseShares(["a", "b"], { a: "70", b: "30" }), { ok: true, shares: { a: 7000, b: 3000 } });
  assert.match(parseShares(["a", "b"], { a: "70", b: "20" }).message, /add up to 100.*90/);
  assert.equal(parseShares(["a", "b"], { a: "70", b: "40" }).ok, false);
  assert.equal(parseShares(["a", "b"], { a: "70.5", b: "29.5" }).ok, false);
  assert.equal(parseShares(["a", "b"], { a: "x", b: "100" }).ok, false);
  assert.equal(parseShares(["a"], { a: "100" }).ok, true);
});

test("the goals the percentages are for: no finish date, not the emergency fund, not full", () => {
  const goals = [g("a"), g("b", { deadline: "2027-01-31" }), g("ef", { role: "emergency" }), g("full"), g("ghost")];
  const p = new Map([prog("a"), prog("b"), prog("ef"), prog("full", { target: 10, balance: 10 })]);
  assert.deepEqual(shareableGoals(goals, p).map((x) => x.id), ["a"]);
});

test("Saved counts goals only: the buffer is its own figure and still comes out of the income", () => {
  assert.deepEqual(shares(2500000, 1000000, 500000, 100000), { spending: 400, saved: 200, buffer: 40, unallocated: 900000 });
  assert.equal(shares(2500000, 1000000, 500000).buffer, 0);
});

// ---- through the budget suggestion ----
const TODAY = "2026-10-05", MONTH = "2026-10";
function state() {
  const s = makeState();
  s.accounts = [account({ id: "chk", name: "Test Checking", class: "asset", opening_balance: 100000000 }), account({ id: "p1", name: "Pocket One", class: "asset", opening_balance: 0 }), account({ id: "p2", name: "Pocket Two", class: "asset", opening_balance: 0 })];
  s.categories = [{ id: "rent", name: "Rent", kind: "expense", role: "rent" }, { id: "food", name: "Food", kind: "expense", role: "food" }, { id: UNLOGGED_CATEGORY_ID, name: "Unlogged", kind: "expense" }, { id: "pay", name: "Pay", kind: "income" }];
  s.payslips = []; s.payslipLines = []; s.subscriptions = []; s.rules = [];
  s.goals = [{ id: "ga", name: "Alpha", account_id: "p1", hidden_by_default: true }, { id: "gb", name: "Beta", account_id: "p2", hidden_by_default: true }];
  return s;
}
const sug = (o) => suggestBudgets({ state: state(), today: TODAY, month: MONTH, pin: 10000000, rent: 2000000, ...o });

test("the suggestion shares the savings between the goals, carries their ids, and keeps the buffer apart", () => {
  const r = sug({});
  assert.equal(r.ok, true);
  const goals = r.saved.filter((x) => x.kind === "goal");
  assert.deepEqual(goals.map((x) => x.goal_id).sort(), ["ga", "gb"]);
  assert.equal(goals[0].amount, goals[1].amount, "equal shares by default");
  assert.ok(r.saved.some((x) => x.kind === "buffer" && !x.goal_id));
  assert.deepEqual(savedRows({ plan: null, suggestion: r }).filter((x) => x.kind === "goal").map((x) => x.goal_id).sort(), ["ga", "gb"]);
});

test("a typed monthly amount and the percentages reach the suggestion", () => {
  const base = sug({}), amount = (r, id) => r.saved.find((x) => x.goal_id === id).amount;
  const total = amount(base, "ga") + amount(base, "gb");
  const pinned = sug({ goalPins: { ga: 123400 } });
  assert.equal(amount(pinned, "ga"), 123400, "typed, so it is not rounded");
  assert.ok(pinned.saved.find((x) => x.goal_id === "ga").pinned);
  const weighted = sug({ goalShares: { ga: 8000, gb: 2000 } });
  assert.ok(amount(weighted, "ga") > amount(weighted, "gb") * 3, "80/20 gives about four to one");
  assert.ok(Math.abs(amount(weighted, "ga") + amount(weighted, "gb") - total) <= 10000, "the same total is shared, give or take rounding to the nearest 50");
});

test("the screens read the settings and the rule is the same everywhere", () => {
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8"), sw = readFileSync(new URL("../app/sw.js", import.meta.url), "utf8"), eng = readFileSync(new URL("../src/model/suggest.js", import.meta.url), "utf8");
  assert.match(sw, /savings\.js/);
  assert.match(app, /goalPins: set\.goal_monthly \?\? \{\}, goalShares: set\.goal_shares \?\? \{\}/);
  assert.match(eng, /splitSavings\(\{ goals, progress, month, total: saving, pins: input\.goalPins \?\? \{\}, shares: input\.goalShares \?\? \{\} \}\)/);
  assert.match(app, /savedAll\.filter\(\(r\) => r\.kind !== "buffer"\)/);
});
