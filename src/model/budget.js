// The budget dashboard's numbers (spec 5, 7.1, 2.5). Pure functions over the state.
//   - Only VERIFIED transactions count toward `spent`; drafts show as `pending`.
//   - A category's budget is the rule in effect on the FIRST day of the month, so a
//     rule added mid-month starts next month.
//   - Spending is grouped by reporting category as of `asOf` (the day the report is
//     run), so a merge also regroups earlier history (Option A).
//   - Over-budget is shown plainly as a negative `remaining`; nothing here blocks.
import { ruleInEffect, reportingCategory } from "./rules.js";
import { countsTowardBudget } from "./invariants.js";

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
    if (rule) row(c).budget = rule.amount;
  }

  return [...rows.values()]
    .map((r) => ({ ...r, remaining: r.budget === null ? null : r.budget - r.spent, over: r.budget !== null && r.spent > r.budget }))
    .sort((a, b) => (a.category_id < b.category_id ? -1 : 1));
}
