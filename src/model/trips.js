// Trips (addendum item 8): a trip is a TAG with an optional budget and, since data version 4, optional first and last days (inclusive).
// Spending on a trip is summed apart from everyday spending (it still counts in the monthly charts like any other spending).
//   - MEMBERSHIP IS WORKED OUT when shown (tripMembership), never written into the entries. What is stored is only a hand override on the
//     transaction: trip_add (put on this trip by hand, or by a manual trip start) and trip_out (taken off the trip the dates would give it).
//   - By dates: a spending entry dated inside a trip's days belongs to it. Moves between own accounts, card bill payments (no spending
//     category) and entries made from templates or scheduled payments are never tagged by dates; they can still be added by hand.
//   - Trips may not overlap, so a date belongs to at most one trip.
//   - Only VERIFIED transactions count, as everywhere else; drafts are reported as pending.
//   - Only expense categories count: income and transfers are not trip spending.
import { budgetGrade } from "./budget.js";
import { reportingCategory } from "./rules.js";
import { validateShape } from "./schema.js";
import { isPhDate } from "./util.js";

// Sources that dates never tag. Scheduled payments (a coming feature) must add their source here.
export const AUTO_TAG_SKIPS = ["template"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const niceDay = (d) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
export const tripDays = (t) => (t.start && t.end ? `${niceDay(t.start)} to ${niceDay(t.end)}` : null);

// The other trip whose days touch start..end (inclusive), or null. exceptId: the trip being changed.
export function overlappingTrip(tags, start, end, exceptId) {
  return tags.find((t) => t.id !== exceptId && t.start && t.end && start <= t.end && t.start <= end) ?? null;
}

// Checks a start and end for a trip; returns a failure or null. Both empty means "no dates".
function datesProblem(tags, start, end, exceptId) {
  if (!start && !end) return null;
  if (!start || !end) return fail("BAD_DATES", "give both a start date and an end date, or leave both empty");
  if (!isPhDate(start) || !isPhDate(end)) return fail("BAD_DATES", "those dates are not real days");
  if (end < start) return fail("BAD_DATES", "the trip cannot end before it starts");
  const other = overlappingTrip(tags, start, end, exceptId);
  if (other) return fail("TRIP_OVERLAP", `These dates overlap your trip "${other.name}" (${tripDays(other)}). Trips cannot overlap: change these dates, or change that trip first.`);
  return null;
}

const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }] });

// input: {id, name, budget? (centavos), start?, end?}. Names are unique, ignoring case. Dates may not overlap another trip.
export function planTag(state, input) {
  const name = (input.name ?? "").trim();
  const tags = state.tags ?? [];
  if (!name) return fail("BAD_NAME", "give the trip a name");
  if (tags.some((t) => t.id === input.id)) return fail("DUPLICATE_ID", "that trip already exists");
  if (tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) return fail("DUPLICATE_NAME", "you already have a trip with that name");
  if (input.budget != null && (!Number.isSafeInteger(input.budget) || input.budget < 0)) return fail("BAD_BUDGET", "the budget cannot be negative");
  const bad = datesProblem(tags, input.start || "", input.end || "", null);
  if (bad) return bad;
  const tag = { id: input.id, name, ...(input.budget != null ? { budget: input.budget } : {}), ...(input.start && input.end ? { start: input.start, end: input.end } : {}) };
  const problems = validateShape("Tag", tag);
  if (problems.length) return { ok: false, violations: problems };
  return { ok: true, violations: [], tag, state: { ...state, tags: [...tags, tag] } };
}

// Gives an existing trip its dates, changes them, or (both empty) takes them off.
export function planTripDates(state, tagId, { start = "", end = "" }) {
  const tags = state.tags ?? [], tag = tags.find((t) => t.id === tagId);
  if (!tag) return fail("UNKNOWN_TAG", "no trip " + tagId);
  const bad = datesProblem(tags, start, end, tagId);
  if (bad) return bad;
  const { start: _s, end: _e, ...rest } = tag;
  const next = { ...rest, ...(start && end ? { start, end } : {}) };
  const problems = validateShape("Tag", next);
  if (problems.length) return { ok: false, violations: problems };
  return { ok: true, violations: [], tag: next, state: { ...state, tags: tags.map((t) => (t.id === tagId ? next : t)) } };
}

// Which trip each transaction belongs to: Map(transaction id -> {tag_id, how}) where how is "hand" or "dates". Only transactions on a trip are in it.
export function tripMembership(state) {
  const tags = state.tags ?? [], byId = new Map(tags.map((t) => [t.id, t])), dated = tags.filter((t) => t.start && t.end);
  const spendCats = new Set(state.categories.filter((c) => c.kind === "expense").map((c) => c.id));
  const spends = new Set(state.entries.filter((e) => e.category_id != null && spendCats.has(e.category_id)).map((e) => e.transaction_id));
  const out = new Map();
  for (const t of state.transactions) {
    if (t.trip_add && byId.has(t.trip_add)) { out.set(t.id, { tag_id: t.trip_add, how: "hand" }); continue; }
    if (!spends.has(t.id) || AUTO_TAG_SKIPS.includes(t.source)) continue;
    const trip = dated.find((x) => t.date >= x.start && t.date <= x.end);
    if (trip && t.trip_out !== trip.id) out.set(t.id, { tag_id: trip.id, how: "dates" });
  }
  return out;
}

// Hand overrides. "add": put the transaction on the trip whatever its date. "remove": take it off, even if its date is inside the trip.
// Returns {ok, state}; only the transaction's own trip_add / trip_out change.
export function planTripOverride(state, transactionId, tagId, action) {
  const tx = state.transactions.find((t) => t.id === transactionId);
  if (!tx) return fail("UNKNOWN_TRANSACTION", "no entry " + transactionId);
  if (!(state.tags ?? []).some((t) => t.id === tagId)) return fail("UNKNOWN_TAG", "no trip " + tagId);
  const set = (next) => ({ ok: true, violations: [], state: { ...state, transactions: state.transactions.map((t) => (t.id === transactionId ? next : t)) } });
  const { trip_add, trip_out, ...rest } = tx;
  if (action === "add") return set({ ...rest, trip_add: tagId, ...(trip_out && trip_out !== tagId ? { trip_out } : {}) });
  if (action !== "remove") return fail("BAD_ACTION", "add or remove");
  const kept = trip_out ? { trip_out } : {};
  const without = { ...state, transactions: state.transactions.map((t) => (t.id === transactionId ? { ...rest, ...kept } : t)) };
  // if the dates would still put it on this trip, remember that it was taken off
  const still = tripMembership(without).get(transactionId);
  return set({ ...rest, ...(still && still.tag_id === tagId ? { trip_out: tagId } : kept) });
}

// {tag, spent, pending, budget, grade, rows:[{category_id, name, amount}]}, biggest first. grade is null without a budget.
export function tagSummary(state, tagId, { categoryMaps = [], asOf } = {}) {
  const tag = (state.tags ?? []).find((t) => t.id === tagId);
  if (!tag) return null;
  const expense = new Map(state.categories.filter((c) => c.kind === "expense").map((c) => [c.id, c]));
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const member = tripMembership(state);
  const totals = new Map();
  let pending = 0;
  for (const e of state.entries) {
    if (e.category_id == null || !expense.has(e.category_id)) continue;
    const t = txById.get(e.transaction_id);
    if (!t || member.get(t.id)?.tag_id !== tagId) continue;
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

// The entries on a trip, for its detail screen: rows [{transaction, amount, counted, how}] newest first. `amount` is the spending on the trip (sum of its
// expense-category entries; for a move or bill payment, the money moved, with counted: false). `before` holds the HAND-ADDED rows dated before the
// trip's first day (they still count in the total).
export function tripEntries(state, tagId) {
  const tag = (state.tags ?? []).find((t) => t.id === tagId);
  if (!tag) return null;
  const member = tripMembership(state), expense = new Set(state.categories.filter((c) => c.kind === "expense").map((c) => c.id));
  const rows = [];
  for (const t of state.transactions) {
    const m = member.get(t.id);
    if (!m || m.tag_id !== tagId) continue;
    const mine = state.entries.filter((e) => e.transaction_id === t.id);
    const spent = mine.filter((e) => e.category_id != null && expense.has(e.category_id)).reduce((n, e) => n + e.amount, 0);
    const moved = mine.filter((e) => e.amount > 0).reduce((n, e) => n + e.amount, 0);
    rows.push({ transaction: t, amount: spent !== 0 ? spent : moved, counted: spent !== 0, how: m.how });
  }
  rows.sort((a, b) => b.transaction.date.localeCompare(a.transaction.date) || a.transaction.id.localeCompare(b.transaction.id));
  const early = (r) => tag.start && r.how === "hand" && r.transaction.date < tag.start;
  return { tag, rows: rows.filter((r) => !early(r)), before: rows.filter(early) };
}
