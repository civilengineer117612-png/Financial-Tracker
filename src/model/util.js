// Small pure helpers. No Node-only imports: this code must also run in the browser.

// Money is stored as integer centavos (spec 7.1). Floats are rejected, not rounded.
export const isCentavos = (n) => typeof n === "number" && Number.isSafeInteger(n);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?\+08:00$/;

// A calendar date written as YYYY-MM-DD. A bare date has no timezone, so it cannot
// drift between UTC and Philippine time. Round-tripping catches 2026-02-30.
export function isPhDate(s) {
  const m = typeof s === "string" && DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// An instant must carry the explicit +08:00 offset (Philippine time, spec 7.1).
export function isPhTimestamp(s) {
  const m = typeof s === "string" && TS_RE.exec(s);
  return Boolean(m) && isPhDate(m[1]) && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 60;
}

// Format an instant as Philippine time: shift by 8h, print as UTC, relabel the offset.
export function phTimestamp(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00");
}

// Structural equality for plain JSON values (used by the append-only rule check).
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
}
