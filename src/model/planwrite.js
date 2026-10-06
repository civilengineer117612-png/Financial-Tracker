// ONE save for a pay plan AND the budgets it implies, so the two cannot disagree (Budget Stage B).
//   - A plan line of kind "expense" whose name is a spending category's name becomes that category's monthly budget (first + second payday).
//     Plan lines match categories by the plan file's own names, as they always have; a line that matches nothing is named, never guessed.
//   - Goal and buffer lines are not budgets: they stay plan lines (the Saved rows read them there), so they cannot disagree with anything.
//   - Budgets are monthly and plans are dated by the day, so the budgets start on the 1st of the plan's month when the plan starts on a 1st, and on the
//     1st of the NEXT month otherwise. The plan counts from its own date; the screen says when the budgets start.
//   - The plan row is added (never edited) and the budget rules are appended with the existing append-only budget change, all in ONE result: the caller
//     saves state and settings together, or nothing. A refusal anywhere returns the old state and settings untouched.
import { addPlan, planInEffect } from "./plan.js";
import { budgetFor, planBudgetChange } from "./budget.js";
import { addMonths, monthOf } from "./reports.js";
import { UNLOGGED_CATEGORY_ID } from "./seed.js";

const key = (s) => s.trim().toLowerCase();
const fail = (message, state, settings) => ({ ok: false, message, state, settings });
export const budgetMonthFor = (effectiveFrom) => (effectiveFrom.endsWith("-01") ? monthOf(effectiveFrom) : addMonths(monthOf(effectiveFrom), 1));

// What a plan says about budgets: [{category_id, name, amount}] (monthly), and the names of the expense lines that match no category.
export function planBudgetRows(state, plan) {
  const cats = new Map(state.categories.filter((c) => c.kind === "expense" && c.id !== UNLOGGED_CATEGORY_ID).map((c) => [key(c.name), c]));
  const rows = [], unmatched = [];
  for (const l of plan.lines) {
    if (l.kind !== "expense") continue;
    const c = cats.get(key(l.name));
    if (c) rows.push({ category_id: c.id, name: c.name, amount: l.first + l.second }); else unmatched.push(l.name);
  }
  return { rows, unmatched };
}

// Where budgets and a plan disagree for a month: [{category_id, name, planned, budget}]. The plan in force is the one in effect on the 1st of that month
// (a plan that starts on the 15th governs the budgets of the month after), and a budget of none counts as zero.
export function planBudgetMismatches(state, settings, month) {
  const plan = planInEffect(settings.plans ?? [], month + "-01");
  if (!plan) return { plan: null, mismatches: [], unmatched: [] };
  const { rows, unmatched } = planBudgetRows(state, plan);
  const mismatches = rows.map((r) => ({ ...r, planned: r.amount, budget: budgetFor(state.rules, r.category_id, month) })).filter((r) => (r.budget ?? 0) !== r.planned)
    .map(({ category_id, name, planned, budget }) => ({ category_id, name, planned, budget }));
  return { plan, mismatches, unmatched };
}

// input: {plan, newId, now?, start?: "YYYY-MM", addPlanRow?: true}. With addPlanRow false only the budgets are written (to match a plan already saved).
// Returns {ok, state, settings, changes: [{category_id, name, from, to}], unmatched, month} or {ok: false, message, state, settings} with the inputs untouched.
export function planWithBudgets(state, settings, { plan, newId, now = new Date(), start, addPlanRow = true }) {
  const month = start ?? budgetMonthFor(plan.effective_from);
  let plans = settings.plans ?? [];
  if (addPlanRow) {
    const added = addPlan(plans, plan);
    if (!added.ok) return fail(added.error, state, settings);
    plans = added.plans;
  }
  const { rows, unmatched } = planBudgetRows(state, plan);
  let next = state;
  const changes = [];
  for (const r of rows) {
    const from = budgetFor(next.rules, r.category_id, month);
    if ((from ?? 0) === r.amount) continue;
    const x = planBudgetChange(next, { id: newId(), category_id: r.category_id, amount: r.amount, from_month: month }, now);
    if (!x.ok) return fail(x.violations[0].message, state, settings);
    next = x.state;
    changes.push({ category_id: r.category_id, name: r.name, from, to: r.amount });
  }
  return { ok: true, state: next, settings: { ...settings, plans }, changes, unmatched, month };
}
