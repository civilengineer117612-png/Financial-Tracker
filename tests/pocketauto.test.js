import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, planPocketFromStatement, isPocket, accountByLast4 } from "../src/model/index.js";

// Invented accounts only.
const base = () => ({ ...emptyState(), accounts: [{ id: "main", name: "GoTyme", class: "asset", role: "", hidden_by_default: false, archived: false, opening_balance: 100000, opening_date: "2026-01-01", bank: "gotyme", last4: "1111" }] });

test("a pocket is made from its statement: a pocket of its bank, its digits kept, nothing in it yet", () => {
  const r = planPocketFromStatement(base(), { id: "p1", last4: "3002", bank: "gotyme", date: "2026-03-01" });
  assert.equal(r.ok, true);
  assert.equal(r.account.name, "GoTyme · Go Save ····3002");
  assert.equal(isPocket(r.account), true);
  assert.equal(r.account.last4, "3002"); assert.equal(r.account.bank, "gotyme");
  assert.equal(r.account.opening_balance, 0); assert.equal(r.account.opening_date, "2026-03-01");
  assert.equal(r.state.accounts.length, 2); assert.equal(accountByLast4(r.state.accounts, "3002").id, "p1");
});

test("without a known bank it is still made, named by its digits", () => {
  const r = planPocketFromStatement(base(), { id: "p2", last4: "4004", date: "2026-03-01" });
  assert.equal(r.ok, true); assert.equal(r.account.name, "Go Save ····4004"); assert.equal(isPocket(r.account), true);
});

test("never twice for the same digits, never without four digits, and the old accounts are untouched", () => {
  const once = planPocketFromStatement(base(), { id: "p1", last4: "3002", bank: "gotyme", date: "2026-03-01" }).state;
  const again = planPocketFromStatement(once, { id: "p9", last4: "3002", bank: "gotyme", date: "2026-03-02" });
  assert.equal(again.ok, false); assert.match(again.violations[0].message, /already have an account ending in 3002/); assert.equal(once.accounts.length, 2);
  assert.equal(planPocketFromStatement(base(), { id: "p3", last4: "30", date: "2026-03-01" }).ok, false);
  assert.equal(planPocketFromStatement(base(), { id: "p3", last4: "1111", date: "2026-03-01" }).ok, false);   // a main account already ends so
  assert.deepEqual(base().accounts[0], once.accounts[0]);
});

test("two different numbers make two pockets", () => {
  let s = base();
  for (const [id, l4] of [["a", "3002"], ["b", "4004"]]) s = planPocketFromStatement(s, { id, last4: l4, bank: "gotyme", date: "2026-03-01" }).state;
  assert.equal(s.accounts.filter(isPocket).length, 2);
  assert.notEqual(s.accounts[1].name, s.accounts[2].name);
});
