import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, validateState, selfCheck, payerFor, nextDue, cardStatement, setCardDetails, planCardPayment, planTransfer, verifyDraft, naturalBalance, countedEntries } from "../src/model/index.js";

// Invented accounts and amounts only.
const acct = (id, name, cls, extra = {}) => ({ id, name, class: cls, role: "", hidden_by_default: false, archived: false, opening_balance: 0, opening_date: "2026-09-01", ...extra });
const base = () => ({ ...emptyState(), accounts: [acct("d", "Sample Bank", "asset", { opening_balance: 2500000, reserve_for: "c" }), acct("c", "Sample Bank · Credit card", "liability", { opening_balance: 1733347 }), acct("w", "Test Wallet", "asset", { opening_balance: 100000 })] });
let n = 0; const newId = () => "p" + ++n;

test("the account that backs the card is the one chosen to pay it; a card with none has none", () => {
  assert.equal(payerFor(base(), "c"), "d");
  const none = { ...base(), accounts: base().accounts.map((a) => ({ ...a, reserve_for: undefined })) };
  assert.equal(payerFor(none, "c"), null);
  const gone = { ...base(), accounts: base().accounts.map((a) => (a.id === "d" ? { ...a, archived: true } : a)) };
  assert.equal(payerFor(gone, "c"), null, "an archived account is not offered");
});

test("the next due date: today counts, later this month, next month, a short month uses its last day, a year end rolls over", () => {
  assert.deepEqual(nextDue(28, "2026-10-17"), { date: "2026-10-28", days: 11 });
  assert.deepEqual(nextDue(17, "2026-10-17"), { date: "2026-10-17", days: 0 });
  assert.deepEqual(nextDue(5, "2026-10-17"), { date: "2026-11-05", days: 19 });
  assert.deepEqual(nextDue(31, "2026-02-10"), { date: "2026-02-28", days: 18 });
  assert.deepEqual(nextDue(3, "2026-12-20"), { date: "2027-01-03", days: 14 });
  assert.equal(nextDue(0, "2026-10-17"), null); assert.equal(nextDue(32, "2026-10-17"), null); assert.equal(nextDue(undefined, "2026-10-17"), null);
});

test("due day and statement balance are typed once per card; only a card has them; bad values are refused; clearing removes them", () => {
  const r = setCardDetails(base(), "c", { due_day: "28", statement_balance: 1097406, date: "2026-10-17" });
  assert.equal(r.ok, true, r.message);
  const c = r.state.accounts.find((a) => a.id === "c");
  assert.deepEqual([c.due_day, c.statement_balance, c.statement_date], [28, 1097406, "2026-10-17"]);
  assert.deepEqual(validateState(r.state), []);
  assert.equal(setCardDetails(base(), "d", { due_day: "28", date: "2026-10-17" }).ok, false, "a debit account has no due day");
  assert.equal(setCardDetails(base(), "c", { due_day: "40", date: "2026-10-17" }).ok, false);
  assert.equal(setCardDetails(base(), "c", { due_day: "", statement_balance: -5, date: "2026-10-17" }).ok, false);
  const cleared = setCardDetails(r.state, "c", { due_day: "", statement_balance: null, date: "2026-10-18" });
  assert.equal(cleared.ok, true); const cc = cleared.state.accounts.find((a) => a.id === "c");
  assert.equal("due_day" in cc || "statement_balance" in cc || "statement_date" in cc, false);
});

test("the last statement: a kept statement's closing figure wins over a typed balance; none at all is null", () => {
  assert.equal(cardStatement(base(), "c"), null);
  const typed = setCardDetails(base(), "c", { due_day: "", statement_balance: 1097406, date: "2026-10-17" }).state;
  assert.deepEqual(cardStatement(typed, "c"), { balance: 1097406, date: "2026-10-17", from: "typed" });
  const kept = { ...typed, statementRecords: [{ id: "r1", account_id: "c", closing: -900000, period_from: "2026-08-01", period_to: "2026-08-31" }, { id: "r2", account_id: "c", closing: 1250000, period_from: "2026-09-01", period_to: "2026-09-30" }] };
  assert.deepEqual(cardStatement(kept, "c"), { balance: 1250000, date: "2026-09-30", from: "statement" }, "the newest kept statement, read as an amount owed");
});

test("paying the card is ONE draft transfer into it: it lowers what is owed once verified, it is not spending, and a debit account cannot be paid this way", () => {
  const r = planCardPayment(base(), { card_id: "c", from_id: "d", amount: 1097406, date: "2026-10-17", newId, now: new Date("2026-10-17T10:25:00+08:00") });
  assert.equal(r.ok, true, r.message);
  const t = r.state.transactions[0];
  assert.deepEqual([t.status, t.payee, t.source, t.date], ["draft", "Card payment", "manual", "2026-10-17"]);
  assert.deepEqual(r.state.entries.map((e) => [e.account_id, e.amount]), [["c", 1097406], ["d", -1097406]]);
  assert.equal(r.state.entries.some((e) => e.category_id), false, "no spending category");
  assert.deepEqual(selfCheck({ state: r.state }), []); assert.deepEqual(validateState(r.state), []);
  assert.equal(planCardPayment(base(), { card_id: "w", from_id: "d", amount: 100, date: "2026-10-17", newId }).ok, false, "paying an account that is not a card");
  assert.equal(planCardPayment(base(), { card_id: "c", from_id: "c", amount: 100, date: "2026-10-17", newId }).ok, false, "paying from a card");
  assert.equal(planCardPayment(base(), { card_id: "c", from_id: "d", amount: 0, date: "2026-10-17", newId }).ok, false);
});

test("Move money into a card used to be refused (a card entry needs pending or posted); now it saves, and once verified it lowers what is owed by exactly the payment", () => {
  const owed = (st) => naturalBalance(st.accounts.find((a) => a.id === "c"), countedEntries(st));
  const before = base(), fromBefore = (st) => naturalBalance(st.accounts.find((a) => a.id === "d"), countedEntries(st));
  const p = planTransfer(before, { transaction_id: "m1", date: "2026-10-17", from_account_id: "d", to_account_id: "c", amount: 1097406, fee: 1500, payee: "Transfer", source: "manual" });
  assert.equal(p.ok, true, p.violations?.[0]?.message);
  assert.deepEqual(p.state.entries.filter((e) => e.account_id === "c").map((e) => e.card_state), ["posted"]);
  const v = verifyDraft(p.state, "m1");
  assert.equal(v.ok, true);
  assert.equal(owed(before) - owed(v.state), 1097406, "the card owes exactly the payment less");
  assert.equal(fromBefore(before) - fromBefore(v.state), 1097406 + 1500, "the paying account holds the payment and its fee less (the fee is verified with it)");
  assert.deepEqual(selfCheck({ state: v.state }), []); assert.deepEqual(validateState(v.state), []);
});
