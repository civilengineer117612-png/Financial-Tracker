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
  assert.ok(!text.includes("\"amount\":9500"));   // a bare 4-digit number can appear by chance inside random ciphertext, so the check is on a longer marker
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

// ----- a passphrase the app can suggest (the phone's own Passwords does the saving; the app keeps nothing) -----
import { makePassphrase, PASSPHRASE_CHARS, MIN_PASSPHRASE } from "../src/model/index.js";
import { readFileSync } from "node:fs";
const appJs = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");

test("a suggested passphrase is 20 easy-to-read characters in four groups, long enough for a backup, and different each time", () => {
  const p = makePassphrase();
  assert.match(p, /^[2-9a-hjkmnp-z]{5}(-[2-9a-hjkmnp-z]{5}){3}$/);
  assert.ok(p.length >= MIN_PASSPHRASE);
  assert.ok(!/[ilo01]/.test(PASSPHRASE_CHARS), "no look-alike characters");
  assert.equal(new Set(Array.from({ length: 50 }, () => makePassphrase())).size, 50);
});
test("the suggestion draws bytes without bias: bytes of 248 or more are thrown away", () => {
  const seq = [255, 248, 250, 0, 1, 30, 31, 247, ...Array(60).fill(7)];
  let i = 0; const fill = (b) => { for (let k = 0; k < b.length; k++) b[k] = seq[i++ % seq.length]; return b; };
  const p = makePassphrase(fill).replace(/-/g, "");
  assert.equal(p.slice(0, 5), [0, 1, 30, 0, 30].map((x) => PASSPHRASE_CHARS[x]).join(""), "255, 248 and 250 skipped; 31 wraps to 0, 247 is the last character");
  assert.equal(p.length, 20);
  const seq2 = Array.from({ length: 20 }, (_, k) => k), fill2 = (b) => { b.fill(0); seq2.forEach((x, k) => { b[k] = x; }); return b; };
  assert.equal(makePassphrase(fill2), [0, 1, 2, 3, 4].map((x) => PASSPHRASE_CHARS[x]).join("") + "-" + [5, 6, 7, 8, 9].map((x) => PASSPHRASE_CHARS[x]).join("") + "-" + [10, 11, 12, 13, 14].map((x) => PASSPHRASE_CHARS[x]).join("") + "-" + [15, 16, 17, 18, 19].map((x) => PASSPHRASE_CHARS[x]).join(""), "every drawn character is used once, in order");
});
test("the suggested passphrase really opens a backup made with it", async () => {
  const p = makePassphrase(), box = await encryptBackup({ accounts: [], envelopes: [], goals: [], transactions: [], entries: [], categories: [] }, p);
  await assert.doesNotReject(decryptBackup(box, p));
  await assert.rejects(decryptBackup(box, makePassphrase()));
});
test("the backup sheet asks the phone to offer a new password; the restore sheet asks for the saved one; the app never writes a passphrase anywhere", () => {
  assert.match(appJs, /id="b-pass"[^>]*autocomplete="new-password"/); assert.match(appJs, /id="b-pass2"[^>]*autocomplete="new-password"/);
  assert.match(appJs, /id="r-pass"[^>]*autocomplete="current-password"/);
  assert.equal((appJs.match(/autocomplete="username"/g) ?? []).length, 3, "a username field (backup, restore and check, pictures restore) lets the phone label the saved entry");
  assert.ok(!/localStorage[^\n]*pass|settings[^\n]*\.pass\b|commit\([^\n]*(form\.pass|made)/.test(appJs), "the passphrase is never saved by the app");
  assert.match(appJs, /case "make-passphrase"[^\n]*M\.makePassphrase\(\)[^\n]*pass: made, pass2: made, made/, "both fields get the same passphrase");
});

test("Check a backup file only opens it: its own sheet, no replace button, no write; Setup tells you to keep a second copy off the phone", () => {
  assert.match(appJs, /case "open-check-backup": ui\.sheet = \{ type: "restore", check: true \}/);
  const block = appJs.slice(appJs.indexOf("if (sh.check) body = `<h3>This backup opens"), appJs.indexOf("else body = `<h3>Replace this phone's data?"));
  assert.ok(block.includes("Nothing on this phone was changed") && !/restore-now|commit\(|writeBoth/.test(block), "the result has no replace button and writes nothing");
  assert.match(appJs, /Keep a second copy off this phone, like iCloud Drive/);
  assert.match(appJs, /keep a second copy off this phone\."\)/);
});
