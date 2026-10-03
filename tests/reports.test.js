import { test } from "node:test";
import assert from "node:assert/strict";
import { spendingByCategory, spendingByAccount, monthlySpending, addMonths, monthLabel, monthOf, setAccountIcon, validateShape } from "../src/model/index.js";
import { makeState, account, tx, entry, commit } from "./fixtures.js";

const VERIFIED = { status: "verified", verified_at: "2026-04-01T08:00:00.000+08:00" };
function base() {
  const s = makeState();
  s.accounts.push(account({ id: "cash", name: "Test Cash", class: "asset", opening_balance: 100000 }));
  s.categories.push({ id: "rent", name: "Rent", kind: "expense" }, { id: "unlogged", name: "Unlogged", kind: "expense" });
  return s;
}
// A spend of `amt` on `cat`, paid from `acct`, on `date`.
function spend(s, id, date, cat, amt, acct = "chk", extra = VERIFIED) {
  commit(s, { transaction: tx({ id, date, ...extra }), entries: [
    entry({ transaction_id: id, category_id: cat, amount: amt }),
    entry({ transaction_id: id, account_id: acct, amount: -amt, ...(acct === "card" ? { card_state: "posted" } : {}) }),
  ] });
}
const M = (s, o = {}) => spendingByCategory(s, { month: "2026-03", asOf: "2026-03-31", ...o });

// ---------- months ----------
test("month arithmetic crosses year ends both ways", () => {
  assert.equal(addMonths("2026-03", 1), "2026-04");
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2026-03", -14), "2025-01");
  assert.equal(addMonths("2026-03", 0), "2026-03");
});
test("months read as words", () => {
  assert.equal(monthLabel("2026-10"), "October 2026");
  assert.equal(monthLabel("2027-01"), "January 2027");
  assert.equal(monthOf("2026-03-31"), "2026-03");
});

// ---------- by category ----------
test("spending by category: biggest first, with each share of the total", () => {
  const s = base();
  spend(s, "a", "2026-03-02", "food", 30000); spend(s, "b", "2026-03-09", "food", 10000);
  spend(s, "c", "2026-03-05", "rent", 50000); spend(s, "d", "2026-03-06", "unlogged", 10000);
  const r = M(s);
  assert.equal(r.total, 100000);
  assert.deepEqual(r.rows.map((x) => [x.name, x.amount, x.percent]), [["Rent", 50000, 50], ["Food", 40000, 40], ["Unlogged", 10000, 10]]);
});
test("shares are to one decimal and ties are ordered by name", () => {
  const s = base();
  spend(s, "a", "2026-03-02", "food", 1); spend(s, "b", "2026-03-02", "rent", 1); spend(s, "c", "2026-03-02", "unlogged", 1);
  const r = M(s);
  assert.deepEqual(r.rows.map((x) => [x.name, x.percent]), [["Food", 33.3], ["Rent", 33.3], ["Unlogged", 33.3]]);
});
test("only verified spending counts; drafts are reported as pending", () => {
  const s = base();
  spend(s, "a", "2026-03-02", "food", 10000);
  spend(s, "b", "2026-03-03", "food", 7000, "chk", { status: "draft" });
  const r = M(s);
  assert.deepEqual([r.total, r.pending], [10000, 7000]);
});
test("only the requested month counts", () => {
  const s = base();
  spend(s, "a", "2026-02-28", "food", 111); spend(s, "b", "2026-03-01", "food", 222); spend(s, "c", "2026-03-31", "food", 333); spend(s, "d", "2026-04-01", "food", 444);
  assert.equal(M(s).total, 555);
});
test("income, transfers between your own accounts and card payments are not spending", () => {
  const s = base();
  spend(s, "a", "2026-03-02", "food", 5000);
  commit(s, { transaction: tx({ id: "inc", date: "2026-03-03", ...VERIFIED }), entries: [entry({ transaction_id: "inc", category_id: "pay", amount: -90000 }), entry({ transaction_id: "inc", account_id: "chk", amount: 90000 })] });
  commit(s, { transaction: tx({ id: "mv", date: "2026-03-04", ...VERIFIED }), entries: [entry({ transaction_id: "mv", account_id: "chk", amount: -20000 }), entry({ transaction_id: "mv", account_id: "cash", amount: 20000 })] });
  commit(s, { transaction: tx({ id: "pay", date: "2026-03-05", ...VERIFIED }), entries: [entry({ transaction_id: "pay", account_id: "card", amount: 4000, card_state: "posted" }), entry({ transaction_id: "pay", account_id: "chk", amount: -4000 })] });
  const r = M(s);
  assert.deepEqual([r.total, r.rows.length], [5000, 1]);
});
test("a refund reduces its category; a category refunded to nothing disappears", () => {
  const s = base();
  spend(s, "a", "2026-03-02", "food", 10000); spend(s, "r", "2026-03-04", "food", -2500);
  spend(s, "b", "2026-03-02", "rent", 3000); spend(s, "c", "2026-03-03", "rent", -3000);
  const r = M(s);
  assert.deepEqual(r.rows.map((x) => [x.name, x.amount]), [["Food", 7500]]);
  assert.equal(r.total, 7500);
});
test("a merge regroups the month in a report run after it took effect", () => {
  const s = base();
  s.categories.push({ id: "bf", name: "Break Fast", kind: "expense" });
  spend(s, "a", "2026-03-02", "bf", 200); spend(s, "b", "2026-03-03", "food", 300);
  const maps = [{ from: "bf", to: "food", effective_from: "2026-04-01" }];
  assert.deepEqual(M(s, { categoryMaps: maps, asOf: "2026-04-15" }).rows.map((x) => [x.name, x.amount]), [["Food", 500]]);
  assert.equal(M(s, { categoryMaps: maps, asOf: "2026-03-31" }).rows.length, 2);
});
test("an empty month is zero, not an error", () => {
  assert.deepEqual(M(base()), { total: 0, pending: 0, rows: [] });
});
test("reports do not change the state they read", () => {
  const s = base(); spend(s, "a", "2026-03-02", "food", 100);
  const before = JSON.stringify(s);
  M(s); spendingByAccount(s, { month: "2026-03" }); monthlySpending(s, { endMonth: "2026-03" });
  assert.equal(JSON.stringify(s), before);
});

// ---------- by account ----------
test("spending by account counts where the money came out, a card as itself", () => {
  const s = base();
  spend(s, "a", "2026-03-02", "food", 9500, "cash"); spend(s, "b", "2026-03-03", "food", 20000, "card"); spend(s, "c", "2026-03-04", "rent", 5000, "cash");
  const r = spendingByAccount(s, { month: "2026-03" });
  assert.deepEqual(r.rows.map((x) => [x.name, x.amount]), [["Test Card", 20000], ["Test Cash", 14500]]);
  assert.equal(r.total, 34500);
});
test("by account ignores drafts, other months, and money that is not spending", () => {
  const s = base();
  spend(s, "a", "2026-03-02", "food", 100, "cash"); spend(s, "d", "2026-03-02", "food", 900, "cash", { status: "draft" }); spend(s, "o", "2026-04-02", "food", 700, "cash");
  commit(s, { transaction: tx({ id: "mv", date: "2026-03-04", ...VERIFIED }), entries: [entry({ transaction_id: "mv", account_id: "chk", amount: -20000 }), entry({ transaction_id: "mv", account_id: "cash", amount: 20000 })] });
  assert.deepEqual(spendingByAccount(s, { month: "2026-03" }).rows.map((x) => [x.name, x.amount]), [["Test Cash", 100]]);
});
test("a refund to an account reduces what came out of it", () => {
  const s = base();
  spend(s, "a", "2026-03-02", "food", 1000, "cash"); spend(s, "r", "2026-03-03", "food", -400, "cash");
  assert.equal(spendingByAccount(s, { month: "2026-03" }).rows[0].amount, 600);
});

// ---------- by month ----------
test("six months of totals, oldest first, ending at the month asked for", () => {
  const s = base();
  spend(s, "a", "2025-11-10", "food", 100); spend(s, "b", "2026-01-10", "food", 300); spend(s, "c", "2026-03-10", "food", 500); spend(s, "d", "2025-09-10", "food", 999);
  const r = monthlySpending(s, { endMonth: "2026-03", months: 6 });
  assert.deepEqual(r.map((x) => x.month), ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(r.map((x) => x.amount), [0, 100, 0, 300, 0, 500]);
});

// ---------- account pictures ----------
const PIC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
test("a small picture can be set on an account and removed again", () => {
  const s = base();
  const a = setAccountIcon(s, "cash", PIC);
  assert.equal(a.ok, true);
  assert.equal(a.state.accounts.find((x) => x.id === "cash").icon, PIC);
  assert.equal(s.accounts.find((x) => x.id === "cash").icon, undefined);   // the original state is untouched
  const b = setAccountIcon(a.state, "cash", null);
  assert.equal("icon" in b.state.accounts.find((x) => x.id === "cash"), false);
});
test("a picture that is not a small embedded image is refused", () => {
  const s = base();
  for (const bad of ["https://example.com/a.png", "data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data:image/png;base64,", "data:image/png;base64," + "A".repeat(40001), "", 5]) {
    const r = setAccountIcon(s, "cash", bad);
    assert.equal(r.ok, false, String(bad).slice(0, 40));
    assert.equal(r.state, s);
  }
  assert.equal(setAccountIcon(s, "nope", PIC).violations[0].code, "UNKNOWN_ACCOUNT");
});
test("a picture is a valid optional field of an account", () => {
  assert.deepEqual(validateShape("Account", account({ id: "x", name: "X", class: "asset", icon: PIC })), []);
  assert.deepEqual(validateShape("Account", account({ id: "x", name: "X", class: "asset" })), []);
});
