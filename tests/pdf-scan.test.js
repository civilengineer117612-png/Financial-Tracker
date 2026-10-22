import { test } from "node:test";
import assert from "node:assert/strict";
import { pdfScanText, readPayslip, readScan } from "../src/model/scan.js";

// Invented values only. The coordinates reproduce tables with headings above
// their values and hours before earnings, rather than any employer's document.
const piece = (str, x, y, w = 65) => ({ str, x, y, w, h: 10 });
test("a PDF payslip pairs summary and date columns, and reads money rather than hours", () => {
  const text = pdfScanText([
    piece("SAMPLE SERVICES INC", 30, 740, 180), piece("Payslip", 30, 720),
    piece("Payment Date", 30, 680), piece("Pay Begin Date", 180, 680), piece("Pay End Date", 330, 680),
    piece("20-Oct-2026", 30, 660), piece("01-Oct-2026", 180, 660), piece("15-Oct-2026", 330, 660),
    piece("Gross", 100, 620), piece("Pre-Tax", 200, 620), piece("Taxes", 300, 620), piece("Net Pay", 400, 620),
    piece("Current", 20, 600), piece("8,000.00", 100, 600), piece("400.00", 200, 600), piece("200.00", 300, 600), piece("7,400.00", 400, 600),
    piece("Description", 30, 550), piece("Hours", 160, 550), piece("Amount", 240, 550), piece("Description", 340, 550), piece("Amount", 490, 550),
    piece("Regular", 30, 530), piece("64.00", 160, 530), piece("8,000.00", 240, 530), piece("SSS", 340, 530), piece("400.00", 490, 530),
    piece("Tax Deduction", 340, 510, 110), piece("200.00", 490, 510),
  ]);
  const slip = readPayslip(text, "2026-10-22");
  assert.equal(slip.printed_gross, 800000);
  assert.equal(slip.printed_net, 740000);
  assert.equal(slip.pay_date, "2026-10-20");
  assert.equal(slip.period_from, "2026-10-01");
  assert.equal(slip.period_to, "2026-10-15");
  assert.deepEqual(slip.earnings, [{ kind: "basic", amount: 800000 }]);
  assert.deepEqual(slip.deductions, [{ kind: "sss", amount: 40000 }, { kind: "tax", amount: 20000 }]);
});

test("a PDF receipt still reads the total and its date", () => {
  const text = pdfScanText([piece("SAMPLE STORE", 20, 700), piece("Official Receipt", 20, 680), piece("Date: Oct 20, 2026", 20, 660, 120), piece("TOTAL", 20, 640), piece("250.00", 150, 640)]);
  const receipt = readScan(text, "2026-10-22");
  assert.equal(receipt.kind, "receipt");
  assert.equal(receipt.amount, 25000);
  assert.equal(receipt.date, "2026-10-20");
  assert.equal(pdfScanText([]), "");
});

test("a PDF payslip can keep explicitly printed dates from previous years", () => {
  const text = "Payslip\nPay period Jan 1, 2023 to Jan 15, 2023\nPay date Jan 20, 2023\nNet pay 1000.00";
  const slip = readPayslip(text, "2026-10-22", { allowHistorical: true });
  assert.equal(slip.period_from, "2023-01-01");
  assert.equal(slip.period_to, "2023-01-15");
  assert.equal(slip.pay_date, "2023-01-20");
});
