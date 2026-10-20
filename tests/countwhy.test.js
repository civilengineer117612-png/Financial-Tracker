import { test } from "node:test";
import assert from "node:assert/strict";
import { planExpense, applyDrafts, verifyDraft, planCheckIn, planCheckInWithMove, spendingByCategory, spendingByAccount, dailySpending, naturalBalance, countedEntries } from "../src/model/index.js";
import { spendingByPayee } from "../src/model/payees.js";
import { makeState } from "./fixtures.js";

// Invented data. Checking holds 1,000.00 less a 120.00 lunch (880.00 by the ledger); a second wallet "res" holds 0.
const NOW = new Date("2026-10-08T12:00:00+08:00");
function ledger() {
  let s = makeState();
  s = { ...s, categories: [...s.categories, { id: "unl", name: "Unlogged", kind: "expense" }] };
  s = applyDrafts(s, planExpense(s, { transaction_id: "lunch", date: "2026-10-08", payee: "Corner Cafe", category_id: "food", amount: 12000, account_id: "chk" }, NOW).drafts);
  return verifyDraft(s, "lunch", NOW).state;
}
const count = (s, counted, why) => planCheckIn(s, { id: "c1", transaction_id: "cnt", date: "2026-10-09", account_id: "chk", counted_balance: counted, unlogged_category_id: "unl", why }, NOW);
const apply = (s, p) => ({ ...s, checkIns: [...(s.checkIns ?? []), p.checkIn], transactions: [...s.transactions, ...(p.transaction ? [p.transaction] : [])], entries: [...s.entries, ...p.entries] });
const spent = (s) => spendingByCategory(s, { month: "2026-10" }).total;

test("just match it, with MORE money than the ledger: the count is an adjustment, so spending does not go down", () => {
  const s = ledger(), p = count(s, 100000, "match");   // 1,000.00 counted, 880.00 in the ledger
  assert.ok(p.ok); assert.equal(p.checkIn.difference, 12000); assert.equal(p.checkIn.matched, true); assert.equal(p.transaction.adjustment, true);
  const next = apply(s, p);
  assert.equal(spent(next), 12000, "spending is still the lunch");
  assert.equal(spendingByAccount(next, { month: "2026-10" }).total, 12000);
  assert.equal(dailySpending(next, { from: "2026-10-01", to: "2026-10-31" }).get("2026-10-09"), undefined, "no spending line on the count's day");
  assert.equal(spendingByPayee(next, null, { from: "2026-10-01", to: "2026-10-31" }).rows?.length ?? spendingByPayee(next, null, { from: "2026-10-01", to: "2026-10-31" }).length, 1, "the count is not a payee");
  assert.equal(naturalBalance(next.accounts.find((a) => a.id === "chk"), countedEntries(next)), 100000, "the balance matches the count");
});

test("without just match it, MORE money still lowers spending (the old behaviour, e.g. a plain count)", () => {
  const s = ledger(), p = count(s, 100000, undefined);
  assert.equal(p.transaction.adjustment, undefined); assert.equal(p.checkIn.matched, undefined);
  assert.equal(spent(apply(s, p)), 0);
});

test("just match it, with LESS money than the ledger: still unlogged spending, and the count says it was matched", () => {
  const s = ledger(), p = count(s, 70000, "match");   // 700.00 counted, 880.00 in the ledger
  assert.equal(p.checkIn.difference, -18000); assert.equal(p.checkIn.matched, true); assert.equal(p.transaction.adjustment, undefined);
  assert.equal(spent(apply(s, p)), 12000 + 18000, "the 180.00 that left is spending nobody logged");
});

test("a gap explained as a move makes a move DRAFT and the count then matches: no gap entry, no spending change", () => {
  const s = ledger();
  const r = planCheckInWithMove(s, { id: "c1", transaction_id: "cnt", date: "2026-10-09", account_id: "chk", counted_balance: 100000, unlogged_category_id: "unl" }, { account_id: "res", move_id: "mv1" }, NOW);
  assert.ok(r.ok, JSON.stringify(r.violations)); assert.equal(r.plan.checkIn.difference, 0); assert.equal(r.plan.transaction, null);
  const mv = r.state.transactions.find((t) => t.id === "mv1"), es = r.state.entries.filter((e) => e.transaction_id === "mv1");
  assert.equal(mv.status, "draft");
  assert.deepEqual(es.map((e) => [e.account_id, e.amount]).sort(), [["chk", 12000], ["res", -12000]], "120.00 moved in from the other account");
  assert.equal(spent(r.state), 12000, "spending is untouched");
  const out = planCheckInWithMove(s, { id: "c2", transaction_id: "cnt2", date: "2026-10-09", account_id: "chk", counted_balance: 70000, unlogged_category_id: "unl" }, { account_id: "res", move_id: "mv2" }, NOW);
  assert.deepEqual(out.state.entries.filter((e) => e.transaction_id === "mv2").map((e) => [e.account_id, e.amount]).sort(), [["chk", -18000], ["res", 18000]], "money that left went to the other account");
  assert.equal(planCheckInWithMove(s, { id: "c3", transaction_id: "cnt3", date: "2026-10-09", account_id: "chk", counted_balance: 100000, unlogged_category_id: "unl" }, { account_id: "chk", move_id: "mv3" }, NOW).ok, false, "not the same account");
  assert.equal(planCheckInWithMove(s, { id: "c4", transaction_id: "cnt4", date: "2026-10-09", account_id: "chk", counted_balance: 88000, unlogged_category_id: "unl" }, { account_id: "res", move_id: "mv4" }, NOW).ok, false, "no gap, nothing to explain");
});
