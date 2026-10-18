import { test } from "node:test";
import assert from "node:assert/strict";
import { loggedMatch, previewImport, categoryFromHistory } from "../src/model/index.js";

// Invented numbers only. A bank statement import asks "is this already in the ledger?" for every line, against every entry. It once rescanned all the entries for every
// transaction for every line, so a few thousand entries froze the phone for many seconds (the lag the owner saw after uploading statements).
const TS = "2026-01-01T09:00:00.000+08:00";
function ledger(n) {
  const st = { categories: [{ id: "food", name: "Food", kind: "expense" }, { id: "fun", name: "Fun", kind: "expense" }, { id: "unlogged", name: "Unlogged", kind: "expense" }], accounts: [{ id: "a", name: "A" }, { id: "b", name: "B" }], presets: [], transactions: [], entries: [] };
  let seed = 7; const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  for (let i = 0; i < n; i++) {
    const id = "t" + i, d = `2026-${String(1 + rnd(9)).padStart(2, "0")}-${String(1 + rnd(28)).padStart(2, "0")}`, amount = 1000 + rnd(40) * 100, acct = rnd(2) ? "a" : "b";
    st.transactions.push({ id, date: d, payee: "Shop " + rnd(30), memo: "", status: rnd(4) ? "verified" : "draft", source: "manual", created_at: TS, ...(rnd(25) === 0 ? { reverses: "t" + rnd(Math.max(1, i)) } : {}) });
    st.entries.push({ transaction_id: id, category_id: rnd(2) ? "food" : "fun", amount }, { transaction_id: id, account_id: acct, amount: -amount });
  }
  return st;
}
// The first way it was written, kept here as the reference the fast one must agree with.
const dayGap = (a, b) => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86400000));
const loose = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function slowMatch(state, { date, name, amount, accountId = null }, used = new Set(), days = 2) {
  const cancelled = new Set(state.transactions.filter((t) => t.reverses).map((t) => t.reverses));
  const spent = (t) => state.entries.find((e) => e.transaction_id === t.id && e.category_id)?.amount;
  const hits = state.transactions.filter((t) => !t.reverses && !cancelled.has(t.id) && !used.has(t.id) && spent(t) === amount && dayGap(t.date, date) <= days
    && (!accountId || state.entries.some((e) => e.transaction_id === t.id && e.account_id === accountId)));
  hits.sort((x, y) => (loose(y.payee) === loose(name)) - (loose(x.payee) === loose(name)) || dayGap(x.date, date) - dayGap(y.date, date));
  return hits[0] ?? null;
}

test("loggedMatch agrees with the plain way of working it out, line by line, with and without an account and with lines already answered", () => {
  const st = ledger(400);
  const used = new Set(), usedSlow = new Set();
  let seed = 3; const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  for (let i = 0; i < 300; i++) {
    const line = { date: `2026-${String(1 + rnd(9)).padStart(2, "0")}-${String(1 + rnd(28)).padStart(2, "0")}`, name: "Shop " + rnd(30), amount: 1000 + rnd(40) * 100, accountId: i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : null };
    const fast = loggedMatch(st, line, used), slow = slowMatch(st, line, usedSlow);
    assert.equal(fast?.id ?? null, slow?.id ?? null, "line " + i);
    if (fast) { used.add(fast.id); usedSlow.add(slow.id); }
  }
});

test("a ledger edited in place is not answered from an old pass", () => {
  const st = ledger(20);
  assert.equal(loggedMatch(st, { date: "2026-12-01", name: "New", amount: 123456 }), null);
  st.transactions.push({ id: "new", date: "2026-12-01", payee: "New", memo: "", status: "verified", source: "manual", created_at: TS });
  st.entries.push({ transaction_id: "new", category_id: "food", amount: 123456 }, { transaction_id: "new", account_id: "a", amount: -123456 });
  assert.equal(loggedMatch(st, { date: "2026-12-01", name: "New", amount: 123456 })?.id, "new");
  assert.equal(categoryFromHistory(st, "New"), "food");
  st.transactions.push({ id: "n2", date: "2026-12-02", payee: "New", memo: "", status: "verified", source: "manual", created_at: TS });
  st.entries.push({ transaction_id: "n2", category_id: "fun", amount: 5 }, { transaction_id: "n2", account_id: "a", amount: -5 }, { transaction_id: "n2x", category_id: "fun", amount: 5 });
  st.transactions.push({ id: "n3", date: "2026-12-03", payee: "New", memo: "", status: "verified", source: "manual", created_at: TS });
  st.entries.push({ transaction_id: "n3", category_id: "fun", amount: 5 });
  assert.equal(categoryFromHistory(st, "New"), "fun", "two fun against one food");
});

test("previewImport for hundreds of lines against thousands of entries takes a moment, not many seconds", () => {
  const st = ledger(4000), items = Array.from({ length: 300 }, (_, i) => ({ id: "i" + i, dateRaw: `${1 + (i % 28)}/${1 + (i % 9)}/2026`, name: "Shop " + (i % 33), amount: 1000 + (i % 40) * 100, meaning: "spending" }));
  const t0 = performance.now(), p = previewImport(st, items, "dmy", null), ms = performance.now() - t0;
  assert.equal(p.lines.length + p.duplicates.length + p.undated.length, 300);
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms (it took about 40 seconds before it was fixed)`);
});
