import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetStatus, pendingDrafts, verifyTransaction } from "../src/model/index.js";
import { makeState, tx, entry, commit, rule } from "./fixtures.js";

const VERIFIED = { status: "verified", verified_at: "2026-03-06T08:00:00.000+08:00" };
function spend(s, id, date, category, amt, extra = {}) {
  commit(s, { transaction: tx({ id, date, ...extra }), entries: [
    entry({ transaction_id: id, category_id: category, amount: amt }),
    entry({ transaction_id: id, account_id: "chk", amount: -amt }),
  ] });
}
const budgets = [rule({ id: "b1", subject_id: "food", amount: 40000, effective_from: "2026-01-01" })];
const run = (s, o = {}) => budgetStatus(s, { rules: budgets, month: "2026-03", asOf: "2026-03-31", ...o });
const food = (rows) => rows.find((r) => r.category_id === "food");

test("verified spending counts; drafts are shown as pending, not spent", () => {
  const s = makeState();
  spend(s, "a", "2026-03-05", "food", 9500, VERIFIED);
  spend(s, "b", "2026-03-06", "food", 2000);   // draft
  const f = food(run(s));
  assert.deepEqual([f.budget, f.spent, f.pending, f.remaining, f.over], [40000, 9500, 2000, 30500, false]);
});

test("only the requested month is counted", () => {
  const s = makeState();
  spend(s, "a", "2026-02-28", "food", 7000, VERIFIED);
  spend(s, "b", "2026-03-01", "food", 1000, VERIFIED);
  spend(s, "c", "2026-03-31", "food", 500, VERIFIED);
  spend(s, "d", "2026-04-01", "food", 9999, VERIFIED);
  assert.equal(food(run(s)).spent, 1500);
});

test("over budget is plain: negative remaining and over = true, never blocked", () => {
  const s = makeState();
  spend(s, "a", "2026-03-05", "food", 45000, VERIFIED);
  const f = food(run(s));
  assert.equal(f.remaining, -5000);
  assert.equal(f.over, true);
});

test("a refund (credit to the category) reduces spent", () => {
  const s = makeState();
  spend(s, "a", "2026-03-05", "food", 10000, VERIFIED);
  spend(s, "r", "2026-03-06", "food", -2500, VERIFIED);
  assert.equal(food(run(s)).spent, 7500);
});

test("income categories are not part of the budget", () => {
  const s = makeState();
  spend(s, "i", "2026-03-05", "pay", -100000, VERIFIED);
  assert.equal(run(s).find((r) => r.category_id === "pay"), undefined);
});

test("budget rule is the one in effect on the first day of the month", () => {
  const s = makeState();
  const rules = [...budgets, rule({ id: "b2", subject_id: "food", amount: 50000, effective_from: "2026-03-15" })];
  assert.equal(food(run(s, { rules })).budget, 40000);                         // mid-month change starts next month
  assert.equal(food(run(s, { rules, month: "2026-04", asOf: "2026-04-30" })).budget, 50000);
});

test("spending with no budget shows budget null", () => {
  const s = makeState();
  spend(s, "a", "2026-03-05", "food", 100, VERIFIED);
  const r = run(s, { rules: [] });
  assert.deepEqual([food(r).budget, food(r).remaining, food(r).over], [null, null, false]);
});

test("Option A: a merge regroups earlier months in a report run after it took effect", () => {
  const s = makeState();
  s.categories.push({ id: "breakfast2", name: "Break Fast", kind: "expense" });
  spend(s, "a", "2026-03-05", "breakfast2", 200, VERIFIED);
  spend(s, "b", "2026-03-06", "food", 300, VERIFIED);
  const maps = [{ from: "breakfast2", to: "food", effective_from: "2026-04-01" }];
  assert.equal(food(run(s, { categoryMaps: maps, asOf: "2026-04-15" })).spent, 500);   // March report run in April
  assert.equal(food(run(s, { categoryMaps: maps, asOf: "2026-03-31" })).spent, 300);   // run before the merge: separate
});

// ---------- verification inbox ----------
test("inbox lists drafts through a date, oldest first, with verified ones excluded", () => {
  const s = makeState();
  spend(s, "z", "2026-03-04", "food", 1);
  spend(s, "a", "2026-03-04", "food", 1);
  spend(s, "old", "2026-03-01", "food", 1);
  spend(s, "later", "2026-03-09", "food", 1);
  spend(s, "done", "2026-03-02", "food", 1, VERIFIED);
  assert.deepEqual(pendingDrafts(s, "2026-03-05").map((t) => t.id), ["old", "a", "z"]);
});

test("verifying a draft stamps verified_at in Philippine time and moves it into the budget", () => {
  const s = makeState();
  spend(s, "a", "2026-03-05", "food", 9500);
  assert.equal(food(run(s)).spent, 0);
  const v = verifyTransaction(s, "a", new Date("2026-03-06T00:00:00Z"));
  assert.equal(v.ok, true);
  assert.equal(v.transaction.status, "verified");
  assert.equal(v.transaction.verified_at, "2026-03-06T08:00:00.000+08:00");
  commit(s, { transaction: v.transaction, entries: s.entries.filter((e) => e.transaction_id === "a") });
  assert.equal(food(run(s)).spent, 9500);
  assert.equal(pendingDrafts(s, "2026-03-31").length, 0);
});

test("verifying twice or an unknown id is reported, not thrown", () => {
  const s = makeState();
  spend(s, "a", "2026-03-05", "food", 100, VERIFIED);
  assert.equal(verifyTransaction(s, "a").violations[0].code, "ALREADY_VERIFIED");
  assert.equal(verifyTransaction(s, "nope").violations[0].code, "UNKNOWN_TRANSACTION");
});

test("inbox lists a day's drafts in the order they were captured, not by id", () => {
  const s = makeState();
  const at = (h) => "2026-03-04T" + h + ":00:00.000+08:00";
  spend(s, "zzz", "2026-03-04", "food", 1, { created_at: at("09") });   // captured first, sorts last by id
  spend(s, "aaa", "2026-03-04", "food", 1, { created_at: at("13") });
  spend(s, "mmm", "2026-03-04", "food", 1, { created_at: at("11") });
  assert.deepEqual(pendingDrafts(s, "2026-03-05").map((t) => t.id), ["zzz", "mmm", "aaa"]);
});
