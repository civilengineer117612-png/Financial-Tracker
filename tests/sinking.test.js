import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sinkingBalance, sinkingFunds, setAsideForSpending, toggleSinking, sinkingStart, SINKING_NOTE, splitSavings } from "../src/model/index.js";

// Invented numbers. A category "Insurance" is saved for at P1,000 a month; P3,000 is paid in month 3.
const rule = (id, sub, amount, from) => ({ id, kind: "budget", subject_id: sub, amount, effective_from: from + "-01", created_at: from + "-01T08:00:00.000+08:00" });
const tx = (id, date, amount) => [{ id, date, payee: "Insurer", memo: "", status: "verified", source: "manual", created_at: date + "T09:00:00.000+08:00", verified_at: date + "T09:00:00.000+08:00" },
  [{ transaction_id: id, category_id: "ins", amount }, { transaction_id: id, account_id: "w", amount: -amount }]];
const paid = [tx("p1", "2026-08-10", 300000)];
const state = { categories: [{ id: "ins", name: "Insurance", kind: "expense" }, { id: "food", name: "Food", kind: "expense" }], categoryMaps: [], rules: [rule("r1", "ins", 100000, "2026-06")],
  transactions: paid.map((p) => p[0]), entries: paid.flatMap((p) => p[1]), accounts: [], goals: [] };
const at = (month) => sinkingBalance(state, { rules: state.rules, categoryId: "ins", since: "2026-06", month, asOf: month + "-28" });

test("what is saved up carries over month to month, and a funded payment is not 'over'", () => {
  assert.deepEqual(at("2026-06"), { months: 1, setAside: 100000, spent: 0, available: 100000, over: false });
  assert.equal(at("2026-07").available, 200000, "two months saved, nothing spent");
  const aug = at("2026-08");
  assert.equal(aug.setAside, 300000); assert.equal(aug.spent, 300000); assert.equal(aug.available, 0); assert.equal(aug.over, false, "P3,000 was saved for exactly this");
  assert.equal(at("2026-09").available, 100000, "after the payment it starts filling again");
});

test("spending more than was set aside is over, by exactly the difference", () => {
  const big = { ...state, transactions: [tx("p2", "2026-07-05", 450000)[0]], entries: tx("p2", "2026-07-05", 450000)[1] };
  const b = sinkingBalance(big, { rules: big.rules, categoryId: "ins", since: "2026-06", month: "2026-07", asOf: "2026-07-28" });
  assert.equal(b.over, true); assert.equal(b.available, -250000);
});

test("a fund counts only from its first month, and never more than 60 months", () => {
  assert.equal(sinkingBalance(state, { rules: state.rules, categoryId: "ins", since: "2026-09", month: "2026-08" }).months, 0, "starts in the future: nothing yet");
  assert.equal(sinkingBalance(state, { rules: state.rules, categoryId: "ins", since: "2000-01", month: "2026-08" }).months, 60);
});

test("the list of funds and the total waiting to be spent; an overspent fund holds nothing", () => {
  const settings = { sinking_funds: { ins: "2026-06", ghost: "2026-06", food: "2026-06" } };
  const funds = sinkingFunds(state, settings, { month: "2026-07", asOf: "2026-07-28" });
  assert.deepEqual(funds.map((f) => f.name), ["Insurance", "Food"], "a category that is gone is left out; biggest set-aside first");
  assert.equal(setAsideForSpending(funds), 200000, "Food has no budget, so it holds nothing");
  assert.equal(setAsideForSpending([{ available: -5 }, { available: 70 }]), 70, "negative balances never reduce the total");
});

test("turning it on and off; the setting is a plain map, no data version change", () => {
  const on = toggleSinking({}, "ins", "2026-10");
  assert.deepEqual(on, { ins: "2026-10" }); assert.equal(sinkingStart({ sinking_funds: on }, "ins"), "2026-10");
  assert.deepEqual(toggleSinking({ sinking_funds: on }, "ins", "2026-11"), {}, "a second tap turns it off");
  const keep = toggleSinking({ sinking_funds: { a: "2026-01" } }, "ins", "2026-10"); assert.deepEqual(keep, { a: "2026-01", ins: "2026-10" });
});

test("a sinking fund is never savings: it is not a Goal, and the savings split does not see it", () => {
  assert.ok(SINKING_NOTE.includes("not saved") && SINKING_NOTE.includes("not part of your savings"));
  const out = splitSavings({ goals: [], progress: new Map(), month: "2026-07", total: 100000, pins: {}, shares: {} });
  assert.ok(!JSON.stringify(out).includes("ins"), "nothing about the category in the savings split");
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  assert.ok(app.includes("const setAsideHtml") && app.includes("M.SINKING_NOTE"), "the Saved view lists them apart, under the note that says so");
  assert.match(app, /M\.setAsideForSpending\(M\.sinkingFunds\(/, "Cards says how much of 'in your accounts' is set aside");
  assert.match(app, /case "toggle-sinking":/);
  assert.match(app, /const sf = funds\.get\(r\.c\.id\);/, "a saving-up category is judged against what was set aside, not the month alone");
});
