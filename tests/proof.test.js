import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, validateState, selfCheck, recordFromParse, proveMonths, acceptMonth, accountLines } from "../src/model/index.js";
import { UNLOGGED_CATEGORY_ID } from "../src/model/seed.js";

// Invented statements only: a bank, its months, its lines. Amounts in centavos.
const TS = "2026-10-14T09:00:00.000+08:00";
const line = (date, text, amount, direction, balance, meaning = "spending") => ({ date, text, payee: text, type: "", amount, direction, balance, meaning });
const parsed = (period, summary, lines, extra = {}) => ({ ok: true, style: "credit-debit", bank: "Sample Bank", period, summary, lines, check: { ok: true }, ...extra });
// Three clean months: Aug opens at 100000.
const AUG = parsed({ from: "2026-08-01", to: "2026-08-31" }, { opening: 100000, closing: 85500 }, [line("2026-08-05", "Corner Cafe", 9500, "out", 90500), line("2026-08-20", "Bus fare", 5000, "out", 85500)]);
const SEP = parsed({ from: "2026-09-01", to: "2026-09-30" }, { opening: 85500, closing: 135500 }, [line("2026-09-01", "Pay in", 60000, "in", 145500, "in"), line("2026-09-10", "Corner Cafe", 9500, "out", 136000), line("2026-09-12", "Go Save move", 500, "out", 135500, "move")]);
const OCT = parsed({ from: "2026-10-01", to: "2026-10-31" }, { opening: 135500, closing: 120500 }, [line("2026-10-03", "Card payment fee", 1500, "out", 134000, "fee"), line("2026-10-09", "Mystery person", 14000, "out", 120000, "unsure")]);
// (the Oct lines above deliberately end at 120000 against a printed closing of 120500: that month is broken until fixed)

const base = () => ({ ...emptyState(),
  accounts: [{ id: "gt", name: "Test Bank", class: "asset", role: "", hidden_by_default: false, archived: false, opening_balance: 0, opening_date: "2026-01-01" }],
  categories: [{ id: "cat-food", name: "Food", kind: "expense", role: "food" }, { id: UNLOGGED_CATEGORY_ID, name: "Unlogged", kind: "expense" }],
  presets: [{ id: "p1", name: "Corner Cafe", amount: 9500, category_id: "cat-food" }] });
const keep = (state, p, n) => { const { record, lines } = recordFromParse(p, { account_id: "gt", id: "rec" + n, now: new Date(TS) }); return { ...state, statementRecords: [...state.statementRecords, record], statementLines: [...state.statementLines, ...lines] }; };
const withStatements = (...ps) => ps.reduce((s, p, i) => keep(s, p, i + 1), { ...base() });
const seqId = () => { let n = 0; return () => "id" + ++n; };

test("a parsed statement is kept as one record and its lines, and passes the ledger's own shape check", () => {
  const s = withStatements(AUG);
  assert.deepEqual(validateState(s), []);
  assert.equal(s.statementRecords[0].opening, 100000); assert.equal(s.statementRecords[0].period_from, "2026-08-01");
  assert.equal(s.statementLines.length, 2); assert.equal(s.statementLines[0].id, "rec1:0");
});

test("a month is proved when its lines add up to the closing balance and it opens where the month before closed", () => {
  const rows = proveMonths(withStatements(AUG, SEP), "gt");
  assert.deepEqual(rows.map((r) => [r.month, r.status]), [["2026-08", "proved"], ["2026-09", "proved"]]);
  assert.equal(rows[1].opening, 85500); assert.equal(rows[1].closing, 135500); assert.equal(rows[1].moneyIn, 60000); assert.equal(rows[1].moneyOut, 10000);
});

test("lines that do not add up are broken; a different opening is a mismatch; a missing month before is a gap", () => {
  assert.equal(proveMonths(withStatements(AUG, SEP, OCT), "gt").find((r) => r.month === "2026-10").status, "broken");
  const wrongLine = parsed({ from: "2026-08-01", to: "2026-08-31" }, { opening: 100000, closing: 85500 }, [line("2026-08-05", "Corner Cafe", 9500, "out", 90000), line("2026-08-20", "Bus fare", 5000, "out", 85500)]);
  const r = proveMonths(withStatements(wrongLine), "gt")[0]; assert.equal(r.status, "broken"); assert.match(r.reason, /do(es)? not follow/);
  const SEP_OTHER = parsed({ from: "2026-09-01", to: "2026-09-30" }, { opening: 90000, closing: 90000 }, [line("2026-09-10", "Corner Cafe", 9500, "out", 80500), line("2026-09-11", "Refund", 9500, "in", 90000, "in")]);
  assert.equal(proveMonths(withStatements(AUG, SEP_OTHER), "gt")[1].status, "mismatch");
  assert.equal(proveMonths(withStatements(AUG, OCT_FIXED()), "gt")[1].status, "gap");
});
const OCT_FIXED = () => parsed({ from: "2026-10-01", to: "2026-10-31" }, { opening: 135500, closing: 120500 }, [line("2026-10-03", "Card payment fee", 1500, "out", 134000, "fee"), line("2026-10-09", "Mystery person", 13500, "out", 120500, "unsure")]);

test("a statement with no balance on its lines proves a month only when it covers exactly that month with printed opening and closing", () => {
  const noBal = (from, to, opening, closing, lines) => parsed({ from, to }, { opening, closing }, lines.map((l) => ({ ...l, balance: null })));
  const ok = noBal("2026-08-01", "2026-08-31", 100000, 90500, [line("2026-08-05", "Corner Cafe", 9500, "out", null)]);
  assert.equal(proveMonths(withStatements(ok), "gt")[0].status, "proved");
  const wide = noBal("2026-08-01", "2026-09-30", 100000, 90500, [line("2026-08-05", "Corner Cafe", 9500, "out", null)]);
  assert.equal(proveMonths(withStatements(wide), "gt")[0].status, "no-balance");
  const short = noBal("2026-08-01", "2026-08-31", 100000, 99999, [line("2026-08-05", "Corner Cafe", 9500, "out", null)]);
  assert.equal(proveMonths(withStatements(short), "gt")[0].status, "broken");
});

test("two statements that overlap do not count a line twice, but two real identical lines in one statement both stay", () => {
  const twice = parsed({ from: "2026-08-01", to: "2026-08-31" }, { opening: 100000, closing: 81000 }, [line("2026-08-05", "Corner Cafe", 9500, "out", 90500), line("2026-08-05", "Corner Cafe", 9500, "out", 81000)]);
  assert.equal(accountLines(withStatements(twice), "gt").length, 2);
  const lap = parsed({ from: "2026-08-15", to: "2026-09-14" }, {}, [line("2026-08-20", "Bus fare", 5000, "out", 85500)]);
  assert.equal(accountLines(withStatements(AUG, lap), "gt").length, 2, "the Bus fare line is in both statements and counted once");
});

test("accepting a proved month makes verified entries from its spending and fees, leaves moves, money in and unsure lines out, and keeps the books balanced", () => {
  const s = withStatements(AUG, SEP);
  const r = acceptMonth(s, "gt", "2026-09", { newId: seqId(), now: new Date(TS) });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.made, 1); assert.deepEqual(r.leftOut, { moves: 1, moneyIn: 1, unsure: 0 });
  const t = r.state.transactions.find((x) => x.source === "statement");
  assert.equal(t.status, "verified"); assert.equal(t.date, "2026-09-10"); assert.equal(t.payee, "Corner Cafe");
  assert.equal(r.state.entries.find((e) => e.transaction_id === t.id && e.category_id).category_id, "cat-food", "the category is the one the owner's quick tile of that name has");
  assert.equal(acceptMonth(withStatements(AUG), "gt", "2026-08", { newId: seqId(), now: new Date(TS) }).state.entries.find((e) => e.category_id === UNLOGGED_CATEGORY_ID).amount, 5000, "a name nothing knows goes to Unlogged, to be chosen in Verify");
  assert.deepEqual(selfCheck({ state: r.state }), []); assert.deepEqual(validateState(r.state), []);
  assert.deepEqual(r.state.statementAccepts.map((a) => [a.month, a.made]), [["2026-09", 1]]);
  assert.equal(proveMonths(r.state, "gt").find((x) => x.month === "2026-09").accepted, true);
});

test("a line already in the ledger is not made twice: a draft of it is verified, a verified one is left", () => {
  let s = withStatements(AUG);
  s = { ...s,
    transactions: [{ id: "d1", date: "2026-08-05", payee: "Corner Cafe", memo: "", status: "draft", source: "manual", created_at: TS }, { id: "v1", date: "2026-08-20", payee: "Bus fare", memo: "", status: "verified", source: "manual", created_at: TS, verified_at: TS }],
    entries: [{ transaction_id: "d1", category_id: "cat-food", amount: 9500 }, { transaction_id: "d1", account_id: "gt", amount: -9500 }, { transaction_id: "v1", category_id: "cat-food", amount: 5000 }, { transaction_id: "v1", account_id: "gt", amount: -5000 }] };
  const r = acceptMonth(s, "gt", "2026-08", { newId: seqId(), now: new Date(TS) });
  assert.equal(r.ok, true, r.message); assert.deepEqual([r.made, r.verified, r.alreadyLogged], [0, 1, 1]);
  assert.equal(r.state.transactions.find((x) => x.id === "d1").status, "verified"); assert.equal(r.state.transactions.length, 2, "nothing doubled");
});

test("a month that is not proved, or was already accepted, or has no statement cannot be accepted, and nothing changes", () => {
  const s = withStatements(AUG, SEP, OCT);
  const bad = acceptMonth(s, "gt", "2026-10", { newId: seqId() }); assert.equal(bad.ok, false); assert.match(bad.message, /not proved/);
  assert.equal(acceptMonth(s, "gt", "2026-07", { newId: seqId() }).ok, false);
  const once = acceptMonth(s, "gt", "2026-08", { newId: seqId(), now: new Date(TS) });
  assert.equal(acceptMonth(once.state, "gt", "2026-08", { newId: seqId() }).message, "That month was already accepted.");
  assert.equal(s.statementAccepts.length, 0, "the input is never changed");
});
