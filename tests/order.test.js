import { test } from "node:test";
import assert from "node:assert/strict";
import { arranged, orderFrom } from "../src/model/index.js";

const L = [{ id: "a", name: "Rent" }, { id: "b", name: "food" }, { id: "c", name: "Fun" }, { id: "d", name: "Health" }];

test("nothing arranged: A to Z, ignoring capitals", () => {
  assert.deepEqual(arranged(L).map((x) => x.id), ["b", "c", "d", "a"]);
  assert.deepEqual(arranged(L, []).map((x) => x.id), ["b", "c", "d", "a"]);
  assert.deepEqual(arranged(L, undefined).map((x) => x.id), ["b", "c", "d", "a"]);
});

test("arranged ones come first in the owner's order; the rest follow A to Z; unknown ids are ignored", () => {
  assert.deepEqual(arranged(L, ["a", "gone", "d"]).map((x) => x.id), ["a", "d", "b", "c"]);
  assert.deepEqual(arranged(L, ["d", "c", "b", "a"]).map((x) => x.id), ["d", "c", "b", "a"]);
});

test("a new item added later lands after the arranged ones, A to Z; the list itself is never changed", () => {
  const before = JSON.stringify(L);
  const more = [...L, { id: "e", name: "Bills" }];
  assert.deepEqual(arranged(more, ["a", "b", "c", "d"]).map((x) => x.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(arranged(more, ["a"]).map((x) => x.id), ["a", "e", "b", "c", "d"]);
  assert.equal(JSON.stringify(L), before);
});

test("orderFrom keeps each id once", () => {
  assert.deepEqual(orderFrom(["a", "b", "a"]), ["a", "b"]);
});
