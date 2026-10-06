import { test } from "node:test";
import assert from "node:assert/strict";
import { goalProgress, requiredPerMonth, visibleGoals, emergencyTarget, splitOvertime, planOvertimeTransfer, planGoal, planGoalDeposit, setGoalTarget, naturalBalance } from "../src/model/index.js";
import { makeState, account, commit } from "./fixtures.js";

function s0() {
  const s = makeState();
  s.accounts.push(account({ id: "goalacct", name: "Test Goal Pocket", class: "asset", opening_balance: 25000 }), account({ id: "ef", name: "Test EF", class: "asset" }));
  return s;
}
const goal = (o) => ({ id: "g", account_id: "goalacct", name: "Test Goal", target: 100000, hidden_by_default: true, ...o });

test("progress: balance, remaining, whole percent, not yet reached", () => {
  const p = goalProgress(s0(), goal());
  assert.deepEqual([p.balance, p.remaining, p.percent, p.reached, p.hidden], [25000, 75000, 25, false, true]);
});
test("percent rounds down and caps at 100; reached at exactly the target", () => {
  const s = s0();
  assert.equal(goalProgress(s, goal({ target: 30000 })).percent, 83);   // 83.33 -> 83
  assert.equal(goalProgress(s, goal({ target: 25000 })).reached, true);
  assert.equal(goalProgress(s, goal({ target: 10000 })).percent, 100);
  assert.equal(goalProgress(s, goal({ target: 10000 })).remaining, 0);
});
test("an open-ended goal has no target, percent or remaining", () => {
  const p = goalProgress(s0(), goal({ target: null }));
  assert.deepEqual([p.target, p.remaining, p.percent, p.reached], [null, null, null, false]);
});
test("a goal pointing at a missing account gives null", () => {
  assert.equal(goalProgress(s0(), goal({ account_id: "nope" })), null);
});
test("required per month rounds UP so the goal is never short", () => {
  const p = goalProgress(s0(), goal());   // 750.00 remaining
  assert.deepEqual(requiredPerMonth(p, "2026-06-30", "2026-03-10"), { monthsLeft: 3, perMonth: 25000 });
  assert.equal(requiredPerMonth(p, "2026-05-31", "2026-03-10").perMonth, 37500);
  assert.deepEqual(requiredPerMonth({ ...p, remaining: 10001 }, "2026-05-31", "2026-03-10"), { monthsLeft: 2, perMonth: 5001 });
});
test("same month or past deadline: everything missing is due now", () => {
  const p = goalProgress(s0(), goal());
  assert.deepEqual(requiredPerMonth(p, "2026-03-31", "2026-03-10"), { monthsLeft: 0, perMonth: 75000 });
  assert.deepEqual(requiredPerMonth(p, "2026-01-31", "2026-03-10"), { monthsLeft: 0, perMonth: 75000 });
});
test("no deadline or no target: nothing to compute", () => {
  const p = goalProgress(s0(), goal());
  assert.equal(requiredPerMonth(p, undefined, "2026-03-10"), null);
  assert.equal(requiredPerMonth(goalProgress(s0(), goal({ target: null })), "2026-06-30", "2026-03-10"), null);
});
test("goals are hidden until revealed", () => {
  const gs = [goal({ id: "a" }), goal({ id: "b", hidden_by_default: false })];
  assert.deepEqual(visibleGoals(gs).map((g) => g.id), ["b"]);
  assert.deepEqual(visibleGoals(gs, true).map((g) => g.id), ["a", "b"]);
});

test("emergency target = months x the sum of monthly essentials", () => {
  assert.equal(emergencyTarget([40000, 40000, 14000]), 282000);
  assert.equal(emergencyTarget([40000, 40000, 14000], 6), 564000);
  assert.equal(emergencyTarget([]), 0);
});

test("overtime splits 60/40 with the remainder going to free spending", () => {
  assert.deepEqual(splitOvertime(100000, { num: 3, den: 5 }), { emergency: 60000, free: 40000 });
  const odd = splitOvertime(99999, { num: 3, den: 5 });   // 59999.4 -> 59999
  assert.deepEqual(odd, { emergency: 59999, free: 40000 });
  for (const a of [1, 3, 7, 12345]) { const r = splitOvertime(a, { num: 3, den: 5 }); assert.equal(r.emergency + r.free, a); }
});
test("overtime transfer is a balanced draft for the Emergency part only", () => {
  const s = s0();
  const p = planOvertimeTransfer(s, { transaction_id: "ot", date: "2026-03-15", overtime_amount: 100000, source_account_id: "chk", emergency_account_id: "ef", share: { num: 3, den: 5 } });
  assert.equal(p.ok, true);
  assert.equal(p.transaction.status, "draft");
  commit(s, p);
  assert.equal(naturalBalance(s.accounts.find((a) => a.id === "ef"), s.entries), 60000);
});
test("overtime transfer reports bad input instead of throwing", () => {
  const s = s0();
  const base = { transaction_id: "ot", date: "2026-03-15", overtime_amount: 100000, source_account_id: "chk", emergency_account_id: "ef", share: { num: 3, den: 5 } };
  assert.equal(planOvertimeTransfer(s, { ...base, overtime_amount: 0 }).violations[0].code, "BAD_AMOUNT");
  assert.equal(planOvertimeTransfer(s, { ...base, overtime_amount: 10.5 }).violations[0].code, "BAD_AMOUNT");
  assert.equal(planOvertimeTransfer(s, { ...base, emergency_account_id: "nope" }).violations[0].code, "UNKNOWN_ACCOUNT");
  assert.equal(planOvertimeTransfer(s, { ...base, overtime_amount: 1, share: { num: 1, den: 5 } }).transaction, null);   // 0 rounds away: nothing to move
});

// ---------- creating a goal and putting money in ----------
test("a goal points at an account you hold, is hidden by default, and bad ones are refused", () => {
  const s = s0();
  const ok = planGoal(s, { id: "g1", account_id: "goalacct", name: " Apartment ", target: 2000000 });
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.goal.name, ok.goal.hidden_by_default, ok.state.goals.length], ["Apartment", true, 1]);
  for (const [o, code] of [[{ name: "  " }, "BAD_NAME"], [{ account_id: "nope" }, "UNKNOWN_ACCOUNT"], [{ id: "g1" }, "DUPLICATE_ID"], [{ id: "g2", name: "apartment" }, "DUPLICATE_NAME"]]) {
    const r = planGoal(ok.state, { id: "g2", account_id: "goalacct", name: "Other", ...o });
    assert.equal(r.violations[0].code, code);
  }
  assert.equal(planGoal(s, { id: "g3", account_id: "goalacct", name: "Neg", target: -5 }).violations[0].code, "BAD_TARGET");
});
test("putting money in makes a draft transfer that moves the pocket balance only once verified-counted", () => {
  const s = planGoal(s0(), { id: "g1", account_id: "goalacct", name: "Apartment", target: 100000 }).state;
  const r = planGoalDeposit(s, { transaction_id: "t9", date: "2026-03-01", goal_id: "g1", from_account_id: "ef", amount: 5000 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.transaction.status, r.entries.map((e) => e.amount).sort((a, b) => a - b)], ["draft", [-5000, 5000]]);
  assert.equal(naturalBalance(r.state.accounts.find((a) => a.id === "goalacct"), r.state.entries), 30000);
  for (const [o, code] of [[{ amount: 0 }, "BAD_AMOUNT"], [{ amount: 1.5 }, "BAD_AMOUNT"], [{ from_account_id: "goalacct" }, "SAME_ACCOUNT"], [{ from_account_id: "x" }, "UNKNOWN_ACCOUNT"], [{ goal_id: "zz" }, "UNKNOWN_GOAL"]]) {
    assert.equal(planGoalDeposit(s, { transaction_id: "t9", date: "2026-03-01", goal_id: "g1", from_account_id: "ef", amount: 5000, ...o }).violations[0].code, code);
  }
});

test("a goal's target can be set, changed or removed; bad ones are refused", () => {
  const s = planGoal(s0(), { id: "g1", account_id: "goalacct", name: "Emergency", target: 100 }).state;
  assert.equal(setGoalTarget(s, "g1", 250000).state.goals[0].target, 250000);
  assert.equal("target" in setGoalTarget(s, "g1", null).state.goals[0], false);
  assert.equal(setGoalTarget(s, "g1", -1).violations[0].code, "BAD_TARGET");
  assert.equal(setGoalTarget(s, "zz", 5).violations[0].code, "UNKNOWN_GOAL");
});

// ----- a goal may have no account yet (data version 6) -----
import { setGoalAccount, goalProgress as gp, planGoalDeposit as pgd, sweepOrderAccounts as soa, validateShape as vs, homeSummary } from "../src/model/index.js";
import { makeState as ms, account as acc } from "./fixtures.js";
const base6 = () => { const s = ms(); s.accounts.push(acc({ id: "pocket", name: "Test Pocket", class: "asset", opening_balance: 50000 })); s.goals = []; return s; };

test("a goal can be made with no account, holds nothing, and cannot take a deposit until it has one", () => {
  const s = base6();
  const made = planGoal(s, { id: "g1", name: "Savings", hidden_by_default: false });
  assert.equal(made.ok, true); assert.equal("account_id" in made.goal, false); assert.deepEqual(vs("Goal", made.goal), []);
  const p = gp(made.state, made.goal);
  assert.equal(p.balance, 0); assert.equal(p.target, null); assert.equal(p.remaining, null);
  const dep = pgd(made.state, { transaction_id: "d", date: "2026-10-08", goal_id: "g1", from_account_id: "pocket", amount: 1000 });
  assert.equal(dep.ok, false); assert.equal(dep.violations[0].code, "NO_ACCOUNT"); assert.match(dep.violations[0].message, /choose where this goal's money sits first/);
  assert.equal(soa(made.state, [{ goal_id: "g1" }, ]).length, 0, "the sweep skips a goal with no account");
  const withTarget = planGoal(s, { id: "g2", name: "Trip", target: 100000, deadline: "2027-01-31" });
  assert.equal(gp(withTarget.state, withTarget.goal).remaining, 100000, "a target still counts from zero");
});
test("choosing an account later gives the goal that account's balance; a bad account is refused; a named account must exist", () => {
  const s = planGoal(base6(), { id: "g1", name: "Savings", target: 100000 }).state;
  const r = setGoalAccount(s, "g1", "pocket");
  assert.equal(r.ok, true); assert.equal(gp(r.state, r.state.goals[0]).balance, 50000);
  assert.equal(pgd(r.state, { transaction_id: "d", date: "2026-10-08", goal_id: "g1", from_account_id: "pocket", amount: 1 }).violations[0].code, "SAME_ACCOUNT", "now the deposit rules apply as before");
  assert.equal(setGoalAccount(s, "g1", "nope").ok, false); assert.equal(setGoalAccount(s, "zzz", "pocket").ok, false);
  const card = base6(); card.accounts.push(acc({ id: "cc", name: "Test Card", class: "liability" }));
  assert.equal(setGoalAccount(planGoal(card, { id: "g1", name: "S" }).state, "g1", "cc").ok, false, "a card is not somewhere money sits");
  assert.equal(planGoal(base6(), { id: "g3", name: "X", account_id: "nope" }).ok, false, "naming an account that does not exist is still refused");
  assert.equal(planGoal(base6(), { id: "g3", name: "X", account_id: "pocket" }).goal.account_id, "pocket", "and naming one works as before");
  assert.equal(gp(base6(), { id: "g9", account_id: "gone", name: "Lost", hidden_by_default: false }), null, "a goal whose account has vanished is still not shown");
});
test("a goal with no account does not change the home summary or the sweep order of the others", () => {
  const s = planGoal(planGoal(base6(), { id: "g1", name: "A" }).state, { id: "g2", name: "B", account_id: "pocket" }).state;
  assert.deepEqual(soa(s, [{ goal_id: "g1" }, { goal_id: "g2", target: 70000 }]), [{ account_id: "pocket", target: 70000 }]);
  assert.doesNotThrow(() => homeSummary(s, { from: "2026-10-01", to: "2026-10-31" }));
});
