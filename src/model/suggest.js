// The suggestion engine: from what the ledger already holds, a SUGGESTED pay plan for one month. Pure functions, no screen, nothing stored.
//
// What it reuses (and never recomputes): payslip nets with overtime split out (income.js netPerPayday), verified spending per category
// (reports.js spendingByCategory), goals and their monthly need (goals.js), the two paydays and date rules (plan.js), roles on categories.
// The savings ratchet and scheduled payments are INPUTS: the ratchet's current amount is passed in, and scheduled payments and installments
// arrive as a list (their stored model comes later; subscriptions are read from state.subscriptions).
//
// Output per payday: lines [{name, kind, first/second amount, reason, source}] plus `unallocated` (income left over) or `short` (lines are more
// than the income). The books always balance exactly, in centavos:  lines + unallocated - short = income.  No line is ever cut to fit.
import { netPerPayday } from "./income.js";
import { spendingByCategory, addMonths, monthOf } from "./reports.js";
import { goalProgress, requiredPerMonth } from "./goals.js";
import { UNLOGGED_CATEGORY_ID } from "./seed.js";
import { dim, dayIn } from "./plan.js";
import { resolveSettings } from "./suggest-settings.js";

export const NO_PAYSLIP_MESSAGE = "Add a payslip first";
const LOOKBACK_MONTHS = 12, MAX_MONTHS = 6, MAX_NETS = 3;
const bad = (message) => ({ ok: false, code: "BAD_INPUT", message });
const whole = (n) => Number.isSafeInteger(n) && n >= 0;
const pct = (bps) => String(bps / 100) + "%";
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

// Middle value of whole numbers. With an even count the two middle values are different, so `side` picks one real value (never an average that
// would need rounding): "low" for income (do not plan on more pay than usually arrives), "high" for spending (do not plan on less than usually goes out).
export function median(values, side = "high") {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b), n = v.length;
  return n % 2 ? v[(n - 1) / 2] : v[side === "low" ? n / 2 - 1 : n / 2];
}

// Splits `total` by weights so the two parts add back to it exactly: the first part rounds down, the second takes the rest.
const splitBy = (total, w1, w2) => { if (w1 + w2 <= 0) return [total, 0]; const a = Math.floor((total * w1) / (w1 + w2)); return [a, total - a]; };

// The paydays of a month: the day each falls on, and how many days each covers. 15 days and 16 days, never two halves.
export function paydayDays(paydays, month) {
  const [y, m] = month.split("-").map(Number);
  if (paydays.length === 1) return { d1: 1, d2: 99, days1: dim(y, m), days2: 0 };   // monthly pay: the one payday covers the whole month
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const d1 = dayIn(paydays[0].day, y, m), d2 = dayIn(paydays[1].day, y, m);
  return { d1, d2, days1: d2 - d1, days2: dim(y, m) - d2 + dayIn(paydays[0].day, ny, nm) };
}

// Which payday (0 or 1) a date's day-of-month is closest to; used to tell a payslip of the first payday from one of the second.
function nearestPayday(paydays, date) {
  if (paydays.length === 1) return 0;
  const [y, m, d] = date.split("-").map(Number), ds = paydays.map((p) => dayIn(p.day, y, m));
  const dist = (a) => { const x = Math.abs(a - d); return Math.min(x, 31 - x); };
  return dist(ds[0]) <= dist(ds[1]) ? 0 : 1;
}

// Months that can be learned from: completed, with enough verified entries, and with Unlogged below its share. Newest first, up to 6.
export function usableMonths(state, { month, today, settings }) {
  const out = [], expense = new Set(state.categories.filter((c) => c.kind === "expense").map((c) => c.id));
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  let m = addMonths(month, -1);
  if (m >= monthOf(today)) m = addMonths(monthOf(today), -1);   // this month is not finished, so it teaches nothing yet
  for (let i = 0; i < LOOKBACK_MONTHS && out.length < MAX_MONTHS; i++, m = addMonths(m, -1)) {
    const by = spendingByCategory(state, { month: m });
    const unlogged = by.rows.filter((r) => r.category_id === UNLOGGED_CATEGORY_ID).reduce((n, r) => n + r.amount, 0);
    const logged = by.rows.filter((r) => r.category_id !== UNLOGGED_CATEGORY_ID).reduce((n, r) => n + r.amount, 0);
    const txs = new Set();
    for (const e of state.entries) {
      if (e.category_id == null || !expense.has(e.category_id) || e.category_id === UNLOGGED_CATEGORY_ID) continue;
      const t = txById.get(e.transaction_id);
      if (t && t.status === "verified" && t.date.startsWith(m + "-")) txs.add(t.id);
    }
    const all = logged + Math.max(0, unlogged);
    const enough = txs.size >= settings.min_entries, tidy = all > 0 && Math.max(0, unlogged) * 10000 < settings.max_unlogged_bps * all;
    if (enough && tidy) out.push({ month: m, by });
  }
  return out;
}

// suggestPlan({ state, plan?, paydays?, today, month, settings?, scheduled?, pinned?, ratchet? })
//   paydays: [{id?, label?, day: 1-31 | "last"}] one (monthly pay) or two (default: the plan's paydays)   month: "YYYY-MM", the month being planned
//   income: [centavos per payday] to use instead of the payslip medians (an owner-typed or plan figure); then no payslip is needed
//   scheduled: [{name, kind: "scheduled" | "installment", amount, day, months_left?, category_id?}]   (category_id: the spending category it is paid
//     under, so it is taken out of that category's median instead of being counted twice)
//   pinned: [{name, first, second, kind?}]   the owner's own lines; never changed, the difference from the suggestion is returned
//   ratchet: {amount}   this month's savings-ratchet amount, which then owns the savings
export function suggestPlan(input) {
  const { state, today, month } = input, scheduled = input.scheduled ?? [], pinned = input.pinned ?? [];
  const cfg = resolveSettings(input.settings);
  if (!cfg.ok) return bad(cfg.message);
  const S = cfg.settings;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(today ?? "")) return bad("Give the month as 2026-10 and today as 2026-10-05.");
  const paydays = (input.paydays ?? input.plan?.paydays)?.slice(0, 2);
  if (!paydays || paydays.length < 1) return bad("Choose your paydays first.");
  if (input.income !== undefined && (!Array.isArray(input.income) || input.income.length !== paydays.length || !input.income.every(whole))) return bad("The income figures must be whole centavos, one per payday.");
  for (const x of scheduled) if (!whole(x.amount) || (x.months_left != null && !whole(x.months_left))) return bad(`The amount for ${x.name} must be whole centavos.`);
  for (const x of pinned) if (!whole(x.first) || !whole(x.second)) return bad(`The pinned amounts for ${x.name} must be whole centavos.`);
  if (input.ratchet && !whole(input.ratchet.amount)) return bad("The ratchet amount must be whole centavos.");

  // 1. Income of each payday: median of the last 3 base nets (overtime out) of that payday.
  const slips = netPerPayday(state);
  if (!slips.length && !input.income) return { ok: false, code: "NO_PAYSLIPS", message: NO_PAYSLIP_MESSAGE };
  const nets = paydays.map(() => []);
  for (const r of slips) nets[nearestPayday(paydays, r.date)].push(r.base);   // oldest first
  const income = input.income ? [...input.income] : nets.map((list) => median(list.slice(-MAX_NETS), "low"));
  const incomeOf = (i) => (input.income ? "Your base income figure." : nets[i].length ? `Median of the last ${plural(Math.min(MAX_NETS, nets[i].length), "payslip", "payslips")}, overtime left out.` : "No payslip for this payday yet.");
  const monthIncome = income.reduce((a, b) => a + b, 0), inc1 = income[1] ?? 0;
  const { days1, days2, d1, d2 } = paydayDays(paydays, month);
  const payOfDay = (day) => (paydays.length === 1 || (day >= d1 && day < d2) ? 0 : 1);

  const lines = new Map();   // name (lower case) -> {name, kind, amounts: [first, second], reason, source}
  const put = (name, kind, amounts, reason, source, category_id) => lines.set(name.trim().toLowerCase(), { name, kind, first: amounts[0], second: amounts[1], reason, source, ...(category_id ? { category_id } : {}) });
  const fixedAt = (name, kind, total, day, reason, source, category_id) => put(name, kind, payOfDay(day) === 0 ? [total, 0] : [0, total], reason, source, category_id);

  // 2. What history can teach: usable months, and each category's amount in each of them.
  const months = usableMonths(state, { month, today, settings: S });
  const learn = months.length >= 2;
  const cats = state.categories.filter((c) => c.kind === "expense" && c.id !== UNLOGGED_CATEGORY_ID);
  const monthly = (id) => months.map((u) => Math.max(0, u.by.rows.filter((r) => r.category_id === id).reduce((n, r) => n + r.amount, 0)));
  const subs = state.subscriptions ?? [];
  const NEEDS = new Set(["rent", "essentials", "food"]);

  // 3. Fixed first: subscriptions, scheduled payments and installments, placed on the payday their due day falls in.
  let fixedNeeds = 0, fixedWants = 0;
  for (const s of subs) {
    if (!whole(s.amount)) return bad(`The amount for ${s.name} must be whole centavos.`);
    fixedAt(s.name, "expense", s.amount, s.renewal_day, `Renews on day ${s.renewal_day}, so it is set aside on payday ${payOfDay(s.renewal_day) + 1}.`, "history");
    fixedWants += s.amount;
  }
  for (const x of scheduled) {
    if (x.months_left === 0) continue;
    const left = x.kind === "installment" && x.months_left != null ? ` ${plural(x.months_left, "payment", "payments")} left.` : "";
    fixedAt(x.name, "expense", x.amount, x.day, `${x.kind === "installment" ? "Installment" : "Scheduled payment"} due on day ${x.day}, so it is set aside on payday ${payOfDay(x.day) + 1}.${left}`, "history");
    fixedNeeds += x.amount;
  }
  // Rent is fixed too, once there is history to learn its amount and its usual day from.
  const rentCat = cats.find((c) => c.role === "rent");
  if (learn && rentCat) {
    const total = median(monthly(rentCat.id));
    const txById = new Map(state.transactions.map((t) => [t.id, t]));
    const days = state.entries.filter((e) => e.category_id === rentCat.id && e.amount > 0).map((e) => txById.get(e.transaction_id))
      .filter((t) => t && t.status === "verified" && months.some((u) => t.date.startsWith(u.month + "-"))).map((t) => Number(t.date.slice(8)));
    const day = days.length ? median(days, "low") : d1;
    if (total > 0) { fixedAt(rentCat.name, "expense", total, day, `Median of the last ${plural(months.length, "usable month", "usable months")}, usually paid around day ${day}, so it is set aside on payday ${payOfDay(day) + 1}.`, "history", rentCat.id); fixedNeeds += total; }
  }

  // 4. Spending lines. With 2 or more usable months: median of each category. Otherwise a starter share of pay, marked "starter".
  const schedulerCat = new Map();
  for (const x of scheduled) if (x.category_id && x.months_left !== 0) schedulerCat.set(x.category_id, (schedulerCat.get(x.category_id) ?? 0) + x.amount);
  const skip = (c) => lines.has(c.name.trim().toLowerCase()) || (c.role === "subscription" && subs.length > 0);
  const spendCats = cats.filter((c) => !skip(c));
  const split = (total, name, kind, reason, source, category_id) => put(name, kind, splitBy(total, days1, days2), reason, source, category_id);
  if (learn) {
    for (const c of spendCats) {
      const total = Math.max(0, median(monthly(c.id)) - (schedulerCat.get(c.id) ?? 0));
      split(total, c.name, "expense", `Median of the last ${plural(months.length, "usable month", "usable months")}${schedulerCat.has(c.id) ? ", after its scheduled payments" : ""}, split by days covered (${days1} and ${days2} days).`, "history", c.id);
    }
  } else {
    const groups = [["needs", spendCats.filter((c) => NEEDS.has(c.role)), Math.max(0, Math.floor((monthIncome * S.starter.needs) / 10000) - fixedNeeds)],
      ["wants", spendCats.filter((c) => !NEEDS.has(c.role)), Math.max(0, Math.floor((monthIncome * S.starter.wants) / 10000) - fixedWants)]];
    for (const [group, list, pool] of groups) {
      const reason = `Starter share, a common rule of thumb and not advice: ${pct(S.starter[group])} of pay for ${group}, split evenly across ${plural(Math.max(1, list.length), "line", "lines")} and by days covered.`;
      if (!list.length) { if (pool > 0) split(pool, group === "needs" ? "Needs" : "Wants", "expense", reason, "starter"); continue; }
      const each = Math.floor(pool / list.length);
      list.forEach((c, i) => split(i === list.length - 1 ? pool - each * (list.length - 1) : each, c.name, "expense", reason, "starter", c.id));
    }
  }

  // 5. Pinned lines are the owner's: they replace the suggestion and are never changed. The difference is returned.
  const differences = [];
  const applyPins = () => {
    for (const p of pinned) {
      const found = [...lines.entries()].find(([k, l]) => (p.category_id ? l.category_id === p.category_id : k === p.name.trim().toLowerCase()));
      const key = found ? found[0] : p.name.trim().toLowerCase(), was = found?.[1];
      if (was?.pinned) continue;
      differences.push({ name: was?.name ?? p.name, ...(was?.category_id || p.category_id ? { category_id: was?.category_id ?? p.category_id } : {}), pinned: { first: p.first, second: p.second }, suggested: was ? { first: was.first, second: was.second } : null, difference: was ? { first: p.first - was.first, second: p.second - was.second } : null });
      lines.set(key, { name: was?.name ?? p.name, kind: p.kind ?? was?.kind ?? "expense", first: p.first, second: p.second, reason: "Pinned by you, so it is not changed.", source: was?.source ?? "history", pinned: true, ...(was?.category_id || p.category_id ? { category_id: was?.category_id ?? p.category_id } : {}) });
    }
  };
  applyPins();

  // 6. The overrun buffer (a setting; the starter share of pay when none is set), then savings.
  const total = (k) => [...lines.values()].reduce((n, l) => n + l[k], 0);
  const spentSoFar = () => total("first") + total("second");
  const bufferMonthly = S.buffer_amount ?? Math.floor((monthIncome * S.starter.buffer) / 10000);
  const bufferName = "Overrun buffer";
  if (!lines.has(bufferName.toLowerCase())) { const [a, b] = splitBy(bufferMonthly, income[0], inc1); put(bufferName, "buffer", [a, b], S.buffer_amount !== null ? "Your overrun buffer setting, split by what each payday brings in." : `Starter share, a common rule of thumb and not advice: ${pct(S.starter.buffer)} of pay, split by what each payday brings in.`, S.buffer_amount !== null ? "history" : "starter"); }
  const bufferNow = lines.get(bufferName.toLowerCase());
  const costs = spentSoFar();   // everything but savings, with the pins in
  let saving, why;
  if (input.ratchet) { saving = input.ratchet.amount; why = "From your savings ratchet, which owns this amount."; }
  else {
    const room = monthIncome - costs, want = Math.floor((monthIncome * S.starter.savings) / 10000);
    saving = Math.max(S.savings_floor, Math.min(want, room));
    why = saving === S.savings_floor && S.savings_floor > Math.min(want, room) ? "Your savings floor; there is not enough room for more." : `A cautious start: what is left after your costs, up to ${pct(S.starter.savings)} of pay (a rule of thumb), never below your savings floor.`;
  }
  const emergency = (state.goals ?? []).find((g) => g.role === "emergency");
  const open = [...(state.goals ?? [])].sort((a, b) => (b === emergency) - (a === emergency)).map((g) => ({ g, p: goalProgress(state, g) })).filter((x) => x.p && !x.p.reached);
  let left = saving;
  const parts = [];
  for (const { g, p } of open) {
    const need = g.deadline ? requiredPerMonth(p, g.deadline.slice(0, 7), month) : null;
    if (need && left > 0) { const give = Math.min(need.perMonth, left); parts.push({ name: g.name, amount: give, reason: `${why} Sized to reach its deadline.` }); left -= give; }
  }
  if (left > 0 || !parts.length) {
    const first = open[0]?.g.name ?? "Savings";
    const hit = parts.find((x) => x.name === first);
    if (hit) { hit.amount += left; } else parts.push({ name: first, amount: left, reason: why });
  }
  for (const part of parts) { const [a, b] = splitBy(part.amount, income[0], inc1); put(part.name, "goal", [a, b], part.reason, input.ratchet || learn ? "history" : "starter"); }
  applyPins();

  // 7. Per payday: the lines, and the exact gap to the income. Nothing is cut.
  const rows = [...lines.values()];
  const out = paydays.map((p, i) => {
    const key = i === 0 ? "first" : "second", list = rows.map((l) => ({ name: l.name, kind: l.kind, amount: l[key], reason: l.reason, source: l.source, ...(l.category_id ? { category_id: l.category_id } : {}), ...(l.pinned ? { pinned: true } : {}) })).filter((l) => l.amount > 0 || l.pinned);
    const sum = list.reduce((n, l) => n + l.amount, 0);
    return { id: p.id ?? (i === 0 ? "first" : "second"), label: p.label ?? (i === 0 ? "1st payday" : "2nd payday"), day: p.day, income: income[i], incomeReason: incomeOf(i), lines: list, total: sum, unallocated: Math.max(0, income[i] - sum), short: Math.max(0, sum - income[i]) };
  });
  return { ok: true, month, paydays: out, differences, history: { usableMonths: months.length, used: learn ? "history" : "starter" }, daysCovered: [days1, days2], settings: S };
}
