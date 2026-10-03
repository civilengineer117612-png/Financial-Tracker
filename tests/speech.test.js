import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpoken, defaultCategories } from "../src/model/index.js";

const ctx = { today: "2026-10-20", categories: defaultCategories() };   // 20 Oct 2026 is a Tuesday; every sentence below is invented
const say = (t) => parseSpoken(t, ctx);

test("amount, name, account, date and category from one sentence", () => {
  const r = say("lunch 95 pesos at Sample Burger using GCash yesterday");
  assert.equal(r.amount, 9500);
  assert.equal(r.payee, "Sample Burger");
  assert.equal(r.bankId, "gcash");
  assert.equal(r.date, "2026-10-19");
  assert.equal(r.categoryName, "Food");
  assert.equal(r.direction, "out");
  assert.deepEqual(r.notes, []);
});
test("amounts as figures, with commas, decimals and k, and as words", () => {
  assert.equal(say("coffee 1,250.50").amount, 125050);
  assert.equal(say("rent 1.5k").amount, 150000);
  assert.equal(say("rent 8k").amount, 800000);
  assert.equal(say("groceries nine hundred fifty pesos from MariBank").amount, 95000);
  assert.equal(say("twenty one pesos").amount, 2100);
  assert.equal(say("PHP 45.75 for snacks").amount, 4575);
});
test("more than one amount, or none, is not guessed", () => {
  const two = say("lunch 95 and coffee 120");
  assert.equal(two.amount, null);
  assert.ok(two.notes.some((n) => /more than one amount/.test(n)));
  const none = say("bought something at the market");
  assert.equal(none.amount, null);
  assert.ok(none.notes.some((n) => /did not hear an amount/.test(n)));
});
test("everyday Filipino words are understood", () => {
  const r = say("kahapon bumili ako ng 250 sa botika gamit ang gcash");
  assert.equal(r.amount, 25000);
  assert.equal(r.date, "2026-10-19");
  assert.equal(r.bankId, "gcash");
  assert.equal(r.categoryName, "Essentials");
  assert.equal(say("pera 120 sa palengke").cash, true);
});
test("days: today by default, yesterday, days ago, and the last time a weekday came round", () => {
  assert.equal(say("lunch 95").date, "2026-10-20");
  assert.equal(say("lunch 95 two days ago".replace("two", "2")).date, "2026-10-18");
  assert.equal(say("lunch 95 last friday").date, "2026-10-16");
  assert.equal(say("lunch 95 on tuesday").date, "2026-10-13", "the same weekday means last week, never today");
});
test("a category named in the sentence wins; a bank is only taken when exactly one is named", () => {
  assert.equal(say("95 pesos for essentials").categoryName, "Essentials");
  assert.equal(say("95 pesos subscription").categoryName, "Subscription");
  assert.equal(say("transfer 95 from gcash to bdo").bankId, null);
  assert.equal(say("lunch 95").bankId, null);
});
test("money coming in is flagged for the owner, not saved as a purchase", () => {
  const r = say("received 500 from a friend");
  assert.equal(r.direction, "in");
  assert.ok(r.notes.some((n) => /coming in/.test(n)));
});
test("empty speech gives an empty guess, never a crash", () => {
  for (const t of ["", "   ", null, undefined]) { const r = say(t); assert.equal(r.amount, null); assert.equal(r.payee, null); }
});
