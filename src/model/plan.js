// The owner's pay plan (addendum item 4, Rev. 2 Table 5.1): two paydays a month and, for each line, what is set
// aside from each. It arrives as a small JSON file made elsewhere, so it is checked hard.
//   - The file declares its unit (whole pesos or centavos); it is converted to integer centavos once and never guessed.
//   - The second payday can be "last" (the last day of the month): February has no 30th, March has a 31st.
//   - Each payday has an income, and that payday's lines must sum to it exactly (the same balance idea as entries).
//   - Plans are append-only and dated, like rules (Section 2.5): a change is a NEW plan with a later effective_from,
//     never an edit. The plan in effect on a date is the latest one that started on or before it.
// Nothing about a real plan is stored in the repository: it lives in the phone's settings and, encrypted, in backups.
//
// File shape (invented numbers; whole pesos, the unit the file declares):
//   { "schema_version": 1, "unit": "PHP_whole_pesos", "effective_from": "2026-10-15",
//     "paydays": [{"id": "first", "day": 15, "label": "1st payday", "expected_income": 1000},
//                 {"id": "second", "day": "last", "label": "2nd payday", "expected_income": 2400}],
//     "lines": [{"name": "Food", "kind": "expense", "first": 600, "second": 600},
//               {"name": "Rent", "kind": "expense", "first": 0, "second": 500},
//               {"name": "Apartment Fund", "kind": "goal", "first": 400, "second": 1300}],
//     "ef_target_basis": ["Rent", "Food"], "ef_target_months": 3 }          // the last two are optional, together
//   kind: "expense" (tracked against the category of the same name), "goal" (savings; matched to a goal by name)
//   or "buffer" (set aside). Internally everything is integer centavos.
import { reportingCategory } from "./rules.js";
import { isPhDate, phTimestamp } from "./util.js";
import { checkTransactionSave } from "./index.js";
import { naturalBalance } from "./balances.js";

const fail = (error) => ({ ok: false, error });
const whole = (n) => Number.isSafeInteger(n) && n >= 0;
const key = (s) => s.trim().toLowerCase();
const KINDS = ["expense", "goal", "buffer"];
// The file declares its unit; amounts are converted to integer centavos once, here, and never guessed.
const UNITS = { PHP_whole_pesos: 100, PHP_centavos: 1 };

export function parsePlan(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return fail("That is not a valid plan file (it could not be read)."); }
  if (!raw || raw.schema_version !== 1) return fail("This plan file is not schema_version 1.");
  const mult = UNITS[raw.unit];
  if (!mult) return fail("The file must declare its unit as \"PHP_whole_pesos\" or \"PHP_centavos\". An amount without a unit is never guessed.");
  if (typeof raw.effective_from !== "string" || !isPhDate(raw.effective_from)) return fail("The plan needs an effective_from date like 2026-10-15.");

  if (!Array.isArray(raw.paydays) || raw.paydays.length !== 2) return fail("A plan needs exactly two paydays.");
  const [a, b] = raw.paydays;
  if (!Number.isInteger(a?.day) || a.day < 1 || a.day > 28) return fail("The 1st payday day must be a whole number from 1 to 28.");
  if (!(b?.day === "last" || (Number.isInteger(b?.day) && b.day > a.day && b.day <= 28))) return fail("The 2nd payday day must be \"last\" (the last day of the month) or a day from " + (a.day + 1) + " to 28.");
  if (!whole(a.expected_income) || !whole(b.expected_income)) return fail("Each payday needs an expected_income in whole " + (mult === 100 ? "pesos" : "centavos") + ".");
  const paydays = [a, b].map((p, i) => ({ label: typeof p.label === "string" && p.label.trim() ? p.label.trim().slice(0, 40) : i === 0 ? "1st payday" : "2nd payday", day: p.day, income: p.expected_income * mult }));

  if (!Array.isArray(raw.lines) || raw.lines.length === 0 || raw.lines.length > 60) return fail("A plan needs between 1 and 60 lines.");
  const lines = [], names = new Set();
  for (const [i, l] of raw.lines.entries()) {
    const name = typeof l?.name === "string" ? l.name.trim() : "";
    if (!name || name.length > 60) return fail("Line " + (i + 1) + " needs a name of 1 to 60 characters.");
    if (names.has(key(name))) return fail("The line \"" + name + "\" appears twice.");
    names.add(key(name));
    const kind = l.kind ?? "expense";
    if (!KINDS.includes(kind)) return fail("Line \"" + name + "\" has an unknown kind.");
    if (!whole(l.first) || !whole(l.second)) return fail("Line \"" + name + "\" needs whole " + (mult === 100 ? "peso" : "centavo") + " amounts of zero or more.");
    lines.push({ name, kind, first: l.first * mult, second: l.second * mult });
  }

  // Each payday's lines must sum to that payday's income, to the centavo.
  for (const [i, field] of [[0, "first"], [1, "second"]]) {
    const sum = lines.reduce((n, l) => n + l[field], 0), income = paydays[i].income;
    if (sum !== income) return fail("The lines for the " + paydays[i].label + " add up to " + sum / mult + " but its expected income is " + income / mult + " (" + (sum > income ? "over by " : "short by ") + Math.abs(sum - income) / mult + ").");
  }

  let emergency = null;
  if (raw.ef_target_basis !== undefined || raw.ef_target_months !== undefined) {
    const basis = raw.ef_target_basis, months = raw.ef_target_months;
    if (!Number.isInteger(months) || months < 1 || months > 24) return fail("ef_target_months must be a whole number from 1 to 24.");
    if (!Array.isArray(basis) || basis.length === 0 || !basis.every((n) => typeof n === "string" && names.has(key(n)))) return fail("Every name in ef_target_basis must be a line in the plan.");
    if (new Set(basis.map(key)).size !== basis.length) return fail("ef_target_basis lists a name twice.");
    emergency = { months, basis: basis.map((n) => lines.find((l) => key(l.name) === key(n)).name) };
  }
  return { ok: true, plan: { effective_from: raw.effective_from, paydays, lines, emergency } };
}

// The Emergency Fund, worked out from the plan in force and never typed in as a fixed number.
// Target = months x (monthly Rent + Food + Essentials), or the months and names the plan itself sets (ef_target_*).
// Monthly contribution = the plan's own goal line for the fund. `missing` names any basis line the plan does not have.
// goal: the goal row whose account holds the fund. Returns null when the plan has none of the basis lines.
export const DEFAULT_EF = { months: 3, basis: ["Rent", "Food", "Essentials"] };
export function emergencyFundStatus(state, plan, goal) {
  if (!plan || !goal) return null;
  const { months, basis } = plan.emergency ?? DEFAULT_EF;
  const found = basis.map((n) => plan.lines.find((l) => key(l.name) === key(n))).filter(Boolean);
  if (!found.length) return null;
  const monthlyBasis = found.reduce((n, l) => n + l.first + l.second, 0), target = months * monthlyBasis;
  const account = state.accounts.find((a) => a.id === goal.account_id);
  const balance = account ? naturalBalance(account, state.entries) : 0;
  const line = plan.lines.find((l) => l.kind === "goal" && key(l.name) === key(goal.name)) ?? plan.lines.find((l) => l.kind === "goal" && /emergency/i.test(l.name));
  const monthly = line ? line.first + line.second : 0, remaining = Math.max(0, target - balance);
  return { target, months, basis: found.map((l) => l.name), missing: basis.filter((n) => !plan.lines.some((l) => key(l.name) === key(n))), monthlyBasis,
    balance, remaining, percent: target ? Math.min(100, Math.floor((balance * 100) / target)) : 0, reached: balance >= target,
    monthly, monthsToTarget: remaining === 0 ? 0 : monthly > 0 ? Math.ceil(remaining / monthly) : null };
}

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

const monthlyOf = (plan, name) => { const l = plan.lines.find((x) => key(x.name) === key(name)); return l ? l.first + l.second : 0; };

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
// An expense line is matched to a category by name; anything that matches nothing is reported (matched:false), never guessed.
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
    const id = cats.get(key(l.name));
    if (!id) return { name: l.name, kind: l.kind, planned, spent: null, remaining: null, matched: false };
    const s = spent.get(id) ?? 0;
    return { name: l.name, kind: l.kind, category_id: id, planned, spent: s, remaining: planned - s, matched: true };
  });
  return { period, rows };
}

// Income variance (owner's decision): the plan holds PLANNING income; the ledger holds what the payslip really said,
// in centavos, overtime included. The two are never reconciled by editing the plan; the gap is just shown.
// For the cutoff containing `date`: planned = that payday's income, actual = verified income received in the cutoff,
// variance = actual - planned (plus means more came in than planned).
export function planIncome(state, plan, date) {
  const period = cutoffFor(plan, date);
  const income = new Set(state.categories.filter((c) => c.kind === "income").map((c) => c.id));
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  let received = 0, count = 0;
  for (const e of state.entries) {
    if (e.category_id == null || !income.has(e.category_id)) continue;
    const t = txById.get(e.transaction_id);
    if (!t || t.status !== "verified" || t.date < period.start || t.date > period.end) continue;
    received -= e.amount;   // income is a credit, stored negative
    count += 1;
  }
  const planned = plan.paydays[period.index - 1].income;
  return { period, label: plan.paydays[period.index - 1].label, planned, actual: received, variance: received - planned, count };
}

// Pay received, typed in from a payslip: money arrives in an account and is booked to an income category.
// It is saved VERIFIED, because copying a figure off a payslip is itself the careful look (like a check-in count).
// input: {transaction_id, date, amount (centavos), account_id, category_id?, memo?}
export function planPayReceived(state, input, now = new Date()) {
  const bad = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }] });
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) return bad("BAD_AMOUNT", "amount must be more than zero");
  const account = state.accounts.find((a) => a.id === input.account_id);
  if (!account || account.class !== "asset") return bad("UNKNOWN_ACCOUNT", "choose the account the pay arrived in");
  const cat = input.category_id ? state.categories.find((c) => c.id === input.category_id) : state.categories.find((c) => c.kind === "income");
  if (!cat || cat.kind !== "income") return bad("UNKNOWN_CATEGORY", "no income category found");
  if (!isPhDate(input.date)) return bad("BAD_DATE", "date must be like 2026-10-15");
  const stamp = phTimestamp(now);
  const transaction = { id: input.transaction_id, date: input.date, payee: input.payee || "Pay received", memo: input.memo ?? "", ...(input.source === "photo" || input.source === "voice" ? { status: "draft", source: input.source, edited_before_verify: false, created_at: stamp } : { status: "verified", source: "manual", created_at: stamp, verified_at: stamp }) };
  const entries = [
    { transaction_id: transaction.id, account_id: account.id, amount: input.amount },
    { transaction_id: transaction.id, category_id: cat.id, amount: -input.amount },
  ];
  const result = checkTransactionSave(state, { transaction, entries });
  return { ...result, transaction, entries, state: result.ok ? { ...state, transactions: [...state.transactions, transaction], entries: [...state.entries, ...entries] } : state };
}
