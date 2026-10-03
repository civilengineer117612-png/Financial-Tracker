import { test } from "node:test";
import assert from "node:assert/strict";
import { BANKS, bankById, bankForName, planAccount, linkAccountBank, setBankIconUrl, setAccountIcon, validateShape } from "../src/model/index.js";
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

test("an account made earlier can be linked to a bank, takes that bank's picture, and can be unlinked", () => {
  let s = planAccount(makeState(), input({ bank: "gotyme" })).state;
  s = setAccountIcon(s, "a1", PNG).state;
  s = planAccount(s, input({ id: "old", name: "Euf" })).state;
  const r = linkAccountBank(s, "old", "gotyme");
  assert.equal(r.ok, true);
  const old = r.state.accounts.find((a) => a.id === "old");
  assert.deepEqual([old.bank, old.icon, old.name], ["gotyme", PNG, "Euf"], "keeps its own name, gains the bank and its picture");
  const off = linkAccountBank(r.state, "old", null).state.accounts.find((a) => a.id === "old");
  assert.equal("bank" in off, false);
  assert.equal(linkAccountBank(s, "old", "nope").violations[0].code, "UNKNOWN_BANK");
  assert.equal(linkAccountBank(s, "zz", "gotyme").violations[0].code, "UNKNOWN_ACCOUNT");
});

test("a typed name that obviously means a listed bank is recognised, others are not", () => {
  assert.equal(bankForName("Gotyme").id, "gotyme");
  assert.equal(bankForName(" GCASH ").id, "gcash");
  assert.equal(bankForName("BDO Savings").id, "bdo");
  for (const n of ["Euf", "Wallet", "Cash on hand", "BDOX", ""]) assert.equal(bankForName(n), null, n);
});

test("a bank picture that cannot be copied can be shown from an allow-listed icon service instead", () => {
  let s = planAccount(makeState(), input({ bank: "gotyme" })).state;
  s = planAccount(s, input({ id: "a2", bank: "gotyme", sub: "Savings" })).state;
  s = planAccount(s, input({ id: "a3", bank: "bdo" })).state;
  const URL_OK = "https://www.google.com/s2/favicons?sz=128&domain=gotyme.com.ph";
  const r = setBankIconUrl(s, "gotyme", URL_OK);
  assert.equal(r.ok && r.changed, true);
  assert.deepEqual(r.state.accounts.filter((a) => a.bank).map((a) => a.icon_url ?? null), [URL_OK, URL_OK, null]);
  const third = planAccount(r.state, input({ id: "a4", bank: "gotyme", sub: "Pocket" }));
  assert.equal(third.account.icon_url, URL_OK, "new accounts of the bank start with it");
  for (const bad of ["http://www.google.com/s2/favicons?domain=x", "https://evil.example/x.png", "javascript:alert(1)", "https://www.google.com.evil.example/x"]) {
    assert.equal(setBankIconUrl(s, "gotyme", bad).ok, false, bad);
  }
  assert.equal(setBankIconUrl(s, "nope", URL_OK).violations[0].code, "UNKNOWN_BANK");
  const withPic = setAccountIcon(r.state, "a1", PNG).state;
  assert.ok(withPic.accounts.filter((a) => a.bank === "gotyme").every((a) => a.icon === PNG && a.icon_url === undefined), "a real picture replaces the address");
  const keep = setBankIconUrl(withPic, "gotyme", URL_OK.replace("128", "64"));
  assert.equal(keep.changed, false, "accounts that have their own picture are left alone");
  assert.ok(setBankIconUrl(r.state, "gotyme", null).state.accounts.every((a) => a.icon_url === undefined));
});

test("relinking an account to a different bank drops the wrong bank's picture, and keeps a picture of its own", () => {
  const URL_G = "https://www.google.com/s2/favicons?sz=128&domain=gcash.com", URL_L = "https://www.google.com/s2/favicons?sz=128&domain=landbank.com";
  let s = planAccount(makeState(), input({ id: "g1", bank: "gcash" })).state;
  s = setBankIconUrl(s, "gcash", URL_G).state;
  s = planAccount(s, input({ id: "l1", name: "Landbank" })).state;
  s = linkAccountBank(s, "l1", "gcash").state;                       // a mistaken link: Landbank gets GCash's logo
  assert.equal(s.accounts.find((a) => a.id === "l1").icon_url, URL_G);
  s = linkAccountBank(s, "l1", "landbank").state;                    // put right
  const l1 = s.accounts.find((a) => a.id === "l1");
  assert.deepEqual([l1.bank, l1.icon_url], ["landbank", undefined], "GCash's address is gone");
  assert.equal(setBankIconUrl(s, "landbank", URL_L).state.accounts.find((a) => a.id === "l1").icon_url, URL_L);
  assert.equal(s.accounts.find((a) => a.id === "g1").icon_url, URL_G, "GCash keeps its own");
  // a copied picture shared with the old bank is dropped; the account's own different picture stays
  let t = planAccount(makeState(), input({ id: "g1", bank: "gcash" })).state;
  t = planAccount(t, input({ id: "g2", bank: "gcash", sub: "Savings" })).state;
  t = setAccountIcon(t, "g1", PNG).state;
  assert.equal(linkAccountBank(t, "g2", "bdo").state.accounts.find((a) => a.id === "g2").icon, undefined, "shared copy dropped");
  const own = "data:image/png;base64,AAAA";
  const t2 = { ...t, accounts: t.accounts.map((a) => (a.id === "g2" ? { ...a, icon: own } : a)) };
  assert.equal(linkAccountBank(t2, "g2", "bdo").state.accounts.find((a) => a.id === "g2").icon, own, "its own picture is kept");
  assert.equal("icon_url" in linkAccountBank(s, "l1", null).state.accounts.find((a) => a.id === "l1"), false, "unlinking drops it too");
});
