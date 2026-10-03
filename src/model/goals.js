// Spec 6: goals, the Emergency Fund target, the overtime rule, hidden-by-default goals.
// No peso figures here; targets and shares are inputs.
import { naturalBalance } from "./balances.js";
import { checkTransactionSave } from "./index.js";
import { phTimestamp } from "./util.js";

// A goal's balance is the balance of the account (pocket) it points at.
export function goalProgress(state, goal) {
  const account = state.accounts.find((a) => a.id === goal.account_id);
  if (!account) return null;
  const balance = naturalBalance(account, state.entries);
  const { target } = goal;
  return {
    goal_id: goal.id, balance, target: target ?? null,
    remaining: target == null ? null : Math.max(0, target - balance),
    percent: target ? Math.min(100, Math.floor((balance * 100) / target)) : null,
    reached: target != null && balance >= target,
    hidden: goal.hidden_by_default,
  };
}

// Goals with a deadline: what must go in each remaining month. Month granularity only.
// Past the deadline everything still missing is due now (monthsLeft 0).
export function requiredPerMonth(progress, deadline, asOf) {
  if (!deadline || progress.remaining == null) return null;
  const [dy, dm] = deadline.split("-").map(Number);
  const [ay, am] = asOf.split("-").map(Number);
  const monthsLeft = Math.max(0, dy * 12 + dm - (ay * 12 + am));
  return { monthsLeft, perMonth: Math.ceil(progress.remaining / Math.max(1, monthsLeft)) };
}

// Spec 9: savings goals are hidden by default, tap to reveal.
export const visibleGoals = (goals, revealed = false) => goals.filter((g) => revealed || !g.hidden_by_default);

// Spec 6.1: Emergency Fund target = months x (sum of the monthly essentials).
export function emergencyTarget(monthlyEssentials, months = 3) {
  return months * monthlyEssentials.reduce((s, a) => s + a, 0);
}

// Spec 4.2: overtime splits between the Emergency Fund and free spending. The Emergency
// part is rounded to the centavo and free spending takes the exact remainder.
export function splitOvertime(amount, { num, den }) {
  const emergency = Math.round((amount * num) / den);
  return { emergency, free: amount - emergency };
}

// The Emergency part as a DRAFT transfer from where the overtime landed (spec 8.1/8.2).
// input: {transaction_id, date, overtime_amount, source_account_id, emergency_account_id, share:{num,den}}
export function planOvertimeTransfer(state, input, now = new Date()) {
  const err = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }], transaction: null, entries: [] });
  if (!Number.isSafeInteger(input.overtime_amount) || input.overtime_amount <= 0) return err("BAD_AMOUNT", "overtime must be positive whole centavos");
  const has = (id) => state.accounts.some((a) => a.id === id);
  if (!has(input.source_account_id) || !has(input.emergency_account_id)) return err("UNKNOWN_ACCOUNT", "source or emergency account not found");

  const { emergency } = splitOvertime(input.overtime_amount, input.share);
  if (emergency === 0) return { ok: true, violations: [], transaction: null, entries: [] };
  const transaction = {
    id: input.transaction_id, date: input.date, payee: "Overtime to Emergency Fund", memo: "",
    status: "draft", source: "template", created_at: phTimestamp(now),
  };
  const entries = [
    { transaction_id: transaction.id, account_id: input.emergency_account_id, amount: emergency },
    { transaction_id: transaction.id, account_id: input.source_account_id, amount: -emergency },
  ];
  return { ...checkTransactionSave(state, { transaction, entries }), transaction, entries };
}
