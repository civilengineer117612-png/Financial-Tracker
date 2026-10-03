// The owner's pay plan (addendum item 4): two paydays a month and, for each line, what to set aside from each.
// It arrives as a small JSON file made elsewhere, so it is checked hard and turned into whole centavos.
// Nothing about a real plan is stored in the repository: it lives in the phone's settings and, encrypted, in backups.
//
// File shape (pesos in the file, centavos once loaded):
//   { "v": 1,
//     "paydays": [{"day": 15, "label": "1st payday"}, {"day": 30, "label": "2nd payday"}],
//     "lines": [{"name": "Rent", "kind": "expense", "first": 0, "second": 5000}, ...],   // kind: "expense" (default) or "goal"
//     "essentials": ["Rent", "Food"],            // optional: line names that make up the emergency target
//     "emergency_months": 3 }                    // optional, default 3
import { reportingCategory } from "./rules.js";

const fail = (error) => ({ ok: false, error });
const toCentavos = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e9) return null;
  const c = Math.round(n * 100);
  return Math.abs(n * 100 - c) < 1e-6 ? c : null;   // at most two decimals
};

export function parsePlan(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return fail("That is not a valid plan file (it could not be read)."); }
  if (!raw || raw.v !== 1) return fail("This plan file is not version 1.");
  if (!Array.isArray(raw.paydays) || raw.paydays.length !== 2) return fail("A plan needs exactly two paydays.");
  const paydays = raw.paydays.map((p) => ({ day: p?.day, label: typeof p?.label === "string" ? p.label.slice(0, 40) : "" }));
  if (!paydays.every((p) => Number.isInteger(p.day) && p.day >= 1 && p.day <= 31)) return fail("Payday days must be whole numbers from 1 to 31.");
  paydays.sort((a, b) => a.day - b.day);
  if (paydays[0].day === paydays[1].day) return fail("The two paydays must be on different days.");
  paydays.forEach((p, i) => { if (!p.label) p.label = i === 0 ? "1st payday" : "2nd payday"; });

  if (!Array.isArray(raw.lines) || raw.lines.length === 0 || raw.lines.length > 60) return fail("A plan needs between 1 and 60 lines.");
  const lines = [], seen = new Set();
  for (const [i, l] of raw.lines.entries()) {
    const name = typeof l?.name === "string" ? l.name.trim() : "";
    if (!name || name.length > 60) return fail("Line " + (i + 1) + " needs a name.");
    if (seen.has(name.toLowerCase())) return fail("The line \"" + name + "\" appears twice.");
    seen.add(name.toLowerCase());
    const kind = l.kind ?? "expense";
    if (kind !== "expense" && kind !== "goal") return fail("Line \"" + name + "\" has an unknown kind.");
    const first = toCentavos(l.first), second = toCentavos(l.second);
    if (first === null || second === null) return fail("Line \"" + name + "\" needs amounts of zero or more, with at most two decimals.");
    lines.push({ name, kind, first, second });
  }
  const essentials = raw.essentials ?? [];
  if (!Array.isArray(essentials) || !essentials.every((n) => typeof n === "string" && seen.has(n.trim().toLowerCase()))) return fail("Every essentials name must also be a line in the plan.");
  const months = raw.emergency_months ?? 3;
  if (!Number.isInteger(months) || months < 1 || months > 24) return fail("Emergency months must be a whole number from 1 to 24.");
  return { ok: true, plan: { v: 1, paydays, lines, essentials: essentials.map((n) => lines.find((l) => l.name.toLowerCase() === n.trim().toLowerCase()).name), emergency_months: months } };
}

export function planTotals(plan) {
  const first = plan.lines.reduce((n, l) => n + l.first, 0), second = plan.lines.reduce((n, l) => n + l.second, 0);
  return { first, second, month: first + second };
}

// Emergency target = months x the essentials' monthly totals (Rev. 2 uses 3 x (Rent + Food + Essentials)).
export function planEmergencyTarget(plan) {
  const set = new Set(plan.essentials);
  return plan.emergency_months * plan.lines.filter((l) => set.has(l.name)).reduce((n, l) => n + l.first + l.second, 0);
}

const pad = (n) => String(n).padStart(2, "0");
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1-12
const at = (y, m, day) => { const t = Date.UTC(y, m - 1, 1); const d = new Date(t); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(Math.min(day, dim(d.getUTCFullYear(), d.getUTCMonth() + 1))); };
const dayBefore = (iso) => new Date(Date.parse(iso) - 86400000).toISOString().slice(0, 10);

// The cutoff a date falls in: from one payday up to the day before the next. index 1 starts on the first payday.
export function cutoffFor(plan, date) {
  const [y, m, d] = date.split("-").map(Number);
  const [p1, p2] = plan.paydays.map((p) => p.day);
  const nextY = m === 12 ? y + 1 : y, nextM = m === 12 ? 1 : m + 1, prevY = m === 1 ? y - 1 : y, prevM = m === 1 ? 12 : m - 1;
  if (d >= Math.min(p2, dim(y, m))) return { index: 2, start: at(y, m, p2), end: dayBefore(at(nextY, nextM, p1)) };
  if (d >= Math.min(p1, dim(y, m))) return { index: 1, start: at(y, m, p1), end: dayBefore(at(y, m, p2)) };
  return { index: 2, start: at(prevY, prevM, p2), end: dayBefore(at(y, m, p1)) };
}

// For each plan line: what the plan sets for this cutoff, what was verified-spent in it, and what is left.
// Expense lines are matched to a category by name; an unmatched line is reported (matched:false), never guessed.
export function planProgress(state, plan, date, { categoryMaps = [] } = {}) {
  const period = cutoffFor(plan, date);
  const cats = new Map(state.categories.filter((c) => c.kind === "expense").map((c) => [c.name.toLowerCase(), c.id]));
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const spent = new Map();
  for (const e of state.entries) {
    if (e.category_id == null) continue;
    const t = txById.get(e.transaction_id);
    if (!t || t.status !== "verified" || t.date < period.start || t.date > period.end) continue;
    const id = reportingCategory(categoryMaps, e.category_id, date);
    spent.set(id, (spent.get(id) ?? 0) + e.amount);
  }
  const rows = plan.lines.map((l) => {
    const planned = period.index === 1 ? l.first : l.second;
    if (l.kind === "goal") return { name: l.name, kind: l.kind, planned, spent: null, remaining: null, matched: true };
    const id = cats.get(l.name.toLowerCase());
    if (!id) return { name: l.name, kind: l.kind, planned, spent: null, remaining: null, matched: false };
    const s = spent.get(id) ?? 0;
    return { name: l.name, kind: l.kind, category_id: id, planned, spent: s, remaining: planned - s, matched: true };
  });
  return { period, rows };
}
