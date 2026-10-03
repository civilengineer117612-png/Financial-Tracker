import { test } from "node:test";
import assert from "node:assert/strict";
import { validateState, encryptBackup, decryptBackup } from "../src/model/index.js";
import { makeState, tx, entry, commit } from "./fixtures.js";

const PASS = "correct horse battery";
function state() {
  const s = makeState();
  commit(s, { transaction: tx({ id: "a", payee: "Secret Payee" }), entries: [
    entry({ transaction_id: "a", category_id: "food", amount: 9500 }), entry({ transaction_id: "a", account_id: "chk", amount: -9500 }) ] });
  return s;
}

test("a valid state has no violations; bad records and unknown collections are named", () => {
  assert.deepEqual(validateState(state()), []);
  const bad = state(); bad.entries[0].amount = 1.5;
  assert.match(validateState(bad)[0].message, /entries\[0\]/);
  assert.match(validateState({ stuff: [] })[0].message, /unknown collection/);
  assert.match(validateState({ accounts: {} })[0].message, /must be an array/);
});

test("round trip returns exactly the original data", async () => {
  const s = state();
  assert.deepEqual(await decryptBackup(await encryptBackup(s, PASS), PASS), s);
});
test("the stored backup does not contain the plaintext", async () => {
  const text = JSON.stringify(await encryptBackup(state(), PASS));
  assert.ok(!text.includes("Secret Payee"));
  assert.ok(!text.includes("9500"));
});
test("two backups of the same data differ (fresh salt and IV)", async () => {
  const a = await encryptBackup(state(), PASS), b = await encryptBackup(state(), PASS);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.data, b.data);
});
test("wrong passphrase fails", async () => {
  const b = await encryptBackup(state(), PASS);
  await assert.rejects(decryptBackup(b, "a different passphrase"), /wrong passphrase or damaged/);
});
test("a tampered backup fails", async () => {
  const b = await encryptBackup(state(), PASS);
  const bytes = Uint8Array.from(atob(b.data), (c) => c.charCodeAt(0)); bytes[5] ^= 1;
  await assert.rejects(decryptBackup({ ...b, data: btoa(String.fromCharCode(...bytes)) }, PASS), /wrong passphrase or damaged/);
});
test("short passphrase, invalid data and unknown version are refused", async () => {
  await assert.rejects(encryptBackup(state(), "short"), /at least 12/);
  const bad = state(); bad.accounts[0].class = "wrong";
  await assert.rejects(encryptBackup(bad, PASS), /invalid data/);
  await assert.rejects(decryptBackup({ v: 2 }, PASS), /unsupported/);
});

test("a backup that decrypts fine but holds invalid data is refused on restore", async () => {
  // Build a genuine ciphertext of bad data with the same scheme, bypassing encryptBackup's own check.
  const bad = state(); bad.accounts[0].class = "wrong";
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASS), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(bad)));
  const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
  const backup = { v: 1, kdf: "PBKDF2-SHA256", iterations: 600000, salt: b64(salt), iv: b64(iv), data: b64(data) };
  await assert.rejects(decryptBackup(backup, PASS), /data is invalid/);
});
