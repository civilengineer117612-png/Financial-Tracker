import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, dailySpending, firstSpendingDate, rangeFor, stepFor, seriesFor, measureSpan, zoomWindow, addDays, daysBetween, monthlySpending } from "../src/model/index.js";

// Invented spending only.
const cats = [{ id: "cat-food", name: "Food", kind: "expense" }, { id: "cat-pay", name: "Salary", kind: "income" }];
let n = 0;
const spend = (date, amount, status = "verified", category_id = "cat-food") => {
  const id = "t" + ++n;
  return { t: { id, date, payee: "Sample Shop", status, source: "manual", created_at: "2026-10-16T09:00:00.000+08:00" }, e: [{ id: id + "a", transaction_id: id, account_id: "w", amount: -amount }, { id: id + "b", transaction_id: id, category_id, amount }] };
};
const build = (list) => ({ ...emptyState(), categories: cats, transactions: list.map((x) => x.t), entries: list.flatMap((x) => x.e) });
const S = () => build([spend("2026-09-30", 1000), spend("2026-10-01", 2500), spend("2026-10-01", 500), spend("2026-10-05", 4000), spend("2026-10-06", 700, "draft"), spend("2026-10-07", 900, "verified", "cat-pay"), spend("2026-10-10", -300)]);

test("daily spending counts verified expenses only, refunds reduce a day", () => {
  const d = dailySpending(S(), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual([...d], [["2026-10-01", 3000], ["2026-10-05", 4000], ["2026-10-10", -300]]);
  assert.equal(firstSpendingDate(S()), "2026-09-30");
});

test("the line adds up to what the month report says", () => {
  const s = S();
  const total = seriesFor(s, { from: "2026-10-01", to: "2026-10-31", step: "week" }).reduce((a, x) => a + x.amount, 0);
  assert.equal(total, monthlySpending(s, { endMonth: "2026-10", months: 1, asOf: "2026-10-31" })[0].amount);
});

test("steps: every day present, weeks Monday to Sunday cut at the window edges, calendar months", () => {
  const days = seriesFor(S(), { from: "2026-10-01", to: "2026-10-10", step: "day" });
  assert.equal(days.length, 10); assert.equal(days[0].amount, 3000); assert.equal(days[1].amount, 0);
  const weeks = seriesFor(S(), { from: "2026-10-01", to: "2026-10-18", step: "week" });
  assert.deepEqual(weeks.map((w) => [w.start, w.end, w.amount]), [["2026-10-01", "2026-10-04", 3000], ["2026-10-05", "2026-10-11", 3700], ["2026-10-12", "2026-10-18", 0]]);
  const months = seriesFor(S(), { from: "2026-09-15", to: "2026-10-20", step: "month" });
  assert.deepEqual(months.map((m) => [m.start, m.end, m.amount]), [["2026-09-15", "2026-09-30", 1000], ["2026-10-01", "2026-10-20", 6700]]);
});

test("the step follows the zoom and the quick ranges end today", () => {
  assert.equal(stepFor("2026-09-10", "2026-10-10"), "day");
  assert.equal(stepFor("2026-04-10", "2026-10-10"), "week");
  assert.equal(stepFor("2024-01-01", "2026-10-10"), "month");
  assert.deepEqual(rangeFor("1M", "2026-10-16"), { from: "2026-09-16", to: "2026-10-16" });
  assert.equal(daysBetween(rangeFor("1Y", "2026-10-16").from, "2026-10-16"), 364);
  assert.deepEqual(rangeFor("All", "2026-10-16", "2025-03-02"), { from: "2025-03-02", to: "2026-10-16" });
  assert.equal(rangeFor("All", "2026-10-16", null).from, "2026-09-16");
});

test("a dragged span says its total, its days and the average a day, whichever way it is dragged", () => {
  const w = seriesFor(S(), { from: "2026-10-01", to: "2026-10-10", step: "day" });
  const m = measureSpan(w, 4, 0);
  assert.deepEqual(m, { from: "2026-10-01", to: "2026-10-05", days: 5, total: 7000, perDay: 1400 });
  assert.deepEqual(measureSpan(w, -3, 99).days, 10);
  assert.equal(measureSpan([], 0, 1), null);
});

test("zooming keeps the point under the fingers, stops at 7 days, never goes past today or before the first entry", () => {
  const lim = { today: "2026-10-16", first: "2026-01-01" };
  const w = { from: "2026-09-01", to: "2026-10-16" };
  const inn = zoomWindow(w, 0.5, 0.5, lim);
  assert.equal(daysBetween(inn.from, inn.to) + 1, 23); assert.ok(inn.from > w.from && inn.to < w.to);
  assert.equal(daysBetween(zoomWindow(w, 0.01, 0.5, lim).from, zoomWindow(w, 0.01, 0.5, lim).to) + 1, 7);
  const out = zoomWindow(w, 10, 1, lim); assert.equal(out.to, "2026-10-16"); assert.equal(out.from, "2026-01-01");
  const mid = zoomWindow(w, 3, 0.5, lim); assert.equal(mid.to, "2026-10-16"); assert.equal(daysBetween(mid.from, mid.to) + 1, 138);   // pushed back from the future
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
});
