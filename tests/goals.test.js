import { test } from "node:test";
import assert from "node:assert/strict";
import { goalProgress, requiredPerMonth, visibleGoals, emergencyTarget, splitOvertime, planOvertimeTransfer, planGoal, planGoalDeposit, naturalBalance } from "../src/model/index.js";
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
