// The numbers behind the charts: where the money went. Pure functions over the state.
//   - Only VERIFIED transactions count, as everywhere else; drafts are reported separately as pending.
//   - Only expense categories count: income, transfers between your own accounts and card payments
//     are not spending (spec 2.3).
//   - Categories are grouped as of `asOf` (the day the report is run), so a merge regroups history.
//   - Unlogged counts: it is real money that left and was never logged.
import { reportingCategory } from "./rules.js";

export const monthOf = (date) => date.slice(0, 7);

export function addMonths(month, n) {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return Math.floor(t / 12) + "-" + String((t % 12) + 1).padStart(2, "0");
}

const NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (month) => NAMES[Number(month.slice(5, 7)) - 1] + " " + month.slice(0, 4);

const lastDayOf = (month) => month + "-31";   // string order is date order, so this safely means "the end of the month"

// {total, pending, rows:[{category_id, name, amount, percent}]}, biggest first, for any date range (inclusive, YYYY-MM-DD).
// `total` is net spending (refunds reduce it); `percent` is each positive row's share of it, to 0.1.
export function spendingByRange(state, { from, to, categoryMaps = [], asOf }) {
  const expense = new Map(state.categories.filter((c) => c.kind === "expense").map((c) => [c.id, c]));
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const totals = new Map();
  let pending = 0;
  for (const e of state.entries) {
    if (e.category_id == null || !expense.has(e.category_id)) continue;
    const t = txById.get(e.transaction_id);
    if (!t || t.date < from || t.date > to) continue;
    if (t.status !== "verified") { pending += e.amount; continue; }
    const id = reportingCategory(categoryMaps, e.category_id, asOf ?? to);
    totals.set(id, (totals.get(id) ?? 0) + e.amount);
  }
  const rows = [...totals].filter(([, amount]) => amount !== 0)
    .map(([category_id, amount]) => ({ category_id, name: expense.get(category_id)?.name ?? category_id, amount }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const total = rows.reduce((n, r) => n + r.amount, 0);
  return { total, pending, rows: rows.map((r) => ({ ...r, percent: r.amount > 0 && total > 0 ? Math.round((r.amount * 1000) / total) / 10 : 0 })) };
}

// The same for one month. Categories are grouped as of `asOf` (the day the report is run), so a merge regroups history.
export function spendingByCategory(state, { month, categoryMaps = [], asOf = lastDayOf(month) }) {
  return spendingByRange(state, { from: month + "-01", to: lastDayOf(month), categoryMaps, asOf });
}

// Which account the spending came out of. A card counts as the account the charge was made on.
// {total, rows:[{account_id, name, amount}]}, biggest first.
export function spendingByAccount(state, { month, from, to }) {
  const lo = from ?? month + "-01", hi = to ?? lastDayOf(month);
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  const expense = new Set(state.categories.filter((c) => c.kind === "expense").map((c) => c.id));
  const spendingTx = new Set();
  for (const e of state.entries) if (e.category_id != null && expense.has(e.category_id)) spendingTx.add(e.transaction_id);
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const totals = new Map();
  for (const e of state.entries) {
    if (e.account_id == null || !spendingTx.has(e.transaction_id)) continue;
    const t = txById.get(e.transaction_id);
    if (!t || t.status !== "verified" || t.date < lo || t.date > hi) continue;
    totals.set(e.account_id, (totals.get(e.account_id) ?? 0) - e.amount);   // money out = a credit, stored negative
  }
  const rows = [...totals].filter(([, amount]) => amount !== 0)
    .map(([account_id, amount]) => ({ account_id, name: accounts.get(account_id)?.name ?? account_id, amount }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  return { total: rows.reduce((n, r) => n + r.amount, 0), rows };
}

// Total spending for each of the last `months` months ending at `endMonth`, oldest first.
export function monthlySpending(state, { endMonth, months = 6, categoryMaps = [], asOf }) {
  return Array.from({ length: months }, (_, i) => {
    const month = addMonths(endMonth, i - (months - 1));
    return { month, amount: spendingByCategory(state, { month, categoryMaps, asOf: asOf ?? lastDayOf(month) }).total };
  });
}

// Quick day total (addendum, item 7): what was spent on one date, drafts INCLUDED because on the day you
// log, nothing is verified yet. `verified` and `draft` are reported apart so the screen can say which is which.
// Spending means expense categories only, net of refunds. A check-in's reconciliation is not an expense you made.
export function dayTotal(state, date) {
  const expense = new Set(state.categories.filter((c) => c.kind === "expense").map((c) => c.id));
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  let verified = 0, draft = 0, drafts = 0;
  for (const e of state.entries) {
    if (e.category_id == null || !expense.has(e.category_id)) continue;
    const t = txById.get(e.transaction_id);
    if (!t || t.date !== date || t.source === "reconciliation") continue;
    if (t.status === "verified") verified += e.amount; else { draft += e.amount; drafts += 1; }
  }
  return { total: verified + draft, verified, draft, drafts };
}
