import { test } from "node:test";
import assert from "node:assert/strict";
import { rowGroup, defaultCategories } from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

function ledger() {
  const s = makeState();
  s.categories = [...defaultCategories(), { id: "mine", name: "My own", kind: "expense" }];
  s.accounts.push(account({ id: "sav", name: "Test Savings", class: "asset" }), account({ id: "sav2", name: "Test Savings Two", class: "asset" }));
  s.goals = [{ id: "g", account_id: "sav", name: "Test Goal", hidden_by_default: false }, { id: "g2", account_id: "sav2", name: "Goal Two", hidden_by_default: false }];
  return s;
}
let n = 0;
const add = (s, rows) => { const id = "t" + ++n, t = { id, date: "2026-10-01", payee: "", status: "verified" }; s.transactions.push(t); for (const r of rows) s.entries.push({ transaction_id: id, ...r }); return t; };

test("Rent and Food are fixed costs; the other spending categories, and any of your own, are everyday", () => {
  const s = ledger();
  for (const [cat, group] of [["cat-rent", "fixed"], ["cat-food", "fixed"], ["cat-lakat", "everyday"], ["cat-family", "everyday"], ["cat-shopping", "everyday"], ["cat-essentials", "everyday"], ["cat-upskill", "everyday"], ["cat-subscription", "everyday"], ["mine", "everyday"]]) {
    assert.equal(rowGroup(s, add(s, [{ category_id: cat, amount: 100 }, { account_id: "chk", amount: -100 }])), group, cat);
  }
});
test("money moved into a goal is its own group; money taken out of a goal, other transfers, income and Unlogged have none", () => {
  const s = ledger();
  assert.equal(rowGroup(s, add(s, [{ account_id: "sav", amount: 500 }, { account_id: "chk", amount: -500 }])), "goals");
  assert.equal(rowGroup(s, add(s, [{ account_id: "chk", amount: 500 }, { account_id: "sav", amount: -500 }])), null, "a withdrawal");
  assert.equal(rowGroup(s, add(s, [{ account_id: "sav2", amount: 500 }, { account_id: "sav", amount: -500 }])), null, "goal to goal nets to nothing");
  assert.equal(rowGroup(s, add(s, [{ account_id: "card", amount: 500 }, { account_id: "chk", amount: -500 }])), null, "a card bill payment");
  assert.equal(rowGroup(s, add(s, [{ account_id: "chk", amount: 500 }, { category_id: "cat-salary", amount: -500 }])), null, "income");
  assert.equal(rowGroup(s, add(s, [{ category_id: "cat-unlogged", amount: 500 }, { account_id: "chk", amount: -500 }])), null, "Unlogged");
});
