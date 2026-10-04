// Income: where every peso of pay comes from. A payslip is copied from paper as lines (earnings and deductions). The app
// COMPARES what is printed with what the lines add up to and with what really arrived, and says so; it never corrects anything.
// Only plain facts are kept: no employee id, tax id or account number. Pure functions over the state.
import { validateShape } from "./schema.js";
import { isPhDate, phTimestamp } from "./util.js";
import { checkTransactionSave } from "./index.js";
import { planOvertimeTransfer, splitOvertime } from "./goals.js";
import { wordsToCentavos } from "./scan.js";
import { monthOf } from "./reports.js";

export const EARNINGS = [["basic", "Basic salary"], ["rice", "Rice subsidy"], ["skills", "Skills allowance"], ["clothing", "Clothing allowance"],
  ["transport", "Transportation allowance"], ["overtime", "Overtime"], ["thirteenth", "13th month"], ["bonus", "Bonus"], ["other", "Other earnings"]];
export const DEDUCTIONS = [["tax", "Withholding tax"], ["sss", "SSS"], ["philhealth", "PhilHealth"], ["pagibig", "Pag-IBIG"],
  ["absences", "Absences"], ["lates", "Lates / undertime"], ["loan", "Loans"], ["other", "Other deductions"]];
export const GOVERNMENT = ["tax", "sss", "philhealth", "pagibig"];   // what went to government
export const LOST = ["absences", "lates"];   // pay lost to missed time
export const OVERTIME_SHARE = { num: 3, den: 5 };   // 60% of overtime goes to the Emergency Fund, 40% is free to spend

const peso = (c) => "₱" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sum = (rows) => rows.reduce((n, r) => n + r.amount, 0);
const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }], state: undefined });

export const linesOf = (state, payslipId) => (state.payslipLines ?? []).filter((l) => l.payslip_id === payslipId);
export const payslipTotals = (lines) => {
  const earn = lines.filter((l) => l.side === "earning"), ded = lines.filter((l) => l.side === "deduction");
  const gross = sum(earn), deductions = sum(ded), overtime = sum(earn.filter((l) => l.kind === "overtime"));
  return { gross, deductions, net: gross - deductions, overtime, base: gross - overtime };
};

// The four checks. Each returns a flag in plain words when something does not match; nothing is changed.
export function payslipChecks(payslip, lines) {
  const t = payslipTotals(lines), flags = [];
  if (payslip.printed_gross !== t.gross) {
    const noOvertime = t.overtime > 0 && payslip.printed_gross === t.gross - t.overtime;
    flags.push({ code: "GROSS", message: noOvertime
      ? `The printed gross ${peso(payslip.printed_gross)} leaves out the overtime ${peso(t.overtime)}. All earnings add to ${peso(t.gross)}.`
      : `The printed gross is ${peso(payslip.printed_gross)} but the earnings lines add to ${peso(t.gross)}.` });
  }
  if (payslip.printed_net !== t.net) flags.push({ code: "NET", message: `The printed net is ${peso(payslip.printed_net)} but gross minus deductions is ${peso(t.net)}.` });
  if (payslip.deposit !== payslip.printed_net) flags.push({ code: "DEPOSIT", message: `The account received ${peso(payslip.deposit)} but the payslip says net ${peso(payslip.printed_net)}.` });
  if (payslip.net_words) {
    const w = wordsToCentavos(payslip.net_words);
    if (w === null) flags.push({ code: "WORDS", message: "I could not read the amount in words." });
    else if (w !== payslip.printed_net) flags.push({ code: "WORDS", message: `The words say ${peso(w)} but the figures say ${peso(payslip.printed_net)}.` });
  }
  return flags;
}

// Saves a payslip and the pay it brought: ONE verified entry for what arrived (copying a figure off paper is itself the
// careful look), split between the Overtime and Salary income categories so the Income screen can show them apart.
// input: {id, transaction_id, employer, period_from, period_to, pay_date, account_id, printed_gross, printed_net, deposit,
//         net_words?, earnings:[{kind, amount, earned_month?}], deductions:[{kind, amount}]}
// Flags never block saving: a payslip that does not add up is exactly what the owner wants to record and see.
export function planPayslip(state, input, now = new Date()) {
  const employer = (input.employer ?? "").trim();
  if (!employer) return fail("BAD_EMPLOYER", "give the employer's name");
  if (!isPhDate(input.pay_date) || !isPhDate(input.period_from) || !isPhDate(input.period_to)) return fail("BAD_DATE", "dates must be like 2026-10-15");
  const account = state.accounts.find((a) => a.id === input.account_id);
  if (!account || account.class !== "asset") return fail("UNKNOWN_ACCOUNT", "choose the account the pay landed in");
  if ((state.payslips ?? []).some((p) => p.id === input.id)) return fail("DUPLICATE_ID", "that payslip is already saved");
  // The same payslip scanned or typed twice would be counted twice: same period and same net pay means it is already here.
  if ((state.payslips ?? []).some((p) => p.period_from === input.period_from && p.period_to === input.period_to && p.deposit === input.deposit)) return fail("DUPLICATE_PAYSLIP", "Duplicate payslip: you already saved one for " + input.period_from + " to " + input.period_to + " with the same net pay (" + peso(input.deposit) + "). To fix it, open it in Income, Payslips and use Change this payslip. If this is a different payslip, change its dates or net pay.");
  if (!(input.earnings ?? []).length) return fail("NO_EARNINGS", "add at least one earnings line");
  const cats = new Map(state.categories.map((c) => [c.id, c]));
  if (cats.get("cat-salary")?.kind !== "income" || cats.get("cat-overtime")?.kind !== "income") return fail("NO_CATEGORY", "the Salary and Overtime income categories are missing");

  const lines = [
    ...input.earnings.map((l) => ({ payslip_id: input.id, side: "earning", kind: l.kind, amount: l.amount, ...(l.kind === "overtime" ? { earned_month: l.earned_month } : {}) })),
    ...(input.deductions ?? []).map((l) => ({ payslip_id: input.id, side: "deduction", kind: l.kind, amount: l.amount })),
  ];
  const payslip = { id: input.id, employer, period_from: input.period_from, period_to: input.period_to, pay_date: input.pay_date, account_id: account.id,
    transaction_id: input.transaction_id, printed_gross: input.printed_gross, printed_net: input.printed_net, deposit: input.deposit,
    ...(input.net_words ? { net_words: input.net_words } : {}) };
  for (const row of lines) { const v = validateShape("PayslipLine", row); if (v.length) return fail("BAD_LINE", v[0].message); }
  const bad = validateShape("Payslip", payslip);
  if (bad.length) return fail("BAD_PAYSLIP", bad[0].message ?? "the payslip is not complete");

  const stamp = phTimestamp(now), t = payslipTotals(lines);
  const overtime = Math.min(t.overtime, input.deposit);
  const transaction = { id: input.transaction_id, date: input.pay_date, payee: employer, memo: "Payslip " + input.period_from + " to " + input.period_to, status: "verified", source: "manual", created_at: stamp, verified_at: stamp };
  const entries = [
    { transaction_id: transaction.id, account_id: account.id, amount: input.deposit },
    ...(overtime > 0 ? [{ transaction_id: transaction.id, category_id: "cat-overtime", amount: -overtime }] : []),
    ...(input.deposit - overtime > 0 ? [{ transaction_id: transaction.id, category_id: "cat-salary", amount: -(input.deposit - overtime) }] : []),
  ];
  const result = checkTransactionSave(state, { transaction, entries });
  if (!result.ok) return { ok: false, violations: result.violations, state: undefined };
  return {
    ok: true, violations: result.violations, flags: payslipChecks(payslip, lines), payslip, lines, transaction, entries,
    state: { ...state, transactions: [...state.transactions, transaction], entries: [...state.entries, ...entries], payslips: [...(state.payslips ?? []), payslip], payslipLines: [...(state.payslipLines ?? []), ...lines] },
  };
}

// A payslip with overtime: 60% goes to the Emergency Fund as a DRAFT transfer for Verify (the other 40% stays free to spend).
// input: {transaction_id, emergency_account_id}. Returns null when the payslip has no overtime.
export function overtimeDraft(state, payslipId, input, now = new Date()) {
  const p = (state.payslips ?? []).find((x) => x.id === payslipId);
  if (!p) return fail("UNKNOWN_PAYSLIP", "no payslip " + payslipId);
  const overtime = payslipTotals(linesOf(state, payslipId)).overtime;
  if (overtime <= 0) return null;
  return planOvertimeTransfer(state, { transaction_id: input.transaction_id, date: p.pay_date, overtime_amount: overtime, source_account_id: p.account_id, emergency_account_id: input.emergency_account_id, share: OVERTIME_SHARE }, now);
}

// The other 40% stays in the account where the pay landed unless the owner chooses somewhere else for it. Then it is
// a DRAFT transfer for Verify. input: {transaction_id, to_account_id}. Returns null when there is no overtime.
export function overtimeFreeDraft(state, payslipId, input, now = new Date()) {
  const p = (state.payslips ?? []).find((x) => x.id === payslipId);
  if (!p) return fail("UNKNOWN_PAYSLIP", "no payslip " + payslipId);
  const overtime = payslipTotals(linesOf(state, payslipId)).overtime;
  if (overtime <= 0) return null;
  if (input.to_account_id === p.account_id) return fail("SAME_ACCOUNT", "that is where the pay landed, so the money already stays there");
  const to = state.accounts.find((a) => a.id === input.to_account_id);
  if (!to || to.class !== "asset") return fail("UNKNOWN_ACCOUNT", "choose an account you hold money in");
  const { free } = splitOvertime(overtime, OVERTIME_SHARE);
  if (free <= 0) return null;
  const transaction = { id: input.transaction_id, date: p.pay_date, payee: "Overtime free to spend", memo: "", status: "draft", source: "template", created_at: phTimestamp(now) };
  const entries = [{ transaction_id: transaction.id, account_id: to.id, amount: free }, { transaction_id: transaction.id, account_id: p.account_id, amount: -free }];
  return { ...checkTransactionSave(state, { transaction, entries }), transaction, entries };
}

// ---------- the views ----------
// A payslip belongs to the month of the period it pays for, not the day it was received: "June 16-30" received on July 2 is June's.
export const slipDate = (p) => p.period_to || p.pay_date;
// A range for the views below: a year ("2026"), {from, to} dates, or null for everything.
const inRange = (range, p) => range === null || range === undefined ? true : typeof range === "string" ? slipDate(p).startsWith(range + "-") : slipDate(p) >= range.from && slipDate(p) <= range.to;
const SOURCE_OF = { "cat-salary": "base", "cat-overtime": "overtime", "cat-interest": "interest", "cat-refund": "refunds" };
export const SOURCES = [["base", "Base pay"], ["overtime", "Overtime"], ["interest", "Interest"], ["refunds", "Refunds"], ["other", "Other"]];

// Income by source for a month (YYYY-MM) or any range: everything verified that came in under an income category.
export function incomeBySource(state, { from, to }) {
  const income = new Set(state.categories.filter((c) => c.kind === "income").map((c) => c.id));
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const periodOf = new Map((state.payslips ?? []).map((p) => [p.transaction_id, slipDate(p)]));   // pay from a payslip counts on its period
  const out = { base: 0, overtime: 0, interest: 0, refunds: 0, other: 0 };
  for (const e of state.entries) {
    if (e.category_id == null || !income.has(e.category_id)) continue;
    const t = txById.get(e.transaction_id);
    const day = t ? periodOf.get(t.id) ?? t.date : null;
    if (!t || t.status !== "verified" || day < from || day > to) continue;
    out[SOURCE_OF[e.category_id] ?? "other"] -= e.amount;   // income is a credit, stored negative
  }
  return { ...out, total: Object.values(out).reduce((a, b) => a + b, 0) };
}
// The months of any range (clamped at its ends), each by source, plus the total for the whole range.
export function incomeMonths(state, { from, to }) {
  const months = [];
  for (let m = monthOf(from); m <= monthOf(to); m = monthOf(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 1)).toISOString().slice(0, 10))) {
    const a = m + "-01" > from ? m + "-01" : from, b = m + "-31" < to ? m + "-31" : to;
    months.push({ month: m, ...incomeBySource(state, { from: a, to: b }) });
  }
  return { months, ytd: incomeBySource(state, { from, to }) };
}
// Twelve months of one year, plus the year to date.
export function incomeByMonth(state, year) {
  const months = Array.from({ length: 12 }, (_, i) => { const m = `${year}-${String(i + 1).padStart(2, "0")}`; return { month: m, ...incomeBySource(state, { from: m + "-01", to: m + "-31" }) }; });
  return { months, ytd: incomeBySource(state, { from: year + "-01-01", to: year + "-12-31" }) };
}

// One row per payslip in the year, oldest first: what arrived, split into base and overtime.
export function netPerPayday(state, range) {
  return (state.payslips ?? []).filter((p) => inRange(range, p)).sort((a, b) => a.pay_date.localeCompare(b.pay_date) || a.id.localeCompare(b.id)).map((p) => {
    const t = payslipTotals(linesOf(state, p.id)), overtime = Math.min(t.overtime, p.deposit);
    return { payslip_id: p.id, date: p.pay_date, employer: p.employer, net: p.deposit, overtime, base: p.deposit - overtime };
  });
}

// Basic pay over time: each payslip's basic salary, and the change from the one before it.
// With a year, only that year's payslips are listed, but each change is still measured against the payslip before it (even from an earlier year).
export function raiseHistory(state, year = null) {
  const rows = (state.payslips ?? []).slice().sort((a, b) => a.pay_date.localeCompare(b.pay_date) || a.id.localeCompare(b.id))
    .map((p) => ({ date: p.pay_date, slip: slipDate(p), employer: p.employer, basic: sum(linesOf(state, p.id).filter((l) => l.side === "earning" && l.kind === "basic")) }))
    .filter((r) => r.basic > 0);
  return rows.map((r, i) => ({ ...r, change: i === 0 ? null : r.basic - rows[i - 1].basic, raised: i > 0 && r.basic > rows[i - 1].basic })).filter((r) => inRange(year, { period_to: r.slip }));
}

// Deductions by month of pay date and for the year to date: government (tax, SSS, PhilHealth, Pag-IBIG), pay lost (absences,
// lates), and loans.
export function deductionsByMonth(state, range) {
  const zero = () => ({ tax: 0, sss: 0, philhealth: 0, pagibig: 0, absences: 0, lates: 0, loan: 0, other: 0 });
  const by = new Map();
  for (const p of state.payslips ?? []) {
    if (!inRange(range, p)) continue;
    const m = by.get(monthOf(slipDate(p))) ?? zero();
    for (const l of linesOf(state, p.id)) if (l.side === "deduction") m[l.kind] += l.amount;
    by.set(monthOf(slipDate(p)), m);
  }
  const shape = (m) => ({ ...m, government: GOVERNMENT.reduce((n, k) => n + m[k], 0), lost: LOST.reduce((n, k) => n + m[k], 0), total: Object.keys(zero()).reduce((n, k) => n + m[k], 0) });   // total: every deduction line
  const months = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([month, m]) => ({ month, ...shape(m) }));
  const ytd = shape(months.reduce((acc, m) => { for (const k of Object.keys(zero())) acc[k] += m[k]; return acc; }, zero()));
  return { months, ytd };
}

// Employers in the order they were worked for: first and last pay date, and how many payslips.
export function employerHistory(state, range = null) {
  const by = new Map();
  for (const p of state.payslips ?? []) {
    if (!inRange(range, p)) continue;
    const e = by.get(p.employer) ?? { employer: p.employer, first: p.pay_date, last: p.pay_date, payslips: 0 };
    e.first = e.first < p.pay_date ? e.first : p.pay_date; e.last = e.last > p.pay_date ? e.last : p.pay_date; e.payslips += 1;
    by.set(p.employer, e);
  }
  return [...by.values()].sort((a, b) => a.first.localeCompare(b.first));
}

// Changes a saved payslip: the same figures a new one takes, saved over the old. The payslip and its pay keep their ids (so the photo stays
// with it) and are replaced together, so the ledger never holds half of the old and half of the new. An overtime transfer still waiting
// as a draft is dropped because its amount may have changed (make it again); a verified one stays, as when a payslip is removed.
// Returns what planPayslip returns, plus {draftsRemoved, photoIds} (picture files of removed drafts, for the caller to delete).
export function updatePayslip(state, id, input, now = new Date()) {
  const p = (state.payslips ?? []).find((x) => x.id === id);
  if (!p) return fail("UNKNOWN_PAYSLIP", "That payslip is no longer there.");
  const side = ["ot-" + id, "otf-" + id], drafts = new Set(state.transactions.filter((t) => side.includes(t.id) && t.status === "draft").map((t) => t.id));
  const gone = new Set([p.transaction_id, ...drafts]), dropped = new Set(drafts);
  const without = { ...state, payslips: state.payslips.filter((x) => x.id !== id), payslipLines: (state.payslipLines ?? []).filter((l) => l.payslip_id !== id),
    transactions: state.transactions.filter((t) => !gone.has(t.id)), entries: state.entries.filter((e) => !gone.has(e.transaction_id)),
    attachments: (state.attachments ?? []).filter((a) => !dropped.has(a.transaction_id)) };
  const old = state.transactions.find((t) => t.id === p.transaction_id);
  const r = planPayslip(without, { ...input, id, transaction_id: p.transaction_id }, now);
  if (!r.ok) return r;
  const transaction = old ? { ...r.transaction, created_at: old.created_at } : r.transaction;
  return { ...r, transaction, draftsRemoved: drafts.size, photoIds: (state.attachments ?? []).filter((a) => dropped.has(a.transaction_id)).map((a) => a.id),
    state: { ...r.state, transactions: r.state.transactions.map((t) => (t.id === transaction.id ? transaction : t)) } };
}

// Income that arrived WITHOUT a payslip behind it (a payslip photo once saved as plain "pay received", interest, a refund): verified entries
// under an income category, by the day they arrived, one row per transaction. They count in every Income total, so they are listed to be seen.
export function incomeWithoutPayslip(state, { from, to }) {
  const income = new Set(state.categories.filter((c) => c.kind === "income").map((c) => c.id));
  const slipTx = new Set((state.payslips ?? []).map((p) => p.transaction_id));
  const rows = [];
  for (const t of state.transactions) {
    if (t.status !== "verified" || slipTx.has(t.id) || t.date < from || t.date > to) continue;
    const mine = state.entries.filter((e) => e.transaction_id === t.id), amount = -mine.filter((e) => e.category_id != null && income.has(e.category_id)).reduce((n, e) => n + e.amount, 0);
    if (amount === 0) continue;
    rows.push({ transaction_id: t.id, date: t.date, payee: t.payee, amount, account_id: mine.find((e) => e.account_id != null)?.account_id ?? null });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.transaction_id.localeCompare(b.transaction_id));
}

// Removes one income entry that has no payslip (a stray or double one): the transaction, its entries and its photo link. The money also
// leaves the account it was added to. A payslip's own pay, or anything that is not plain income, is refused (use the payslip's Remove).
// Returns {ok, state, photoIds} or {ok: false, error}.
export function removeIncomeEntry(state, id) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return { ok: false, error: "That entry is no longer there." };
  if ((state.payslips ?? []).some((p) => p.transaction_id === id)) return { ok: false, error: "That is a payslip's pay. Remove the payslip instead." };
  const income = new Set(state.categories.filter((c) => c.kind === "income").map((c) => c.id)), mine = state.entries.filter((e) => e.transaction_id === id);
  if (!mine.some((e) => e.category_id != null && income.has(e.category_id)) || mine.some((e) => e.category_id != null && !income.has(e.category_id))) return { ok: false, error: "That is not a plain income entry." };
  return { ok: true, photoIds: (state.attachments ?? []).filter((a) => a.transaction_id === id).map((a) => a.id),
    state: { ...state, transactions: state.transactions.filter((x) => x.id !== id), entries: state.entries.filter((e) => e.transaction_id !== id), attachments: (state.attachments ?? []).filter((a) => a.transaction_id !== id) } };
}

// Removes a payslip: its lines, the pay it recorded (the transaction, its entries and its photo link), and any overtime transfer still
// waiting as a draft. An overtime transfer already verified stays (it is real money that moved); `keptTransfers` says how many.
// Returns {ok, state, photoIds, keptTransfers}; photoIds are the picture files the caller deletes.
export function deletePayslip(state, id) {
  const p = (state.payslips ?? []).find((x) => x.id === id);
  if (!p) return { ok: false, error: "That payslip is no longer there." };
  const side = ["ot-" + id, "otf-" + id], drafts = new Set(state.transactions.filter((t) => side.includes(t.id) && t.status === "draft").map((t) => t.id));
  const gone = new Set([p.transaction_id, ...drafts]);
  return {
    ok: true,
    photoIds: (state.attachments ?? []).filter((a) => gone.has(a.transaction_id)).map((a) => a.id),
    keptTransfers: state.transactions.filter((t) => side.includes(t.id) && t.status !== "draft").length,
    state: { ...state, payslips: state.payslips.filter((x) => x.id !== id), payslipLines: (state.payslipLines ?? []).filter((l) => l.payslip_id !== id),
      transactions: state.transactions.filter((t) => !gone.has(t.id)), entries: state.entries.filter((e) => !gone.has(e.transaction_id)), attachments: (state.attachments ?? []).filter((a) => !gone.has(a.transaction_id)) },
  };
}
