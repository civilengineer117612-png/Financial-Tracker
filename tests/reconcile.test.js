import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, validateState, selfCheck, recordFromParse, isPocket, setAccountPocket, planAccount, classifyLine, pairMoves, moveLogged, planPairedMove, matchPayslips } from "../src/model/index.js";

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

test("a move is also found from the RECEIVING end: money in that names your account (by its last four) pairs with the send in that account, which names only you", () => {
  // the bank's own statement shows the send under your own name (no digits); the wallet's statement says "Received from Test Bank ending 2222"
  const bank = stmt([line("2023-02-01", "Own name transfer", 100000, "out", 50000, "move", { own: true })], 150000);
  const wallet = stmt([line("2023-02-01", "Cash in from Test Bank ending 2222", 100000, "in", 100000, "in", { last4: "2222" })], 0);
  const r = pairMoves(keep(keep(base(), "bk", bank, 1), "gc", wallet, 2));
  assert.equal(r.pairs.length, 1);
  assert.deepEqual([r.pairs[0].from_id, r.pairs[0].to_id, r.pairs[0].amount], ["bk", "gc", 100000]);
  // a receiving line that names a THIRD account does not pair with it
  const wrong = stmt([line("2023-02-01", "Cash in from Test Wallet ending 1111", 100000, "in", 100000, "in", { last4: "1111" })], 0);
  const r2 = pairMoves(keep(keep(base(), "bk", bank, 1), "gc", wrong, 2));
  assert.equal(r2.pairs.length, 0, "it names the wallet itself, not the bank the money left");
});

// ----- phase 3: the ledger against the statement -----
import { statementDifference, planMissingDraft, startFromStatement, proveMonths } from "../src/model/index.js";
const food = (s) => ({ ...s, categories: [...s.categories.filter((c) => c.id !== "cat-food"), { id: "cat-food", name: "Food", kind: "expense", role: "food" }] });
const tx = (id, date, payee, amount, account, status = "verified") => ({ t: { id, date, payee, memo: "", status, source: "manual", created_at: TS, ...(status === "verified" ? { verified_at: TS } : {}) }, es: [{ transaction_id: id, category_id: "cat-food", amount }, { transaction_id: id, account_id: account, amount: -amount }] });
const withTx = (state, ...list) => ({ ...state, transactions: [...state.transactions, ...list.map((x) => x.t)], entries: [...state.entries, ...list.flatMap((x) => x.es)] });
// the bank: opens at 100,000, spends 9,500 and 5,000, closes at 85,500
const BANKM = () => stmt([line("2023-02-05", "Corner Cafe", 9500, "out", 90500, "spending"), line("2023-02-20", "Bus fare", 5000, "out", 85500, "spending")], 100000);
const diffBase = () => food({ ...keep(base(), "bk", { ...BANKM(), period: { from: "2023-02-01", to: "2023-02-28" } }, 1), accounts: [acct("gc", "Test Wallet", "1111"), { ...acct("bk", "Test Bank", "2222"), opening_balance: 100000 }] });

test("when the ledger holds exactly what the statement shows, the difference is nothing and nothing is missing", () => {
  const s = withTx(diffBase(), tx("a", "2023-02-05", "Corner Cafe", 9500, "bk"), tx("b", "2023-02-20", "Bus fare", 5000, "bk"));
  const d = statementDifference(s, "bk", "2023-02");
  assert.equal(d.ok, true, d.reason);
  assert.deepEqual([d.statementClosing, d.ledgerBalance, d.difference, d.missing.length, d.extra.length, d.carried], [85500, 85500, 0, 0, 0, 0]);
});

test("a statement line the ledger lacks is MISSING, and it explains the difference exactly", () => {
  const s = withTx(diffBase(), tx("a", "2023-02-05", "Corner Cafe", 9500, "bk"));
  const d = statementDifference(s, "bk", "2023-02");
  assert.equal(d.difference, 5000, "the ledger shows 5,000 more than the bank");
  assert.deepEqual(d.missing.map((m) => [m.line.text, m.action]), [["Bus fare", "expense"]]);
  assert.deepEqual([d.explained, d.carried], [5000, 0]);
});

test("a ledger entry the statement lacks is EXTRA; a day or two of difference still matches; the same amount twice needs two lines", () => {
  const s = withTx(diffBase(), tx("a", "2023-02-06", "Corner Cafe", 9500, "bk"), tx("b", "2023-02-20", "Bus fare", 5000, "bk"), tx("c", "2023-02-12", "Snack", 700, "bk"));
  const d = statementDifference(s, "bk", "2023-02");
  assert.deepEqual(d.extra.map((e) => [e.payee, e.amount]), [["Snack", -700]]);
  assert.equal(d.difference, -700, "the ledger shows 700 less than the bank");
  assert.deepEqual([d.explained, d.carried], [-700, 0]);
  const twice = withTx(diffBase(), tx("a", "2023-02-05", "Corner Cafe", 9500, "bk"), tx("a2", "2023-02-05", "Corner Cafe", 9500, "bk"), tx("b", "2023-02-20", "Bus fare", 5000, "bk"));
  const t = statementDifference(twice, "bk", "2023-02");
  assert.equal(t.extra.length, 1, "one line cannot cover two entries");
});

test("an opening balance that differs shows as CARRIED, not as missing lines", () => {
  const s0 = withTx(diffBase(), tx("a", "2023-02-05", "Corner Cafe", 9500, "bk"), tx("b", "2023-02-20", "Bus fare", 5000, "bk"));
  const s = { ...s0, accounts: s0.accounts.map((a) => (a.id === "bk" ? { ...a, opening_balance: 120000 } : a)) };
  const d = statementDifference(s, "bk", "2023-02");
  assert.deepEqual([d.difference, d.missing.length, d.extra.length, d.explained, d.carried], [20000, 0, 0, 0, 20000]);
});

test("a month with no closing balance is not compared (and says why)", () => {
  assert.equal(statementDifference(diffBase(), "bk", "2023-09").ok, false);
  const none = diffBase(); none.statementRecords = none.statementRecords.map((r) => ({ ...r, closing: undefined })); none.statementLines = none.statementLines.map((l) => ({ ...l, balance: null }));
  assert.equal(statementDifference(none, "bk", "2023-02").ok, false);
});

// a CARD: the statement prints what is OWED (it rises with a purchase, falls with a payment); the ledger keeps a card below zero.
// Opens owing 100,000, a purchase of 9,500, a purchase of 5,000, a payment of 20,000: closes owing 94,500.
const CARDM = () => stmt([line("2023-02-05", "Corner Cafe", 9500, "out", 109500, "spending"), line("2023-02-10", "Bus fare", 5000, "out", 114500, "spending"), line("2023-02-25", "Payment, thank you", 20000, "in", 94500, "in")], 100000);
const cardBase = () => food({ ...keep(base(), "cd", { ...CARDM(), period: { from: "2023-02-01", to: "2023-02-28" } }, 1), accounts: [acct("gc", "Test Wallet", "1111"), { ...acct("cd", "Test Card", "3333"), class: "liability", opening_balance: -100000 }] });
const pay = (id, date, amount) => ({ t: { id, date, payee: "Card payment", memo: "", status: "verified", source: "manual", created_at: TS, verified_at: TS }, es: [{ transaction_id: id, account_id: "gc", amount: -amount }, { transaction_id: id, account_id: "cd", amount, card_state: "posted" }] });
const cardTx = (id, date, payee, amount) => { const x = tx(id, date, payee, amount, "cd"); x.es[1].card_state = "posted"; return x; };

test("a CARD month is proved against the amount owed, and is compared in owed terms: the ledger agrees, owes less, or owes more", () => {
  const all = withTx(cardBase(), cardTx("a", "2023-02-05", "Corner Cafe", 9500), cardTx("b", "2023-02-10", "Bus fare", 5000), pay("p", "2023-02-25", 20000));
  assert.equal(proveMonths(all, "cd")[0].status, "proved", proveMonths(all, "cd")[0].reason);
  const d = statementDifference(all, "cd", "2023-02");
  assert.equal(d.ok, true, d.reason); assert.equal(d.card, true);
  assert.deepEqual([d.statementClosing, d.ledgerBalance, d.difference, d.missing.length, d.extra.length], [94500, -94500, 0, 0, 0]);
  const lacking = withTx(cardBase(), cardTx("a", "2023-02-05", "Corner Cafe", 9500), pay("p", "2023-02-25", 20000));
  const l = statementDifference(lacking, "cd", "2023-02");
  assert.deepEqual([l.difference, l.explained, l.carried, l.missing.map((m) => [m.line.text, m.action])], [5000, 5000, 0, [["Bus fare", "expense"]]], "the ledger owes 5,000 LESS than the statement: a purchase is missing");
  const more = withTx(cardBase(), cardTx("a", "2023-02-05", "Corner Cafe", 9500), cardTx("b", "2023-02-10", "Bus fare", 5000), cardTx("c", "2023-02-12", "Snack", 700), pay("p", "2023-02-25", 20000));
  assert.deepEqual([statementDifference(more, "cd", "2023-02").difference, statementDifference(more, "cd", "2023-02").extra.length], [-700, 1], "the ledger owes 700 MORE: an entry the statement lacks");
});

test("on a card a payment line is named, never made into income; a purchase line becomes ONE draft expense on the card", () => {
  const noPay = withTx(cardBase(), cardTx("a", "2023-02-05", "Corner Cafe", 9500), cardTx("b", "2023-02-10", "Bus fare", 5000));
  const m = statementDifference(noPay, "cd", "2023-02").missing;
  assert.deepEqual(m.map((x) => [x.line.text, x.action]), [["Payment, thank you", "payment"]]);
  const refused = planMissingDraft(noPay, m[0].line, { newId: seqId(), now: new Date(TS) });
  assert.deepEqual([refused.ok, refused.message], [false, "A payment to a card is not added here."], "a payment is not added here");
  const one = withTx(cardBase(), cardTx("a", "2023-02-05", "Corner Cafe", 9500), pay("p", "2023-02-25", 20000));
  const r = planMissingDraft(one, statementDifference(one, "cd", "2023-02").missing[0].line, { newId: seqId(), now: new Date(TS) });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(selfCheck({ state: r.state }), []); assert.deepEqual(validateState(r.state), []);
  assert.equal(statementDifference(r.state, "cd", "2023-02").difference, 0, "after adding it the ledger owes what the statement says");
  assert.equal(startFromStatement(one, "cd").ok, false, "a card never starts from its statement");
});

test("a missing spending line becomes ONE draft expense (source statement), never verified by itself; a move is not made this way", () => {
  const s = withTx(diffBase(), tx("a", "2023-02-05", "Corner Cafe", 9500, "bk"));
  const m = statementDifference(s, "bk", "2023-02").missing[0];
  const r = planMissingDraft(s, m.line, { newId: seqId(), now: new Date(TS) });
  assert.equal(r.ok, true, r.message);
  const t = r.state.transactions.find((x) => x.source === "statement");
  assert.deepEqual([t.status, t.date, t.payee], ["draft", "2023-02-20", "Bus fare"]);
  assert.deepEqual(selfCheck({ state: r.state }), []); assert.deepEqual(validateState(r.state), []);
  assert.equal(statementDifference(r.state, "bk", "2023-02").difference, 0, "after adding it the ledger agrees with the bank");
  assert.equal(planMissingDraft(s, { ...m.line, direction: "out", meaning: "move" }, { newId: seqId() }).ok, false);
});

// the bank: spends 9,500, receives 20,000 from a person, sends 3,000 that does not say what it was; the ledger holds only the spending
const MIXED = () => stmt([line("2023-02-05", "Corner Cafe", 9500, "out", 90500, "spending"), line("2023-02-10", "Sample Person", 20000, "in", 110500, "in"), line("2023-02-12", "Sample Person", 3000, "out", 107500, "unsure")], 100000);
const mixedBase = () => {
  const s = withTx(food({ ...keep(base(), "bk", { ...MIXED(), period: { from: "2023-02-01", to: "2023-02-28" } }, 1), accounts: [acct("gc", "Test Wallet", "1111"), { ...acct("bk", "Test Bank", "2222"), opening_balance: 100000 }] }), tx("a", "2023-02-05", "Corner Cafe", 9500, "bk"));
  return { ...s, categories: [...s.categories, { id: "cat-unlogged", name: "Unlogged", kind: "expense" }, { id: "cat-salary", name: "Salary", kind: "income" }, { id: "cat-other-income", name: "Other income", kind: "income" }, { id: "cat-family", name: "Family", kind: "expense" }] };
};

test("money in becomes ONE draft of income in the account, in Other income, and unsure money out becomes ONE draft expense in Unlogged (or in the payee's own category)", () => {
  const s = mixedBase(), d = statementDifference(s, "bk", "2023-02");
  assert.deepEqual(d.missing.map((m) => m.action), ["in", "choose"]);
  const ids = seqId(), inc = planMissingDraft(s, d.missing[0].line, { newId: ids, now: new Date(TS) });
  assert.equal(inc.ok, true, inc.message); assert.equal(inc.kind, "income");
  const t = inc.state.transactions.find((x) => x.source === "statement");
  assert.deepEqual([t.status, t.date, t.payee], ["draft", "2023-02-10", "Sample Person"]);
  const es = inc.state.entries.filter((e) => e.transaction_id === t.id);
  assert.deepEqual(es.map((e) => [e.account_id ?? e.category_id, e.amount]), [["bk", 20000], ["cat-other-income", -20000]]);
  assert.deepEqual(selfCheck({ state: inc.state }), []); assert.deepEqual(validateState(inc.state), []);
  assert.deepEqual(statementDifference(inc.state, "bk", "2023-02").missing.map((m) => m.action), ["choose"], "the line is no longer missing");
  const unsure = planMissingDraft(inc.state, d.missing[1].line, { newId: ids, now: new Date(TS) });
  assert.equal(unsure.ok, true, unsure.message); assert.equal(unsure.kind, "expense");
  const u = unsure.state.transactions.filter((x) => x.source === "statement").find((x) => x.date === "2023-02-12");
  assert.equal(unsure.state.entries.find((e) => e.transaction_id === u.id && e.category_id).category_id, "cat-unlogged");
  assert.equal(statementDifference(unsure.state, "bk", "2023-02").difference, 0, "with both drafts the ledger agrees with the bank");
  assert.deepEqual(validateState(unsure.state), []);
  const named = planMissingDraft(s, d.missing[1].line, { newId: seqId(), now: new Date(TS), book: { "sample person": { name: "Sample Person", category_id: "cat-family" } } });
  assert.equal(named.state.entries.find((e) => e.category_id && e.transaction_id !== "a" && e.category_id !== "cat-food").category_id, "cat-family", "a payee you named keeps its category");
  const none = { ...s, categories: s.categories.filter((c) => c.kind !== "income") };
  assert.equal(planMissingDraft(none, d.missing[0].line, { newId: seqId() }).ok, false, "no income category, no draft");
});

test("starting an account from its statement sets its opening balance and date; the first month must be proved; earlier entries are counted as history", () => {
  let s = withTx(diffBase(), tx("old", "2023-01-10", "Earlier", 1000, "bk"));
  s = { ...s, accounts: s.accounts.map((a) => (a.id === "bk" ? { ...a, opening_balance: 555, opening_date: "2022-01-01" } : a)) };
  const r = startFromStatement(s, "bk");
  assert.equal(r.ok, true, r.message);
  assert.deepEqual([r.opening, r.from, r.ignored], [100000, "2023-02-01", 1]);
  const a = r.state.accounts.find((x) => x.id === "bk");
  assert.deepEqual([a.opening_balance, a.opening_date], [100000, "2023-02-01"]);
  assert.equal(s.accounts.find((x) => x.id === "bk").opening_balance, 555, "the input is never changed");
  const bad = { ...keep(base(), "gt", { ...BANKM(), lines: BANKM().lines.map((l) => ({ ...l, balance: 1 })) }, 1), accounts: [acct("gt", "X")] };
  assert.equal(startFromStatement(bad, "gt").ok, false, "a first month that is not proved cannot be the start");
});

// ---- Go Save pockets: a pocket is an account (role "pocket") of the same bank as the main account; they name each other only as "Go Save account" / "Deposit account" ----
const gt = (id, name, role = "") => ({ ...acct(id, name), bank: "gotyme", role });
const pbase = (pockets = ["pk"]) => ({ ...base(), accounts: [gt("gm", "GoTyme"), ...pockets.map((p) => gt(p, "GoTyme · " + p, "pocket"))] });
const MAIN = (date = "2023-03-05") => stmt([line(date, "Transfer to Go Save account", 90000, "out", 10000, "move")], 100000);
const POCKET = (date = "2023-03-05", amount = 90000) => stmt([line(date, "Transfer from Deposit account", amount, "in", amount, "move")], 0);

test("a pocket flag is kept in the spare role field; only an account that holds money can be one, never a card's reserve", () => {
  const s = pbase();
  assert.equal(isPocket(s.accounts[1]), true); assert.equal(isPocket(s.accounts[0]), false);
  const on = setAccountPocket(s, "gm", true); assert.equal(isPocket(on.state.accounts[0]), true);
  assert.equal(isPocket(setAccountPocket(on.state, "gm", false).state.accounts[0]), false, "and it can be turned off again");
  const card = { ...s, accounts: [...s.accounts, { ...acct("cc", "Card"), class: "liability" }] };
  assert.equal(setAccountPocket(card, "cc", true).ok, false);
  const made = planAccount(s, { id: "n1", bank: "gotyme", sub: "Travel", kind: "asset", opening: 0, date: "2026-10-15", pocket: true });
  assert.equal(made.account.role, "pocket"); assert.equal(planAccount(s, { id: "n2", name: "Plain", kind: "asset", date: "2026-10-15" }).account.role, "");
  assert.deepEqual(validateState(on.state), [], "the saved shape is unchanged");
});

test("the lines between a pocket and its main account are moves of your own money, not money in and not unsure", () => {
  for (const t of ["Transfer from Deposit account", "Transfer to Deposit account", "Transfer to Go Save account", "Transfer from Go Save account"])
    for (const d of ["in", "out"]) assert.equal(classifyLine({ text: t, direction: d }).meaning, "move", t + " " + d);
});

test("Main's send to Go Save and the pocket's arrival are ONE move, found without any digits: same bank, one pocket, same amount, close days", () => {
  const s = keep(keep(pbase(), "gm", MAIN(), 1), "pk", POCKET("2023-03-06"), 2);
  const r = pairMoves(s);
  assert.equal(r.pairs.length, 1);
  assert.deepEqual([r.pairs[0].from_id, r.pairs[0].to_id, r.pairs[0].amount, r.pairs[0].dayGap], ["gm", "pk", 90000, 1]);
  assert.equal(pairMoves(keep(keep(pbase(), "gm", MAIN(), 1), "pk", POCKET("2023-03-20"), 2)).pairs.length, 0, "too far apart");
  assert.equal(pairMoves(keep(keep(pbase(), "gm", MAIN(), 1), "pk", POCKET("2023-03-05", 50000), 2)).pairs.length, 0, "a different amount");
});

test("two pockets that could both fit are NEVER guessed: nothing pairs", () => {
  const s = keep(keep(keep(pbase(["pk", "pj"]), "gm", MAIN(), 1), "pk", POCKET(), 2), "pj", POCKET(), 3);
  assert.equal(pairMoves(s).pairs.length, 0);
});

test("without a pocket on either side (two ordinary accounts of one bank) the words alone pair nothing", () => {
  const plain = { ...pbase(), accounts: [gt("gm", "GoTyme"), gt("gx", "GoTyme · Other")] };
  assert.equal(pairMoves(keep(keep(plain, "gm", MAIN(), 1), "gx", POCKET(), 2)).pairs.length, 0);
});
