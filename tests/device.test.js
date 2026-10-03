import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPlatform, assessDevice, trialAllowed } from "../src/model/index.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const both = (v) => ({ local: v, idb: v });
const ok = { platform: "ios", standalone: true, stores: both(true) };

test("platform is read from the user agent", () => {
  assert.equal(detectPlatform(IPHONE), "ios");
  assert.equal(detectPlatform(ANDROID), "android");
  assert.equal(detectPlatform(IPAD), "other");
  assert.equal(detectPlatform(DESKTOP), "other");
});

test("Android: empty is normal, no data entry, whatever the stores hold", () => {
  for (const stores of [both(false), both(true), { local: true, idb: false }]) {
    const r = assessDevice({ platform: "android", standalone: true, stores });
    assert.equal(r.status, "ANDROID_NO_LEDGER");
    assert.equal(r.allowEntry, false);
    assert.match(r.message, /not lost data/);
  }
});
test("other devices are told they are not the finance phone", () => {
  assert.equal(assessDevice({ ...ok, platform: "other" }).status, "NOT_THE_FINANCE_PHONE");
});
test("iPhone in a Safari tab: wrong storage, open the Home Screen icon", () => {
  const r = assessDevice({ ...ok, standalone: false });
  assert.equal(r.status, "BROWSER_TAB");
  assert.equal(r.allowEntry, false);
});
test("iPhone Home Screen app with data in both stores is fine and silent", () => {
  assert.deepEqual(assessDevice(ok), { status: "OK", message: "", allowEntry: true });
});
test("iPhone Home Screen app with both stores empty: expected on first run, restore if not", () => {
  const r = assessDevice({ ...ok, stores: both(false) });
  assert.equal(r.status, "EMPTY");
  assert.equal(r.allowEntry, true);
  assert.match(r.message, /restore/);
});
test("one store empty and one not is flagged as partial loss, naming the empty one", () => {
  const a = assessDevice({ ...ok, stores: { local: true, idb: false } });
  assert.equal(a.status, "PARTIAL_LOSS");
  assert.match(a.message, /IndexedDB is empty/);
  assert.equal(a.allowEntry, false);
  assert.match(assessDevice({ ...ok, stores: { local: false, idb: true } }).message, /localStorage is empty/);
});
test("a store that cannot be read stops saving", () => {
  for (const stores of [{ local: null, idb: true }, { local: true, idb: null }, { local: null, idb: null }]) {
    const r = assessDevice({ ...ok, stores });
    assert.equal(r.status, "STORAGE_UNAVAILABLE");
    assert.equal(r.allowEntry, false);
  }
});
test("platform is checked before storage: an Android never reports data loss", () => {
  assert.notEqual(assessDevice({ platform: "android", standalone: true, stores: { local: true, idb: false } }).status, "PARTIAL_LOSS");
});

test("a trial copy turns entry on for an Android phone, a desktop or an iPhone browser tab, and says plainly that it is not the real ledger", () => {
  for (const platform of ["android", "other", "ios"]) {
    const r = assessDevice({ platform, standalone: false, stores: both(false), trial: true });
    assert.equal(r.status, "TRIAL", platform);
    assert.equal(r.allowEntry, true, platform);
    assert.match(r.message, /not your real ledger/);
    assert.match(r.message, /Do not enter real financial data/);
  }
});
test("a trial can never be switched on in the iPhone Home Screen app, which holds the real ledger", () => {
  assert.equal(trialAllowed({ platform: "ios", standalone: true }), false);
  const r = assessDevice({ platform: "ios", standalone: true, stores: both(true), trial: true });
  assert.equal(r.status, "OK", "the ?trial is ignored and the real ledger is shown as usual");
  assert.equal(assessDevice({ platform: "ios", standalone: true, stores: both(false), trial: true }).status, "EMPTY");
});
test("without ?trial nothing changes: Android stays switched off; a trial still refuses unreadable storage", () => {
  assert.equal(assessDevice({ platform: "android", standalone: false, stores: both(false) }).status, "ANDROID_NO_LEDGER");
  const r = assessDevice({ platform: "android", standalone: false, stores: { local: null, idb: false }, trial: true });
  assert.equal(r.status, "STORAGE_UNAVAILABLE");
  assert.equal(r.allowEntry, false);
});
