import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  readMove, classifyMove, accountByLast4, setAccountLast4, normalizeLast4, last4In, recipientKey, rememberRecipient, planTransfer, editTransfer,
  feeOf, foreignOf, findDuplicate, checkTransactionSave, verifyDraft, discardDraft, validateShape, BANK_FEES_ROLE, CHOOSE_MESSAGE, selfCheck,
} from "../src/model/index.js";
import { account } from "./fixtures.js";

// Invented names, digits and amounts only.
const base = () => ({
  accounts: [
    account({ id: "bank", name: "Test Bank", class: "asset", opening_balance: 5000000, last4: "4821" }),
    account({ id: "wallet", name: "Test Wallet", class: "asset", opening_balance: 100000, last4: "7305" }),
    account({ id: "cash", name: "Cash on hand", class: "asset", opening_balance: 200000, last4: "" }),
    account({ id: "card", name: "Test Card", class: "liability", last4: "" }),
  ],
  categories: [{ id: "food", name: "Food", kind: "expense" }, { id: "pay", name: "Pay", kind: "income" }],
  envelopes: [], transactions: [], entries: [], attachments: [], tags: [], foreignAmounts: [],
});
const accounts = base().accounts;
const NOW = new Date("2026-10-03T03:00:00Z");

const OWN = ["Transfer successful", "From", "Test Bank ****4821", "To", "Test Wallet XXXX 7305", "Amount Sent P1,000.00", "Ref No. 8842 1170 55", "Oct 03, 2026 02:15 PM"].join("\n");

test("a last 4 is exactly four digits: five are refused, letters are refused, and the same four cannot sit on two accounts", () => {
  const s = base();
  assert.equal(normalizeLast4("4821"), "4821"); assert.equal(normalizeLast4("48211"), ""); assert.equal(normalizeLast4("48a1"), ""); assert.equal(normalizeLast4(" 4821 "), "4821");
  assert.equal(setAccountLast4(s, "card", "12345").ok, false, "never longer than four");
  assert.equal(setAccountLast4(s, "card", "12a4").ok, false);
  assert.equal(setAccountLast4(s, "card", "4821").ok, false, "already on the bank account");
  const ok = setAccountLast4(s, "card", "9090"); assert.equal(ok.ok, true); assert.equal(ok.state.accounts.find((a) => a.id === "card").last4, "9090");
  assert.equal(setAccountLast4(ok.state, "card", "").state.accounts.find((a) => a.id === "card").last4, "", "empty removes it");
  assert.equal(validateShape("Account", { ...accounts[0], last4: "12345" }).length > 0, true, "the saved shape refuses a long one too");
  assert.deepEqual(validateShape("Account", { ...accounts[0], last4: "1234" }), []);
  assert.equal(accountByLast4(accounts, "4821").id, "bank"); assert.equal(accountByLast4(accounts, "0000"), null);
  assert.equal(accountByLast4([...accounts, account({ id: "dup", name: "Dup", class: "asset", last4: "4821" })], "4821"), null, "two accounts with the same digits: no guess");
});

test("the screenshot is read: masked digits, both ends, the amount, the reference and the time", () => {
  const r = readMove(OWN);
  assert.equal(r.kind, "transfer"); assert.equal(r.amount, 100000); assert.equal(r.from.last4, "4821"); assert.equal(r.to.last4, "7305");
  assert.equal(r.reference, "8842117055", "a reference written in groups is one reference"); assert.equal(r.time, "14:15");
  for (const [text, want] of [["****1234", "1234"], ["XXXX-XXXX-5678", "5678"], ["•••• 4321", "4321"], ["ending in 9911", "9911"], ["Account No. 0012 3456 7890", "7890"], ["09171234567", ""], ["Maria Sample", ""]]) assert.equal(last4In(text), want, text);
});

test("an own-account transfer: both ends match saved accounts by last 4", () => {
  const c = classifyMove(readMove(OWN), { accounts });
  assert.deepEqual([c.result, c.from_id, c.to_id], ["transfer", "bank", "wallet"]);
});

test("a transfer to a relative with the SAME SURNAME is never an own account", () => {
  // the owner's accounts are filed under the surname Sample; the relative shares it. Names are never matched.
  const mine = accounts.map((a) => (a.id === "wallet" ? { ...a, name: "Ana Sample" } : a));
  const text = ["Transfer successful", "From", "Test Bank ****4821", "To", "Rosa Sample", "Amount Sent P500.00"].join("\n");
  const c = classifyMove(readMove(text), { accounts: mine });
  assert.notEqual(c.result, "transfer", "no digits matched, so it is not an own account");
  assert.equal(c.result, "ask", "the other end is unknown: asked once");
  assert.equal(c.to_id, null);
  // even when the relative's NAME equals the name of one of the owner's accounts
  const named = classifyMove(readMove(["Transfer successful", "To", "Ana Sample", "From", "Test Bank ****4821", "Amount P500.00"].join("\n")), { accounts: mine, recipients: {} });
  assert.notEqual(named.result, "transfer");
});

test("an unknown destination asks once per recipient and remembers the answer", () => {
  const text = ["Send Money", "From", "Test Wallet XXXX 7305", "To", "0917 123 4567", "Amount P250.00"].join("\n");
  const read = readMove(text);
  assert.equal(recipientKey("0917 123 4567"), "09171234567"); assert.equal(recipientKey("+63 917 123 4567"), "09171234567");
  const first = classifyMove(read, { accounts, recipients: {} });
  assert.equal(first.result, "ask"); assert.equal(first.ask.key, "09171234567"); assert.equal(first.from_id, "wallet");
  const yes = classifyMove(read, { accounts, recipients: rememberRecipient({}, first.ask.key, "bank") });
  assert.deepEqual([yes.result, yes.from_id, yes.to_id, yes.ask], ["transfer", "wallet", "bank", null], "answered yes: it is that account, and it is not asked again");
  const no = classifyMove(read, { accounts, recipients: rememberRecipient({}, first.ask.key, "") });
  assert.deepEqual([no.result, no.ask], ["expense", null], "answered no: an ordinary payment, not asked again");
  const other = classifyMove(readMove(text.replace("0917 123 4567", "0918 555 0000")), { accounts, recipients: rememberRecipient({}, "09171234567", "bank") });
  assert.equal(other.result, "ask", "another recipient is asked on its own");
});

test("when it cannot tell, it says Transfer or expense? Choose and never defaults", () => {
  const c = classifyMove(readMove(["Transfer successful", "Amount P300.00"].join("\n")), { accounts });
  assert.equal(c.result, "unsure"); assert.equal(c.why, CHOOSE_MESSAGE); assert.equal(CHOOSE_MESSAGE, "Transfer or expense? Choose");
  assert.equal(c.from_id, null); assert.equal(c.to_id, null);
  assert.equal(classifyMove(readMove("Lunch at a cafe P120.00"), { accounts }).result, "unsure", "no transfer wording at all");
  assert.equal(readMove("Lunch at a cafe P120.00").kind, null);
});

test("a cash withdrawal with an ATM fee: Transfer from the bank to Cash on hand, and the fee is a Bank fees expense", () => {
  const text = ["ATM Withdrawal", "From", "Test Bank ****4821", "Withdrawal Amount P2,000.00", "Service Fee P18.00", "Total P2,018.00", "Ref No. ATM778899", "Oct 03, 2026 09:40"].join("\n");
  const r = readMove(text);
  assert.deepEqual([r.kind, r.amount, r.fee], ["withdrawal", 200000, 1800], "the moved amount is not the total");
  const onlyTotal = readMove(["Cash Out", "Service Fee P18.00", "Total P2,018.00"].join("\n"));
  assert.deepEqual([onlyTotal.amount, onlyTotal.fee], [200000, 1800], "with only a total and a fee, the amount is the total less the fee");
  const c = classifyMove(r, { accounts, cashId: "cash" });
  assert.deepEqual([c.result, c.from_id, c.to_id], ["transfer", "bank", "cash"]);
  const p = planTransfer(base(), { transaction_id: "w1", date: "2026-10-03", from_account_id: "bank", to_account_id: "cash", amount: r.amount, fee: r.fee, payee: "Cash withdrawal", reference_no: r.reference, shot_time: r.time }, NOW);
  assert.equal(p.ok, true, JSON.stringify(p.violations));
  const t = p.state.transactions.find((x) => x.id === "w1"), f = p.state.transactions.find((x) => x.id === "fee:w1");
  assert.deepEqual([t.status, t.source, f.status, f.source], ["draft", "photo", "draft", "photo"]);
  assert.deepEqual(p.state.entries.filter((e) => e.transaction_id === "w1").map((e) => [e.account_id, e.amount]).sort(), [["bank", -200000], ["cash", 200000]]);
  const cat = p.state.categories.find((c2) => c2.role === BANK_FEES_ROLE);
  assert.equal(cat.name, "Bank fees"); assert.equal(cat.kind, "expense");
  assert.deepEqual(p.state.entries.filter((e) => e.transaction_id === "fee:w1").map((e) => [e.account_id ?? e.category_id, e.amount]).sort(), [["bank", -1800], ["cat-bank-fees", 1800]]);
  assert.equal(feeOf(p.state, "w1").amount, 1800);
  for (const tr of p.state.transactions) assert.deepEqual(validateShape("Transaction", tr), [], tr.id);
  // one more withdrawal reuses the same category
  const again = planTransfer(p.state, { transaction_id: "w2", date: "2026-10-04", from_account_id: "bank", to_account_id: "cash", amount: 100000, fee: 1800 }, NOW);
  assert.equal(again.state.categories.filter((c2) => c2.role === BANK_FEES_ROLE).length, 1);
  // verifying the withdrawal verifies its fee; deleting it deletes its fee
  const v = verifyDraft(p.state, "w1", NOW);
  assert.deepEqual(v.state.transactions.filter((x) => x.id === "w1" || x.id === "fee:w1").map((x) => x.status), ["verified", "verified"]);
  const d = discardDraft(p.state, "w1");
  assert.equal(d.state.transactions.some((x) => x.id === "w1" || x.id === "fee:w1"), false); assert.equal(d.state.entries.some((e) => e.transaction_id === "fee:w1"), false);
  assert.deepEqual(selfCheck({ v: 7, state: { ...v.state }, settings: {} }), []);
});

test("a cash deposit is the reverse: Cash on hand to the bank", () => {
  const r = readMove(["Cash In", "To", "Test Wallet XXXX 7305", "Amount P1,500.00"].join("\n"));
  assert.equal(r.kind, "deposit");
  const c = classifyMove(r, { accounts, cashId: "cash" });
  assert.deepEqual([c.result, c.from_id, c.to_id], ["transfer", "cash", "wallet"]);
  assert.equal(classifyMove(r, { accounts, cashId: null }).result, "unsure", "no Cash on hand account: it says so, it does not pick one");
});

test("a foreign withdrawal keeps the foreign currency and amount; the peso amount is corrected at Verify and the rate follows", () => {
  const r = readMove(["ATM Withdrawal", "From", "Test Bank ****4821", "Amount USD 100.00", "Oct 03, 2026 18:05"].join("\n"));
  assert.deepEqual(r.foreign, { currency: "USD", amount: 10000 });
  assert.equal(r.amount, null, "the foreign figure is not read as pesos");
  assert.ok(r.notes.some((n) => /peso amount/.test(n)));
  let s = base(); s.tags = [{ id: "trip1", name: "Test Trip" }];
  const p = planTransfer(s, { transaction_id: "x1", date: "2026-10-03", from_account_id: "bank", to_account_id: "cash", amount: 570000, foreign: r.foreign, trip_id: "trip1" }, NOW);
  assert.equal(p.ok, true, JSON.stringify(p.violations));
  assert.deepEqual([foreignOf(p.state, "x1").currency, foreignOf(p.state, "x1").foreign_amount, foreignOf(p.state, "x1").rate], ["USD", 10000, 57]);
  assert.equal(p.state.transactions.find((x) => x.id === "x1").trip_add, "trip1", "tagged to the trip");
  const e = editTransfer(p.state, "x1", { amount: 575000 }, NOW);
  assert.equal(e.ok, true); assert.equal(foreignOf(e.state, "x1").rate, 57.5); assert.equal(foreignOf(e.state, "x1").foreign_amount, 10000);
  assert.equal(planTransfer(s, { transaction_id: "x2", date: "2026-10-03", from_account_id: "bank", to_account_id: "cash", amount: 100, trip_id: "nope" }, NOW).ok, false, "an unknown trip is refused");
});

test("a duplicate screenshot is flagged and offered for linking, never refused", () => {
  const first = planTransfer(base(), { transaction_id: "a", date: "2026-10-03", from_account_id: "bank", to_account_id: "wallet", amount: 100000, reference_no: "8842117055", shot_time: "14:15" }, NOW);
  const cand = (id, over, amt = 100000, date = "2026-10-04") => {
    const t = { id, date, payee: "", memo: "", status: "draft", source: "photo", edited_before_verify: false, created_at: "2026-10-04T09:00:00.000+08:00", ...over };
    return { t, es: [{ transaction_id: id, account_id: "wallet", amount: amt }, { transaction_id: id, account_id: "bank", amount: -amt }] };
  };
  const a = cand("b", { reference_no: "8842117055" });
  assert.equal(findDuplicate(first.state, a.t, a.es), "a", "same reference and amount, a day later");
  assert.equal(checkTransactionSave(first.state, { transaction: a.t, entries: a.es }).ok, true, "never refused");
  const far = cand("c", { reference_no: "8842117055" }, 100000, "2026-10-08");
  assert.equal(findDuplicate(first.state, far.t, far.es), null, "5 days apart is another payment");
  const other = cand("d", { reference_no: "8842117055" }, 100001);
  assert.equal(findDuplicate(first.state, other.t, other.es), null, "another amount is another payment");
  const sameTime = cand("e", { shot_time: "14:15" }, 100000, "2026-10-03");
  assert.equal(findDuplicate(first.state, sameTime.t, sameTime.es), "a", "no reference: same accounts, amount, day and time");
  const otherWay = { t: sameTime.t, es: [{ transaction_id: "e", account_id: "bank", amount: 100000 }, { transaction_id: "e", account_id: "wallet", amount: -100000 }] };
  assert.equal(findDuplicate(first.state, otherWay.t, otherWay.es), null, "the other way round is not the same transfer");
  const none = cand("f", {}, 100000, "2026-10-03");
  assert.equal(findDuplicate(first.state, none.t, none.es), null, "nothing to compare by: never flagged on amount alone");
  // planning the same transfer again still works (a warning, not a stop)
  const second = planTransfer(first.state, { transaction_id: "g", date: "2026-10-03", from_account_id: "bank", to_account_id: "wallet", amount: 100000, reference_no: "8842117055", shot_time: "14:15" }, NOW);
  assert.equal(second.ok, true); assert.equal(second.violations[0].duplicate_of, "a");
});

test("editing a transfer draft changes both ends, the amount and the fee; the photo link and the original capture time stay", () => {
  let s = { ...base(), attachments: [{ id: "ph1", transaction_id: "e1", type: "photo", file: "ph1", file_timestamp: "2026-10-03T09:00:00.000+08:00" }] };
  const p = planTransfer(s, { transaction_id: "e1", date: "2026-10-03", from_account_id: "bank", to_account_id: "wallet", amount: 100000, fee: 1500, payee: "Transfer" }, NOW);
  const created = p.state.transactions.find((x) => x.id === "e1").created_at;
  const e = editTransfer({ ...p.state, attachments: s.attachments }, "e1", { from_account_id: "wallet", to_account_id: "cash", amount: 90000, fee: 0 }, new Date("2026-10-05T03:00:00Z"));
  assert.equal(e.ok, true, JSON.stringify(e.violations));
  assert.deepEqual(e.state.entries.filter((x) => x.transaction_id === "e1").map((x) => [x.account_id, x.amount]).sort(), [["cash", 90000], ["wallet", -90000]]);
  assert.equal(feeOf(e.state, "e1").transaction, null, "the fee was cleared, so its draft is gone");
  assert.equal(e.state.transactions.find((x) => x.id === "e1").created_at, created); assert.equal(e.state.transactions.find((x) => x.id === "e1").edited_before_verify, true);
  assert.equal(e.state.attachments.length, 1, "the photo stays with it");
  assert.equal(editTransfer(e.state, "e1", { from_account_id: "cash", to_account_id: "cash" }).ok, false, "two different accounts");
  const v = verifyDraft(e.state, "e1", NOW);
  assert.equal(editTransfer(v.state, "e1", { amount: 5 }).ok, false, "a verified one is not edited here");
});

test("the screens: the Setup row, the scan window, Verify and the restore note use these rules", () => {
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  assert.ok(app.includes('data-action="edit-last4"') && app.includes("M.setAccountLast4("), "Setup lets the owner type the last 4");
  assert.ok(app.includes("M.readMove(text)") && app.includes("M.classifyMove(") && app.includes("ledger.settings.own_recipients"), "the scan window reads moves and the remembered answers");
  assert.ok(app.includes("Is the other end one of your accounts?"), "the question is asked in words");
  assert.ok(app.includes("M.CHOOSE_MESSAGE"), "the unsure state says Transfer or expense? Choose");
  assert.ok(/own-no[\s\S]{0,200}askNo/.test(app) && /rememberRecipient\(ledger\.settings\.own_recipients, f\.askNo, ""\)/.test(app), "a no is remembered too");
  assert.ok(app.includes("M.findDuplicate(") && app.includes('data-action="link-dup"') && app.includes('data-action="dup-new"'), "a repeat offers to link instead of adding a second");
  assert.ok(app.includes("M.editTransfer("), "Verify edits a transfer's ends and fee");
  assert.ok(app.includes("function transferFields") && app.includes('<dt>From</dt>') && app.includes('<dt>Fee</dt>') && app.includes('<dt>Foreign</dt>'), "Verify shows From, To, Fee and the foreign amount");
  assert.ok(app.includes("Pictures are not in a backup, so those entries will say \"picture not on this phone\"."), "the restore says plainly that photos are not in the backup");
  assert.ok(app.includes("Picture not on this phone."), "a row whose picture is missing says so");
  assert.ok(app.includes("M.isFeeId(t.id)"), "a fee draft is shown inside its transfer, not as a row of its own");
  const sw = readFileSync(new URL("../app/sw.js", import.meta.url), "utf8");
  assert.ok(sw.includes("../src/model/transfers.js"), "works offline");
});

// ----- the follow-ups: typed transfers, a rate hint, last 4 on Cards, Bank fees as a need -----
import { lastRate, readBucket } from "../src/model/index.js";

test("a transfer typed on Log is a manual draft: no photo flags, its fee follows, it verifies and edits like the scanned one", () => {
  const p = planTransfer(base(), { transaction_id: "m1", date: "2026-10-03", from_account_id: "bank", to_account_id: "wallet", amount: 50000, fee: 1500, payee: "Transfer", source: "manual" }, NOW);
  assert.equal(p.ok, true, JSON.stringify(p.violations));
  for (const id of ["m1", "fee:m1"]) {
    const t = p.state.transactions.find((x) => x.id === id);
    assert.deepEqual([t.source, t.status, "edited_before_verify" in t], ["manual", "draft", false], id + ": a typed entry has no photo flag");
    assert.deepEqual(validateShape("Transaction", t), [], id);
  }
  assert.equal(planTransfer(base(), { transaction_id: "m2", date: "2026-10-03", from_account_id: "bank", to_account_id: "wallet", amount: 100, source: "voice" }).ok, false, "only photo or manual");
  const e = editTransfer(p.state, "m1", { to_account_id: "cash", amount: 40000, fee: 0 }, NOW);
  assert.equal(e.ok, true, JSON.stringify(e.violations));
  assert.equal(e.state.transactions.find((x) => x.id === "m1").source, "manual"); assert.equal("edited_before_verify" in e.state.transactions.find((x) => x.id === "m1"), false);
  assert.equal(feeOf(e.state, "m1").transaction, null);
  const v = verifyDraft(p.state, "m1", NOW);
  assert.deepEqual(v.state.transactions.filter((x) => x.id.endsWith("m1")).map((x) => x.status), ["verified", "verified"]);
  const other = { ...p.state, transactions: p.state.transactions.map((x) => (x.id === "m1" ? { ...x, source: "template" } : x)) };
  assert.equal(editTransfer(other, "m1", { amount: 1 }).ok, false, "a sweep or reserve transfer is not edited here");
});

test("the last rate for a currency is a hint taken from the newest foreign amount, never a default", () => {
  assert.equal(lastRate(base(), "USD"), null);
  let s = base();
  for (const [id, date, pesos] of [["f1", "2026-09-01", 560000], ["f2", "2026-10-02", 570000]]) s = planTransfer(s, { transaction_id: id, date, from_account_id: "bank", to_account_id: "cash", amount: pesos, foreign: { currency: "USD", amount: 10000 } }, NOW).state;
  s = planTransfer(s, { transaction_id: "f3", date: "2026-10-03", from_account_id: "bank", to_account_id: "cash", amount: 90000, foreign: { currency: "JPY", amount: 250000 } }, NOW).state;
  assert.equal(lastRate(s, "USD"), 57, "the newest USD one, not the oldest");
  assert.equal(lastRate(s, "JPY"), 0.36); assert.equal(lastRate(s, "EUR"), null);
});

test("Bank fees reads as a need from its name, so it is not asked", () => {
  for (const n of ["Bank fees", "Bank fee", "ATM fee", "Service fee"]) assert.equal(readBucket(n).bucket, "need", n);
  assert.equal(readBucket("Family").bucket, null, "the ask words are untouched");
});

test("the screens: Move money on Log, last 4 beside an account on Cards, a rate hint in the scan window", () => {
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  assert.ok(app.includes('data-action="open-move" style="width:100%">Move money between accounts</button>') && app.includes('case "save-move"') && app.includes('source: "manual"'), "a transfer can be typed");
  const log = app.slice(app.indexOf("function viewLog()"), app.indexOf("function viewVerify()")), cards = app.slice(app.indexOf("function viewCards()"), app.indexOf("function viewMoney()"));
  assert.ok(!log.includes("open-move") && cards.includes("open-move"), "it lives on Cards, with the accounts, not on the Log home where few would know what it is");
  assert.ok(/class="l4" aria-label="ends in/.test(app), "Cards shows the last 4 beside the name");
  assert.ok(app.includes("function rateHint") && app.includes("M.lastRate(S(), fx.currency)") && app.includes("${rateHint(f.foreign)}"), "a hint, shown under the foreign note");
  assert.ok(app.includes('(t.source === "photo" || t.source === "manual")'), "Verify edits both ends of a typed transfer too");
});
