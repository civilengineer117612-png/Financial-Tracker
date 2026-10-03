import { test } from "node:test";
import assert from "node:assert/strict";
import { planSplitExpense, applyDrafts, verifyDraft, spendingByRange, validateState, defaultCategories, budgetStatus, editDraftFields } from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

const NOW = new Date("2026-10-18T04:00:00Z");   // invented figures
function ledger() {
  const s = makeState();
  s.categories = defaultCategories();
  s.accounts.push(account({ id: "wal", name: "Test Wallet", class: "asset" }));
  return s;
}
const split = (s, over = {}) => planSplitExpense(s, { transaction_id: "tx1", date: "2026-10-18", payee: "Sample Mart", account_id: "wal", source: "photo",
  lines: [{ category_id: "cat-food", amount: 6000 }, { category_id: "cat-essentials", amount: 3500 }], ...over }, NOW);

test("one receipt, two categories: the account is charged the total once and each category gets its part", () => {
  const s = ledger(), r = split(s);
  assert.ok(r.ok, JSON.stringify(r.violations));
  const t = r.drafts[0], next = applyDrafts(s, r.drafts);
  assert.equal(t.entries.reduce((n, e) => n + e.amount, 0), 0);
  assert.deepEqual(t.entries.filter((e) => e.category_id).map((e) => [e.category_id, e.amount]), [["cat-food", 6000], ["cat-essentials", 3500]]);
  assert.equal(t.entries.find((e) => e.account_id === "wal").amount, -9500);
  assert.equal(t.transaction.status, "draft");
  assert.equal(t.transaction.edited_before_verify, false);
  assert.deepEqual(validateState(next), []);
});
test("after verifying, each category's spending shows only its own part", () => {
  const s = ledger(), drafted = applyDrafts(s, split(s).drafts), v = verifyDraft(drafted, "tx1", NOW);
  assert.ok(v.ok);
  const by = Object.fromEntries(spendingByRange(v.state, { from: "2026-10-01", to: "2026-10-31" }).rows.map((r) => [r.category_id, r.amount]));
  assert.deepEqual([by["cat-food"], by["cat-essentials"]], [6000, 3500]);
  assert.equal(spendingByRange(v.state, { from: "2026-10-01", to: "2026-10-31" }).total, 9500);
});
test("a split paid by a card with a reserve makes its reserve transfer for the whole amount", () => {
  const s = ledger();
  const r = planSplitExpense(s, { transaction_id: "tx2", date: "2026-10-18", payee: "", account_id: "card", source: "manual", reserve_source_id: "chk",
    lines: [{ category_id: "cat-food", amount: 6000 }, { category_id: "cat-essentials", amount: 4000 }] }, NOW);
  assert.ok(r.ok, JSON.stringify(r.violations));
  assert.equal(r.drafts.length, 2);
  assert.equal(r.drafts[1].entries.find((e) => e.amount > 0).amount, 10000);
});
test("bad splits are refused with a reason", () => {
  const s = ledger();
  for (const [over, code] of [[{ lines: [{ category_id: "cat-food", amount: 9500 }] }, "BAD_SPLIT"],
    [{ lines: [{ category_id: "cat-food", amount: 5000 }, { category_id: "cat-food", amount: 4500 }] }, "BAD_SPLIT"],
    [{ lines: [{ category_id: "cat-food", amount: 0 }, { category_id: "cat-essentials", amount: 9500 }] }, "BAD_SPLIT"],
    [{ lines: [{ category_id: "cat-food", amount: 5000 }, { category_id: "cat-salary", amount: 4500 }] }, "UNKNOWN_CATEGORY"],
    [{ account_id: "nope" }, "UNKNOWN_ACCOUNT"]]) {
    const r = split(s, over);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.violations[0].code, code, JSON.stringify(over));
  }
});
test("a split draft's date and name can be fixed, its parts cannot be changed by accident, and a photo split counts as edited when fixed", () => {
  const s = ledger(), drafted = applyDrafts(s, split(s).drafts);
  const fixed = editDraftFields(drafted, "tx1", { payee: "Other Mart" });
  assert.ok(fixed.ok, JSON.stringify(fixed.violations));
  assert.equal(fixed.state.transactions[0].edited_before_verify, true);
  assert.equal(fixed.state.entries.filter((e) => e.category_id).length, 2);
  assert.equal(editDraftFields(drafted, "tx1", { amount: 5000 }).ok, false);
});
