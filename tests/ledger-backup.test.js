import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptLedgerBackup, decryptLedgerBackup, decryptBackup, encryptBackup, emptyLedger, nextLedger, restoreLedger, summarizeLedger,
  backupFileName, daysSinceBackup, parseLedger, defaultCategories, defaultPresets,
} from "../src/model/index.js";
import { makeState, tx, entry, commit } from "./fixtures.js";

const PASS = "correct horse battery";
function ledger() {
  const s = makeState();
  s.categories = defaultCategories(); s.presets = defaultPresets();
  commit(s, { transaction: tx({ id: "a", date: "2026-03-04", payee: "Secret Payee" }), entries: [
    entry({ transaction_id: "a", category_id: "cat-food", amount: 9500 }), entry({ transaction_id: "a", account_id: "chk", amount: -9500 }) ] });
  return nextLedger({ ...emptyLedger(), rev: 6 }, s, { reserve_source_id: "chk", last_backup_at: "2026-03-01T09:00:00.000+08:00" }, new Date("2026-03-05T00:00:00Z"));
}

test("a ledger backup round-trips with its settings, revision and save time intact", async () => {
  const l = ledger();
  const back = await decryptLedgerBackup(await encryptLedgerBackup(l, PASS), PASS);
  assert.deepEqual(back, l);
  assert.equal(back.settings.reserve_source_id, "chk");
  assert.equal(back.rev, 7);
});
test("the stored file reveals nothing: no payee, no amounts, no account names", async () => {
  const text = JSON.stringify(await encryptLedgerBackup(ledger(), PASS));
  for (const leak of ["Secret Payee", "9500", "Test Checking", "reserve_source_id", "cat-food"]) assert.ok(!text.includes(leak), leak);
});
test("a wrong passphrase, a damaged file and an edited file all fail the same way", async () => {
  const b = await encryptLedgerBackup(ledger(), PASS);
  await assert.rejects(decryptLedgerBackup(b, "another long passphrase"), /wrong passphrase or damaged/);
  const bytes = Uint8Array.from(atob(b.data), (c) => c.charCodeAt(0)); bytes[3] ^= 1;
  await assert.rejects(decryptLedgerBackup({ ...b, data: btoa(String.fromCharCode(...bytes)) }, PASS), /wrong passphrase or damaged/);
  await assert.rejects(decryptLedgerBackup({ ...b, salt: btoa("0123456789abcdef") }, PASS), /wrong passphrase or damaged/);
});
test("a short passphrase is refused", async () => {
  await assert.rejects(encryptLedgerBackup(ledger(), "short"), /at least 12/);
});
test("invalid data is refused on the way in", async () => {
  const bad = ledger(); bad.state.accounts[0].class = "wrong";
  await assert.rejects(encryptLedgerBackup(bad, PASS), /invalid data/);
  await assert.rejects(encryptLedgerBackup({ ...ledger(), settings: null }, PASS), /invalid data/);
});
test("the two backup kinds are not mixed up", async () => {
  await assert.rejects(decryptLedgerBackup(await encryptBackup(ledger().state, PASS), PASS), /not a ledger backup/);
  await assert.rejects(decryptBackup(await encryptLedgerBackup(ledger(), PASS), PASS), /invalid/);
  await assert.rejects(decryptLedgerBackup(null, PASS), /not a ledger backup/);
});
test("the key-stretching rounds written in the file are range-checked", async () => {
  const b = await encryptLedgerBackup(ledger(), PASS);
  for (const iterations of [1, 99999, 2000001, 1e12, "600000", null, undefined]) {
    await assert.rejects(decryptLedgerBackup({ ...b, iterations }, PASS), /unsupported backup settings/, String(iterations));
  }
});
test("a backup that decrypts but holds invalid data is refused on restore", async () => {
  const l = ledger(); l.state.entries[0].amount = 1.5;
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASS), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(l)));
  const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
  await assert.rejects(decryptLedgerBackup({ v: 1, kind: "ledger", kdf: "PBKDF2-SHA256", iterations: 600000, salt: b64(salt), iv: b64(iv), data: b64(data) }, PASS), /data is invalid/);
});

test("restoring replaces the data and is stamped newer than both ledgers", () => {
  const cur = { ...emptyLedger(), rev: 12 }, back = ledger();   // the backup is revision 7
  const r = restoreLedger(cur, back, new Date("2026-03-10T00:00:00Z"));
  assert.deepEqual([r.rev, r.saved_at], [13, "2026-03-10T08:00:00.000+08:00"]);
  assert.deepEqual(r.state, back.state);
  assert.deepEqual(r.settings, back.settings);
  assert.equal(restoreLedger({ ...emptyLedger(), rev: 2 }, back).rev, 8);   // the backup's own revision can be the higher one
  assert.equal(parseLedger(JSON.stringify(r)).ok, true);
});
test("the restore preview shows counts, the latest entry date and when it was saved", () => {
  assert.deepEqual(summarizeLedger(ledger()), { accounts: 3, transactions: 1, entries: 2, latest_date: "2026-03-04", saved_at: "2026-03-05T08:00:00.000+08:00" });
  assert.deepEqual(summarizeLedger(emptyLedger()), { accounts: 0, transactions: 0, entries: 0, latest_date: null, saved_at: null });
});
test("the file name carries the date", () => {
  assert.equal(backupFileName("2026-10-03"), "finance-backup-2026-10-03.json");
});
test("days since the last backup, by Philippine date, or null if there never was one", () => {
  assert.equal(daysSinceBackup({}, "2026-03-10"), null);
  assert.equal(daysSinceBackup({ last_backup_at: "2026-03-10T23:30:00.000+08:00" }, "2026-03-10"), 0);
  assert.equal(daysSinceBackup({ last_backup_at: "2026-03-01T09:00:00.000+08:00" }, "2026-03-10"), 9);
});
test("the latest entry date is the latest, whatever order the entries were stored in", () => {
  const l = ledger();
  for (const [id, date] of [["b", "2026-03-20"], ["c", "2026-02-11"], ["d", "2026-03-09"]]) {
    l.state.transactions.push(tx({ id, date }));
  }
  assert.equal(summarizeLedger(l).latest_date, "2026-03-20");
});
