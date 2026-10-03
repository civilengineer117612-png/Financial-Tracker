import { test } from "node:test";
import assert from "node:assert/strict";
import { envelopeBalance, planGcashSpend, splitSweep, planMonthEndSweep, underBudgetedCategories, planEnvelopeSetup, planBufferFunding, bufferSummary, naturalBalance } from "../src/model/index.js";
import { makeState, account, tx, entry, commit } from "./fixtures.js";

// Invented data: wallet with a 50.00 allowance and a 200.00 buffer; targets are made up.
function walletState() {
  const s = makeState();
  s.accounts.push(
    account({ id: "wallet", name: "Test Wallet", class: "asset" }),
    account({ id: "mole", name: "Test Mole", class: "asset", opening_balance: 90000 }),
    account({ id: "emerg", name: "Test Emergency", class: "asset" }),
  );
  s.envelopes.push(
    { id: "allow", account_id: "wallet", name: "Allowance", purpose: "rides" },
    { id: "buf", account_id: "wallet", name: "Buffer", purpose: "overrun" },
  );
  s.categories.push({ id: "rides", name: "Rides", kind: "expense" });
  fund(s, "f1", "allow", 5000);
  fund(s, "f2", "buf", 20000);
  return s;
}
function fund(s, id, envelope, amt) {
  commit(s, { transaction: tx({ id }), entries: [
    entry({ transaction_id: id, account_id: "wallet", envelope_id: envelope, amount: amt }),
    entry({ transaction_id: id, account_id: "chk", amount: -amt }),
  ] });
}
const spend = (o) => ({ transaction_id: "s1", date: "2026-01-10", payee: "Ride", category_id: "rides", amount: 3000,
  gcash_account_id: "wallet", allowance_envelope_id: "allow", buffer_envelope_id: "buf", ...o });
const codes = (p) => p.violations.map((v) => v.code);

test("envelope balance is the sum of entries tagged with it", () => {
  const s = walletState();
  assert.equal(envelopeBalance(s.entries, "allow"), 5000);
  assert.equal(envelopeBalance(s.entries, "buf"), 20000);
});

test("a spend inside the allowance touches only the allowance, no warnings", () => {
  const s = walletState();
  const p = planGcashSpend(s, spend({ amount: 3000 }));
  assert.equal(p.ok, true);
  assert.deepEqual(p.violations, []);
  commit(s, p);
  assert.equal(envelopeBalance(s.entries, "allow"), 2000);
  assert.equal(envelopeBalance(s.entries, "buf"), 20000);
});

test("spending the last of the allowance warns that further spending draws the buffer", () => {
  const p = planGcashSpend(walletState(), spend({ amount: 5000 }));
  assert.equal(p.ok, true);
  assert.deepEqual(codes(p), ["ALLOWANCE_EMPTY"]);
});

test("a spend beyond the allowance draws the buffer, tagged in the same transaction as the category", () => {
  const s = walletState();
  const p = planGcashSpend(s, spend({ amount: 7000 }));
  assert.equal(p.ok, true);
  assert.deepEqual(codes(p), ["ALLOWANCE_EMPTY", "BUFFER_DRAWN"]);
  assert.equal(p.violations.find((v) => v.code === "BUFFER_DRAWN").drawn, 2000);
  commit(s, p);
  assert.equal(envelopeBalance(s.entries, "allow"), 0);
  assert.equal(envelopeBalance(s.entries, "buf"), 18000);
  assert.equal(p.entries.reduce((a, e) => a + e.amount, 0), 0);
  assert.equal(naturalBalance(s.accounts.find((a) => a.id === "wallet"), s.entries), 18000);   // 250.00 held, 70.00 spent
});

test("a spend beyond allowance and buffer is still saved, with an exhausted warning", () => {
  const p = planGcashSpend(walletState(), spend({ amount: 30000 }));
  assert.equal(p.ok, true);
  assert.ok(codes(p).includes("BUFFER_EXHAUSTED"));
  assert.equal(p.violations.find((v) => v.code === "BUFFER_EXHAUSTED").untracked, 5000);
  assert.equal(p.entries.reduce((a, e) => a + e.amount, 0), 0);
});

// ---------- month-end sweep ----------
test("sweep: buffer goes to Mole until its target, then the rest to Emergency", () => {
  assert.deepEqual(splitSweep(20000, 90000, 100000), { toMole: 10000, toEmergency: 10000 });
  assert.deepEqual(splitSweep(20000, 0, 100000), { toMole: 20000, toEmergency: 0 });
  assert.deepEqual(splitSweep(20000, 100000, 100000), { toMole: 0, toEmergency: 20000 });
  assert.deepEqual(splitSweep(20000, 130000, 100000), { toMole: 0, toEmergency: 20000 });   // already over target
  assert.deepEqual(splitSweep(0, 0, 100000), { toMole: 0, toEmergency: 0 });
});

test("sweep transaction is a draft template, balances, and empties the buffer", () => {
  const s = walletState();
  const p = planMonthEndSweep(s, { transaction_id: "sw", date: "2026-01-31", gcash_account_id: "wallet", buffer_envelope_id: "buf",
    mole_account_id: "mole", emergency_account_id: "emerg", mole_target: 100000 });
  assert.equal(p.ok, true);
  assert.equal(p.transaction.status, "draft");
  assert.equal(p.transaction.source, "template");
  commit(s, p);
  assert.equal(envelopeBalance(s.entries, "buf"), 0);
  assert.equal(naturalBalance(s.accounts.find((a) => a.id === "mole"), s.entries), 100000);
  assert.equal(naturalBalance(s.accounts.find((a) => a.id === "emerg"), s.entries), 10000);
});

test("empty buffer: no sweep transaction; unknown account is reported", () => {
  const s = walletState();
  const base = { transaction_id: "sw", date: "2026-01-31", gcash_account_id: "wallet", buffer_envelope_id: "nobuffer",
    mole_account_id: "mole", emergency_account_id: "emerg", mole_target: 100000 };
  assert.equal(planMonthEndSweep(s, base).transaction, null);
  assert.equal(planMonthEndSweep(s, { ...base, buffer_envelope_id: "buf", mole_account_id: "nope" }).violations[0].code, "UNKNOWN_ACCOUNT");
});

// ---------- repeated draws ----------
test("a category drawn on in several different months is flagged as under-budgeted", () => {
  const s = walletState();
  const draw = (id, date) => {
    commit(s, { transaction: tx({ id, date }), entries: [
      entry({ transaction_id: id, category_id: "rides", amount: 1000 }),
      entry({ transaction_id: id, account_id: "wallet", envelope_id: "buf", amount: -1000 }),
    ] });
  };
  draw("d1", "2026-01-05"); draw("d2", "2026-01-20");   // same month twice counts once
  assert.deepEqual(underBudgetedCategories(s, "buf", 2), []);
  draw("d3", "2026-02-03");
  assert.deepEqual(underBudgetedCategories(s, "buf", 2), [{ category_id: "rides", months: ["2026-01", "2026-02"] }]);
  assert.deepEqual(underBudgetedCategories(s, "buf", 3), []);
});

test("funding the buffer is not a draw", () => {
  assert.deepEqual(underBudgetedCategories(walletState(), "buf", 1), []);
});

test("funding the buffer straight from an income category is not a draw", () => {
  const s = walletState();
  commit(s, { transaction: tx({ id: "inc", date: "2026-03-01" }), entries: [
    entry({ transaction_id: "inc", category_id: "pay", amount: -5000 }),
    entry({ transaction_id: "inc", account_id: "wallet", envelope_id: "buf", amount: 5000 }),
  ] });
  assert.deepEqual(underBudgetedCategories(s, "buf", 1), []);
});

// ---------- setting the envelopes up and showing the buffer ----------
function bare() {
  const s = makeState();
  s.accounts.push(account({ id: "wallet", name: "Test Wallet", class: "asset", opening_balance: 65731 }));
  s.categories.push({ id: "rides", name: "Rides", kind: "expense" });
  return s;
}
const SETUP = { gcash_account_id: "wallet", allowance_envelope_id: "allow", buffer_envelope_id: "buf", allowance_amount: 15731, buffer_amount: 50000, date: "2026-10-05", transaction_ids: ["t-a", "t-b"] };

test("setting up splits the wallet into two envelopes without changing what the wallet holds", () => {
  const s = bare();
  const r = planEnvelopeSetup(s, SETUP);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.equal(r.state.envelopes.length, s.envelopes.length + 2);
  assert.deepEqual([envelopeBalance(r.state.entries, "allow"), envelopeBalance(r.state.entries, "buf")], [15731, 50000]);
  const wallet = r.state.accounts.find((a) => a.id === "wallet");
  assert.equal(naturalBalance(wallet, r.state.entries), 65731, "the wallet total is unchanged");
  assert.ok(r.state.transactions.every((t) => t.status === "verified"));
  assert.equal(s.envelopes.length, 1, "the input state is untouched");
});
test("setup refuses envelopes bigger than the wallet, bad amounts, a non-asset account, and doing it twice", () => {
  const s = bare();
  assert.equal(planEnvelopeSetup(s, { ...SETUP, buffer_amount: 60000 }).violations[0].code, "MORE_THAN_HELD");
  assert.equal(planEnvelopeSetup(s, { ...SETUP, buffer_amount: -1 }).violations[0].code, "BAD_AMOUNT");
  assert.equal(planEnvelopeSetup(s, { ...SETUP, allowance_amount: 1.5 }).violations[0].code, "BAD_AMOUNT");
  assert.equal(planEnvelopeSetup(s, { ...SETUP, gcash_account_id: "card" }).violations[0].code, "UNKNOWN_ACCOUNT");
  assert.equal(planEnvelopeSetup(planEnvelopeSetup(s, SETUP).state, SETUP).violations[0].code, "DUPLICATE_ID");
  const none = planEnvelopeSetup(s, { ...SETUP, allowance_amount: 0, buffer_amount: 0 });
  assert.equal(none.ok && none.state.transactions.length === s.transactions.length, true, "two empty envelopes need no transactions");
});
test("topping up the buffer moves money in from another account", () => {
  const s = planEnvelopeSetup(bare(), SETUP).state;
  const r = planBufferFunding(s, { transaction_id: "up", date: "2026-10-15", amount: 100000, from_account_id: "chk", gcash_account_id: "wallet", buffer_envelope_id: "buf" });
  assert.equal(r.ok, true);
  assert.equal(envelopeBalance(r.state.entries, "buf"), 150000);
  assert.equal(planBufferFunding(s, { transaction_id: "x", date: "2026-10-15", amount: 0, from_account_id: "chk", gcash_account_id: "wallet", buffer_envelope_id: "buf" }).violations[0].code, "BAD_AMOUNT");
  assert.equal(planBufferFunding(s, { transaction_id: "x", date: "2026-10-15", amount: 5, from_account_id: "wallet", gcash_account_id: "wallet", buffer_envelope_id: "buf" }).violations[0].code, "SAME_ACCOUNT");
});
test("the buffer summary lists this month's draws by category and ignores the month-end sweep", () => {
  let s = planEnvelopeSetup(bare(), { ...SETUP, allowance_amount: 1000, buffer_amount: 20000 }).state;
  const gcash = (id, date, amt, extra) => { const p = planGcashSpend(s, { transaction_id: id, date, payee: "Ride", category_id: "rides", amount: amt, gcash_account_id: "wallet", allowance_envelope_id: "allow", buffer_envelope_id: "buf" }); s = { ...s, transactions: [...s.transactions, { ...p.transaction, ...extra }], entries: [...s.entries, ...p.entries] }; };
  gcash("a", "2026-10-06", 3000, { status: "verified", verified_at: "2026-10-06T09:00:00.000+08:00" });   // 1000 allowance + 2000 buffer
  gcash("b", "2026-10-07", 500, {});                                                                       // a draft, all from the buffer
  gcash("c", "2026-09-30", 700, { status: "verified", verified_at: "2026-09-30T09:00:00.000+08:00" });    // last month
  const sum = bufferSummary(s, { allowance_envelope_id: "allow", buffer_envelope_id: "buf", month: "2026-10" });
  assert.deepEqual(sum.draws.map((d) => [d.name, d.amount, d.pending]), [["Rides", 2000, 500]]);
  assert.equal(sum.drawn, 2500);
  assert.deepEqual([sum.allowance, sum.buffer], [0, 20000 - 2000 - 500 - 700], "the balances count every entry");
});
