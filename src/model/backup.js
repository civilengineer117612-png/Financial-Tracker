// Spec 10.3: local-first, encrypted backup only. A passphrase is stretched with PBKDF2
// and used with AES-GCM, which both hides the data and detects any tampering or a wrong
// passphrase (decryption simply fails). Uses the standard Web Crypto API, present in
// browsers and Node. Attachment FILES are not in a backup, only their metadata rows.
import { validateState } from "./validate.js";
import { parseLedger } from "./persist.js";

export { validateState } from "./validate.js";

const ITERATIONS = 600000;     // PBKDF2-SHA256; deliberately slow so guessing is slow
export const MIN_PASSPHRASE = 12;

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFrom(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Shared by every backup kind. A fresh salt and IV every time means two backups of the same
// data look completely different. `extra` labels the container (e.g. {kind: "ledger"}).
async function seal(text, passphrase, extra = {}) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE) throw new Error("passphrase must be at least " + MIN_PASSPHRASE + " characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passphrase, salt, ITERATIONS);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return { v: 1, ...extra, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

// Wrong passphrase, damaged file and edited file all fail the same way: an Error.
// The file states its own key-stretching rounds, so they are range-checked: a tampered file
// must not be able to make the phone grind for minutes.
async function unseal(backup, passphrase) {
  if (!backup || backup.v !== 1) throw new Error("unsupported backup version");
  if (!Number.isInteger(backup.iterations) || backup.iterations < 100000 || backup.iterations > 2000000) throw new Error("unsupported backup settings");
  try {
    const key = await keyFrom(passphrase, unb64(backup.salt), backup.iterations);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(backup.iv) }, key, unb64(backup.data)));
  } catch {
    throw new Error("could not decrypt: wrong passphrase or damaged backup");
  }
}

export async function encryptBackup(state, passphrase) {
  const problems = validateState(state);
  if (problems.length) throw new Error("refusing to back up invalid data: " + problems[0].message);
  return seal(JSON.stringify(state), passphrase);
}

export async function decryptBackup(backup, passphrase) {
  const state = JSON.parse(await unseal(backup, passphrase));
  const problems = validateState(state);
  if (problems.length) throw new Error("backup decrypted but its data is invalid: " + problems[0].message);
  return state;
}

// The whole ledger: every record AND the app's settings (which account hosts the reserve,
// last backup date...). `ledger` is {v, rev, saved_at, state, settings}; it is checked on both
// ends exactly as it is when saved to the phone.
export async function encryptLedgerBackup(ledger, passphrase) {
  const check = parseLedger(JSON.stringify(ledger));
  if (!check.ok) throw new Error("refusing to back up invalid data: " + check.error);
  return seal(JSON.stringify(ledger), passphrase, { kind: "ledger" });
}

export async function decryptLedgerBackup(backup, passphrase) {
  if (!backup || backup.kind !== "ledger") throw new Error("this is not a ledger backup");
  const parsed = parseLedger(await unseal(backup, passphrase));
  if (!parsed.ok) throw new Error("backup decrypted but its data is invalid: " + parsed.error);
  return parsed.ledger;
}
