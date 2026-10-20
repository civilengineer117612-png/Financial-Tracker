import { test } from "node:test";
import assert from "node:assert/strict";
import { planExpense, applyDrafts, verifyDraft, planCheckIn, planCorrection, applyCorrection, dayTotal, spendingByCategory, autoFillSurvey } from "../src/model/index.js";
import { makeState } from "./fixtures.js";

// Invented data. A count that found 120.00 MORE than the ledger (a negative Unlogged entry), then cancelled at the Weekly review, twice over.
const NOW = new Date("2026-10-09T12:00:00+08:00"), TODAY = "2026-10-09";
function counted() {
  let s = makeState();
  s = { ...s, categories: [...s.categories, { id: "unl", name: "Unlogged", kind: "expense" }] };
  s = applyDrafts(s, planExpense(s, { transaction_id: "lunch", date: "2026-10-09", payee: "Corner Cafe", category_id: "food", amount: 5000, account_id: "chk" }, NOW).drafts);
  s = verifyDraft(s, "lunch", NOW).state;
  return s;
}
function count(s, id, counted_balance) {
  const p = planCheckIn(s, { id: "chk" + id, transaction_id: "cnt" + id, date: TODAY, account_id: "chk", counted_balance, unlogged_category_id: "unl" }, NOW);
  return { ...s, checkIns: [...(s.checkIns ?? []), p.checkIn], transactions: [...s.transactions, p.transaction], entries: [...s.entries, ...p.entries] };
}
const cancel = (s, id) => applyCorrection(s, planCorrection(s, { id, redo_id: "redo" + id, today: TODAY }, NOW));

test("cancelling a count that found money does not show that money as spent today", () => {
  let s = count(counted(), "1", 120000);   // ledger 950.00, counted 1,200.00: 250.00 found
  assert.equal(dayTotal(s, TODAY).total, 5000, "the count itself is not spending");
  s = cancel(s, "cnt1");
  assert.equal(dayTotal(s, TODAY).total, 5000, "and neither is the entry that cancels it");
  s = cancel(count(s, "2", 120000), "cnt2");   // again, as the owner did
  assert.equal(dayTotal(s, TODAY).total, 5000, "cancelling twice changes nothing");
  assert.equal(spendingByCategory(s, { month: "2026-10" }).total, 5000, "the month agrees with the day");
});

test("cancelling a count that found money MISSING does not show it as spent today either", () => {
  let s = count(counted(), "1", 80000);   // ledger 950.00, counted 800.00: 150.00 missing
  assert.equal(dayTotal(s, TODAY).total, 5000);
  s = cancel(s, "cnt1");
  assert.equal(dayTotal(s, TODAY).total, 5000);
});

test("a cancelled ordinary entry still nets to zero in the day total (both sides count)", () => {
  const s = cancel(counted(), "lunch");
  assert.equal(dayTotal(s, TODAY).verified, 0);
});

test("the weekly survey does not count a count that was put right as a missed entry", () => {
  let s = count(counted(), "1", 80000);
  const week = { unlogged_category_id: "unl", week_start: "2026-10-04", week_end: "2026-10-10" };
  assert.equal(autoFillSurvey(s, week).q1_missed_count, 1);
  s = cancel(s, "cnt1");
  assert.equal(autoFillSurvey(s, week).q1_missed_count, 0);
});
