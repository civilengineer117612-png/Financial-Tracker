// The Pay plan typed in by hand. The form is turned into the same plan text a plan file holds and then read by `parsePlan`, so one set of rules
// (the day ranges, each payday's lines adding up to its pay, names not repeated) judges a typed plan and a loaded file alike.
import { parsePesos } from "./money.js";
import { suggestPlan } from "./suggest.js";
import { suggestInputs } from "./schedules.js";
import { engineSettings, toNearest50 } from "./budgetview.js";
import { UNLOGGED_CATEGORY_ID } from "./seed.js";
import { monthOf } from "./reports.js";

export const MAX_FORM_LINES = 60;
// A line with no amount typed on either payday is left out, listed or not: the form lists every category, and only the ones you give money to are in the plan.
const blankLine = (f, i) => !(f["a" + i] ?? "").trim() && !(f["b" + i] ?? "").trim();
const KINDS = { expense: "Spending", goal: "Goal", buffer: "Buffer" };
export const KIND_NAMES = KINDS;

export const newPlanForm = (today) => ({ start: today, twice: true, d1: "15", p1: "", d2: "last", p2: "", count: 4, n0: "", k0: "expense", a0: "", b0: "", n1: "", k1: "expense", a1: "", b1: "", n2: "", k2: "expense", a2: "", b2: "", n3: "", k3: "expense", a3: "", b3: "" });

// Pesos typed in a box ("1,250.50") to centavos; empty means zero; anything else is NaN.
const peso = (s) => { const t = String(s ?? "").trim(); if (!t) return 0; const r = parsePesos(t); return r.ok ? r.centavos : NaN; };

// {ok, text} for the plan text, or {ok: false, error} when a box cannot be read. Whether the plan is acceptable is parsePlan's call.
export function planTextFromForm(f) {
  const income = [peso(f.p1), f.twice ? peso(f.p2) : 0];
  if (income.some(Number.isNaN)) return { ok: false, error: "A pay amount is not a number. Type it like 25000 or 25000.50." };
  const paydays = [{ label: "1st payday", day: Number(f.d1), expected_income: income[0] }];
  if (f.twice) paydays.push({ label: "2nd payday", day: String(f.d2).trim().toLowerCase() === "last" ? "last" : Number(f.d2), expected_income: income[1] });
  const lines = [];
  for (let i = 0; i < (f.count ?? 0); i++) {
    if (blankLine(f, i)) continue;
    const a = peso(f["a" + i]), b = f.twice ? peso(f["b" + i]) : 0;
    if (Number.isNaN(a) || Number.isNaN(b)) return { ok: false, error: "The amount on line " + (i + 1) + " is not a number." };
    lines.push({ name: (f["n" + i] ?? "").trim(), kind: f["k" + i] ?? "expense", first: a, second: b });
  }
  return { ok: true, text: JSON.stringify({ schema_version: 1, unit: "PHP_centavos", effective_from: f.start, paydays, lines }) };
}

// Live help while typing: for each payday, the pay, what the lines place, and what is left to place (negative: placed too much).
export function planFormStatus(f) {
  const rows = [];
  for (let p = 0; p < (f.twice ? 2 : 1); p++) {
    const pay = peso(f[p ? "p2" : "p1"]); let placed = 0;
    for (let i = 0; i < (f.count ?? 0); i++) { if (blankLine(f, i)) continue; const v = peso(f[(p ? "b" : "a") + i]); placed += Number.isNaN(v) ? 0 : v; }
    rows.push({ pay: Number.isNaN(pay) ? 0 : pay, placed, left: (Number.isNaN(pay) ? 0 : pay) - placed });
  }
  return rows;
}

// The form filled from a plan already saved, to start a newer one from it: same paydays, same lines, a new start date. Amounts come back as typed pesos.
const pesoText = (c) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));
export function formFromPlan(plan, today) {
  const two = plan.paydays.length === 2, f = { start: today, twice: two, d1: String(plan.paydays[0].day), p1: pesoText(plan.paydays[0].income),
    d2: two ? String(plan.paydays[1].day) : "last", p2: two ? pesoText(plan.paydays[1].income) : "", count: Math.min(plan.lines.length, MAX_FORM_LINES) };
  plan.lines.slice(0, MAX_FORM_LINES).forEach((l, i) => { f["n" + i] = l.name; f["k" + i] = l.kind; f["a" + i] = pesoText(l.first); f["b" + i] = two ? pesoText(l.second) : ""; });
  return f;
}

// ---------- the form lists the owner's own categories and goals ----------
const lower = (x) => String(x ?? "").trim().toLowerCase();
// Centavos as the pesos a box takes: 6000 for 600000, 6000.50 for 600050.
export const amountText = (c) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));

// The lines the form lists for you: every spending category (not Unlogged, not hidden) and every goal, plus `extra` lines (the overrun buffer) when given.
// A name is listed once. A line is matched to its category or goal by name, as parsePlan does, so these are the names the plan will use.
export function planFormLines(state, hidden = [], extra = []) {
  const out = [], seen = new Set();
  const add = (l) => { const k = lower(l.name); if (!k || seen.has(k)) return; seen.add(k); out.push(l); };
  for (const c of state.categories ?? []) if (c.kind === "expense" && c.id !== UNLOGGED_CATEGORY_ID && !hidden.includes(c.id)) add({ name: c.name, kind: "expense" });
  for (const g of state.goals ?? []) add({ name: g.name, kind: "goal" });
  for (const x of extra) add({ name: x.name, kind: x.kind ?? "buffer" });
  return out;
}

// The form with its lines rebuilt: the listed lines first (their amounts kept when the form already had a line of that name, as when a newer plan starts from
// the current one), then any line of the form's own that is not listed (marked custom: it keeps a name box). Blank lines are dropped.
export function withListedLines(form, lines) {
  const old = new Map();
  for (let i = 0; i < (form.count ?? 0); i++) if (!blankLine(form, i)) old.set(lower(form["n" + i]), i);
  const f = Object.fromEntries(Object.entries(form).filter(([k]) => !/^[nkabc]\d+$/.test(k)));
  let i = 0;
  const put = (name, kind, from, custom) => { f["n" + i] = name; f["k" + i] = kind; f["a" + i] = from === undefined ? "" : form["a" + from] ?? ""; f["b" + i] = from === undefined ? "" : form["b" + from] ?? ""; f["c" + i] = custom; i++; };
  for (const l of lines) { const from = old.get(lower(l.name)); old.delete(lower(l.name)); put(l.name, l.kind, from, false); }
  for (const [, from] of old) put(form["n" + from] ?? "", form["k" + from] ?? "expense", from, true);
  f.count = Math.min(i, MAX_FORM_LINES);
  return f;
}

// A suggestion for each line of the form, from the owner's own history, for the paydays the form describes.
//  pay:     what each payday has brought in, from the payslips (median of the last 3 of that payday, overtime left out), or null when there is none yet.
//  income:  what the suggestion was built on: the pay typed in the form, else the payslip figure. Without one for every payday there is no suggestion.
//  rows:    {lower-case line name: {first, second}} in centavos; the amounts of a scheduled payment go on its category's line.
//  extras:  lines the engine adds that are not a category or goal (the overrun buffer): [{name, kind}].
// Nothing here is stored. `settings` is the ledger's settings (suggest_settings, bucket_overrides, goal_monthly and so on).
export function planFormSuggestion(state, f, { today, settings = {} }) {
  const day = (v) => (String(v).trim().toLowerCase() === "last" ? "last" : Number(v));
  const d1 = day(f.d1), d2 = day(f.d2);
  if (!Number.isInteger(d1) || d1 < 1 || d1 > 28) return { ok: false, pay: null, message: "Type the payday day first (1 to 28)." };
  if (f.twice && !(d2 === "last" || (Number.isInteger(d2) && d2 > d1 && d2 <= 28))) return { ok: false, pay: null, message: "Type the 2nd payday as a day after the first, or last." };
  const paydays = [{ id: "first", label: f.twice ? "1st payday" : "Payday", day: d1 }, ...(f.twice ? [{ id: "second", label: "2nd payday", day: d2 }] : [])];
  const month = monthOf(today), scheduled = suggestInputs(state, today), { buckets, withTargets } = engineSettings(state, settings.suggest_settings, settings.bucket_overrides ?? {}, settings.bucket_targets);
  const run = (income, rent = settings.starter_rent ?? undefined) => suggestPlan({ state, paydays, income, today, month, settings: withTargets, scheduled, rent, buckets, goalPins: settings.goal_monthly ?? {}, goalShares: settings.goal_shares ?? {} });
  const slips = run(undefined, 0);   // only to read what each payday has brought in: rent plays no part in that, so it never stops this step
  if (!slips.ok && slips.code !== "NO_PAYSLIPS") return { ok: false, pay: null, message: slips.message };
  const pay = slips.ok ? slips.paydays.map((p) => p.income) : null;
  const typed = [peso(f.p1), f.twice ? peso(f.p2) : 0].map((x) => (Number.isNaN(x) ? 0 : x));
  const income = paydays.map((_, i) => (typed[i] > 0 ? typed[i] : pay?.[i] ?? 0));
  if (income.some((x) => !(x > 0))) return { ok: false, pay, message: "Add a payslip for each payday, or type what each one brings in, to see suggestions." };
  const r = run(income);
  if (!r.ok) return { ok: false, pay, message: r.code === "NEEDS_RENT" ? "Suggestions need your monthly rent first: tap Suggest a budget on Budget and type it once." : r.message };
  const forCategory = new Map(scheduled.map((x) => [lower(x.name), x.category_id])), names = new Map((state.categories ?? []).map((c) => [c.id, lower(c.name)]));
  const rows = {}, extras = [], listed = new Set(planFormLines(state).map((l) => lower(l.name)));
  // a payday's list leaves out the lines that come to nothing on it, so the two lists are matched by name, never by position
  const seen = new Map();
  r.paydays.forEach((p, i) => { for (const l of p.lines) { const e = seen.get(lower(l.name)) ?? { name: l.name, kind: l.kind, amounts: [0, 0] }; e.amounts[i] += l.amount; seen.set(lower(l.name), e); } });
  for (const [k, e] of seen) {
    let key = k;
    if (!listed.has(k) && e.kind === "buffer") extras.push({ name: e.name, kind: "buffer" });
    else if (!listed.has(k)) key = names.get(forCategory.get(k)) ?? null;   // a scheduled payment sits on its category's line
    if (!key) continue;
    const row = rows[key] ?? (rows[key] = { first: 0, second: 0 });
    row.first += e.amounts[0]; row.second += e.amounts[1];
  }
  for (const row of Object.values(rows)) { row.first = toNearest50(row.first); row.second = toNearest50(row.second); }   // rounded to the nearest P50, like the Budget suggestion
  return { ok: true, pay, income, rows, extras };
}
