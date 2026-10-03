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
const SOURCE_OF = { "cat-salary": "base", "cat-overtime": "overtime", "cat-interest": "interest", "cat-refund": "refunds" };
export const SOURCES = [["base", "Base pay"], ["overtime", "Overtime"], ["interest", "Interest"], ["refunds", "Refunds"], ["other", "Other"]];

// Income by source for a month (YYYY-MM) or any range: everything verified that came in under an income category.
export function incomeBySource(state, { from, to }) {
  const income = new Set(state.categories.filter((c) => c.kind === "income").map((c) => c.id));
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const out = { base: 0, overtime: 0, interest: 0, refunds: 0, other: 0 };
  for (const e of state.entries) {
    if (e.category_id == null || !income.has(e.category_id)) continue;
    const t = txById.get(e.transaction_id);
    if (!t || t.status !== "verified" || t.date < from || t.date > to) continue;
    out[SOURCE_OF[e.category_id] ?? "other"] -= e.amount;   // income is a credit, stored negative
  }
  return { ...out, total: Object.values(out).reduce((a, b) => a + b, 0) };
}
// Twelve months of one year, plus the year to date.
export function incomeByMonth(state, year) {
  const months = Array.from({ length: 12 }, (_, i) => { const m = `${year}-${String(i + 1).padStart(2, "0")}`; return { month: m, ...incomeBySource(state, { from: m + "-01", to: m + "-31" }) }; });
  return { months, ytd: incomeBySource(state, { from: year + "-01-01", to: year + "-12-31" }) };
}

// One row per payslip in the year, oldest first: what arrived, split into base and overtime.
export function netPerPayday(state, year) {
  return (state.payslips ?? []).filter((p) => p.pay_date.startsWith(year + "-")).sort((a, b) => a.pay_date.localeCompare(b.pay_date) || a.id.localeCompare(b.id)).map((p) => {
    const t = payslipTotals(linesOf(state, p.id)), overtime = Math.min(t.overtime, p.deposit);
    return { payslip_id: p.id, date: p.pay_date, employer: p.employer, net: p.deposit, overtime, base: p.deposit - overtime };
  });
}

// Basic pay over time: each payslip's basic salary, and the change from the one before it.
export function raiseHistory(state) {
  const rows = (state.payslips ?? []).slice().sort((a, b) => a.pay_date.localeCompare(b.pay_date) || a.id.localeCompare(b.id))
    .map((p) => ({ date: p.pay_date, employer: p.employer, basic: sum(linesOf(state, p.id).filter((l) => l.side === "earning" && l.kind === "basic")) }))
    .filter((r) => r.basic > 0);
  return rows.map((r, i) => ({ ...r, change: i === 0 ? null : r.basic - rows[i - 1].basic, raised: i > 0 && r.basic > rows[i - 1].basic }));
}

// Deductions by month of pay date and for the year to date: government (tax, SSS, PhilHealth, Pag-IBIG), pay lost (absences,
// lates), and loans.
export function deductionsByMonth(state, year) {
  const zero = () => ({ tax: 0, sss: 0, philhealth: 0, pagibig: 0, absences: 0, lates: 0, loan: 0, other: 0 });
  const by = new Map();
  for (const p of state.payslips ?? []) {
    if (!p.pay_date.startsWith(year + "-")) continue;
    const m = by.get(monthOf(p.pay_date)) ?? zero();
    for (const l of linesOf(state, p.id)) if (l.side === "deduction") m[l.kind] += l.amount;
    by.set(monthOf(p.pay_date), m);
  }
  const shape = (m) => ({ ...m, government: GOVERNMENT.reduce((n, k) => n + m[k], 0), lost: LOST.reduce((n, k) => n + m[k], 0) });
  const months = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([month, m]) => ({ month, ...shape(m) }));
  const ytd = shape(months.reduce((acc, m) => { for (const k of Object.keys(zero())) acc[k] += m[k]; return acc; }, zero()));
  return { months, ytd };
}

// Employers in the order they were worked for: first and last pay date, and how many payslips.
export function employerHistory(state) {
  const by = new Map();
  for (const p of state.payslips ?? []) {
    const e = by.get(p.employer) ?? { employer: p.employer, first: p.pay_date, last: p.pay_date, payslips: 0 };
    e.first = e.first < p.pay_date ? e.first : p.pay_date; e.last = e.last > p.pay_date ? e.last : p.pay_date; e.payslips += 1;
    by.set(p.employer, e);
  }
  return [...by.values()].sort((a, b) => a.first.localeCompare(b.first));
}
