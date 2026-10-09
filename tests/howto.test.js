import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHANGES, whatsNew, HOWTOS, HOWTO_HINT, clipData, howtoClip } from "../src/model/index.js";

// Invented names and numbers only.
const own = { date: "Tue, 7 Oct", tiles: [{ name: "Coffee shop", amount: 18000, category: "Food" }, { name: "Train", amount: 3000, category: "Transpo" }, { name: "Lunch", amount: 9500, category: "Food" }],
  account: { name: "Test Wallet", picture: '<span class="ico mono">T</span>' }, total: 20000 };

test("What's new: newest first, each one dated sentence, shown until the newest is seen, three at a time", () => {
  assert.ok(CHANGES.length >= 3);
  for (const c of CHANGES) { assert.match(c.date, /^\d{4}-\d{2}-\d{2}$/); assert.ok(c.text.length > 10 && c.text.length < 200 && /\.$/.test(c.text), c.id); }
  assert.equal(new Set(CHANGES.map((c) => c.id)).size, CHANGES.length, "ids are unique");
  assert.ok(CHANGES.every((c, i) => i === 0 || c.date <= CHANGES[i - 1].date), "newest first");
  assert.deepEqual(whatsNew({}).map((c) => c.id), CHANGES.slice(0, 3).map((c) => c.id));
  assert.deepEqual(whatsNew({ whatsnew_seen: CHANGES[0].id }), []);
  assert.equal(whatsNew({ whatsnew_seen: CHANGES[1].id }).length, 3, "an older one seen: the latest three show again");
});

test("the log clip is drawn from the owner's own tiles, account, date and total", () => {
  const h = howtoClip("log", own);
  for (const w of ["Coffee shop", "Train", "Lunch", "Test Wallet", "Tue, 7 Oct", "₱200.00", "₱30.00", "₱230.00"]) assert.ok(h.includes(w), w);
  assert.ok(h.includes('class="ico mono"'), "the account's own picture");
  assert.ok(!h.includes("Example"), "nothing is marked as an example");
  assert.match(h, /hw-tile hw-pick"><b>Train/, "the middle tile is the one tapped");
  assert.match(h, /role="img" aria-label="A finger taps the Train tile/);
});

test("with no tiles or no account yet, plainly marked examples stand in", () => {
  const h = howtoClip("log", { date: "Tue, 7 Oct", tiles: [], account: null, total: 0 });
  assert.ok(h.includes("Example") && h.includes("Wallet"));
  assert.equal(clipData({ date: "x", tiles: own.tiles, account: null }).example, true, "tiles without an account are still an example");
});

test("verify and scan clips use the same data; the scan clip draws an invented receipt and saves a draft", () => {
  const v = howtoClip("verify", own), sc = howtoClip("scan", own);
  assert.ok(v.includes("Correct") && v.includes("Train") && v.includes("Test Wallet") && v.includes("hw-verify"));
  assert.ok(sc.includes("SAMPLE STORE") && sc.includes("Save as a draft") && sc.includes("Test Wallet") && sc.includes("hw-scan"));
  assert.equal(howtoClip("nope", own), "");
});

test("names from the owner's screen are escaped, never run as markup", () => {
  const h = howtoClip("log", { ...own, tiles: [{ name: '<img src=x onerror="alert(1)">', amount: 100, category: "Food" }] });
  assert.ok(!h.includes("<img src=x") && h.includes("&lt;img src=x"));
});

test("every clip has one caption; the hint names the buttons that hold a how-to, and the app wires exactly those", () => {
  assert.deepEqual(HOWTOS.map((h) => h.id), ["log", "verify", "scan", "budget", "trips", "cards", "checkin", "checks", "buffer", "goals", "import", "scheduled", "backup"]);
  for (const h of HOWTOS) assert.ok(h.caption && h.label && h.caption.length < 80, h.id);
  assert.match(HOWTO_HINT, /^Hold a button or a menu row for a moment to watch how it works\. Help lists every clip\.$/);
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8"), css = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(app, /data-tab="\$\{id\}" data-howto="\$\{id\}"/); assert.match(app, /class="camicon" data-action="open-scan-pick" data-howto="scan"/);
  assert.match(app, /class="tile addtile" data-action="add-tile" data-howto="log"/);
  assert.match(app, /<button class="item" data-action="tab" data-tab="\$\{id\}" data-howto="\$\{id\}"/, "menu items carry their how-to");

  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n    \.hw \*/, "Reduce Motion stops every clip");
  for (const k of ["hwLogFinger", "hwVerFinger", "hwScanFinger", "hwBudFinger", "hwTripFinger", "hwBackFinger", "hwGoalFinger", "hwCardFinger", "hwChip", "hwGrow"]) assert.ok(css.includes(`@keyframes ${k}`), k);
});

const bud = { income: 2500000, rows: [{ name: "Groceries", amount: 500000, bucket: "need" }, { name: "Coffee", amount: 100000, bucket: "want" }, { name: "Misc", amount: 0, bucket: "other" }],
  buckets: [{ bucket: "need", label: "Needs", amount: 1000000 }, { bucket: "want", label: "Wants", amount: 400000 }, { bucket: "savings", label: "Savings", amount: 300000 }] };

test("the budget clip is drawn from the owner's own budgets, income and buckets; the first category gets +P500 in the picture only", () => {
  const h = howtoClip("budget", { ...own, budget: bud });
  for (const w of ["Groceries", "Coffee", "Misc", "₱25,000.00", "₱5,000.00", "₱5,500.00", "₱1,000.00", "Needs", "Wants", "Savings"]) assert.ok(h.includes(w), w);
  assert.ok(!h.includes("Example"));
  assert.match(h, /hw-fill hw-grow" style="--w0:40%;--w1:42%"/, "the Needs bar grows from 40.0% to 42.0% of income");
  assert.match(h, /hw-fill" style="--w0:16%;--w1:16%"/, "the other bars stay");
  assert.match(h, /hw-t0">₱5,000\.00<small>20\.0%<\/small>/, "before: 5,000 is 20.0% of 25,000");
  assert.match(h, /hw-t1">₱5,500\.00<small>22\.0%<\/small>/, "after: 5,500 is 22.0%");
  assert.match(h, /hw-tip"><span class="hw-t0">40\.0%<\/span><span class="hw-t1">42\.0%<\/span>/, "the Needs value at the bar tip changes with it");
});

test("a category with no budget yet is shown going to P3,000; with the new Budget off there are no bars; with no income or budgets, a marked example", () => {
  const zero = howtoClip("budget", { ...own, budget: { ...bud, rows: [{ name: "Pets", amount: 0, bucket: "other" }] } });
  assert.ok(zero.includes("₱3,000.00"));
  const off = howtoClip("budget", { ...own, budget: { ...bud, buckets: null } });
  assert.ok(!off.includes("hw-bars") && off.includes("Groceries"));
  assert.ok(howtoClip("budget", { ...own, budget: { income: 0, rows: [] } }).includes("Example"));
  assert.ok(howtoClip("budget", { ...own, budget: null }).includes("Example"));
});

test("the verify clip shows the amount being fixed before Correct is tapped", () => {
  const v = howtoClip("verify", own);
  assert.match(v, /hw-amt hw-type"><span class="hw-t0">₱40\.00<\/span><span class="hw-t1">₱30\.00<\/span>/, "the logged amount is P10 off and is edited to the right one");
  assert.ok(v.indexOf("hw-type") < v.indexOf("hw-ok"), "the edit comes before Correct");
  assert.match(v, /edits the amount to ₱30\.00 and the category from Other to Transpo, taps Correct/);
  assert.match(HOWTOS.find((h) => h.id === "verify").caption, /fix anything that is wrong/);
});

test("the trips clip is drawn from the owner's own trips; with none, a marked example; names are escaped", () => {
  const t = howtoClip("trips", { ...own, trips: [{ name: "Test Island", days: "3 Oct 2026 to 5 Oct 2026", spent: 120000 }, { name: "<b>x</b>", days: null, spent: 0 }] });
  for (const w of ["Test Island", "3 Oct 2026 to 5 Oct 2026", "₱1,200.00", "₱2,150.00", "No dates yet", "Tag new entries with this trip", "Tagging new entries ✓", "hw-trips"]) assert.ok(t.includes(w), w);
  assert.ok(!t.includes("Example") && !t.includes("<b>x</b>") && t.includes("&lt;b&gt;x"));
  assert.ok(howtoClip("trips", own).includes("Example"), "no trips yet: a marked example");
  assert.equal(clipData({ date: "x", trips: [{}, {}, {}] }).trips.length, 2, "at most two trips");
});

test("the verify clip also fixes the category; the trips clip says dates work too; the backup clip says the data lives only on the phone", () => {
  const v = howtoClip("verify", own), t = howtoClip("trips", own), b = howtoClip("backup", own);
  assert.match(v, /hw-cat"><span class="hw-t0">Other<\/span><span class="hw-t1">Transpo<\/span>/);
  assert.ok(t.includes("Or give the trip dates"));
  for (const w of ["Back up now", "Save the file", "No backup yet", "Last backup today", "lives only on this phone", "hw-backup"]) assert.ok(b.includes(w), w);
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  assert.match(app, /data-action="open-backup" data-howto="backup"/, "Back up now carries its clip");
  assert.ok(!app.includes("Hold a row or Back up now to watch how it works"), "the hold hint lives in Help, not on the menu");
});

test("the goals clip is drawn from the owner's own goal; the bar and the figures grow together; with none, a marked example", () => {
  const g = howtoClip("goals", { ...own, goal: { name: "Test Trip Fund", balance: 500000, target: 2000000, account: { name: "Test Savings", picture: '<span class="ico mono">S</span>' } } });
  for (const w of ["Test Trip Fund", "₱5,000.00 of ₱20,000.00", "₱6,000.00 of ₱20,000.00", "Put money in", "₱1,000.00", "Test Savings", "25.0%", "30.0%", "hw-goals"]) assert.ok(g.includes(w), w);
  assert.match(g, /hw-fill hw-grow" style="--w0:25%;--w1:30%"/);
  assert.ok(!g.includes("Example"));
  assert.ok(howtoClip("goals", own).includes("Example") && howtoClip("goals", { ...own, goal: { name: "x", balance: 0, target: 0 } }).includes("Example"), "no goal with a target: a marked example");
  assert.ok(howtoClip("goals", { ...own, goal: { name: "Almost", balance: 1990000, target: 2000000 } }).includes("₱100.00"), "near the target, only what is left is added");
  assert.ok(howtoClip("goals", { ...own, goal: { name: "<i>x</i>", balance: 1, target: 100 } }).includes("&lt;i&gt;x") && !howtoClip("goals", { ...own, goal: { name: "<i>x</i>", balance: 1, target: 100 } }).includes("<i>x"), "escaped");
});

test("the goals clip explains the emergency fund's target and the no-account case; the import clip is an invented, marked example drawn on the owner's account", () => {
  const ef = howtoClip("goals", { ...own, goal: { name: "Safety", balance: 100000, target: 900000, ef: true, months: 3, account: { name: "Test Savings" } } });
  assert.ok(ef.includes("worked out from your budgets: 3 months of your rent, food and essentials"));
  const plain = howtoClip("goals", { ...own, goal: { name: "G", balance: 1, target: 100 } });
  assert.ok(plain.includes("holds nothing: choose an account for it first") && !plain.includes("worked out from your budgets"));
  const im = howtoClip("import", own);
  for (const w of ["Example", "Test Wallet", "12 lines", "2 already logged, left out", "Add 10 drafts to Verify", "hw-import"]) assert.ok(im.includes(w), w);
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
  assert.match(app, /!x\.hidden_by_default \|\| ui\.reveal/, "a hidden goal is drawn only while balances are shown");
  for (const k of ["hwScanFinger"]) assert.ok(readFileSync(new URL("../app/index.html", import.meta.url), "utf8").includes(k));
});

const accts = [{ name: "Test Card", amount: 304800, owe: true, spent: [54900, 120000], picture: '<span class="ico mono">C</span>' }, { name: "Test Wallet", amount: 292600, spent: [39900, 85000] }];

test("the Cards clip is drawn from the owner's accounts: balances stay, the month and what was spent change", () => {
  const h = howtoClip("cards", { ...own, accounts: accts, months: ["October 2026", "September 2026"] });
  for (const w of ["Test Card", "Test Wallet", "\u2212₱3,048.00", "hw-up", "₱549.00", "₱1,200.00", "October 2026", "September 2026", "hw-cards"]) assert.ok(h.includes(w), w);
  assert.ok(!h.includes("Example") && h.includes('class="ico mono"'), "own accounts, with their pictures");
  assert.equal((h.match(/₱3,048\.00/g) ?? []).length, 2, "the balance is drawn before and after, unchanged");
  assert.ok(!/you owe|in it|spent ₱/.test(h), "the clip uses the screen's signs, not small sentences");
  assert.ok(howtoClip("cards", own).includes("Example"), "no accounts: a marked example");
});

test("the Weekly review clip counts the first account: not counted becomes its balance and the count goes up", () => {
  const h = howtoClip("checkin", { ...own, accounts: accts });
  for (const w of ["Weekly review", "0 of 2 counted", "1 of 2 counted", "Not counted", "₱3,048.00", "real balance", "Save", "hw-checkin"]) assert.ok(h.includes(w), w);
  assert.ok(!h.includes("Example") && howtoClip("checkin", own).includes("Example"));
  assert.ok(howtoClip("checkin", { ...own, accounts: [{ name: "<b>x</b>", amount: 1, spent: [0, 0] }] }).includes("&lt;b&gt;x") && !howtoClip("checkin", { ...own, accounts: [{ name: "<b>x</b>", amount: 1, spent: [0, 0] }] }).includes("<b>x</b>"), "names are escaped");
});

test("the Checks and Buffer clips are invented, marked examples that tell their story in words", () => {
  const c = howtoClip("checks", own), b = howtoClip("buffer", own);
  for (const w of ["Example", "Test Card owes", "Reserve holds", "Covered", "Short by ₱548.00", "Card purchase ₱2,500.00"]) assert.ok(c.includes(w), w);
  for (const w of ["Example", "Over by ₱500.00", "Covered", "₱2,000.00", "₱1,500.00", "recorded against Food"]) assert.ok(b.includes(w), w);
  assert.match(b, /aria-label="Food goes 500 pesos over its limit; the buffer pays the gap/);
  assert.equal(HOWTOS.find((h) => h.id === "buffer").label, "Cover an overrun", "the screen keeps its name, Buffer; the clip says what it is for");
});

test("the Scheduled clip is drawn from the owner's own schedules: the first row turns into a draft waiting in Verify; nothing is confirmed", () => {
  const own = { date: "Sat, 3 Oct", tiles: [], account: null, total: 0 };
  const h = howtoClip("scheduled", { ...own, schedules: [{ name: "Test Rent", amount: 500000, due: "Oct 5" }, { name: "Test Phone", amount: 200000, due: "Oct 12" }] });
  for (const w of ["Test Rent", "Test Phone", "\u20B15,000.00", "due Oct 5", "draft in Verify", "hw-scheduled", "hw-t0", "hw-t1"]) assert.ok(h.includes(w), w);
  assert.ok(!h.includes("Example"), "their own: not marked as an example");
  assert.equal((h.match(/draft in Verify/g) ?? []).length, 1, "only the first row changes");
  assert.ok(howtoClip("scheduled", own).includes("Example"), "none yet: a marked example");
  assert.match(h, /aria-label="[^"]*nothing is confirmed for you/);
  const css = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(css, /\.hw-scheduled \.hw-t0 \{ animation-name: hwTapOld; \} \.hw-scheduled \.hw-t1 \{ animation-name: hwTapNew; \}/, "its motion is defined");
});
