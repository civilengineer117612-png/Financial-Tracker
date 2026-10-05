import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePesos, formatPesos, formatPesosWhole, defaultCategories, defaultPresets, validateState, emptyLedger, emptyState, nextLedger, parseLedger, chooseLedger,
  planExpense, applyDrafts, discardDraft, verifyDraft, editDraftFields, naturalBalance, pendingDrafts, budgetStatus,
} from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

// ---------- money ----------
test("pesos parse to whole centavos, never rounding", () => {
  for (const [input, c] of [["95", 9500], ["95.5", 9550], ["95.05", 9505], ["1,250.00", 125000], ["₱20", 2000], [" 7 ", 700], ["0", 0], ["0.01", 1]]) {
    assert.deepEqual(parsePesos(input), { ok: true, centavos: c }, input);
  }
  for (const bad of ["", "abc", "-5", "1.234", "1.", ".5", "1e3", "9.9.9", "12 34", null, undefined]) assert.equal(parsePesos(bad).ok, false, String(bad));
  assert.equal(parsePesos("99999999999999999").ok, false);   // beyond safe integers
});
test("centavos format as pesos with grouping and a leading sign", () => {
  assert.equal(formatPesos(9500), "₱95.00");
  assert.equal(formatPesos(125050), "₱1,250.50");
  assert.equal(formatPesos(100000000), "₱1,000,000.00");
  assert.equal(formatPesos(5), "₱0.05");
  assert.equal(formatPesos(0), "₱0.00");
  assert.equal(formatPesos(-1500), "-₱15.00");
});
test("whole pesos for tight spaces round to the nearest peso", () => {
  assert.equal(formatPesosWhole(1234567), "₱12,346");
  assert.equal(formatPesosWhole(1234549), "₱12,345");
  assert.equal(formatPesosWhole(49), "₱0");
  assert.equal(formatPesosWhole(-49), "₱0");
  assert.equal(formatPesosWhole(-150000), "-₱1,500");
  assert.equal(formatPesosWhole(0), "₱0");
});
test("parse then format round-trips", () => {
  for (const c of [0, 1, 99, 100, 101, 123456789]) assert.equal(parsePesos(formatPesos(c)).centavos, c);
});

// ---------- defaults ----------
test("defaults form a valid ledger and contain no accounts or balances", () => {
  const s = { ...emptyState(), categories: defaultCategories(), presets: defaultPresets() };
  assert.deepEqual(validateState(s), []);
  assert.equal(s.accounts.length, 0);
  assert.ok(s.categories.some((c) => c.id === "cat-unlogged" && c.kind === "expense"));
  assert.deepEqual(defaultPresets().map((p) => [p.name, p.amount]), [["Breakfast", 2000], ["Lunch", 9500], ["Dinner", 9500]]);
  for (const p of defaultPresets()) assert.ok(defaultCategories().some((c) => c.id === p.category_id));
});

// ---------- planExpense ----------
const S = () => {
  const s = makeState();
  s.accounts.push(account({ id: "cash", name: "Test Cash", class: "asset", opening_balance: 50000 }));
  return s;
};
const input = (o = {}) => ({ transaction_id: "t1", date: "2026-03-10", category_id: "food", amount: 9500, account_id: "cash", ...o });

test("a debit expense is one balanced draft with the category and account", () => {
  const p = planExpense(S(), input({ source: "preset", payee: "Lunch" }));
  assert.equal(p.ok, true);
  assert.equal(p.drafts.length, 1);
  const { transaction, entries } = p.drafts[0];
  assert.deepEqual([transaction.status, transaction.source, transaction.payee], ["draft", "preset", "Lunch"]);
  assert.deepEqual(entries.map((e) => [e.category_id ?? e.account_id, e.amount]), [["food", 9500], ["cash", -9500]]);
});
test("a card expense is tagged pending and brings its reserve transfer as a second draft", () => {
  const p = planExpense(S(), input({ account_id: "card", reserve_source_id: "chk" }));
  assert.equal(p.drafts.length, 2);
  assert.equal(p.drafts[0].entries[1].card_state, "pending");
  assert.equal(p.drafts[1].transaction.id, "rsv:t1");
  assert.deepEqual(p.drafts[1].entries.map((e) => [e.account_id, e.amount]), [["res", 9500], ["chk", -9500]]);
  assert.deepEqual(p.violations, []);   // judged WITH the reserve transfer in place, so the reserve covers the card
});
test("a card expense without a reserve source warns but is still saved", () => {
  const p = planExpense(S(), input({ account_id: "card" }));
  assert.equal(p.ok, true);
  assert.equal(p.drafts.length, 1);
  assert.equal(p.violations[0].code, "RESERVE_BELOW_OUTSTANDING");
});
test("bad input is reported, not thrown", () => {
  const s = S();
  for (const [o, code] of [[{ amount: 0 }, "BAD_AMOUNT"], [{ amount: 9.5 }, "BAD_AMOUNT"], [{ amount: -5 }, "BAD_AMOUNT"],
    [{ account_id: "nope" }, "UNKNOWN_ACCOUNT"], [{ category_id: "nope" }, "UNKNOWN_CATEGORY"], [{ category_id: "pay" }, "UNKNOWN_CATEGORY"],
    [{ source: "import" }, "BAD_SOURCE"]]) {
    const p = planExpense(s, input(o));
    assert.equal(p.ok, false, code);
    assert.equal(p.violations[0].code, code);
    assert.deepEqual(p.drafts, []);
  }
});
test("planning does not change the state it is given", () => {
  const s = S();
  const before = JSON.stringify(s);
  planExpense(s, input({ account_id: "card", reserve_source_id: "chk" }));
  assert.equal(JSON.stringify(s), before);
});

// ---------- applying, discarding, verifying ----------
test("applyDrafts returns a new state with the drafts added, and replaces a draft with the same id", () => {
  const s = S();
  const a = applyDrafts(s, planExpense(s, input()).drafts);
  assert.equal(s.transactions.length, 0);
  assert.equal(a.transactions.length, 1);
  const b = applyDrafts(a, planExpense(a, input({ amount: 100 })).drafts);
  assert.equal(b.transactions.length, 1);
  assert.equal(b.entries.length, 2);
});
test("discarding a purchase removes its reserve transfer too; verified items are never removed", () => {
  const s = S();
  const a = applyDrafts(s, planExpense(s, input({ account_id: "card", reserve_source_id: "chk" })).drafts);
  const d = discardDraft(a, "t1");
  assert.equal(d.ok, true);
  assert.deepEqual([d.state.transactions.length, d.state.entries.length], [0, 0]);
  const v = verifyDraft(a, "t1").state;
  const again = discardDraft(v, "t1");
  assert.equal(again.ok, false);
  assert.equal(again.violations[0].code, "NOT_A_DRAFT");
  assert.equal(discardDraft(a, "nope").violations[0].code, "UNKNOWN_TRANSACTION");
});
test("verifying a purchase verifies its reserve transfer with it, and stamps Philippine time", () => {
  const s = S();
  const a = applyDrafts(s, planExpense(s, input({ account_id: "card", reserve_source_id: "chk" })).drafts);
  const v = verifyDraft(a, "t1", new Date("2026-03-11T00:00:00Z"));
  assert.equal(v.ok, true);
  assert.deepEqual(v.state.transactions.map((t) => [t.id, t.status]).sort(), [["rsv:t1", "verified"], ["t1", "verified"]]);
  assert.equal(v.state.transactions.find((t) => t.id === "t1").verified_at, "2026-03-11T08:00:00.000+08:00");
  assert.deepEqual(pendingDrafts(v.state, "2026-12-31"), []);
  assert.equal(verifyDraft(v.state, "t1").violations[0].code, "ALREADY_VERIFIED");
  assert.equal(verifyDraft(a, "nope").violations[0].code, "UNKNOWN_TRANSACTION");
});
test("only verified spending reaches the budget", () => {
  const s = S();
  const a = applyDrafts(s, planExpense(s, input()).drafts);
  const rules = [{ id: "b", kind: "budget", subject_id: "food", amount: 40000, effective_from: "2026-01-01", created_at: "2026-01-01T09:00:00.000+08:00" }];
  const row = (st) => budgetStatus(st, { rules, month: "2026-03", asOf: "2026-03-31" }).find((r) => r.category_id === "food");
  assert.deepEqual([row(a).spent, row(a).pending], [0, 9500]);
  const v = verifyDraft(a, "t1").state;
  assert.deepEqual([row(v).spent, row(v).pending], [9500, 0]);
});

// ---------- editing a draft ----------
test("editing an expense draft changes amount, category, account, date and payee together", () => {
  const s = S();
  const a = applyDrafts(s, planExpense(s, input({ source: "preset", payee: "Lunch" }), new Date("2026-03-10T04:00:00Z")).drafts);
  const e = editDraftFields(a, "t1", { amount: 12000, category_id: "food", date: "2026-03-09", payee: "Fixed" });
  assert.equal(e.ok, true);
  const t = e.state.transactions.find((x) => x.id === "t1");
  assert.deepEqual([t.date, t.payee, t.source, t.status, t.created_at], ["2026-03-09", "Fixed", "preset", "draft", "2026-03-10T12:00:00.000+08:00"]);   // capture time is kept
  assert.equal(e.state.entries.find((x) => x.account_id === "cash").amount, -12000);
  assert.equal(e.state.entries.reduce((n, x) => n + x.amount, 0), 0);
});
test("moving an expense draft from a card to cash removes its reserve transfer; the reverse adds one", () => {
  const s = S();
  const onCard = applyDrafts(s, planExpense(s, input({ account_id: "card", reserve_source_id: "chk" })).drafts);
  const toCash = editDraftFields(onCard, "t1", { account_id: "cash" }, { reserve_source_id: "chk" });
  assert.deepEqual(toCash.state.transactions.map((t) => t.id), ["t1"]);
  assert.equal(toCash.state.entries.find((x) => x.account_id === "cash").amount, -9500);
  const back = editDraftFields(toCash.state, "t1", { account_id: "card" }, { reserve_source_id: "chk" });
  assert.deepEqual(back.state.transactions.map((t) => t.id).sort(), ["rsv:t1", "t1"]);
  const bigger = editDraftFields(back.state, "t1", { amount: 20000 }, { reserve_source_id: "chk" });
  assert.equal(bigger.state.entries.find((x) => x.transaction_id === "rsv:t1" && x.account_id === "res").amount, 20000);
});
test("an invalid edit leaves the state untouched", () => {
  const s = S();
  const a = applyDrafts(s, planExpense(s, input()).drafts);
  for (const ch of [{ amount: 0 }, { amount: 1.5 }, { account_id: "nope" }, { category_id: "nope" }]) {
    const e = editDraftFields(a, "t1", ch);
    assert.equal(e.ok, false, JSON.stringify(ch));
    assert.equal(e.state, a);
  }
  assert.equal(editDraftFields(a, "nope", { amount: 1 }).violations[0].code, "UNKNOWN_TRANSACTION");
  assert.equal(editDraftFields(verifyDraft(a, "t1").state, "t1", { amount: 1 }).violations[0].code, "NOT_A_DRAFT");
});
test("transfer drafts can change amount, date and payee, scaled across both legs", () => {
  const s = S();
  const tr = { transaction: { id: "x", date: "2026-03-10", payee: "Move", memo: "", status: "draft", source: "template", created_at: "2026-03-10T09:00:00.000+08:00" },
    entries: [{ transaction_id: "x", account_id: "chk", amount: -5000 }, { transaction_id: "x", account_id: "cash", amount: 5000 }] };
  const a = applyDrafts(s, [tr]);
  const e = editDraftFields(a, "x", { amount: 7000, payee: "Moved" });
  assert.equal(e.ok, true);
  assert.deepEqual(e.state.entries.map((x) => x.amount).sort((p, q) => p - q), [-7000, 7000]);
  assert.equal(e.state.transactions[0].payee, "Moved");
  assert.equal(editDraftFields(a, "x", { category_id: "food" }).ok, true);   // unsupported fields are ignored, not applied
});
test("a split draft cannot have its amount edited", () => {
  const s = S();
  const split = { transaction: { id: "sp", date: "2026-03-10", payee: "", memo: "", status: "draft", source: "manual", created_at: "2026-03-10T09:00:00.000+08:00" },
    entries: [{ transaction_id: "sp", category_id: "food", amount: 6000 }, { transaction_id: "sp", category_id: "pay", amount: 3000 }, { transaction_id: "sp", account_id: "cash", amount: -9000 }] };
  const a = applyDrafts(s, [split]);
  assert.equal(editDraftFields(a, "sp", { amount: 100 }).violations[0].code, "NOT_EDITABLE");
  assert.equal(editDraftFields(a, "sp", { payee: "Grocery" }).ok, true);
});

// ---------- persistence across the two stores ----------
const ledger = (rev, extra = {}) => ({ ...emptyLedger(), rev, ...extra });
const text = (l) => JSON.stringify(l);

test("a saved ledger round-trips and bumps its revision", () => {
  const l0 = emptyLedger();
  const l1 = nextLedger(l0, { ...emptyState(), categories: defaultCategories() }, { reserve_source_id: "x" }, new Date("2026-03-10T00:00:00Z"));
  assert.deepEqual([l1.rev, l1.saved_at], [1, "2026-03-10T08:00:00.000+08:00"]);
  const p = parseLedger(text(l1));
  assert.equal(p.ok, true);
  assert.deepEqual(p.ledger, l1);
});
test("chooseLedger: nothing stored is a first run", () => {
  const c = chooseLedger(null, null);
  assert.deepEqual([c.status, c.repairTo], ["NONE", null]);
  assert.equal(c.ledger.rev, 0);
});
test("chooseLedger: both stores agreeing is fine", () => {
  const c = chooseLedger(text(ledger(3)), text(ledger(3)));
  assert.deepEqual([c.status, c.repairTo, c.ledger.rev], ["OK", null, 3]);
});
test("chooseLedger: a missing or unreadable store is repaired from the survivor", () => {
  assert.deepEqual(chooseLedger(text(ledger(2)), null).repairTo, "idb");
  assert.deepEqual(chooseLedger(null, text(ledger(2))).repairTo, "local");
  assert.deepEqual(chooseLedger(text(ledger(2)), "garbage").repairTo, "idb");
  assert.deepEqual(chooseLedger("{", text(ledger(2))).repairTo, "local");
});
test("chooseLedger: when revisions differ the higher one wins and the other is repaired", () => {
  const a = chooseLedger(text(ledger(5)), text(ledger(4)));
  assert.deepEqual([a.status, a.repairTo, a.ledger.rev], ["REPAIR", "idb", 5]);
  const b = chooseLedger(text(ledger(4)), text(ledger(5)));
  assert.deepEqual([b.status, b.repairTo, b.ledger.rev], ["REPAIR", "local", 5]);
});
test("chooseLedger: two unusable stores are reported, never replaced with an empty ledger", () => {
  const c = chooseLedger("nope", "{}");
  assert.equal(c.status, "CORRUPT");
  assert.equal(c.ledger, null);
  assert.equal(c.problems.length, 2);
});
test("parseLedger rejects wrong versions, bad revisions and invalid records", () => {
  assert.equal(parseLedger(text({ ...ledger(1), v: 99 })).ok, false, "a version newer than this app knows");
  assert.equal(parseLedger(text({ ...ledger(1), v: 0 })).ok, false);
  assert.equal(parseLedger(text({ ...ledger(1), v: 1.5 })).ok, false);
  assert.equal(parseLedger(text({ ...ledger(1), v: "2" })).ok, false);
  assert.equal(parseLedger(text({ ...ledger(1), rev: -1 })).ok, false);
  assert.equal(parseLedger(text({ ...ledger(1), rev: 1.5 })).ok, false);
  assert.equal(parseLedger(text({ ...ledger(1), settings: null })).ok, false);
  const bad = ledger(1); bad.state.accounts = [{ id: "x" }];
  assert.equal(parseLedger(text(bad)).ok, false);
});
