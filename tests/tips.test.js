import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUDGET_TIPS, TIPS_NOTE } from "../src/model/index.js";

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
