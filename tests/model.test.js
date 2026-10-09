import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateShape, checkTransactionSave, checkRulesSave, cardOutstanding, naturalBalance,
  splitByBudgetStatus, phTimestamp, isPhDate, isPhTimestamp,
} from "../src/model/index.js";
import { makeState, account, tx, entry, cardPurchase, reserveSetAside, commit, rule } from "./fixtures.js";

const codes = (r) => r.violations.map((v) => v.code);

// ---------- units and dates ----------
test("phTimestamp prints Philippine time, including across midnight", () => {
  assert.equal(phTimestamp(new Date("2026-10-02T00:00:00Z")), "2026-10-02T08:00:00.000+08:00");
  assert.equal(phTimestamp(new Date("2026-10-02T20:00:00Z")), "2026-10-03T04:00:00.000+08:00");
  assert.ok(isPhTimestamp(phTimestamp()));
});
test("dates must be real calendar dates; timestamps must carry +08:00", () => {
  assert.ok(isPhDate("2026-02-28"));
  assert.ok(!isPhDate("2026-02-30"));
  assert.ok(!isPhDate("2026-2-3"));
  assert.ok(!isPhTimestamp("2026-01-05T09:00:00Z"));
  assert.ok(!isPhTimestamp("2026-01-05T09:00:00+00:00"));
  assert.ok(!isPhTimestamp("2026-01-05T25:00:00+08:00"));
});

// ---------- shape ----------
test("a well-formed account passes", () => {
  assert.deepEqual(validateShape("Account", makeState().accounts[0]), []);
});
test("fractional centavos are rejected, not rounded", () => {
  const bad = account({ id: "x", name: "X", class: "asset", opening_balance: 10.5 });
  assert.equal(validateShape("Account", bad)[0].field, "opening_balance");
});
test("unknown fields and missing fields are rejected", () => {
  const a = account({ id: "x", name: "X", class: "asset", colour: "red" });
  assert.ok(validateShape("Account", a).some((v) => v.field === "colour"));
  const { name, ...noName } = makeState().accounts[0];
  assert.ok(validateShape("Account", noName).some((v) => v.field === "name"));
});
test("verified needs verified_at; draft must not have it", () => {
  assert.equal(validateShape("Transaction", tx({ status: "verified" })).length, 1);
  assert.equal(validateShape("Transaction", tx({ verified_at: "2026-01-06T08:00:00.000+08:00" })).length, 1);
  assert.deepEqual(validateShape("Transaction", tx({ status: "verified", verified_at: "2026-01-06T08:00:00.000+08:00" })), []);
});
test("an entry targets exactly one of account or category", () => {
  assert.equal(validateShape("Entry", entry({ amount: 5 })).length, 1);
  assert.equal(validateShape("Entry", entry({ amount: 5, account_id: "a", category_id: "c" })).length, 1);
  assert.deepEqual(validateShape("Entry", entry({ amount: 5, account_id: "a" })), []);
});
test("check-in difference must equal counted minus ledger", () => {
  const c = { id: "c", date: "2026-01-05", account_id: "chk", counted_balance: 1000, ledger_balance: 1200, difference: -200 };
  assert.deepEqual(validateShape("CheckIn", c), []);
  assert.equal(validateShape("CheckIn", { ...c, difference: 200 }).length, 1);
});

// ---------- 7.1: entries sum to zero ----------
test("balanced two-entry debit purchase is accepted", () => {
  const s = makeState();
  const r = checkTransactionSave(s, {
    transaction: tx(),
    entries: [entry({ category_id: "food", amount: 9500 }), entry({ account_id: "chk", amount: -9500 })],
  });
  assert.deepEqual(r, { ok: true, violations: [] });
});
test("one centavo off is rejected", () => {
  const r = checkTransactionSave(makeState(), {
    transaction: tx(),
    entries: [entry({ category_id: "food", amount: 9500 }), entry({ account_id: "chk", amount: -9499 })],
  });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("UNBALANCED"));
});
test("a single entry is rejected", () => {
  const r = checkTransactionSave(makeState(), { transaction: tx(), entries: [entry({ category_id: "food", amount: 0 })] });
  assert.ok(codes(r).includes("TOO_FEW_ENTRIES"));
});
test("split lines across categories still balance", () => {
  const r = checkTransactionSave(makeState(), {
    transaction: tx(),
    entries: [entry({ category_id: "food", amount: 6000 }), entry({ category_id: "pay", amount: 3000 }), entry({ account_id: "chk", amount: -9000 })],
  });
  assert.equal(r.ok, true);
});
test("shape errors stop the check before invariants run", () => {
  const r = checkTransactionSave(makeState(), {
    transaction: tx(),
    entries: [entry({ category_id: "food", amount: 95.5 }), entry({ account_id: "chk", amount: -95.5 })],
  });
  assert.deepEqual([...new Set(codes(r))], ["SHAPE"]);
});

// ---------- references ----------
test("unknown account, category, envelope and foreign envelope are rejected", () => {
  const s = makeState();
  const save = (e) => checkTransactionSave(s, { transaction: tx(), entries: [e, entry({ account_id: "chk", amount: -e.amount })] });
  assert.ok(codes(save(entry({ account_id: "nope", amount: 5 }))).includes("UNKNOWN_ACCOUNT"));
  assert.ok(codes(save(entry({ category_id: "nope", amount: 5 }))).includes("UNKNOWN_CATEGORY"));
  assert.ok(codes(save(entry({ account_id: "chk", envelope_id: "nope", amount: 5 }))).includes("UNKNOWN_ENVELOPE"));
  assert.ok(codes(save(entry({ account_id: "res", envelope_id: "env1", amount: 5 }))).includes("ENVELOPE_MISMATCH"));
});
test("entries must belong to the transaction being saved", () => {
  const r = checkTransactionSave(makeState(), {
    transaction: tx(),
    entries: [entry({ transaction_id: "other", category_id: "food", amount: 5 }), entry({ account_id: "chk", amount: -5 })],
  });
  assert.ok(codes(r).includes("WRONG_TRANSACTION"));
});

// ---------- pending vs posted on the card ----------
test("card entries need card_state; non-card entries must not have it", () => {
  const s = makeState();
  const noState = checkTransactionSave(s, {
    transaction: tx(),
    entries: [entry({ category_id: "food", amount: 100 }), entry({ account_id: "card", amount: -100 })],
  });
  assert.ok(codes(noState).includes("CARD_STATE_MISSING"));
  const stray = checkTransactionSave(s, {
    transaction: tx(),
    entries: [entry({ category_id: "food", amount: 100 }), entry({ account_id: "chk", amount: -100, card_state: "posted" })],
  });
  assert.ok(codes(stray).includes("CARD_STATE_UNEXPECTED"));
});
test("outstanding = posted + pending", () => {
  const s = makeState();
  commit(s, cardPurchase("a", 10000, "posted"));
  commit(s, cardPurchase("b", 30000, "pending"));
  assert.deepEqual(cardOutstanding(s.accounts[2], s.entries), { posted: 10000, pending: 30000, total: 40000 });
  assert.equal(naturalBalance(s.accounts[2], s.entries), 40000);
});

// ---------- 7.1: reserve covers the card (warn only) ----------
const reserveWarning = (r) => r.violations.find((v) => v.code === "RESERVE_BELOW_OUTSTANDING");

test("a card purchase with no reserve set-aside warns but is still saved", () => {
  const r = checkTransactionSave(makeState(), cardPurchase("a", 20000));
  assert.equal(r.ok, true);
  assert.equal(reserveWarning(r).severity, "warning");
  assert.equal(reserveWarning(r).shortfall, 20000);
  assert.equal(reserveWarning(r).worsened, true);
});
test("a pending charge counts toward what the reserve must cover", () => {
  assert.equal(reserveWarning(checkTransactionSave(makeState(), cardPurchase("a", 20000, "pending"))).shortfall, 20000);
});
test("purchase covered by the reserve gives no warning", () => {
  const s = makeState();
  commit(s, reserveSetAside("r", 20000));
  assert.deepEqual(checkTransactionSave(s, cardPurchase("a", 20000)), { ok: true, violations: [] });
  commit(s, cardPurchase("a", 20000));
  assert.equal(naturalBalance(s.accounts[1], s.entries), 20000);
});
test("reserve exactly equal to outstanding passes (>=, not >)", () => {
  const s = makeState();
  commit(s, reserveSetAside("r", 15000));
  assert.equal(reserveWarning(checkTransactionSave(s, cardPurchase("a", 15000))), undefined);
  assert.equal(reserveWarning(checkTransactionSave(s, cardPurchase("a", 15001))).shortfall, 1);
});
test("an existing shortfall warns on unrelated saves, flagged as not worsened", () => {
  const s = makeState();
  s.accounts[2].opening_balance = 50000;
  const r = checkTransactionSave(s, {
    transaction: tx(),
    entries: [entry({ category_id: "food", amount: 100 }), entry({ account_id: "chk", amount: -100 })],
  });
  assert.equal(r.ok, true);
  assert.equal(reserveWarning(r).worsened, false);
});
test("a partial top-up shrinks the warning", () => {
  const s = makeState();
  s.accounts[2].opening_balance = 50000;
  const w = reserveWarning(checkTransactionSave(s, reserveSetAside("r", 20000)));
  assert.equal(w.shortfall, 30000);
  assert.equal(w.worsened, false);
});
test("editing a transaction replaces its old entries instead of double counting", () => {
  const s = makeState();
  commit(s, reserveSetAside("r", 20000));
  commit(s, cardPurchase("a", 20000));
  assert.equal(reserveWarning(checkTransactionSave(s, cardPurchase("a", 20000))), undefined);
  assert.equal(reserveWarning(checkTransactionSave(s, cardPurchase("a", 20001))).shortfall, 1);
});

// ---------- 7.1: duplicates ----------
test("same reference number and same amount is a duplicate", () => {
  const s = makeState();
  const first = { transaction: tx({ id: "a", reference_no: "REF-1" }), entries: [entry({ transaction_id: "a", category_id: "food", amount: 5000 }), entry({ transaction_id: "a", account_id: "chk", amount: -5000 })] };
  commit(s, first);
  const second = { transaction: tx({ id: "b", reference_no: "REF-1" }), entries: [entry({ transaction_id: "b", category_id: "food", amount: 5000 }), entry({ transaction_id: "b", account_id: "chk", amount: -5000 })] };
  const r = checkTransactionSave(s, second);
  assert.equal(r.ok, true, "a repeat is a warning with the older entry named, never a refusal");
  assert.equal(r.violations[0].severity, "warning");
  assert.equal(r.violations[0].duplicate_of, "a");
});
test("a repeat more than 3 days later is not flagged; the same two accounts, amount, day and screenshot time are", () => {
  const s = makeState();
  const mk = (id, over, date) => ({ transaction: tx({ id, date, ...over }), entries: [entry({ transaction_id: id, account_id: "res", amount: 5000 }), entry({ transaction_id: id, account_id: "chk", amount: -5000 })] });
  commit(s, mk("a", { reference_no: "REF-9", shot_time: "14:05" }, "2026-03-10"));
  assert.equal(checkTransactionSave(s, mk("b", { reference_no: "REF-9" }, "2026-03-13")).violations[0]?.duplicate_of, "a", "3 days later is still the same payment");
  assert.deepEqual(checkTransactionSave(s, mk("c", { reference_no: "REF-9" }, "2026-03-14")).violations, [], "4 days later is a different one");
  assert.equal(checkTransactionSave(s, mk("d", { shot_time: "14:05" }, "2026-03-10")).violations[0]?.duplicate_of, "a", "no reference, but the same time on the same day");
  assert.deepEqual(checkTransactionSave(s, mk("e", { shot_time: "14:06" }, "2026-03-10")).violations, [], "another minute is another payment");
  assert.deepEqual(checkTransactionSave(s, mk("f", { shot_time: "14:05" }, "2026-03-11")).violations, [], "another day is another payment");
});
test("same reference but different amount is not a duplicate", () => {
  const s = makeState();
  commit(s, { transaction: tx({ id: "a", reference_no: "REF-1" }), entries: [entry({ transaction_id: "a", category_id: "food", amount: 5000 }), entry({ transaction_id: "a", account_id: "chk", amount: -5000 })] });
  const r = checkTransactionSave(s, { transaction: tx({ id: "b", reference_no: "REF-1" }), entries: [entry({ transaction_id: "b", category_id: "food", amount: 5001 }), entry({ transaction_id: "b", account_id: "chk", amount: -5001 })] });
  assert.equal(r.ok, true);
});
test("same amount alone, or amount with no reference, is never a duplicate", () => {
  const s = makeState();
  commit(s, { transaction: tx({ id: "a", reference_no: "REF-1" }), entries: [entry({ transaction_id: "a", category_id: "food", amount: 5000 }), entry({ transaction_id: "a", account_id: "chk", amount: -5000 })] });
  const mk = (id, ref) => ({ transaction: tx({ id, reference_no: ref }), entries: [entry({ transaction_id: id, category_id: "food", amount: 5000 }), entry({ transaction_id: id, account_id: "chk", amount: -5000 })] });
  assert.equal(checkTransactionSave(s, mk("b", "REF-2")).ok, true);
  assert.equal(checkTransactionSave(s, mk("c", undefined)).ok, true);
  commit(s, mk("c", undefined));
  assert.equal(checkTransactionSave(s, mk("d", undefined)).ok, true);
});
test("re-saving the same transaction is not a duplicate of itself", () => {
  const s = makeState();
  const a = { transaction: tx({ id: "a", reference_no: "REF-1" }), entries: [entry({ transaction_id: "a", category_id: "food", amount: 5000 }), entry({ transaction_id: "a", account_id: "chk", amount: -5000 })] };
  commit(s, a);
  assert.equal(checkTransactionSave(s, a).ok, true);
});

// ---------- 7.1: rules append-only ----------
test("adding a new dated row is allowed", () => {
  const prev = [rule()];
  const next = [rule(), rule({ id: "r2", amount: 450000, effective_from: "2026-03-01" })];
  assert.deepEqual(checkRulesSave(prev, next), { ok: true, violations: [] });
});
test("editing an existing row is rejected", () => {
  const r = checkRulesSave([rule()], [rule({ amount: 450000 })]);
  assert.deepEqual(codes(r), ["RULE_EDITED"]);
});
test("deleting an existing row is rejected", () => {
  assert.deepEqual(codes(checkRulesSave([rule()], [])), ["RULE_DELETED"]);
});
test("reusing an id for a new row is rejected", () => {
  assert.ok(codes(checkRulesSave([], [rule(), rule()])).includes("RULE_DUPLICATE_ID"));
});
test("a malformed rule (no effective date) is rejected", () => {
  const { effective_from, ...bad } = rule();
  assert.deepEqual(codes(checkRulesSave([], [bad])), ["SHAPE"]);
});

// ---------- 7.1: only verified counts toward budgets ----------
test("drafts are pending; only verified transactions are counted", () => {
  const v = tx({ id: "v", status: "verified", verified_at: "2026-01-06T08:00:00.000+08:00" });
  const d = tx({ id: "d" });
  const { counted, pending } = splitByBudgetStatus([v, d]);
  assert.deepEqual(counted.map((t) => t.id), ["v"]);
  assert.deepEqual(pending.map((t) => t.id), ["d"]);
});
