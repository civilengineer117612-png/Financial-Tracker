// Suggested scheduled payments. Two quiet sources, both only SUGGESTIONS: the owner adds one (the usual Add form opens, filled in, and the owner saves it)
// or turns it down for good. Nothing becomes a schedule, a draft or an entry by itself.
//   1. History: the same payee paid in at least 3 different months of the last 6, always around the same day of the month, for the same amount
//      (or, when it varies a little like a utility bill, an "about" amount).
//   2. The Pay plan: a plan line that is rent, utilities, a subscription or a debt (read from the category's ROLE) and is not scheduled yet.
// A payee or plan line that already has a schedule is never suggested, and neither is one the owner dismissed (`schedule_hints_dismissed`).
import { monthsBefore } from "./pictures.js";

export const HISTORY_MONTHS = 6, MIN_MONTHS = 3, DAY_SPREAD = 3, AMOUNT_SPREAD = 0.15;
const FIXED_ROLES = ["rent", "utilities", "subscription", "debt"];
const NOT_PLAIN = ["reconciliation", "correction", "template"];
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const mode = (a) => { const c = new Map(); for (const x of a) c.set(x, (c.get(x) ?? 0) + 1); return [...c.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0] ?? null; };
const sameMonthOf = (d) => d.slice(0, 7);

// Is this name already a schedule, or dismissed?
function skipper(state, dismissed) {
  const have = new Set((state.schedules ?? []).map((s) => norm(s.name))), gone = new Set(dismissed ?? []);
  return (name, key) => have.has(norm(name)) || gone.has(key);
}

// Plain expenses (one expense category, one account) that were verified, are not cancelled, and are not scheduled payments.
function plainExpenses(state) {
  const cancelled = new Set((state.transactions ?? []).filter((t) => t.reverses).flatMap((t) => [t.id, t.reverses]));
  const cats = new Map((state.categories ?? []).map((c) => [c.id, c]));
  const byTx = new Map();
  for (const e of state.entries ?? []) { if (!byTx.has(e.transaction_id)) byTx.set(e.transaction_id, []); byTx.get(e.transaction_id).push(e); }
  const out = [];
  for (const t of state.transactions ?? []) {
    if (t.status !== "verified" || cancelled.has(t.id) || NOT_PLAIN.includes(t.source) || t.id.startsWith("rsv:") || t.id.startsWith("fee:") || !norm(t.payee)) continue;
    const es = byTx.get(t.id) ?? [];
    const cat = es.find((e) => e.category_id != null), acct = es.find((e) => e.account_id != null);
    if (es.length !== 2 || !cat || !acct || cat.amount <= 0 || cats.get(cat.category_id)?.kind !== "expense") continue;
    out.push({ payee: t.payee.trim(), key: norm(t.payee), date: t.date, amount: cat.amount, category_id: cat.category_id, account_id: acct.account_id });
  }
  return out;
}

export function suggestFromHistory(state, today, { dismissed = [] } = {}) {
  const from = monthsBefore(today, HISTORY_MONTHS), skip = skipper(state, dismissed), groups = new Map();
  for (const x of plainExpenses(state)) { if (x.date < from || x.date > today) continue; if (!groups.has(x.key)) groups.set(x.key, []); groups.get(x.key).push(x); }
  const out = [];
  for (const [key, rows] of groups) {
    const months = new Set(rows.map((r) => sameMonthOf(r.date)));
    if (months.size < MIN_MONTHS || rows.length > months.size * 2) continue;   // paid about once a month, in at least 3 different months
    const days = rows.map((r) => Number(r.date.slice(8)));
    if (Math.max(...days) - Math.min(...days) > DAY_SPREAD * 2) continue;     // always around the same day
    const amounts = rows.map((r) => r.amount), lo = Math.min(...amounts), hi = Math.max(...amounts);
    if (hi > lo * (1 + AMOUNT_SPREAD)) continue;                              // a payee whose amount swings widely is not a repeating payment
    if (skip(rows[0].payee, "hist:" + key)) continue;
    out.push({ key: "hist:" + key, source: "history", name: rows[0].payee, amount: lo === hi ? lo : median(amounts), approx: lo !== hi, day: median(days),
      category_id: mode(rows.map((r) => r.category_id)), account_id: mode(rows.map((r) => r.account_id)), months: months.size, of: HISTORY_MONTHS });
  }
  return out.sort((a, b) => b.months - a.months || (a.name < b.name ? -1 : 1));
}

// plan: the plan in effect ({paydays: [{day}], lines: [{name, kind, first, second}]} in centavos) or null.
export function suggestFromPlan(state, plan, { dismissed = [] } = {}) {
  if (!plan) return [];
  const skip = skipper(state, dismissed), scheduledCats = new Set((state.schedules ?? []).filter((s) => s.kind === "repeating").map((s) => s.category_id));
  const lastPay = new Map();
  for (const x of plainExpenses(state)) { const k = x.category_id; if (!lastPay.has(k) || x.date > lastPay.get(k).date) lastPay.set(k, x); }
  const out = [];
  for (const l of plan.lines ?? []) {
    if (l.kind !== "expense") continue;
    const cat = (state.categories ?? []).find((c) => c.kind === "expense" && norm(c.name) === norm(l.name));   // the plan file's own names
    if (!cat || !FIXED_ROLES.includes(cat.role) || scheduledCats.has(cat.id)) continue;
    const amount = (l.first ?? 0) + (l.second ?? 0);
    if (!(amount > 0) || skip(l.name, "plan:" + norm(l.name))) continue;
    const first = (l.first ?? 0) > 0 ? plan.paydays[0] : plan.paydays[1] ?? plan.paydays[0];
    const day = first.day === "last" ? 28 : Number(first.day);
    out.push({ key: "plan:" + norm(l.name), source: "plan", name: l.name, amount, approx: false, day, category_id: cat.id, account_id: lastPay.get(cat.id)?.account_id ?? null });
  }
  return out;
}

// Both sources together, a history suggestion winning when the same name is in both; at most `limit`.
export function scheduleHints(state, today, plan, { dismissed = [], limit = 3 } = {}) {
  const hist = suggestFromHistory(state, today, { dismissed }), seen = new Set(hist.map((h) => norm(h.name)));
  return [...hist, ...suggestFromPlan(state, plan, { dismissed }).filter((p) => !seen.has(norm(p.name)))].slice(0, limit);
}
