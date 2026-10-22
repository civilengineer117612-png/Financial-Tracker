import { test } from "node:test";
import assert from "node:assert/strict";
import { spendingTransactions, spendingByRange, spendingByAccount } from "../src/model/index.js";
import { makeState, commit, tx } from "./fixtures.js";

const opts = { from: "2026-01-01", to: "2026-12-31", asOf: "2026-10-22", categoryMaps: [{ from: "old-food", to: "food", effective_from: "2026-01-01" }] };
const sample = () => {
  const s = makeState();
  s.categories.push({ id: "old-food", name: "Old food", kind: "expense" }, { id: "travel", name: "Travel", kind: "expense" });
  const add = (id, date, entries, extra = {}) => commit(s, { transaction: tx({ id, date, status: "verified", verified_at: "2026-10-22T08:00:00.000+08:00", ...extra }), entries: entries.map((e) => ({ transaction_id: id, ...e })) });
  add("split", "2026-03-12", [{ category_id: "food", amount: 20000 }, { category_id: "travel", amount: 10000 }, { account_id: "chk", amount: -30000 }]);
  add("refund", "2026-03-15", [{ category_id: "food", amount: -5000 }, { account_id: "chk", amount: 5000 }]);
  add("merged", "2026-04-01", [{ category_id: "old-food", amount: 4000 }, { account_id: "card", amount: -4000, card_state: "posted" }]);
  add("draft", "2026-04-02", [{ category_id: "food", amount: 1000 }, { account_id: "chk", amount: -1000 }], { status: "draft", verified_at: undefined });
  add("outside", "2025-12-31", [{ category_id: "food", amount: 7000 }, { account_id: "chk", amount: -7000 }]);
  add("pay", "2026-03-10", [{ category_id: "pay", amount: -80000 }, { account_id: "chk", amount: 80000 }]);
  add("move", "2026-03-11", [{ account_id: "res", amount: 6000 }, { account_id: "chk", amount: -6000 }]);
  add("found-money", "2026-03-14", [{ category_id: "food", amount: -8000 }, { account_id: "chk", amount: 8000 }], { adjustment: "found" });
  return s;
};
test("category details equal the chart, including merged categories, refunds, and split portions", () => {
  const s = sample(), chart = spendingByRange(s, opts);
  for (const row of chart.rows) {
    const details = spendingTransactions(s, { ...opts, category_id: row.category_id });
    assert.equal(details.total, row.amount);
    assert.equal(details.rows.reduce((sum, row) => sum + row.amount, 0), row.amount);
  }
  const r = spendingTransactions(s, { ...opts, category_id: "food" });
  assert.deepEqual(r.rows.map((row) => [row.transaction.id, row.amount]), [["merged", 4000], ["refund", -5000], ["split", 20000]]);
});
test("account details equal the account total and omit income, moves, drafts, and found-money adjustments", () => {
  const s = sample();
  for (const row of spendingByAccount(s, opts).rows) assert.equal(spendingTransactions(s, { ...opts, account_id: row.account_id }).total, row.amount);
  assert.deepEqual(spendingTransactions(s, { ...opts, account_id: "chk" }).rows.map((row) => row.transaction.id), ["refund", "split"]);
});
test("month and custom period bounds, reversals, and a negative row reconcile exactly", () => {
  const s = sample();
  commit(s, { transaction: tx({ id: "reversal", date: "2026-03-16", status: "verified", reverses: "split", verified_at: "2026-03-16T08:00:00.000+08:00" }), entries: [{ transaction_id: "reversal", category_id: "food", amount: -20000 }, { transaction_id: "reversal", category_id: "travel", amount: -10000 }, { transaction_id: "reversal", account_id: "chk", amount: 30000 }] });
  const bounds = { ...opts, from: "2026-03-12", to: "2026-03-16" };
  assert.equal(spendingTransactions(s, { ...bounds, category_id: "food" }).total, -5000);
  for (const row of spendingByRange(s, bounds).rows) assert.equal(spendingTransactions(s, { ...bounds, category_id: row.category_id }).total, row.amount);
  assert.deepEqual(spendingTransactions(s, { ...opts, category_id: "missing" }), { total: 0, rows: [] });
});
