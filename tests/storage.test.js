import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSize, picturesNote, readerStatus, usageLine } from "../src/model/index.js";

test("sizes read in plain megabytes and gigabytes", () => {
  assert.equal(formatSize(0), "less than 1 MB"); assert.equal(formatSize(1048575), "less than 1 MB");
  assert.equal(formatSize(1048576), "1 MB"); assert.equal(formatSize(48.4 * 1048576), "48 MB");
  assert.equal(formatSize(1073741824), "1.0 GB"); assert.equal(formatSize(1.26 * 1073741824), "1.3 GB");
  assert.equal(formatSize(NaN), ""); assert.equal(formatSize(-1), ""); assert.equal(formatSize(undefined), "");
});
test("the pictures note says how many are not in the backup, and says nothing when there are none", () => {
  assert.equal(picturesNote(0), ""); assert.equal(picturesNote(undefined), ""); assert.equal(picturesNote(-2), "");
  assert.equal(picturesNote(1), "1 picture is kept on this phone only. It is not in the backup.");
  assert.equal(picturesNote(12), "12 pictures are kept on this phone only. They are not in the backup.");
});
test("the reader is ready only when every one of its files is on the phone", () => {
  assert.equal(readerStatus(6, 6).ready, true); assert.match(readerStatus(6, 6).text, /is on this phone/);
  for (const n of [0, 5]) { const s = readerStatus(n, 6); assert.equal(s.ready, false); assert.match(s.text, /not on this phone yet/); }
  assert.equal(readerStatus(3, 0).ready, false, "no list of files, nothing to claim");
});
test("the usage line is empty when the phone does not say, and never claims 'about' for under a megabyte", () => {
  assert.equal(usageLine(undefined), "");
  assert.equal(usageLine(50 * 1048576), "This app uses about 50 MB of the phone's space (the reader, pictures and ledger).");
  assert.match(usageLine(100), /^This app uses less than 1 MB/);
});
