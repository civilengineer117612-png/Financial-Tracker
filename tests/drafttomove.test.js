import { test } from "node:test";
import assert from "node:assert/strict";
import { planExpense, applyDrafts, verifyDraft, draftToMove, spendingByCategory, naturalBalance, countedEntries, checkTransactionSave } from "../src/model/index.js";
import { makeState } from "./fixtures.js";

// Invented data: a spending draft of 395.00 from the checking account that was really a withdrawal to the reserve account.
const NOW = new Date("2026-10-02T12:00:00+08:00");
function withDraft(extra = {}) {
  const s = makeState();
  const p = planExpense(s, { transaction_id: "atm", date: "2026-10-02", payee: "ATM", category_id: "food", amount: 39500, account_id: "chk" }, NOW);
  const st = applyDrafts(s, p.drafts);
  return { ...st, transactions: st.transactions.map((t) => (t.id === "atm" ? { ...t, ...extra } : t)) };
}

test("a spending draft becomes a move draft in its place: same id, date and name, no spending, still a draft", () => {
  const s = withDraft({ corrects: "old1", memo: "note" });
  const r = draftToMove(s, "atm", { from_account_id: "chk", to_account_id: "res" }, NOW);
  assert.ok(r.ok, JSON.stringify(r.violations));
  const t = r.state.transactions.find((x) => x.id === "atm"), es = r.state.entries.filter((e) => e.transaction_id === "atm");
  assert.equal(t.status, "draft"); assert.equal(t.date, "2026-10-02"); assert.equal(t.payee, "ATM");
  assert.equal(t.corrects, "old1", "it still says which cancelled entry it replaces"); assert.equal(t.memo, "note");
  assert.deepEqual(es.map((e) => [e.account_id, e.amount]).sort(), [["chk", -39500], ["res", 39500]]);
  assert.ok(es.every((e) => e.category_id == null), "no category: it is not spending");
  const v = verifyDraft(r.state, "atm", NOW).state;
  assert.equal(spendingByCategory(v, { month: "2026-10" }).total, 0, "verified, it counts as no spending");
  assert.equal(naturalBalance(v.accounts.find((a) => a.id === "res"), countedEntries(v)), 39500, "and the money arrives in the other account");
});

test("only a plain spending draft can become a move; a verified entry, a scheduled payment or the same account cannot", () => {
  assert.equal(draftToMove(withDraft({ schedule_id: "s1" }), "atm", { from_account_id: "chk", to_account_id: "res" }).ok, false);
  assert.equal(draftToMove(withDraft(), "atm", { from_account_id: "chk", to_account_id: "chk" }).ok, false);
  const verified = verifyDraft(withDraft(), "atm", NOW).state;
  assert.equal(draftToMove(verified, "atm", { from_account_id: "chk", to_account_id: "res" }).ok, false);
});
