import { test } from "node:test";
import assert from "node:assert/strict";
import { LEDGER_VERSION, COLLECTION_NAMES, encryptLedgerBackup, decryptLedgerBackup, encryptBackup, decryptBackup, parseLedger } from "../src/model/index.js";

// A ledger with a long history is hundreds of kilobytes of text. Making the backup file once failed with "Maximum call stack size exceeded" because every
// byte was passed to one function call. These tests make a backup of a big ledger (invented entries) and open it again.
const TS = "2026-03-04T09:00:00.000+08:00";
function bigLedger(n) {
  const state = Object.fromEntries(COLLECTION_NAMES.map((k) => [k, []]));
  state.accounts = [{ id: "wal", name: "Test Wallet", class: "asset", role: "", hidden_by_default: false, archived: false, opening_balance: 100000, opening_date: "2026-01-01" }];
  state.categories = [{ id: "cat-food", name: "Food", kind: "expense" }];
  for (let i = 0; i < n; i++) {
    state.transactions.push({ id: "t" + i, date: "2026-03-04", payee: "Sample Shop number " + i, memo: "an invented memo to make the line longer", status: "verified", source: "manual", created_at: TS, verified_at: TS });
    state.entries.push({ transaction_id: "t" + i, category_id: "cat-food", amount: 9500 }, { transaction_id: "t" + i, account_id: "wal", amount: -9500 });
  }
  return { v: LEDGER_VERSION, rev: 7, saved_at: TS, state, settings: { last_backup_at: TS } };
}

test("a backup of a big ledger (over a megabyte of text) is made and opens again with every entry", async () => {
  const ledger = bigLedger(6000);
  assert.ok(JSON.stringify(ledger).length > 1_000_000, "the ledger is over a megabyte");
  const sealed = await encryptLedgerBackup(ledger, "correct horse battery");
  assert.ok(typeof sealed.data === "string" && sealed.data.length > 1_000_000);
  const back = await decryptLedgerBackup(sealed, "correct horse battery");
  assert.equal(back.state.transactions.length, 6000);
  assert.equal(back.state.entries.length, 12000);
  assert.deepEqual(back.state.transactions[5999], ledger.state.transactions[5999]);
  assert.ok(parseLedger(JSON.stringify(back)).ok);
});

test("the older state-only backup also handles a big state", async () => {
  const state = bigLedger(4000).state;
  const back = await decryptBackup(await encryptBackup(state, "correct horse battery"), "correct horse battery");
  assert.equal(back.transactions.length, 4000);
});

test("a wrong passphrase still fails the same way on a big backup", async () => {
  const sealed = await encryptLedgerBackup(bigLedger(500), "correct horse battery");
  await assert.rejects(() => decryptLedgerBackup(sealed, "not the passphrase at all"), /wrong passphrase or damaged backup/);
});
