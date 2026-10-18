import { test } from "node:test";
import assert from "node:assert/strict";
import { overdrawOf, goalProgress, goalSlices } from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

const spend = (s, id, acct, amount) => {
  s.transactions.push({ id, date: "2026-02-01", payee: "x", memo: "", status: "verified", source: "manual", created_at: "2026-02-01T09:00:00.000+08:00", verified_at: "2026-02-01T09:00:00.000+08:00" });
  s.entries.push({ transaction_id: id, category_id: "food", amount }, { transaction_id: id, account_id: acct, amount: -amount });
};

test("a spend that would take a debit account below zero is flagged, with the balance now and after", () => {
  const s = makeState();   // Test Checking holds 100000
  const w = overdrawOf(s, { account_id: "chk", amount: 150000 });
  assert.deepEqual([w.before, w.amount, w.after, w.name], [100000, 150000, -50000, "Test Checking"]);
});
test("a spend that fits, or exactly empties the account, is not flagged", () => {
  const s = makeState();
  assert.equal(overdrawOf(s, { account_id: "chk", amount: 100000 }), null);
  assert.equal(overdrawOf(s, { account_id: "chk", amount: 1 }), null);
});
test("earlier spending counts, and so does a draft", () => {
  const s = makeState(); spend(s, "t1", "chk", 90000);
  assert.equal(overdrawOf(s, { account_id: "chk", amount: 10001 }).after, -1);
  assert.equal(overdrawOf(s, { account_id: "chk", amount: 10000 }), null);
  s.transactions[s.transactions.length - 1].status = "draft";
  assert.ok(overdrawOf(s, { account_id: "chk", amount: 10001 }), "a draft already took the money");
});
test("a credit card may go negative, an unknown account or a zero amount is never flagged", () => {
  const s = makeState();
  assert.equal(overdrawOf(s, { account_id: "card", amount: 99999999 }), null);
  assert.equal(overdrawOf(s, { account_id: "nope", amount: 5 }), null);
  assert.equal(overdrawOf(s, { account_id: "chk", amount: 0 }), null);
});
test("a goal on an overdrawn account holds nothing: never a minus, alone or sharing", () => {
  const s = makeState(); spend(s, "t1", "chk", 117170 + 100000);   // the account is at -117170
  const g = { id: "g", account_id: "chk", name: "Test Goal", target: 100000, hidden_by_default: false };
  assert.equal(goalProgress(s, g).balance, 0);
  const g2 = { ...g, id: "g2" };
  s.goals = [g, g2];
  assert.deepEqual([...goalSlices(s, s.accounts[0]).values()].map((x) => x.balance), [0, 0]);
});
