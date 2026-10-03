import { test } from "node:test";
import assert from "node:assert/strict";
import { planPayslip, payslipChecks, payslipTotals, linesOf, overtimeDraft, overtimeFreeDraft, incomeBySource, incomeByMonth, netPerPayday, raiseHistory, deductionsByMonth, employerHistory,
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
  assert.deepEqual(Object.keys(r.payslip).sort(), ["account_id", "deposit", "employer", "id", "pay_date", "period_from", "period_to", "printed_gross", "printed_net", "transaction_id"]);
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
