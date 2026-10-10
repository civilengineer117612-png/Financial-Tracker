import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addSchedule, makeDueDrafts, setNewAmount, skipPayment, endSchedule, markPaidOff, markNextDue, payNext, skipOnDelete, viewOf, dueSoon, daysText, planLine,
  committedIn, matchDueDraft, nextOpenPayment, reserveForPlan, reserveIdFor, payKey, skippedOf, linkToDue, planInText, paymentState, paymentsOf, monthsAfter, verifyDraft, discardDraft, editDraftFields, validateShape, validateState,
  encryptLedgerBackup, decryptLedgerBackup, upgradeLedger, parseLedger, selfCheck, LEDGER_VERSION, INTEREST_ROLE, COLLECTION_NAMES,
} from "../src/model/index.js";
import { account } from "./fixtures.js";

// Invented names, days and amounts only.
const NOW = new Date("2026-10-05T01:00:00Z");
const base = () => ({
  accounts: [account({ id: "bank", name: "Test Bank", class: "asset", opening_balance: 9000000 }), account({ id: "card", name: "Test Card", class: "liability" })],
  categories: [{ id: "cat-rent", name: "Rent", kind: "expense", role: "rent" }, { id: "cat-shop", name: "Shopping", kind: "expense", role: "shopping" }, { id: "cat-pay", name: "Pay", kind: "income" }],
  envelopes: [], transactions: [], entries: [], attachments: [], tags: [], foreignAmounts: [], schedules: [], scheduleChanges: [],
});
const rent = (over = {}) => ({ id: "r1", kind: "repeating", name: "Rent", category_id: "cat-rent", account_id: "bank", amount: 500000, day: 5, start: "2026-09-05", ...over });
const plan = (over = {}) => ({ id: "p1", kind: "installment", name: "Test Phone", category_id: "cat-shop", account_id: "bank", total: 600000, count: 3, made: 0, start: "2026-10-10", ...over });
const add = (s, input) => { const r = addSchedule(s, input, NOW); assert.equal(r.ok, true, JSON.stringify(r.violations)); return r.state; };
const idsOf = (s) => s.transactions.filter((t) => t.id.startsWith("sch:")).map((t) => t.id).sort();

test("a repeating payment becomes a DRAFT on its due day, never verified, and running it again changes nothing", () => {
  const s0 = add(base(), rent());
  const a = makeDueDrafts(s0, "2026-10-05", { now: NOW });
  assert.deepEqual(idsOf(a.state), ["sch:r1:2026-09", "sch:r1:2026-10"], "September was missed (the app was closed): caught up; October is due today");
  for (const t of a.state.transactions) assert.deepEqual([t.status, t.source, t.schedule_id, "verified_at" in t], ["draft", "template", "r1", false], t.id + ": a draft, never auto-confirmed");
  const oct = a.state.transactions.find((t) => t.id === "sch:r1:2026-10");
  assert.deepEqual([oct.date, oct.payee, oct.schedule_key], ["2026-10-05", "Rent", "2026-10"]);
  assert.deepEqual(a.state.entries.filter((e) => e.transaction_id === oct.id).map((e) => [e.category_id ?? e.account_id, e.amount]).sort(), [["bank", -500000], ["cat-rent", 500000]]);
  for (const t of a.state.transactions) assert.deepEqual(validateShape("Transaction", t), [], t.id);
  const again = makeDueDrafts(a.state, "2026-10-05", { now: NOW });
  assert.equal(again.made.length, 0); assert.equal(again.state.transactions.length, a.state.transactions.length, "no second draft");
  assert.equal(makeDueDrafts(s0, "2026-10-04", { now: NOW }).state.transactions.some((t) => t.id === "sch:r1:2026-10"), false, "not before its day");
  assert.equal(makeDueDrafts(s0, "2027-03-01", { now: NOW }).state.transactions.some((t) => t.id === "sch:r1:2026-09"), false, "payments older than about three months are not made up");
});

test("day 31 falls on the last day of a short month, by the same rule as the templates", () => {
  const s = add(base(), rent({ day: 31, start: "2026-02-01" }));
  assert.deepEqual(paymentsOf(s, s.schedules[0], { through: "2026-04-30" }).map((p) => p.due), ["2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.equal(monthsAfter("2026-01-31", 1), "2026-02-28");
});

test("a new amount is a new dated row: October keeps its old amount, and nothing earlier is edited", () => {
  let s = add(base(), rent()); s = makeDueDrafts(s, "2026-10-05", { now: NOW }).state;
  const before = JSON.stringify(s.scheduleChanges), draftsBefore = JSON.stringify(s.transactions);
  const r = setNewAmount(s, "r1", 550000, "2026-11-01", NOW); assert.equal(r.ok, true);
  assert.equal(JSON.stringify(r.state.scheduleChanges.slice(0, s.scheduleChanges.length)), before, "earlier rows are untouched");
  assert.equal(r.state.scheduleChanges.length, 1); assert.equal(JSON.stringify(r.state.transactions), draftsBefore, "past months never change");
  assert.equal(r.state.schedules[0].amount, 500000, "the schedule row itself is never edited");
  const next = makeDueDrafts(r.state, "2026-11-05", { now: NOW }).state;
  assert.equal(next.entries.find((e) => e.transaction_id === "sch:r1:2026-11" && e.category_id).amount, 550000, "November has the new amount");
  assert.equal(next.entries.find((e) => e.transaction_id === "sch:r1:2026-10" && e.category_id).amount, 500000, "October keeps the old one");
  assert.deepEqual(paymentsOf(r.state, r.state.schedules[0], { through: "2026-12-31" }).map((p) => [p.key, p.amount]), [["2026-09", 500000], ["2026-10", 500000], ["2026-11", 550000], ["2026-12", 550000]], "read back, every month before the date has the old amount");
  assert.equal(setNewAmount(s, "r1", 0, "2026-11-01").ok, false);
  assert.equal(setNewAmount(add(s, plan()), "p1", 100, "2026-11-01").ok, false, "only a repeating payment has a new amount");
});

test("skip a month: no draft; delete a due draft: it is not made again; the others carry on", () => {
  let s = add(base(), rent());
  s = skipPayment(s, "r1", "2026-10", "2026-10-01", NOW).state;
  const a = makeDueDrafts(s, "2026-11-05", { now: NOW }).state;
  assert.deepEqual(idsOf(a), ["sch:r1:2026-09", "sch:r1:2026-11"], "October was skipped");
  assert.equal(paymentState(a, a.schedules[0], "2026-10"), "skipped");
  const del = discardDraft(a, "sch:r1:2026-11"); assert.equal(del.ok, true);
  const noted = skipOnDelete(del.state, a.transactions.find((t) => t.id === "sch:r1:2026-11"), "2026-11-05", NOW);
  assert.equal(makeDueDrafts(noted.state, "2026-11-06", { now: NOW }).made.length, 0, "a deleted draft stays deleted");
});

test("ending stops FUTURE payments only: past months, drafts and verified entries are exactly as they were", () => {
  let s = add(base(), rent()); s = makeDueDrafts(s, "2026-10-05", { now: NOW }).state;
  s = verifyDraft(s, "sch:r1:2026-09", NOW).state;
  const before = JSON.stringify([s.transactions, s.entries]);
  const e = endSchedule(s, "r1", "2026-10-31", NOW); assert.equal(e.ok, true);
  assert.equal(JSON.stringify([e.state.transactions, e.state.entries]), before, "nothing in the past changed");
  assert.equal(makeDueDrafts(e.state, "2026-12-05", { now: NOW }).made.length, 0, "no November or December draft");
  assert.equal(viewOf(e.state, e.state.schedules[0], "2026-12-05").ended, true);
  assert.equal(e.state.scheduleChanges.length, 1, "ending is a row, not a removal");
});

test("an installment plan: payments add up exactly, payments already made are skipped, paid X of N and still to pay", () => {
  const s = add(base(), plan({ total: 100001, count: 3, made: 1, start: "2026-09-10" }));
  const ps = paymentsOf(s, s.schedules[0], { through: "2027-01-01" });
  assert.deepEqual(ps.map((p) => [p.key, p.due, p.amount]), [["2", "2026-10-10", 33333], ["3", "2026-11-10", 33335]], "the first was paid before; the last takes the remainder");
  let v = viewOf(s, s.schedules[0], "2026-10-01");
  assert.deepEqual([v.paid, v.of, v.stillToPay, v.next.due], [1, 3, 66668, "2026-10-10"]);
  let d = makeDueDrafts(s, "2026-10-10", { now: NOW }).state;
  assert.deepEqual(idsOf(d), ["sch:p1:2"]);
  d = verifyDraft(d, "sch:p1:2", NOW).state;
  v = viewOf(d, d.schedules[0], "2026-10-11");
  assert.deepEqual([v.paid, v.stillToPay, v.next.key], [2, 33335, "3"]);
  assert.equal(validateShape("Schedule", d.schedules[0]).length, 0);
});

test("counting: an installment counts as spent only when verified, in the plan's category, and the interest part is its own line", () => {
  const s = add(base(), plan({ total: 600000, count: 3, interest: 30000 }));
  const d = makeDueDrafts(s, "2026-10-10", { now: NOW }).state;
  const es = d.entries.filter((e) => e.transaction_id === "sch:p1:1");
  assert.equal(es.reduce((n, e) => n + e.amount, 0), 0, "balanced");
  const cat = (id) => d.categories.find((c) => c.id === id);
  const lines = es.filter((e) => e.category_id).map((e) => [cat(e.category_id).role, e.amount]).sort();
  assert.deepEqual(lines, [[INTEREST_ROLE, 10000], ["shopping", 190000]], "190,000 of the plan, 10,000 interest and fees");
  assert.equal(es.find((e) => e.account_id).amount, -200000, "the account pays the whole payment");
  assert.equal(d.transactions.find((t) => t.id === "sch:p1:1").status, "draft", "a draft counts toward nothing yet");
  assert.equal(d.categories.filter((c) => c.role === INTEREST_ROLE).length, 1);
  assert.equal(addSchedule(base(), plan({ interest: 600000 })).ok, false, "interest cannot be the whole total");
});

test("paid off early stops the rest of the plan; what was paid stays", () => {
  let s = add(base(), plan()); s = makeDueDrafts(s, "2026-10-10", { now: NOW }).state; s = verifyDraft(s, "sch:p1:1", NOW).state;
  const r = markPaidOff(s, "p1", "2026-10-12", NOW); assert.equal(r.ok, true);
  const v = viewOf(r.state, r.state.schedules[0], "2026-10-12");
  assert.deepEqual([v.paid, v.stillToPay, v.paidOff, v.next], [1, 0, true, null]);
  assert.equal(makeDueDrafts(r.state, "2027-01-10", { now: NOW }).made.length, 0, "no more payments");
  assert.equal(r.state.transactions.find((t) => t.id === "sch:p1:1").status, "verified");
  assert.equal(markPaidOff(add(base(), rent()), "r1", "2026-10-12").ok, false, "only a plan is marked paid off");
});

test("pay ahead: the next payment becomes a draft today; skipping an installment leaves it owed", () => {
  let s = add(base(), plan());
  const a = payNext(s, "p1", "2026-09-20", { now: NOW }); assert.equal(a.ok, true);
  assert.equal(a.state.transactions.find((t) => t.id === "sch:p1:1").date, "2026-09-20", "dated today, before its due date");
  const b = payNext(a.state, "p1", "2026-09-20", { now: NOW }); assert.equal(b.payment.key, "2", "the next one after that");
  s = skipPayment(s, "p1", "1", "2026-10-10", NOW).state;
  assert.equal(makeDueDrafts(s, "2026-10-10", { now: NOW }).made.length, 0);
  assert.equal(viewOf(s, s.schedules[0], "2026-10-10").stillToPay, 600000, "a skipped payment is still owed");
});

test("the guard: a payment logged by hand near a due draft is offered a link; never a second entry", () => {
  let s = add(base(), rent()); s = makeDueDrafts(s, "2026-10-05", { now: NOW }).state;
  const near = (over) => matchDueDraft(s, { payee: "Rent", amount: 500000, date: "2026-10-06", ...over });
  assert.equal(near({}), "sch:r1:2026-10");
  assert.equal(near({ payee: "Rent - October" }), "sch:r1:2026-10", "about the same payee");
  assert.equal(near({ amount: 520000 }), "sch:r1:2026-10", "about the same amount");
  assert.equal(near({ amount: 300000 }), null, "a different amount");
  assert.equal(near({ payee: "Groceries" }), null, "a different payee");
  assert.equal(near({ date: "2026-10-25" }), null, "far from the due date");
  // the owner links: the entry they logged takes the place of the due draft
  const mine = { id: "tx-hand", date: "2026-10-06", payee: "Rent", memo: "", status: "draft", source: "manual", created_at: "2026-10-06T09:00:00.000+08:00" };
  const withMine = { ...s, transactions: [...s.transactions, mine], entries: [...s.entries, { transaction_id: "tx-hand", category_id: "cat-rent", amount: 500000 }, { transaction_id: "tx-hand", account_id: "bank", amount: -500000 }] };
  const l = linkToDue(withMine, "tx-hand", "sch:r1:2026-10"); assert.equal(l.ok, true);
  assert.equal(l.state.transactions.some((t) => t.id === "sch:r1:2026-10"), false, "the due draft is gone");
  assert.equal(l.state.transactions.filter((t) => t.schedule_id === "r1" && t.schedule_key === "2026-10").length, 1, "one payment for October");
  assert.equal(makeDueDrafts(l.state, "2026-10-20", { now: NOW }).made.length, 0, "and no new draft is made for it");
  assert.equal(paymentState(l.state, l.state.schedules[0], "2026-10"), "draft");
  assert.equal(validateShape("Transaction", l.state.transactions.find((t) => t.id === "tx-hand")).length, 0);
});

test("a foreign-currency item carries an estimated peso amount, kept with its currency, fixed when it is verified", () => {
  const s = add(base(), rent({ id: "f1", name: "Test Cloud", amount: 57000, day: 12, start: "2026-10-01", foreign: { currency: "USD", amount: 1000 } }));
  const d = makeDueDrafts(s, "2026-10-12", { now: NOW }).state;
  const f = d.foreignAmounts.find((x) => x.transaction_id === "sch:f1:2026-10");
  assert.deepEqual([f.currency, f.foreign_amount, f.rate], ["USD", 1000, 57]);
  const e = editDraftFields(d, "sch:f1:2026-10", { amount: 58000 }, {}, NOW);
  assert.equal(e.ok, true, JSON.stringify(e.violations));
  assert.equal(e.state.entries.find((x) => x.transaction_id === "sch:f1:2026-10" && x.category_id).amount, 58000, "the peso amount is corrected");
  assert.equal(e.state.foreignAmounts.find((x) => x.transaction_id === "sch:f1:2026-10").rate, 58, "and its rate follows");
});

test("Due soon: name, amount, days left; overdue in plain words; verified and skipped ones are not listed", () => {
  let s = add(add(base(), rent()), plan({ start: "2026-10-12" }));
  s = makeDueDrafts(s, "2026-10-05", { now: NOW }).state;
  const list = dueSoon(s, "2026-10-08", { days: 7 });
  assert.deepEqual(list.map((x) => [x.name, x.key, x.amount, x.days]), [["Rent", "2026-09", 500000, -33], ["Rent", "2026-10", 500000, -3], ["Test Phone", "1", 200000, 4]], "September is still unpaid, so it is listed as overdue");
  assert.deepEqual([daysText(0), daysText(1), daysText(4), daysText(-1), daysText(-3)], ["due today", "due tomorrow", "due in 4 days", "1 day overdue", "3 days overdue"]);
  const paid = verifyDraft(s, "sch:r1:2026-10", NOW).state;
  assert.equal(dueSoon(paid, "2026-10-08").some((x) => x.name === "Rent" && x.key === "2026-10"), false);
  assert.equal(dueSoon(skipPayment(paid, "p1", "1", "2026-10-08", NOW).state, "2026-10-08").some((x) => x.name === "Test Phone"), false);
});

test("the plan line and the amount an installment commits in its category this month", () => {
  const peso = (c) => "P" + (c / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  assert.equal(planLine({ perMonth: 50000, months: 3, categoryName: "Shopping", budget: 100000 }, peso), "This plan takes P500 a month for 3 months. Shopping budget: P1,000.");
  assert.equal(planLine({ perMonth: 50000, months: 1, categoryName: "Shopping", budget: null }, peso), "This plan takes P500 a month for 1 month.");
  let s = add(base(), plan({ total: 150000, count: 3, start: "2026-10-10" }));
  assert.equal(committedIn(s, "cat-shop", "2026-10", "2026-10-01"), 50000, "this month's payment, not the whole plan");
  assert.equal(committedIn(s, "cat-rent", "2026-10", "2026-10-01"), 0);
  s = makeDueDrafts(s, "2026-10-10", { now: NOW }).state;
  assert.equal(committedIn(s, "cat-shop", "2026-10", "2026-10-10"), 50000, "a due draft is still committed");
  s = verifyDraft(s, "sch:p1:1", NOW).state;
  assert.equal(committedIn(s, "cat-shop", "2026-10", "2026-10-10"), 0, "once paid it is spent, not committed");
});

test("the scanner link: a payment request names a plan and marks its next payment due with that amount; it is a reminder, never an expense", () => {
  const s = add(base(), plan({ name: "Test Phone" }));
  assert.equal(planInText(s, "PAYMENT REQUEST\nTest Phone installment\nAmount due P2,500.00").id, "p1");
  assert.equal(planInText(s, "Groceries P2,500.00"), null);
  const r = markNextDue(s, "p1", 250000, "2026-10-05", NOW); assert.equal(r.ok, true);
  assert.equal(r.state.transactions.length, 0, "no expense was made");
  assert.equal(r.payment.amount, 250000);
  const d = makeDueDrafts(r.state, "2026-10-10", { now: NOW }).state;
  assert.equal(d.entries.find((e) => e.transaction_id === "sch:p1:1" && e.category_id).amount, 250000, "its draft carries the requested amount");
  assert.equal(r.state.schedules[0].total, 600000, "the plan itself is unchanged");
});

test("a schedule must be well formed: a name, a category, an account, a real day, sensible counts", () => {
  const b = base();
  for (const [label, input] of [["no name", rent({ name: " " })], ["no category", rent({ category_id: "nope" })], ["an income category", rent({ category_id: "cat-pay" })], ["no account", rent({ account_id: "nope" })],
    ["amount 0", rent({ amount: 0 })], ["day 32", rent({ day: 32 })], ["zero payments", plan({ count: 0 })], ["more made than payments", plan({ made: 4 })], ["total 0", plan({ total: 0 })], ["fractional centavos", rent({ amount: 100.5 })]]) {
    assert.equal(addSchedule(b, input, NOW).ok, false, label);
  }
  assert.equal(addSchedule(b, plan({ count: 1 }), NOW).ok, true, "one payment is valid");
  assert.equal(addSchedule(add(b, rent()), rent(), NOW).ok, false, "the same id twice");
});

test("backup and restore carry schedules: a version 7 backup upgrades, and a ledger with schedules passes every check", async () => {
  const ts = "2026-10-08T09:00:00.000+08:00";
  const v7 = { v: 7, rev: 80, saved_at: ts, state: { ...Object.fromEntries(COLLECTION_NAMES.filter((k) => !["schedules", "scheduleChanges"].includes(k)).map((k) => [k, []])),
    accounts: [account({ id: "bank", name: "Test Bank", class: "asset", opening_balance: 100000, last4: "" })], categories: [{ id: "cat-rent", name: "Rent", kind: "expense", role: "rent" }] }, settings: { notice_seen_at: ts } };
  const up = upgradeLedger(await decryptLedgerBackup(await encryptLedgerBackup(v7, "correct horse battery"), "correct horse battery"), { now: new Date("2026-10-10T00:00:00Z") });
  assert.equal(up.ok, true, up.error); assert.equal(up.ledger.v, LEDGER_VERSION);
  assert.deepEqual([up.ledger.state.schedules, up.ledger.state.scheduleChanges], [[], []], "the new collections start empty");
  let st = add({ ...up.ledger.state, tags: [] }, rent({ account_id: "bank", category_id: "cat-rent" }));
  st = makeDueDrafts(st, "2026-10-05", { now: NOW }).state;
  const ledger = { ...up.ledger, state: st };
  assert.deepEqual(validateState(ledger.state), []); assert.deepEqual(selfCheck(ledger), []);
  const round = await decryptLedgerBackup(await encryptLedgerBackup(ledger, "correct horse battery"), "correct horse battery");
  assert.equal(round.state.schedules.length, 1); assert.equal(round.state.scheduleChanges.length, 0); assert.equal(round.state.transactions.filter((t) => t.schedule_id).length, 2);
  assert.equal(parseLedger(JSON.stringify(round)).ok, true);
});

test("the screens: a Scheduled screen, Due soon on Log, the guard, the budget line and the scanner link are wired", () => {
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  assert.ok(app.includes("function viewScheduled") && app.includes("M.makeDueDrafts("), "the screen and the draft run");
  assert.ok(app.includes("M.dueSoon(") && app.includes("M.daysText("), "Due soon on Log");
  assert.ok(app.includes("M.matchDueDraft(") && app.includes("M.linkToDue(") && app.includes('data-action="link-due"'), "the guard offers to link");
  assert.ok(app.includes("M.committedIn(") && app.includes("Committed by installments this month"), "the budget row says what installments commit");
  assert.ok(app.includes("M.planInText(") && app.includes("M.markNextDue("), "a scanned payment request marks the next payment due");
  assert.ok(app.includes("M.skipOnDelete("), "a deleted due draft is not made again");
  const sw = readFileSync(new URL("../app/sw.js", import.meta.url), "utf8");
  assert.ok(sw.includes("../src/model/schedules.js"), "works offline");
});

test("a plan on a credit card: the reserve covers the whole amount still to be billed, once; the payments add no reserve of their own", () => {
  const s0 = { ...base(), accounts: [...base().accounts, account({ id: "res", name: "Test Reserve", class: "asset", opening_balance: 0, reserve_for: "card" }), account({ id: "pay", name: "Test Pay", class: "asset", opening_balance: 9000000 })] };
  const s1 = add(s0, plan({ account_id: "card", total: 600000, count: 3, made: 0, start: "2026-10-10" }));
  const r = reserveForPlan(s1, s1.schedules[0], { reserve_source_id: "pay", today: "2026-10-05", now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.violations)); assert.equal(r.id, reserveIdFor("p1")); assert.equal(r.amount, 600000, "the whole plan, not one payment");
  const t = r.state.transactions.find((x) => x.id === r.id);
  assert.deepEqual([t.status, t.source], ["draft", "template"]);
  assert.deepEqual(r.state.entries.filter((e) => e.transaction_id === r.id).map((e) => [e.account_id, e.amount]).sort(), [["pay", -600000], ["res", 600000]]);
  const d = makeDueDrafts(r.state, "2026-10-10", { reserve_source_id: "pay", now: NOW }).state;
  assert.equal(d.transactions.some((x) => x.id.startsWith("rsv:")), false, "no reserve draft with the payment: it is already covered");
  assert.equal(reserveForPlan(r.state, r.state.schedules[0], { reserve_source_id: "pay", today: "2026-10-05", now: NOW }).id, null, "made once");
  const plain = makeDueDrafts(s1, "2026-10-10", { reserve_source_id: "pay", now: NOW }).state;
  assert.equal(plain.transactions.some((x) => x.id.startsWith("rsv:")), true, "without the plan reserve, each payment has the usual one");
  // only a plan on a credit card that has a reserve account
  assert.equal(reserveForPlan(add(s0, plan({ id: "p2" })), { ...plan({ id: "p2" }), kind: "installment" }, { reserve_source_id: "pay", today: "2026-10-05" }).id, null, "paid from a bank account: nothing");
  assert.equal(reserveForPlan(add(base(), plan({ account_id: "card" })), plan({ account_id: "card" }), { reserve_source_id: "bank", today: "2026-10-05" }).id, null, "a card with no reserve account: nothing");
  const odd = { ...s0, accounts: [...s0.accounts, account({ id: "odd", name: "Odd Reserve", class: "asset", opening_balance: 0, reserve_for: "bank" })] };
  assert.equal(reserveForPlan(add(odd, plan({ id: "p3", account_id: "bank" })), plan({ id: "p3", account_id: "bank" }), { reserve_source_id: "pay", today: "2026-10-05" }).id, null, "only a credit card gets a plan reserve, whatever points at the account");
  assert.equal(reserveForPlan(add(s0, rent({ id: "q", account_id: "card" })), rent({ id: "q", account_id: "card" }), { reserve_source_id: "pay", today: "2026-10-05" }).id, null, "a repeating payment is covered per payment, as before");
});

test("a skipped payment can be brought back as a draft; a payment that is not skipped cannot", () => {
  let s = add(base(), rent()); s = skipPayment(s, "r1", "2026-10", "2026-10-01", NOW).state;
  assert.deepEqual(skippedOf(s, s.schedules[0], "2026-10-20").map((p) => p.key), ["2026-10"]);
  const b = payKey(s, "r1", "2026-10", "2026-10-20", { now: NOW }); assert.equal(b.ok, true, JSON.stringify(b.violations));
  const t = b.state.transactions.find((x) => x.id === "sch:r1:2026-10");
  assert.deepEqual([t.status, t.date, t.schedule_key], ["draft", "2026-10-05", "2026-10"], "a draft on its own due day");
  assert.equal(skippedOf(b.state, b.state.schedules[0], "2026-10-20").length, 0, "no longer skipped");
  assert.equal(b.state.scheduleChanges.length, s.scheduleChanges.length, "no row was removed or added");
  assert.equal(payKey(b.state, "r1", "2026-10", "2026-10-20").ok, false, "already a draft");
  assert.equal(payKey(s, "r1", "2026-09", "2026-10-20").ok, false, "never skipped");
});

test("the amount of a scheduled payment with an interest part can be corrected in Verify: the plan's part moves, the interest stays", () => {
  const s = add(base(), plan({ total: 600000, count: 3, interest: 30000 }));
  const d = makeDueDrafts(s, "2026-10-10", { now: NOW }).state;
  const e = editDraftFields(d, "sch:p1:1", { amount: 210000 }, {}, NOW); assert.equal(e.ok, true, JSON.stringify(e.violations));
  const es = e.state.entries.filter((x) => x.transaction_id === "sch:p1:1");
  assert.equal(es.reduce((n, x) => n + x.amount, 0), 0);
  const role = (x) => e.state.categories.find((c) => c.id === x.category_id)?.role;
  assert.deepEqual(es.filter((x) => x.category_id).map((x) => [role(x), x.amount]).sort(), [[INTEREST_ROLE, 10000], ["shopping", 200000]], "the interest part is unchanged");
  assert.equal(es.find((x) => x.account_id).amount, -210000);
  assert.equal(e.state.transactions.find((x) => x.id === "sch:p1:1").schedule_key, "1", "it is still that payment");
  assert.equal(editDraftFields(d, "sch:p1:1", { amount: 10000 }, {}, NOW).ok, false, "not less than the interest part");
  const note = editDraftFields(d, "sch:p1:1", { memo: "covers Sept to Oct" }, {}, NOW);
  assert.equal(note.state.transactions.find((x) => x.id === "sch:p1:1").memo, "covers Sept to Oct", "the note is kept");
});

test("Skip means the next payment that has no draft yet, even when the next one due already is a draft", () => {
  let s = add(base(), plan()); s = payNext(s, "p1", "2026-10-01", { now: NOW }).state;
  assert.equal(viewOf(s, s.schedules[0], "2026-10-01").next.key, "1", "payment 1 is the next due and is already a draft");
  assert.equal(nextOpenPayment(s, s.schedules[0], "2026-10-01").key, "2", "but payment 2 is the next that can be skipped");
  const k = skipPayment(s, "p1", nextOpenPayment(s, s.schedules[0], "2026-10-01").key, "2026-10-01", NOW).state;
  assert.deepEqual(skippedOf(k, k.schedules[0], "2026-10-01").map((p) => p.key), ["2"]);
  assert.equal(nextOpenPayment(markPaidOff(s, "p1", "2026-10-01", NOW).state, s.schedules[0], "2026-10-01"), null, "nothing left once paid off");
  let r = add(base(), rent()); r = endSchedule(r, "r1", "2026-08-31", NOW).state;
  assert.equal(nextOpenPayment(r, r.schedules[0], "2026-10-01"), null, "nothing after the end");
});
