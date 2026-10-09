import { oldEmergencyFundStatus } from "./old-ef.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEDGER_VERSION, upgradeLedger, selfCheck, fingerprint, parseLedger, planMonthEndSweep, planSweep, sweepOrderAccounts, goalByRole, setGoalRole, planGoal,
  emergencyFundStatus, parsePlan, readScan, categoryByRole, addCategory, renameCategory, defaultCategories, validateState, overtimeDraft, planPayslip, ensureIncomeCategories,
} from "../src/model/index.js";

// A ledger as DATA VERSION 2 wrote it (by hand, so it does not move when the code does): goals found by NAME, categories found by NAME.
// Invented names and numbers.
const TS = "2026-09-04T09:00:00.000+08:00";
const acct = (o) => ({ role: "", hidden_by_default: false, archived: false, opening_balance: 0, opening_date: "2026-01-01", ...o });
function v2() {
  const tx = (id, date) => ({ id, date, payee: "x", memo: "", status: "verified", source: "manual", created_at: TS, verified_at: TS });
  return {
    v: 2, rev: 11, saved_at: "2026-09-05T08:00:00.000+08:00",
    settings: { gcash: { account_id: "wal", allowance_id: "env-a", buffer_id: "env-b" }, last_backup_at: "2026-09-01T09:00:00.000+08:00" },
    state: {
      accounts: [acct({ id: "chk", name: "Test Checking", class: "asset", opening_balance: 500000 }), acct({ id: "wal", name: "Test Wallet", class: "asset", opening_balance: 0 }),
        acct({ id: "efa", name: "Test Pocket One", class: "asset", opening_balance: 40000 }), acct({ id: "mra", name: "Test Pocket Two", class: "asset", opening_balance: 20000 }),
        acct({ id: "tra", name: "Test Pocket Three", class: "asset", opening_balance: 0 })],
      goals: [
        { id: "g-trip", account_id: "tra", name: "Trip fund", hidden_by_default: true },
        { id: "g-ef", account_id: "efa", name: "Emergency Fund", target: 300000, hidden_by_default: true },
        { id: "g-mr", account_id: "mra", name: "Mole Removal", target: 50000, hidden_by_default: true },
        { id: "g-ef2", account_id: "tra", name: "Second emergency idea", hidden_by_default: true },
      ],
      envelopes: [{ id: "env-a", account_id: "wal", name: "Allowance", purpose: "everyday" }, { id: "env-b", account_id: "wal", name: "Buffer", purpose: "overruns" }],
      categories: [{ id: "c1", name: "food", kind: "expense" }, { id: "c2", name: "ESSENTIALS", kind: "expense" }, { id: "c3", name: "Subscription", kind: "expense" },
        { id: "c4", name: "Rent", kind: "expense" }, { id: "c5", name: "Lakat/Date", kind: "expense" }, { id: "c6", name: "Upskill", kind: "expense" },
        { id: "cat-unlogged", name: "Unlogged", kind: "expense" }, { id: "cat-salary", name: "Salary", kind: "income" }],
      categoryMaps: [], rules: [], templates: [], presets: [], payeeRules: [], subscriptions: [], checkIns: [], attachments: [], tags: [], foreignAmounts: [], surveyResponses: [],
      payslips: [], payslipLines: [], payslipRevisions: [],
      transactions: [tx("t1", "2026-09-04"), tx("t2", "2026-09-06")],
      entries: [
        { transaction_id: "t1", account_id: "wal", amount: 30000, envelope_id: "env-b" }, { transaction_id: "t1", account_id: "chk", amount: -30000 },
        { transaction_id: "t2", category_id: "c1", amount: 9500 }, { transaction_id: "t2", account_id: "chk", amount: -9500 },
      ],
    },
  };
}
// The OLD code, written out as it was (it found things by name), for the before/after comparisons below.
const oldGoal = (goals, re) => goals.find((g) => re.test(g.name));
const up = () => { const r = upgradeLedger(v2(), { now: new Date("2026-10-07T00:00:00Z") }); assert.equal(r.ok, true, r.error); return r.ledger; };

test("data version 2 upgrades to the current version: nothing but roles and the sweep order are added; totals and the self-check are the same", () => {
  const before = v2(), after = up();
  assert.equal(after.v, LEDGER_VERSION); assert.equal(after.rev, 12);
  assert.equal(fingerprint(after), fingerprint(before)); assert.deepEqual(selfCheck(after), []);
  assert.equal(parseLedger(JSON.stringify(after)).ok, true); assert.deepEqual(validateState(after.state), []);
  const strip = (l) => JSON.parse(JSON.stringify(l, (k, v) => (k === "role" || k === "last4" ? undefined : v)));
  assert.deepEqual({ ...strip(after).state }, strip(before).state, "every record is the same apart from the new role field");
  assert.deepEqual(Object.keys(after.settings).sort(), [...Object.keys(before.settings), "sweep_order"].sort());
  for (const k of Object.keys(before.settings)) assert.deepEqual(after.settings[k], before.settings[k], "setting " + k + " kept");
});

test("migration gives each role once, from what the old code looked for by name", () => {
  const after = up();
  assert.deepEqual(after.state.categories.filter((c) => c.role).map((c) => [c.id, c.role]), [["c1", "food"], ["c2", "essentials"], ["c3", "subscription"], ["c4", "rent"]]);
  assert.equal(after.state.categories.find((c) => c.id === "c5").role, undefined, "Lakat/Date has no role");
  assert.deepEqual(after.state.goals.filter((g) => g.role).map((g) => [g.id, g.role]), [["g-ef", "emergency"]], "only the FIRST goal with emergency in its name, as the old code took");
  assert.equal(after.state.goals.find((g) => g.id === "g-ef2").role, undefined);
  assert.deepEqual(after.settings.sweep_order, [{ goal_id: "g-mr" }, { goal_id: "g-ef" }], "the owner's old order: the Mole goal, then the Emergency goal");
});

test("migration leaves a sweep order alone, and sets none when the old sweep could not have run", () => {
  const own = v2(); own.settings.sweep_order = [{ goal_id: "g-trip", target: 100 }];
  assert.deepEqual(upgradeLedger(own).ledger.settings.sweep_order, [{ goal_id: "g-trip", target: 100 }]);
  const noMole = v2(); noMole.state.goals = noMole.state.goals.filter((g) => g.id !== "g-mr");
  assert.equal(upgradeLedger(noMole).ledger.settings.sweep_order, undefined);
  const noEf = v2(); noEf.state.goals = noEf.state.goals.filter((g) => !/emergency/i.test(g.name));
  const r = upgradeLedger(noEf).ledger; assert.equal(r.settings.sweep_order, undefined); assert.equal(r.state.goals.some((g) => g.role), false);
});

test("BEFORE/AFTER: the emergency goal, the sweep and the Emergency Fund status come out exactly as they did when found by name", () => {
  const before = v2(), after = up();
  // the goal the overtime draft and the status use
  assert.equal(goalByRole(after.state, "emergency").id, oldGoal(before.state.goals, /emergency/i).id);
  assert.equal(goalByRole(after.state, "emergency").account_id, oldGoal(before.state.goals, /emergency/i).account_id, "the overtime draft goes to the same account");
  // the sweep (buffer 300.00 sits in the wallet's buffer envelope)
  const mole = oldGoal(before.state.goals, /mole/i), emerg = oldGoal(before.state.goals, /emergency/i);
  const oldSweep = planMonthEndSweep(before.state, { transaction_id: "sw", date: "2026-09-30", gcash_account_id: "wal", buffer_envelope_id: "env-b", mole_account_id: mole.account_id, emergency_account_id: emerg.account_id, mole_target: mole.target ?? 0 }, new Date("2026-09-30T00:00:00Z"));
  const order = sweepOrderAccounts(after.state, after.settings.sweep_order);
  const newSweep = planSweep(after.state, { transaction_id: "sw", date: "2026-09-30", gcash_account_id: "wal", buffer_envelope_id: "env-b", order }, new Date("2026-09-30T00:00:00Z"));
  assert.equal(oldSweep.ok, true); assert.deepEqual(newSweep.transaction, oldSweep.transaction); assert.deepEqual(newSweep.entries, oldSweep.entries);
  assert.deepEqual(oldSweep.entries.map((e) => [e.account_id, e.amount]), [["mra", 30000], ["wal", -30000]], "the example is a real sweep: the pocket had 20,000 of 50,000 and takes all 30,000");
  // the Emergency Fund status against a plan
  const plan = parsePlan(JSON.stringify({ schema_version: 1, unit: "PHP_whole_pesos", effective_from: "2026-09-01",
    paydays: [{ id: "first", day: 15, label: "1st payday", expected_income: 1000 }, { id: "second", day: "last", label: "2nd payday", expected_income: 1000 }],
    lines: [{ name: "Rent", kind: "expense", first: 300, second: 300 }, { name: "Food", kind: "expense", first: 200, second: 200 }, { name: "Essentials", kind: "expense", first: 100, second: 100 },
      { name: "Emergency Fund", kind: "goal", first: 400, second: 400 }] })).plan;
  assert.ok(plan, "the invented plan loads");
  assert.deepEqual(emergencyFundStatus(after.state, plan, goalByRole(after.state, "emergency")), oldEmergencyFundStatus(before.state, plan, oldGoal(before.state.goals, /emergency/i)));
  // the scanner's category guess
  const guess = readScan("JOLLIBEE\nOfficial Receipt\nTOTAL 150.00", "2026-09-06").categoryGuess;
  const oldPick = before.state.categories.find((c) => c.kind === "expense" && c.name.toLowerCase() === "food");
  assert.equal(guess, "food"); assert.equal(categoryByRole(after.state.categories, guess).id, oldPick.id);
});

test("renaming a category or a goal no longer breaks anything", () => {
  const after = up(), cats = after.state.categories.map((c) => (c.id === "c1" ? { ...c, name: "Meals out" } : c));
  assert.equal(categoryByRole(cats, "food").name, "Meals out", "the scanner still finds the food category");
  const goals = after.state.goals.map((g) => (g.id === "g-ef" ? { ...g, name: "Rainy day" } : g));
  assert.equal(goalByRole({ goals }, "emergency").name, "Rainy day");
  assert.equal(categoryByRole(cats.map((c) => (c.id === "c1" ? { ...c, role: undefined } : c)), "food"), null, "with no role there is no guess (the app then asks)");
  assert.equal(goalByRole({ goals: goals.map(({ role, ...g }) => g) }, "emergency"), null);
});

test("a goal's role moves: one goal at most holds it, and it can be taken away", () => {
  const s = up().state;
  const moved = setGoalRole(s, "g-trip", "emergency");
  assert.equal(moved.ok, true); assert.deepEqual(moved.state.goals.filter((g) => g.role).map((g) => g.id), ["g-trip"]);
  assert.deepEqual(setGoalRole(moved.state, "g-trip", null).state.goals.filter((g) => g.role), []);
  assert.equal(setGoalRole(s, "nope", "emergency").ok, false);
  const created = planGoal(s, { id: "g-new", account_id: "tra", name: "Fresh", role: "emergency" });
  assert.equal(created.ok, true); assert.deepEqual(created.state.goals.filter((g) => g.role).map((g) => g.id), ["g-new"], "a new emergency goal takes the role");
  assert.equal(validateState(created.state).length, 0);
});

test("the sweep goes down any ordered list: caps first, the last takes the rest; unknown goals and an empty buffer are handled", () => {
  const s = up().state, input = (order) => ({ transaction_id: "sw", date: "2026-09-30", gcash_account_id: "wal", buffer_envelope_id: "env-b", order });
  const three = planSweep(s, input([{ account_id: "mra", target: 30000 }, { account_id: "tra", target: 5000 }, { account_id: "efa" }]));
  assert.deepEqual(three.entries.map((e) => [e.account_id, e.amount]), [["mra", 10000], ["tra", 5000], ["efa", 15000], ["wal", -30000]], "10,000 fills the first, 5,000 fills the second, the last takes 15,000");
  assert.equal(planSweep(s, input([{ account_id: "efa" }])).entries[0].amount, 30000, "one goal takes everything");
  assert.equal(planSweep(s, input([{ account_id: "nope" }, { account_id: "efa" }])).ok, false);
  assert.equal(planSweep(s, input([])).ok, false);
  const empty = { ...s, entries: s.entries.filter((e) => e.transaction_id !== "t1") };
  assert.equal(planSweep(empty, input([{ account_id: "efa" }])).transaction, null, "nothing in the buffer: nothing to sweep");
  assert.equal(sweepOrderAccounts(s, [{ goal_id: "gone" }]), null); assert.equal(sweepOrderAccounts(s, []), null);
  assert.deepEqual(sweepOrderAccounts(s, [{ goal_id: "g-mr" }, { goal_id: "g-ef", target: 7 }]), [{ account_id: "mra", target: 50000 }, { account_id: "efa", target: 7 }], "a goal's own target is used unless the entry sets one");
});

test("a new install starts neutral: plain categories, four roles, no tiles, and the scanner finds a rent or food category by role", () => {
  const cats = defaultCategories();
  assert.deepEqual(cats.filter((c) => c.kind === "expense").map((c) => c.name), ["Food", "Essentials", "Transport", "Rent", "Subscription", "Shopping", "Health", "Fun", "Other", "Unlogged"]);
  assert.equal(categoryByRole(cats, "rent").name, "Rent"); assert.equal(categoryByRole(cats, "subscription").id, "cat-subscription");
  assert.equal(readScan("Rent for the month of October\nTotal 5,000.00", "2026-10-05").categoryGuess, "rent");
});

test("categories can be added and renamed: the id, role and every entry stay; unlogged, income and duplicate names are refused", () => {
  const s = up().state;
  const renamed = renameCategory(s, "c1", "Meals out");
  assert.equal(renamed.ok, true);
  const c = renamed.state.categories.find((x) => x.id === "c1");
  assert.deepEqual([c.id, c.name, c.role, c.kind], ["c1", "Meals out", "food", "expense"], "same id, same role");
  assert.deepEqual(renamed.state.entries, s.entries, "no entry changed");
  assert.deepEqual(renamed.state.categories.filter((x) => x.id !== "c1"), s.categories.filter((x) => x.id !== "c1"), "no other category changed");
  assert.equal(categoryByRole(renamed.state.categories, "food").name, "Meals out");
  assert.equal(renameCategory(s, "c1", "  ESSENTIALS ").violations[0].code, "DUPLICATE_NAME", "ignoring capitals and spaces");
  assert.equal(renameCategory(s, "c1", "Food").ok, true, "its own name again is fine");
  assert.equal(renameCategory(s, "c1", "   ").violations[0].code, "BAD_NAME");
  assert.equal(renameCategory(s, "c1", "x".repeat(41)).violations[0].code, "BAD_NAME");
  assert.equal(renameCategory(s, "cat-unlogged", "Gone").violations[0].code, "FIXED_CATEGORY");
  assert.equal(renameCategory(s, "cat-salary", "Pay").violations[0].code, "FIXED_CATEGORY");
  assert.equal(renameCategory(s, "nope", "X").violations[0].code, "UNKNOWN_CATEGORY");
  const added = addCategory(s, { id: "c-new", name: "  Pets " });
  assert.equal(added.ok, true); assert.deepEqual(added.category, { id: "c-new", name: "Pets", kind: "expense" });
  assert.equal(addCategory(added.state, { id: "c-new2", name: "pets" }).violations[0].code, "DUPLICATE_NAME");
  assert.equal(addCategory(s, { id: "c1", name: "Fresh" }).violations[0].code, "DUPLICATE_ID");
  assert.deepEqual(validateState(added.state), []);
});

test("a category can hold any of the twelve roles, and an unknown role is refused", async () => {
  const { validateShape: vs } = await import("../src/model/index.js");
  for (const role of ["food", "essentials", "subscription", "rent", "transport", "health", "utilities", "debt", "shopping", "fun", "dining", "invest"]) assert.deepEqual(vs("Category", { id: "c", name: "X", kind: "expense", role }), [], role);
  assert.equal(vs("Category", { id: "c", name: "X", kind: "expense", role: "gambling" }).length, 1);
});
