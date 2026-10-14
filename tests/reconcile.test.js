import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, validateState, selfCheck, recordFromParse, pairMoves, moveLogged, planPairedMove, matchPayslips } from "../src/model/index.js";

// Invented accounts, statements and amounts. GCash "gc" (last four 1111) and a bank "bk" (last four 2222).
const TS = "2026-10-14T09:00:00.000+08:00";
const acct = (id, name, last4) => ({ id, name, class: "asset", role: "", hidden_by_default: false, archived: false, opening_balance: 0, opening_date: "2022-01-01", ...(last4 ? { last4 } : {}) });
const line = (date, text, amount, direction, balance, meaning, extra = {}) => ({ date, text, payee: text, type: "", amount, direction, balance, meaning, ...extra });
const stmt = (lines, opening = 0) => ({ ok: true, style: "gcash", period: { from: "2023-01-01", to: "2023-12-31" }, summary: { opening }, lines, check: { ok: true } });
const base = () => ({ ...emptyState(), accounts: [acct("gc", "Test Wallet", "1111"), acct("bk", "Test Bank", "2222")], categories: [{ id: "cat-food", name: "Food", kind: "expense" }, { id: "cat-unlogged", name: "Unlogged", kind: "expense" }] });
const keep = (state, account, p, n) => { const { record, lines } = recordFromParse(p, { account_id: account, id: "rec" + n, now: new Date(TS) }); return { ...state, statementRecords: [...state.statementRecords, record], statementLines: [...state.statementLines, ...lines] }; };
const seqId = () => { let n = 0; return () => "id" + ++n; };

// The wallet sends P1,000 to the bank (named by its last four), and the bank shows P1,000 arriving.
const WALLET = (o = {}) => stmt([line("2023-02-01", "Sent GCash to Test Bank ending 2222", 100000 + (o.fee ?? 0), "out", 50000, "unsure", { last4: "2222" })], 150000 + (o.fee ?? 0));
const BANK = (o = {}) => stmt([line(o.date ?? "2023-02-01", "Transfer in", 100000, "in", 100000, "in")], 0);
const both = (w, b) => keep(keep(base(), "gc", w, 1), "bk", b, 2);

test("a transfer out of one account and the money in to the other is ONE move: found by the last four digits, the amount and the day", () => {
  const r = pairMoves(both(WALLET(), BANK()));
  assert.equal(r.pairs.length, 1);
  const p = r.pairs[0];
  assert.deepEqual([p.from_id, p.to_id, p.amount, p.fee, p.dayGap], ["gc", "bk", 100000, 0, 0]);
  assert.deepEqual([r.loneOut.length, r.loneIn.length], [0, 0]);
});

test("a day or two apart still pairs; a small difference is a FEE and is shown; too far apart or too different does not pair", () => {
  assert.equal(pairMoves(both(WALLET(), BANK({ date: "2023-02-03" }))).pairs[0].dayGap, 2);
  const f = pairMoves(both(WALLET({ fee: 1500 }), BANK())).pairs[0];
  assert.deepEqual([f.amount, f.fee], [100000, 1500], "the amount that arrived, and the fee that left with it");
  assert.equal(pairMoves(both(WALLET(), BANK({ date: "2023-02-10" }))).pairs.length, 0, "a week apart is not the same move");
  assert.equal(pairMoves(both(WALLET({ fee: 50000 }), BANK())).pairs.length, 0, "a difference that large is not a fee");
});

test("a line that names your account but has no partner yet (the other statement is not kept) is listed alone, never paired with something else", () => {
  const r = pairMoves(keep(base(), "gc", WALLET(), 1));
  assert.equal(r.pairs.length, 0); assert.equal(r.loneOut.length, 1);
  const other = { ...BANK(), lines: [line("2023-02-01", "Transfer in", 77700, "in", 77700, "in")] };
  assert.equal(pairMoves(both(WALLET(), other)).pairs.length, 0, "a different amount is not the same move");
});

test("each line is used once: two sends and two arrivals pair up closest first, not all to one", () => {
  const w = stmt([line("2023-02-01", "Sent GCash to Test Bank ending 2222", 100000, "out", 50000, "unsure", { last4: "2222" }), line("2023-02-05", "Sent GCash to Test Bank ending 2222", 100000, "out", 40000, "unsure", { last4: "2222" })], 150000);
  const b = stmt([line("2023-02-01", "Transfer in", 100000, "in", 100000, "in"), line("2023-02-06", "Transfer in", 100000, "in", 200000, "in")], 0);
  const r = pairMoves(both(w, b));
  assert.deepEqual(r.pairs.map((p) => [p.out.date, p.in.date]), [["2023-02-01", "2023-02-01"], ["2023-02-05", "2023-02-06"]]);
});

test("a line naming a last four that is no account of yours, or two accounts with the same digits, is not paired (never a guess)", () => {
  const w = stmt([line("2023-02-01", "Sent GCash to Stranger Bank ending 9999", 100000, "out", 50000, "unsure", { last4: "9999" })], 150000);
  assert.equal(pairMoves(both(w, BANK())).pairs.length, 0);
  const twin = both(WALLET(), BANK()); twin.accounts = [...twin.accounts, acct("bk2", "Twin", "2222")];
  assert.equal(pairMoves(twin).pairs.length, 0, "two accounts holding the same four digits: not guessed");
});

test("a pair becomes ONE draft transfer with the statement as its source (and the fee as its own draft); never twice", () => {
  const s = both(WALLET({ fee: 1500 }), BANK());
  const p = pairMoves(s).pairs[0];
  const r = planPairedMove(s, p, { newId: seqId(), now: new Date(TS) });
  assert.equal(r.ok, true, r.message);
  const t = r.state.transactions.filter((x) => x.source === "statement");
  assert.equal(t.length, 2, "the transfer and its fee"); assert.ok(t.every((x) => x.status === "draft" && x.date === "2023-02-01"));
  const main = t.find((x) => !x.id.startsWith("fee:")), es = r.state.entries.filter((e) => e.transaction_id === main.id);
  assert.deepEqual(es.map((e) => [e.account_id, e.amount]).sort(), [["bk", 100000], ["gc", -100000]].sort());
  assert.deepEqual(selfCheck({ state: r.state }), []); assert.deepEqual(validateState(r.state), []);
  assert.equal(moveLogged(r.state, p), true);
  assert.equal(planPairedMove(r.state, p, { newId: seqId() }).ok, false, "the same move is not made twice");
  assert.equal(moveLogged(s, p), false);
});

test("money in that equals a payslip's deposit near its pay date is the payslip arriving, once", () => {
  let s = keep(base(), "bk", stmt([line("2023-03-15", "Employer pay", 2500000, "in", 2500000, "in"), line("2023-03-16", "Employer pay", 2500000, "in", 5000000, "in")], 0), 1);
  s = { ...s, payslips: [{ id: "ps1", employer: "Sample Employer", period_from: "2023-03-01", period_to: "2023-03-15", pay_date: "2023-03-15", account_id: "bk", transaction_id: "t-ps1", printed_gross: 3000000, printed_net: 2500000, deposit: 2500000 }] };
  const m = matchPayslips(s);
  assert.equal(m.length, 1); assert.equal(m[0].payslip.id, "ps1"); assert.equal(m[0].line.date, "2023-03-15");
  const wrongAccount = { ...s, payslips: [{ ...s.payslips[0], account_id: "gc" }] };
  assert.equal(matchPayslips(wrongAccount).length, 0, "another account's payslip does not match");
  const off = { ...s, payslips: [{ ...s.payslips[0], deposit: 2500100 }] };
  assert.equal(matchPayslips(off).length, 0, "a different amount is not a match");
});

test("one arrival is claimed by ONE send, even when two identical sends could fit it; the other stays alone", () => {
  const w = stmt([line("2023-02-01", "Sent GCash to Test Bank ending 2222", 100000, "out", 50000, "unsure", { last4: "2222" }), line("2023-02-01", "Sent GCash to Test Bank ending 2222", 100000, "out", 40000, "unsure", { last4: "2222" })], 150000);
  const r = pairMoves(both(w, BANK()));
  assert.equal(r.pairs.length, 1); assert.equal(r.loneOut.length, 1);
});
