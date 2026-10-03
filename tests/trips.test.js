import { test } from "node:test";
import assert from "node:assert/strict";
import { planTag, tagSummary, planExpense, applyDrafts } from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

function s0() {
  const s = makeState();
  s.accounts.push(account({ id: "cash", name: "Test Cash", class: "asset", opening_balance: 10000000 }));
  s.categories.push({ id: "fare", name: "Fares", kind: "expense" });
  s.tags = [];
  return s;
}
const verify = (s) => ({ ...s, transactions: s.transactions.map((t) => ({ ...t, status: "verified", verified_at: t.created_at })) });
const spend = (s, id, cat, amount, tag_id) => {
  const r = planExpense(s, { transaction_id: id, date: "2026-10-05", category_id: cat, amount, account_id: "cash", ...(tag_id ? { tag_id } : {}) });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  return applyDrafts(s, r.drafts);
};

test("a trip is a unique, named tag with an optional non-negative budget", () => {
  const r = planTag(s0(), { id: "t1", name: " Test Trip ", budget: 500000 });
  assert.deepEqual([r.ok, r.tag.name, r.state.tags.length], [true, "Test Trip", 1]);
  for (const [o, code] of [[{ name: " " }, "BAD_NAME"], [{ id: "t1" }, "DUPLICATE_ID"], [{ id: "t2", name: "test TRIP" }, "DUPLICATE_NAME"], [{ id: "t2", name: "B", budget: -1 }, "BAD_BUDGET"], [{ id: "t2", name: "B", budget: 1.5 }, "BAD_BUDGET"]]) {
    assert.equal(planTag(r.state, { id: "t2", name: "Other", ...o }).violations[0].code, code);
  }
  assert.equal("budget" in planTag(s0(), { id: "t3", name: "No budget" }).tag, false);
});
test("an expense can carry a trip tag, and an unknown tag is refused", () => {
  const s = planTag(s0(), { id: "t1", name: "Trip" }).state;
  const ok = planExpense(s, { transaction_id: "a", date: "2026-10-05", category_id: "fare", amount: 1000, account_id: "cash", tag_id: "t1" });
  assert.equal(ok.drafts[0].transaction.tag_id, "t1");
  const bad = planExpense(s, { transaction_id: "a", date: "2026-10-05", category_id: "fare", amount: 1000, account_id: "cash", tag_id: "nope" });
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].code, "UNKNOWN_TAG");
});
test("a trip summary counts only verified, tagged spending, by category, with a budget grade", () => {
  let s = planTag(s0(), { id: "t1", name: "Trip", budget: 100000 }).state;
  s = spend(s, "a", "fare", 60000, "t1");
  s = spend(s, "b", "food", 30000, "t1");
  s = spend(s, "c", "fare", 999, null);          // not on the trip
  s = verify(s);
  s = spend(s, "d", "fare", 4000, "t1");         // a draft on the trip
  const sum = tagSummary(s, "t1");
  assert.deepEqual([sum.spent, sum.pending, sum.budget], [90000, 4000, 100000]);
  assert.deepEqual(sum.rows.map((r) => [r.name, r.amount]), [["Fares", 60000], ["Food", 30000]]);
  assert.equal(sum.grade.level, "serious", "90% of the budget is used");
  assert.equal(tagSummary(s, "nope"), null);
  assert.equal(tagSummary(planTag(s0(), { id: "t9", name: "Free" }).state, "t9").grade, null, "no budget, no grade");
});
