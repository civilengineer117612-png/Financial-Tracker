import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fitToIncome, DEFAULT_TARGETS, resolveTargets, parseTargets, bucketOf, bucketMap, unclear, renameConflict, readBucket, BUCKET_WORDS, withBucket, starterFromTargets, bucketRows, suggestBudgets, SUGGEST_DEFAULTS, CATEGORY_ROLES } from "../src/model/index.js";
import { UNLOGGED_CATEGORY_ID } from "../src/model/seed.js";
import { makeState, account } from "./fixtures.js";

// Invented numbers only. 100 centavos = 1 peso.
const c = (id, name, role) => ({ id, name, kind: "expense", ...(role ? { role } : {}) });

test("the bucket is read from the name: the owner's own categories need nothing set", () => {
  const want = { Food: "need", Essentials: "need", Transpo: "need", Rent: "need", Subscription: "want", Shopping: "want", Health: "need", Fun: "want", Other: "other",
    "Lakat/Date": "want", Lakat: "want", Upskill: "savings", Damit: "need" };
  for (const [name, b] of Object.entries(want)) assert.equal(bucketOf(c("x", name)), b, name);
});

test("English, Filipino, Taglish and shorthand are read; capitals, accents, plurals and extra words do not matter", () => {
  const want = { "Grocery (SM)": "need", GROCERIES: "need", Palengke: "need", Baon: "need", "Kuryente & Tubig": "need", Meralco: "need", Load: "need", Bills: "need",
    Pamasahe: "need", Grab: "need", Gasolina: "need", RFID: "need", Gamot: "need", PhilHealth: "need", "Pag-IBIG": "need", HDMF: "need", Amort: "need", "Assoc dues": "need",
    Kape: "want", "Café": "want", "Milk tea": "want", Samgyup: "want", "Kain sa labas": "want", Gimik: "want", Inuman: "want", Netflix: "want", Shopee: "want", Budol: "want", Salon: "want",
    Ipon: "savings", MP2: "savings", "Emergency fund": "savings", Books: "savings", Misc: "other", "Iba pa": "other", Others: "other" };
  for (const [name, b] of Object.entries(want)) assert.equal(readBucket(name).bucket, b, name);
});

test("the longest matching words win: food delivery is a want, food alone a need; a tie goes to the word that must be asked", () => {
  assert.equal(readBucket("Food delivery").bucket, "want");
  assert.equal(readBucket("Food").bucket, "need");
  assert.equal(readBucket("Other bills").bucket, "need", "a clear word beats Other");
  assert.equal(readBucket("Gym membership").bucket, "want", "membership is longer than gym");
  assert.equal(readBucket("Gym fees").bucket, null, "gym on its own is asked");
  assert.equal(readBucket("Gym spa").bucket, null, "same length (gym, spa): the word to ask about wins");
  assert.equal(readBucket("Bar fee").bucket, "want");
});

test("names that depend on the person are not read but asked: family, debt, shoes, gym, pets, gifts", () => {
  for (const n of ["Family", "Pamilya", "Padala", "Allowance", "Utang", "Loan", "Credit card", "CC", "Hulog", "Sapatos", "Shoes", "Gym", "Pets", "Regalo", "Tithes"]) {
    assert.equal(readBucket(n).bucket, null, n); assert.ok(readBucket(n).word, n + " is recognised as a word to ask about");
  }
  for (const n of ["Shabu Kain", "Pets and stuff", "Zzz", ""]) assert.equal(readBucket(n).bucket, null, n);
  assert.equal(readBucket("Shabu Kain").word, null, "an unknown name has no word at all");
});

test("whole words only: a word inside another word does not count", () => {
  assert.equal(readBucket("Update").bucket, null, "date is not read inside update");
  assert.equal(readBucket("Bart").bucket, null, "bar is not read inside Bart");
  assert.equal(readBucket("Carpool money").bucket, null, "car is not read inside carpool");
});

test("every word is in one list only, so a name never reads two ways", () => {
  const seen = new Map();
  for (const [kind, words] of Object.entries(BUCKET_WORDS)) for (const w of words) { assert.ok(!seen.has(w), `${w} is in ${seen.get(w)} and ${kind}`); seen.set(w, kind); }
});

test("the owner's answer (any of the four) wins over the name; an answer that is not one of them is ignored", () => {
  assert.equal(bucketOf(c("a", "Food"), { a: "want" }), "want");
  assert.equal(bucketOf(c("a", "Shabu Kain"), { a: "other" }), "other", "Keep in Other");
  assert.equal(bucketOf(c("a", "Food"), { a: "other" }), "other", "Other chosen by hand wins over a clear name");
  assert.equal(bucketOf(c("a", "Shabu Kain"), { a: "savings" }), "savings");
  assert.equal(bucketOf(c("a", "Food"), { a: "banana" }), "need");
  assert.equal(bucketOf(c("a", "Food", "fun")), "need", "an old stored Type no longer decides the bucket: the name does");
});

test("unclear lists the categories the name cannot place and the owner has not answered, never Unlogged or income", () => {
  const cats = [c("f", "Food"), c("s", "Shabu Kain"), c("u", "Utang"), c("k", "Keep me", ), c("m", "Misc"), c(UNLOGGED_CATEGORY_ID, "Unlogged"), { id: "i", name: "Salary", kind: "income" }];
  assert.deepEqual(unclear(cats, { k: "other" }, UNLOGGED_CATEGORY_ID).map((x) => x.id), ["s", "u"]);
});

test("renaming: a bucket set by hand is kept unless the new name clearly reads otherwise, and then the owner is asked", () => {
  assert.deepEqual(renameConflict(c("a", "Coffee"), "Kape", { a: "need" }), { mine: "need", read: "want" });
  assert.equal(renameConflict(c("a", "Coffee"), "Kape", {}), null, "nothing set by hand: the new name simply applies");
  assert.equal(renameConflict(c("a", "Coffee"), "Shabu Kain", { a: "need" }), null, "an unclear new name keeps your choice");
  assert.equal(renameConflict(c("a", "Coffee"), "Groceries", { a: "need" }), null, "the new name agrees");
  assert.deepEqual(renameConflict(c("a", "X"), "Misc", { a: "need" }), { mine: "need", read: "other" });
});

test("withBucket stores an answer, clears it, and refuses a made-up bucket", () => {
  const s = withBucket({ keep: 1 }, "a", "want");
  assert.deepEqual(s, { keep: 1, bucket_overrides: { a: "want" } });
  assert.deepEqual(withBucket(s, "a", null).bucket_overrides, {});
  assert.equal(withBucket(s, "a", "banana"), s);
  assert.deepEqual(withBucket(s, "a", "other").bucket_overrides, { a: "other" }, "Keep in Other is an answer");
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

test("bucket rows: totals and percent of income per bucket, Goals and spending on yourself in savings, the buffer on its own line, never anything about red", () => {
  const cats = [c("rent", "Rent"), c("food", "Food"), c("fun", "Fun"), c("up", "Upskill"), c("m", "Shabu Kain")];
  const r = bucketRows({ categories: cats, overrides: {}, targets: undefined, budgets: { rent: 800000, food: 500000, fun: 300000, up: 100000, m: 50000 }, goals: 400000, buffer: 100000, income: 2500000 });
  assert.deepEqual(r.rows.map((x) => [x.bucket, x.amount, x.tenths, x.target]), [["need", 1300000, 520, 500], ["want", 300000, 120, 300], ["savings", 500000, 200, 200], ["other", 50000, 20, null]]);
  assert.deepEqual(r.invested, { label: "Invest in yourself", amount: 100000 });
  assert.deepEqual([r.buffer.label, r.buffer.amount, r.buffer.tenths], ["Overrun buffer", 100000, 40]);
  assert.ok(!r.rows.some((x) => /red|over|short/i.test(JSON.stringify(x))));
});

test("bucket rows: unclear names are counted in Other and flagged with the amount and how many; Other on purpose and answered ones are not flagged", () => {
  const cats = [c("rent", "Rent"), c("s", "Shabu Kain"), c("u", "Utang"), c("m", "Misc"), c("k", "Kept"), c("z", "Zero")];
  const r = bucketRows({ categories: cats, overrides: { k: "other" }, budgets: { rent: 800000, s: 40000, u: 60000, m: 30000, k: 20000, z: 0 }, income: 2500000 });
  assert.deepEqual(r.rows.map((x) => [x.bucket, x.amount]), [["need", 800000], ["want", 0], ["savings", 0], ["other", 150000]]);
  assert.deepEqual(r.unconfirmed, { amount: 100000, count: 2, ids: ["s", "u"] }, "only the unclear ones with a budget");
});

test("everything in Savings that is spending shows as Invest in yourself, chosen by hand or read from the name", () => {
  const r = bucketRows({ categories: [c("up", "Course"), c("x", "Shabu Kain")], overrides: { x: "savings" }, budgets: { up: 100000, x: 70000 }, income: 2500000 });
  assert.equal(r.rows.find((x) => x.bucket === "savings").amount, 170000);
  assert.equal(r.invested.amount, 170000);
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
