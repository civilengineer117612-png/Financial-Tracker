// The owner's pay plan (addendum item 4, Rev. 2 Table 5.1): two paydays a month and, for each line, what is set
// aside from each. It arrives as a small JSON file made elsewhere, so it is checked hard.
//   - Money is integer CENTAVOS and the file must say so ("units": "centavos"); a bare 500 is never guessed.
//   - The second payday can be "last" (the last day of the month): February has no 30th, March has a 31st.
//   - Each payday has an income, and that payday's lines must sum to it exactly (the same balance idea as entries).
//   - Plans are append-only and dated, like rules (Section 2.5): a change is a NEW plan with a later effective_from,
//     never an edit. The plan in effect on a date is the latest one that started on or before it.
// Nothing about a real plan is stored in the repository: it lives in the phone's settings and, encrypted, in backups.
//
// File shape (invented numbers):
//   { "schema": 2, "units": "centavos", "effective_from": "2026-10-01",
//     "paydays": [{"label": "1st payday", "day": 15, "income": 1000000}, {"label": "2nd payday", "day": "last", "income": 2400000}],
//     "lines": [
//       {"name": "Daily spending", "kind": "expense", "first": 600000, "second": 600000,
//        "categories": [{"name": "Food", "monthly": 800000}, {"name": "Shopping", "monthly": 400000}]},
//       {"name": "Rent", "kind": "expense", "first": 0, "second": 500000},
//       {"name": "Apartment Fund", "kind": "goal", "first": 400000, "second": 1300000}],
//     "emergency": {"months": 3, "basis": ["Rent", "Food"]} }          // optional
//   kind: "expense" (tracked against a category), "goal" (savings; matched to a goal by name) or "buffer" (set aside).
import { reportingCategory } from "./rules.js";
import { isPhDate } from "./util.js";

const fail = (error) => ({ ok: false, error });
const amount = (n) => Number.isSafeInteger(n) && n >= 0;
const key = (s) => s.trim().toLowerCase();
const KINDS = ["expense", "goal", "buffer"];

export function parsePlan(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return fail("That is not a valid plan file (it could not be read)."); }
  if (!raw || raw.schema !== 2) return fail("This plan file is not schema 2.");
  if (raw.units !== "centavos") return fail("The file must say \"units\": \"centavos\". Amounts are whole centavos, so 500 pesos is 50000.");
  if (typeof raw.effective_from !== "string" || !isPhDate(raw.effective_from)) return fail("The plan needs an effective_from date like 2026-10-01.");

  if (!Array.isArray(raw.paydays) || raw.paydays.length !== 2) return fail("A plan needs exactly two paydays.");
  const [a, b] = raw.paydays;
  if (!Number.isInteger(a?.day) || a.day < 1 || a.day > 28) return fail("The 1st payday day must be a whole number from 1 to 28.");
  if (!(b?.day === "last" || (Number.isInteger(b?.day) && b.day > a.day && b.day <= 28))) return fail("The 2nd payday day must be \"last\" (the last day of the month) or a day from " + (a.day + 1) + " to 28.");
  if (!amount(a.income) || !amount(b.income)) return fail("Each payday needs an income in whole centavos.");
  const paydays = [a, b].map((p, i) => ({ label: typeof p.label === "string" && p.label.trim() ? p.label.trim().slice(0, 40) : i === 0 ? "1st payday" : "2nd payday", day: p.day, income: p.income }));

  if (!Array.isArray(raw.lines) || raw.lines.length === 0 || raw.lines.length > 60) return fail("A plan needs between 1 and 60 lines.");
  const lines = [], names = new Set();
  const claim = (name, where) => {
    if (!name || name.length > 60) return "Every name needs 1 to 60 characters (" + where + ").";
    if (names.has(key(name))) return "The name \"" + name + "\" appears twice.";
    names.add(key(name));
    return null;
  };
  for (const [i, l] of raw.lines.entries()) {
    const name = typeof l?.name === "string" ? l.name.trim() : "";
    const dup = claim(name, "line " + (i + 1));
    if (dup) return fail(dup);
    const kind = l.kind ?? "expense";
    if (!KINDS.includes(kind)) return fail("Line \"" + name + "\" has an unknown kind.");
    if (!amount(l.first) || !amount(l.second)) return fail("Line \"" + name + "\" needs whole-centavo amounts of zero or more.");
    const line = { name, kind, first: l.first, second: l.second };
    if (l.categories !== undefined) {
      if (kind !== "expense" || !Array.isArray(l.categories) || l.categories.length === 0) return fail("Only an expense line can list categories, and the list cannot be empty (\"" + name + "\").");
      line.categories = [];
      for (const c of l.categories) {
        const cn = typeof c?.name === "string" ? c.name.trim() : "";
        const d = claim(cn, "a category of \"" + name + "\"");
        if (d) return fail(d);
        if (!amount(c.monthly)) return fail("Category \"" + cn + "\" needs a monthly amount in whole centavos.");
        line.categories.push({ name: cn, monthly: c.monthly });
      }
      const sum = line.categories.reduce((n, c) => n + c.monthly, 0);
      if (sum !== line.first + line.second) return fail("The categories of \"" + name + "\" add up to " + sum + " centavos a month, but the line is " + (line.first + line.second) + ".");
    }
    lines.push(line);
  }

  // Each payday's lines must sum to that payday's income, to the centavo.
  for (const [i, field] of [[0, "first"], [1, "second"]]) {
    const sum = lines.reduce((n, l) => n + l[field], 0), income = paydays[i].income;
    if (sum !== income) return fail("The lines for the " + paydays[i].label + " add up to " + sum + " centavos but its income is " + income + " (" + (sum > income ? "over by " : "short by ") + Math.abs(sum - income) + ").");
  }

  let emergency = null;
  if (raw.emergency !== undefined) {
    const e = raw.emergency;
    if (!Number.isInteger(e?.months) || e.months < 1 || e.months > 24) return fail("Emergency months must be a whole number from 1 to 24.");
    if (!Array.isArray(e.basis) || e.basis.length === 0 || !e.basis.every((n) => typeof n === "string" && names.has(key(n)))) return fail("Every name in the emergency basis must be a line or category in the plan.");
    if (new Set(e.basis.map(key)).size !== e.basis.length) return fail("The emergency basis lists a name twice.");
    emergency = { months: e.months, basis: e.basis.map((n) => canonical(lines, n)) };
  }
  return { ok: true, plan: { schema: 2, units: "centavos", effective_from: raw.effective_from, paydays, lines, emergency } };
}

const canonical = (lines, name) => {
  for (const l of lines) {
    if (key(l.name) === key(name)) return l.name;
    const c = l.categories?.find((x) => key(x.name) === key(name));
    if (c) return c.name;
  }
  return name;
};

// Adds a plan without ever editing one: the same effective date twice is refused unless it is the identical plan.
export function addPlan(plans, plan) {
  const same = plans.find((p) => p.effective_from === plan.effective_from);
  if (same) return JSON.stringify(same) === JSON.stringify(plan) ? { ok: true, plans, unchanged: true } : { ok: false, error: "A plan starting " + plan.effective_from + " is already saved. A change is a new plan with a later start date; saved plans are never edited." };
  return { ok: true, plans: [...plans, plan] };
}

// The plan in force on a date: the latest effective_from on or before it (null before the first plan starts).
export function planInEffect(plans, date) {
  let best = null;
  for (const p of plans) if (p.effective_from <= date && (!best || p.effective_from >= best.effective_from)) best = p;
  return best;
}

export function planTotals(plan) {
  const first = plan.lines.reduce((n, l) => n + l.first, 0), second = plan.lines.reduce((n, l) => n + l.second, 0);
  return { first, second, month: first + second };
}

// The monthly amount of a plan name: a category's own monthly figure, or a whole line's monthly total.
const monthlyOf = (plan, name) => {
  for (const l of plan.lines) {
    if (key(l.name) === key(name)) return l.first + l.second;
    const c = l.categories?.find((x) => key(x.name) === key(name));
    if (c) return c.monthly;
  }
  return 0;
};

// Emergency target = months x the monthly total of the basis names (null when the plan sets none).
export function planEmergencyTarget(plan) {
  return plan.emergency ? plan.emergency.months * plan.emergency.basis.reduce((n, name) => n + monthlyOf(plan, name), 0) : null;
}

const pad = (n) => String(n).padStart(2, "0");
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1-12
const dayIn = (day, y, m) => (day === "last" ? dim(y, m) : Math.min(day, dim(y, m)));
const at = (y, m, day) => { const d = new Date(Date.UTC(y, m - 1, 1)); const yy = d.getUTCFullYear(), mm = d.getUTCMonth() + 1; return yy + "-" + pad(mm) + "-" + pad(dayIn(day, yy, mm)); };
const dayBefore = (iso) => new Date(Date.parse(iso) - 86400000).toISOString().slice(0, 10);

// The cutoff a date falls in: from one payday up to the day before the next. index 1 starts on the first payday.
export function cutoffFor(plan, date) {
  const [y, m, d] = date.split("-").map(Number);
  const [p1, p2] = plan.paydays.map((p) => p.day);
  const nextY = m === 12 ? y + 1 : y, nextM = m === 12 ? 1 : m + 1, prevY = m === 1 ? y - 1 : y, prevM = m === 1 ? 12 : m - 1;
  if (d >= dayIn(p2, y, m)) return { index: 2, start: at(y, m, p2), end: dayBefore(at(nextY, nextM, p1)) };
  if (d >= dayIn(p1, y, m)) return { index: 1, start: at(y, m, p1), end: dayBefore(at(y, m, p2)) };
  return { index: 2, start: at(prevY, prevM, p2), end: dayBefore(at(y, m, p1)) };
}

// For each plan line: what the plan sets for this cutoff, what was verified-spent in it, and what is left.
// An expense line is matched to categories by name (its listed categories, or the line's own name); anything that
// matches nothing is reported (matched:false), never guessed.
export function planProgress(state, plan, date, { categoryMaps = [] } = {}) {
  const period = cutoffFor(plan, date);
  const cats = new Map(state.categories.filter((c) => c.kind === "expense").map((c) => [key(c.name), c.id]));
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
    if (l.kind !== "expense") return { name: l.name, kind: l.kind, planned, spent: null, remaining: null, matched: true };
    const wanted = (l.categories ?? [{ name: l.name }]).map((c) => c.name);
    const ids = wanted.map((n) => cats.get(key(n)));
    const missing = wanted.filter((_, i) => !ids[i]);
    if (missing.length) return { name: l.name, kind: l.kind, planned, spent: null, remaining: null, matched: false, missing };
    const s = ids.reduce((n, id) => n + (spent.get(id) ?? 0), 0);
    return { name: l.name, kind: l.kind, planned, spent: s, remaining: planned - s, matched: true };
  });
  return { period, rows };
}
