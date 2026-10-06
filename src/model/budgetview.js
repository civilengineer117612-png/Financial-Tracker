// The new Budget screen's numbers (Stage A): the base income, every amount as a share of it, the saved block, and the suggestion.
// Pure functions. Nothing here writes anything: the screen saves through the existing budget change (planBudgetChange), once per category.
// Reused, not copied: payslip nets (income.js), the suggestion engine (suggest.js), budgetFor and planBudgetChange (budget.js).
import { netPerPayday } from "./income.js";
import { median, suggestPlan } from "./suggest.js";
import { budgetFor, planBudgetChange } from "./budget.js";
import { UNLOGGED_CATEGORY_ID } from "./seed.js";

export const NO_INCOME_PROMPT = "Add a payslip or your pay to get a suggested budget.";
const whole = (n) => Number.isSafeInteger(n) && n >= 0;

// How many kinds of payday the payslips show when no plan says so: pay dates that all fall within 10 days of the month are ONE kind (monthly pay);
// otherwise two, split at the biggest gap between the days of the month. Returns the base nets of each kind, oldest first.
export function netsByKind(slips) {
  if (!slips.length) return [];
  const day = (r) => Number(r.date.slice(8)), days = [...new Set(slips.map(day))].sort((a, b) => a - b);
  if (days[days.length - 1] - days[0] <= 10) return [slips.map((r) => r.base)];
  let cut = 0, gap = -1;
  for (let i = 1; i < days.length; i++) if (days[i] - days[i - 1] > gap) { gap = days[i] - days[i - 1]; cut = days[i]; }
  return [slips.filter((r) => day(r) < cut).map((r) => r.base), slips.filter((r) => day(r) >= cut).map((r) => r.base)];
}

// The income every share is measured against. The owner's own figure wins, then a loaded plan's expected income, then the payslips: the median of
// the last 3 nets of each kind of payday, overtime left out, added up for the month. {amount, source, text}; amount is null with no income at all.
export function baseIncome(state, { plan = null, pin = null } = {}) {
  if (whole(pin) && pin > 0) return { amount: pin, source: "pinned", text: "Your own figure" };
  if (plan?.paydays?.length) return { amount: plan.paydays.reduce((n, p) => n + p.income, 0), source: "plan", text: "From your pay plan (its expected income)" };
  const kinds = netsByKind(netPerPayday(state));
  if (!kinds.length) return { amount: null, source: "none", text: NO_INCOME_PROMPT };
  return { amount: kinds.reduce((n, list) => n + median(list.slice(-3), "low"), 0), source: "payslips", text: "From your last 3 payslips" };
}

// Tenths of a percent (1000 = 100.0%). The three shares add up to exactly 1000, with Unallocated the remainder (negative when the plan is over the income).
export function shares(income, spending, saved) {
  const s = Math.floor((spending * 1000) / income), v = Math.floor((saved * 1000) / income);
  return { spending: s, saved: v, unallocated: 1000 - s - v };
}
// One amount as tenths of a percent of the income, rounded to the nearest tenth (rows are shown on their own; only the three shares above must add up).
export const tenths = (amount, income) => Math.floor((amount * 2000 + income) / (2 * income));
export const showTenths = (t) => (t / 10).toFixed(1) + "%";

// "Income changed: review": the income when the budgets were last confirmed is not the income now. Only ever a note.
export const incomeChanged = (seen, now) => whole(seen) && whole(now) && seen !== now;

// The rows of the "Saved and set aside" block: the loaded plan's goal and buffer lines (monthly), or, with no plan, the engine's suggested amounts.
export function savedRows({ plan, suggestion }) {
  if (plan) return plan.lines.filter((l) => l.kind === "goal" || l.kind === "buffer").map((l) => ({ name: l.name, kind: l.kind, amount: l.first + l.second, label: "From your plan" }));
  return (suggestion?.saved ?? []).map((l) => ({ ...l, label: "Suggested, not saved" }));
}

// A suggested budget for one month, built by the engine for ONE monthly payday on the base income. Lines are mapped by category id, never by name.
// pins: {category_id: centavos} the owner typed; they come back as the owner's, and the engine's own figure is kept as the suggestion.
export function suggestBudgets({ state, plan = null, pin = null, today, month, settings, pins = {}, scheduled = [] }) {
  const income = baseIncome(state, { plan, pin });
  if (!income.amount) return { ok: false, code: "NO_INCOME", message: NO_INCOME_PROMPT };
  const names = new Map(state.categories.filter((c) => c.kind === "expense" && c.id !== UNLOGGED_CATEGORY_ID).map((c) => [c.id, c.name]));
  const pinned = Object.entries(pins).filter(([id, v]) => names.has(id) && whole(v)).map(([category_id, v]) => ({ category_id, name: names.get(category_id), first: v, second: 0 }));
  const r = suggestPlan({ state, paydays: [{ id: "month", label: "Month", day: 1 }], income: [income.amount], today, month, settings, scheduled, pinned });
  if (!r.ok) return r;
  const lines = r.paydays[0].lines, diff = new Map(r.differences.filter((d) => d.category_id).map((d) => [d.category_id, d]));
  // every spending category gets a row (the engine drops a line that comes to nothing), so a figure can be typed for any of them
  const rows = [...names].map(([category_id, name]) => {
    const l = lines.find((x) => x.category_id === category_id), d = diff.get(category_id), current = budgetFor(state.rules, category_id, month);
    if (!l) return { category_id, name, suggested: 0, pinned: false, amount: 0, reason: "Nothing to suggest: no spending on it in the months I could learn from.", source: r.history.used, current };
    return { category_id, name: l.name, suggested: l.pinned ? (d?.suggested?.first ?? null) : l.amount, pinned: Boolean(l.pinned), amount: l.amount,
      reason: l.pinned ? "You pinned this figure, so it is not changed." : l.reason, source: l.source, current };
  });
  const others = lines.filter((l) => !l.category_id && l.kind === "expense").map((l) => ({ name: l.name, amount: l.amount, reason: l.reason }));
  const saved = lines.filter((l) => l.kind === "goal" || l.kind === "buffer").map((l) => ({ name: l.name, kind: l.kind, amount: l.amount, reason: l.reason }));
  return { ok: true, income, rows, others, saved, unallocated: r.paydays[0].unallocated, short: r.paydays[0].short, history: r.history };
}

// What confirming would save: draft {category_id: centavos} against the budget now in effect. Each change goes through the existing append-only
// budget change, so history is never edited. Nothing is saved when any one is refused. start: "YYYY-MM". newId() gives each rule its id.
export function budgetChangesFromDraft(state, draft, { start, newId, now = new Date() }) {
  const changes = [];
  let next = state;
  for (const [category_id, to] of Object.entries(draft)) {
    if (!whole(to)) return { ok: false, message: "Amounts must be whole centavos." };
    const from = budgetFor(state.rules, category_id, start);
    if ((from ?? 0) === to) continue;
    const r = planBudgetChange(next, { id: newId(), category_id, amount: to, from_month: start }, now);
    if (!r.ok) return { ok: false, message: r.violations[0].message };
    next = r.state;
    changes.push({ category_id, name: state.categories.find((c) => c.id === category_id)?.name ?? category_id, from, to });
  }
  return { ok: true, state: next, changes };
}
