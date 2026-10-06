import { test } from "node:test";
import assert from "node:assert/strict";
import { planTag, tagSummary, planExpense, applyDrafts, planTripDates, planTripOverride, tripMembership, tripEntries, validateShape } from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

function s0() {
  const s = makeState();
  s.accounts.push(account({ id: "cash", name: "Test Cash", class: "asset", opening_balance: 10000000 }));
  s.categories.push({ id: "fare", name: "Fares", kind: "expense" });
  s.tags = [];
  return s;
}
const verify = (s) => ({ ...s, transactions: s.transactions.map((t) => ({ ...t, status: "verified", verified_at: t.created_at })) });
const spend = (s, id, cat, amount, tag_id) => {
  const r = planExpense(s, { transaction_id: id, date: "2026-10-05", category_id: cat, amount, account_id: "cash", ...(tag_id ? { tag_id } : {}) });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  return applyDrafts(s, r.drafts);
};

test("a trip is a unique, named tag with an optional non-negative budget", () => {
  const r = planTag(s0(), { id: "t1", name: " Test Trip ", budget: 500000 });
  assert.deepEqual([r.ok, r.tag.name, r.state.tags.length], [true, "Test Trip", 1]);
  for (const [o, code] of [[{ name: " " }, "BAD_NAME"], [{ id: "t1" }, "DUPLICATE_ID"], [{ id: "t2", name: "test TRIP" }, "DUPLICATE_NAME"], [{ id: "t2", name: "B", budget: -1 }, "BAD_BUDGET"], [{ id: "t2", name: "B", budget: 1.5 }, "BAD_BUDGET"]]) {
    assert.equal(planTag(r.state, { id: "t2", name: "Other", ...o }).violations[0].code, code);
  }
  assert.equal("budget" in planTag(s0(), { id: "t3", name: "No budget" }).tag, false);
});
test("an expense can carry a trip tag, and an unknown tag is refused", () => {
  const s = planTag(s0(), { id: "t1", name: "Trip" }).state;
  const ok = planExpense(s, { transaction_id: "a", date: "2026-10-05", category_id: "fare", amount: 1000, account_id: "cash", tag_id: "t1" });
  assert.equal(ok.drafts[0].transaction.trip_add, "t1"); assert.equal("tag_id" in ok.drafts[0].transaction, false, "the old field is no longer written");
  const bad = planExpense(s, { transaction_id: "a", date: "2026-10-05", category_id: "fare", amount: 1000, account_id: "cash", tag_id: "nope" });
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].code, "UNKNOWN_TAG");
});
test("a trip summary counts only verified, tagged spending, by category, with a budget grade", () => {
  let s = planTag(s0(), { id: "t1", name: "Trip", budget: 100000 }).state;
  s = spend(s, "a", "fare", 60000, "t1");
  s = spend(s, "b", "food", 30000, "t1");
  s = spend(s, "c", "fare", 999, null);          // not on the trip
  s = verify(s);
  s = spend(s, "d", "fare", 4000, "t1");         // a draft on the trip
  const sum = tagSummary(s, "t1");
  assert.deepEqual([sum.spent, sum.pending, sum.budget], [90000, 4000, 100000]);
  assert.deepEqual(sum.rows.map((r) => [r.name, r.amount]), [["Fares", 60000], ["Food", 30000]]);
  assert.equal(sum.grade.level, "serious", "90% of the budget is used");
  assert.equal(tagSummary(s, "nope"), null);
  assert.equal(tagSummary(planTag(s0(), { id: "t9", name: "Free" }).state, "t9").grade, null, "no budget, no grade");
});

// ----- trips with dates (data version 4) -----
const TS = "2026-10-01T09:00:00.000+08:00";
// A hand-made state: a spending entry, a move between own accounts, a card bill payment, a template entry. Invented amounts.
function dated(extra = []) {
  const s = s0();
  s.accounts.push(account({ id: "card2", name: "Test Card Two", class: "liability" }), account({ id: "sav", name: "Test Savings", class: "asset" }));
  s.tags = [{ id: "a", name: "Trip A", start: "2026-10-10", end: "2026-10-14" }, { id: "b", name: "Trip B", start: "2026-10-20", end: "2026-10-22", budget: 100000 }, { id: "u", name: "Undated" }];
  const add = (id, date, kind, o = {}) => {
    s.transactions.push({ id, date, payee: "", memo: "", status: "verified", source: "manual", created_at: TS, verified_at: TS, ...o });
    if (kind === "spend") s.entries.push({ transaction_id: id, category_id: "fare", amount: 1000 }, { transaction_id: id, account_id: "cash", amount: -1000 });
    if (kind === "move") s.entries.push({ transaction_id: id, account_id: "sav", amount: 5000 }, { transaction_id: id, account_id: "cash", amount: -5000 });
    if (kind === "bill") s.entries.push({ transaction_id: id, account_id: "card2", amount: 7000 }, { transaction_id: id, account_id: "cash", amount: -7000 });
  };
  add("first", "2026-10-10", "spend"); add("last", "2026-10-14", "spend"); add("before", "2026-10-09", "spend"); add("after", "2026-10-15", "spend"); add("mid", "2026-10-12", "spend");
  add("move", "2026-10-12", "move"); add("bill", "2026-10-12", "bill"); add("tmpl", "2026-10-12", "spend", { source: "template" });
  for (const f of extra) f(add);
  return s;
}
const ids = (s, tag) => [...tripMembership(s)].filter(([, m]) => m.tag_id === tag).map(([id]) => id).sort();

test("entries dated on a trip's days belong to it, first and last day included, and nothing else does", () => {
  assert.deepEqual(ids(dated(), "a"), ["first", "last", "mid"]);
  assert.deepEqual(ids(dated(), "b"), []);
  assert.equal(tagSummary(dated(), "a").spent, 3000);
});
test("membership is worked out, not stored: no entry or transaction is changed by dating a trip", () => {
  const s = dated(), snap = JSON.stringify([s.transactions, s.entries]);
  tripMembership(s); tagSummary(s, "a"); tripEntries(s, "a");
  assert.equal(JSON.stringify([s.transactions, s.entries]), snap);
  const moved = planTripDates(s, "u", { start: "2026-11-01", end: "2026-11-03" });
  assert.equal(JSON.stringify([moved.state.transactions, moved.state.entries]), snap, "dating a trip writes nothing into the entries");
  const changed = planTripDates(s, "a", { start: "2026-10-09", end: "2026-10-14" });
  assert.deepEqual(ids(changed.state, "a"), ["before", "first", "last", "mid"], "change the dates and the members change with them");
});
test("moves between own accounts, card bill payments and template entries are not tagged by dates, but can be added by hand", () => {
  const s = dated();
  assert.ok(!ids(s, "a").some((x) => ["move", "bill", "tmpl"].includes(x)));
  let h = s;
  for (const id of ["move", "bill", "tmpl"]) h = planTripOverride(h, id, "a", "add").state;
  assert.deepEqual(ids(h, "a"), ["bill", "first", "last", "mid", "move", "tmpl"]);
  const rows = Object.fromEntries(tripEntries(h, "a").rows.map((r) => [r.transaction.id, r]));
  assert.deepEqual([rows.move.counted, rows.bill.counted, rows.tmpl.counted], [false, false, true], "a move or bill payment is listed but is not spending");
  assert.equal(tagSummary(h, "a").spent, 4000, "only the template's spending is added to the total");
});
test("a hand removal keeps a dated entry off the trip, and adding it back clears the removal; only the entry's own override fields change", () => {
  const s = dated();
  const out = planTripOverride(s, "mid", "a", "remove").state;
  assert.deepEqual(ids(out, "a"), ["first", "last"]); assert.equal(out.transactions.find((t) => t.id === "mid").trip_out, "a");
  const back = planTripOverride(out, "mid", "a", "add").state;
  assert.deepEqual(ids(back, "a"), ["first", "last", "mid"]);
  const t = back.transactions.find((x) => x.id === "mid"); assert.equal(t.trip_out, undefined); assert.equal(t.trip_add, "a");
  const { trip_add, ...plain } = t; assert.deepEqual(plain, s.transactions.find((x) => x.id === "mid"), "nothing else about the entry changed");
  assert.equal(planTripOverride(s, "nope", "a", "add").ok, false); assert.equal(planTripOverride(s, "mid", "zzz", "add").ok, false);
});
test("removing a hand-added entry that dates would not give the trip just clears the add; one that dates would give it is also marked out", () => {
  const s = dated();
  const added = planTripOverride(s, "after", "a", "add").state;
  assert.deepEqual(ids(added, "a"), ["after", "first", "last", "mid"]);
  const gone = planTripOverride(added, "after", "a", "remove").state;
  assert.deepEqual(gone.transactions.find((t) => t.id === "after"), s.transactions.find((t) => t.id === "after"), "back exactly as it was");
  const both = planTripOverride(planTripOverride(s, "mid", "a", "add").state, "mid", "a", "remove").state;
  assert.equal(both.transactions.find((t) => t.id === "mid").trip_out, "a"); assert.equal(both.transactions.find((t) => t.id === "mid").trip_add, undefined);
  assert.deepEqual(ids(both, "a"), ["first", "last"]);
});
test("a hand-added entry on another day counts on its trip, and wins over the dates of a different trip", () => {
  let s = planTripOverride(dated(), "mid", "b", "add").state;
  assert.deepEqual([ids(s, "a"), ids(s, "b")], [["first", "last"], ["mid"]]);
  assert.equal(tagSummary(s, "b").spent, 1000);
});
test("an undated trip keeps manual start and stop: only entries tagged by hand are on it", () => {
  const s = dated();
  assert.deepEqual(ids(s, "u"), []);
  const r = planExpense(s, { transaction_id: "x", date: "2026-10-12", category_id: "fare", amount: 2500, account_id: "cash", tag_id: "u" });
  const s2 = applyDrafts(s, r.drafts);
  assert.deepEqual(ids(s2, "u"), ["x"]);
  assert.deepEqual(ids(s2, "a"), ["first", "last", "mid"], "the entry is on the manual trip, not also on the dated one");
});
test("Before the trip: only hand-added entries dated before the start, still counted in the total", () => {
  const s = planTripOverride(planTripOverride(dated(), "before", "a", "add").state, "after", "a", "add").state;
  const d = tripEntries(s, "a");
  assert.deepEqual(d.before.map((r) => r.transaction.id), ["before"]);
  assert.deepEqual(d.rows.map((r) => r.transaction.id), ["after", "last", "mid", "first"], "newest first; the late hand-added one is in the main list");
  assert.equal(tagSummary(s, "a").spent, 5000);
  assert.deepEqual(tripEntries(dated(), "a").before, [], "an entry dated before the trip is not in it unless added by hand");
  assert.deepEqual(tripEntries(planTripOverride(dated(), "mid", "u", "add").state, "u").before, [], "an undated trip has no before");
  assert.equal(tripEntries(s, "zzz"), null);
});
test("trips may not overlap: the message names the other trip, nothing is saved, and the day an earlier trip ends counts as overlapping", () => {
  const s = dated();
  for (const [start, end] of [["2026-10-12", "2026-10-16"], ["2026-10-14", "2026-10-18"], ["2026-10-08", "2026-10-10"], ["2026-10-01", "2026-10-31"], ["2026-10-11", "2026-10-12"]]) {
    const r = planTripDates(s, "u", { start, end });
    assert.equal(r.ok, false); assert.equal(r.violations[0].code, "TRIP_OVERLAP"); assert.match(r.violations[0].message, /"Trip A"/);
    assert.match(r.violations[0].message, /10 Oct 2026 to 14 Oct 2026/);
    const n = planTag(s, { id: "n", name: "New", start, end });
    assert.equal(n.ok, false); assert.equal(n.violations[0].code, "TRIP_OVERLAP"); assert.equal(n.state, undefined, "not saved");
  }
  assert.equal(planTripDates(s, "u", { start: "2026-10-15", end: "2026-10-19" }).ok, true, "the days between two trips are free");
  assert.equal(planTripDates(s, "a", { start: "2026-10-09", end: "2026-10-16" }).ok, true, "a trip does not overlap itself");
  assert.match(planTripDates(s, "a", { start: "2026-10-12", end: "2026-10-21" }).violations[0].message, /"Trip B"/);
});
test("logging is never blocked by trips: an entry on a day inside a trip saves like any other", () => {
  const r = planExpense(dated(), { transaction_id: "z", date: "2026-10-12", category_id: "fare", amount: 100, account_id: "cash" });
  assert.equal(r.ok, true);
});
test("trip dates must be both or neither, real, and in order; a dated trip passes the shape check and a half-dated one does not", () => {
  const s = dated();
  for (const d of [{ start: "2026-12-01" }, { end: "2026-12-01" }, { start: "2026-12-05", end: "2026-12-01" }, { start: "2026-13-01", end: "2026-13-02" }]) {
    const r = planTripDates(s, "u", d); assert.equal(r.ok, false); assert.equal(r.violations[0].code, "BAD_DATES");
  }
  assert.equal(validateShape("Tag", { id: "x", name: "X", start: "2026-12-01" }).length, 1);
  assert.equal(validateShape("Tag", { id: "x", name: "X", start: "2026-12-05", end: "2026-12-01" }).length, 1);
  assert.equal(validateShape("Tag", { id: "x", name: "X", start: "2026-12-01", end: "2026-12-01" }).length, 0, "a one-day trip is fine");
  const cleared = planTripDates(s, "a", {});
  assert.deepEqual(cleared.tag, { id: "a", name: "Trip A" }); assert.deepEqual(ids(cleared.state, "a"), []);
  assert.equal(planTripDates(s, "zzz", {}).ok, false);
});
