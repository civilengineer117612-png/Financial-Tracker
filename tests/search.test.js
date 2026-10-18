import { test } from "node:test";
import assert from "node:assert/strict";
import { searchEntries } from "../src/model/index.js";
import { makeState, account, tx, entry, commit } from "./fixtures.js";

// Invented entries only.
function ledger() {
  const s = makeState();
  s.accounts.push(account({ id: "wal", name: "Test Wallet", class: "asset", opening_balance: 500000 }));
  s.categories.push({ id: "rent", name: "Rent", kind: "expense" }, { id: "fun", name: "Fun", kind: "expense" });
  const add = (id, date, payee, cat, amount, acct = "wal", memo = "") => commit(s, { transaction: tx({ id, date, payee, memo, status: "verified" }), entries: [entry({ transaction_id: id, category_id: cat, amount }), entry({ transaction_id: id, account_id: acct, amount: -amount })] });
  add("a", "2026-10-03", "Sample Cafe", "food", 24500);
  add("b", "2026-10-05", "Landlord", "rent", 800000, "wal", "October rent");
  add("c", "2026-09-20", "Sample Cinema", "fun", 124500);
  add("d", "2026-10-09", "Sample Grocer", "food", 150000);
  return s;
}
const ids = (r) => r.rows.map((t) => t.id).join();

test("every word must be found: payee, note, category, account, date or amount", () => {
  const s = ledger();
  assert.equal(ids(searchEntries(s, "cafe")), "a");
  assert.equal(ids(searchEntries(s, "october rent")), "b", "the note");
  assert.equal(ids(searchEntries(s, "fun")), "c", "the category");
  assert.equal(ids(searchEntries(s, "wallet cinema")), "c", "two words, the account and the payee");
  assert.equal(ids(searchEntries(s, "sept 20")), "c", "a word is found inside a longer one");
  assert.equal(ids(searchEntries(s, "september 20")), "c", "the date in words");
  assert.equal(ids(searchEntries(s, "cafe cinema")), "", "all words, not any");
});
test("an amount is found as 245, 245.00 and, over a thousand, with or without the comma", () => {
  const s = ledger();
  assert.equal(ids(searchEntries(s, "245.00")), "a");
  assert.equal(ids(searchEntries(s, "1,245.00")), "c");
  assert.equal(ids(searchEntries(s, "1245")), "c");
  assert.equal(ids(searchEntries(s, "8000")), "b");
});
test("newest first, limited, with the full count; a period and a skip rule narrow it; an empty search finds nothing", () => {
  const s = ledger();
  const all = searchEntries(s, "sample");
  assert.equal(ids(all), "d,a,c");
  const one = searchEntries(s, "sample", { limit: 1 });
  assert.deepEqual([ids(one), one.total], ["d", 3]);
  assert.equal(ids(searchEntries(s, "sample", { from: "2026-10-01", to: "2026-10-31" })), "d,a");
  assert.equal(ids(searchEntries(s, "sample", { skip: (t) => t.id === "d" })), "a,c");
  assert.deepEqual(searchEntries(s, "   "), { rows: [], total: 0 });
});
