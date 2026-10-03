import { test } from "node:test";
import assert from "node:assert/strict";
import { readScan, readPayslip, wordsToCentavos, categoryFromHistory } from "../src/model/index.js";

const TODAY = "2026-10-20";   // all texts below are invented

test("a store receipt: kind, total (not subtotal, cash or change), date and store name", () => {
  const r = readScan(`SAMPLE BURGER HOUSE
Official Receipt
Date: Oct 18, 2026 12:41
1 Burger meal   150.00
Subtotal   150.00
VAT 12%   16.07
TOTAL   150.00
Cash   200.00
Change   50.00
Thank you`, TODAY);
  assert.equal(r.kind, "receipt");
  assert.equal(r.amount, 15000);
  assert.equal(r.date, "2026-10-18");
  assert.equal(r.payee, "SAMPLE BURGER HOUSE");
  assert.equal(r.categoryGuess, "Food");
  assert.equal(r.direction, "out");
});
test("the last Total wins and its amount may sit on the next line", () => {
  const r = readScan("Sample Mart\nSubtotal 90.00\nTOTAL\n₱ 1,234.50\nCash 2,000.00\nChange 765.50", TODAY);
  assert.equal(r.amount, 123450);
});
test("when two lines say total, the later one (the amount actually due) wins", () => {
  assert.equal(readScan("Sample Cafe\nTotal 100.00\nService charge 10.00\nTOTAL DUE 110.00", TODAY).amount, 11000);
});
test("a payslip takes the NET pay, never gross or basic", () => {
  const r = readScan(`Sample Co Payslip
Pay period 01/10/2026 - 15/10/2026
Basic pay 12,000.00
Gross pay 12,000.00
SSS 500.00
Philhealth 300.00
Net pay 11,200.00`, TODAY);
  assert.equal(r.kind, "payslip");
  assert.equal(r.direction, "in");
  assert.equal(r.amount, 1120000);
});
test("a payslip with no net pay line is not guessed", () => {
  const r = readScan("Payslip\nBasic pay 12,000.00\nGross pay 12,000.00", TODAY);
  assert.equal(r.amount, null);
  assert.ok(r.notes.some((n) => /net pay/i.test(n)));
});
test("a GCash screenshot: kind, amount, payee, and no long number is kept", () => {
  const r = readScan(`GCash
Express Send
Sent to
JUAN D. SAMPLE 09171234567
Amount 350.00
Total Amount Sent 350.00
Ref No. 1234 567 890123
Oct 19, 2026 6:02 PM`, TODAY);
  assert.equal(r.kind, "gcash");
  assert.equal(r.amount, 35000);
  assert.equal(r.date, "2026-10-19");
  assert.ok(!/\d{6,}/.test(r.payee), "no long number in the payee: " + r.payee);
});
test("money received is income", () => {
  const r = readScan("GCash\nYou have received PHP 500.00 of GCash from SAMPLE PERSON\n2026-10-19", TODAY);
  assert.equal(r.kind, "received");
  assert.equal(r.direction, "in");
  assert.equal(r.amount, 50000);
});
test("a ride and a rent receipt are recognised", () => {
  assert.equal(readScan("Grab\nYour ride\nFare 185.00\nOct 18, 2026", TODAY).kind, "ride");
  const rent = readScan("ACKNOWLEDGMENT RECEIPT\nReceived from Sample Tenant the sum of Five thousand pesos (P5,000.00) for rent for the month of October\n10/05/2026", TODAY);
  assert.equal(rent.kind, "rent");
  assert.equal(rent.amount, 500000);
  assert.equal(rent.categoryGuess, "Rent");
});
test("amount in words is read, and a disagreement with the figures is flagged", () => {
  assert.equal(wordsToCentavos("Nine thousand five hundred pesos"), 950000);
  assert.equal(wordsToCentavos("One thousand two hundred thirty-four pesos and 50/100"), 123450);
  assert.equal(wordsToCentavos("twenty one"), 2100);
  assert.equal(wordsToCentavos("hello world"), null);
  const same = readScan("Rent receipt\nReceived Php 5,000.00\nFive thousand pesos only", TODAY);
  assert.ok(!same.notes.some((n) => /words say/.test(n)));
  const off = readScan("Rent receipt\nReceived Php 5,000.00\nFour thousand pesos only", TODAY);
  assert.ok(off.notes.some((n) => /words say ₱4,000\.00 but the figures say ₱5,000\.00/.test(n)));
  assert.equal(off.amount, 500000);   // the figures stay; the owner decides
});
test("a year that is old or in the future is flagged and not used", () => {
  const old = readScan("Sample Mart\nTOTAL 100.00\nJan 5, 2016", TODAY);
  assert.equal(old.date, null);
  assert.equal(old.dateSeen, "Jan 5, 2016");
  assert.ok(old.notes.some((n) => /not within the last year/.test(n)));
  assert.equal(readScan("Sample Mart\nTOTAL 100.00\n2028-10-18", TODAY).date, null);
  assert.equal(readScan("Sample Mart\nTOTAL 100.00\nno date here", TODAY).date, null);
});
test("date formats: day first when it must be, month first otherwise, letters mistaken for digits", () => {
  assert.equal(readScan("Mart TOTAL 10.00 25/10/2026", TODAY).date, null);   // 5 days ahead: too far, not used
  assert.equal(readScan("Mart TOTAL 10.00 18/10/2026", TODAY).date, "2026-10-18");
  const amb = readScan("Mart TOTAL 10.00 10/09/2026", TODAY);
  assert.equal(amb.date, "2026-10-09");
  assert.ok(amb.notes.some((n) => /month first/.test(n)));
  assert.equal(readScan("Mart TOTAL 10.00 1O/18/2O26", TODAY).date, "2026-10-18");
  assert.equal(readScan("Mart TOTAL 10.00 18 October 2026", TODAY).date, "2026-10-18");
});
test("no Total line: the biggest amount is taken, with a warning; change and cash are ignored", () => {
  const r = readScan("Sample Mart\nitem 40.00\nitem 60.00\nCash 500.00\nChange 400.00", TODAY);
  assert.equal(r.amount, 6000);
  assert.ok(r.notes.some((n) => /biggest amount/.test(n)));
});
test("empty or unreadable text gives an empty guess, never a crash", () => {
  for (const t of ["", "   \n ", null, undefined, "@@## ~~"]) {
    const r = readScan(t, TODAY);
    assert.equal(r.kind, "other");
    assert.equal(r.amount, null);
    assert.equal(r.date, null);
  }
});

// Texts below are invented; the layout imitates a bank app's "Transaction Details" screen.
const CARD_SCREEN = `Transaction Details
PHP 592.50
From MariBank
To SAMPLE SUPERMARKET MAKATI CITY PHL
Card Number **** **** **** 1234
Transaction Amount PHP 592.50
Cashback +PHP 17.78
Reference Number 20261001320100010000127337311000
Transaction Type Credit Card Transaction
Transaction Time 01 Oct 2026, 19:52
Posted Time 03 Oct 2026, 10:47`;
test("a bank app screenshot: the bank on the From line paid, not GCash; the amount, the date and the payee are read", () => {
  const r = readScan(CARD_SCREEN, TODAY);
  assert.equal(r.bankId, "maribank");
  assert.equal(r.creditCard, true);
  assert.equal(r.amount, 59250);
  assert.equal(r.date, "2026-10-01");
  assert.match(r.payee, /SAMPLE SUPERMARKET/);
  assert.ok(!/\d{6,}/.test(r.payee));
});
test("the bank is found by the From line, forgiving one misread letter, and the recipient's bank is never taken as the payer", () => {
  assert.equal(readScan("From Mari8ank\nTo Sample Store", TODAY).bankId, "maribank");
  assert.equal(readScan("From GoTyme\nTo BDO\nPHP 10.00", TODAY).bankId, "gotyme");
  assert.equal(readScan("From Security Bank\nPHP 10.00", TODAY).bankId, "securitybank");
  assert.equal(readScan("Transfer\nBPI to BDO\nPHP 10.00", TODAY).bankId, null, "two banks and no From line: not guessed");
  assert.equal(readScan("GCash\nExpress Send\nSent to\nSAMPLE PERSON\nAmount 350.00", TODAY).bankId, "gcash");
  assert.equal(readScan("Sample Mart\nTOTAL 100.00", TODAY).bankId, null);
  assert.equal(readScan("From BDX\nPHP 10.00", TODAY).bankId, null, "short names must be exact");
});

test("the category used before for the same payee is remembered, verified entries only, most used first", () => {
  const st = { categories: [{ id: "food", name: "Food", kind: "expense" }, { id: "ess", name: "Essentials", kind: "expense" }, { id: "inc", name: "Pay", kind: "income" }], transactions: [], entries: [] };
  const add = (id, payee, date, cat, status = "verified") => { st.transactions.push({ id, payee, date, status }); st.entries.push({ transaction_id: id, category_id: cat, amount: 100 }); };
  add("a", "Sample Mart", "2026-09-01", "ess"); add("b", "sample mart ", "2026-09-05", "food"); add("c", "Sample Mart", "2026-09-09", "food");
  add("d", "Sample Mart", "2026-09-20", "ess", "draft"); add("e", "Other", "2026-09-02", "ess");
  assert.equal(categoryFromHistory(st, "SAMPLE MART"), "food", "two food against one essentials; the draft does not count");
  add("f", "Tie Shop", "2026-09-01", "food"); add("g", "Tie Shop", "2026-09-10", "ess");
  assert.equal(categoryFromHistory(st, "Tie Shop"), "ess", "a tie goes to the more recent");
  assert.equal(categoryFromHistory(st, "Never Seen"), null);
  assert.equal(categoryFromHistory(st, ""), null);
});

// An invented payslip, laid out like a typical one with two columns (this pay, and the year so far).
const PAYSLIP = `Sample Employer Inc
PAYSLIP
Pay period: 01/10/2026 - 15/10/2026
Pay date: Oct 15, 2026
EARNINGS
Basic Salary 9,000.00 18,000.00
Rice Subsidy 1,000.00 2,000.00
Skills Allowance 500.00 1,000.00
Overtime 1,500.00 1,500.00
Gross Pay 12,000.00 22,500.00
DEDUCTIONS
Withholding Tax 700.00 1,400.00
SSS 300.00 600.00
PhilHealth 100.00 200.00
Pag-IBIG 100.00 200.00
SSS Loan 50.00 50.00
Late/Undertime 25.00
Total Deductions 1,275.00
Net Pay 10,725.00
Year to date
Basic Salary 18,000.00`;
test("a payslip: every earnings and deduction line, tax and what went to government, the printed gross and net", () => {
  const r = readPayslip(PAYSLIP, TODAY);
  assert.deepEqual(r.earnings.map((l) => [l.kind, l.amount]), [["basic", 900000], ["rice", 100000], ["skills", 50000], ["overtime", 150000]]);
  assert.deepEqual(r.deductions.map((l) => [l.kind, l.amount]), [["tax", 70000], ["sss", 30000], ["philhealth", 10000], ["pagibig", 10000], ["loan", 5000], ["lates", 2500]]);
  assert.equal(r.printed_gross, 1200000);
  assert.equal(r.printed_net, 1072500);
  assert.equal(r.employer, "Sample Employer Inc");
  assert.deepEqual([r.period_from, r.period_to, r.pay_date], ["2026-10-01", "2026-10-15", "2026-10-15"]);
});
test("a payslip: the first figure is taken, an SSS loan is a loan not SSS, taxable income is not tax, and nothing after the year-to-date heading counts", () => {
  const r = readPayslip("Net Pay 100.00\nGross Pay 150.00\nTaxable Income 140.00\nSSS 10.00\nSSS Loan 5.00\nYear to date\nPhilHealth 99.00", TODAY);
  assert.deepEqual(r.deductions.map((l) => [l.kind, l.amount]), [["sss", 1000], ["loan", 500]]);
  assert.ok(!r.deductions.some((l) => l.kind === "tax" || l.kind === "philhealth"));
});
test("a payslip with a label alone on a line takes the figure from the next line; missing gross, net and dates are said in words", () => {
  const r = readPayslip("Withholding Tax\n1,234.50\nPhilHealth 450.00", TODAY);
  assert.deepEqual(r.deductions.map((l) => [l.kind, l.amount]), [["tax", 123450], ["philhealth", 45000]]);
  assert.ok(r.notes.some((n) => /printed gross/.test(n)) && r.notes.some((n) => /printed net/.test(n)) && r.notes.some((n) => /pay date/.test(n)));
});
test("an old year on a payslip is not used as the pay date", () => {
  const r = readPayslip("Pay date: Jan 15, 2016\nNet Pay 100.00", TODAY);
  assert.equal(r.pay_date, null);
});
test("an unreadable payslip gives an empty reading, never a crash", () => {
  for (const t of ["", null, undefined, "@@ ~~"]) { const r = readPayslip(t, TODAY); assert.deepEqual([r.earnings.length, r.deductions.length, r.printed_net], [0, 0, null]); }
});
