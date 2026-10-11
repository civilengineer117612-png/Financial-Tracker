import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, newPlanForm, planTextFromForm, planFormStatus, formFromPlan, addPlan, planInEffect, encryptLedgerBackup, decryptLedgerBackup, upgradeLedger, selfCheck, LEDGER_VERSION } from "../src/model/index.js";

// Invented names and amounts only.
const twice = (over = {}) => ({ ...newPlanForm("2026-10-15"), p1: "10000", d1: "15", p2: "24000", d2: "last", count: 3,
  n0: "Rent", k0: "expense", a0: "0", b0: "5000", n1: "Food", k1: "expense", a1: "6000", b1: "6000", n2: "Apartment Fund", k2: "goal", a2: "4000", b2: "13000", ...over });

test("a typed plan becomes plan text that the same reader accepts, with every amount in centavos", () => {
  const t = planTextFromForm(twice()); assert.equal(t.ok, true);
  const r = parsePlan(t.text); assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.plan.paydays.map((p) => [p.day, p.income]), [[15, 1000000], ["last", 2400000]]);
  assert.deepEqual(r.plan.lines.map((l) => [l.name, l.kind, l.first, l.second]), [["Rent", "expense", 0, 500000], ["Food", "expense", 600000, 600000], ["Apartment Fund", "goal", 400000, 1300000]]);
  assert.equal(r.plan.effective_from, "2026-10-15");
});
test("centavos typed in a box are kept, an empty amount is zero, and blank lines are left out", () => {
  const t = planTextFromForm(twice({ p1: "10,000.50", a0: "", n3: "", a3: "", b3: "", count: 4, a1: "6000.50" })); assert.equal(t.ok, true);
  assert.deepEqual(JSON.parse(t.text).lines.map((l) => l.first), [0, 600050, 400000], "three lines: the blank fourth is not a line");
  assert.equal(JSON.parse(t.text).paydays[0].expected_income, 1000050);
});
test("a plan paid once a month has one payday and no second amounts", () => {
  const f = { ...newPlanForm("2026-10-01"), twice: false, d1: "5", p1: "20000", count: 2, n0: "Rent", a0: "8000", n1: "Food", a1: "12000" };
  const r = parsePlan(planTextFromForm(f).text); assert.equal(r.ok, true, r.error);
  assert.equal(r.plan.paydays.length, 1); assert.deepEqual(r.plan.lines.map((l) => [l.first, l.second]), [[800000, 0], [1200000, 0]]);
});
test("what the reader refuses is still refused: lines that do not add up to the pay, a repeated name, a bad day", () => {
  assert.match(parsePlan(planTextFromForm(twice({ a1: "5000" })).text).error, /Food|add up|income|sum|1st payday/i);
  assert.match(parsePlan(planTextFromForm(twice({ n1: "rent" })).text).error, /twice/);
  assert.match(parsePlan(planTextFromForm(twice({ d1: "31" })).text).error, /1 to 28/);
  assert.match(parsePlan(planTextFromForm(twice({ d2: "10" })).text).error, /2nd payday/);
  assert.equal(parsePlan(planTextFromForm(twice({ count: 3, n0: "", a0: "", b0: "", n1: "", a1: "", b1: "", n2: "", a2: "", b2: "" })).text).ok, false, "no lines");
});
test("an amount that is not a number is named, never guessed", () => {
  assert.match(planTextFromForm(twice({ p1: "ten thousand" })).error, /pay amount/);
  assert.match(planTextFromForm(twice({ b1: "12x" })).error, /line 2/);
});
test("the status shows what is left to place on each payday, and goes negative when too much is placed", () => {
  assert.deepEqual(planFormStatus(twice()), [{ pay: 1000000, placed: 1000000, left: 0 }, { pay: 2400000, placed: 2400000, left: 0 }]);
  assert.deepEqual(planFormStatus(twice({ a1: "7000" }))[0], { pay: 1000000, placed: 1100000, left: -100000 });
  assert.deepEqual(planFormStatus({ ...twice(), twice: false }).length, 1);
  assert.deepEqual(planFormStatus(twice({ p1: "oops" }))[0].pay, 0, "an unreadable pay counts as zero in the helper; the text step names the problem");
});

test("a saved plan fills the form again: typing nothing new gives back the same plan, only dated later", () => {
  const first = parsePlan(planTextFromForm(twice({ p1: "10000.50", a1: "6000.50" })).text).plan;
  const f = formFromPlan(first, "2026-12-01");
  assert.equal(f.start, "2026-12-01"); assert.equal(f.p1, "10000.50"); assert.equal(f.a1, "6000.50"); assert.equal(f.b0, "5000"); assert.equal(f.k2, "goal"); assert.equal(f.count, 3);
  const again = parsePlan(planTextFromForm(f).text);
  assert.equal(again.ok, true, again.error);
  assert.deepEqual({ ...again.plan, effective_from: first.effective_from }, first, "the same paydays and lines to the centavo");
  const one = parsePlan(planTextFromForm({ ...newPlanForm("2026-10-01"), twice: false, d1: "5", p1: "20000", count: 1, n0: "Rent", a0: "20000" }).text).plan;
  const g = formFromPlan(one, "2026-11-01"); assert.equal(g.twice, false); assert.equal(g.d2, "last");
  assert.equal(parsePlan(planTextFromForm(g).text).ok, true);
});
test("a typed plan survives an encrypted backup and an upgrade, and is still the plan in effect", async () => {
  const typed = parsePlan(planTextFromForm(twice()).text).plan, added = addPlan([], typed); assert.equal(added.ok, true);
  const state = Object.fromEntries(["accounts", "goals", "envelopes", "transactions", "entries", "categories", "categoryMaps", "rules", "templates", "payeeRules", "subscriptions", "checkIns", "attachments", "tags", "foreignAmounts", "surveyResponses", "payslips", "payslipLines", "payslipRevisions", "presets", "schedules", "scheduleChanges"].map((k) => [k, []]));
  const ledger = { v: LEDGER_VERSION - 1, rev: 3, saved_at: "2026-10-11T09:00:00.000+08:00", state, settings: { plans: added.plans } };
  const back = await decryptLedgerBackup(await encryptLedgerBackup(ledger, "correct horse battery"), "correct horse battery");
  assert.deepEqual(back.settings.plans, added.plans, "the plan comes back exactly");
  const up = upgradeLedger(back, { now: new Date("2026-10-11T00:00:00Z") });
  assert.equal(up.ok, true, up.error); assert.deepEqual(up.ledger.settings.plans, added.plans);
  assert.equal(planInEffect(up.ledger.settings.plans, "2026-10-20").lines.length, 3, "and it is the plan in effect");
});
