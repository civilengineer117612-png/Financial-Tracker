import { test } from "node:test";
import assert from "node:assert/strict";
import { planExpense, verifyDraft, applyDrafts, correctable, planCorrection, applyCorrection, isReversed, correctionTag, naturalBalance, countedEntries, cardOutstanding, editDraftFields, planTransfer, editTransfer } from "../src/model/index.js";
import { makeState } from "./fixtures.js";

// Invented data. A checking account of 1,000.00 and one verified lunch of 120.00 on the 8th.
const NOW = new Date("2026-10-08T12:00:00+08:00"), TODAY = "2026-10-10";
function ledger({ card = false } = {}) {
  let s = makeState();
  const p = planExpense(s, { transaction_id: "lunch", date: "2026-10-08", payee: "Corner Cafe", category_id: "food", amount: 12000, account_id: card ? "card" : "chk", reserve_source_id: card ? "res" : undefined }, NOW);
  s = applyDrafts(s, p.drafts);
  return verifyDraft(s, "lunch", NOW).state;
}
const chk = (s) => naturalBalance(s.accounts.find((a) => a.id === "chk"), countedEntries(s));
const ids = (s) => s.transactions.map((t) => t.id);

test("a verified entry from the last two weeks can be corrected; drafts, count gaps, scheduled payments and corrections cannot", () => {
  const s = ledger();
  assert.deepEqual(correctable(s, TODAY).map((t) => t.id), ["lunch"]);
  assert.deepEqual(correctable(s, "2026-10-30").map((t) => t.id), [], "too old");
  const draft = applyDrafts(s, planExpense(s, { transaction_id: "d1", date: "2026-10-09", payee: "x", category_id: "food", amount: 100, account_id: "chk" }, NOW).drafts);
  assert.ok(!correctable(draft, TODAY).some((t) => t.id === "d1"), "a draft is edited in Verify, not here");
  for (const source of ["reconciliation", "template", "correction"]) {
    const odd = { ...s, transactions: s.transactions.map((t) => ({ ...t, source })) };
    assert.deepEqual(correctable(odd, TODAY), [], source);
  }
});

test("a correction cancels the old entry with a new one and leaves the old rows exactly as they were", () => {
  const s = ledger(), before = JSON.stringify({ t: s.transactions, e: s.entries });
  assert.equal(chk(s), 100000 - 12000);
  const p = planCorrection(s, { id: "lunch", redo_id: "fix1", today: TODAY }, NOW);
  assert.equal(p.ok, true, JSON.stringify(p.violations));
  const next = applyCorrection(s, { ...p, redo: null });
  assert.equal(chk(next), 100000, "the money is back (the fresh draft, which also counts, is left out here)");
  assert.equal(chk(applyCorrection(s, p)), 100000 - 12000, "with the fresh draft in place the balance shows the same spending again until it is changed");
  assert.equal(JSON.stringify({ t: next.transactions.filter((t) => t.id === "lunch"), e: next.entries.filter((e) => e.transaction_id === "lunch") }),
    JSON.stringify({ t: s.transactions.filter((t) => t.id === "lunch"), e: s.entries.filter((e) => e.transaction_id === "lunch") }), "the old entry is untouched");
  assert.ok(before.length > 0 && ids(next).includes("rev:lunch"));
  const rev = next.transactions.find((t) => t.id === "rev:lunch");
  assert.equal(rev.status, "verified"); assert.equal(rev.source, "correction"); assert.equal(rev.reverses, "lunch"); assert.equal(rev.date, "2026-10-08", "dated like the old entry, so its month nets to zero");
  assert.equal(next.entries.filter((e) => e.transaction_id === "rev:lunch").reduce((n, e) => n + e.amount, 0), 0);
  assert.equal(next.entries.filter((e) => e.category_id === "food").reduce((n, e) => n + e.amount, 0), 0, "spending on the category nets to zero");
});

test("a plain expense comes back as a fresh draft with the old values; the right amount verified makes the balance right", () => {
  const s = ledger();
  const p = planCorrection(s, { id: "lunch", redo_id: "fix1", today: TODAY }, NOW);
  assert.equal(p.redo.length, 1);
  const next = applyCorrection(s, p), draft = next.transactions.find((t) => t.id === "fix1");
  assert.equal(draft.status, "draft"); assert.equal(draft.corrects, "lunch"); assert.equal(draft.payee, "Corner Cafe");
  assert.equal(next.entries.find((e) => e.transaction_id === "fix1" && e.category_id).amount, 12000);
  const edited = editDraftFields(next, "fix1", { amount: 9000 }, {}, NOW);
  assert.equal(edited.ok, true, JSON.stringify(edited.violations));
  const done = verifyDraft(edited.state, "fix1", NOW).state;
  assert.equal(chk(done), 100000 - 9000);
});

test("an entry can be corrected once; the tags say which is which", () => {
  const s = ledger(), next = applyCorrection(s, planCorrection(s, { id: "lunch", redo_id: "fix1", today: TODAY }, NOW));
  assert.equal(isReversed(next, "lunch"), true);
  assert.equal(planCorrection(next, { id: "lunch", redo_id: "fix2", today: TODAY }, NOW).ok, false);
  assert.ok(!correctable(next, TODAY).some((t) => t.id === "lunch" || t.id === "rev:lunch"));
  assert.equal(correctionTag(next, next.transactions.find((t) => t.id === "lunch")), "Corrected");
  assert.equal(correctionTag(next, next.transactions.find((t) => t.id === "rev:lunch")), "Correction");
  assert.equal(correctionTag(next, next.transactions.find((t) => t.id === "fix1")), null);
});

test("a card purchase is cancelled together with its reserve transfer", () => {
  const s = ledger({ card: true });
  assert.ok(ids(s).includes("rsv:lunch"));
  const owed = (x) => cardOutstanding(x.accounts.find((a) => a.id === "card"), countedEntries(x)).posted + cardOutstanding(x.accounts.find((a) => a.id === "card"), countedEntries(x)).pending;
  assert.equal(owed(s), 12000);
  const p = planCorrection(s, { id: "lunch", redo_id: "fix1", reserve_source_id: "res", today: TODAY }, NOW);
  assert.equal(p.ok, true, JSON.stringify(p.violations));
  assert.deepEqual(p.transactions.map((t) => t.id).sort(), ["rev:lunch", "rev:rsv:lunch"]);
  const next = applyCorrection(s, p);
  assert.equal(owed(applyCorrection(s, { ...p, redo: null })), 0);
  assert.equal(owed(next), 12000, "the fresh draft holds the same charge until the right amount is typed");
  assert.ok(ids(next).includes("rsv:fix1"), "the fresh draft brings its own reserve transfer");
  assert.ok(!correctable(s, TODAY).some((t) => t.id === "rsv:lunch"), "the reserve transfer is not listed on its own");
});

test("a move between two accounts comes back as a transfer draft with its fee; the right amount verified makes both balances right", () => {
  let s = ledger();
  const made = planTransfer(s, { transaction_id: "mv", date: "2026-10-09", from_account_id: "chk", to_account_id: "res", amount: 5000, fee: 1500, payee: "Move", source: "manual" }, NOW);
  assert.equal(made.ok, true, JSON.stringify(made.violations));
  s = verifyDraft(made.state, "mv", NOW).state;
  assert.equal(s.transactions.find((t) => t.id === "fee:mv").status, "verified", "the fee is verified with the move");
  const bal = (x, id) => naturalBalance(x.accounts.find((a) => a.id === id), countedEntries(x));
  const before = [bal(s, "chk"), bal(s, "res")];
  const p = planCorrection(s, { id: "mv", redo_id: "fix9", today: TODAY }, NOW);
  assert.equal(p.ok, true, JSON.stringify(p.violations));
  assert.deepEqual(p.transactions.map((t) => t.id).sort(), ["rev:fee:mv", "rev:mv"]);
  assert.deepEqual(p.redo.map((d) => d.transaction.id).sort(), ["fee:fix9", "fix9"]);
  assert.equal(p.redo.find((d) => d.transaction.id === "fix9").transaction.corrects, "mv");
  const gone = applyCorrection(s, { ...p, redo: null });
  assert.deepEqual([bal(gone, "chk"), bal(gone, "res")], [before[0] + 5000 + 1500, before[1] - 5000], "cancelled: both accounts are back where they were before the move");
  const next = applyCorrection(s, p);
  assert.deepEqual([bal(next, "chk"), bal(next, "res")], before, "with the fresh draft in place the figures read the same until it is changed");
  const edited = editTransfer(next, "fix9", { amount: 4000, fee: 1000 }, NOW);
  assert.equal(edited.ok, true, JSON.stringify(edited.violations));
  const done = verifyDraft(edited.state, "fix9", NOW).state;
  assert.deepEqual([bal(done, "chk"), bal(done, "res")], [before[0] + 5000 + 1500 - 4000 - 1000, before[1] - 5000 + 4000]);
});

test("an income entry and a split purchase are cancelled with no draft", () => {
  const s = ledger();
  const inc = { ...s, transactions: [...s.transactions, { id: "pay", date: "2026-10-09", payee: "Pay", memo: "", status: "verified", source: "manual", created_at: "2026-10-09T09:00:00.000+08:00", verified_at: "2026-10-09T09:00:00.000+08:00" }],
    entries: [...s.entries, { transaction_id: "pay", category_id: "pay", amount: -30000 }, { transaction_id: "pay", account_id: "chk", amount: 30000 }] };
  const p = planCorrection(inc, { id: "pay", redo_id: "fix8", today: TODAY }, NOW);
  assert.equal(p.ok, true, JSON.stringify(p.violations)); assert.equal(p.redo, null);
  assert.equal(chk(applyCorrection(inc, p)), chk(inc) - 30000);
  const split = { ...s, transactions: [...s.transactions, { id: "sp", date: "2026-10-09", payee: "Mart", memo: "", status: "verified", source: "manual", created_at: "2026-10-09T09:00:00.000+08:00", verified_at: "2026-10-09T09:00:00.000+08:00" }],
    entries: [...s.entries, { transaction_id: "sp", category_id: "food", amount: 3000 }, { transaction_id: "sp", category_id: "food", amount: 2000 }, { transaction_id: "sp", account_id: "chk", amount: -5000 }] };
  const q = planCorrection(split, { id: "sp", redo_id: "fix7", today: TODAY }, NOW);
  assert.equal(q.ok, true, JSON.stringify(q.violations)); assert.equal(q.redo, null);
  assert.equal(chk(applyCorrection(split, q)), chk(split) + 5000);
});
