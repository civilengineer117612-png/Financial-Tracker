import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planCheckIn, planEnvelopeSetup, emergencyFundFromBudgets, countedEntries, earlyEntryChanges, naturalBalance, cardOutstanding, goalProgress, accountsOverview, ledgerBalanceFor, spendingByCategory } from "../src/model/index.js";
import { makeState, account, tx } from "./fixtures.js";

// Invented numbers only. The wallet was added on Oct 5 with P1,000.00 in it ("How much is in it today").
function ledger() {
  const s = makeState();
  s.accounts = [account({ id: "w", name: "Test Wallet", class: "asset", opening_balance: 100000, opening_date: "2026-10-05" }),
    account({ id: "b", name: "Test Bank", class: "asset", opening_balance: 500000, opening_date: "2026-09-01" }),
    account({ id: "cc", name: "Test Card", class: "liability", opening_balance: 0, opening_date: "2026-10-05" })];
  s.categories = [{ id: "food", name: "Food", kind: "expense" }];
  const spend = (id, date, acct, amount) => { s.transactions.push(tx({ id, date, status: "verified" })); s.entries.push({ transaction_id: id, category_id: "food", amount }, { transaction_id: id, account_id: acct, amount: -amount }); };
  spend("old", "2026-10-02", "w", 20000);      // before the wallet was added: already inside the P1,000
  spend("same", "2026-10-05", "w", 3000);      // the day it was added: counted (the safer mistake)
  spend("new", "2026-10-06", "w", 5000);       // after: counted
  spend("bank", "2026-10-02", "b", 7000);      // the bank was added in September, so Oct 2 is after its start: counted
  spend("ccold", "2026-10-01", "cc", 9000);    // a card purchase before the card was added
  // a transfer dated Oct 3: from the bank (counted, after its start) to the wallet (not counted, before the wallet's start)
  s.transactions.push(tx({ id: "move", date: "2026-10-03", status: "verified" })); s.entries.push({ transaction_id: "move", account_id: "b", amount: -10000 }, { transaction_id: "move", account_id: "w", amount: 10000 });
  return s;
}

test("an account's balance skips spending dated before the day it was added, and counts that day and after", () => {
  const s = ledger(), c = countedEntries(s), w = s.accounts[0];
  assert.equal(naturalBalance(w, c), 100000 - 3000 - 5000);
  assert.equal(naturalBalance(w, s.entries), 100000 - 20000 - 3000 - 5000 + 10000, "without the rule it would be taken off twice");
});

test("each account has its own start: the same day can be history for one and count for another (a transfer)", () => {
  const s = ledger(), c = countedEntries(s);
  assert.equal(naturalBalance(s.accounts[1], c), 500000 - 7000 - 10000, "the bank counts both its Oct 2 spending and its side of the Oct 3 transfer");
  assert.equal(naturalBalance(s.accounts[0], c), 92000, "the wallet's side of the transfer is before its start");
});

test("cards follow the same rule", () => {
  const s = ledger();
  assert.equal(cardOutstanding(s.accounts[2], countedEntries(s)).total, 0);
  assert.equal(cardOutstanding(s.accounts[2], s.entries).total, 9000);
});

test("history keeps every entry: spending reports still show the early ones", () => {
  const s = ledger();
  assert.equal(spendingByCategory(s, { month: "2026-10" }).total, 20000 + 3000 + 5000 + 7000 + 9000);
  assert.equal(countedEntries(s).filter((e) => e.category_id).length, s.entries.filter((e) => e.category_id).length, "category sides are never dropped");
});

test("balances everywhere use the rule: accounts overview, goals and the weekly check", () => {
  const s = ledger();
  s.goals = [{ id: "g", account_id: "w", name: "Pocket", hidden_by_default: true }];
  assert.equal(accountsOverview(s, { from: "2026-10-01", to: "2026-10-31" }).money.find((m) => m.account_id === "w").balance, 92000);
  assert.equal(goalProgress(s, s.goals[0]).balance, 92000);
  assert.equal(ledgerBalanceFor(s.accounts[0], countedEntries(s)), 92000);
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  assert.ok(!/M\.naturalBalance\([^)]*S\(\)\.entries\)/.test(app) && !/M\.reserveShortfalls\(S\(\)\.accounts, S\(\)\.entries\)/.test(app), "the screens never total raw entries for a balance");
});

test("the one-time note lists the accounts whose balance the rule changes, and by how much", () => {
  const s = ledger();
  assert.deepEqual(earlyEntryChanges(s), [{ account_id: "w", name: "Test Wallet", by: 20000 - 10000 }, { account_id: "cc", name: "Test Card", by: -9000 }]);
  const clean = makeState(); clean.accounts = [account({ id: "x", name: "X", class: "asset", opening_date: "2026-01-01" })];
  assert.deepEqual(earlyEntryChanges(clean), []);
});

test("an entry with no date found, or an account with no start date, still counts (nothing is dropped by accident)", () => {
  const s = ledger(); s.transactions = s.transactions.filter((t) => t.id !== "old");
  assert.ok(countedEntries(s).some((e) => e.transaction_id === "old"));
  const t = ledger(); t.accounts[0] = { ...t.accounts[0], opening_date: undefined };
  assert.equal(naturalBalance(t.accounts[0], countedEntries(t)), naturalBalance(t.accounts[0], t.entries));
});

test("the answer is recomputed when the data changes (never a stale cached balance)", () => {
  const s = ledger(), first = countedEntries(s);
  assert.equal(countedEntries(s), first, "same data: the same list");
  const moved = { ...s, accounts: s.accounts.map((a) => (a.id === "w" ? { ...a, opening_date: "2026-09-01" } : a)) };
  assert.equal(naturalBalance(moved.accounts[0], countedEntries(moved)), 100000 - 20000 - 3000 - 5000 + 10000);
});

test("the weekly check compares the bank with the counted balance: the right figure matches with nothing to add", () => {
  const s = ledger(); s.categories.push({ id: "cat-unlogged", name: "Unlogged", kind: "expense" }); s.checkIns = [];
  const r = planCheckIn(s, { id: "ci", transaction_id: "tci", date: "2026-10-07", account_id: "w", counted_balance: 92000, unlogged_category_id: "cat-unlogged" });
  assert.equal(r.ok, true); assert.equal(r.transaction, null, "P920.00 in the wallet matches: no Unlogged entry");
});

test("the Emergency Fund and the envelopes read the counted balance too", () => {
  const s = ledger();
  const e = emergencyFundFromBudgets({ ...s, rules: [{ id: "r", kind: "budget", subject_id: "food", amount: 100000, effective_from: "2026-10-01", created_at: "2026-10-01T08:00:00.000+08:00" }],
    categories: [{ id: "food", name: "Food", kind: "expense", role: "food" }] }, { id: "g", account_id: "w", name: "EF", hidden_by_default: true }, { month: "2026-10" });
  assert.equal(e.balance, 92000);
  s.envelopes = [];
  const env = planEnvelopeSetup(s, { gcash_account_id: "w", allowance_amount: 95000, buffer_amount: 0, allowance_envelope_id: "e1", buffer_envelope_id: "e2" });
  assert.equal(env.violations[0].code, "MORE_THAN_HELD", "P950 is more than the P920 counted");
  const fits = planEnvelopeSetup(s, { gcash_account_id: "w", allowance_amount: 90000, buffer_amount: 0, allowance_envelope_id: "e1", buffer_envelope_id: "e2", transaction_ids: ["tx-a", "tx-b"], date: "2026-10-07" });
  assert.ok(!fits.violations?.some((v) => v.code === "MORE_THAN_HELD"), "P900 fits in the P920 counted (it would not fit the P820 of the old, wrong total)");
});
