import { test } from "node:test";
import assert from "node:assert/strict";
import { planCheckIn, pendingPurchases, unloggedTotal, naturalBalance, cardOutstanding } from "../src/model/index.js";
import { makeState, account, tx, entry, commit, reserveSetAside, cardPurchase } from "./fixtures.js";

// Invented data: a wallet with a ledger balance of 1,000.00.
function walletState() {
  const s = makeState();
  s.accounts.push(account({ id: "cash", name: "Test Cash", class: "asset", opening_balance: 100000 }));
  s.categories.push({ id: "unlogged", name: "Unlogged", kind: "expense" });
  return s;
}
const input = (o) => ({ id: "ci1", transaction_id: "rec1", date: "2026-01-10", account_id: "cash", counted_balance: 100000, unlogged_category_id: "unlogged", ...o });
const save = (s, p) => commit(s, p);

test("count matches the ledger: check-in recorded, no reconciliation entry", () => {
  const p = planCheckIn(walletState(), input());
  assert.equal(p.ok, true);
  assert.equal(p.transaction, null);
  assert.deepEqual(p.checkIn, { id: "ci1", date: "2026-01-10", account_id: "cash", counted_balance: 100000, ledger_balance: 100000, difference: 0 });
});

test("less cash than the ledger: shortfall posts to Unlogged as spending", () => {
  const s = walletState();
  const p = planCheckIn(s, input({ counted_balance: 95000 }));
  assert.equal(p.ok, true);
  assert.equal(p.checkIn.difference, -5000);
  assert.equal(p.transaction.source, "reconciliation");
  assert.equal(p.transaction.status, "verified");
  save(s, p);
  assert.equal(naturalBalance(s.accounts.find((a) => a.id === "cash"), s.entries), 95000);   // ledger now equals the count
  assert.equal(unloggedTotal(s, "unlogged", "2026-01-01", "2026-01-31"), 5000);
});

test("more cash than the ledger: unexplained gain, Unlogged goes negative", () => {
  const s = walletState();
  const p = planCheckIn(s, input({ counted_balance: 102500 }));
  save(s, p);
  assert.equal(naturalBalance(s.accounts.find((a) => a.id === "cash"), s.entries), 102500);
  assert.equal(unloggedTotal(s, "unlogged", "2026-01-01", "2026-01-31"), -2500);
});

test("the reconciliation transaction balances and passes the normal save checks", () => {
  const p = planCheckIn(walletState(), input({ counted_balance: 95000 }));
  assert.equal(p.entries.reduce((a, e) => a + e.amount, 0), 0);
  assert.deepEqual(p.violations, []);
});

test("a second check-in after correcting finds nothing left to reconcile", () => {
  const s = walletState();
  save(s, planCheckIn(s, input({ counted_balance: 95000 })));
  const again = planCheckIn(s, input({ id: "ci2", transaction_id: "rec2", counted_balance: 95000 }));
  assert.equal(again.transaction, null);
  assert.equal(again.checkIn.difference, 0);
});

test("card: bank shows more POSTED owed than the ledger (interest or fee)", () => {
  const s = walletState();
  commit(s, reserveSetAside("r", 50000));
  commit(s, cardPurchase("a", 20000, "posted"));
  commit(s, cardPurchase("b", 7000, "pending"));
  const p = planCheckIn(s, input({ account_id: "card", counted_balance: 20300 }));   // bank posted: 203.00
  assert.equal(p.checkIn.ledger_balance, 20000);   // posted only; the pending 70.00 is not compared
  assert.equal(p.checkIn.difference, 300);
  assert.equal(p.entries[0].card_state, "posted");
  save(s, p);
  assert.deepEqual(cardOutstanding(s.accounts[2], s.entries), { posted: 20300, pending: 7000, total: 27300 });
  assert.equal(unloggedTotal(s, "unlogged", "2026-01-01", "2026-01-31"), 300);   // only the fee; Food purchases are not Unlogged
});

test("a card reconciliation that pushes outstanding above the reserve warns, not blocks", () => {
  const s = walletState();
  commit(s, reserveSetAside("r", 20000));
  commit(s, cardPurchase("a", 20000, "posted"));
  const p = planCheckIn(s, input({ account_id: "card", counted_balance: 20500 }));
  assert.equal(p.ok, true);
  assert.equal(p.violations[0].code, "RESERVE_BELOW_OUTSTANDING");
  assert.equal(p.violations[0].shortfall, 500);
});

test("unlogged total only covers the requested dates", () => {
  const s = walletState();
  save(s, planCheckIn(s, input({ counted_balance: 95000 })));
  save(s, planCheckIn(s, input({ id: "ci2", transaction_id: "rec2", date: "2026-01-17", counted_balance: 93000 })));
  assert.equal(unloggedTotal(s, "unlogged", "2026-01-01", "2026-01-12"), 5000);
  assert.equal(unloggedTotal(s, "unlogged", "2026-01-13", "2026-01-20"), 2000);
  assert.equal(unloggedTotal(s, "unlogged", "2026-01-01", "2026-01-31"), 7000);
});

test("bad input is reported, not thrown", () => {
  const s = walletState();
  assert.equal(planCheckIn(s, input({ account_id: "nope" })).violations[0].code, "UNKNOWN_ACCOUNT");
  assert.equal(planCheckIn(s, input({ unlogged_category_id: "nope" })).violations[0].code, "UNKNOWN_CATEGORY");
  const frac = planCheckIn(s, input({ counted_balance: 950.5 }));
  assert.equal(frac.ok, false);
  assert.equal(frac.violations[0].code, "SHAPE");
});

// Invented card: one pending purchase of 1,000.00 that the bank already shows as posted.
function cardWithPending() {
  const s = walletState();
  s.accounts.push(account({ id: "card", name: "Test Card", class: "liability" }));
  commit(s, cardPurchase("c1", 100000, "pending"));
  commit(s, cardPurchase("c2", 25000, "pending"));
  return s;
}
const cardInput = (o) => input({ account_id: "card", counted_balance: 100000, ...o });

test("card count: a purchase the bank already shows is moved to posted, not counted twice", () => {
  const s = cardWithPending();
  const p = planCheckIn(s, cardInput({ basis: "posted", posted_tx_ids: ["c1"] }));
  assert.equal(p.ok, true);
  assert.equal(p.checkIn.difference, 0);          // the 1,000.00 is explained by the ticked purchase
  assert.equal(p.transaction, null);              // so nothing goes to Unlogged
  commit(s, p.posting);
  const card = s.accounts.find((a) => a.id === "card");
  assert.deepEqual(cardOutstanding(card, s.entries), { posted: 100000, pending: 25000, total: 125000 });   // what you owe did not change
  assert.deepEqual(p.posting.entries.reduce((a, e) => a + e.amount, 0), 0);
});

test("card count: the same purchase is not offered twice, and not ticked it still shows as the difference", () => {
  const s = cardWithPending(), card = s.accounts.find((a) => a.id === "card");
  assert.deepEqual(pendingPurchases(s, card).map((x) => x.transaction_id).sort(), ["c1", "c2"]);
  commit(s, planCheckIn(s, cardInput({ basis: "posted", posted_tx_ids: ["c1"] })).posting);
  assert.deepEqual(pendingPurchases(s, card).map((x) => x.transaction_id), ["c2"]);
  const p = planCheckIn(s, cardInput({ id: "ci2", transaction_id: "rec2", counted_balance: 130000, basis: "posted" }));
  assert.equal(p.checkIn.difference, 30000);       // posted 100,000 in the ledger, 130,000 at the bank: 300.00 is unexplained
});

test("card count on the total owed: pending charges count, no double entry", () => {
  const s = cardWithPending();
  const p = planCheckIn(s, cardInput({ basis: "owed", counted_balance: 125000 }));
  assert.equal(p.checkIn.ledger_balance, 125000);
  assert.equal(p.checkIn.difference, 0);
  const q = planCheckIn(s, cardInput({ basis: "owed", counted_balance: 130000 }));
  assert.equal(q.checkIn.difference, 5000);
  commit(s, q);
  assert.equal(cardOutstanding(s.accounts.find((a) => a.id === "card"), s.entries).total, 130000);
});

test("only a card has pending purchases", () => {
  const s = cardWithPending();
  assert.deepEqual(pendingPurchases(s, s.accounts.find((a) => a.id === "cash")), []);
});

test("the posting entry pair passes the same save-time checks as any transaction", async () => {
  const { checkTransactionSave } = await import("../src/model/index.js");
  const s = cardWithPending();
  const p = planCheckIn(s, cardInput({ basis: "posted", posted_tx_ids: ["c1", "c2"], counted_balance: 125000 }));
  const r = checkTransactionSave(s, p.posting);
  assert.deepEqual(r.violations.filter((v) => v.severity === "error"), []);
});
