import { test } from "node:test";
import assert from "node:assert/strict";
import { monthsBefore, shrinkDue, shrinkProgress, targetSize } from "../src/model/index.js";

const att = (id, ts) => ({ id, transaction_id: "t", type: "photo", file: id, file_timestamp: ts + "T09:00:00.000+08:00" });

test("three months back is the same calendar day, or the last day of a shorter month", () => {
  assert.equal(monthsBefore("2026-10-03", 3), "2026-07-03");
  assert.equal(monthsBefore("2026-01-15", 3), "2025-10-15");
  assert.equal(monthsBefore("2026-05-31", 3), "2026-02-28");
  assert.equal(monthsBefore("2024-05-31", 3), "2024-02-29");
  assert.equal(monthsBefore("2026-03-01", 12), "2025-03-01");
});
test("only pictures older than 3 months are due; the cutoff day itself is due, the day after is not", () => {
  const list = [att("a", "2026-07-03"), att("b", "2026-07-04"), att("c", "2026-01-10"), att("d", "2026-10-01")];
  assert.deepEqual(shrinkDue(list, "2026-10-03", "", { limit: 10 }).map((x) => x.id), ["c", "a"], "oldest first, and nothing newer than the cutoff");
});
test("the marker skips what is done, and a batch is at most three, oldest first", () => {
  const list = ["01", "02", "03", "04", "05"].map((m) => att("p" + m, "2026-" + m + "-10"));
  assert.deepEqual(shrinkDue(list, "2026-10-03", "").map((x) => x.id), ["p01", "p02", "p03"]);
  assert.deepEqual(shrinkDue(list, "2026-10-03", list[2].file_timestamp).map((x) => x.id), ["p04", "p05"], "after the marker only");
  assert.deepEqual(shrinkDue(list, "2026-10-03", list[4].file_timestamp), [], "nothing left");
  assert.deepEqual(shrinkDue([], "2026-10-03"), []); assert.deepEqual(shrinkDue(undefined, "2026-10-03"), []);
  assert.deepEqual(shrinkDue([{ id: "x" }], "2026-10-03"), [], "a record with no time is never touched");
});
test("progress counts what is done and what waits", () => {
  const list = ["01", "02", "03"].map((m) => att("p" + m, "2026-" + m + "-10")).concat(att("new", "2026-10-01"));
  assert.deepEqual(shrinkProgress(list, "2026-10-03", ""), { old: 3, done: 0, waiting: 3 });
  assert.deepEqual(shrinkProgress(list, "2026-10-03", list[1].file_timestamp), { old: 3, done: 2, waiting: 1 });
});
test("a big picture is brought down to 1600 on its longest side keeping its shape; a small one is left at its size", () => {
  assert.deepEqual(targetSize(4000, 3000), { width: 1600, height: 1200, resized: true });
  assert.deepEqual(targetSize(3000, 4000), { width: 1200, height: 1600, resized: true });
  assert.deepEqual(targetSize(1200, 800), { width: 1200, height: 800, resized: false });
  assert.equal(targetSize(0, 0), null);
});
