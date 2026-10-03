import { test } from "node:test";
import assert from "node:assert/strict";
import { planExpense, applyDrafts, discardDraft, verifyDraft, editDraftFields, planAttachment, attachmentsFor, planPayReceived, validateState } from "../src/model/index.js";
import { makeState } from "./fixtures.js";

const NOW = new Date("2026-10-18T04:00:00Z");
function photoDraft(extra = {}) {
  const s = makeState();
  const p = planExpense(s, { transaction_id: "tx1", date: "2026-10-18", payee: "Sample Burger", category_id: "food", amount: 15000, account_id: "chk", source: "photo", ...extra }, NOW);
  assert.ok(p.ok, JSON.stringify(p.violations));
  return applyDrafts(s, p.drafts);
}

test("a photo expense is a draft that records it has not been edited yet", () => {
  const s = photoDraft();
  const t = s.transactions[0];
  assert.equal(t.status, "draft");
  assert.equal(t.source, "photo");
  assert.equal(t.edited_before_verify, false);
  assert.deepEqual(validateState(s), []);
});
test("fixing the amount, name, date, category or account of a photo draft marks it edited; saving it unchanged does not", () => {
  const s = photoDraft();
  assert.equal(editDraftFields(s, "tx1", {}).state.transactions[0].edited_before_verify, false);
  for (const change of [{ amount: 14000 }, { payee: "Other" }, { date: "2026-10-17" }, { account_id: "card" }]) {
    const r = editDraftFields(s, "tx1", change);
    assert.ok(r.ok, JSON.stringify(change) + JSON.stringify(r.violations));
    assert.equal(r.state.transactions[0].edited_before_verify, true, JSON.stringify(change));
    assert.equal(r.state.transactions[0].source, "photo");
  }
});
test("once edited, a photo draft stays marked edited even if the value is put back", () => {
  let s = editDraftFields(photoDraft(), "tx1", { amount: 14000 }).state;
  s = editDraftFields(s, "tx1", { amount: 15000 }).state;
  assert.equal(s.transactions[0].edited_before_verify, true);
});
test("a photo draft verifies like any other", () => {
  const r = verifyDraft(photoDraft(), "tx1", NOW);
  assert.ok(r.ok);
  assert.equal(r.state.transactions[0].status, "verified");
});
test("an attachment row records the photo; it needs a real transaction", () => {
  const s = photoDraft();
  const a = planAttachment(s, { id: "att1", transaction_id: "tx1" }, NOW);
  assert.ok(a.ok);
  assert.deepEqual(attachmentsFor(a.state, "tx1").map((x) => x.id), ["att1"]);
  assert.deepEqual(validateState(a.state), []);
  assert.equal(planAttachment(s, { id: "att2", transaction_id: "nope" }, NOW).ok, false);
});
test("editing a draft keeps its photo", () => {
  const withPhoto = planAttachment(photoDraft(), { id: "att1", transaction_id: "tx1" }, NOW).state;
  const r = editDraftFields(withPhoto, "tx1", { amount: 14000 });
  assert.deepEqual(attachmentsFor(r.state, "tx1").map((x) => x.id), ["att1"]);
});
test("deleting a draft removes its attachment row", () => {
  const withPhoto = planAttachment(photoDraft(), { id: "att1", transaction_id: "tx1" }, NOW).state;
  const gone = discardDraft(withPhoto, "tx1").state;
  assert.equal(gone.attachments.length, 0);
  assert.equal(gone.transactions.length, 0);
});
test("a scanned payslip becomes an income DRAFT with its own name, and the amount stays editable", () => {
  const s = makeState();
  const p = planPayReceived(s, { transaction_id: "tx2", date: "2026-10-15", amount: 1120000, account_id: "chk", source: "photo", payee: "Sample Co payslip" }, NOW);
  assert.ok(p.ok);
  assert.equal(p.transaction.status, "draft");
  assert.equal(p.transaction.edited_before_verify, false);
  assert.equal(p.transaction.verified_at, undefined);
  const fixed = editDraftFields(applyDrafts(s, [p]), "tx2", { amount: 1100000 });
  assert.ok(fixed.ok, JSON.stringify(fixed.violations));
  assert.equal(fixed.state.transactions[0].edited_before_verify, true);
  assert.equal(fixed.state.entries.find((e) => e.account_id === "chk").amount, 1100000);
});
test("typed pay is unchanged: verified at once, called Pay received", () => {
  const p = planPayReceived(makeState(), { transaction_id: "tx3", date: "2026-10-15", amount: 100000, account_id: "chk" }, NOW);
  assert.equal(p.transaction.status, "verified");
  assert.equal(p.transaction.payee, "Pay received");
});
