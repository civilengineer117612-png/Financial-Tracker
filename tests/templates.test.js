import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchedule, isDue, datesBetween, categoryForPayee, draftFromTemplate, draftsForRange, planReserveTransfer, naturalBalance, updatePreset, addPreset, removePreset, reorderPresets, MAX_PRESETS } from "../src/model/index.js";
import { makeState, commit, cardPurchase } from "./fixtures.js";

// Invented data only.
function s0() {
  const s = makeState();
  s.categories.push({ id: "rent", name: "Rent", kind: "expense" }, { id: "subs", name: "Subscription", kind: "expense" });
  return s;
}
const rules = [
  { id: "p1", payee_pattern: "landlord", category_id: "rent" },
  { id: "p2", payee_pattern: "streaming", category_id: "subs" },
  { id: "p3", payee_pattern: "streaming plus", category_id: "food" },   // longer pattern must win
];
const rentT = { id: "rent", payee: "Test Landlord", amount: 50000, accounts: ["chk"], schedule: "monthly:1" };
const subT = { id: "sub", payee: "Streaming Co", amount: 15000, accounts: ["chk"], schedule: "monthly:20" };
const xferT = { id: "x", payee: "Payday split", amount: 30000, accounts: ["chk", "res"], schedule: "monthly:15,last" };

test("schedules parse; junk does not", () => {
  assert.deepEqual(parseSchedule("monthly:15,last"), [15, "last"]);
  assert.equal(parseSchedule("weekly:1"), null);
  assert.equal(parseSchedule("monthly:32"), null);
  assert.equal(parseSchedule("monthly:0"), null);
  assert.equal(parseSchedule("monthly:"), null);
});
test("due on its day, including month end and short months", () => {
  assert.equal(isDue("monthly:20", "2026-03-20"), true);
  assert.equal(isDue("monthly:20", "2026-03-19"), false);
  assert.equal(isDue("monthly:last", "2026-02-28"), true);
  assert.equal(isDue("monthly:last", "2024-02-29"), true);   // leap year
  assert.equal(isDue("monthly:31", "2026-02-28"), true);      // 31st falls on the last day of a short month
  assert.equal(isDue("monthly:31", "2026-04-30"), true);
  assert.equal(isDue("monthly:15,last", "2026-03-31"), true);
});
test("datesBetween is inclusive", () => {
  assert.deepEqual(datesBetween("2026-02-27", "2026-03-02"), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
});
test("payee rules: case-insensitive, longest pattern wins", () => {
  assert.equal(categoryForPayee(rules, "TEST LANDLORD"), "rent");
  assert.equal(categoryForPayee(rules, "Streaming Plus family"), "food");
  assert.equal(categoryForPayee(rules, "Streaming Co"), "subs");
  assert.equal(categoryForPayee(rules, "Unknown"), null);
});

test("expense template makes a balanced DRAFT with the payee's category", () => {
  const p = draftFromTemplate(s0(), rentT, rules, "2026-03-01");
  assert.equal(p.ok, true);
  assert.equal(p.transaction.status, "draft");
  assert.equal(p.transaction.source, "template");
  assert.deepEqual(p.entries.map((e) => [e.category_id ?? e.account_id, e.amount]), [["rent", 50000], ["chk", -50000]]);
});
test("transfer template moves source to destination", () => {
  const p = draftFromTemplate(s0(), xferT, rules, "2026-03-15");
  assert.deepEqual(p.entries.map((e) => [e.account_id, e.amount]), [["res", 30000], ["chk", -30000]]);
});
test("an expense template with no matching payee rule is an error, not a guess", () => {
  const p = draftFromTemplate(s0(), { ...rentT, payee: "Mystery" }, rules, "2026-03-01");
  assert.equal(p.ok, false);
  assert.equal(p.violations[0].code, "NO_CATEGORY");
});
test("bad schedule or account count is reported", () => {
  assert.equal(draftFromTemplate(s0(), { ...rentT, schedule: "daily" }, rules, "2026-03-01").violations[0].code, "BAD_SCHEDULE");
  assert.equal(draftFromTemplate(s0(), { ...rentT, accounts: ["chk", "res", "card"] }, rules, "2026-03-01").violations[0].code, "BAD_TEMPLATE_ACCOUNTS");
});
test("a card-funded expense template tags the charge pending", () => {
  const p = draftFromTemplate(s0(), { ...subT, accounts: ["card"] }, rules, "2026-03-20");
  assert.equal(p.entries[1].card_state, "pending");
});

test("running the same date twice never makes a second draft", () => {
  const s = s0();
  const first = draftFromTemplate(s, rentT, rules, "2026-03-01");
  commit(s, first);
  assert.equal(draftFromTemplate(s, rentT, rules, "2026-03-01").skipped, true);
});

test("range catch-up: a month of templates in due order, skipping what exists", () => {
  const s = s0();
  const all = draftsForRange(s, [rentT, subT, xferT], rules, "2026-03-01", "2026-03-31");
  assert.deepEqual(all.map((d) => d.template_id + "@" + d.date.slice(8)), ["rent@01", "x@15", "sub@20", "x@31"]);
  for (const d of all) commit(s, d);
  assert.deepEqual(draftsForRange(s, [rentT, subT, xferT], rules, "2026-03-01", "2026-03-31"), []);   // nothing left to make
});

// ---------- card reserve transfer ----------
test("a card purchase generates a draft reserve transfer for the amount added", () => {
  const s = s0();
  const purchase = cardPurchase("a", 20000);
  const [t] = planReserveTransfer(s, purchase, "chk");
  assert.equal(t.transaction.status, "draft");
  assert.deepEqual(t.entries.map((e) => [e.account_id, e.amount]), [["res", 20000], ["chk", -20000]]);
  commit(s, t);
  commit(s, purchase);
  assert.equal(naturalBalance(s.accounts[1], s.entries), 20000);   // reserve now covers the card
  assert.deepEqual(t.violations, []);
});
test("a card payment or refund generates no reserve transfer", () => {
  const s = s0();
  const payment = { transaction: { id: "pay", date: "2026-01-05" }, entries: [
    { transaction_id: "pay", account_id: "card", amount: 5000, card_state: "posted" },
    { transaction_id: "pay", account_id: "chk", amount: -5000 } ] };
  assert.deepEqual(planReserveTransfer(s, payment, "chk"), []);
});
test("a purchase that is not on the card generates nothing", () => {
  const s = s0();
  const debit = { transaction: { id: "d", date: "2026-01-05" }, entries: [
    { transaction_id: "d", category_id: "food", amount: 100 }, { transaction_id: "d", account_id: "chk", amount: -100 } ] };
  assert.deepEqual(planReserveTransfer(s, debit, "chk"), []);
});

// invented tiles and categories
const withTiles = () => ({ ...makeState(), categories: [{ id: "food", name: "Food", kind: "expense" }, { id: "shop", name: "Shopping", kind: "expense" }, { id: "pay", name: "Pay", kind: "income" }],
  presets: [{ id: "pre-lunch", name: "Lunch", amount: 9500, category_id: "food" }, { id: "pre-dinner", name: "Dinner", amount: 9500, category_id: "food" }] });

test("a quick tile can be renamed, repriced and moved to another spending category, and nothing else changes", () => {
  const s = withTiles();
  const r = updatePreset(s, "pre-lunch", { name: "  Snack ", amount: 4500, category_id: "shop" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.presets, [{ id: "pre-lunch", name: "Snack", amount: 4500, category_id: "shop" }, { id: "pre-dinner", name: "Dinner", amount: 9500, category_id: "food" }]);
  assert.equal(r.state.transactions.length, 0, "nothing is logged");
});

test("a quick tile refuses an empty name, a bad amount, a non-spending category or a missing tile", () => {
  const s = withTiles();
  assert.equal(updatePreset(s, "pre-lunch", { name: " ", amount: 100, category_id: "food" }).ok, false);
  assert.equal(updatePreset(s, "pre-lunch", { name: "Snack", amount: 0, category_id: "food" }).ok, false);
  assert.equal(updatePreset(s, "pre-lunch", { name: "Snack", amount: 10.5, category_id: "food" }).ok, false);
  assert.equal(updatePreset(s, "pre-lunch", { name: "x".repeat(25), amount: 100, category_id: "food" }).ok, false);
  assert.equal(updatePreset(s, "pre-lunch", { name: "Snack", amount: 100, category_id: "pay" }).ok, false);
  assert.equal(updatePreset(s, "pre-nope", { name: "Snack", amount: 100, category_id: "food" }).ok, false);
});

test("tiles can be added up to six, removed and moved, and none of it logs anything", () => {
  let s = withTiles();
  const a = addPreset(s, { name: " Coffee ", amount: 12000, category_id: "food" }, "pre-coffee");
  assert.equal(a.ok, true);
  assert.deepEqual(a.state.presets.map((p) => p.name), ["Lunch", "Dinner", "Coffee"]);
  s = a.state;
  const moved = reorderPresets(s, ["pre-coffee", "pre-lunch", "pre-dinner"]);
  assert.deepEqual(moved.state.presets.map((p) => p.id), ["pre-coffee", "pre-lunch", "pre-dinner"]);
  const gone = removePreset(moved.state, "pre-lunch");
  assert.deepEqual(gone.state.presets.map((p) => p.id), ["pre-coffee", "pre-dinner"]);
  assert.equal(gone.state.transactions.length, 0);
  for (let i = 0; i < MAX_PRESETS; i++) { const r = addPreset(s, { name: "T" + i, amount: 100, category_id: "food" }, "pre-x" + i); if (r.ok) s = r.state; }
  assert.equal(s.presets.length, MAX_PRESETS);
  assert.equal(addPreset(s, { name: "One more", amount: 100, category_id: "food" }, "pre-more").ok, false, "six is the most");
});

test("tiles refuse a bad new tile, a duplicate id, a missing tile and a reorder that drops or invents a tile", () => {
  const s = withTiles();
  assert.equal(addPreset(s, { name: "", amount: 100, category_id: "food" }, "p1").ok, false);
  assert.equal(addPreset(s, { name: "A", amount: 0, category_id: "food" }, "p1").ok, false);
  assert.equal(addPreset(s, { name: "A", amount: 100, category_id: "pay" }, "p1").ok, false);
  assert.equal(addPreset(s, { name: "A", amount: 100, category_id: "food" }, "pre-lunch").ok, false);
  assert.equal(removePreset(s, "pre-nope").ok, false);
  assert.equal(reorderPresets(s, ["pre-lunch"]).ok, false);
  assert.equal(reorderPresets(s, ["pre-lunch", "pre-lunch"]).ok, false);
  assert.equal(reorderPresets(s, ["pre-lunch", "pre-other"]).ok, false);
});
