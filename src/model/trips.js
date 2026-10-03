// Trips (addendum item 8): a trip is a TAG on transactions with an optional budget. Spending tagged with it is
// summed apart from everyday spending (it still counts in the monthly charts like any other spending).
//   - Only VERIFIED transactions count, as everywhere else; drafts are reported as pending.
//   - Only expense categories count: income and transfers are not trip spending.
import { budgetGrade } from "./budget.js";
import { reportingCategory } from "./rules.js";
import { validateShape } from "./schema.js";

const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }] });

// input: {id, name, budget? (centavos)}. Names are unique, ignoring case.
export function planTag(state, input) {
  const name = (input.name ?? "").trim();
  const tags = state.tags ?? [];
  if (!name) return fail("BAD_NAME", "give the trip a name");
  if (tags.some((t) => t.id === input.id)) return fail("DUPLICATE_ID", "that trip already exists");
  if (tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) return fail("DUPLICATE_NAME", "you already have a trip with that name");
  if (input.budget != null && (!Number.isSafeInteger(input.budget) || input.budget < 0)) return fail("BAD_BUDGET", "the budget cannot be negative");
  const tag = { id: input.id, name, ...(input.budget != null ? { budget: input.budget } : {}) };
  const problems = validateShape("Tag", tag);
  if (problems.length) return { ok: false, violations: problems };
  return { ok: true, violations: [], tag, state: { ...state, tags: [...tags, tag] } };
}

// {tag, spent, pending, budget, grade, rows:[{category_id, name, amount}]}, biggest first. grade is null without a budget.
export function tagSummary(state, tagId, { categoryMaps = [], asOf } = {}) {
  const tag = (state.tags ?? []).find((t) => t.id === tagId);
  if (!tag) return null;
  const expense = new Map(state.categories.filter((c) => c.kind === "expense").map((c) => [c.id, c]));
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const totals = new Map();
  let pending = 0;
  for (const e of state.entries) {
    if (e.category_id == null || !expense.has(e.category_id)) continue;
    const t = txById.get(e.transaction_id);
    if (!t || t.tag_id !== tagId) continue;
    if (t.status !== "verified") { pending += e.amount; continue; }
    const id = reportingCategory(categoryMaps, e.category_id, asOf ?? t.date);
    totals.set(id, (totals.get(id) ?? 0) + e.amount);
  }
  const rows = [...totals].filter(([, a]) => a !== 0).map(([category_id, amount]) => ({ category_id, name: expense.get(category_id)?.name ?? category_id, amount }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const spent = rows.reduce((n, r) => n + r.amount, 0);
  const budget = tag.budget ?? null;
  return { tag, spent, pending, budget, grade: budget ? budgetGrade(spent, budget) : null, rows };
}
