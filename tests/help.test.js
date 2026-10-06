import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MENU_GROUPS, SCREEN_NAMES } from "../src/model/names.js";
import { QUICK_NOTES, FIRST_RUN_NOTICE, TOPICS, checklist } from "../src/model/help.js";

const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");

test("the five quick notes are there, in the owner's words", () => {
  assert.equal(QUICK_NOTES.length, 5);
  assert.match(QUICK_NOTES[0], /still being built/);
  assert.match(QUICK_NOTES[1], /only on your phone/);
  assert.match(QUICK_NOTES[2], /Setup, then Backup/); assert.match(QUICK_NOTES[2], /passphrase/); assert.match(QUICK_NOTES[2], /can't be opened/); assert.match(QUICK_NOTES[2], /keep it in Passwords on your phone/);
  assert.match(QUICK_NOTES[3], /Home Screen icon, not a Safari tab/);
  assert.match(QUICK_NOTES[4], /screenshot/); assert.match(QUICK_NOTES[4], /Never send your backup file/);
});

test("every screen in the menu, and the bottom bar, has a help topic (so adding a screen means writing its help)", () => {
  assert.match(app, /const MENU = M\.MENU_GROUPS\.map/, "the menu is built from the shared names");
  const screens = MENU_GROUPS.flatMap(([, ids]) => ids);
  assert.ok(screens.length >= 10, "found the menu screens: " + screens.join());
  const have = new Set(TOPICS.map((t) => t.tab));
  for (const id of [...screens, "setup", "log", "verify", "income"]) assert.ok(have.has(id), "a help topic for " + id);
  for (const t of TOPICS) { assert.ok(t.label && t.lines.length >= 1 && t.lines.every((l) => l.length < 260), t.tab + " is short and has words"); }
  assert.equal(new Set(TOPICS.map((t) => t.tab)).size, TOPICS.length, "no screen twice");
});

test("every topic opens a screen the app really has", () => {
  const known = new Set([...app.matchAll(/ui\.tab === "([a-z]+)"/g)].map((m) => m[1]));
  for (const t of TOPICS) assert.ok(known.has(t.tab) || t.tab === "log", t.tab + " is a screen in app.js");
});

test("the getting-started steps tick themselves from the data", () => {
  const empty = checklist({ accounts: [], transactions: [] }, {});
  assert.deepEqual(empty.map((s) => s.done), [false, false, false]);
  const some = checklist({ accounts: [{ id: "a" }], transactions: [{ id: "t" }] }, { last_backup_at: "2026-10-05T09:00:00.000+08:00" });
  assert.deepEqual(some.map((s) => s.done), [true, true, true]);
  assert.deepEqual(checklist({ accounts: [{ id: "a" }], transactions: [] }, {}).map((s) => s.done), [true, false, false]);
});

test("the first-run notice says the five plain things: data stays here, nothing recovers a lost phone or passphrase, back up now, iPhone Home Screen, Android site data", () => {
  const all = FIRST_RUN_NOTICE.lines.join(" ");
  assert.equal(FIRST_RUN_NOTICE.lines.length, 5);
  assert.match(FIRST_RUN_NOTICE.lines[0], /stays on this phone/);
  assert.match(FIRST_RUN_NOTICE.lines[1], /lost phone/); assert.match(FIRST_RUN_NOTICE.lines[1], /forgotten backup passphrase/); assert.match(FIRST_RUN_NOTICE.lines[1], /cannot be recovered/);
  assert.match(FIRST_RUN_NOTICE.lines[2], /backup now/);
  assert.match(FIRST_RUN_NOTICE.lines[3], /^iPhone: add this app to the Home Screen first/);
  assert.match(FIRST_RUN_NOTICE.lines[4], /^Android: clearing the browser's site data erases the ledger/);
  assert.ok(all.length < 520, "short enough to read at a glance");
});

test("Help words never name an owner-specific goal or category, and the goals topic speaks of roles", () => {
  const words = TOPICS.flatMap((t) => t.lines).join(" ") + QUICK_NOTES.join(" ") + FIRST_RUN_NOTICE.lines.join(" ");
  for (const owner of ["Mole", "Lakat", "Upskill"]) assert.ok(!words.includes(owner), owner);
  assert.match(TOPICS.find((t) => t.tab === "goals").lines.join(" "), /Choose which goal is your emergency fund/);
});

test("Pay plan words: the label, the empty state, the line under the title and the Help topic, exactly as the owner wrote them", () => {
  const EMPTY = "Your plan for each payday: how much goes to rent, daily spending and savings. You can skip it. Budget works without it.";
  const LINE = "This divides each payday. Budget sets your limit per category for the month.";
  assert.equal(SCREEN_NAMES.plan, "Pay plan (optional)");
  assert.ok(app.includes(`<p class="note">${EMPTY}</p>`) || app.includes(EMPTY), "the empty state");
  assert.ok(app.includes(`<h1>Pay plan</h1><p class="sub">${LINE}</p>`), "the line sits right under the title when a plan exists");
  const t = TOPICS.find((x) => x.tab === "plan");
  assert.equal(t.label, "Pay plan (optional)");
  assert.deepEqual(t.lines, [EMPTY, LINE, "With the new Budget switched on (Setup), the plan lives in Budget, under By payday."]);
  assert.ok(MENU_GROUPS.some(([, ids]) => ids.includes("plan")), "it is still a menu screen, and so still needs (and has) its Help topic");
});

test("loading and viewing a plan does not change it: an invented plan file parses to the same plan, the same totals and the same cutoff progress as before the words changed", async () => {
  const { parsePlan, addPlan, planInEffect, planTotals } = await import("../src/model/index.js");
  const file = { schema_version: 1, unit: "PHP_whole_pesos", effective_from: "2026-10-01", paydays: [{ day: 15, expected_income: 1000 }, { day: "last", expected_income: 2400 }],
    lines: [{ name: "Food", kind: "expense", first: 600, second: 600 }, { name: "Rent", kind: "expense", first: 0, second: 500 }, { name: "Savings", kind: "goal", first: 400, second: 1300 }] };
  const r = parsePlan(JSON.stringify(file));
  assert.equal(r.ok, true);
  const before = JSON.stringify(r.plan);
  const stored = addPlan([], r.plan).plans;
  assert.equal(JSON.stringify(planInEffect(stored, "2026-10-20")), before);
  assert.deepEqual(planTotals(r.plan), { first: 100000, second: 240000, month: 340000 });
  assert.deepEqual(r.plan.paydays.map((p) => p.income), [100000, 240000]);
});

test("Stage C: the Pay plan menu entry is hidden only when the new Budget is on; the screen, its Help topic and every other entry stay", async () => {
  const { menuHidden, MENU_GROUPS } = await import("../src/model/index.js");
  assert.equal(menuHidden({}).size, 0); assert.equal(menuHidden(undefined).size, 0); assert.equal(menuHidden({ try_new_budget: false }).size, 0, "off: nothing is hidden");
  assert.deepEqual([...menuHidden({ try_new_budget: true })], ["plan"]);
  assert.ok(MENU_GROUPS.some(([, ids]) => ids.includes("plan")), "the entry is still part of the menu list, so Help keeps its topic");
  assert.match(app, /items\.filter\(\(\[id\]\) => !hidden\.has\(id\)\)/); assert.match(app, /const hidden = M\.menuHidden\(ledger\.settings\)/);
  assert.match(app, /data-tab="\$\{ledger\.settings\.try_new_budget \? "budget" : "plan"\}"/, "Setup points at Budget when the new Budget is on");
  assert.ok(app.includes('ui.tab === "plan" ? viewPlan()'), "the old Pay plan screen is still routed for one more release");
});

test("there is no way to load a plan file in the app: no button anywhere, and no By payday or Setup section when there is no plan", () => {
  assert.ok(!/data-action="open-plan"/.test(app), "no Load a plan / Load a newer plan button is drawn");
  assert.ok(!/Load a plan|Load a newer plan|Load a pay plan \(Menu/.test(app.replace(/<h3>Load a pay plan<\/h3>/, "")), "no words offer it");
  const view = app.slice(app.indexOf("function byPaydaySection()"), app.indexOf("function viewBudgetOld()"));
  assert.match(view, /if \(!plan\) return "";/, "By payday is not shown without a plan");
  assert.match(app, /\$\{planOf\(\) \? `<h2>Pay plan<\/h2>/, "Setup's Pay plan section only appears when a plan exists");
  assert.match(app, /worked out from your budgets: 3 months of your rent, food and essentials/, "the emergency fund hint points at Budget, not at loading a plan");
  const plan = app.slice(app.indexOf("function viewPlan()"), app.indexOf("function planBody("));
  assert.ok(!/<button/.test(plan), "the empty Pay plan screen has no button");
});
