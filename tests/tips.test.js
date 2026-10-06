import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUDGET_TIPS, TIPS_NOTE, tipsYours } from "../src/model/index.js";

const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");

test("every budgeting tip is short, names its rule and where it comes from, and the block says rules of thumb, not advice", () => {
  assert.ok(BUDGET_TIPS.length >= 5);
  for (const t of BUDGET_TIPS) { assert.ok(t.rule && t.source && t.text.length < 160 && /\.$/.test(t.text), t.rule); }
  assert.match(TIPS_NOTE, /not advice/);
  const all = BUDGET_TIPS.map((t) => t.text).join(" ");
  for (const fact of ["50% of take-home pay for needs, 30% for wants and 20% for savings", "30% of income", "3 to 6 months", "36% of gross monthly income", "35% of gross monthly income"]) assert.ok(all.includes(fact), fact);
});

test("the starter share's note is said once, in the tips, not under every row; a row keeps only its own reason", () => {
  assert.match(app, /const rowWhy = \(x\) => \(x\.source === "starter" && !x\.pinned \? \(\/Lowered by \.\*\$\/\.exec\(x\.reason\)\?\.\[0\] \?\? ""\) : x\.reason\);/);
  assert.match(app, /\$\{tipsBlock\(r\.history\.used === "starter"\)\}/);
  assert.match(app, /Suggested <b>\$\{x\.suggested === null \? "none" : peso\(x\.suggested\)\}<\/b>/, "the suggested figure is bold");
  assert.match(app, /<p class="note"><i>\$\{esc\(why\)\}<\/i><\/p>/, "a row's note is in italics");
});

test("the starter line states the shares the suggestion really uses: the buffer comes off the top of savings", () => {
  assert.match(app, /M\.starterFromTargets\(ledger\.settings\.bucket_targets, M\.SUGGEST_DEFAULTS\.starter\.buffer\)/);
  assert.match(app, /savings \$\{pc\(t\.savings\)\} and an overrun buffer of \$\{pc\(t\.buffer\)\}/);
});

const c = (id, name, role) => ({ id, name, kind: "expense", ...(role ? { role } : {}) });

test("your own figures beside the tips: needs and wants, rent and all debt as a share of income, the emergency fund in months", () => {
  const cats = [c("r", "Rent"), c("f", "Food"), c("n", "Netflix"), c("u", "Utang"), c("l", "Car loan", "debt"), c("x", "Shabu Kain")];
  const y = tipsYours({ income: 3000000, categories: cats, budgets: { r: 900000, f: 600000, n: 50000, u: 20000, l: 100000, x: 30000 }, ef: { balance: 1700000, monthlyBasis: 1500000 } });
  assert.deepEqual(y, { "50/30/20": "needs 50.0%, wants 1.7%", Rent: "30.0%", "All debt": "4.0%", "Emergency fund": "1.1 months saved" });
});

test("your figures follow your own bucket answers, and only what can be worked out is shown", () => {
  const cats = [c("f", "Food"), c("k", "Kape")];
  assert.deepEqual(tipsYours({ income: 1000000, categories: cats, overrides: { k: "need" }, budgets: { f: 100000, k: 50000 } }), { "50/30/20": "needs 15.0%, wants 0.0%" });
  assert.deepEqual(tipsYours({ income: 0, categories: cats, budgets: { f: 100000 } }), {}, "no income: nothing to compare");
  assert.equal(tipsYours({ income: 1000000, categories: cats, budgets: {}, ef: { balance: 1935000, monthlyBasis: 1500000 } })["Emergency fund"], "1.2 months saved", "1.29 months is shown as 1.2: never rounded up into more than is saved");
  assert.deepEqual(tipsYours({ income: 1000000, categories: cats, budgets: {}, ef: { balance: 5, monthlyBasis: 0 } }), {}, "no budgets and no basis: nothing");
});

test("two Philippine tips with their sources: emergency fund by situation, and where to keep it (PDIC up to P1,000,000 since March 2025)", () => {
  const ph = BUDGET_TIPS.filter((t) => /Philippine|PDIC/.test(t.source));
  assert.ok(ph.some((t) => /3 months single/.test(t.text) && /up to 9/.test(t.text)));
  assert.ok(ph.some((t) => /PDIC/.test(t.text) && /\u20B11,000,000 per depositor per bank since March 2025/.test(t.text) && /not in MP2/.test(t.text)));
  assert.match(app, /Yours: <b>\$\{esc\(yours\[x\.rule\]\)\}<\/b>/);
  assert.equal((app.match(/data-action="use-all-sug"/g) ?? []).length, 2, "Use all suggestions at the top and again beside Confirm");
  assert.match(readFileSync(new URL("../app/index.html", import.meta.url), "utf8"), /\.note \{ font-style: italic; \}/, "notes are in italics everywhere");
});
