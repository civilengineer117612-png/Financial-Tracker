import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestFromHistory, suggestFromPlan, scheduleHints, addSchedule } from "../src/model/index.js";
import { account } from "./fixtures.js";

// Invented names, days and amounts only.
const TODAY = "2026-10-10";
const base = () => ({
  accounts: [account({ id: "bank", name: "Test Bank", class: "asset", opening_balance: 9000000 }), account({ id: "wallet", name: "Test Wallet", class: "asset", opening_balance: 100000 })],
  categories: [{ id: "c-sub", name: "Subscription", kind: "expense", role: "subscription" }, { id: "c-rent", name: "Rent", kind: "expense", role: "rent" }, { id: "c-food", name: "Food", kind: "expense", role: "food" },
    { id: "c-util", name: "Utilities", kind: "expense", role: "utilities" }, { id: "c-pay", name: "Pay", kind: "income" }],
  envelopes: [], transactions: [], entries: [], attachments: [], tags: [], foreignAmounts: [], schedules: [], scheduleChanges: [],
});
let n = 0;
const spend = (s, payee, date, amount, o = {}) => {
  const id = "t" + ++n;
  s.transactions.push({ id, date, payee, memo: "", status: "verified", source: "manual", created_at: date + "T09:00:00.000+08:00", verified_at: date + "T09:00:00.000+08:00", ...(o.tx ?? {}) });
  s.entries.push({ transaction_id: id, category_id: o.category ?? "c-sub", amount }, { transaction_id: id, account_id: o.account ?? "bank", amount: -amount });
  return s;
};
const monthly = (s, payee, days, amounts, o) => { const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]; months.forEach((m, i) => { if (i < days.length) spend(s, payee, m + "-" + String(days[i]).padStart(2, "0"), amounts[i % amounts.length], o); }); return s; };

test("the same payee paid in 3 or more months, around the same day, for the same amount, is suggested with its day, amount, category and account", () => {
  const s = monthly(base(), "Stream Plus", [8, 8, 9, 8], [29900]);
  const h = suggestFromHistory(s, TODAY);
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].name, h[0].amount, h[0].approx, h[0].day, h[0].category_id, h[0].account_id, h[0].months, h[0].source], ["Stream Plus", 29900, false, 8, "c-sub", "bank", 4, "history"]);
});
test("a payee that varies a little is suggested with an about amount; one that swings widely, or comes up in only 2 months, is not", () => {
  const near = monthly(base(), "Power Co", [20, 21, 20, 22], [150000, 162000, 158000, 149000], { category: "c-util" });
  const h = suggestFromHistory(near, TODAY); assert.equal(h.length, 1); assert.equal(h[0].approx, true); assert.ok(h[0].amount >= 149000 && h[0].amount <= 162000);
  assert.deepEqual(suggestFromHistory(monthly(base(), "Power Co", [20, 21, 20, 22], [150000, 400000, 90000, 149000]), TODAY), [], "a swinging amount is not a repeating payment");
  assert.deepEqual(suggestFromHistory(monthly(base(), "Stream Plus", [8, 8], [29900]), TODAY), [], "only 2 months");
});
test("days that drift too far apart, or many payments in one month, do not make a monthly payment", () => {
  assert.deepEqual(suggestFromHistory(monthly(base(), "Stream Plus", [2, 14, 25, 3], [29900]), TODAY), []);
  const s = base(); for (const d of ["05", "12", "19", "26"]) spend(s, "Corner Cafe", "2026-09-" + d, 9500); spend(s, "Corner Cafe", "2026-08-05", 9500); spend(s, "Corner Cafe", "2026-07-05", 9500);
  assert.deepEqual(suggestFromHistory(s, TODAY), [], "a cafe visited weekly is a habit, not a bill");
  const busy = base(); for (const m of ["06", "07", "08", "09"]) for (const d of ["08", "09", "10"]) spend(busy, "Corner Cafe", "2026-" + m + "-" + d, 9500);
  assert.deepEqual(suggestFromHistory(busy, TODAY), [], "three visits a month, all in the same few days, is still a habit");
});
test("old history is ignored, and so are drafts, count gaps, scheduled payments, cancelled entries and transfers", () => {
  assert.deepEqual(suggestFromHistory(monthly(base(), "Stream Plus", [8, 8, 8, 8], [29900]), "2027-03-10"), [], "all of it is older than 6 months");
  for (const tx of [{ status: "draft" }, { source: "reconciliation" }, { source: "template" }, { source: "correction" }]) {
    assert.deepEqual(suggestFromHistory(monthly(base(), "Stream Plus", [8, 8, 8, 8], [29900], { tx }), TODAY), [], JSON.stringify(tx));
  }
  const s = monthly(base(), "Stream Plus", [8, 8, 8], [29900]);
  assert.equal(suggestFromHistory(s, TODAY).length, 1, "3 months: suggested");
  s.transactions.push({ id: "rev", date: "2026-07-08", payee: "Stream Plus", memo: "", status: "verified", source: "correction", reverses: s.transactions[2].id, created_at: "2026-07-08T09:00:00.000+08:00", verified_at: "2026-07-08T09:00:00.000+08:00" });
  s.entries.push({ transaction_id: "rev", category_id: "c-sub", amount: -29900 }, { transaction_id: "rev", account_id: "bank", amount: 29900 });
  assert.deepEqual(suggestFromHistory(s, TODAY), [], "one of the 3 months was cancelled: only 2 are left");
  const mv = monthly(base(), "Move", [8, 8, 8, 8], [5000]); for (const e of mv.entries.filter((x) => x.category_id)) { e.account_id = "wallet"; delete e.category_id; }
  assert.deepEqual(suggestFromHistory(mv, TODAY), [], "a move between two accounts is not spending");
});
test("a name that already has a schedule, or that was dismissed, is not suggested again", () => {
  const s = monthly(base(), "Stream Plus", [8, 8, 8, 8], [29900]);
  assert.equal(suggestFromHistory(s, TODAY).length, 1);
  assert.deepEqual(suggestFromHistory(s, TODAY, { dismissed: ["hist:stream plus"] }), []);
  const added = addSchedule(s, { id: "x", kind: "repeating", name: "  stream PLUS ", category_id: "c-sub", account_id: "bank", amount: 29900, day: 8, start: "2026-10-08" }, new Date("2026-10-10T01:00:00Z"));
  assert.equal(added.ok, true); assert.deepEqual(suggestFromHistory(added.state, TODAY), [], "matched by name, ignoring case and spaces");
});
test("the Pay plan suggests only fixed kinds (read from the category's role), once, on the payday it is paid, and never a flexible one like food", () => {
  const plan = { paydays: [{ day: 15 }, { day: "last" }], lines: [{ name: "Rent", kind: "expense", first: 0, second: 500000 }, { name: "Food", kind: "expense", first: 60000, second: 60000 }, { name: "Subscription", kind: "expense", first: 29900, second: 0 }, { name: "Savings", kind: "goal", first: 1000, second: 1000 }] };
  const p = suggestFromPlan(base(), plan);
  assert.deepEqual(p.map((x) => [x.name, x.amount, x.day, x.source]), [["Rent", 500000, 28, "plan"], ["Subscription", 29900, 15, "plan"]]);
  const s = base(); s.schedules = [{ id: "r", kind: "repeating", name: "My rent", category_id: "c-rent", account_id: "bank", amount: 500000, day: 5, start: "2026-09-05", created_at: "2026-09-01T00:00:00.000+08:00" }];
  assert.deepEqual(suggestFromPlan(s, plan).map((x) => x.name), ["Subscription"], "rent is already scheduled, matched by category");
  assert.deepEqual(suggestFromPlan(base(), null), []);
  assert.deepEqual(suggestFromPlan(base(), plan, { dismissed: ["plan:rent"] }).map((x) => x.name), ["Subscription"]);
});
test("both sources together: a payee in both shows once, history first, at most three", () => {
  const s = monthly(base(), "Subscription", [15, 15, 16, 15], [29900]);
  const plan = { paydays: [{ day: 15 }, { day: "last" }], lines: [{ name: "Subscription", kind: "expense", first: 29900, second: 0 }, { name: "Rent", kind: "expense", first: 0, second: 500000 }] };
  assert.deepEqual(scheduleHints(s, TODAY, plan).map((x) => [x.name, x.source]), [["Subscription", "history"], ["Rent", "plan"]]);
  for (const name of ["A One", "B Two", "C Three", "D Four"]) monthly(s, name, [3, 3, 3, 3], [10000]);
  assert.equal(scheduleHints(s, TODAY, plan).length, 3);
});
