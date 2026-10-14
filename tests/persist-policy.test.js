import { test } from "node:test";
import assert from "node:assert/strict";
import { saveOutcome, ledgerBytes, formatBytes } from "../src/model/persist.js";

test("a full localStorage mirror is not an error while IndexedDB holds the save", () => {
  const o = saveOutcome({ local: false, idb: true });
  assert.equal(o.ok, true); assert.equal(o.error, null); assert.equal(o.mirror, false);
});
test("both stores saved: ok, mirror kept", () => {
  assert.deepEqual(saveOutcome({ local: true, idb: true }), { ok: true, mirror: true, error: null });
});
test("IndexedDB failing is an error, even when the mirror saved", () => {
  const o = saveOutcome({ local: true, idb: false });
  assert.equal(o.ok, false); assert.match(o.error, /IndexedDB/); assert.doesNotMatch(o.error, /localStorage/);
});
test("both failing names both", () => {
  assert.match(saveOutcome({ local: false, idb: false }).error, /IndexedDB and localStorage/);
});
test("size is counted in bytes, not characters, and shown plainly", () => {
  assert.equal(ledgerBytes("é"), 2);
  assert.equal(formatBytes(500), "1 KB");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(5.4 * 1024 * 1024), "5.4 MB");
});
