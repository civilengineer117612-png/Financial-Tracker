import { test } from "node:test";
import assert from "node:assert/strict";
import { planCheckIn, unloggedTotal, naturalBalance, cardOutstanding } from "../src/model/index.js";
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
