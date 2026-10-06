import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fitToIncome, BUCKET_BY_ROLE, DEFAULT_TARGETS, resolveTargets, parseTargets, bucketOf, bucketMap, unconfirmed, askBucket, guessType, typeOf, withBucket, starterFromTargets, bucketRows, suggestBudgets, SUGGEST_DEFAULTS, CATEGORY_ROLES } from "../src/model/index.js";
import { UNLOGGED_CATEGORY_ID } from "../src/model/seed.js";
import { makeState, account } from "./fixtures.js";

// Invented numbers only. 100 centavos = 1 peso.
const c = (id, name, role) => ({ id, name, kind: "expense", ...(role ? { role } : {}) });

test("the bucket follows from the Type: needs, wants, savings; Family and Other have no default", () => {
  assert.deepEqual(Object.keys(BUCKET_BY_ROLE).sort(), [...CATEGORY_ROLES.filter((r) => r !== "family" && r !== "other"), "essentials", "health"].sort(), "every Type but Family and Other has a bucket; the two older Types keep theirs");
  for (const r of ["rent", "food", "transport", "utilities", "debt", "essentials", "health"]) assert.equal(bucketOf(c("x", "Any", r)), "need", r);
  for (const r of ["shopping", "dining", "fun", "subscription"]) assert.equal(bucketOf(c("x", "Any", r)), "want", r);
  assert.equal(bucketOf(c("x", "Upskill", "invest")), "savings");
  assert.equal(bucketOf(c("x", "Support", "family")), "other"); assert.equal(bucketOf(c("x", "Misc", "other")), "other");
});

test("the owner's answer wins over the Type; an answer that is not a bucket is ignored", () => {
  assert.equal(bucketOf(c("a", "Food", "food"), { a: "want" }), "want");
  assert.equal(bucketOf(c("a", "Mystery", "family"), { a: "need" }), "need");
  assert.equal(bucketOf(c("a", "Food", "food"), { a: "banana" }), "need", "an invalid answer is not used");
});

test("with no stored Type, the bucket is the name's guess; with no guess, Other. A stored Type always wins over the name", () => {
  assert.equal(bucketOf(c("a", "Rent")), "need", "guessed rent");
  assert.equal(bucketOf(c("a", "Netflix")), "want");
  assert.equal(bucketOf(c("a", "Mystery")), "other", "no guess");
  assert.equal(bucketOf(c("a", "Rent", "fun")), "want", "named Rent but the owner's Type is Fun");
});

test("unconfirmed lists the spending categories with no stored Type, never Unlogged or income; askBucket lists Family and Other with no answer", () => {
  const cats = [c("f", "Food", "food"), c("m", "Mystery"), c("z", "Zed"), c("fam", "Support", "family"), c("o", "Misc", "other"), c(UNLOGGED_CATEGORY_ID, "Unlogged"), { id: "i", name: "Salary", kind: "income" }];
  assert.deepEqual(unconfirmed(cats, UNLOGGED_CATEGORY_ID).map((x) => x.id), ["m", "z"]);
  assert.deepEqual(askBucket(cats, { o: "want" }).map((x) => x.id), ["fam"]);
  assert.deepEqual(askBucket(cats, {}).map((x) => x.id), ["fam", "o"], "Other is asked too");
});

test("typeOf: a stored Type is confirmed; a name's guess is not; no guess is no Type", () => {
  assert.deepEqual(typeOf(c("a", "Pets", "family")), { type: "family", confirmed: true, guess: false });
  assert.deepEqual(typeOf(c("a", "Groceries")), { type: "food", confirmed: false, guess: true });
  assert.deepEqual(typeOf(c("a", "Pets")), { type: null, confirmed: false, guess: false });
});

test("guessing a Type from the name, with common Filipino words; nothing for what is unclear", () => {
  const want = { Rent: "rent", Upa: "rent", Groceries: "food", Palengke: "food", Pamasahe: "transport", Grab: "transport", Kuryente: "utilities", Meralco: "utilities", Netflix: "subscription", Shopee: "shopping",
    "Milk tea": "dining", Kainan: "dining", "Lakat/Date": "fun", Sine: "fun", Pamilya: "family", "Family support": "family", Padala: "family", Upskill: "invest", Utang: "debt", "Credit card": "debt" };
  for (const [name, type] of Object.entries(want)) assert.equal(guessType(name), type, name);
  for (const n of ["Pets", "Misc", "Stuff", "", "Other"]) assert.equal(guessType(n), null, n);
});

test("withBucket stores an answer, clears it, and refuses a made-up bucket", () => {
  const s = withBucket({ keep: 1 }, "a", "want");
  assert.deepEqual(s, { keep: 1, bucket_overrides: { a: "want" } });
  assert.deepEqual(withBucket(s, "a", null).bucket_overrides, {});
  assert.equal(withBucket(s, "a", "other"), s);
  assert.deepEqual(s.bucket_overrides, { a: "want" }, "the old settings are not changed");
});

test("targets: 50/30/20 by default, the owner's when they add to 100, the default again when they do not", () => {
  assert.deepEqual(resolveTargets(undefined), DEFAULT_TARGETS); assert.deepEqual(DEFAULT_TARGETS, { need: 5000, want: 3000, savings: 2000 });
  assert.deepEqual(resolveTargets({ need: 6000, want: 2000, savings: 2000 }), { need: 6000, want: 2000, savings: 2000 });
  assert.deepEqual(resolveTargets({ need: 6000, want: 3000, savings: 2000 }), DEFAULT_TARGETS);
  assert.deepEqual(resolveTargets({ need: 5000.5, want: 2999.5, savings: 2000 }), DEFAULT_TARGETS);
  assert.deepEqual(parseTargets({ need: "60", want: "20", savings: "20" }), { ok: true, targets: { need: 6000, want: 2000, savings: 2000 } });
  assert.equal(parseTargets({ need: "60", want: "30", savings: "20" }).ok, false);
  assert.match(parseTargets({ need: "60", want: "30", savings: "20" }).message, /add up to 100.*110/);
  assert.equal(parseTargets({ need: "x", want: "30", savings: "70" }).ok, false);
  assert.equal(parseTargets({ need: "50.5", want: "29.5", savings: "20" }).ok, false);
});

test("the starter ratios come from the targets with the buffer off the top of savings; the default targets give exactly the old starter ratios", () => {
  assert.deepEqual(starterFromTargets(undefined, 500), SUGGEST_DEFAULTS.starter);
  assert.deepEqual(starterFromTargets({ need: 6000, want: 2000, savings: 2000 }, 500), { needs: 6000, wants: 2000, savings: 1500, buffer: 500 });
  assert.deepEqual(starterFromTargets({ need: 7000, want: 2800, savings: 200 }, 500), { needs: 7000, wants: 2800, savings: 0, buffer: 200 }, "the buffer never takes more than the savings target");
});

test("bucket rows: totals and percent of income per bucket, Goals and invested spending in savings, the buffer on its own line, never anything about red", () => {
  const cats = [c("rent", "Rent", "rent"), c("food", "Food", "food"), c("fun", "Fun", "fun"), c("up", "Upskill", "invest"), c("m", "Mystery")];
  const r = bucketRows({ categories: cats, overrides: {}, targets: undefined, budgets: { rent: 800000, food: 500000, fun: 300000, up: 100000, m: 50000 }, goals: 400000, buffer: 100000, income: 2500000 });
  assert.deepEqual(r.rows.map((x) => [x.bucket, x.amount, x.tenths, x.target]), [["need", 1300000, 520, 500], ["want", 300000, 120, 300], ["savings", 500000, 200, 200], ["other", 50000, 20, null]]);
  assert.deepEqual(r.invested, { label: "Invest in yourself", amount: 100000 });
  assert.deepEqual([r.buffer.label, r.buffer.amount, r.buffer.tenths], ["Overrun buffer", 100000, 40]);
  assert.ok(!r.rows.some((x) => /red|over|short/i.test(JSON.stringify(x))));
});

test("bucket rows: unconfirmed categories are counted under their guessed bucket, or Other, and flagged with the amount and how many", () => {
  const cats = [c("rent", "Rent", "rent"), c("g", "Groceries"), c("n", "Netflix"), c("m", "Mystery"), c("z", "Zero")];
  const r = bucketRows({ categories: cats, overrides: {}, budgets: { rent: 800000, g: 400000, n: 50000, m: 30000, z: 0 }, income: 2500000 });
  assert.deepEqual(r.rows.map((x) => [x.bucket, x.amount]), [["need", 1200000], ["want", 50000], ["savings", 0], ["other", 30000]]);
  assert.deepEqual(r.unconfirmed, { amount: 480000, count: 3, ids: ["g", "n", "m"] }, "the Type-less ones with a budget; a zero budget is not counted");
  const done = bucketRows({ categories: [c("g", "Groceries", "food"), c("m", "Mystery", "other")], overrides: {}, budgets: { g: 400000, m: 30000 }, income: 2500000 });
  assert.equal(done.unconfirmed.count, 0, "a stored Type, even Other, is confirmed");
  assert.deepEqual(done.rows.find((x) => x.bucket === "other"), { bucket: "other", label: "Other", amount: 30000, tenths: 12, target: null }, "Other is its own line, never dropped");
});

test("only spending of the Type Invest in yourself shows as invested; another category the owner put in Savings does not", () => {
  const r = bucketRows({ categories: [c("up", "Course", "invest"), c("x", "Misc", "food")], overrides: { x: "savings" }, budgets: { up: 100000, x: 70000 }, income: 2500000 });
  assert.equal(r.rows.find((x) => x.bucket === "savings").amount, 170000);
  assert.equal(r.invested.amount, 100000);
});

test("bucket rows: an answer moves a category; no 'not sorted' row when nothing is in it; no percent without income", () => {
  const cats = [c("food", "Food", "food"), c("m", "Mystery")];
  const r = bucketRows({ categories: cats, overrides: { food: "want", m: "need" }, budgets: { food: 100000, m: 200000 }, income: 0 });
  assert.deepEqual(r.rows.map((x) => [x.bucket, x.amount, x.tenths]), [["need", 200000, null], ["want", 100000, null], ["savings", 0, null]]);
});

// ---- the starter suggestion reads buckets and targets ----
const TODAY = "2026-10-05", MONTH = "2026-10";
function starterState() {
  const s = makeState();
  s.accounts = [account({ id: "chk", name: "Test Checking", class: "asset", opening_balance: 100000000 })];
  s.categories = [c("rent", "Rent", "rent"), c("food", "Food", "food"), c("util", "Utilities", "utilities"), c("fam", "Family"), c("fun", "Fun", "fun"), c("up", "Upskill", "invest"),
    c(UNLOGGED_CATEGORY_ID, "Unlogged"), { id: "pay", name: "Pay", kind: "income" }];
  s.payslips = []; s.payslipLines = []; s.subscriptions = []; s.goals = []; s.rules = [];
  return s;
}
const sug = (o) => suggestBudgets({ state: starterState(), today: TODAY, month: MONTH, pin: 10000000, rent: 2000000, ...o });
const amt = (r, id) => r.rows.find((x) => x.category_id === id).amount;

test("starter: Utilities is a need by default, so it shares the needs pool; an unsorted category gets nothing until it is answered", () => {
  const r = sug({});
  assert.equal(r.ok, true);
  assert.ok(amt(r, "util") > 0, "utilities draws from the needs pool");
  assert.ok(amt(r, "food") > amt(r, "util"), "by weight: food 40% of the pool, an other need 10%");
  assert.equal(amt(r, "fam"), 0 + amt(r, "fam"));
  const noWants = sug({ overrides: { fam: "want" } });
  assert.ok(amt(noWants, "fam") > 0, "answered want: it shares the wants");
  const asNeed = sug({ overrides: { fam: "need" } });
  assert.ok(amt(asNeed, "fam") > 0, "answered need: it shares the needs pool");
});

test("starter: a category the owner puts in Savings takes no starter share; moving food to Wants takes it out of the needs pool", () => {
  assert.equal(amt(sug({}), "up"), 0, "invested in yourself is not given a starter amount");
  const r0 = sug({}), r1 = sug({ overrides: { food: "want" } });
  assert.ok(amt(r1, "util") > amt(r0, "util"), "with food gone from needs, utilities takes more of the pool");
});

test("starter: the targets set the pools, with the rent typed first and the buffer off the top of savings", () => {
  const a = sug({ targets: { need: 5000, want: 3000, savings: 2000 } }), b = sug({ targets: { need: 7000, want: 1500, savings: 1500 } });
  const need = (r) => ["food", "util"].reduce((n, id) => n + amt(r, id), 0);
  assert.ok(need(b) > need(a), "a higher needs target gives the needs categories more");
  assert.ok(amt(b, "fun") < amt(a, "fun"), "and a lower wants target gives the wants less");
  assert.equal(JSON.stringify(sug({}).rows.map((x) => x.amount)), JSON.stringify(sug({ targets: DEFAULT_TARGETS }).rows.map((x) => x.amount)), "the default targets change nothing");
  assert.ok(a.saved.find((x) => x.kind === "buffer"), "the buffer stays its own line");
});

test("the buckets reach the screens: the Budget block, the question, and the settings keys", () => {
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8"), sw = readFileSync(new URL("../app/sw.js", import.meta.url), "utf8");
  const bv = readFileSync(new URL("../src/model/budgetview.js", import.meta.url), "utf8");
  assert.match(bv, /fitToIncome\(\{ rows, others, saved, income: income\.amount, roles, buckets \}\)/, "the trimming reads the same buckets as the suggestion");
  assert.match(sw, /buckets\.js/);
  assert.match(app, /bucket_overrides/); assert.match(app, /bucket_targets/);
  assert.match(app, /overrides: set\.bucket_overrides/); assert.match(app, /targets: set\.bucket_targets/);
});

test("targets that add to less than 100 are refused too, both when typed and when stored", () => {
  assert.equal(parseTargets({ need: "50", want: "30", savings: "10" }).ok, false);
  assert.deepEqual(resolveTargets({ need: 5000, want: 3000, savings: 1000 }), DEFAULT_TARGETS);
});

test("starter: with no rent the rent category takes nothing from the needs pool", () => {
  const r = sug({ rent: 0 });
  assert.equal(amt(r, "rent"), 0);
  assert.ok(amt(r, "food") > 0);
});

test("the trimming that keeps a suggestion inside the income cuts a Want before a Need, by the owner's buckets and not by role", () => {
  const row = (category_id, amount) => ({ category_id, name: category_id, amount, suggested: amount, pinned: false, reason: "x" });
  const buckets = new Map([["a", "need"], ["b", "want"]]);
  const r = fitToIncome({ rows: [row("a", 500000), row("b", 400000)], income: 800000, buckets });
  assert.equal(r.rows.find((x) => x.category_id === "a").amount, 500000, "the larger one is a need and is kept");
  assert.equal(r.rows.find((x) => x.category_id === "b").amount, 300000, "the want gives up the excess");
});
