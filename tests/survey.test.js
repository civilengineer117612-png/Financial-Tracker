import { test } from "node:test";
import assert from "node:assert/strict";
import { validateShape, validateState, weekEndingOn, autoFillSurvey, planSurveyResponse, surveyReview, editDraft, planCheckIn } from "../src/model/index.js";
import { makeState, account, tx, entry, commit } from "./fixtures.js";

function s0() {
  const s = makeState();
  s.accounts.push(account({ id: "cash", name: "Test Cash", class: "asset", opening_balance: 100000 }));
  s.categories.push({ id: "unlogged", name: "Unlogged", kind: "expense" });
  return s;
}
// Record a weekly check-in that finds `counted` in the wallet.
function checkIn(s, n, date, counted) {
  const p = planCheckIn(s, { id: "ci" + n, transaction_id: "rec" + n, date, account_id: "cash", counted_balance: counted, unlogged_category_id: "unlogged" });
  if (p.transaction) commit(s, p);
  return p;
}
const WEEK = { week_start: "2026-03-09", week_end: "2026-03-15" };
const fill = (s) => autoFillSurvey(s, { unlogged_category_id: "unlogged", ...WEEK });

// ---------- weeks ----------
test("a week is the 7 days ending on the check-in day, across month ends", () => {
  assert.deepEqual(weekEndingOn("2026-03-15"), { week_start: "2026-03-09", week_end: "2026-03-15" });
  assert.deepEqual(weekEndingOn("2026-03-02"), { week_start: "2026-02-24", week_end: "2026-03-02" });
});

// ---------- Q1 auto-fill ----------
test("Q1: count and total of money found MISSING at check-ins this week", () => {
  const s = s0();
  checkIn(s, 1, "2026-03-10", 95000);   // 50.00 missing
  checkIn(s, 2, "2026-03-14", 90000);   // 50.00 more missing
  const q = fill(s);
  assert.deepEqual([q.q1_missed_count, q.q1_missed_amount], [2, 10000]);
});
test("Q1: found money (a gain) and matching counts are not missed transactions", () => {
  const s = s0();
  checkIn(s, 1, "2026-03-10", 102500);   // 25.00 gained
  checkIn(s, 2, "2026-03-14", 102500);   // matches: no difference
  assert.deepEqual([fill(s).q1_missed_count, fill(s).q1_missed_amount], [0, 0]);
});
test("Q1: differences outside the week are left out", () => {
  const s = s0();
  checkIn(s, 1, "2026-03-08", 95000);
  checkIn(s, 2, "2026-03-16", 90000);
  assert.equal(fill(s).q1_missed_count, 0);
});
test("Q1: only reconciliations count, not ordinary spending logged to Unlogged by hand", () => {
  const s = s0();
  commit(s, { transaction: tx({ id: "m", date: "2026-03-10" }), entries: [
    entry({ transaction_id: "m", category_id: "unlogged", amount: 7000 }), entry({ transaction_id: "m", account_id: "chk", amount: -7000 }) ] });
  assert.equal(fill(s).q1_missed_count, 0);
});

// ---------- Q4 auto-fill and edit tracking ----------
const photoTx = (o = {}) => tx({ id: "ph", date: "2026-03-10", source: "photo", edited_before_verify: false, ...o });
const photoEntries = (amt = 9500) => [
  entry({ transaction_id: "ph", category_id: "food", amount: amt }), entry({ transaction_id: "ph", account_id: "chk", amount: -amt }) ];

test("a photo/voice transaction must say whether it was edited; other sources must not claim edits", () => {
  assert.equal(validateShape("Transaction", tx({ source: "photo" })).length, 1);
  assert.deepEqual(validateShape("Transaction", tx({ source: "voice", edited_before_verify: false })), []);
  assert.equal(validateShape("Transaction", tx({ source: "manual", edited_before_verify: true })).length, 1);
  assert.deepEqual(validateShape("Transaction", tx({ source: "manual" })), []);
});
test("editing a photo draft sets the flag; re-saving it unchanged does not", () => {
  const s = s0();
  commit(s, { transaction: photoTx(), entries: photoEntries() });
  const same = editDraft(s, { transaction: photoTx(), entries: photoEntries() });
  assert.equal(same.ok, true);
  assert.equal(same.transaction.edited_before_verify, false);
  const amountFixed = editDraft(s, { transaction: photoTx(), entries: photoEntries(9000) });
  assert.equal(amountFixed.transaction.edited_before_verify, true);
  const payeeFixed = editDraft(s, { transaction: photoTx({ payee: "Fixed Name" }), entries: photoEntries() });
  assert.equal(payeeFixed.transaction.edited_before_verify, true);
});
test("entry order alone is not an edit; once flagged it stays flagged", () => {
  const s = s0();
  commit(s, { transaction: photoTx(), entries: photoEntries() });
  assert.equal(editDraft(s, { transaction: photoTx(), entries: [...photoEntries()].reverse() }).transaction.edited_before_verify, false);
  commit(s, editDraft(s, { transaction: photoTx({ payee: "Fixed" }), entries: photoEntries() }));
  assert.equal(editDraft(s, { transaction: photoTx({ payee: "Fixed" }), entries: photoEntries() }).transaction.edited_before_verify, true);
});
test("manual drafts are edited freely and never get the flag", () => {
  const s = s0();
  commit(s, { transaction: tx({ id: "m" }), entries: [ entry({ transaction_id: "m", category_id: "food", amount: 100 }), entry({ transaction_id: "m", account_id: "chk", amount: -100 }) ] });
  const r = editDraft(s, { transaction: tx({ id: "m", payee: "Changed" }), entries: [ entry({ transaction_id: "m", category_id: "food", amount: 100 }), entry({ transaction_id: "m", account_id: "chk", amount: -100 }) ] });
  assert.equal(r.ok, true);
  assert.equal("edited_before_verify" in r.transaction, false);
});
test("editing rules: draft only, no verifying, source fixed, must exist", () => {
  const s = s0();
  commit(s, { transaction: photoTx(), entries: photoEntries() });
  assert.equal(editDraft(s, { transaction: photoTx({ id: "nope" }), entries: photoEntries() }).violations[0].code, "UNKNOWN_TRANSACTION");
  assert.equal(editDraft(s, { transaction: photoTx({ status: "verified", verified_at: "2026-03-11T08:00:00.000+08:00" }), entries: photoEntries() }).violations[0].code, "NOT_A_DRAFT");
  assert.equal(editDraft(s, { transaction: photoTx({ source: "manual", edited_before_verify: undefined }), entries: photoEntries() }).violations[0].code, "SOURCE_FIXED");
  commit(s, { transaction: photoTx({ id: "done", status: "verified", verified_at: "2026-03-11T08:00:00.000+08:00" }), entries: photoEntries().map((e) => ({ ...e, transaction_id: "done" })) });
  assert.equal(editDraft(s, { transaction: photoTx({ id: "done" }), entries: photoEntries().map((e) => ({ ...e, transaction_id: "done" })) }).violations[0].code, "NOT_A_DRAFT");
});
test("an invalid edit is still rejected by the normal save checks", () => {
  const s = s0();
  commit(s, { transaction: photoTx(), entries: photoEntries() });
  const r = editDraft(s, { transaction: photoTx(), entries: [entry({ transaction_id: "ph", category_id: "food", amount: 9500 }), entry({ transaction_id: "ph", account_id: "chk", amount: -9400 })] });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === "UNBALANCED"));
});
test("Q4: verified photo/voice transactions edited before verifying, in the verified week", () => {
  const s = s0();
  const v = (id, source, edited, at) => commit(s, { transaction: tx({ id, source, edited_before_verify: edited, status: "verified", verified_at: at, date: "2026-03-09" }),
    entries: [ entry({ transaction_id: id, category_id: "food", amount: 100 }), entry({ transaction_id: id, account_id: "chk", amount: -100 }) ] });
  v("a", "photo", true, "2026-03-10T08:00:00.000+08:00");    // counts
  v("b", "voice", true, "2026-03-15T23:30:00.000+08:00");    // counts (Philippine date is still the 15th)
  v("c", "photo", false, "2026-03-11T08:00:00.000+08:00");   // not edited
  v("d", "photo", true, "2026-03-16T08:00:00.000+08:00");    // verified next week
  v("e", "photo", true, "2026-03-09T00:05:00.000+08:00");    // first day of the week counts
  v("f", "photo", true, "2026-03-08T23:55:00.000+08:00");    // last day of the previous week does not
  assert.equal(fill(s).q4_corrections_count, 3);
});
test("Q4 is 0 when no photo or voice capture exists yet", () => {
  assert.equal(fill(s0()).q4_corrections_count, 0);
});

// ---------- storing the response ----------
test("a response combines auto-filled Q1/Q4 with the answers; stored per week", () => {
  const s = s0();
  checkIn(s, 1, "2026-03-10", 95000);
  const p = planSurveyResponse(fill(s), { q2_ease: 4, q3_annoyance: "Too many taps" });
  assert.equal(p.ok, true);
  assert.deepEqual(p.response, { id: "survey:2026-03-09", ...WEEK, q1_missed_count: 1, q1_missed_amount: 5000, q2_ease: 4, q3_annoyance: "Too many taps", q4_corrections_count: 0 });
});
test("the owner's confirmation of Q1 overrides the auto-filled figures", () => {
  const p = planSurveyResponse({ ...WEEK, q1_missed_count: 1, q1_missed_amount: 5000, q4_corrections_count: 0 }, { q2_ease: 3, q1_missed_count: 3, q1_missed_amount: 12000 });
  assert.deepEqual([p.response.q1_missed_count, p.response.q1_missed_amount], [3, 12000]);
});
test("ease must be a whole number 1 to 5; annoyance may be empty", () => {
  const auto = { ...WEEK, q1_missed_count: 0, q1_missed_amount: 0, q4_corrections_count: 0 };
  for (const bad of [0, 6, 2.5, undefined, "4"]) assert.equal(planSurveyResponse(auto, { q2_ease: bad }).ok, false, String(bad));
  const ok = planSurveyResponse(auto, { q2_ease: 5 });
  assert.equal(ok.ok, true);
  assert.equal(ok.response.q3_annoyance, "");
});
test("answering the same week again yields the same id, so it replaces", () => {
  const auto = { ...WEEK, q1_missed_count: 0, q1_missed_amount: 0, q4_corrections_count: 0 };
  assert.equal(planSurveyResponse(auto, { q2_ease: 2 }).response.id, planSurveyResponse(auto, { q2_ease: 5 }).response.id);
});
test("a week ending before it starts, or a negative amount, is rejected", () => {
  const base = { id: "x", week_start: "2026-03-09", week_end: "2026-03-15", q1_missed_count: 0, q1_missed_amount: 0, q2_ease: 3, q3_annoyance: "", q4_corrections_count: 0 };
  assert.deepEqual(validateShape("SurveyResponse", base), []);
  assert.equal(validateShape("SurveyResponse", { ...base, week_end: "2026-03-08" }).length, 1);
  assert.equal(validateShape("SurveyResponse", { ...base, q1_missed_amount: -1 }).length, 1);
});
test("survey rows are part of the validated, backed-up state", () => {
  const s = s0();
  s.surveyResponses = [{ id: "x", week_start: "2026-03-09", week_end: "2026-03-15", q1_missed_count: 0, q1_missed_amount: 0, q2_ease: 9, q3_annoyance: "", q4_corrections_count: 0 }];
  assert.match(validateState(s)[0].message, /surveyResponses\[0\]/);
});

// ---------- review view ----------
test("review: weeks oldest first with the Unlogged trend; ready after 4 weeks", () => {
  const s = s0();
  checkIn(s, 1, "2026-03-10", 90000);    // wk1: 100.00 missing
  checkIn(s, 2, "2026-03-17", 85000);    // wk2: 50.00 missing
  checkIn(s, 3, "2026-03-24", 85000);    // wk3: nothing
  const weeks = ["2026-03-15", "2026-03-22", "2026-03-29"].map((end) => {
    const r = weekEndingOn(end);
    return planSurveyResponse(autoFillSurvey(s, { unlogged_category_id: "unlogged", ...r }), { q2_ease: 4 }).response;
  });
  const review = surveyReview(s, [weeks[2], weeks[0], weeks[1]], "unlogged");   // given out of order on purpose
  assert.deepEqual(review.weeks.map((w) => w.week_end), ["2026-03-15", "2026-03-22", "2026-03-29"]);
  assert.deepEqual(review.weeks.map((w) => w.unlogged_net), [10000, 5000, 0]);
  assert.deepEqual(review.trend, { first: 10000, last: 0, change: -10000 });
  assert.equal(review.ready, false);
  const four = surveyReview(s, [...weeks, { ...weeks[0], id: "w4", week_start: "2026-03-30", week_end: "2026-04-05" }], "unlogged");
  assert.equal(four.ready, true);
});
test("review with one week has no trend; with none, nothing", () => {
  const s = s0();
  assert.equal(surveyReview(s, [], "unlogged").trend, null);
  assert.deepEqual(surveyReview(s, [], "unlogged").weeks, []);
});
