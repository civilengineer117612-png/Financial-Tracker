import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, payeeKey, payeeLabel, withPayeeBook, spendingByPayee, payeeMonths, payeeCount, namePayee, categoryFromBook, spendingByRange, previewImport } from "../src/model/index.js";

// Invented people, numbers and amounts only.
const cats = [{ id: "cat-food", name: "Food", kind: "expense" }, { id: "cat-family", name: "Family", kind: "expense" }, { id: "cat-unlogged", name: "Unlogged", kind: "expense" }];
const acct = { id: "w", name: "Test Wallet", class: "asset", role: "", hidden_by_default: false, archived: false, opening_balance: 0, opening_date: "2020-01-01" };
let n = 0;
const pay = (date, payee, amount, category_id = "cat-unlogged", status = "verified") => {
  const id = "t" + ++n;
  return { t: { id, date, payee, status, source: "statement", created_at: "2026-10-16T09:00:00.000+08:00" }, e: [{ id: id + "a", transaction_id: id, account_id: "w", amount: -amount }, { id: id + "b", transaction_id: id, category_id, amount }] };
};
const build = (list) => ({ ...emptyState(), accounts: [acct], categories: cats, transactions: list.map((x) => x.t), entries: list.flatMap((x) => x.e) });
const S = () => build([
  pay("2026-08-02", "09851234999", 50000), pay("2026-09-03", "09851234999", 30000), pay("2026-09-20", "BDO Unibank, Inc. ending 1234", 20000),
  pay("2026-09-21", "Sample Shop", 10000, "cat-food"), pay("2026-09-22", "09851234999", 7000, "cat-unlogged", "draft"),
]);

test("a payee key ignores case and punctuation; a long number is shown by its first and last four digits", () => {
  assert.equal(payeeKey("BDO Unibank, Inc. ending 1234"), payeeKey("bdo unibank inc  ending 1234"));
  assert.equal(payeeLabel("09851234999"), "0985…4999");
  assert.equal(payeeLabel("Sample Shop"), "Sample Shop");
});

test("spending by payee: one row per payee, biggest first, verified only, with its count", () => {
  const rows = spendingByPayee(S(), {}, { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(rows.map((r) => [r.name, r.total, r.count]), [["0985…4999", 80000, 2], ["BDO Unibank, Inc. ending 1234", 20000, 1], ["Sample Shop", 10000, 1]]);
  assert.equal(rows[2].category_id, "cat-food", "a payee already in a category shows it");
});

test("naming a payee: its drafts in Unlogged move for real, verified ones only SHOW under the category; the stored entries stay", () => {
  const s = S(), key = payeeKey("09851234999");
  assert.equal(payeeCount(s, key), 3);
  const r = namePayee(s, {}, key, { name: "Sample Person", category_id: "cat-family" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.book[key], { name: "Sample Person", category_id: "cat-family" });
  const draftId = r.state.transactions.find((t) => t.status === "draft").id, firstId = r.state.transactions[0].id;
  const draftCat = r.state.entries.find((e) => e.transaction_id === draftId && e.category_id)?.category_id;
  assert.equal(draftCat, "cat-family", "the draft changed");
  assert.equal(r.state.entries.find((e) => e.transaction_id === firstId && e.category_id).category_id, "cat-unlogged", "the verified entry is final");
  const view = spendingByRange(withPayeeBook(r.state, r.book), { from: "2026-01-01", to: "2026-12-31" });
  assert.equal(view.rows.find((x) => x.category_id === "cat-family")?.amount, 80000, "the reports show it under Family");
  assert.equal(view.rows.find((x) => x.category_id === "cat-unlogged")?.amount, 20000, "an unnamed payee stays in Unlogged");
  assert.equal(view.total, spendingByRange(r.state, { from: "2026-01-01", to: "2026-12-31" }).total, "the total does not change");
  assert.equal(namePayee(s, {}, key, { name: "x", category_id: "cat-unlogged" }).ok, false, "a category is needed, and not Unlogged");
});

test("an entry with a real category keeps it, whatever the payee's name says", () => {
  const s = S(), book = { [payeeKey("Sample Shop")]: { category_id: "cat-family" } };
  const view = spendingByRange(withPayeeBook(s, book), { from: "2026-01-01", to: "2026-12-31" });
  assert.equal(view.rows.find((x) => x.category_id === "cat-food")?.amount, 10000);
});

test("payees with the same name are one person: one row, its accounts inside", () => {
  const book = { [payeeKey("09851234999")]: { name: "Mama", category_id: "cat-family" }, [payeeKey("BDO Unibank, Inc. ending 1234")]: { name: " mama ", category_id: "cat-family" } };
  const rows = spendingByPayee(S(), book, { from: "2026-01-01", to: "2026-12-31" });
  assert.equal(rows[0].name, "Mama"); assert.equal(rows[0].total, 100000); assert.equal(rows[0].members.length, 2);
  assert.deepEqual(rows[0].members.map((m) => m.total), [80000, 20000]);
  assert.equal(rows[0].category_id, "cat-family");
});

test("a payee month by month, and an import uses the name you gave", () => {
  const months = payeeMonths(S(), payeeKey("09851234999"), { endMonth: "2026-10", months: 3 });
  assert.deepEqual(months, [{ month: "2026-08", amount: 50000 }, { month: "2026-09", amount: 30000 }, { month: "2026-10", amount: 0 }]);
  const book = { [payeeKey("09851234999")]: { category_id: "cat-family" } };
  assert.equal(categoryFromBook(S(), book, "09851234999"), "cat-family");
  const p = previewImport(S(), [{ dateRaw: "2026-10-01", name: "09851234999", amount: 1000 }], "dmy", book);
  assert.deepEqual([p.lines[0].category_id, p.lines[0].how], ["cat-family", "your name for them"]);
});
