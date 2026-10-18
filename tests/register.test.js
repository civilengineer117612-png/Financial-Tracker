import { test } from "node:test";
import assert from "node:assert/strict";
import { accountRegister, naturalBalance, cardOutstanding, countedEntries } from "../src/model/index.js";
import { makeState, account, tx, entry, commit, cardPurchase } from "./fixtures.js";

// Invented: a wallet that began on Jan 1 with 1,000.00.
function ledger() {
  const s = makeState();
  s.accounts.push(account({ id: "wal", name: "Test Wallet", class: "asset", opening_balance: 100000, opening_date: "2026-01-01" }));
  s.categories.push({ id: "pay", name: "Pay", kind: "income" });
  const spend = (id, date, amount, o = {}) => commit(s, { transaction: tx({ id, date, status: o.status ?? "verified", created_at: date + "T" + (o.at ?? "09") + ":00:00.000+08:00" }), entries: [entry({ transaction_id: id, category_id: "food", amount }), entry({ transaction_id: id, account_id: "wal", amount: -amount })] });
  spend("a", "2026-01-05", 20000); spend("b", "2026-01-03", 5000);
  commit(s, { transaction: tx({ id: "inc", date: "2026-01-10", status: "verified" }), entries: [entry({ transaction_id: "inc", category_id: "pay", amount: -300000 }), entry({ transaction_id: "inc", account_id: "wal", amount: 300000 })] });
  spend("old", "2025-12-20", 99999);   // before the account began: not counted
  spend("dr", "2026-01-12", 1000, { status: "draft" });
  return s;
}

test("opening balance, then each entry in date order with the balance after it; the last balance is the account's balance", () => {
  const s = ledger(), r = accountRegister(s, "wal");
  assert.deepEqual(r.rows.map((x) => x.transaction.id), ["b", "a", "inc", "dr"]);
  assert.deepEqual(r.rows.map((x) => x.change), [-5000, -20000, 300000, -1000]);
  assert.deepEqual(r.rows.map((x) => x.balance), [95000, 75000, 375000, 374000]);
  assert.equal(r.opening, 100000);
  assert.equal(r.closing, naturalBalance(s.accounts.find((a) => a.id === "wal"), countedEntries(s)));
});
test("two entries on one day keep the order they were made in", () => {
  const s = ledger();
  commit(s, { transaction: tx({ id: "z2", date: "2026-01-20", created_at: "2026-01-20T09:00:00.000+08:00", status: "verified" }), entries: [entry({ transaction_id: "z2", category_id: "food", amount: 200 }), entry({ transaction_id: "z2", account_id: "wal", amount: -200 })] });
  commit(s, { transaction: tx({ id: "z1", date: "2026-01-20", created_at: "2026-01-20T08:00:00.000+08:00", status: "verified" }), entries: [entry({ transaction_id: "z1", category_id: "food", amount: 100 }), entry({ transaction_id: "z1", account_id: "wal", amount: -100 })] });
  assert.deepEqual(accountRegister(s, "wal").rows.slice(-2).map((x) => x.transaction.id), ["z1", "z2"]);
});
test("a card shows what is owed: a purchase raises it, a payment lowers it, pending is marked, and the end matches cardOutstanding", () => {
  const s = makeState();
  commit(s, cardPurchase("p1", 50000, "posted")); commit(s, cardPurchase("p2", 20000, "pending", { date: "2026-01-06" }));
  commit(s, { transaction: tx({ id: "pay", date: "2026-01-09", status: "verified" }), entries: [entry({ transaction_id: "pay", account_id: "chk", amount: -30000 }), entry({ transaction_id: "pay", account_id: "card", amount: 30000, card_state: "posted" })] });
  const r = accountRegister(s, "card");
  assert.deepEqual(r.rows.map((x) => [x.change, x.balance, x.pending]), [[50000, 50000, false], [20000, 70000, true], [-30000, 40000, false]]);
  assert.equal(r.closing, cardOutstanding(s.accounts.find((a) => a.id === "card"), s.entries).total);
});
test("an unknown account has no register", () => assert.equal(accountRegister(makeState(), "nope"), null));
