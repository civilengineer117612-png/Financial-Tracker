import { test } from "node:test";
import assert from "node:assert/strict";
import { envelopeBalance, planGcashSpend, splitSweep, planMonthEndSweep, underBudgetedCategories, naturalBalance } from "../src/model/index.js";
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
