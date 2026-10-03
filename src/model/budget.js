// The budget dashboard's numbers (spec 5, 7.1, 2.5). Pure functions over the state.
//   - Only VERIFIED transactions count toward `spent`; drafts show as `pending`.
//   - A category's budget is the rule in effect on the FIRST day of the month, so a
//     rule added mid-month starts next month.
//   - Spending is grouped by reporting category as of `asOf` (the day the report is
//     run), so a merge also regroups earlier history (Option A).
//   - Over-budget is shown plainly as a negative `remaining`; nothing here blocks.
import { ruleInEffect, reportingCategory } from "./rules.js";
import { countsTowardBudget } from "./invariants.js";
import { checkRulesSave } from "./index.js";
import { addMonths } from "./reports.js";
import { UNLOGGED_CATEGORY_ID } from "./seed.js";
import { phTimestamp } from "./util.js";

const inMonth = (date, month) => date >= month + "-01" && date <= month + "-31";   // string order is date order

// month: "YYYY-MM". Returns one row per expense category that has a budget or any activity.
export function budgetStatus(state, { rules, categoryMaps = [], month, asOf }) {
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const expense = new Set(state.categories.filter((c) => c.kind === "expense").map((c) => c.id));
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { category_id: id, budget: null, spent: 0, pending: 0 });
    return rows.get(id);
  };

  for (const e of state.entries) {
    if (e.category_id == null || !expense.has(e.category_id)) continue;
    const t = txById.get(e.transaction_id);
    if (!t || !inMonth(t.date, month)) continue;
    const r = row(reportingCategory(categoryMaps, e.category_id, asOf));
    if (countsTowardBudget(t)) r.spent += e.amount; else r.pending += e.amount;
  }

  for (const c of expense) {
    const rule = ruleInEffect(rules, "budget", c, month + "-01");
    if (rule && rule.amount > 0) row(c).budget = rule.amount;   // a budget of 0 is how a budget is removed
  }

  return [...rows.values()]
    .map((r) => ({ ...r, remaining: r.budget === null ? null : r.budget - r.spent, over: r.budget !== null && r.spent > r.budget }))
    .sort((a, b) => (a.category_id < b.category_id ? -1 : 1));
}

// ---------- how much of a budget is used: a green-to-red grade ----------
// Green below 60% used, yellow from 60%, orange from 85%, red only once it is OVER the budget.
// Compared in whole centavos, so exactly 100% is orange, never red. Every grade also has words
// in the screen, so colour is never the only signal.
export const GRADE_AT = { warning: 60, serious: 85 };

export function budgetGrade(spent, budget) {
  if (budget == null || budget <= 0) return null;
  const level = spent > budget ? "critical" : spent * 100 >= budget * GRADE_AT.serious ? "serious" : spent * 100 >= budget * GRADE_AT.warning ? "warning" : "good";
  return { level, percent: Math.max(0, Math.floor((spent * 100) / budget)), over: spent > budget };
}

// How far through the month a date is, as a whole percent: the "where you should be" mark on a meter.
export function monthElapsedPercent(month, today) {
  const now = today.slice(0, 7);
  if (month < now) return 100;
  if (month > now) return 0;
  const [y, m] = month.split("-").map(Number);
  return Math.round((Number(today.slice(8, 10)) * 100) / new Date(Date.UTC(y, m, 0)).getUTCDate());
}

// ---------- setting a budget ----------
// Rules are append-only, so a change is a NEW dated row and history is never edited. A first budget
// starts this month (so it counts straight away); a change to an existing one starts next month.
export function suggestedBudgetStart(rules, categoryId, today) {
  const has = rules.some((r) => r.kind === "budget" && r.subject_id === categoryId);
  return has ? addMonths(today.slice(0, 7), 1) : today.slice(0, 7);
}

// The monthly amount in effect for a category in a month, or null for none.
export function budgetFor(rules, categoryId, month) {
  const r = ruleInEffect(rules, "budget", categoryId, month + "-01");
  return r && r.amount > 0 ? r.amount : null;
}

// input: {id, category_id, amount (centavos, 0 removes the budget), from_month: "YYYY-MM"}
export function planBudgetChange(state, { id, category_id, amount, from_month }, now = new Date()) {
  const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }], state });
  const cat = state.categories.find((c) => c.id === category_id);
  if (!cat || cat.kind !== "expense" || cat.id === UNLOGGED_CATEGORY_ID) return fail("UNKNOWN_CATEGORY", "a budget needs a spending category");
  if (!Number.isSafeInteger(amount) || amount < 0) return fail("BAD_AMOUNT", "a budget is an amount of zero or more");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from_month ?? "")) return fail("BAD_MONTH", "choose the month it starts");
  const rule = { id, kind: "budget", subject_id: category_id, amount, effective_from: from_month + "-01", created_at: phTimestamp(now) };
  const check = checkRulesSave(state.rules, [...state.rules, rule]);
  if (!check.ok) return { ok: false, violations: check.violations, state };
  return { ok: true, violations: [], state: { ...state, rules: [...state.rules, rule] } };
}
