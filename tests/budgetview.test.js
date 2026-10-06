import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseIncome, shares, tenths, showTenths, incomeChanged, savedRows, suggestBudgets, budgetChangesFromDraft, netsByKind, NO_INCOME_PROMPT, budgetFor, renameCategory, suggestPlan, parsePlan } from "../src/model/index.js";
import { UNLOGGED_CATEGORY_ID } from "../src/model/seed.js";
import { makeState, account } from "./fixtures.js";

// Invented numbers only. Whole centavos: 100000 is 1,000 pesos.
const TS = "2026-01-01T09:00:00.000+08:00", TODAY = "2026-10-05", MONTH = "2026-10";
const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");

function base() {
  const s = makeState();
  s.accounts = [account({ id: "chk", name: "Test Checking", class: "asset", opening_balance: 100000000 })];
  s.categories = [{ id: "food", name: "Food", kind: "expense", role: "food" }, { id: "rent", name: "Rent", kind: "expense", role: "rent" }, { id: "fun", name: "Fun", kind: "expense" },
    { id: UNLOGGED_CATEGORY_ID, name: "Unlogged", kind: "expense" }, { id: "pay", name: "Pay", kind: "income" }];
  s.payslips = []; s.payslipLines = []; s.subscriptions = []; s.goals = []; s.rules = [];
  return s;
}
let n = 0;
function spend(s, date, cat, amount) {
  const id = "t" + ++n;
  s.transactions.push({ id, date, payee: "", memo: "", status: "verified", source: "manual", created_at: TS, verified_at: TS });
  s.entries.push({ transaction_id: id, category_id: cat, amount }, { transaction_id: id, account_id: "chk", amount: -amount });
}
function slip(s, date, deposit, overtime = 0) {
  const id = "p" + ++n;
  s.payslips.push({ id, employer: "Test Co", period_from: date, period_to: date, pay_date: date, account_id: "chk", transaction_id: "x" + n, printed_gross: deposit, printed_net: deposit, deposit });
  s.payslipLines.push({ payslip_id: id, side: "earning", kind: "basic", amount: deposit - overtime });
  if (overtime) s.payslipLines.push({ payslip_id: id, side: "earning", kind: "overtime", amount: overtime });
}
function logMonth(s, month, { food = 600000, rent = 800000, fun = 300000 } = {}) {
  for (let i = 0; i < 12; i++) spend(s, `${month}-${String(2 + i).padStart(2, "0")}`, "food", food / 12);
  spend(s, `${month}-01`, "rent", rent);
  for (let i = 0; i < 3; i++) spend(s, `${month}-20`, "fun", fun / 3);
}
const M6 = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
// Monthly pay: one payslip a month on the 30th (2,500 pesos... in centavos 2,500,000 is 25,000 pesos)
function monthly(extra) { const s = base(); for (const m of M6) { slip(s, m + "-28", 2500000); logMonth(s, m); } extra?.(s); return s; }
function twice() { const s = base(); for (const m of M6) { slip(s, m + "-15", 1000000); slip(s, m + "-30", 2000000); logMonth(s, m); } return s; }
const sug = (s, o = {}) => suggestBudgets({ state: s, today: TODAY, month: MONTH, ...o });

test("the new Budget is behind a switch that is off by default, and off it is exactly the old screen (a before/after on the code itself)", () => {
  assert.match(app, /function viewBudget\(\) \{ return ledger\.settings\.try_new_budget \? viewBudgetNew\(\) : viewBudgetOld\(\); \}/);
  const old = app.slice(app.indexOf("function viewBudgetOld() {")).split("\n}\n")[0] + "\n}\n";
  assert.equal(old, readFileSync(new URL("./golden/old-viewbudget.txt", import.meta.url), "utf8"), "the old screen is byte for byte what it was before this change");
  assert.ok(!/try_new_budget/.test(readFileSync(new URL("../src/model/seed.js", import.meta.url), "utf8")), "no setting is switched on by default");
  assert.match(app, /case "toggle-new-budget": await commit\(S\(\), \{ \.\.\.ledger\.settings, try_new_budget: !ledger\.settings\.try_new_budget \}\)/);
});

test("the summary: Spending and Saved are plainly rounded to a tenth of a percent, Unallocated is in pesos (centavos), and nothing forces the shares to add to 100.0%", () => {
  assert.deepEqual(shares(2500000, 1000000, 500000), { spending: 400, saved: 200, buffer: 0, unallocated: 1000000 });
  assert.equal(showTenths(400), "40.0%");
  assert.equal(tenths(1000000, 2500000), 400); assert.equal(tenths(1, 3), 333); assert.equal(tenths(2, 3), 667, "rounded to the nearest tenth");
  // 79.96% and 19.96% are shown as 80.0% and 20.0%, the unallocated 0.08% is a few pesos: the three are not made to add up
  const s = shares(10000000, 7996000, 1996000);
  assert.deepEqual([s.spending, s.saved, s.unallocated], [800, 200, 8000 * 1], "80.0%, 20.0% and 80.00 pesos left");
  assert.equal(tenths(799, 1000) + tenths(199, 1000), 998 + 0, "each row is its own rounding");
  const o = shares(1000000, 700000, 500000);
  assert.equal(o.unallocated, -200000, "over the income is a negative amount, never hidden");
  for (const [inc, a, b] of [[1000003, 333333, 166667], [7, 3, 3], [999999, 1, 2], [1000000, 0, 0]]) assert.equal(shares(inc, a, b).unallocated, inc - a - b, `exact centavos for ${inc}`);
  assert.equal(shares(1000000, 333333, 333333).spending, 333, "33.3333% is 33.3%");
});

test("overtime does not change the income basis, and the base is the median of the last 3 nets", () => {
  const a = base(), b = base();
  for (const [d, v, ot] of [["2026-06-28", 2400000, 0], ["2026-07-28", 2500000, 0], ["2026-08-28", 2600000, 0], ["2026-09-28", 2500000, 0]]) { slip(a, d, v); slip(b, d, v + 900000, 900000); }
  const x = baseIncome(a), y = baseIncome(b);
  assert.equal(x.amount, 2500000); assert.equal(y.amount, x.amount, "900,000 of overtime on every payslip changes nothing");
  assert.equal(x.text, "From your last 3 payslips"); assert.equal(x.source, "payslips");
  const old = base(); slip(old, "2026-06-28", 100000); slip(old, "2026-07-28", 2800000); slip(old, "2026-08-28", 2000000); slip(old, "2026-09-28", 2200000);
  assert.equal(baseIncome(old).amount, 2200000, "only the last 3 count (2.8M, 2.0M, 2.2M): the small old payslip is left out");
  const two = base(); slip(two, "2026-08-28", 2000000); slip(two, "2026-09-28", 2400000);
  assert.equal(baseIncome(two).amount, 2000000, "with two, the lower: never plan on more pay than usually arrives");
  const wobble = base(); slip(wobble, "2026-07-28", 2500000); slip(wobble, "2026-08-30", 2500000); slip(wobble, "2026-09-31".replace("31", "30"), 2500000);
  assert.equal(netsByKind(wobble.payslips.map((p) => ({ date: p.pay_date, base: p.deposit }))).length, 1, "pay dates a few days apart are still one monthly payday");
  assert.equal(baseIncome(wobble).amount, 2500000);
});

test("the owner's figure wins, then a loaded plan's expected income (and says so), then payslips; with none, the prompt", () => {
  const s = monthly();
  assert.deepEqual(baseIncome(s, { pin: 3000000 }), { amount: 3000000, source: "pinned", text: "Your own figure" });
  const plan = parsePlan(JSON.stringify({ schema_version: 1, unit: "PHP_whole_pesos", effective_from: "2026-10-01", paydays: [{ day: 15, expected_income: 1000 }, { day: "last", expected_income: 2000 }],
    lines: [{ name: "Food", kind: "expense", first: 1000, second: 2000 }] })).plan;
  const p = baseIncome(s, { plan });
  assert.equal(p.amount, 300000); assert.equal(p.source, "plan"); assert.match(p.text, /pay plan/);
  assert.equal(baseIncome(s, { plan, pin: 3000000 }).source, "pinned");
  const none = baseIncome(base());
  assert.equal(none.amount, null); assert.equal(none.text, "Add a payslip or your pay to get a suggested budget."); assert.equal(NO_INCOME_PROMPT, none.text);
  const r = sug(base());
  assert.equal(r.ok, false); assert.equal(r.message, NO_INCOME_PROMPT);
  assert.equal(baseIncome(base(), { pin: 1500000 }).amount, 1500000, "a typed figure is enough, even with no payslip");
});

test("a once-a-month income works: one payday kind, the median of 3, and a suggestion for the month", () => {
  const s = monthly();
  assert.equal(netsByKind(suggestPlanSlips(s)).length, 1);
  assert.equal(baseIncome(s).amount, 2500000);
  const r = sug(s);
  assert.equal(r.ok, true); assert.equal(r.income.amount, 2500000);
  const food = r.rows.find((x) => x.category_id === "food");
  assert.equal(food.suggested, 600000); assert.match(food.reason, /Median of the last 6 usable months/);
  assert.equal(r.rows.find((x) => x.category_id === "rent").suggested, 800000);
  assert.equal(r.history.used, "history");
  const total = r.rows.reduce((a, x) => a + x.amount, 0) + r.saved.reduce((a, x) => a + x.amount, 0) + r.unallocated - r.short;
  assert.equal(total, 2500000, "spending + saved + unallocated is the whole income");
});
function suggestPlanSlips(s) { return s.payslips.map((p) => ({ date: p.pay_date, base: p.deposit })); }

test("two paydays a month: the base income is the sum of each kind's median", () => {
  const s = twice();
  assert.equal(netsByKind(suggestPlanSlips(s)).length, 2);
  assert.equal(baseIncome(s).amount, 3000000);
  assert.equal(sug(s).ok, true);
});

test("with no usable history the suggestion is starter shares and says so; a plan-less ledger still gets Saved rows, labelled not saved", () => {
  const s = base(); slip(s, "2026-09-28", 2500000); logMonth(s, "2026-09");
  const r = sug(s, { rent: 800000 });
  assert.equal(r.ok, true); assert.equal(r.history.used, "starter");
  assert.ok(r.rows.some((x) => x.source === "starter" && /rule of thumb/.test(x.reason)));
  const rows = savedRows({ plan: null, suggestion: r });
  assert.ok(rows.length >= 1 && rows.every((x) => x.label === "Suggested, not saved"));
  assert.ok(rows.some((x) => x.kind === "buffer"));
});

test("with a plan loaded the Saved rows are the plan's goal and buffer lines, monthly, labelled from the plan", () => {
  const plan = { lines: [{ name: "Food", kind: "expense", first: 100, second: 100 }, { name: "Cushion", kind: "goal", first: 40000, second: 60000 }, { name: "Spare", kind: "buffer", first: 1000, second: 1000 }] };
  const rows = savedRows({ plan, suggestion: null });
  assert.deepEqual(rows.map((r) => [r.name, r.amount, r.label]), [["Cushion", 100000, "From your plan"], ["Spare", 2000, "From your plan"]]);
});

test("a pinned line survives a re-suggest: it stays the owner's figure and the suggestion is kept beside it", () => {
  const s = monthly();
  const free = sug(s), pinned = sug(s, { pins: { food: 123400 } });
  const f = pinned.rows.find((x) => x.category_id === "food"), g = free.rows.find((x) => x.category_id === "food");
  assert.equal(f.pinned, true); assert.equal(f.amount, 123400); assert.equal(f.suggested, g.suggested, "the engine's own figure is still shown as the suggestion");
  assert.equal(sug(s, { pins: { food: 123400 } }).rows.find((x) => x.category_id === "food").amount, 123400, "and again");
  assert.equal(pinned.rows.find((x) => x.category_id === "rent").pinned, false);
  const ignored = sug(s, { pins: { nope: 5 } });
  assert.equal(ignored.ok, true, "a pin on a category that is gone is ignored");
});

test("a category rename does not break the suggestion: lines and pins follow the id, never the name", () => {
  const s = monthly();
  const renamed = renameCategory(s, "food", "Groceries");
  assert.equal(renamed.ok, true);
  const r = sug(renamed.state, { pins: { food: 55500 } });
  const f = r.rows.find((x) => x.category_id === "food");
  assert.equal(f.name, "Groceries"); assert.equal(f.amount, 55500); assert.equal(f.pinned, true);
  const free = sug(renamed.state);
  assert.equal(free.rows.find((x) => x.category_id === "food").suggested, 600000, "the history is still found");
  // the engine itself: a line carries its category id, and a pin by id works even when the pinned name is something else
  const e = suggestPlan({ state: renamed.state, paydays: [{ day: 1 }], income: [2500000], today: TODAY, month: MONTH, pinned: [{ category_id: "food", name: "anything", first: 1000, second: 0 }] });
  const line = e.paydays[0].lines.find((l) => l.category_id === "food");
  assert.deepEqual([line.name, line.amount, line.pinned], ["Groceries", 1000, true]);
});

test("every spending category gets a row (even one with nothing to suggest), and the Unlogged category never does", () => {
  const r = sug(monthly());
  assert.deepEqual(r.rows.map((x) => x.category_id).sort(), ["food", "fun", "rent"]);
  const none = base(); slip(none, "2026-09-28", 2500000); for (const m of M6) logMonth(none, m, { fun: 0 });
  assert.equal(sug(none).rows.find((x) => x.category_id === "fun").suggested, 0);
});

test("confirming saves ordinary append-only budget rules once per changed category, never edits history, and starts next month by default", () => {
  const s = monthly();
  s.rules = [{ id: "r0", kind: "budget", subject_id: "food", amount: 500000, effective_from: "2026-01-01", created_at: TS }];
  const before = JSON.stringify(s.rules);
  let k = 0;
  const r = budgetChangesFromDraft(s, { food: 600000, rent: 800000, fun: 0 }, { start: "2026-11", newId: () => "new" + ++k });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes.map((c) => [c.category_id, c.from, c.to]), [["food", 500000, 600000], ["rent", null, 800000]], "fun stays without a budget: 0 against none is no change");
  assert.equal(JSON.stringify(r.state.rules[0]), JSON.stringify(s.rules[0]), "the old row is untouched"); assert.equal(JSON.stringify(s.rules), before);
  assert.equal(r.state.rules.length, 3); assert.equal(s.rules.length, 1, "the input is not changed");
  assert.equal(budgetFor(r.state.rules, "food", "2026-10"), 500000, "this month is untouched when it starts next month");
  assert.equal(budgetFor(r.state.rules, "food", "2026-11"), 600000);
  assert.equal(r.state.rules[1].effective_from, "2026-11-01");
  const none = budgetChangesFromDraft(s, { food: 500000 }, { start: "2026-11", newId: () => "x" });
  assert.deepEqual(none.changes, []);
  assert.equal(budgetChangesFromDraft(s, { food: 100.5 }, { start: "2026-11", newId: () => "x" }).ok, false, "a float is refused, never rounded");
  assert.equal(budgetChangesFromDraft(s, { nope: 5 }, { start: "2026-11", newId: () => "x" }).ok, false, "an unknown category is refused and nothing is saved");
  assert.match(app, /start: M\.addMonths\(M\.monthOf\(today\(\)\), 1\), used: \{\}/, "the screen opens with next month chosen");
});

test("Income changed: review shows only when the income at the last confirm differs, and it is only a note", () => {
  assert.equal(incomeChanged(2500000, 2500000), false); assert.equal(incomeChanged(2500000, 2600000), true);
  assert.equal(incomeChanged(null, 2600000), false, "nothing confirmed yet, nothing to review"); assert.equal(incomeChanged(2500000, null), false);
  assert.match(app, /Income changed: review\./); assert.ok(!/Income changed: review[^`]*disabled/.test(app));
});

test("Saved rows are never red: the block carries no critical shape or colour, and only a strictly-over spending row gets one", () => {
  const block = app.slice(app.indexOf("const savedHtml ="), app.indexOf("let sum = \"\";"));
  assert.ok(block.length > 100 && !/critical|overnote|glyph/.test(block));
  const spendRow = app.slice(app.indexOf("const spendRows ="), app.indexOf("const savedHtml ="));
  assert.match(spendRow, /const over = r\.st\?\.over && r\.now !== null;/);
  assert.match(spendRow, /\$\{over \? `<small class="overnote">\$\{glyph\("critical"\)\} Over budget by/);
});

test("the new screen adds only the amount and the share to a row, one totals line per block, one overall line and one extra figure", () => {
  const view = app.slice(app.indexOf("function viewBudgetNew()"), app.indexOf("function viewBudgetOld()"));
  for (const id of ["bud-income", "bud-shares", "bud-spent", "bud-spend-total", "bud-saved-total"]) assert.ok(view.includes(`id="${id}"`), id);
  assert.match(view, /Spending \$\{M\.showTenths\(sh\.spending\)\}, Saved \$\{M\.showTenths\(sh\.saved\)\}, \$\{bufferTotal \? "Buffer " \+ M\.showTenths\(sh\.buffer\) \+ ", " : ""\}\$\{sh\.unallocated < 0 \? "Over income by " \+ peso\(-sh\.unallocated\) : "Unallocated " \+ peso\(sh\.unallocated\)\}/);
  assert.match(view, /Spent so far: \$\{M\.showTenths/);
  assert.ok(view.indexOf("<h2>Spending</h2>") < view.indexOf("<h2>Saved and set aside</h2>"), "Spending first, then Saved and set aside");
});

test("no data version bump is needed: the new settings keys are additive, a ledger with or without them loads and passes the self-check", async () => {
  const { parseLedger, selfCheck, LEDGER_VERSION, upgradeLedger } = await import("../src/model/index.js");
  const s = monthly();
  const plain = { v: LEDGER_VERSION, rev: 1, saved_at: TS, state: Object.fromEntries(Object.entries(s).filter(([, v]) => Array.isArray(v))), settings: {} };
  const keyed = { ...plain, settings: { try_new_budget: true, income_base_pin: 2500000, budget_pins: { food: 600000 }, budget_income_seen: 2500000 } };
  for (const l of [plain, keyed]) { assert.equal(parseLedger(JSON.stringify(l)).ok, true); assert.deepEqual(selfCheck(l), []); }
  const r = upgradeLedger({ ...plain, v: LEDGER_VERSION - 1, settings: { notice_seen_at: TS } });
  assert.equal(r.ok, true); assert.equal(r.ledger.settings.try_new_budget, undefined, "an upgraded ledger never gets the switch turned on");
});

test("the new Budget's amounts line up: the share sits under the amount, the totals lines and the overall line use the same numbers, and the bar has a colour", () => {
  const view = app.slice(app.indexOf("function viewBudgetNew()"), app.indexOf("function viewBudgetOld()"));
  assert.match(view, /const share = \(amount\) => \(income \? `<small>\$\{M\.showTenths\(M\.tenths\(amount, income\)\)\} of income<\/small>` : ""\)/);
  assert.ok(!/ \\u00b7 \$\{M\.showTenths\(M\.tenths/.test(view), "no share is glued to the amount on one long line");
  assert.match(view, /M\.showTenths\(sh\.spending\) \+ " of income"/); assert.match(view, /M\.showTenths\(sh\.saved\) \+ " of income"/);
  assert.match(view, /"Over income by " \+ peso\(-sh\.unallocated\) : "Unallocated " \+ peso\(sh\.unallocated\)/, "Unallocated is shown in pesos");
  assert.match(view, /<div class="meter goal"/);
  const css = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(css, /\.row \.amt \{[^}]*text-align: right/); assert.match(css, /\.choice \.bval \{ text-align: right; \}/); assert.match(css, /\.meter\.goal \.fill \{ background: var\(--chart\)/);
});

// ----- rounding to the nearest 50 pesos, and how saving is worked out -----
import { toNearest50, savingsExplained, SUGGEST_DEFAULTS as DEFAULTS } from "../src/model/index.js";
test("suggestions are rounded to the nearest 50 pesos, halves up; a typed (pinned) figure is kept exactly", () => {
  assert.equal(toNearest50(12600), 15000, "126 becomes 150"); assert.equal(toNearest50(12400), 10000, "124 becomes 100"); assert.equal(toNearest50(12500), 15000, "125 goes up");
  assert.equal(toNearest50(0), 0); assert.equal(toNearest50(2499), 0); assert.equal(toNearest50(521548), 520000, "5,215.48 becomes 5,200"); assert.equal(toNearest50(325967), 325000);
  const s = base(); slip(s, "2026-09-28", 3277737); logMonth(s, "2026-09");
  const r = sug(s, { rent: 335000, pins: { fun: 123456 } });
  for (const x of r.rows.filter((y) => !y.pinned)) { assert.equal(x.suggested % 5000, 0, x.name + " suggested is a multiple of 50 pesos"); assert.equal(x.amount, x.suggested); }
  for (const x of r.saved) assert.equal(x.amount % 5000, 0, x.name);
  const fun = r.rows.find((x) => x.category_id === "fun");
  assert.equal(fun.amount, 123456, "the owner's own figure is not rounded"); assert.equal(fun.suggested % 5000, 0, "but the suggestion shown beside it is");
});
test("how saving is worked out is said in plain words, from the settings actually in use", () => {
  const d = savingsExplained(DEFAULTS);
  assert.match(d[0], /Overrun buffer: 5% of your pay/); assert.match(d[1], /no more than 15% of your pay\./); assert.ok(!/floor/.test(d[1]), "no floor, no floor sentence");
  assert.match(d[2], /finish date gets what it needs/); assert.match(d[3], /rounded to the nearest ₱50/); assert.match(d[3], /not advice/);
  const c = savingsExplained({ ...DEFAULTS, starter: { ...DEFAULTS.starter, savings: 2000, buffer: 300 }, savings_floor: 100000, buffer_amount: null });
  assert.match(c[0], /3% of your pay/); assert.match(c[1], /no more than 20% of your pay and never less than your savings floor/);
  assert.equal(savingsExplained({ ...DEFAULTS, buffer_amount: 50000 })[0], "Overrun buffer: the amount set for it.");
  const view = app.slice(app.indexOf("function viewBudgetNew()"), app.indexOf("function viewBudgetOld()"));
  assert.match(view, /How saving is worked out/); assert.match(view, /M\.savingsExplained\(/);
});
test("the Budget screen's Saved block uses the same suggestion as the sheet, so the rent you typed counts there too", () => {
  const view = app.slice(app.indexOf("function viewBudgetNew()"), app.indexOf("function viewBudgetOld()"));
  assert.match(view, /const sug = income && !plan \? runSuggest\(\) : null;/);
  assert.match(app, /const runSuggest = \(\) => \{[^\n]*rent: set\.starter_rent \?\? undefined/);
  const s = base(); slip(s, "2026-09-28", 2500000); logMonth(s, "2026-09");
  assert.equal(sug(s).code, "NEEDS_RENT"); assert.ok(sug(s, { rent: 300000 }).saved.length >= 1, "with the rent, the saved rows are there");
});

// ----- rounding must never cause "Short" -----
import { fitToIncome } from "../src/model/index.js";
const roles = new Map([["rent", "rent"], ["food", "food"], ["ess", "essentials"], ["fun", "fun-not-a-role"]]);
const row = (id, name, amount, pinned = false) => ({ category_id: id, name, amount, suggested: amount, pinned, reason: "R." });
const total = (f, others = [], saved = []) => f.rows.reduce((n, r) => n + r.amount, 0) + others.reduce((n, o) => n + o.amount, 0) + saved.reduce((n, o) => n + o.amount, 0);

test("when rounding up pushes the total past income, the excess comes off the largest want in 50-peso steps, and what is left is Unallocated", () => {
  // income 10,000.00; rent 4,000, food 3,000, fun 2,000, shopping 1,000, saved 100 = 10,100 after rounding: 100.00 too much
  const rows = [row("rent", "Rent", 400000), row("food", "Food", 300000), row("fun", "Fun", 200000), row("shop", "Shopping", 100000)];
  const f = fitToIncome({ rows, saved: [{ amount: 10000 }], income: 1000000, roles });
  assert.equal(f.rows.find((r) => r.category_id === "fun").amount, 190000, "Fun is the largest want: 100 pesos off, in two 50-peso steps");
  assert.deepEqual(f.rows.filter((r) => r.category_id !== "fun").map((r) => r.amount), [400000, 300000, 100000], "nothing else is touched");
  assert.deepEqual(f.trimmed, [{ category_id: "fun", name: "Fun", by: 10000 }]);
  assert.equal(f.short, 0); assert.equal(f.unallocated, 0);
  assert.equal(f.rows.find((r) => r.category_id === "fun").suggested, 190000, '"Use this" would use the lowered figure');
  assert.match(f.rows.find((r) => r.category_id === "fun").reason, /Lowered by ₱100\.00 so the total fits your income\./);
  // an excess of 30 pesos still takes a whole 50, and the 20 left over shows as Unallocated
  const g = fitToIncome({ rows, saved: [{ amount: 3000 }], income: 1000000, roles: new Map(roles) });
  assert.equal(g.rows.find((r) => r.category_id === "fun").amount, 195000); assert.equal(g.unallocated, 2000); assert.equal(g.short, 0);
  // already fitting: nothing is changed
  const h = fitToIncome({ rows, income: 1100000, roles }); assert.deepEqual(h.rows, rows); assert.deepEqual(h.trimmed, []); assert.equal(h.unallocated, 100000);
});

test("a pinned line is never touched, nor the rent, nor a saved line, nor a fixed payment", () => {
  const rows = [row("rent", "Rent", 500000), row("fun", "Fun", 400000, true), row("shop", "Shopping", 100000)];
  const f = fitToIncome({ rows, others: [{ amount: 50000 }], saved: [{ amount: 100000 }], income: 1100000, roles });
  // total 1,150,000: 500 pesos too much; Fun is the biggest want but typed, so Shopping (1,000) gives
  assert.equal(f.rows.find((r) => r.category_id === "fun").amount, 400000); assert.equal(f.rows.find((r) => r.category_id === "rent").amount, 500000);
  assert.equal(f.rows.find((r) => r.category_id === "shop").amount, 50000, "the excess of 500 pesos came off Shopping");
  assert.equal(f.short, 0);
  // the owner's own figures alone are more than the income: that, and only that, is Short, and nothing is cut to hide it
  const over = fitToIncome({ rows: [row("rent", "Rent", 700000), row("fun", "Fun", 600000, true)], saved: [{ amount: 100000 }], income: 1000000, roles });
  assert.equal(over.short, 400000); assert.equal(over.unallocated, -400000); assert.deepEqual(over.trimmed, []); assert.deepEqual(over.rows.map((r) => r.amount), [700000, 600000]);
});

test("with no want line the excess comes off the largest unpinned spending line, and a want is always preferred to a need", () => {
  const needsOnly = [row("rent", "Rent", 300000), row("food", "Food", 400000), row("ess", "Essentials", 250000)];
  const f = fitToIncome({ rows: needsOnly, income: 940000, roles });
  assert.equal(f.rows.find((r) => r.category_id === "food").amount, 390000, "Food is the largest unpinned line: 100 pesos off"); assert.equal(f.rows.find((r) => r.category_id === "rent").amount, 300000);
  assert.equal(f.short, 0);
  const both = fitToIncome({ rows: [row("food", "Food", 900000), row("fun", "Fun", 200000)], income: 1050000, roles });
  assert.equal(both.rows.find((r) => r.category_id === "fun").amount, 150000, "Fun is a want, so it gives even though Food is bigger"); assert.equal(both.rows.find((r) => r.category_id === "food").amount, 900000);
  // wants run out: the rest comes off the largest need, never the rent
  const run = fitToIncome({ rows: [row("rent", "Rent", 500000), row("food", "Food", 400000), row("fun", "Fun", 50000)], income: 800000, roles });
  assert.equal(run.rows.find((r) => r.category_id === "fun").amount, 0); assert.equal(run.rows.find((r) => r.category_id === "food").amount, 300000, "50 from Fun, the other 100 from Food"); assert.equal(run.rows.find((r) => r.category_id === "rent").amount, 500000);
  assert.equal(run.short, 0); assert.equal(total(run), 800000);
  // rent plus fixed payments more than income, nothing else to cut: Short, and the rent is not touched
  const rentOnly = fitToIncome({ rows: [row("rent", "Rent", 900000)], others: [{ amount: 300000 }], income: 1000000, roles });
  assert.equal(rentOnly.short, 200000); assert.equal(rentOnly.rows[0].amount, 900000);
});

test("end to end: suggestions that round up past the income are brought back under it, so Short never comes from rounding", () => {
  // a ledger whose six spending lines all round UP: income is just above the exact total
  let found = 0;
  for (let income = 3000100; income < 3000100 + 50000 && found < 3; income += 997) {
    const s = base(); s.categories.push({ id: "shop", name: "Shopping", kind: "expense" }, { id: "tr", name: "Transpo", kind: "expense", role: "transport" }, { id: "hl", name: "Health", kind: "expense", role: "health" }, { id: "ess", name: "Essentials", kind: "expense", role: "essentials" });
    slip(s, "2026-09-28", income);
    const r = sug(s, { rent: 333333 });
    assert.equal(r.ok, true);
    const t = r.rows.reduce((a, x) => a + x.amount, 0) + r.others.reduce((a, x) => a + x.amount, 0) + r.saved.reduce((a, x) => a + x.amount, 0);
    assert.ok(t <= income, `total ${t} is within income ${income}`); assert.equal(r.short, 0); assert.equal(r.unallocated, income - t);
    for (const x of r.rows.filter((y) => !y.pinned)) assert.equal(x.amount % 5000, 0, "still multiples of 50 pesos");
    if (r.trimmed.length) found++;
  }
  assert.ok(found >= 1, "at least one of these incomes needed the fix");
});

test("the Suggest sheet says what was lowered and what is left unallocated, in pesos", () => {
  assert.match(app, /Left unallocated if you use all of them: \$\{peso\(r\.unallocated\)\}\./);
  assert.match(app, /Rounding would have gone over your income, so/);
  assert.match(app, /more than your income\./);
});
