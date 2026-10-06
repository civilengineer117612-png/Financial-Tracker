// The new Budget screen's numbers (Stage A): the base income, every amount as a share of it, the saved block, and the suggestion.
// Pure functions. Nothing here writes anything: the screen saves through the existing budget change (planBudgetChange), once per category.
// Reused, not copied: payslip nets (income.js), the suggestion engine (suggest.js), budgetFor and planBudgetChange (budget.js).
import { netPerPayday } from "./income.js";
import { median, suggestPlan, NEEDS_ROLES } from "./suggest.js";
import { formatPesos } from "./money.js";
import { budgetFor, planBudgetChange } from "./budget.js";
import { UNLOGGED_CATEGORY_ID } from "./seed.js";
import { bucketMap, resolveTargets, starterFromTargets } from "./buckets.js";
import { guessType } from "./types.js";
import { SUGGEST_DEFAULTS } from "./suggest-settings.js";

// Suggestions are shown rounded to the nearest 50 pesos (5,000 centavos), halves going up: 126 becomes 150, 124 becomes 100, 125 becomes 150.
// Only what is SUGGESTED is rounded; a figure the owner typed is kept exactly as typed.
export const toNearest50 = (centavos) => Math.floor((centavos + 2500) / 5000) * 5000;

// Rounding up must never push the suggestion past the income. After every suggested line is rounded, any excess comes off the LARGEST unpinned "want"
// line in 50-peso steps (then the next largest, and so on); with no want line left it comes off the largest unpinned spending line. Never the rent, never a
// line the owner typed (pinned), never a saved line (goals and the buffer), never a fixed payment. What is still short after that is the owner's own doing.
// rows: [{category_id, name, amount, suggested, pinned, ...}]; others: [{amount}] fixed payments; saved: [{amount}]; roles: Map(category_id -> role).
export function fitToIncome({ rows, others = [], saved = [], income, roles = new Map(), buckets = null }) {
  const out = rows.map((r) => ({ ...r })), trimmed = [];
  const sum = (xs) => xs.reduce((n, x) => n + x.amount, 0), total = () => sum(out) + sum(others) + sum(saved);
  const isNeed = (r) => (buckets ? buckets.get(r.category_id) === "need" : NEEDS_ROLES.includes(roles.get(r.category_id))), isRent = (r) => roles.get(r.category_id) === "rent";
  const cutFrom = (cands) => {
    while (total() > income) {
      const c = cands.filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount || (a.name < b.name ? -1 : 1))[0];
      if (!c) return;
      const take = Math.min(c.amount, Math.ceil((total() - income) / 5000) * 5000);
      c.amount -= take; if (!c.pinned) c.suggested = c.amount;
      const t = trimmed.find((x) => x.category_id === c.category_id);
      if (t) t.by += take; else trimmed.push({ category_id: c.category_id, name: c.name, by: take });
      c.reason = `${c.reason.replace(/ Lowered by .*$/, "")} Lowered by ${formatPesos(trimmed.find((x) => x.category_id === c.category_id).by)} so the total fits your income.`;
    }
  };
  const free = out.filter((r) => !r.pinned && !isRent(r));
  cutFrom(free.filter((r) => !isNeed(r)));   // the largest want first
  cutFrom(free);                             // none left: the largest unpinned spending line
  return { rows: out, trimmed, unallocated: income - total(), short: Math.max(0, total() - income) };
}

// How the "Saved and set aside" suggestion is worked out, in plain words, from the settings actually in use (so the words cannot drift from the rule).
export function savingsExplained(settings) {
  const pct = (bps) => String(bps / 100) + "%", floor = settings.savings_floor ?? 0;
  return [
    settings.buffer_amount != null ? "Overrun buffer: the amount set for it." : `Overrun buffer: ${pct(settings.starter.buffer)} of your pay, for months when a category runs over.`,
    "Savings: if a savings ratchet is set, its amount. Otherwise a cautious start: what is left of your pay after the spending budgets and the buffer, but no more than " +
      `${pct(settings.starter.savings)} of your pay${floor > 0 ? " and never less than your savings floor" : ""}.`,
    "Then shared out: a goal with a finish date gets what it needs each month to make that date, and your emergency fund (or your first goal) takes the rest.",
    "Every suggestion is rounded to the nearest ₱50. A common rule of thumb, not advice: change any figure.",
  ];
}

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

// The summary of the month: Spending and Saved as a share of the income, each PLAINLY rounded to the nearest tenth of a percent (1000 = 100.0%), and
// Unallocated in whole centavos (what is left of the income; negative when the budgets and savings are more than the income). The shares are not forced
// to add up to 100.0%: each is what it is, rounded like every other percent on the screen.
// The overrun buffer is its own figure, never part of Saved (Saved counts Goals only); it still comes out of the income before Unallocated.
export function shares(income, spending, saved, buffer = 0) {
  return { spending: tenths(spending, income), saved: tenths(saved, income), buffer: tenths(buffer, income), unallocated: income - spending - saved - buffer };
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
// rent: the monthly rent the owner typed (centavos, 0 for none), needed only while there is too little history to learn it from: without it the answer is {ok: false, code: "NEEDS_RENT"}.
// pins: {category_id: centavos} the owner typed; they come back as the owner's, and the engine's own figure is kept as the suggestion.
export function suggestBudgets({ state, plan = null, pin = null, today, month, settings, pins = {}, scheduled = [], rent, overrides = {}, targets, goalPins = {}, goalShares = {} }) {
  const income = baseIncome(state, { plan, pin });
  if (!income.amount) return { ok: false, code: "NO_INCOME", message: NO_INCOME_PROMPT };
  const names = new Map(state.categories.filter((c) => c.kind === "expense" && c.id !== UNLOGGED_CATEGORY_ID).map((c) => [c.id, c.name]));
  const pinned = Object.entries(pins).filter(([id, v]) => names.has(id) && whole(v)).map(([category_id, v]) => ({ category_id, name: names.get(category_id), first: v, second: 0 }));
  // The buckets (the owner's answers, else the role defaults) say which categories are needs; the bucket targets give the starter ratios, the buffer coming off the top of savings.
  const buckets = bucketMap(state.categories, overrides), buffer = settings?.starter?.buffer ?? SUGGEST_DEFAULTS.starter.buffer;
  const withTargets = targets === undefined ? settings : { ...(settings ?? {}), starter: { ...(settings?.starter ?? {}), ...starterFromTargets(resolveTargets(targets), buffer) } };
  const r = suggestPlan({ state, paydays: [{ id: "month", label: "Month", day: 1 }], income: [income.amount], today, month, settings: withTargets, scheduled, pinned, rent, buckets, goalPins, goalShares });
  if (!r.ok) return r;
  const lines = r.paydays[0].lines, diff = new Map(r.differences.filter((d) => d.category_id).map((d) => [d.category_id, d]));
  // every spending category gets a row (the engine drops a line that comes to nothing), so a figure can be typed for any of them
  const rows = [...names].map(([category_id, name]) => {
    const l = lines.find((x) => x.category_id === category_id), d = diff.get(category_id), current = budgetFor(state.rules, category_id, month);
    if (!l) return { category_id, name, suggested: 0, pinned: false, amount: 0, reason: "Nothing to suggest: no spending on it in the months I could learn from.", source: r.history.used, current };
    return { category_id, name: l.name, suggested: l.pinned ? (d?.suggested?.first == null ? null : toNearest50(d.suggested.first)) : toNearest50(l.amount), pinned: Boolean(l.pinned), amount: l.pinned ? l.amount : toNearest50(l.amount),
      reason: l.pinned ? "You pinned this figure, so it is not changed." : l.reason, source: l.source, current };
  });
  const others = lines.filter((l) => !l.category_id && l.kind === "expense").map((l) => ({ name: l.name, amount: l.amount, reason: l.reason }));
  const saved = lines.filter((l) => l.kind === "goal" || l.kind === "buffer").map((l) => ({ name: l.name, kind: l.kind, amount: l.pinned ? l.amount : toNearest50(l.amount), reason: l.reason, ...(l.goal_id ? { goal_id: l.goal_id } : {}), ...(l.pinned ? { pinned: true } : {}) }));
  const roles = new Map(state.categories.map((c) => [c.id, c.role ?? guessType(c.name)]).filter(([, r]) => r));
  const fit = fitToIncome({ rows, others, saved, income: income.amount, roles, buckets });
  return { ok: true, income, rows: fit.rows, others, saved, trimmed: fit.trimmed, unallocated: fit.unallocated, short: fit.short, history: r.history };
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
