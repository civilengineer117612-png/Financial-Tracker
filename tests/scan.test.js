import { test } from "node:test";
import assert from "node:assert/strict";
import { readScan, readPayslip, linesFromWords, linesFromBoxes, snapEmployer, wordsToCentavos, categoryFromHistory } from "../src/model/index.js";

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
  assert.equal(r.categoryGuess, "food");
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
  assert.equal(rent.categoryGuess, "rent");
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

// Words with boxes, like the reader returns them. A two-column payslip (earnings left, deductions right), tilted so the right side
// sits lower: row pitch 40, word height 28, tilt 0.06 (every 100 across drops the line 6 down). All figures invented.
function page(tilt) {
  const words = [], row = (y, left, right) => {
    const put = (x, text, base) => words.push({ text, x0: x, x1: x + 12 * text.length, y0: y + tilt * x, y1: y + 28 + tilt * x });
    let x = 20; for (const t of left.label.split(" ")) { put(x, t); x += 12 * t.length + 14; } if (left.amount) put(330, left.amount);
    x = 480; for (const t of right.label.split(" ")) { put(x, t); x += 12 * t.length + 14; } if (right.amount) put(840, right.amount);
  };
  row(100, { label: "EARNINGS", amount: "" }, { label: "DEDUCTIONS", amount: "" });
  row(140, { label: "Basic Salary", amount: "9,000.00" }, { label: "Withholding Tax", amount: "794.22" });
  row(180, { label: "Rice Subsidy", amount: "2,000.00" }, { label: "SSS Premium Cont.", amount: "1,700.00" });
  row(220, { label: "Skills Allowance", amount: "9,000.00" }, { label: "Philhealth Premium Cont.", amount: "450.00" });
  row(260, { label: "Clothing Allowance", amount: "3,000.00" }, { label: "Pag-Ibig Premium Cont.", amount: "360.00" });
  row(300, { label: "Gross Earnings", amount: "23,000.00" }, { label: "Absences", amount: "827.39" });
  row(340, { label: "", amount: "" }, { label: "Total Deductions", amount: "3,131.61" });
  return words;
}
test("a two-column payslip keeps every label with its own amount, even when the photo is tilted", () => {
  for (const tilt of [0, 0.06, -0.05]) {
    const lines = linesFromWords(page(tilt)).split("\n");
    for (const want of ["Basic Salary 9,000.00", "Withholding Tax 794.22", "SSS Premium Cont. 1,700.00", "Philhealth Premium Cont. 450.00", "Pag-Ibig Premium Cont. 360.00", "Absences 827.39", "Gross Earnings 23,000.00"]) {
      assert.ok(lines.includes(want), "tilt " + tilt + ": " + want + " in " + JSON.stringify(lines));
    }
  }
});
test("the lines made from a tilted two-column page give the right tax, SSS, PhilHealth and Pag-IBIG", () => {
  const r = readPayslip(linesFromWords(page(0.06)), TODAY);
  assert.deepEqual(r.deductions.map((l) => [l.kind, l.amount]), [["tax", 79422], ["sss", 170000], ["philhealth", 45000], ["pagibig", 36000], ["absences", 82739]]);
  assert.deepEqual(r.earnings.map((l) => [l.kind, l.amount]), [["basic", 900000], ["rice", 200000], ["skills", 900000], ["clothing", 300000]]);
  assert.equal(r.printed_gross, 2300000);
});
test("a currency sign stays with its amount, a second figure joins the same label, and nothing found gives empty text", () => {
  const w = (t, x, y = 0) => ({ text: t, x0: x, x1: x + 10 * t.length, y0: y, y1: y + 20 });
  assert.equal(linesFromWords([w("Net", 0), w("Pay:", 40), w("P", 100), w("21,868.19", 120)]), "Net Pay: 21,868.19");
  assert.equal(linesFromWords([w("Basic", 0), w("9,000.00", 80), w("18,000.00", 200)]), "Basic 9,000.00 18,000.00");
  assert.equal(linesFromWords([]), "");
  assert.equal(linesFromWords(null), "");
});
test("a payslip dated as a range, with the company's name under a title, is read", () => {
  const r = readPayslip("PHIL SAMPLE, INC.\nPAYSLIP\nApr 16-30, 2026\nNet Pay: P 10,000.00\nGross Earnings 11,000.00", "2026-10-03");
  assert.equal(r.employer, "PHIL SAMPLE, INC.");
  assert.deepEqual([r.period_from, r.period_to, r.pay_date], ["2026-04-16", "2026-04-30", "2026-04-30"]);
  assert.deepEqual([r.printed_net, r.printed_gross], [1000000, 1100000]);
});
test("Pag-IBIG is found under the spellings a photo gives it", () => {
  for (const label of ["Pag-IBIG", "Pag-Ibig Premium Cont.", "Pag-big Premium Cont.", "PAGIBIG", "HDMF"]) assert.deepEqual(readPayslip(label + " 100.00", TODAY).deductions.map((l) => l.kind), ["pagibig"], label);
});

test("the employer is the company's name, never a figure, a label, a date or a signature line", () => {
  const emp = (lines) => readPayslip(lines.join("\n"), "2026-10-03").employer;
  assert.equal(emp(["L SAMPLE CO, INC. Apr 16-30, 2026", "PAYSLIP", "Net Pay: P 100.00"]), "SAMPLE CO, INC.", "a date and a stray letter on the same line are dropped");
  assert.equal(emp(["Withholding Tax 794.22", "SSS Premium Cont. 1,700.00", "SAMPLE CO, INC.", "PAYSLIP"]), "SAMPLE CO, INC.", "figure lines and deduction labels are skipped");
  assert.equal(emp(["PAYSLIP", "SAMPLE ENGINEERING CONSULTANCY", "DESIGNERS - ENGINEERS", "Covered Period: Sept 26, 2025 to Oct 12, 2025"]), "SAMPLE ENGINEERING CONSULTANCY", "company words beyond Inc and Corp are known");
  assert.equal(emp(["Employer: Another Co", "SAMPLE CO, INC."]), "Another Co", "a labelled employer wins");
  assert.equal(emp(["EARNINGS", "Basic Salary 9,000.00", "Withholding Tax"]), null, "nothing company-like gives nothing, not a wrong line");
});
test("an employer read from a photo snaps to one already saved, and a different name is left alone", () => {
  const known = ["PHIL. JAC, INC.", "TSI CORE ENGINEERING CONSULTANCY"];
  assert.equal(snapEmployer("L PHIL. JAC, INC. Apr 16-30", known), "PHIL. JAC, INC.");
  assert.equal(snapEmployer("PHIL JAG INC", known), "PHIL. JAC, INC.");
  assert.equal(snapEmployer("TSI CORE ENGINEERING CONSULTANCY", known), "TSI CORE ENGINEERING CONSULTANCY");
  assert.equal(snapEmployer("Some Other Company Ltd", known), "Some Other Company Ltd");
  assert.equal(snapEmployer("Te SULTANGY", known), "Te SULTANGY");
  assert.equal(snapEmployer("", known), "");
  assert.equal(snapEmployer("PHIL. JAC, INC.", []), "PHIL. JAC, INC.");
});

// ---- the stronger reader's boxes ----
// Boxes are built the way the reader reports them: a label on the left, its amount at the right of the same row, the whole page tilted.
const box = (text, x, y, w = 200, tilt = 0, h = 20) => ({ text, th: tilt, x0: x, x1: x + w, y0: y + tilt * x, y1: y + h + tilt * x });

test("linesFromBoxes pairs a label with the amount at its height on a tilted page", () => {
  const t = 0.05, rows = [["Basic Pay", "12,000.00"], ["SSS", "500.00"], ["Philhealth", "300.00"], ["Withholding Tax", "250.00"]];
  const boxes = rows.flatMap(([l, a], i) => [box(l, 20, 40 + i * 30, 150, t), box(a, 400, 40 + i * 30, 90, t)]);
  const out = linesFromBoxes(boxes).split("\n");
  assert.deepEqual(out, ["Basic Pay 12,000.00", "SSS 500.00", "Philhealth 300.00", "Withholding Tax 250.00"]);
});

test("linesFromBoxes splits a box that holds a label and its amount, and keeps two columns apart", () => {
  const boxes = [box("Basic Pay 9,000.00", 20, 40, 300), box("SSS 400.00", 420, 40, 200), box("Rice 1,000.00", 20, 70, 300), box("Philhealth 250.00", 420, 70, 200)];
  const out = linesFromBoxes(boxes).split("\n");
  assert.deepEqual(out, ["Basic Pay 9,000.00", "SSS 400.00", "Rice 1,000.00", "Philhealth 250.00"]);
});

test("linesFromBoxes uses each amount once", () => {
  const out = linesFromBoxes([box("Basic", 20, 40, 100), box("Rice", 20, 42, 100), box("5,000.00", 400, 41, 90)]).split("\n");
  assert.equal(out.filter((l) => /5,000/.test(l)).length, 1);
  assert.equal(linesFromBoxes([]), "");
});

test("readPayslip copes with dotted thousands, a count times a rate, garbled labels and advances", () => {
  const r = readPayslip(["PHIL JAC INC", "Apr 16-30, 2026", "Total Salary 6.250.50", "Overtime 2.50 x 114.18", "555: 300.00", "Phitheahh 150.00", "Advances 200.00", "1/2 Day 125.00", "Net Pay 5,400.00"].join("\n"), "2026-05-02");
  assert.equal(r.printed_gross, 625050);
  assert.deepEqual(r.earnings.map((e) => [e.kind, e.amount]), [["overtime", 11418]]);
  const d = Object.fromEntries(r.deductions.map((x) => [x.kind, x.amount]));
  assert.deepEqual(d, { sss: 30000, philhealth: 15000, loan: 20000, absences: 12500 });
  assert.equal(r.printed_net, 540000);
});

test("a month whose letter was read as a digit (0ct, 5ep) is still a month", () => {
  assert.equal(readScan("SAMPLE STORE\nDate: 0ct 2, 2026\nTOTAL 150.00", "2026-10-20").date, "2026-10-02");
  assert.equal(readScan("SAMPLE STORE\nDate: 5ep 9, 2026\nTOTAL 150.00", "2026-10-20").date, "2026-09-09");
});

test("a payee after a To that the reader glued to the name is still found", () => {
  const r = readScan("Transaction Details\nPHP592.50\nFrom MariBank\nToSAMPLE SUPERMARKET\nTransaction Time 01 Oct 2026, 19:52", "2026-10-20");
  assert.equal(r.payee, "SAMPLE SUPERMARKET");
  assert.equal(r.amount, 59250);
});

test("a payslip whose figures and labels were misread letter for digit is still read", () => {
  const r = readPayslip(["Withnolding 1ax  7oo.00", "SSS 3oo.00", "PhnHeaitn 1oo.00", "Net Pay 10,3oo.00"].join("\n"), "2026-10-04");
  assert.deepEqual(Object.fromEntries(r.deductions.map((d) => [d.kind, d.amount])), { tax: 70000, sss: 30000, philhealth: 10000 });
  assert.equal(r.printed_net, 1030000);
});

test("linesFromBoxes reads 100:00 as an amount but leaves a clock time alone", () => {
  const out = linesFromBoxes([box("Pag-IBIG", 20, 40, 150), box("100:00", 400, 40, 90), box("Time", 20, 80, 100), box("19:52", 400, 80, 90)]);
  assert.match(out, /Pag-IBIG 100\.00/);
  assert.match(out, /19:52/);
  assert.ok(!/Time 19\.52/.test(out));
});

test("an employer read without the space after its comma gets it back", () => {
  assert.equal(readPayslip("PHIL SAMPLE,INC.\nPAYSLIP\nNet Pay 9,075.00", "2026-10-04").employer, "PHIL SAMPLE, INC.");
});

test("spaces the reader dropped: a date written 01Oct2026 and a payee after TOSAMPLE", () => {
  const r = readScan("Transaction Details\nPHP592.50\nFromMariBank\nTOSAMPLESUPERMARKET\nTransaction Time 01Oct2026, 19:52", "2026-10-20");
  assert.equal(r.date, "2026-10-01");
  assert.equal(r.payee, "SAMPLESUPERMARKET");
});

test("a bank screen that prints the name above its To label and a masked number under it", () => {
  const r = readScan("Transferred\nP2,690.00\nInstant\n1.SAMPLE PERSON\nTo\n·..1234\nSample Bank\nFrom\nAmount 2,690.00\nReference No.\nDate\n16 Sep 2026 at 18:24\nTransfer successful", "2026-10-04");
  assert.equal(r.payee, "SAMPLE PERSON");
  assert.equal(r.amount, 269000);
});

test("a corporate suffix alone is not a store name", () => {
  assert.notEqual(readScan("Inc\nOfficial Receipt\nTOTAL 150.00", "2026-10-04").payee, "Inc");
});

test("linesFromBoxes cleans a stray mark and a B read for 8 so the amount pairs with its label", () => {
  const out = linesFromBoxes([box("Sub-Total: 51.29", 20, 20, 250), box("：1.157.B4", 400, 60, 100), box("Bill Amount", 20, 60, 150)]);
  assert.match(out, /Bill Amount 1\.157\.84/);
  assert.equal(readScan("Billing Invoice\nMeralco\nBill Amount 1.157.84\nDue date Oct 10, 2026", "2026-10-04").amount, 115784);
});

test("a bank screen with the value above its label and a cashback line: the transaction amount is the total, the date is the transaction time", () => {
  const boxes = [box("PHP 834.67", 300, 20, 200), box("From", 20, 80, 80), box("SampleBank", 360, 80, 140), box("To", 20, 120, 40), box("SAMPLE STORE MALUGAY", 300, 120, 220),
    box("Transaction Amount", 20, 220, 260), box("PHP 834.67", 400, 220, 120), box("Cashback", 20, 260, 140), box("+PHP 8.35", 400, 260, 120),
    box("Transaction Type", 20, 340, 220), box("Credit Card Transaction", 300, 340, 220), box("Transaction Time", 20, 380, 220), box("02 0ct 2026. 21:16", 300, 380, 220), box("Posted Time", 20, 420, 160), box("04 0ct 2026. 01:00", 300, 420, 220)];
  const text = linesFromBoxes(boxes);
  assert.match(text, /Transaction Amount PHP 834\.67/);
  assert.match(text, /Cashback \+PHP 8\.35/);
  const r = readScan(text, "2026-10-04");
  assert.equal(r.amount, 83467);
  assert.equal(r.date, "2026-10-02");
  assert.equal(r.creditCard, true);
});

test("a bank screen read with the spaces dropped: the amount, the date and the time are still found", () => {
  const text = "Transaction Details\nPHP834.67\nFrom\nSampleBank\nTo\nSAMPLESTOREMALUGAY\nTransactionAmountPHP834.67\nCashback+PHP8.35\nCreditCardTransaction\nTransactionType\nTransactionTime020ct2026,21:16\nPostedTime04.0ct2026.01:00";
  const r = readScan(text, "2026-10-04");
  assert.equal(r.amount, 83467);
  assert.equal(r.date, "2026-10-02");
  assert.equal(r.creditCard, true);
  assert.deepEqual(r.notes, []);
});

test("a payslip whose period is printed over its label, read with the spaces dropped", () => {
  const r = readPayslip("SAMPLE CONSULTANCY\nNet Pay: 1,000.00\nGross Pay: 1,200.00\nAugust13.2026 toAugust25.2026\nCovered Period:", "2026-10-04");
  assert.equal(r.period_from, "2026-08-13");
  assert.equal(r.period_to, "2026-08-25");
  const glued = readPayslip("Net Pay: 1,000.00\nDecember26,2025toJanuary12,2026\nCovered Period:", "2026-10-04");
  assert.equal(glued.period_from, "2025-12-26");
  assert.equal(glued.period_to, "2026-01-12");
});

test("an electricity bill that also prints a TIN is a bill, not a receipt", () => {
  assert.equal(readScan("SAMPLE POWER COOP\nBILLING INVOICE\nTIN\nMeter No 123\nSub-Total: 10.00\nBill Amount 1,157.84", "2026-10-04").kind, "bill");
});

// A payslip with two columns (earnings left, deductions right) photographed on a slant. Every figure is invented.
const slantedSlip = (ownOffset = 4) => {
  const t = -0.05, at = (x, y, w, text, dy = 0) => box(text, x, y + dy, w, t);
  return [
    at(20, 300, 150, "Basic Salary"), at(300, 300, 80, "5,000.00"), at(500, 300, 170, "Withholding Tax"), at(800, 300, 70, "400.00"),
    at(20, 340, 150, "Clothing Allowance"), at(300, 340, 80, "3 000.00", ownOffset), at(500, 340, 170, "Pag-lbig Premium Cont"), at(800, 340, 70, "100.00"),
    at(20, 380, 200, "Transportation Allowance"), at(300, 380, 80, "2,000.00", ownOffset), at(500, 380, 170, "Absences"), at(800, 380, 70, "250.00"),
    at(20, 420, 150, "Gross Earnings"), at(300, 420, 80, "10-000-00"), at(500, 420, 170, "Total Deductions"), at(800, 420, 70, "750.00"),
    at(20, 460, 200, "NET PAYABLE"), at(300, 460, 80, "9,250.00"),
  ];
};

test("a payslip on a slant: a label takes its own figure, not the same slanted row's figure of the other column", () => {
  const text = linesFromBoxes(slantedSlip());
  assert.match(text, /Clothing Allowance 3,000\.00/);
  assert.match(text, /Transportation Allowance 2,000\.00/);
  const r = readPayslip(text, "2026-10-04");
  assert.equal(r.earnings.find((l) => l.kind === "clothing").amount, 300000);
  assert.equal(r.earnings.reduce((n, l) => n + l.amount, 0), 1000000, "the earnings add to the printed gross");
  assert.equal(r.printed_gross, 1000000, "a figure written 10-000-00 is 10,000.00");
  assert.equal(r.deductions.reduce((n, l) => n + l.amount, 0), 75000, "the deductions add to the printed total");
  assert.deepEqual(r.notes.filter((n) => !/pay date/.test(n)), [], "nothing is flagged as missing or not adding up");
});

test("a payslip label the reader misspelled still counts: Paa-lbig is Pag-IBIG, Ahsences is Absences", () => {
  const r = readPayslip("Withholding Tax 400.00\nPaa-lbig Premium Cont 100.00\nAhsences 250.00\nTotal Deductions 750.00\nBasic Salary 10,000.00\nGross Earnings 10,000.00\nNet Pay 9,250.00", "2026-10-04");
  assert.deepEqual(r.deductions.map((l) => l.kind), ["tax", "pagibig", "absences"]);
});

test("when the lines read do not add to the printed total deductions, the gap is said in plain words", () => {
  const r = readPayslip("Withholding Tax 400.00\nTotal Deductions 750.00\nBasic Salary 10,000.00\nGross Earnings 10,000.00\nNet Pay 9,250.00", "2026-10-04");
  assert.equal(r.printed_deductions, 75000);
  assert.ok(r.notes.some((n) => /total deductions is ₱750\.00 but the lines I read add to ₱400\.00, so ₱350\.00 is missing/.test(n)), r.notes.join(" | "));
});

test("a year followed by a time is not a figure", () => {
  assert.equal(readScan("Paid 04 Oct 2026.01:00\n120.50", "2026-10-04").amount, 12050);
});

test("a cashback or reward line is never taken as the amount", () => {
  assert.equal(readScan("Transaction Details\nTransaction Amount\nCashback +PHP 8.35\nFrom MariBank\nPHP 834.67", "2026-10-04").amount, 83467);
});
