import { test } from "node:test";
import assert from "node:assert/strict";
import { ratchetSchedule, splitRatchet, wasMet, validateRatchetParams } from "../src/model/index.js";

// Invented policy: start 100.00, step 10.00, floor 80.00 (in centavos).
const P = { start: 10000, step: 1000, floor: 8000 };
const M = true, X = false;

test("a met month raises next month by one step", () => {
  assert.deepEqual(ratchetSchedule(P, [M, M]), [10000, 11000, 12000]);
});
test("one miss holds", () => {
  assert.deepEqual(ratchetSchedule(P, [X]), [10000, 10000]);
});
test("two misses in a row lower by one step", () => {
  assert.deepEqual(ratchetSchedule(P, [X, X]), [10000, 10000, 9000]);
});
test("a met month between misses resets the count", () => {
  assert.deepEqual(ratchetSchedule(P, [X, M, X]), [10000, 10000, 11000, 11000]);
});
test("a long miss streak lowers every second month", () => {
  assert.deepEqual(ratchetSchedule(P, [X, X, X, X]), [10000, 10000, 9000, 9000, 8000]);
});
test("never goes below the floor", () => {
  assert.deepEqual(ratchetSchedule(P, [X, X, X, X, X, X]).at(-1), 8000);
});
test("no history means the start amount", () => {
  assert.deepEqual(ratchetSchedule(P, []), [10000]);
});
test("met means at least the amount actually moved", () => {
  assert.equal(wasMet(10000, 10000), true);
  assert.equal(wasMet(10000, 9999), false);
});
test("bad parameters are refused", () => {
  assert.ok(validateRatchetParams({ ...P, start: 7000 }).length);
  assert.ok(validateRatchetParams({ ...P, step: 10.5 }).length);
  assert.throws(() => ratchetSchedule({ ...P, floor: -1 }, []));
});

test("split by 2/3 rounds Emergency and gives Sinking the exact remainder", () => {
  const s = splitRatchet(10000, { num: 2, den: 3 });   // 66.666... -> 66.67
  assert.deepEqual(s, { emergency: 6667, sinking: 3333, longTerm: 0 });
  assert.equal(s.emergency + s.sinking, 10000);
});
test("parts always add back to the amount", () => {
  for (const amt of [1, 2, 9999, 10001, 123457]) {
    const s = splitRatchet(amt, { num: 2, den: 3 });
    assert.equal(s.emergency + s.sinking + s.longTerm, amt);
  }
});
test("once the Emergency target is reached, its share goes to long-term", () => {
  assert.deepEqual(splitRatchet(9000, { num: 2, den: 3 }, true), { emergency: 0, sinking: 3000, longTerm: 6000 });
});
