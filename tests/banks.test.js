import { test } from "node:test";
import assert from "node:assert/strict";
import { BANKS, bankById, planAccount, setAccountIcon, validateShape } from "../src/model/index.js";
import { makeState } from "./fixtures.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const input = (o) => ({ id: "a1", kind: "asset", opening: 0, date: "2026-10-05", ...o });

test("the picker offers ten banks, unique, with plain names and no logos", () => {
  assert.equal(BANKS.length, 10);
  assert.equal(new Set(BANKS.map((b) => b.id)).size, 10);
  assert.ok(["GCash", "GoTyme", "MariBank"].every((n) => BANKS.some((b) => b.name === n)), "includes the owner's own");
  assert.ok(BANKS.every((b) => !("icon" in b) && !("logo" in b)));
  assert.ok(BANKS.every((b) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(b.domain)), "each bank has only a website name, no image");
  assert.equal(bankById("cash").name, "Cash");
  assert.equal(bankById("nope"), null);
});
test("choosing a bank names the account for you, and a part of the bank is added after a dot", () => {
  const s = makeState();
  const a = planAccount(s, input({ bank: "gotyme", opening: 500000 }));
  assert.deepEqual([a.ok, a.account.name, a.account.bank, a.account.opening_balance], [true, "GoTyme", "gotyme", 500000]);
  const b = planAccount(a.state, input({ id: "a2", bank: "gotyme", sub: "  Emergency Fund " }));
  assert.equal(b.account.name, "GoTyme · Emergency Fund");
  assert.equal(b.state.accounts.filter((x) => x.bank === "gotyme").length, 2);
  const typed = planAccount(s, input({ id: "a3", name: " Pocket money " }));
  assert.deepEqual([typed.account.name, "bank" in typed.account], ["Pocket money", false]);
});
test("bad accounts are refused in plain words", () => {
  const s = planAccount(makeState(), input({ bank: "gcash" })).state;
  for (const [o, code] of [[{ bank: "nope" }, "UNKNOWN_BANK"], [{ bank: undefined, name: "  " }, "BAD_NAME"], [{ bank: "gcash" }, "DUPLICATE_NAME"], [{ bank: undefined, name: "gcash" }, "DUPLICATE_NAME"], [{ bank: "bdo", sub: "x".repeat(41) }, "BAD_NAME"]]) {
    const r = planAccount(s, input({ id: "z", ...o }));
    assert.equal(r.ok, false, code);
    assert.equal(r.violations[0].code, code);
  }
  assert.equal(planAccount(s, input({ id: "z", bank: "bdo", opening: -1.5 })).ok, false);
});
test("a picture chosen for one account is shared by every account of the same bank, and new ones inherit it", () => {
  let s = planAccount(makeState(), input({ bank: "gotyme" })).state;
  s = planAccount(s, input({ id: "a2", bank: "gotyme", sub: "Emergency Fund" })).state;
  s = planAccount(s, input({ id: "a3", bank: "bdo" })).state;
  const r = setAccountIcon(s, "a1", PNG);
  assert.equal(r.ok, true);
  const gotyme = r.state.accounts.filter((a) => a.bank === "gotyme"), other = r.state.accounts.find((a) => a.bank === "bdo");
  assert.ok(gotyme.every((a) => a.icon === PNG) && gotyme.length === 2, "both GoTyme accounts share it");
  assert.equal(other.icon, undefined, "another bank is untouched");
  const third = planAccount(r.state, input({ id: "a4", bank: "gotyme", sub: "Savings" }));
  assert.equal(third.account.icon, PNG, "a new GoTyme account starts with the picture");
  const cleared = setAccountIcon(r.state, "a2", null);
  assert.ok(cleared.state.accounts.filter((a) => a.bank === "gotyme").every((a) => a.icon === undefined), "removing it clears the whole bank");
  assert.equal(setAccountIcon(s, "a1", "javascript:alert(1)").ok, false);
  assert.equal(validateShape("Account", planAccount(makeState(), input({ bank: "bpi" })).account).length, 0);
});
