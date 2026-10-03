// Spec 10.3: local-first, encrypted backup only. A passphrase is stretched with PBKDF2
// and used with AES-GCM, which both hides the data and detects any tampering or a wrong
// passphrase (decryption simply fails). Uses the standard Web Crypto API, present in
// browsers and Node. Attachment FILES are not in a backup, only their metadata rows.
import { SCHEMAS, validateShape } from "./schema.js";

const ITERATIONS = 600000;     // PBKDF2-SHA256; deliberately slow so guessing is slow
export const MIN_PASSPHRASE = 12;

// state key -> entity name, for validating every record on the way in and out.
const COLLECTIONS = {
  accounts: "Account", goals: "Goal", envelopes: "Envelope", transactions: "Transaction", entries: "Entry",
  categories: "Category", categoryMaps: "CategoryMap", rules: "Rule", templates: "Template", presets: "Preset",
  payeeRules: "PayeeRule", subscriptions: "Subscription", checkIns: "CheckIn", attachments: "Attachment",
  tags: "Tag", foreignAmounts: "ForeignAmount",
};

// Every record in every collection must be well-formed; unknown collections are refused.
export function validateState(state) {
  if (typeof state !== "object" || state === null) return [{ code: "SHAPE", severity: "error", message: "state must be an object" }];
  const out = [];
  for (const [key, rows] of Object.entries(state)) {
    const entity = COLLECTIONS[key];
    if (!entity) { out.push({ code: "SHAPE", severity: "error", message: "unknown collection " + key }); continue; }
    if (!Array.isArray(rows)) { out.push({ code: "SHAPE", severity: "error", message: key + " must be an array" }); continue; }
    rows.forEach((r, i) => validateShape(entity, r).forEach((v) => out.push({ ...v, message: key + "[" + i + "] " + v.message })));
  }
  return out;
}

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFrom(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Returns a JSON-safe object to store anywhere (file, cloud drive). A fresh salt and IV
// every time means two backups of the same data look completely different.
export async function encryptBackup(state, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE) throw new Error("passphrase must be at least " + MIN_PASSPHRASE + " characters");
  const problems = validateState(state);
  if (problems.length) throw new Error("refusing to back up invalid data: " + problems[0].message);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passphrase, salt, ITERATIONS);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(state)));
  return { v: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

// Wrong passphrase, damaged file and edited file all fail the same way: an Error.
export async function decryptBackup(backup, passphrase) {
  if (!backup || backup.v !== 1) throw new Error("unsupported backup version");
  let plain;
  try {
    const key = await keyFrom(passphrase, unb64(backup.salt), backup.iterations);
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(backup.iv) }, key, unb64(backup.data));
  } catch {
    throw new Error("could not decrypt: wrong passphrase or damaged backup");
  }
  const state = JSON.parse(new TextDecoder().decode(plain));
  const problems = validateState(state);
  if (problems.length) throw new Error("backup decrypted but its data is invalid: " + problems[0].message);
  return state;
}
