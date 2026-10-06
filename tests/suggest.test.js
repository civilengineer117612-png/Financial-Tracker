import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { suggestPlan, median, paydayDays, usableMonths, NO_PAYSLIP_MESSAGE, SUGGEST_DEFAULTS, resolveSettings, ratchetSchedule } from "../src/model/index.js";
import { UNLOGGED_CATEGORY_ID } from "../src/model/seed.js";
import { makeState, account } from "./fixtures.js";

// Every number here is invented. Amounts are whole centavos: 100000 is 1,000 pesos.
const TS = "2026-01-01T09:00:00.000+08:00";
const PAYDAYS = [{ id: "first", label: "1st payday", day: 15 }, { id: "second", label: "2nd payday", day: "last" }];
const TODAY = "2026-10-05", MONTH = "2026-10";   // October has 31 days: the first payday covers 16 days, the second 15

function base() {
  const s = makeState();
  s.accounts = [account({ id: "chk", name: "Test Checking", class: "asset", opening_balance: 100000000 })];
  s.categories = [
    { id: "food", name: "Food", kind: "expense", role: "food" }, { id: "rent", name: "Rent", kind: "expense", role: "rent" }, { id: "fun", name: "Fun", kind: "expense" },
    { id: UNLOGGED_CATEGORY_ID, name: "Unlogged", kind: "expense" }, { id: "pay", name: "Pay", kind: "income" },
  ];
  s.payslips = []; s.payslipLines = []; s.subscriptions = []; s.goals = [];
  return s;
}
let n = 0;
function spend(s, date, cat, amount, status = "verified") {
  const id = "t" + ++n;
  s.transactions.push({ id, date, payee: "", memo: "", status, source: "manual", created_at: TS, ...(status === "verified" ? { verified_at: TS } : {}) });
  s.entries.push({ transaction_id: id, category_id: cat, amount }, { transaction_id: id, account_id: "chk", amount: -amount });
}
function slip(s, date, deposit, overtime = 0) {
  const id = "p" + ++n;
  s.payslips.push({ id, employer: "Test Co", period_from: date, period_to: date, pay_date: date, account_id: "chk", transaction_id: "x" + n, printed_gross: deposit, printed_net: deposit, deposit });
  s.payslipLines.push({ payslip_id: id, side: "earning", kind: "basic", amount: deposit - overtime });
  if (overtime) s.payslipLines.push({ payslip_id: id, side: "earning", kind: "overtime", amount: overtime });
}
// A properly logged month: 12 food entries, rent on the 1st, 3 fun entries (all verified). Amounts can be overridden.
function logMonth(s, month, { food = 600000, rent = 800000, fun = 300000, entries = 12, unlogged = 0 } = {}) {
  for (let i = 0; i < entries; i++) spend(s, `${month}-${String(2 + i).padStart(2, "0")}`, "food", food / entries);
  if (rent) spend(s, `${month}-01`, "rent", rent);
  if (fun) for (let i = 0; i < 3; i++) spend(s, `${month}-20`, "fun", fun / 3);
  if (unlogged) spend(s, `${month}-28`, UNLOGGED_CATEGORY_ID, unlogged);
}
const MONTHS6 = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
function withHistory(extra = () => {}) {
  const s = base();
  for (const m of MONTHS6) { slip(s, m + "-15", 1000000); slip(s, m + "-" + (m === "2026-06" ? "30" : "30"), 2000000); logMonth(s, m); }
  extra(s);
  return s;
}
const run = (s, o = {}) => suggestPlan({ state: s, paydays: PAYDAYS, today: TODAY, month: MONTH, ...o });
const line = (r, i, name) => r.paydays[i].lines.find((l) => l.name === name);
const balances = (r) => r.paydays.every((p) => p.lines.reduce((a, l) => a + l.amount, 0) + p.unallocated - p.short === p.income);

test("no payslips: nothing is suggested, and the message says to add one first", () => {
  const r = run(base());
  assert.equal(r.ok, false); assert.equal(r.message, "Add a payslip first"); assert.equal(NO_PAYSLIP_MESSAGE, "Add a payslip first"); assert.equal(r.paydays, undefined);
});

test("unequal paydays (10,000 and 20,000): income is the median net, and on each payday lines + unallocated - short equal the income exactly", () => {
  const r = run(withHistory());
  assert.equal(r.ok, true);
  assert.deepEqual(r.paydays.map((p) => p.income), [1000000, 2000000]);
  assert.ok(balances(r));
  for (const p of r.paydays) assert.equal(p.lines.reduce((a, l) => a + l.amount, 0) + p.unallocated - p.short, p.income);
  // exact figures: rent (day 1) falls on the second payday; food and fun split by 16 and 15 days; buffer 5% and savings 15% of 30,000 pesos
  assert.equal(line(r, 1, "Rent").amount, 800000); assert.equal(line(r, 0, "Rent"), undefined);
  assert.equal(line(r, 0, "Overrun buffer").amount + line(r, 1, "Overrun buffer").amount, 150000);
  assert.equal(line(r, 0, "Overrun buffer").amount, 50000, "split by what each payday brings in, 1 to 2");
  const saved = ["first", "second"].map((_, i) => line(r, i, "Savings").amount);
  assert.equal(saved[0] + saved[1], 450000);
  assert.equal(r.paydays[0].unallocated + r.paydays[1].unallocated, 3000000 - 1850000 - 450000);
  assert.ok(r.paydays.every((p) => p.short === 0));
});

test("overtime is left out of income, and only the last 3 payslips of a payday count (the median, not the average)", () => {
  const s = base();
  slip(s, "2026-06-15", 900000); slip(s, "2026-07-15", 1000000); slip(s, "2026-08-15", 1100000, 0); slip(s, "2026-09-15", 1400000, 400000);   // base 1,000,000 with 400,000 of overtime
  slip(s, "2026-09-30", 2000000);
  const r = run(s);
  assert.equal(r.paydays[0].income, 1000000, "last 3 bases: 1,000,000 / 1,100,000 / 1,000,000 -> median 1,000,000");
  assert.equal(r.paydays[1].income, 2000000);
  const four = base(); for (const [d, v] of [["2026-06-15", 100000], ["2026-07-15", 1000000], ["2026-08-15", 1100000], ["2026-09-15", 1200000]]) slip(four, d, v); slip(four, "2026-09-30", 2000000);
  assert.equal(run(four).paydays[0].income, 1100000, "the last 3 only: the old small payslip does not count");
  const even = base(); slip(even, "2026-08-15", 1000000); slip(even, "2026-09-15", 1200000); slip(even, "2026-09-30", 2000000);
  assert.equal(run(even).paydays[0].income, 1000000, "two payslips: the lower middle value, a pay that really arrived");
  assert.equal(median([1, 2, 3, 4], "low"), 2); assert.equal(median([1, 2, 3, 4], "high"), 3); assert.equal(median([5, 1, 9]), 5); assert.equal(median([]), 0);
});

test("an under-logged month is left out of the median", () => {
  const s = withHistory((x) => { for (const m of ["2026-09"]) { x.transactions = x.transactions.filter((t) => !t.date.startsWith(m + "-") || t.id.startsWith("p")); } });
  // rebuild September badly: 3 entries only, with a huge food amount that would drag the median
  const dropIds = new Set(s.transactions.filter((t) => t.date.startsWith("2026-09-") && !t.id.startsWith("x")).map((t) => t.id));
  s.entries = s.entries.filter((e) => !dropIds.has(e.transaction_id));
  s.transactions = s.transactions.filter((t) => !dropIds.has(t.id));
  logMonth(s, "2026-09", { food: 9000000, entries: 3 });
  const u = usableMonths(s, { month: MONTH, today: TODAY, settings: SUGGEST_DEFAULTS });
  assert.ok(!u.some((x) => x.month === "2026-09"), "September has only 3 verified entries");
  assert.deepEqual(u.map((x) => x.month), ["2026-08", "2026-07", "2026-06", "2026-05", "2026-04"]);
  const r = run(s);
  const food = line(r, 0, "Food").amount + line(r, 1, "Food").amount;
  assert.equal(food, 600000); assert.match(line(r, 0, "Food").reason, /Median of the last 5 usable months/);
});

test("a month with too much Unlogged is also left out, and both limits are settings", () => {
  const s = withHistory((x) => { spend(x, "2026-09-28", UNLOGGED_CATEGORY_ID, 400000); });   // 400,000 of 1,700,000 is 23%
  assert.ok(!usableMonths(s, { month: MONTH, today: TODAY, settings: SUGGEST_DEFAULTS }).some((x) => x.month === "2026-09"));
  const loose = resolveSettings({ max_unlogged_bps: 3000 }).settings;
  assert.ok(usableMonths(s, { month: MONTH, today: TODAY, settings: loose }).some((x) => x.month === "2026-09"), "a looser limit lets it in");
  const strict = resolveSettings({ min_entries: 40 }).settings;
  assert.equal(usableMonths(s, { month: MONTH, today: TODAY, settings: strict }).length, 0, "a higher minimum rules every month out");
});

test("a lump month does not move the median", () => {
  const s = withHistory((x) => { spend(x, "2026-06-10", "fun", 5000000); });
  const r = run(s);
  assert.equal(line(r, 0, "Fun").amount + line(r, 1, "Fun").amount, 300000);
  assert.ok(balances(r));
});

test("with no usable history the lines are starter shares, marked starter, with the rule-of-thumb reason", () => {
  const s = base(); slip(s, "2026-09-15", 1000000); slip(s, "2026-09-30", 2000000);
  logMonth(s, "2026-09");   // one usable month is still too few
  const r = run(s);
  assert.equal(r.history.used, "starter"); assert.equal(r.history.usableMonths, 1);
  const spendLines = r.paydays.flatMap((p) => p.lines).filter((l) => ["Food", "Rent", "Fun"].includes(l.name));
  assert.ok(spendLines.length >= 3 && spendLines.every((l) => l.source === "starter"));
  assert.match(line(r, 0, "Food").reason, /Starter share, a common rule of thumb and not advice: 50% of pay for needs/);
  assert.match(line(r, 0, "Fun").reason, /30% of pay for wants/);
  // needs pool is 50% of 30,000 pesos = 1,500,000, split evenly over Rent and Food (the roles that are needs); wants 900,000 over Fun
  const total = (name) => r.paydays.reduce((a, p) => a + (p.lines.find((l) => l.name === name)?.amount ?? 0), 0);
  assert.deepEqual([total("Rent") + total("Food"), total("Fun")], [1500000, 900000]);
  assert.ok(balances(r));
});

test("a pinned line is never changed; the difference from the suggestion is returned", () => {
  const s = withHistory();
  const free = run(s), r = run(s, { pinned: [{ name: "food", first: 100000, second: 120000 }] });
  assert.deepEqual([line(r, 0, "Food").amount, line(r, 1, "Food").amount], [100000, 120000]);
  assert.equal(line(r, 0, "Food").pinned, true); assert.match(line(r, 0, "Food").reason, /Pinned by you/);
  const d = r.differences.find((x) => x.name === "food");
  assert.deepEqual(d.suggested, { first: line(free, 0, "Food").amount, second: line(free, 1, "Food").amount });
  assert.deepEqual(d.difference, { first: 100000 - d.suggested.first, second: 120000 - d.suggested.second });
  assert.ok(balances(r));
  // everything else is still computed around it, and a pin on a name the engine did not suggest is kept as is
  const extra = run(s, { pinned: [{ name: "Gift fund", first: 5000, second: 0 }] });
  assert.equal(line(extra, 0, "Gift fund").amount, 5000); assert.equal(extra.differences[0].suggested, null);
});

test("a shortfall shows Short, and nothing is cut", () => {
  const s = withHistory((x) => { x.payslips.forEach((p) => { if (p.pay_date.endsWith("-30")) p.deposit = p.printed_net = p.printed_gross = 500000; }); x.payslipLines.forEach((l) => { const p = x.payslips.find((q) => q.id === l.payslip_id); if (p.pay_date.endsWith("-30")) l.amount = 500000; }); });
  const r = run(s);
  assert.equal(r.paydays[1].income, 500000);
  assert.equal(line(r, 1, "Rent").amount, 800000, "rent stays whole");
  assert.ok(r.paydays[1].short > 0 && r.paydays[1].unallocated === 0);
  assert.equal(r.paydays[1].short, r.paydays[1].lines.reduce((a, l) => a + l.amount, 0) - 500000);
  assert.ok(balances(r));
  assert.equal(line(r, 1, "Food").amount + line(r, 0, "Food").amount, 600000, "food is not trimmed either");
});

test("daily spending splits by the days each payday covers (16 versus 15 in October), never in half", () => {
  assert.deepEqual([paydayDays(PAYDAYS, "2026-10").days1, paydayDays(PAYDAYS, "2026-10").days2], [16, 15]);
  assert.deepEqual([paydayDays(PAYDAYS, "2026-02").days1, paydayDays(PAYDAYS, "2026-02").days2], [13, 15], "February: 15th to the 27th, then the 28th to the 14th");
  const s = withHistory((x) => { for (const m of MONTHS6) { x.entries = x.entries.filter((e) => !(e.category_id === "fun")); } });
  s.transactions = s.transactions.filter((t) => s.entries.some((e) => e.transaction_id === t.id) || t.id.startsWith("x"));
  const r = run(s);
  const first = line(r, 0, "Food").amount, second = line(r, 1, "Food").amount;
  assert.equal(first + second, 600000);
  assert.equal(first, Math.floor((600000 * 16) / 31)); assert.equal(second, 600000 - first);
  assert.ok(first > second, "the longer stretch gets more");
  assert.match(line(r, 0, "Food").reason, /split by days covered \(16 and 15 days\)/);
});

test("a ratchet amount, when present, is used for savings, and without one savings start cautiously and never below the floor", () => {
  const s = withHistory();
  const params = { start: 100000, step: 20000, floor: 50000 }, amount = ratchetSchedule(params, [true, true])[2];
  assert.equal(amount, 140000);
  const r = run(s, { ratchet: { amount } });
  assert.equal(line(r, 0, "Savings").amount + line(r, 1, "Savings").amount, 140000);
  assert.match(line(r, 0, "Savings").reason, /From your savings ratchet/);
  assert.ok(balances(r));
  // no ratchet: a cautious start; with no room it is the floor, never negative
  const free = run(s), tight = run(withHistory((x) => { x.payslips.forEach((p) => { p.deposit = p.printed_net = p.printed_gross = Math.floor(p.deposit / 3); }); x.payslipLines.forEach((l) => { l.amount = Math.floor(l.amount / 3); }); }), { settings: { savings_floor: 20000 } });
  assert.equal(line(free, 0, "Savings").amount + line(free, 1, "Savings").amount, 450000);
  const t = tight.paydays.reduce((a, p) => a + (p.lines.find((l) => l.name === "Savings")?.amount ?? 0), 0);
  assert.equal(t, 20000, "the floor, even when it leaves a shortfall");
  assert.ok(tight.paydays.some((p) => p.short > 0));
  const zero = run(withHistory((x) => { x.payslips.forEach((p) => { p.deposit = p.printed_net = p.printed_gross = 10000; }); x.payslipLines.forEach((l) => { l.amount = 10000; }); }));
  assert.ok(zero.paydays.every((p) => p.lines.every((l) => l.amount >= 0)), "never negative");
});

test("subscriptions, scheduled payments and installments are placed first, on the payday their day falls in, and are not counted twice", () => {
  const s = withHistory((x) => { x.subscriptions = [{ id: "s1", name: "Test Streaming", card: "chk", currency: "PHP", amount: 25000, renewal_day: 20, exit_condition: "", review_date: "2026-12-01" }]; });
  const r = run(s, { scheduled: [{ name: "Test Loan", kind: "installment", amount: 150000, day: 5, months_left: 4 }, { name: "Test Insurance", kind: "scheduled", amount: 60000, day: 16, category_id: "fun" }, { name: "Test Done", kind: "installment", amount: 99999, day: 3, months_left: 0 }] });
  assert.equal(line(r, 0, "Test Streaming").amount, 25000, "day 20 is after the 15th, before the last: payday 1");
  assert.equal(line(r, 1, "Test Loan").amount, 150000, "day 5 is before the 15th, so the cutoff that began on the last day of last month: payday 2");
  assert.match(line(r, 1, "Test Loan").reason, /4 payments left/);
  assert.equal(line(r, 0, "Test Insurance").amount, 60000);
  assert.equal(r.paydays.flatMap((p) => p.lines).some((l) => l.name === "Test Done"), false, "an installment with no payments left is dropped");
  assert.equal(line(r, 0, "Fun").amount + line(r, 1, "Fun").amount, 300000 - 60000, "Fun's median is reduced by the scheduled payment paid under it");
  assert.ok(balances(r));
});

test("money must be whole centavos: a float is refused, never rounded", () => {
  const s = withHistory();
  for (const o of [{ scheduled: [{ name: "x", kind: "scheduled", amount: 100.5, day: 3 }] }, { pinned: [{ name: "food", first: 1.5, second: 0 }] }, { ratchet: { amount: 10.25 } }, { settings: { savings_floor: 99.9 } }, { settings: { buffer_amount: -5 } }]) {
    const r = run(s, o); assert.equal(r.ok, false); assert.equal(r.code, "BAD_INPUT");
  }
  assert.equal(resolveSettings({ starter: { needs: 5000, wants: 3000, savings: 1500, buffer: 600 } }).ok, false, "the ratios must add up to 100%");
  assert.equal(resolveSettings({ starter: { needs: 5000.5, wants: 2999.5, savings: 1500, buffer: 500 } }).ok, false);
  assert.equal(run(s, { month: "2026-13" }).ok, false);
  assert.equal(run(s, { paydays: [PAYDAYS[0]] }).ok, false);
});

test("the starter ratios live in ONE settings table and are used nowhere else", () => {
  assert.deepEqual(SUGGEST_DEFAULTS.starter, { needs: 5000, wants: 3000, savings: 1500, buffer: 500 });
  assert.equal(SUGGEST_DEFAULTS.starter.needs + SUGGEST_DEFAULTS.starter.wants + SUGGEST_DEFAULTS.starter.savings + SUGGEST_DEFAULTS.starter.buffer, 10000);
  const dir = new URL("../src/model/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js") && x !== "suggest-settings.js")) {
    assert.ok(!/needs: ?5000|wants: ?3000|savings: ?1500|buffer: ?500\b/.test(readFileSync(new URL(f, dir), "utf8")), f + " has no copy of the ratios");
  }
  assert.match(readFileSync(new URL("suggest-settings.js", dir), "utf8"), /common rule of\s+thumb[^\n]*NOT advice/i);
});

test("the engine changes nothing it is given, and every suggested line has a one-sentence reason and a source", () => {
  const s = withHistory(), snap = JSON.stringify(s);
  const r = run(s, { scheduled: [{ name: "Test Loan", kind: "installment", amount: 150000, day: 5, months_left: 4 }], pinned: [{ name: "food", first: 1, second: 2 }] });
  assert.equal(JSON.stringify(s), snap);
  for (const l of r.paydays.flatMap((p) => p.lines)) {
    assert.ok(l.reason.length > 10 && l.reason.endsWith("."), l.name + " has a reason");
    assert.ok(["history", "starter"].includes(l.source), l.name + " has a source");
    assert.ok(Number.isSafeInteger(l.amount) && l.amount >= 0);
  }
  assert.ok(r.paydays.every((p) => p.incomeReason.length > 10));
});

test("a month that is not finished yet teaches nothing: planning November from the middle of October skips October", () => {
  const s = withHistory((x) => { logMonth(x, "2026-10", { food: 9000000 }); });
  const u = usableMonths(s, { month: "2026-11", today: "2026-10-20", settings: SUGGEST_DEFAULTS });
  assert.ok(!u.some((x) => x.month === "2026-10"));
  assert.equal(u[0].month, "2026-09");
  assert.equal(usableMonths(s, { month: "2026-11", today: "2026-11-02", settings: SUGGEST_DEFAULTS })[0].month, "2026-10", "once October is over it counts");
  const r = suggestPlan({ state: s, paydays: PAYDAYS, today: "2026-10-20", month: "2026-11" });
  assert.equal(line(r, 0, "Food").amount + line(r, 1, "Food").amount, 600000);
});

test("a subscription category is not counted twice when subscription records exist, and is an ordinary line when they do not", () => {
  const subsCat = (x) => { x.categories.push({ id: "subs", name: "Subscriptions", kind: "expense", role: "subscription" }); for (const m of MONTHS6) spend(x, m + "-05", "subs", 25000); };
  const sub = { id: "s1", name: "Test Streaming", card: "chk", currency: "PHP", amount: 25000, renewal_day: 20, exit_condition: "", review_date: "2026-12-01" };
  const with1 = run(withHistory((x) => { subsCat(x); x.subscriptions = [sub]; }));
  assert.equal(with1.paydays.flatMap((p) => p.lines).filter((l) => /Subscriptions/.test(l.name)).length, 0);
  assert.equal(line(with1, 0, "Test Streaming").amount, 25000);
  const without = run(withHistory(subsCat));
  assert.equal(line(without, 0, "Subscriptions").amount + line(without, 1, "Subscriptions").amount, 25000);
});

test("the overrun buffer is a setting; without one it is the starter share, marked starter", () => {
  const s = withHistory();
  const set = run(s, { settings: { buffer_amount: 200000 } });
  assert.equal(line(set, 0, "Overrun buffer").amount + line(set, 1, "Overrun buffer").amount, 200000);
  assert.match(line(set, 0, "Overrun buffer").reason, /Your overrun buffer setting/); assert.equal(line(set, 0, "Overrun buffer").source, "history");
  const dflt = run(s);
  assert.equal(line(dflt, 0, "Overrun buffer").source, "starter"); assert.match(line(dflt, 0, "Overrun buffer").reason, /5% of pay/);
});

test("goals with a deadline are sized to reach it; the emergency goal takes the rest; a reached goal gets nothing", () => {
  const s = withHistory((x) => {
    x.accounts.push(account({ id: "g1", name: "Test Trip Pot", class: "asset", opening_balance: 100000 }), account({ id: "g2", name: "Test Cushion", class: "asset", opening_balance: 0 }), account({ id: "g3", name: "Test Done Pot", class: "asset", opening_balance: 900000 }));
    x.goals = [{ id: "a", account_id: "g1", name: "Trip Pot", target: 400000, deadline: "2027-02-28", hidden_by_default: false }, { id: "b", account_id: "g2", name: "Cushion", target: 5000000, hidden_by_default: false, role: "emergency" }, { id: "c", account_id: "g3", name: "Done Pot", target: 800000, hidden_by_default: false }];
  });
  const r = run(s), all = (name) => r.paydays.reduce((a, p) => a + (p.lines.find((l) => l.name === name)?.amount ?? 0), 0);
  assert.equal(all("Trip Pot"), 75000, "300,000 still to go over the 4 months left");
  assert.equal(all("Cushion"), 450000 - 75000, "the emergency goal takes what is left");
  assert.equal(all("Done Pot"), 0);
  assert.equal(all("Savings"), 0);
  assert.ok(balances(r));
});

test("a reached goal listed first never takes the leftover: it goes to the first goal still open", () => {
  const t = withHistory((x) => {
    x.accounts.push(account({ id: "g3", name: "Test Done Pot", class: "asset", opening_balance: 900000 }), account({ id: "g4", name: "Test Open Pot", class: "asset", opening_balance: 0 }));
    x.goals = [{ id: "c", account_id: "g3", name: "Done Pot", target: 800000, hidden_by_default: false }, { id: "d", account_id: "g4", name: "Open Pot", target: 9000000, hidden_by_default: false }];
  });
  const u = run(t), got = (name) => u.paydays.reduce((a, p) => a + (p.lines.find((l) => l.name === name)?.amount ?? 0), 0);
  assert.deepEqual([got("Done Pot"), got("Open Pot")], [0, 450000]);
});
