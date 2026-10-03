// Spec 6: goals, the Emergency Fund target, the overtime rule, hidden-by-default goals.
// No peso figures here; targets and shares are inputs.
import { naturalBalance } from "./balances.js";
import { checkTransactionSave } from "./index.js";
import { phTimestamp } from "./util.js";
import { validateShape } from "./schema.js";

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

const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }] });

// A new goal points at an account that already exists (the pocket where the money really sits).
// input: {id, account_id, name, target?, deadline?, hidden_by_default?}. Hidden by default (spec 9).
export function planGoal(state, input) {
  const name = (input.name ?? "").trim();
  const account = state.accounts.find((a) => a.id === input.account_id);
  if (!name) return fail("BAD_NAME", "give the goal a name");
  if (input.target != null && (!Number.isSafeInteger(input.target) || input.target < 0)) return fail("BAD_TARGET", "the target cannot be negative");
  if (!account || account.class !== "asset") return fail("UNKNOWN_ACCOUNT", "a goal needs an account you hold money in");
  if ((state.goals ?? []).some((g) => g.id === input.id)) return fail("DUPLICATE_ID", "that goal already exists");
  if ((state.goals ?? []).some((g) => g.name.toLowerCase() === name.toLowerCase())) return fail("DUPLICATE_NAME", "you already have a goal with that name");
  const goal = { id: input.id, account_id: account.id, name, hidden_by_default: input.hidden_by_default ?? true,
    ...(input.target != null ? { target: input.target } : {}), ...(input.deadline ? { deadline: input.deadline } : {}) };
  const problems = validateShape("Goal", goal);
  if (problems.length) return { ok: false, violations: problems };
  return { ok: true, violations: [], goal, state: { ...state, goals: [...(state.goals ?? []), goal] } };
}

// Move money into a goal's account as a DRAFT transfer, verified later like any other entry.
// input: {transaction_id, date, goal_id, from_account_id, amount}
export function planGoalDeposit(state, input, now = new Date()) {
  const goal = state.goals.find((g) => g.id === input.goal_id);
  if (!goal) return fail("UNKNOWN_GOAL", "no goal " + input.goal_id);
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) return fail("BAD_AMOUNT", "amount must be more than zero");
  if (input.from_account_id === goal.account_id) return fail("SAME_ACCOUNT", "choose a different account to take the money from");
  if (!state.accounts.some((a) => a.id === input.from_account_id)) return fail("UNKNOWN_ACCOUNT", "no account " + input.from_account_id);
  const transaction = { id: input.transaction_id, date: input.date, payee: "To " + goal.name, memo: "", status: "draft", source: "manual", created_at: phTimestamp(now) };
  const entries = [
    { transaction_id: transaction.id, account_id: goal.account_id, amount: input.amount },
    { transaction_id: transaction.id, account_id: input.from_account_id, amount: -input.amount },
  ];
  const result = checkTransactionSave(state, { transaction, entries });
  return { ...result, transaction, entries, state: result.ok ? { ...state, transactions: [...state.transactions, transaction], entries: [...state.entries, ...entries] } : state };
}
