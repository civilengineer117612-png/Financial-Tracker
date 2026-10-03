import { test } from "node:test";
import assert from "node:assert/strict";
import { homeSummary } from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

// All figures invented. Oct 2026 is the month; the card is a liability.
const FROM = "2026-10-01", TO = "2026-10-31";
let n = 0;
function add(s, date, rows, status = "verified") {
  const id = "t" + ++n;
  s.transactions.push({ id, date, payee: "", memo: "", status, source: "manual", created_at: "2026-10-01T00:00:00+08:00", ...(status === "verified" ? { verified_at: "2026-10-01T00:00:00+08:00" } : {}) });
  for (const r of rows) s.entries.push({ transaction_id: id, ...r });
}
function ledger() {
  const s = makeState();
  s.accounts.push(account({ id: "sav", name: "Test Savings", class: "asset" }), account({ id: "wal", name: "Test Wallet", class: "asset" }));
  s.categories.push({ id: "refund", name: "Refund", kind: "income" });
  s.goals = [{ id: "g1", account_id: "sav", name: "Test Goal", hidden_by_default: false }];
  return s;
}

test("IN, SPENT, SAVED and LEFT for a month", () => {
  const s = ledger();
  add(s, "2026-10-02", [{ account_id: "chk", amount: 1000000 }, { category_id: "pay", amount: -1000000 }]);   // pay in
  add(s, "2026-10-03", [{ category_id: "food", amount: 20000 }, { account_id: "wal", amount: -20000 }]);   // cash spent
  add(s, "2026-10-04", [{ category_id: "food", amount: 30000 }, { account_id: "card", amount: -30000 }]);   // spent by credit card
  add(s, "2026-10-05", [{ account_id: "sav", amount: 200000 }, { account_id: "chk", amount: -200000 }]);   // saved into a goal
  add(s, "2026-10-06", [{ account_id: "wal", amount: 50000 }, { account_id: "chk", amount: -50000 }]);   // own-account transfer
  add(s, "2026-10-07", [{ account_id: "card", amount: 30000 }, { account_id: "chk", amount: -30000 }]);   // card bill paid
  add(s, "2026-10-08", [{ account_id: "chk", amount: 5000 }, { category_id: "refund", amount: -5000 }]);   // refund received
  const r = homeSummary(s, { from: FROM, to: TO });
  assert.deepEqual([r.in, r.spent, r.saved, r.left], [1005000, 50000, 200000, 755000]);
  assert.equal(r.left, r.in - r.spent - r.saved);
});
test("a credit card purchase is SPENT when bought; paying the card bill is not SPENT again", () => {
  const s = ledger();
  add(s, "2026-10-04", [{ category_id: "food", amount: 30000 }, { account_id: "card", amount: -30000 }]);
  assert.equal(homeSummary(s, { from: FROM, to: TO }).spent, 30000);
  add(s, "2026-10-20", [{ account_id: "card", amount: 30000 }, { account_id: "chk", amount: -30000 }]);
  assert.equal(homeSummary(s, { from: FROM, to: TO }).spent, 30000);
});
test("moving money between own accounts is neither IN nor SPENT, and not SAVED unless it enters a goal", () => {
  const s = ledger();
  add(s, "2026-10-06", [{ account_id: "wal", amount: 50000 }, { account_id: "chk", amount: -50000 }]);
  assert.deepEqual(homeSummary(s, { from: FROM, to: TO }), { in: 0, spent: 0, saved: 0, left: 0, drafts: 0 });
});
test("pay that lands straight in a goal's account is income, not saving; spending from it is spending", () => {
  const s = ledger();
  add(s, "2026-10-02", [{ account_id: "sav", amount: 400000 }, { category_id: "pay", amount: -400000 }]);
  add(s, "2026-10-03", [{ category_id: "food", amount: 10000 }, { account_id: "sav", amount: -10000 }]);
  const r = homeSummary(s, { from: FROM, to: TO });
  assert.deepEqual([r.in, r.spent, r.saved], [400000, 10000, 0]);
});
test("taking money out of a goal reduces SAVED; a move between two goals nets to nothing", () => {
  const s = ledger();
  s.accounts.push(account({ id: "sav2", name: "Test Goal 2 Pocket", class: "asset" }));
  s.goals.push({ id: "g2", account_id: "sav2", name: "Goal 2", hidden_by_default: false });
  add(s, "2026-10-05", [{ account_id: "sav", amount: 100000 }, { account_id: "chk", amount: -100000 }]);
  add(s, "2026-10-06", [{ account_id: "sav2", amount: 30000 }, { account_id: "sav", amount: -30000 }]);
  assert.equal(homeSummary(s, { from: FROM, to: TO }).saved, 100000);
  add(s, "2026-10-07", [{ account_id: "chk", amount: 20000 }, { account_id: "sav", amount: -20000 }]);
  assert.equal(homeSummary(s, { from: FROM, to: TO }).saved, 80000);
});
test("only verified entries inside the month count; drafts are only counted", () => {
  const s = ledger();
  add(s, "2026-10-03", [{ category_id: "food", amount: 20000 }, { account_id: "wal", amount: -20000 }], "draft");
  add(s, "2026-09-30", [{ category_id: "food", amount: 99000 }, { account_id: "wal", amount: -99000 }]);
  add(s, "2026-11-01", [{ category_id: "food", amount: 99000 }, { account_id: "wal", amount: -99000 }]);
  assert.deepEqual(homeSummary(s, { from: FROM, to: TO }), { in: 0, spent: 0, saved: 0, left: 0, drafts: 1 });
});
test("a month with nothing in it is all zeros, not an error", () => {
  assert.deepEqual(homeSummary(ledger(), { from: FROM, to: TO }), { in: 0, spent: 0, saved: 0, left: 0, drafts: 0 });
});
