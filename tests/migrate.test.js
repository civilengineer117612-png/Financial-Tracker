import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEDGER_VERSION, MIGRATIONS, COLLECTION_NAMES, parseLedger, chooseLedger, upgradeLedger, selfCheck, fingerprint, rotateCopies, restorableCopy,
  restoreLedger, encryptLedgerBackup, decryptLedgerBackup, naturalBalance,
} from "../src/model/index.js";

// Data as the FIRST data version wrote it (v 1), written out by hand so it does not move when the code does: no payslip revisions, and in the
// older one no payslips at all. Invented names and amounts.
const TS = "2026-03-04T09:00:00.000+08:00";
const acct = (o) => ({ role: "", hidden_by_default: false, archived: false, opening_balance: 0, opening_date: "2026-01-01", ...o });
function v1Early() {
  return {
    v: 1, rev: 6, saved_at: "2026-03-05T08:00:00.000+08:00",
    state: {
      accounts: [acct({ id: "chk", name: "Test Checking", class: "asset", opening_balance: 100000 }), acct({ id: "card", name: "Test Card", class: "liability" }), acct({ id: "res", name: "Test Reserve", class: "asset", reserve_for: "card" })],
      goals: [], envelopes: [], categories: [{ id: "cat-food", name: "Food", kind: "expense" }, { id: "cat-salary", name: "Salary", kind: "income" }], categoryMaps: [], rules: [],
      templates: [], presets: [], payeeRules: [], subscriptions: [], checkIns: [], attachments: [], tags: [], foreignAmounts: [], surveyResponses: [],
      transactions: [
        { id: "t1", date: "2026-03-04", payee: "Sample Shop", memo: "", status: "verified", source: "manual", created_at: TS, verified_at: TS },
        { id: "t2", date: "2026-03-05", payee: "Sample Employer", memo: "", status: "verified", source: "manual", created_at: TS, verified_at: TS },
      ],
      entries: [
        { transaction_id: "t1", category_id: "cat-food", amount: 9500 }, { transaction_id: "t1", account_id: "chk", amount: -9500 },
        { transaction_id: "t2", account_id: "chk", amount: 500000 }, { transaction_id: "t2", category_id: "cat-salary", amount: -500000 },
      ],
    },
    settings: { reserve_source_id: "chk", last_backup_at: "2026-03-01T09:00:00.000+08:00", last_employer: "Sample Employer" },
  };
}
function v1WithPayslip() {
  const l = v1Early();
  l.state.payslips = [{ id: "ps1", employer: "Sample Employer", period_from: "2026-03-01", period_to: "2026-03-15", pay_date: "2026-03-05", account_id: "chk", transaction_id: "t2", printed_gross: 500000, printed_net: 500000, deposit: 500000 }];
  l.state.payslipLines = [{ payslip_id: "ps1", side: "earning", kind: "basic", amount: 500000 }];
  return l;
}
const FIXTURES = { "version 1, before payslips": v1Early, "version 1, with a payslip": v1WithPayslip };
const text = (l) => JSON.stringify(l);
// every field of `a` is still in `b` with the same value (b may have more)
const holds = (a, b) => (typeof a !== "object" || a === null ? a === b : typeof b === "object" && b !== null && Object.keys(a).every((k) => holds(a[k], b[k])));

test("the current data version is 3 and the first version's data is still accepted as older", () => {
  assert.equal(LEDGER_VERSION, 3);
  for (const make of Object.values(FIXTURES)) { const p = parseLedger(text(make())); assert.equal(p.ok, true); assert.equal(p.older, true); }
  const cur = upgradeLedger(v1Early()).ledger;
  assert.equal(parseLedger(text(cur)).older, undefined);
});

for (const [name, make] of Object.entries(FIXTURES)) {
  test(`a ${name} ledger upgrades with the same totals, every field kept, and passes the self-check`, () => {
    const before = make(), snapshot = JSON.stringify(before);
    const r = upgradeLedger(before, { now: new Date("2026-10-05T00:00:00Z") });
    assert.equal(r.ok, true, r.error);
    assert.equal(JSON.stringify(before), snapshot, "the input is never changed");
    assert.equal(r.ledger.v, LEDGER_VERSION); assert.equal(r.ledger.rev, before.rev + 1);
    assert.equal(fingerprint(r.ledger), fingerprint(before));
    assert.deepEqual(selfCheck(r.ledger), []);
    for (const k of COLLECTION_NAMES) assert.ok(Array.isArray(r.ledger.state[k]), k + " exists");
    const { v, rev, saved_at, ...rest } = before;
    assert.ok(holds(rest, r.ledger), "no field was dropped or changed");
    const acc = r.ledger.state.accounts.find((a) => a.id === "chk");
    assert.equal(naturalBalance(acc, r.ledger.state.entries), 100000 - 9500 + 500000, "the balance is the same after");
    assert.equal(parseLedger(text(r.ledger)).ok, true);
  });
}

test("a version 1 backup file opens, and upgrades to the same totals", async () => {
  const sealed = await encryptLedgerBackup(v1WithPayslip(), "correct horse battery");
  const back = await decryptLedgerBackup(sealed, "correct horse battery");
  assert.equal(back.v, 1);
  const r = upgradeLedger(back);
  assert.equal(r.ok, true, r.error);
  assert.equal(fingerprint(r.ledger), fingerprint(v1WithPayslip()));
});

test("restoring an older backup keeps its own data version, so the app upgrades it (with a copy) instead of calling half-converted data current", () => {
  const cur = { v: LEDGER_VERSION, rev: 9, saved_at: TS, state: {}, settings: {} };
  const r = restoreLedger(cur, v1Early());
  assert.equal(r.v, 1); assert.equal(r.rev, 9 + 1);
});

test("chooseLedger passes an older ledger through unchanged for the app to upgrade", () => {
  const t = text(v1Early());
  const c = chooseLedger(t, t);
  assert.equal(c.status, "OK"); assert.equal(c.ledger.v, 1);
});

test("an update that stops part way, has no step, or meets unknown data leaves the data alone and says why in plain words", () => {
  const before = v1Early(), snapshot = JSON.stringify(before);
  const boom = upgradeLedger(before, { migrations: { ...MIGRATIONS, 1: () => { throw new Error("x"); } } });
  assert.equal(boom.ok, false); assert.match(boom.error, /stopped part way/);
  assert.match(upgradeLedger(before, { migrations: {} }).error, /no way to update data from version 1/);
  assert.match(upgradeLedger(before, { migrations: { 1: MIGRATIONS[1] } }).error, /no way to update data from version 2/, "a missing later step is also refused");
  assert.equal(upgradeLedger({ ...before, v: 0 }).ok, false);
  assert.equal(upgradeLedger({ ...before, v: LEDGER_VERSION + 1 }).ok, false);
  assert.equal(upgradeLedger({ ...before, v: "1" }).ok, false);
  assert.equal(JSON.stringify(before), snapshot);
});

test("an update that changes a total, or leaves an entry that does not add up, is refused", () => {
  const before = v1Early();
  const lose = upgradeLedger(before, { migrations: { ...MIGRATIONS, 1: (l) => ({ ...l, state: { ...l.state, entries: l.state.entries.filter((e) => e.transaction_id !== "t1") } }) } });
  assert.equal(lose.ok, false);
  const skew = upgradeLedger(before, { migrations: { ...MIGRATIONS, 1: (l) => ({ ...l, state: { ...l.state, entries: l.state.entries.map((e) => (e.transaction_id === "t1" && e.account_id ? { ...e, amount: -9400 } : e)) } }) } });
  assert.equal(skew.ok, false); assert.match(skew.error, /not add up|problem after|totals/);
  const skewCat = upgradeLedger(before, { migrations: { ...MIGRATIONS, 1: (l) => ({ ...l, state: { ...l.state, entries: l.state.entries.map((e) => (e.transaction_id === "t1" && e.category_id ? { ...e, amount: 9400 } : e)) } }) } });
  assert.equal(skewCat.ok, false); assert.match(skewCat.error, /problem after the update: 1 entry does not add up/, "only the self-check can see this one: no account balance moved");
  const coins = upgradeLedger(before, { migrations: { ...MIGRATIONS, 1: (l) => ({ ...l, state: { ...l.state, accounts: l.state.accounts.map((a) => (a.id === "chk" ? { ...a, opening_balance: a.opening_balance + 1 } : a)) } }) } });
  assert.equal(coins.ok, false); assert.match(coins.error, /totals were not the same/, "an account holding a centavo more is a changed total");
  const junk = upgradeLedger(before, { migrations: { ...MIGRATIONS, 1: (l) => ({ ...l, state: { ...l.state, accounts: [{ id: "x" }] } }) } });
  assert.equal(junk.ok, false);
});

test("the self-check finds entries that do not add up to zero, a record out of shape, and a reserve check that cannot compute", () => {
  const good = upgradeLedger(v1Early()).ledger;
  assert.deepEqual(selfCheck(good), []);
  const off = JSON.parse(JSON.stringify(good)); off.state.entries[0].amount = 9400;
  assert.match(selfCheck(off).join(" "), /1 entry does not add up to zero/);
  const two = JSON.parse(JSON.stringify(good)); two.state.entries[0].amount = 1; two.state.entries[2].amount = 1;
  assert.match(selfCheck(two).join(" "), /2 entries do not add up to zero/);
  const shape = JSON.parse(JSON.stringify(good)); shape.state.accounts[0] = { id: "x" };
  assert.match(selfCheck(shape).join(" "), /not in the right shape/);
  assert.match(selfCheck(good, { reserve: () => { throw new Error("x"); } }).join(" "), /reserve check could not be worked out/);
  assert.match(selfCheck(good, { reserve: () => null }).join(" "), /reserve check gave no answer/);
  assert.match(selfCheck({}).join(" "), /no records/);
});

test("no migration deletes or changes a field: each step, run on the oldest data, keeps every field it had", () => {
  for (const [v, step] of Object.entries(MIGRATIONS)) {
    for (const make of Object.values(FIXTURES)) {
      const before = make(); before.v = Number(v);
      const after = step(JSON.parse(JSON.stringify(before)));
      const { v: _v, ...rest } = before;
      assert.ok(holds(rest, after), "step from version " + v + " kept every field");
    }
  }
});

test("the last two copies from before an upgrade are kept, newest first, and the same data is not copied twice", () => {
  const A = text(v1Early()), l2 = v1WithPayslip(), B = text(l2), l3 = v1Early(); l3.settings.last_employer = "Other"; const C = text(l3);
  let c = rotateCopies([], A, { at: "1" });
  c = rotateCopies(c, B, { at: "2" }); c = rotateCopies(c, C, { at: "3" });
  assert.deepEqual(c.map((x) => x.at), ["3", "2"]); assert.equal(c.length, 2);
  assert.equal(rotateCopies(c, C.replace('"rev":6', '"rev":7'), { at: "4" }).map((x) => x.at).join(), "3,2", "only the revision differs: no new copy");
  assert.equal(rotateCopies(null, A, { at: "1" }).length, 1);
});

test("a stored copy comes back with its own data version, newer than what is on the phone", () => {
  const copy = { at: "x", text: text(v1Early()) };
  const r = restorableCopy(copy, 20, new Date("2026-10-05T00:00:00Z"));
  assert.equal(r.v, 1); assert.equal(r.rev, 21); assert.equal(r.state.accounts.length, 3);
  assert.equal(restorableCopy(copy, 2).rev, 7, "or newer than the copy itself");
});
