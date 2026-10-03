import { test } from "node:test";
import assert from "node:assert/strict";
import { readScan, wordsToCentavos } from "../src/model/index.js";

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
