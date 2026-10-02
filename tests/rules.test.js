import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleInEffect, rulesInEffect, reportingCategory, checkCategoryMapSave } from "../src/model/index.js";
import { rule } from "./fixtures.js";

const t = (h) => "2026-01-05T" + h + ":00:00.000+08:00";
const history = [
  rule({ id: "a", amount: 400000, effective_from: "2026-01-01" }),
  rule({ id: "b", amount: 450000, effective_from: "2026-03-01" }),
  rule({ id: "c", subject_id: "rent", amount: 335000, effective_from: "2026-01-01" }),
  rule({ id: "s", kind: "savings", amount: 350000, effective_from: "2026-01-01" }),
];

test("before any rule takes effect there is none", () => {
  assert.equal(ruleInEffect(history, "budget", "food", "2025-12-31"), null);
});
test("the latest row on or before the date wins", () => {
  assert.equal(ruleInEffect(history, "budget", "food", "2026-02-28").id, "a");
  assert.equal(ruleInEffect(history, "budget", "food", "2026-03-01").id, "b");   // effective date is inclusive
  assert.equal(ruleInEffect(history, "budget", "food", "2026-12-31").id, "b");
});
test("kind and subject are kept apart", () => {
  assert.equal(ruleInEffect(history, "budget", "rent", "2026-06-01").id, "c");
  assert.equal(ruleInEffect(history, "savings", "food", "2026-06-01").id, "s");
});
test("same effective date: the later-created row corrects the earlier one", () => {
  const rows = [
    rule({ id: "wrong", amount: 40000, effective_from: "2026-04-01", created_at: t("09") }),
    rule({ id: "fixed", amount: 400000, effective_from: "2026-04-01", created_at: t("10") }),
  ];
  assert.equal(ruleInEffect(rows, "budget", "food", "2026-04-02").id, "fixed");
  assert.equal(ruleInEffect([...rows].reverse(), "budget", "food", "2026-04-02").id, "fixed");   // order of storage does not matter
});
test("a backdated row inserted later still sits in its place in time", () => {
  const rows = [...history, rule({ id: "late", amount: 420000, effective_from: "2026-02-01", created_at: t("23") })];
  assert.equal(ruleInEffect(rows, "budget", "food", "2026-02-15").id, "late");
  assert.equal(ruleInEffect(rows, "budget", "food", "2026-03-15").id, "b");
});
test("rulesInEffect builds the full table as of a date", () => {
  const table = rulesInEffect(history, "budget", "2026-03-15");
  assert.deepEqual([...table.entries()].map(([k, r]) => [k, r.id]).sort(), [["food", "b"], ["rent", "c"]]);
});

// ---------- category maps (reporting merges) ----------
const maps = [
  { from: "breakfast2", to: "breakfast", effective_from: "2026-02-01" },
  { from: "breakfast", to: "food", effective_from: "2026-05-01" },
];
test("a category reports as itself until a map takes effect", () => {
  assert.equal(reportingCategory(maps, "breakfast2", "2026-01-31"), "breakfast2");
  assert.equal(reportingCategory(maps, "breakfast2", "2026-02-01"), "breakfast");
});
test("chained merges are followed to the end", () => {
  assert.equal(reportingCategory(maps, "breakfast2", "2026-06-01"), "food");
});
test("an unmapped category is untouched", () => {
  assert.equal(reportingCategory(maps, "rent", "2026-06-01"), "rent");
});
test("a map that would create a loop is refused at save", () => {
  assert.equal(checkCategoryMapSave(maps, { from: "food", to: "breakfast2", effective_from: "2026-07-01" })[0].code, "MAP_CYCLE");
  assert.equal(checkCategoryMapSave(maps, { from: "food", to: "food", effective_from: "2026-07-01" })[0].code, "MAP_SELF");
  assert.deepEqual(checkCategoryMapSave(maps, { from: "snacks", to: "food", effective_from: "2026-07-01" }), []);
});
