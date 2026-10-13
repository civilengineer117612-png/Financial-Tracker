import { test } from "node:test";
import assert from "node:assert/strict";
import { planFormLines, withListedLines, planFormSuggestion, planTextFromForm, newPlanForm, suggestInputs, parsePlan, amountText } from "../src/model/index.js";
import { UNLOGGED_CATEGORY_ID } from "../src/model/seed.js";
import { makeState, account } from "./fixtures.js";

// Invented ledger: pay of 10,000 on the 15th and 20,000 on the last day, six logged months, rent on the 1st. Amounts are whole centavos.
const TS = "2026-01-01T09:00:00.000+08:00", TODAY = "2026-10-05";
let n = 0;
function base() {
  const s = makeState();
  s.accounts = [account({ id: "chk", name: "Test Checking", class: "asset", opening_balance: 100000000 })];
  s.categories = [{ id: "food", name: "Food", kind: "expense", role: "food" }, { id: "rent", name: "Rent", kind: "expense", role: "rent" }, { id: "fun", name: "Fun", kind: "expense" },
    { id: "hid", name: "Hobby", kind: "expense" }, { id: UNLOGGED_CATEGORY_ID, name: "Unlogged", kind: "expense" }, { id: "pay", name: "Pay", kind: "income" }];
  s.payslips = []; s.payslipLines = []; s.subscriptions = []; s.goals = [{ id: "g1", name: "Test Fund", target: 5000000, account_id: null, created_at: TS }];
  return s;
}
function spend(s, date, cat, amount) {
  const id = "t" + ++n;
  s.transactions.push({ id, date, payee: "", memo: "", status: "verified", source: "manual", created_at: TS, verified_at: TS });
  s.entries.push({ transaction_id: id, category_id: cat, amount }, { transaction_id: id, account_id: "chk", amount: -amount });
}
function slip(s, date, deposit) {
  const id = "p" + ++n;
  s.payslips.push({ id, employer: "Test Co", period_from: date, period_to: date, pay_date: date, account_id: "chk", transaction_id: "x" + n, printed_gross: deposit, printed_net: deposit, deposit });
  s.payslipLines.push({ payslip_id: id, side: "earning", kind: "basic", amount: deposit });
}
function history() {
  const s = base();
  for (const m of ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]) {
    slip(s, m + "-15", 1000000); slip(s, m + "-30", 2000000);
    for (let i = 0; i < 12; i++) spend(s, `${m}-${String(2 + i).padStart(2, "0")}`, "food", 50000);
    spend(s, m + "-01", "rent", 800000);
  }
  return s;
}
const form = (o = {}) => ({ ...newPlanForm(TODAY), ...o });

test("the form lists every spending category and goal by name: not Unlogged, not income, not a hidden one", () => {
  const names = planFormLines(history(), ["hid"]).map((l) => l.name);
  assert.deepEqual(names, ["Food", "Rent", "Fun", "Test Fund"]);
  assert.deepEqual(planFormLines(history(), ["hid"]).map((l) => l.kind), ["expense", "expense", "expense", "goal"]);
  assert.ok(planFormLines(history(), [], [{ name: "Overrun buffer", kind: "buffer" }]).some((l) => l.name === "Overrun buffer" && l.kind === "buffer"));
});

test("rebuilding the form keeps the amounts of lines it already had, drops blank lines, and keeps its own lines as custom", () => {
  const old = form({ count: 4, n0: "Rent", k0: "expense", a0: "5000", b0: "0", n1: "", a1: "", b1: "", n2: "Padala", k2: "expense", a2: "100", b2: "200", n3: "", a3: "", b3: "" });
  const f = withListedLines(old, planFormLines(history()));
  assert.equal(f.count, 6, "five listed lines and the one of its own");
  const byName = Object.fromEntries(Array.from({ length: f.count }, (_, i) => [f["n" + i], { a: f["a" + i], b: f["b" + i], custom: f["c" + i] }]));
  assert.deepEqual(byName.Rent, { a: "5000", b: "0", custom: false });
  assert.deepEqual(byName.Food, { a: "", b: "", custom: false });
  assert.deepEqual(byName.Padala, { a: "100", b: "200", custom: true });
  assert.equal(f.start, old.start, "the other fields of the form are untouched");
});

test("the suggestion is built on what each payday really brought in: the payslips of that payday, not a made-up figure", () => {
  const r = planFormSuggestion(history(), form({ p1: "", p2: "" }), { today: TODAY });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pay, [1000000, 2000000], "the pay of each payday is the median of its own payslips");
  assert.deepEqual(r.income, [1000000, 2000000]);
  const total = (k) => Object.values(r.rows).reduce((a, x) => a + x[k], 0);
  assert.ok(total("first") <= 1000000 && total("second") <= 2000000, "nothing placed is more than that payday brings in");
  assert.ok(Object.values(r.rows).every((x) => x.first % 5000 === 0 && x.second % 5000 === 0), "every figure is rounded to the nearest P50, like the Budget suggestion");
  assert.ok(r.rows.rent.second > 0 || r.rows.rent.first > 0, "rent is placed");
  assert.equal(r.rows.rent.first + r.rows.rent.second, 800000, "rent is the median of the logged months, in one piece");
});

test("pay typed in the form replaces the payslip figure for that payday only", () => {
  const r = planFormSuggestion(history(), form({ p1: "12000", p2: "" }), { today: TODAY });
  assert.deepEqual(r.income, [1200000, 2000000]);
  assert.deepEqual(r.pay, [1000000, 2000000], "what the payslips say is still reported");
});

test("a fixed bill is set aside on the payday before its due day: rent paid on the 1st falls on the last-day payday, a schedule due on the 10th too", () => {
  const s = history();
  s.schedules = [{ id: "sc1", kind: "repeating", name: "Test Plan", category_id: "fun", account_id: "chk", start: "2026-01-10", amount: 50000, day: 10, created_at: TS }];
  const r = planFormSuggestion(s, form(), { today: TODAY });
  assert.equal(r.rows.rent.first, 0); assert.equal(r.rows.rent.second, 800000, "rent comes due on the 1st, so the last-day payday carries it");
  assert.ok(r.rows.fun.second >= 50000, "the scheduled payment sits on its category's line, on the last-day payday");
  assert.deepEqual(suggestInputs(s, TODAY).map((x) => [x.name, x.day, x.amount]), [["Test Plan", 10, 50000]]);
});

test("without a payslip and without typed pay there is no suggestion, and it says why", () => {
  const s = history(); s.payslips = []; s.payslipLines = [];
  const r = planFormSuggestion(s, form({ p1: "10000", p2: "" }), { today: TODAY });
  assert.equal(r.ok, false); assert.equal(r.pay, null);
  assert.match(r.message, /payslip/);
  const typed = planFormSuggestion(s, form({ p1: "10000", p2: "20000" }), { today: TODAY });
  assert.equal(typed.ok, true, "typed pay alone is enough");
});

test("bad paydays give a plain message, not a guess", () => {
  assert.equal(planFormSuggestion(history(), form({ d1: "" }), { today: TODAY }).ok, false);
  assert.equal(planFormSuggestion(history(), form({ d2: "10" }), { today: TODAY }).ok, false);
});

test("a plan made from the listed lines and the suggestion is read by the same rules as a typed one", () => {
  const s = history(), sug = planFormSuggestion(s, form({ p1: "", p2: "" }), { today: TODAY });
  let f = withListedLines(form({ p1: amountText(sug.pay[0]), p2: amountText(sug.pay[1]) }), planFormLines(s, [], sug.extras));
  for (let i = 0; i < f.count; i++) { const row = sug.rows[f["n" + i].toLowerCase()]; if (row) { f["a" + i] = amountText(row.first); f["b" + i] = amountText(row.second); } }
  const t = planTextFromForm(f), r = parsePlan(t.text);
  assert.equal(t.ok, true);
  assert.ok(r.error?.includes("add up") || r.ok, "the plan is either exact or says plainly it does not add up to the pay");
  assert.equal(amountText(600000), "6000"); assert.equal(amountText(600050), "6000.50");
});

test("with pay known but no rent and no history, it says to type the rent once, and still reports what each payday brought in", () => {
  const s = history(); s.transactions = []; s.entries = [];   // nothing logged: nothing to learn the rent from
  const r = planFormSuggestion(s, form(), { today: TODAY });
  assert.equal(r.ok, false); assert.match(r.message, /rent/); assert.deepEqual(r.pay, [1000000, 2000000]);
  assert.equal(planFormSuggestion(s, form(), { today: TODAY, settings: { starter_rent: 600000 } }).ok, true, "with the rent typed once on Budget it suggests from common shares of the pay");
});

test("only lines with an amount typed go into the plan: the listed categories you give nothing to are left out", () => {
  const s = history(), f = withListedLines(form({ p1: "10000", p2: "20000" }), planFormLines(s));
  const i = Array.from({ length: f.count }, (_, k) => k).find((k) => f["n" + k] === "Rent");
  f["b" + i] = "20000";
  const plan = JSON.parse(planTextFromForm(f).text);
  assert.deepEqual(plan.lines.map((l) => [l.name, l.first, l.second]), [["Rent", 0, 2000000]]);
});
