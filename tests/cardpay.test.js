import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, validateState, selfCheck, payerFor, nextDue, lastStatementDate, cardStatement, setCardDetails, planCardPayment, makeCardDueDrafts, planTransfer, verifyDraft, naturalBalance, countedEntries } from "../src/model/index.js";

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

// ----- the due day -----
const withCard = (extra = {}) => { const b = base(); return { ...b, accounts: b.accounts.map((a) => (a.id === "c" ? { ...a, due_day: 28, statement_balance: 1097406, statement_date: "2026-10-01", ...extra } : a)) }; };
const dues = (st, made, today) => makeCardDueDrafts(st, made, today, { newId: (() => { let k = 0; return () => "due" + ++k; })(), now: new Date("2026-10-28T09:00:00+08:00") });

test("on the due day ONE draft payment is made from the account that backs the card, for the last statement balance, dated the due day", () => {
  const r = dues(withCard(), {}, "2026-10-28");
  assert.equal(r.drafts.length, 1); assert.deepEqual(r.drafts[0], { card_id: "c", amount: 1097406, date: "2026-10-28" });
  const t = r.state.transactions.find((x) => x.id === "due1");
  assert.deepEqual([t.status, t.date, t.payee], ["draft", "2026-10-28", "Card payment (due Oct 28)"]);
  assert.deepEqual(r.state.entries.filter((e) => e.transaction_id === "due1").map((e) => [e.account_id, e.amount]), [["c", 1097406], ["d", -1097406]]);
  assert.deepEqual(r.made, { c: "2026-10" }); assert.equal(r.changed, true);
  assert.deepEqual(selfCheck({ state: r.state }), []); assert.deepEqual(validateState(r.state), []);
});

test("not before the due day, not more than a week after it, and once a month: a draft thrown away does not come back that month, the next month brings the next one", () => {
  assert.equal(dues(withCard(), {}, "2026-10-27").drafts.length, 0, "the day before");
  assert.equal(dues(withCard(), {}, "2026-11-04").drafts.length, 0, "eight days after the 28th");
  assert.equal(dues(withCard(), {}, "2026-11-03").drafts.length, 0, "the 3rd is before November's 28th: nothing yet");
  assert.equal(dues(withCard(), {}, "2026-10-30").drafts.length, 1, "two days late (the app was closed) still drafts");
  const first = dues(withCard(), {}, "2026-10-28");
  const again = dues(first.state, first.made, "2026-10-29");
  assert.equal(again.drafts.length, 0); assert.equal(again.state.transactions.length, first.state.transactions.length, "running again changes nothing");
  assert.equal(again.changed, false);
  const gone = { ...first.state, transactions: [], entries: [] };
  assert.equal(dues(gone, first.made, "2026-10-29").drafts.length, 0, "a draft that was thrown away does not come back this month");
  assert.equal(dues(first.state, first.made, "2026-11-28").drafts.length, 0, "the same statement, already paid, is not asked for twice");
  const newer = { ...first.state, accounts: first.state.accounts.map((a) => (a.id === "c" ? { ...a, statement_balance: 500000, statement_date: "2026-11-01" } : a)) };
  const nov = dues(newer, first.made, "2026-11-28");
  assert.deepEqual(nov.drafts.map((d) => d.amount), [500000], "a new statement brings the next month's draft");
});

test("a short month uses its last day; a card without a due day, a last statement or a backing account makes nothing and is tried again later", () => {
  const feb = withCard({ due_day: 31, statement_date: "2027-01-31" });
  assert.deepEqual(dues(feb, {}, "2027-02-28").drafts.map((d) => d.date), ["2027-02-28"]);
  const noDay = withCard({ due_day: undefined }); delete noDay.accounts[1].due_day;
  assert.equal(dues(noDay, {}, "2026-10-28").drafts.length, 0);
  const noStmt = withCard({ statement_balance: undefined, statement_date: undefined });
  assert.equal(dues(noStmt, {}, "2026-10-28").drafts.length, 0);
  const noPayer = { ...withCard(), accounts: withCard().accounts.map((a) => ({ ...a, reserve_for: undefined })) };
  const r = dues(noPayer, {}, "2026-10-28"); assert.equal(r.drafts.length, 0); assert.deepEqual(r.made, {}, "not marked as done, so it is tried again once there is a backing account");
});

test("what was already paid into the card since the statement is taken off; a card paid in full gets no draft", () => {
  const paidPart = planCardPayment(withCard(), { card_id: "c", from_id: "d", amount: 400000, date: "2026-10-10", newId: () => "p1" }).state;
  const r = dues(paidPart, {}, "2026-10-28");
  assert.equal(r.drafts[0].amount, 1097406 - 400000, "only what is still owed of the statement");
  const paidAll = planCardPayment(withCard(), { card_id: "c", from_id: "d", amount: 1097406, date: "2026-10-10", newId: () => "p2" }).state;
  const none = dues(paidAll, {}, "2026-10-28");
  assert.equal(none.drafts.length, 0); assert.deepEqual(none.made, { c: "2026-10" }, "marked, so it is not looked at again this month");
  const before = planCardPayment(withCard(), { card_id: "c", from_id: "d", amount: 1097406, date: "2026-09-20", newId: () => "p3" }).state;
  assert.equal(dues(before, {}, "2026-10-28").drafts[0].amount, 1097406, "a payment before the statement does not count");
});

test("the statement day: the last close on or before today, a short month uses its last day, and it is kept and cleared like the due day", () => {
  assert.equal(lastStatementDate(15, "2026-10-19"), "2026-10-15"); assert.equal(lastStatementDate(15, "2026-10-15"), "2026-10-15", "today counts");
  assert.equal(lastStatementDate(15, "2026-10-03"), "2026-09-15", "not closed yet this month: last month's");
  assert.equal(lastStatementDate(31, "2026-03-05"), "2026-02-28", "a short month uses its last day");
  assert.equal(lastStatementDate(15, "2026-01-05"), "2025-12-15", "across New Year");
  assert.equal(lastStatementDate(0, "2026-10-19"), null); assert.equal(lastStatementDate(undefined, "2026-10-19"), null);
  const r = setCardDetails(base(), "c", { due_day: "28", statement_day: "15", date: "2026-10-17" });
  assert.equal(r.ok, true); const c = r.state.accounts.find((a) => a.id === "c");
  assert.deepEqual([c.due_day, c.statement_day], [28, 15]);
  assert.equal(validateState(r.state).filter((v) => v.severity === "error").length, 0);
  assert.equal(setCardDetails(base(), "c", { statement_day: "32", date: "2026-10-17" }).ok, false, "a statement day is 1 to 31");
  assert.equal(setCardDetails(base(), "c", { statement_day: "x", date: "2026-10-17" }).ok, false);
  const cleared = setCardDetails(r.state, "c", { due_day: "28", statement_day: "", date: "2026-10-17" }).state.accounts.find((a) => a.id === "c");
  assert.equal(cleared.statement_day, undefined, "an empty box clears it");
});
