import { test } from "node:test";
import assert from "node:assert/strict";
import { planPayslip, payslipChecks, payslipTotals, linesOf, overtimeDraft, overtimeFreeDraft, incomeBySource, incomeByMonth, netPerPayday, raiseHistory, deductionsByMonth, employerHistory, incomeMonths, slipDate, deletePayslip, updatePayslip, payslipNotes, missingPayPeriods, samePeriodPayslips, markPayslipChecked, revisionChanges, revisionsOf, PAYSLIP_VERSION, planAttachment, incomeWithoutPayslip, removeIncomeEntry, planPayReceived,
  ensureIncomeCategories, validateState, applyDrafts } from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

const NOW = new Date("2026-10-16T04:00:00Z");   // every figure below is invented
function ledger() {
  const s = makeState();
  s.categories.push({ id: "cat-salary", name: "Salary", kind: "income" }, { id: "cat-overtime", name: "Overtime", kind: "income" });
  s.accounts.push(account({ id: "ef", name: "Test Emergency", class: "asset" }));
  return ensureIncomeCategories(s);
}
const base = (o = {}) => ({ id: "ps1", transaction_id: "tx-ps1", employer: "Sample Employer Inc", period_from: "2026-10-01", period_to: "2026-10-15", pay_date: "2026-10-15", account_id: "chk",
  printed_gross: 1000000, printed_net: 880000, deposit: 880000, earnings: [{ kind: "basic", amount: 900000 }, { kind: "rice", amount: 100000 }],
  deductions: [{ kind: "tax", amount: 70000 }, { kind: "sss", amount: 30000 }, { kind: "philhealth", amount: 10000 }, { kind: "pagibig", amount: 10000 }], ...o });

test("full deductions: gross minus deductions equals net to the centavo, no flags", () => {
  const r = planPayslip(ledger(), base(), NOW);
  assert.ok(r.ok, JSON.stringify(r.violations));
  const t = payslipTotals(r.lines);
  assert.equal(t.gross, 1000000); assert.equal(t.deductions, 120000); assert.equal(t.net, 880000);
  assert.deepEqual(r.flags, []);
  assert.deepEqual(validateState(r.state), []);
});
test("the pay is one verified entry for what arrived, split between Salary and Overtime", () => {
  const r = planPayslip(ledger(), base({ printed_gross: 1150000, printed_net: 1030000, deposit: 1030000, earnings: [{ kind: "basic", amount: 900000 }, { kind: "rice", amount: 100000 }, { kind: "overtime", amount: 150000, earned_month: "2026-09" }] }), NOW);
  assert.ok(r.ok);
  assert.equal(r.transaction.status, "verified");
  assert.equal(r.entries.reduce((n, e) => n + e.amount, 0), 0);
  assert.equal(r.entries.find((e) => e.category_id === "cat-overtime").amount, -150000);
  assert.equal(r.entries.find((e) => e.category_id === "cat-salary").amount, -880000);
  assert.deepEqual(r.flags, []);
});
test("overtime must reach gross: a printed gross that leaves it out is flagged, naming the overtime", () => {
  const r = planPayslip(ledger(), base({ printed_gross: 1000000, printed_net: 880000, deposit: 880000, earnings: [{ kind: "basic", amount: 900000 }, { kind: "rice", amount: 100000 }, { kind: "overtime", amount: 150000, earned_month: "2026-09" }] }), NOW);
  assert.ok(r.ok, "flags never block saving");
  const g = r.flags.find((f) => f.code === "GROSS");
  assert.match(g.message, /leaves out the overtime ₱1,500\.00/);
  assert.ok(r.flags.some((f) => f.code === "NET"), "net no longer equals gross minus deductions either");
});
test("each check flags, and none of them changes a figure", () => {
  const ps = (o) => { const r = planPayslip(ledger(), base(o), NOW); return r; };
  assert.deepEqual(ps({ printed_net: 870000, deposit: 870000 }).flags.map((f) => f.code), ["NET"]);
  assert.deepEqual(ps({ deposit: 875000 }).flags.map((f) => f.code), ["DEPOSIT"]);
  assert.deepEqual(ps({ net_words: "Eight thousand eight hundred pesos" }).flags.map((f) => f.code), []);
  assert.deepEqual(ps({ net_words: "Eight thousand seven hundred pesos" }).flags.map((f) => f.code), ["WORDS"]);
  const r = ps({ deposit: 875000 });
  assert.equal(r.payslip.deposit, 875000);   // the real deposit stays as typed
  assert.equal(r.entries[0].amount, 875000);
});
test("bad input is refused with a reason; a payslip is never saved twice", () => {
  const s = ledger();
  for (const [o, code] of [[{ employer: "  " }, "BAD_EMPLOYER"], [{ pay_date: "2026-13-01" }, "BAD_DATE"], [{ account_id: "card" }, "UNKNOWN_ACCOUNT"], [{ earnings: [] }, "NO_EARNINGS"],
    [{ earnings: [{ kind: "overtime", amount: 1000 }] }, "BAD_LINE"], [{ deductions: [{ kind: "basic", amount: 1000 }] }, "BAD_LINE"], [{ earnings: [{ kind: "basic", amount: 0 }] }, "BAD_LINE"]]) {
    const r = planPayslip(s, base(o), NOW);
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.equal(r.violations[0].code, code, JSON.stringify(o));
  }
  const once = planPayslip(s, base(), NOW);
  assert.equal(planPayslip(once.state, base({ transaction_id: "x" }), NOW).violations[0].code, "DUPLICATE_ID");
});
test("no tax id, employee id or account number can be stored on a payslip", () => {
  const r = planPayslip(ledger(), base(), NOW);
  assert.deepEqual(Object.keys(r.payslip).sort(), ["account_id", "deposit", "employer", "id", "pay_date", "period_from", "period_to", "printed_gross", "printed_net", "transaction_id", "version"]);
});
test("overtime on a payslip makes a draft: 60% to the Emergency Fund; none without overtime", () => {
  const s = planPayslip(ledger(), base({ printed_gross: 1150000, printed_net: 1030000, deposit: 1030000, earnings: [{ kind: "basic", amount: 900000 }, { kind: "rice", amount: 100000 }, { kind: "overtime", amount: 150000, earned_month: "2026-09" }] }), NOW).state;
  const d = overtimeDraft(s, "ps1", { transaction_id: "tx-ot", emergency_account_id: "ef" }, NOW);
  assert.ok(d.ok);
  assert.equal(d.transaction.status, "draft");
  assert.equal(d.entries.find((e) => e.account_id === "ef").amount, 90000);
  assert.equal(d.entries.find((e) => e.account_id === "chk").amount, -90000);
  assert.equal(overtimeDraft(planPayslip(ledger(), base(), NOW).state, "ps1", { transaction_id: "t", emergency_account_id: "ef" }, NOW), null);
});
test("income by source, by month and year to date, from verified entries only", () => {
  let s = planPayslip(ledger(), base({ printed_gross: 1150000, printed_net: 1030000, deposit: 1030000, earnings: [{ kind: "basic", amount: 900000 }, { kind: "rice", amount: 100000 }, { kind: "overtime", amount: 150000, earned_month: "2026-09" }] }), NOW).state;
  s = { ...s, transactions: [...s.transactions, { id: "i1", date: "2026-10-20", payee: "Bank", memo: "", status: "verified", source: "manual", created_at: "2026-10-20T00:00:00+08:00", verified_at: "2026-10-20T00:00:00+08:00" },
    { id: "i2", date: "2026-10-21", payee: "Draft", memo: "", status: "draft", source: "manual", created_at: "2026-10-21T00:00:00+08:00" }],
  entries: [...s.entries, { transaction_id: "i1", account_id: "chk", amount: 1234 }, { transaction_id: "i1", category_id: "cat-interest", amount: -1234 },
    { transaction_id: "i2", account_id: "chk", amount: 999 }, { transaction_id: "i2", category_id: "cat-refund", amount: -999 }] };
  const oct = incomeBySource(s, { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(oct, { base: 880000, overtime: 150000, interest: 1234, refunds: 0, other: 0, total: 1031234 });
  const y = incomeByMonth(s, "2026");
  assert.equal(y.months.length, 12);
  assert.equal(y.months[9].total, 1031234);
  assert.equal(y.months[0].total, 0);   // a month with no data is zero, never an error
  assert.equal(y.ytd.total, 1031234);
});
test("net per payday splits base and overtime; raises, deductions and employers are summarised", () => {
  let s = ledger();
  s = planPayslip(s, base({ id: "a", transaction_id: "ta", employer: "Old Employer", pay_date: "2025-12-15", period_from: "2025-12-01", period_to: "2025-12-15", printed_gross: 800000, printed_net: 700000, deposit: 700000,
    earnings: [{ kind: "basic", amount: 800000 }], deductions: [{ kind: "tax", amount: 60000 }, { kind: "absences", amount: 40000 }] }), NOW).state;
  s = planPayslip(s, base({ id: "b", transaction_id: "tb", pay_date: "2026-10-15" }), NOW).state;
  s = planPayslip(s, base({ id: "c", transaction_id: "tc", pay_date: "2026-10-30", period_from: "2026-10-16", period_to: "2026-10-30", printed_gross: 1100000, printed_net: 980000, deposit: 980000,
    earnings: [{ kind: "basic", amount: 1000000 }, { kind: "overtime", amount: 100000, earned_month: "2026-10" }] }), NOW).state;
  const pd = netPerPayday(s, "2026");
  assert.deepEqual(pd.map((r) => [r.base, r.overtime, r.net]), [[880000, 0, 880000], [880000, 100000, 980000]]);
  const raise = raiseHistory(s);
  assert.deepEqual(raise.map((r) => [r.basic, r.change, r.raised]), [[800000, null, false], [900000, 100000, true], [1000000, 100000, true]]);
  const dec = deductionsByMonth(s, "2025");
  assert.deepEqual([dec.ytd.government, dec.ytd.lost], [60000, 40000]);
  const d26 = deductionsByMonth(s, "2026");
  assert.equal(d26.months.length, 1);
  assert.equal(d26.months[0].government, 240000);
  assert.deepEqual(employerHistory(s).map((e) => [e.employer, e.payslips]), [["Old Employer", 1], ["Sample Employer Inc", 2]]);
});
test("a ledger from before the income categories existed gets the missing ones", () => {
  const s = ensureIncomeCategories({ ...makeState(), categories: [{ id: "cat-salary", name: "Salary", kind: "income" }] });
  assert.deepEqual(s.categories.map((c) => c.id).sort(), ["cat-interest", "cat-other-income", "cat-overtime", "cat-refund", "cat-salary"]);
  assert.equal(ensureIncomeCategories(s), s);
});

test("the free 40% stays put unless the owner picks where it goes; then it is a draft of exactly the remainder", () => {
  const s = planPayslip(ledger(), base({ printed_gross: 1150000, printed_net: 1030000, deposit: 1030000, earnings: [{ kind: "basic", amount: 900000 }, { kind: "rice", amount: 100000 }, { kind: "overtime", amount: 150000, earned_month: "2026-09" }] }), NOW).state;
  assert.equal(s.transactions.filter((t) => t.status === "draft").length, 0, "saving a payslip makes no second draft by itself");
  const d = overtimeFreeDraft(s, "ps1", { transaction_id: "tx-free", to_account_id: "ef" }, NOW);
  assert.ok(d.ok);
  assert.equal(d.transaction.status, "draft");
  assert.equal(d.entries.find((e) => e.account_id === "ef").amount, 60000);   // 150,000 less the 90,000 that goes to the Emergency Fund
  assert.equal(d.entries.find((e) => e.account_id === "chk").amount, -60000);
  const ef = overtimeDraft(s, "ps1", { transaction_id: "tx-ef", emergency_account_id: "ef" }, NOW);
  assert.equal(ef.entries[0].amount + d.entries[0].amount, 150000, "the two drafts add up to all of the overtime");
  assert.equal(overtimeFreeDraft(s, "ps1", { transaction_id: "x", to_account_id: "chk" }, NOW).violations[0].code, "SAME_ACCOUNT");
  assert.equal(overtimeFreeDraft(s, "ps1", { transaction_id: "x", to_account_id: "card" }, NOW).violations[0].code, "UNKNOWN_ACCOUNT");
  assert.equal(overtimeFreeDraft(planPayslip(ledger(), base(), NOW).state, "ps1", { transaction_id: "x", to_account_id: "ef" }, NOW), null);
});

test("looking at a year lists only that year's raises, employers and payslips, but a raise is still measured against the payslip before it", () => {
  let s = ledger();
  s = planPayslip(s, base({ id: "a", transaction_id: "ta", employer: "Old Employer", pay_date: "2025-12-15", period_from: "2025-12-01", period_to: "2025-12-15", printed_gross: 800000, printed_net: 800000, deposit: 800000, earnings: [{ kind: "basic", amount: 800000 }], deductions: [] }), NOW).state;
  s = planPayslip(s, base({ id: "b", transaction_id: "tb", pay_date: "2026-10-15" }), NOW).state;
  assert.deepEqual(raiseHistory(s, "2025").map((r) => [r.date, r.basic]), [["2025-12-15", 800000]]);
  assert.deepEqual(raiseHistory(s, "2026").map((r) => [r.date, r.basic, r.change, r.raised]), [["2026-10-15", 900000, 100000, true]], "the first payslip of 2026 is compared with December 2025");
  assert.deepEqual(raiseHistory(s, "2024"), []);
  assert.deepEqual(employerHistory(s, "2025").map((e) => e.employer), ["Old Employer"]);
  assert.deepEqual(employerHistory(s, "2026").map((e) => e.employer), ["Sample Employer Inc"]);
  assert.deepEqual(employerHistory(s, "2024"), []);
  assert.equal(employerHistory(s).length, 2, "with no year, all of them");
});

test("a payslip belongs to the month of the period it pays for, not the day it arrived", () => {
  let s = ledger();
  s = planPayslip(s, base({ id: "j", transaction_id: "tj", period_from: "2026-06-16", period_to: "2026-06-30", pay_date: "2026-07-02" }), NOW).state;
  s = planPayslip(s, base({ id: "k", transaction_id: "tk", period_from: "2026-07-01", period_to: "2026-07-15", pay_date: "2026-07-15" }), NOW).state;
  assert.equal(slipDate(s.payslips[0]), "2026-06-30");
  const m = Object.fromEntries(incomeMonths(s, { from: "2026-06-01", to: "2026-07-31" }).months.map((x) => [x.month, x.total]));
  assert.deepEqual(m, { "2026-06": 880000, "2026-07": 880000 }, "the July 2 payslip counts in June");
  assert.equal(incomeBySource(s, { from: "2026-06-01", to: "2026-06-30" }).total, 880000);
  assert.deepEqual(deductionsByMonth(s, { from: "2026-06-01", to: "2026-06-30" }).months.map((x) => x.month), ["2026-06"]);
  assert.deepEqual(employerHistory(s, { from: "2026-07-01", to: "2026-07-31" }).map((e) => e.payslips), [1]);
  assert.equal(netPerPayday(s, { from: "2026-06-01", to: "2026-06-30" }).length, 1);
});

test("incomeMonths clamps the first and last month to the range asked for", () => {
  let s = ledger();
  s = planPayslip(s, base({ id: "a", transaction_id: "ta", period_from: "2026-06-01", period_to: "2026-06-15", pay_date: "2026-06-15" }), NOW).state;
  s = planPayslip(s, base({ id: "b", transaction_id: "tb", period_from: "2026-06-16", period_to: "2026-06-30", pay_date: "2026-06-30" }), NOW).state;
  const r = incomeMonths(s, { from: "2026-06-20", to: "2026-06-30" });
  assert.deepEqual(r.months.map((x) => [x.month, x.total]), [["2026-06", 880000]]);
  assert.equal(r.ytd.total, 880000);
});

test("removing a payslip removes its lines, its pay, its photo link and draft overtime transfers, and the ledger stays valid", () => {
  let s = ledger();
  const r0 = planPayslip(s, base({ printed_gross: 1150000, printed_net: 1030000, deposit: 1030000, earnings: [{ kind: "basic", amount: 900000 }, { kind: "rice", amount: 100000 }, { kind: "overtime", amount: 150000, earned_month: "2026-09" }] }), NOW);
  s = r0.state;
  const ot = overtimeDraft(s, "ps1", { transaction_id: "ot-ps1", emergency_account_id: "ef" }, NOW);
  s = { ...s, transactions: [...s.transactions, ot.transaction], entries: [...s.entries, ...ot.entries], attachments: [{ id: "ph1", transaction_id: "tx-ps1", mime: "image/jpeg", created_at: "2026-10-16T12:00:00.000+08:00" }] };
  const d = deletePayslip(s, "ps1");
  assert.equal(d.ok, true);
  assert.deepEqual(d.photoIds, ["ph1"]);
  assert.equal(d.keptTransfers, 0);
  assert.equal(d.state.payslips.length, 0);
  assert.equal(d.state.payslipLines.length, 0);
  assert.equal(d.state.transactions.some((t) => t.id === "tx-ps1" || t.id === "ot-ps1"), false);
  assert.equal(d.state.entries.some((e) => e.transaction_id === "tx-ps1" || e.transaction_id === "ot-ps1"), false);
  assert.equal(incomeBySource(d.state, { from: "2026-10-01", to: "2026-10-31" }).total, 0);
  assert.deepEqual(validateState(d.state), []);
  assert.equal(deletePayslip(s, "nope").ok, false);
});

test("a verified overtime transfer stays when its payslip is removed, and the result says so", () => {
  let s = ledger();
  s = planPayslip(s, base({ printed_gross: 1150000, printed_net: 1030000, deposit: 1030000, earnings: [{ kind: "basic", amount: 900000 }, { kind: "rice", amount: 100000 }, { kind: "overtime", amount: 150000, earned_month: "2026-09" }] }), NOW).state;
  const ot = overtimeDraft(s, "ps1", { transaction_id: "ot-ps1", emergency_account_id: "ef" }, NOW);
  s = { ...s, transactions: [...s.transactions, { ...ot.transaction, status: "verified", verified_at: ot.transaction.created_at }], entries: [...s.entries, ...ot.entries] };
  const d = deletePayslip(s, "ps1");
  assert.equal(d.keptTransfers, 1);
  assert.equal(d.state.transactions.some((t) => t.id === "ot-ps1"), true);
});

test("the same payslip saved twice is refused: same period and same net pay", () => {
  const first = planPayslip(ledger(), base(), NOW);
  assert.equal(first.ok, true);
  const again = planPayslip(first.state, base({ id: "ps2", transaction_id: "tx-ps2", employer: "Sample Employer Inc (misread)" }), NOW);
  assert.equal(again.ok, false);
  assert.equal(again.violations[0].code, "DUPLICATE_PAYSLIP");
  assert.match(again.violations[0].message, /already saved one for 2026-10-01 to 2026-10-15/);
  assert.equal(planPayslip(first.state, base({ id: "ps3", transaction_id: "tx-ps3", deposit: 700000, printed_net: 700000 }), NOW).ok, true, "a second income in the same period, with another net pay, is allowed");
  assert.equal(planPayslip(first.state, base({ id: "ps4", transaction_id: "tx-ps4", period_from: "2026-10-16", period_to: "2026-10-31", pay_date: "2026-10-31" }), NOW).ok, true, "the next period with the same net pay is allowed");
});

test("editing a payslip replaces it in place: same ids, new figures, photo kept, the ledger stays valid and nothing is counted twice", () => {
  let s = planPayslip(ledger(), base(), NOW).state;
  s = planAttachment(s, { id: "ph1", transaction_id: "tx-ps1" }).state;
  const r = updatePayslip(s, "ps1", base({ employer: "Sample Employer Inc.", printed_gross: 1100000, printed_net: 980000, deposit: 980000, earnings: [{ kind: "basic", amount: 1000000 }, { kind: "rice", amount: 100000 }] }), NOW);
  assert.ok(r.ok, JSON.stringify(r.violations));
  assert.equal(r.state.payslips.length, 1);
  assert.equal(r.state.payslips[0].employer, "Sample Employer Inc.");
  assert.equal(r.state.payslips[0].deposit, 980000);
  assert.equal(r.state.transactions.filter((t) => t.id === "tx-ps1").length, 1);
  assert.equal(r.state.transactions.find((t) => t.id === "tx-ps1").payee, "Sample Employer Inc.");
  assert.equal(r.state.attachments.length, 1, "the photo stays with the pay");
  assert.equal(incomeBySource(r.state, { from: "2026-10-01", to: "2026-10-31" }).total, 980000);
  assert.deepEqual(validateState(r.state), []);
});

test("editing a payslip: a waiting overtime draft is dropped, a verified overtime transfer stays, an unknown id is refused", () => {
  const ot = { printed_gross: 1150000, printed_net: 1030000, deposit: 1030000, earnings: [{ kind: "basic", amount: 900000 }, { kind: "rice", amount: 100000 }, { kind: "overtime", amount: 150000, earned_month: "2026-09" }] };
  let s = planPayslip(ledger(), base(ot), NOW).state;
  const d = overtimeDraft(s, "ps1", { transaction_id: "ot-ps1", emergency_account_id: "ef" }, NOW);
  const withDraft = { ...s, transactions: [...s.transactions, d.transaction], entries: [...s.entries, ...d.entries] };
  const r = updatePayslip(withDraft, "ps1", base(ot), NOW);
  assert.equal(r.draftsRemoved, 1);
  assert.equal(r.state.transactions.some((t) => t.id === "ot-ps1"), false);
  const verified = { ...s, transactions: [...s.transactions, { ...d.transaction, status: "verified", verified_at: d.transaction.created_at }], entries: [...s.entries, ...d.entries] };
  const r2 = updatePayslip(verified, "ps1", base(ot), NOW);
  assert.equal(r2.draftsRemoved, 0);
  assert.equal(r2.state.transactions.some((t) => t.id === "ot-ps1"), true);
  assert.equal(updatePayslip(s, "nope", base(ot), NOW).ok, false);
});

test("editing a payslip may keep its own period and net pay, but may not copy another payslip's", () => {
  let s = planPayslip(ledger(), base(), NOW).state;
  s = planPayslip(s, base({ id: "ps2", transaction_id: "tx-ps2", period_from: "2026-10-16", period_to: "2026-10-31", pay_date: "2026-10-31" }), NOW).state;
  assert.ok(updatePayslip(s, "ps1", base({ employer: "Renamed Inc" }), NOW).ok, "same period and net as itself is fine");
  const clash = updatePayslip(s, "ps1", base({ period_from: "2026-10-16", period_to: "2026-10-31" }), NOW);
  assert.equal(clash.ok, false);
  assert.equal(clash.violations[0].code, "DUPLICATE_PAYSLIP");
});

// A payslip plus a plain "pay received" of the same amount (a payslip photo once saved the older way): the month counts it twice.
function withStray() {
  let s = planPayslip(ledger(), base(), NOW).state;
  const p = planPayReceived(s, { transaction_id: "tx-stray", date: "2026-10-15", amount: 880000, account_id: "chk", category_id: "cat-salary", payee: "Pay received" }, NOW);
  return { s: p.state, before: p.state };
}

test("income without a payslip is listed, and it is what makes a month count twice", () => {
  const { s } = withStray(), oct = { from: "2026-10-01", to: "2026-10-31" };
  assert.equal(incomeBySource(s, oct).total, 1760000, "one payslip and one stray entry: the month shows double");
  const rows = incomeWithoutPayslip(s, oct);
  assert.deepEqual(rows.map((r) => [r.transaction_id, r.amount, r.account_id]), [["tx-stray", 880000, "chk"]]);
  assert.deepEqual(incomeWithoutPayslip(s, { from: "2026-11-01", to: "2026-11-30" }), [], "another month has none");
  assert.equal(incomeWithoutPayslip(planPayslip(ledger(), base(), NOW).state, oct).length, 0, "a payslip's own pay is not listed");
});

test("removing a stray income entry takes it out of the totals and the account, and leaves the payslip alone", () => {
  const { s } = withStray(), oct = { from: "2026-10-01", to: "2026-10-31" };
  const r = removeIncomeEntry(s, "tx-stray");
  assert.equal(r.ok, true);
  assert.equal(incomeBySource(r.state, oct).total, 880000);
  assert.equal(r.state.payslips.length, 1);
  assert.equal(r.state.transactions.some((t) => t.id === "tx-stray"), false);
  assert.equal(r.state.entries.some((e) => e.transaction_id === "tx-stray"), false);
  assert.deepEqual(validateState(r.state), []);
  assert.equal(removeIncomeEntry(s, "tx-ps1").ok, false, "a payslip's pay is removed with the payslip");
  assert.equal(removeIncomeEntry(s, "nope").ok, false);
});

test("deductions by month carry a total of every deduction line, including absences, and it matches the payslip's own total", () => {
  const s = planPayslip(ledger(), base({ printed_gross: 1000000, printed_net: 795000, deposit: 795000,
    deductions: [{ kind: "tax", amount: 70000 }, { kind: "sss", amount: 30000 }, { kind: "absences", amount: 105000 }] }), NOW).state;
  const d = deductionsByMonth(s, "2026");
  assert.equal(d.months[0].total, 205000);
  assert.equal(d.ytd.total, 205000);
  assert.equal(d.months[0].total, payslipTotals(linesOf(s, "ps1")).deductions);
  assert.equal(d.months[0].government, 100000, "absences are not government money");
  assert.equal(d.months[0].lost, 105000);
});

test("the same payslip saved twice is refused with a message that says what to do; a different net pay or period is allowed", () => {
  const first = planPayslip(ledger(), base(), NOW);
  assert.ok(first.ok);
  const again = planPayslip(first.state, base({ id: "ps2", transaction_id: "tx-ps2" }), NOW);
  assert.equal(again.ok, false);
  assert.equal(again.violations[0].code, "DUPLICATE_PAYSLIP");
  assert.match(again.violations[0].message, /Duplicate payslip.*Change this payslip/);
  const other = planPayslip(first.state, base({ id: "ps3", transaction_id: "tx-ps3", deposit: 870000, printed_net: 870000 }), NOW);
  assert.ok(other.ok, "a different net pay is a different payslip");
  const next = planPayslip(first.state, base({ id: "ps4", transaction_id: "tx-ps4", period_from: "2026-10-16", period_to: "2026-10-31" }), NOW);
  assert.ok(next.ok, "a different period is a different payslip");
  const edit = updatePayslip(first.state, "ps1", base(), NOW);
  assert.ok(edit.ok, "changing a payslip is never a duplicate of itself");
});

// ---- Income round 4: notes on a saved payslip, missing periods, earlier figures ----
const saved = (o = {}, id = "ps1") => planPayslip(ledger(), base({ id, transaction_id: "tx-" + id, ...o }), NOW).state;

test("a payslip saved before the fix says so, once; saving it again removes the line", () => {
  const s = saved(), old = { ...s, payslips: s.payslips.map((p) => { const { version, ...rest } = p; return rest; }) };
  assert.deepEqual(payslipNotes(old, old.payslips[0]), ["Saved before the fix, may be wrong."]);
  assert.deepEqual(payslipNotes(s, s.payslips[0]), []);
  assert.equal(s.payslips[0].version, PAYSLIP_VERSION);
  const again = updatePayslip(old, "ps1", base(), NOW);
  assert.deepEqual(payslipNotes(again.state, again.state.payslips[0]), []);
  assert.deepEqual(validateState(old), [], "old payslips without the field stay valid");
});

test("a pay date more than 7 days after the period end is named; 7 days or fewer is not", () => {
  const note = (pay) => { const s = saved({ pay_date: pay }); return payslipNotes(s, s.payslips[0]); };
  assert.deepEqual(note("2026-10-23"), ["Pay date is 8 days after period end."]);
  assert.deepEqual(note("2026-10-22"), []);   // exactly 7
  assert.deepEqual(note("2026-10-24"), ["Pay date is 9 days after period end."]);
  assert.deepEqual(note("2026-10-15"), []);
});

test("the printed deductions total is kept and compared with the lines: match, differ, or nothing when not entered", () => {
  assert.deepEqual(payslipNotes(saved(), saved().payslips[0]), []);
  const ok = saved({ printed_deductions: 120000 });
  assert.equal(ok.payslips[0].printed_deductions, 120000);
  assert.deepEqual(payslipNotes(ok, ok.payslips[0]), ["Lines match paper."]);
  const off = saved({ printed_deductions: 125000 });
  assert.deepEqual(payslipNotes(off, off.payslips[0]), ["Lines differ from paper by ₱50.00."]);
  const low = saved({ printed_deductions: 110000 });
  assert.deepEqual(payslipNotes(low, low.payslips[0]), ["Lines differ from paper by ₱100.00."]);
  assert.deepEqual(validateState(off), []);
});

test("pay periods with no payslip: twice-a-month pay only, from the first payslip, not the last week, inside the range", () => {
  const mk = (...periods) => periods.reduce((st, [from, to], i) => planPayslip(st, base({ id: "p" + i, transaction_id: "t" + i, period_from: from, period_to: to, pay_date: to, deposit: 880000 + i }), NOW).state, ledger());
  const s = mk(["2026-03-01", "2026-03-15"], ["2026-03-16", "2026-03-31"], ["2026-04-01", "2026-04-15"], ["2026-05-01", "2026-05-15"]);
  assert.deepEqual(missingPayPeriods(s, null, "2026-06-10"), [{ from: "2026-04-16", to: "2026-04-30" }, { from: "2026-05-16", to: "2026-05-31" }]);
  assert.deepEqual(missingPayPeriods(s, "2026", "2026-06-10").length, 2);
  assert.deepEqual(missingPayPeriods(s, "2025", "2026-06-10"), []);
  assert.deepEqual(missingPayPeriods(s, { from: "2026-04-01", to: "2026-04-30" }, "2026-06-10"), [{ from: "2026-04-16", to: "2026-04-30" }]);
  assert.deepEqual(missingPayPeriods(s, null, "2026-05-20"), [{ from: "2026-04-16", to: "2026-04-30" }], "May 16-31 has not ended; nothing is asked for it");
  assert.deepEqual(missingPayPeriods(s, null, "2026-05-31").length, 1, "just after a period ends it is not called missing yet");
  assert.equal(missingPayPeriods(s, null, "2026-06-08").length, 2, "a week and a day after the period ended it is listed");
  assert.equal(missingPayPeriods(s, null, "2026-06-07").length, 1, "one day sooner it is not");
  const late = mk(["2026-03-16", "2026-03-31"], ["2026-04-01", "2026-04-15"], ["2026-04-16", "2026-04-30"]);
  assert.deepEqual(missingPayPeriods(late, null, "2026-09-01").slice(0, 1), [{ from: "2026-05-01", to: "2026-05-15" }], "nothing is asked for the half-month before the first payslip");
  const monthly = mk(["2026-03-01", "2026-03-31"], ["2026-05-01", "2026-05-31"]);
  assert.deepEqual(missingPayPeriods(monthly, null, "2026-09-01"), [], "monthly pay is never reported as missing halves");
  assert.deepEqual(missingPayPeriods(ledger(), null, "2026-09-01"), []);
});

test("changing a payslip keeps the old figures and the change date; ids stay; an unchanged save adds nothing", () => {
  const s = saved();
  const r = updatePayslip(s, "ps1", base({ deposit: 870000, printed_net: 870000, printed_gross: 990000, earnings: [{ kind: "basic", amount: 890000 }, { kind: "rice", amount: 100000 }] }), NOW);
  assert.ok(r.ok, JSON.stringify(r.violations));
  assert.equal(r.state.payslips[0].id, "ps1"); assert.equal(r.state.payslips[0].transaction_id, "tx-ps1");
  const [rev] = revisionsOf(r.state, "ps1");
  assert.equal(rev.changed_on, "2026-10-16");
  assert.equal(rev.deposit, 880000); assert.equal(rev.printed_gross, 1000000);
  assert.equal(rev.lines.find((l) => l.kind === "basic").amount, 900000);
  assert.deepEqual(validateState(r.state), []);
  const same = updatePayslip(r.state, "ps1", base({ deposit: 870000, printed_net: 870000, printed_gross: 990000, earnings: [{ kind: "basic", amount: 890000 }, { kind: "rice", amount: 100000 }] }), NOW);
  assert.equal(revisionsOf(same.state, "ps1").length, 1, "same figures, no second entry");
  const third = updatePayslip(r.state, "ps1", base(), NOW);
  assert.deepEqual(revisionsOf(third.state, "ps1").map((x) => x.deposit), [870000, 880000], "newest first");
  assert.equal(new Set(third.state.payslipRevisions.map((x) => x.id)).size, 2, "each earlier version has its own id");
  assert.equal(updatePayslip(s, "ps1", base(), NOW).state.payslipRevisions, undefined, "no change at all adds no collection entry");
  const gone = deletePayslip(r.state, "ps1");
  assert.deepEqual(gone.state.payslipRevisions, [], "removing the payslip removes its history");
});

// ---- Income round 5: several employers, mark as checked, what changed ----
test("same employer and same period (any net pay) is found for the warning; another employer, another period, or the payslip itself is not", () => {
  const s = saved();
  const q = (o) => samePeriodPayslips(s, base(o), o?.except ?? null).map((p) => p.id);
  assert.deepEqual(q({ deposit: 870000 }), ["ps1"]);
  assert.deepEqual(q({ employer: "sample employer inc" }), ["ps1"]);
  assert.deepEqual(q({ employer: "Other Employer Co" }), []);
  assert.deepEqual(q({ period_from: "2026-10-16", period_to: "2026-10-31" }), []);
  assert.deepEqual(samePeriodPayslips(s, base(), "ps1"), []);
});

test("marking a payslip checked clears the old-figures line and changes nothing else", () => {
  const s = saved(), old = { ...s, payslips: s.payslips.map(({ version, ...rest }) => rest) };
  assert.equal(payslipNotes(old, old.payslips[0]).length, 1);
  const r = markPayslipChecked(old, "ps1");
  assert.ok(r.ok);
  assert.deepEqual(payslipNotes(r.state, r.state.payslips[0]), []);
  assert.deepEqual({ ...r.state.payslips[0], version: undefined }, { ...old.payslips[0], version: undefined });
  assert.deepEqual(r.state.payslipLines, old.payslipLines);
  assert.deepEqual(validateState(r.state), []);
  assert.equal(markPayslipChecked(old, "nope").ok, false);
});

test("each change lists which lines changed: amounts, added and removed lines, dates and the employer; newest change first", () => {
  const s = saved();
  const one = updatePayslip(s, "ps1", base({ employer: "Renamed Co", pay_date: "2026-10-16", earnings: [{ kind: "basic", amount: 890000 }, { kind: "rice", amount: 100000 }, { kind: "skills", amount: 10000 }], printed_gross: 1000000,
    deductions: [{ kind: "tax", amount: 70000 }, { kind: "sss", amount: 30000 }] , printed_net: 880000 }), NOW);
  assert.ok(one.ok, JSON.stringify(one.violations));
  const two = updatePayslip(one.state, "ps1", base({ earnings: [{ kind: "basic", amount: 900000 }, { kind: "rice", amount: 100000 }] }), NOW);
  const list = revisionChanges(two.state, "ps1");
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].changes.sort(), ["Basic salary ₱8,900.00 to ₱9,000.00", "Employer Renamed Co to Sample Employer Inc", "Pag-IBIG added ₱100.00", "PhilHealth added ₱100.00", "Pay date Oct 16, 2026 to Oct 15, 2026", "Skills allowance removed (was ₱100.00)"].sort());
  assert.deepEqual(list[1].changes.sort(), ["Basic salary ₱9,000.00 to ₱8,900.00", "Employer Sample Employer Inc to Renamed Co", "Pag-IBIG removed (was ₱100.00)", "PhilHealth removed (was ₱100.00)", "Pay date Oct 15, 2026 to Oct 16, 2026", "Skills allowance added ₱100.00"].sort());
  assert.deepEqual(revisionChanges(s, "ps1"), []);
  assert.deepEqual(revisionChanges(s, "nope"), []);
});
