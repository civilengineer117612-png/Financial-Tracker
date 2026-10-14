import { test } from "node:test";
import assert from "node:assert/strict";
import { sameAmountElsewhere } from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

// Invented entries. Amounts are whole centavos.
const TS = "2026-10-03T09:00:00.000+08:00";
function base() {
  const s = makeState();
  s.accounts = [account({ id: "cash", name: "Test Cash", class: "asset", opening_balance: 500000 }), account({ id: "bank", name: "Test Bank", class: "asset", opening_balance: 500000 })];
  s.categories = [{ id: "food", name: "Food", kind: "expense" }, { id: "fun", name: "Fun", kind: "expense" }];
  return s;
}
function add(s, id, { date = "2026-10-03", amount = 15000, status = "draft", acct = "cash", cat = "food", extra = {} } = {}) {
  s.transactions.push({ id, date, payee: "", memo: "", status, source: "manual", created_at: TS, ...(status === "verified" ? { verified_at: TS } : {}), ...extra });
  s.entries.push({ transaction_id: id, category_id: cat, amount }, { transaction_id: id, account_id: acct, amount: -amount });
}

test("two entries of the same amount on the same day are noted, each with its status", () => {
  const s = base(); add(s, "a"); add(s, "b", { acct: "bank", status: "verified" });
  assert.deepEqual(sameAmountElsewhere(s, "a"), [{ id: "b", status: "verified", days: 0 }]);
  assert.deepEqual(sameAmountElsewhere(s, "b"), [{ id: "a", status: "draft", days: 0 }]);
});

test("another day, another amount, or the entry itself is never noted", () => {
  const s = base(); add(s, "a"); add(s, "day", { date: "2026-10-04" }); add(s, "amt", { amount: 15001 });
  assert.deepEqual(sameAmountElsewhere(s, "a"), []);
  assert.deepEqual(sameAmountElsewhere(s, "missing"), []);
});

test("the app's own partners are left out: a card reserve transfer, a transfer's fee", () => {
  const s = base(); add(s, "a"); add(s, "rsv:a", { acct: "bank", cat: "fun" }); add(s, "fee:a", { acct: "bank", cat: "fun" }); add(s, "sch-rsv:x", { acct: "bank", cat: "fun" });
  assert.deepEqual(sameAmountElsewhere(s, "a"), []);
});

test("a cancelled entry and the entry that cancels it are left out, so a correction does not look like a double", () => {
  const s = base(); add(s, "old", { status: "verified" }); add(s, "cancel", { status: "verified", extra: { reverses: "old" } }); add(s, "fresh", { extra: { corrects: "old" } });
  assert.deepEqual(sameAmountElsewhere(s, "fresh"), [], "the old entry is cancelled and the cancelling entry is not a payment");
});

test("an entry's size is its positive legs, so a split purchase is compared as a whole", () => {
  const s = base(); add(s, "a", { amount: 15000 });
  s.transactions.push({ id: "sp", date: "2026-10-03", payee: "", memo: "", status: "draft", source: "manual", created_at: TS });
  s.entries.push({ transaction_id: "sp", category_id: "food", amount: 10000 }, { transaction_id: "sp", category_id: "fun", amount: 5000 }, { transaction_id: "sp", account_id: "cash", amount: -15000 });
  assert.deepEqual(sameAmountElsewhere(s, "a"), [{ id: "sp", status: "draft", days: 0 }]);
});

test("one day apart is noted only when the two came from different sources: a receipt photo against the bank's own record", () => {
  const s = base(); add(s, "photo", { extra: { source: "photo" } }); add(s, "bank", { date: "2026-10-04", extra: { source: "import" } });
  assert.deepEqual(sameAmountElsewhere(s, "photo").map((x) => [x.id, x.days]), [["bank", 1]]);
  assert.deepEqual(sameAmountElsewhere(s, "bank").map((x) => [x.id, x.days]), [["photo", 1]]);
});

test("two typed entries a day apart are two real purchases: not noted", () => {
  const s = base(); add(s, "mon"); add(s, "tue", { date: "2026-10-04" });
  assert.deepEqual(sameAmountElsewhere(s, "mon"), []);
  assert.deepEqual(sameAmountElsewhere(s, "tue"), []);
});

test("two days apart is never noted, and a scheduled payment is left to the link the app already offers", () => {
  const s = base(); add(s, "a", { extra: { source: "photo" } }); add(s, "far", { date: "2026-10-05", extra: { source: "import" } });
  assert.deepEqual(sameAmountElsewhere(s, "a"), []);
  add(s, "due", { extra: { schedule_id: "sc1", source: "template" } });
  assert.deepEqual(sameAmountElsewhere(s, "a"), [], "a due scheduled payment is not offered as a double");
  assert.deepEqual(sameAmountElsewhere(s, "due"), []);
});
