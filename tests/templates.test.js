import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchedule, isDue, datesBetween, categoryForPayee, draftFromTemplate, draftsForRange, planReserveTransfer, naturalBalance } from "../src/model/index.js";
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
