import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyState, removeKind, removeCategory, restoreCategory, categoryInUse, hideCategory, showCategory, hiddenCategoryIds, pickable, UNLOGGED_CATEGORY_ID } from "../src/model/index.js";
import { account } from "./fixtures.js";

// Invented names and amounts only.
const base = () => ({ ...emptyState(),
  accounts: [account({ id: "w", name: "Test Wallet", class: "asset", opening_balance: 100000 })],
  categories: [{ id: "c-used", name: "Used", kind: "expense" }, { id: "c-free", name: "Free", kind: "expense", role: "food" }, { id: "c-budget", name: "Budgeted", kind: "expense" },
    { id: UNLOGGED_CATEGORY_ID, name: "Unlogged", kind: "expense" }, { id: "c-pay", name: "Pay", kind: "income" }],
  transactions: [{ id: "t1", date: "2026-10-02", payee: "X", memo: "", status: "verified", source: "manual", created_at: "2026-10-02T09:00:00.000+08:00", verified_at: "2026-10-02T09:00:00.000+08:00" }],
  entries: [{ transaction_id: "t1", category_id: "c-used", amount: 500 }, { transaction_id: "t1", account_id: "w", amount: -500 }],
  rules: [{ id: "r1", kind: "budget", category_id: "c-budget", amount: 100000, from_month: "2026-10" }] });

test("a category nothing refers to can be removed; one with entries or a budget can only be hidden", () => {
  const s = base();
  assert.equal(removeKind(s, "c-free"), "remove");
  assert.equal(removeKind(s, "c-used"), "hide", "it has an entry");
  assert.equal(removeKind(s, "c-budget"), "hide", "it has a budget line");
  const r = removeCategory(s, "c-free");
  assert.ok(r.ok && !r.state.categories.some((c) => c.id === "c-free") && r.state.categories.length === s.categories.length - 1);
  assert.equal(removeCategory(s, "c-used").ok, false, "the used one stays");
  assert.equal(removeCategory(s, "c-used").violations[0].code, "IN_USE");
});

test("the app's own categories (Unlogged, income) and unknown ids are never removed", () => {
  const s = base();
  for (const id of [UNLOGGED_CATEGORY_ID, "c-pay", "nope"]) { assert.equal(removeKind(s, id), null, id); assert.equal(removeCategory(s, id).ok, false, id); }
});

test("a reference anywhere counts, even in a list inside a record", () => {
  const s = { ...base(), presets: [{ id: "p", name: "Tile", amount: 100, category_id: "c-free" }] };
  assert.equal(categoryInUse(s, "c-free"), true);
  assert.equal(removeKind(s, "c-free"), "hide");
  assert.equal(categoryInUse(base(), "c-free"), false);
});

test("hiding is a setting: the category and its history stay, only the pickers leave it out, and showing it again undoes it", () => {
  const s = base(), st = hideCategory({ keep: 1 }, "c-used");
  assert.deepEqual(hiddenCategoryIds(st), ["c-used"]);
  assert.equal(st.keep, 1, "other settings are untouched");
  assert.equal(hideCategory(st, "c-used"), st, "hiding twice changes nothing");
  assert.deepEqual(pickable(s.categories, st).map((c) => c.id), ["c-free", "c-budget", UNLOGGED_CATEGORY_ID, "c-pay"]);
  assert.ok(s.categories.some((c) => c.id === "c-used"), "the category itself is still in the ledger");
  assert.deepEqual(hiddenCategoryIds(showCategory(st, "c-used")), []);
  assert.equal(pickable(s.categories, {}).length, s.categories.length);
});

const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8"), css = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");

test("Setup shows one pencil; in edit mode a row opens the change window and × removes (after a second tap) or – hides", () => {
  assert.match(app, /data-action="cat-edit" aria-label="Edit categories"/);
  assert.match(app, /data-action="rename-cat" data-id="\$\{esc\(c\.id\)\}"><span>\$\{esc\(c\.name\)\}<small>/, "the whole row is the tap target");
  assert.match(app, /ui\.confirmRemoveCat === c\.id \? "Tap again to remove"/, "a removal cannot be undone, so it asks once more");
  assert.match(app, /if \(ui\.confirmRemoveCat !== id\) \{ ui\.confirmRemoveCat = id; renderScreen\(\); break; \}/);
  assert.ok(!app.includes('data-action="cat-bucket"') && !app.includes('>Rename</button>'), "the Bucket and Rename links are gone");
  assert.match(app, /pick-edit-bucket/);
  assert.match(app, /const chose = cat && M\.CHOICES\.includes\(ui\.form\.bucket\) && ui\.form\.bucket !== ui\.form\.bucket0/, "a bucket picked in the window is the answer");
  assert.match(app, /Hidden categories/);
});

test("the pickers leave out hidden categories while budgets and totals still count them", () => {
  assert.match(app, /const pickCategories = \(\) => M\.pickable\(expenseCategories\(\), ledger\.settings\)/);
  assert.ok(!/chips\(expenseCategories\(\)/.test(app), "no chooser offers every category");
  assert.match(app, /const budget = expenseCategories\(\)\.filter/, "the budget total still reads every category");
});

test("required fields carry a * in the ink colour, never red, with one line saying what it means", () => {
  assert.match(css, /\.req \{ color: var\(--ink\); font-weight: 600; \}/);
  assert.match(app, /const REQ = ' <span class="req" aria-hidden="true">\*<\/span>'/);
  assert.match(app, /<label>Paid from\$\{REQ\}<\/label>/);
  assert.match(app, /<label for="f-amount">Amount \(₱\)\$\{REQ\}<\/label>/);
  assert.match(app, /needed before you can save/);
});

test("the welcome card: centred, after the notice on a new install only, with Make it mine, Skip for now and a Don't show this again check", () => {
  assert.match(app, /welcome_pending: true/, "only a brand-new install is marked");
  assert.match(app, /if \(!ledger\.settings\.welcome_pending \|\| ledger\.settings\.welcome_off \|\| S\(\)\.transactions\.length\) return;/);
  assert.match(app, /data-action="welcome-mine">Make it mine/);
  assert.match(app, /data-action="welcome-skip" style="width:100%">Skip for now/);
  assert.match(app, /role="checkbox" aria-checked="\$\{ui\.form\.welcomeOff === true\}" data-action="welcome-off"/);
  assert.match(app, /case "welcome-mine": \{[^}]*ui\.setupPage = "categories"; ui\.catEdit = true/, "Make it mine lands on the categories in edit mode");
  assert.match(app, /welcome_off: true/);
  assert.match(css, /\.sheet\.center \{ top: 50%;/, "it sits in the middle, not at the bottom");
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.wl-type \{ width: 0;/, "Reduce Motion shows the finished frame");
});

test("a removed category can be put back exactly where it was, unless its name has been taken since", () => {
  const s = base(), r = removeCategory(s, "c-free");
  assert.deepEqual(r.removed, { category: s.categories[1], index: 1 });
  const back = restoreCategory(r.state, r.removed);
  assert.ok(back.ok);
  assert.deepEqual(back.state.categories, s.categories, "same categories in the same order");
  const taken = { ...r.state, categories: [...r.state.categories, { id: "other", name: " FREE ", kind: "expense" }] };
  assert.equal(restoreCategory(taken, r.removed).ok, false, "the same name is not made twice");
  assert.equal(restoreCategory(back.state, r.removed).ok, false, "putting it back twice does nothing");
});

test("Undo after a removal, Monthly payment, and the one-time card for ledgers that were already in use", () => {
  assert.match(app, /showToast\("Removed " \+ r\.removed\.category\.name, id, null, "undo-cat"\)/);
  assert.match(app, /case "undo-cat": \{[\s\S]*?M\.restoreCategory\(S\(\), u\)/);
  assert.match(app, /aria-pressed="\$\{!inst\}">Monthly payment<\/button>/);
  assert.ok(!app.includes("Repeats each month"));
  assert.match(app, /!ledger\.settings\.cat_card_seen && !ledger\.settings\.welcome_pending\) \{ ui\.sheet = \{ type: "catcard" \}/, "only an old ledger that has not seen it, never a new install");
  assert.match(app, /welcome_pending: true, cat_card_seen: M\.phTimestamp\(\)/, "a new install is marked as having seen it");
  assert.match(app, /case "cat-card-later": [^\n]*cat_card_seen: M\.phTimestamp\(\)/, "Not now also counts: it never comes back");
  assert.match(app, /data-action="cat-card-show">Show me/);
});

test("an entry in a hidden category still shows it (marked hidden) while it is edited; a reserve account can be paid from", () => {
  assert.match(app, /const pickCategoriesWith = \(id\) => \{[^\n]*name: c\.name \+ " \(hidden\)"/);
  assert.ok((app.match(/pickCategoriesWith\(/g) ?? []).length >= 5, "every form that edits an entry uses it");
  assert.match(app, /return activeAccounts\(\)\.filter\(\(a\) => pockets \|\| !M\.isPocket\(a\)\)\.sort\(/, "the pickers no longer leave out a reserve account (only a savings pocket is left out of Paid from)");
  assert.ok(!/activeAccounts\(\)\.filter\(\(a\) => !a\.reserve_for\)/.test(app));
});

test("the other forms that need something carry the same * and line: tile, scheduled payment, money received and the Verify edit", () => {
  for (const label of ['pay-name">Name${REQ}', 's-name">${inst ? "Item" : "Name (rent, a subscription)"}${REQ}', 's-amount">Amount each month (\\u20B1)${REQ}', 'Amount received (\\u20B1)${REQ}', '<label>Arrived in${REQ}</label>', '<label>Paid from${REQ}</label>']) assert.ok(app.includes(label), label);
  assert.ok((app.match(/\$\{REQNOTE\}/g) ?? []).length >= 6, "each of those forms says what the * means");
});

test("Budget keeps a hidden category in its place with one quiet word under its name, no separate group", () => {
  assert.match(app, /const hiddenTag = \(id\) => M\.isHiddenCategory\(ledger\.settings, id\) \? `<small class="hiddennote">hidden<\/small>` : "";/);
  assert.ok((app.match(/\$\{hiddenTag\(/g) ?? []).length >= 3, "every Budget row shows it");
  assert.match(css, /small\.hiddennote \{ display: block; color: var\(--muted\); font-size: 12px; \}/);
  assert.ok(!/<h2>Hidden<\/h2>/.test(app), "rows stay plain: no group label");
});
