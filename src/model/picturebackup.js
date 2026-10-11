// The Pictures file: the receipt and payslip pictures, kept apart from the ledger backup so that one stays small. Same passphrase idea, same strong
// key stretching and AES-GCM, but written in pieces (one per picture) so the phone never has to hold one huge block, and cut into parts so no
// file grows past `maxBytes`. Each part opens on its own, so restoring is "put back what is missing", part by part, in any order.
//
// Layout of a part:  [4-byte length][header JSON] then, for each picture, [4-byte length][12-byte IV][encrypted piece], and a last "end" piece that
// marks the end, so a cut-off file is noticed. A piece's plaintext is [4-byte length][meta JSON {id}][the picture's bytes].
// Each piece is bound to its position (additional data "pic<n>"), so pieces cannot be reordered or dropped unnoticed.
import { MIN_PASSPHRASE } from "./backup.js";

export const PART_BYTES = 120 * 1024 * 1024;   // a part stays near this size, a safe size to hold in memory and to share
const ITERATIONS = 600000;
const enc = new TextEncoder(), dec = new TextDecoder();
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const readU32 = (b, at = 0) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const aad = (i) => enc.encode("pic" + i);

async function keyFrom(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Groups pictures into parts: [{id, size}] -> [[id, ...], ...], each part at most `maxBytes` unless one picture alone is bigger. Order is kept.
export function planParts(items, maxBytes = PART_BYTES) {
  const parts = []; let cur = [], size = 0;
  for (const it of items) {
    if (cur.length && size + it.size > maxBytes) { parts.push(cur); cur = []; size = 0; }
    cur.push(it.id); size += it.size;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

export const partFileName = (date, part, parts) => `finance-pictures-${date}${parts > 1 ? `-part${part}of${parts}` : ""}.fpics`;

// items: [{id, bytes: Uint8Array}] (or a function giving one at a time, so only one picture is in memory besides the result). Returns a Blob.
export async function sealPictures(items, passphrase, { savedAt = "", part = 1, parts = 1, iterations = ITERATIONS } = {}) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE) throw new Error("passphrase must be at least " + MIN_PASSPHRASE + " characters");
  const salt = crypto.getRandomValues(new Uint8Array(16)), key = await keyFrom(passphrase, salt, iterations);
  const header = enc.encode(JSON.stringify({ v: 1, kind: "pictures", kdf: "PBKDF2-SHA256", iterations, salt: b64(salt), saved_at: savedAt, part, parts }));
  const pieces = [u32(header.length), header];
  let n = 0;
  const put = async (meta, bytes) => {
    const m = enc.encode(JSON.stringify(meta)), plain = new Uint8Array(4 + m.length + bytes.length);
    plain.set(u32(m.length), 0); plain.set(m, 4); plain.set(bytes, 4 + m.length);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(n) }, key, plain));
    pieces.push(u32(12 + ct.length), iv, ct); n++;
  };
  let count = 0;
  for (const it of items) { const one = typeof it === "function" ? await it() : it; if (one) { await put({ id: one.id }, one.bytes); count++; } }
  await put({ end: true, count }, new Uint8Array(0));
  return new Blob(pieces, { type: "application/octet-stream" });
}

// Reads a part and checks every piece; calls onPicture(id, bytes) for each. Throws on a wrong passphrase, a damaged, edited, reordered or cut-off file.
// Returns {count, part, parts, saved_at}.
export async function openPictures(blob, passphrase, onPicture = async () => {}) {
  const fail = (msg) => { throw new Error(msg); };
  const read = async (from, len) => { const b = new Uint8Array(await blob.slice(from, from + len).arrayBuffer()); if (b.length !== len) fail("the file is cut off"); return b; };
  let at = 0, header;
  try { const hl = readU32(await read(0, 4)); if (hl < 20 || hl > 4096) fail("not a pictures file"); header = JSON.parse(dec.decode(await read(4, hl))); at = 4 + hl; }
  catch (e) { throw new Error(e.message === "the file is cut off" ? e.message : "that is not a pictures file"); }
  if (header?.v !== 1 || header.kind !== "pictures") throw new Error("that is not a pictures file");
  if (!Number.isInteger(header.iterations) || header.iterations < 100000 || header.iterations > 2000000) throw new Error("unsupported file settings");
  let key; try { key = await keyFrom(passphrase, unb64(header.salt), header.iterations); } catch { throw new Error("that is not a pictures file"); }
  let n = 0, count = 0, ended = false;
  while (at < blob.size) {
    if (ended) fail("the file has extra data after its end");
    const len = readU32(await read(at, 4)); at += 4;
    if (len < 12 + 16 || at + len > blob.size) fail("the file is cut off");
    const piece = await read(at, len); at += len;
    let plain;
    try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: piece.slice(0, 12), additionalData: aad(n) }, key, piece.slice(12))); }
    catch { throw new Error("could not decrypt: wrong passphrase or damaged file"); }
    const ml = readU32(plain), meta = JSON.parse(dec.decode(plain.slice(4, 4 + ml)));
    if (meta.end) ended = true;   // each piece is bound to its position, so a dropped or swapped piece never gets this far
    else { await onPicture(meta.id, plain.slice(4 + ml)); count++; }
    n++;
  }
  if (!ended) fail("the file is cut off");
  return { count, part: header.part, parts: header.parts, saved_at: header.saved_at };
}
