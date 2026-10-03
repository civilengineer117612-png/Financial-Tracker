// Addendum 2-3: the weekly survey shown at the end of each weekly check-in.
//   Q1 missed transactions  AUTO-FILLED from the check-in reconciliations; user confirms
//   Q2 ease 1-5            user answers
//   Q3 annoyance           user answers (free text)
//   Q4 photo/voice fixes   AUTO-FILLED from verification edits (0 until Phase 2)
// Each week is stored with its date range; after about 4 weeks a review view appears.
import { validateShape } from "./schema.js";
import { unloggedTotal } from "./checkin.js";

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// The weekly check-in day is the owner's choice, so a week is "the 7 days ending on" it.
export function weekEndingOn(date) {
  return { week_start: iso(Date.parse(date) - 6 * DAY), week_end: date };
}

// Q1: each reconciliation that found money MISSING is one difference (an unexplained
// gain is not a missed transaction). Count and total of those differences in the week.
// Q4: photo/voice transactions verified this week that were edited before verifying.
export function autoFillSurvey(state, { unlogged_category_id, week_start, week_end }) {
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  let count = 0, amount = 0;
  for (const e of state.entries) {
    if (e.category_id !== unlogged_category_id || e.amount <= 0) continue;
    const t = txById.get(e.transaction_id);
    if (t && t.source === "reconciliation" && t.date >= week_start && t.date <= week_end) { count += 1; amount += e.amount; }
  }
  const corrections = state.transactions.filter((t) =>
    (t.source === "photo" || t.source === "voice") && t.status === "verified" && t.edited_before_verify === true &&
    t.verified_at.slice(0, 10) >= week_start && t.verified_at.slice(0, 10) <= week_end).length;
  return { week_start, week_end, q1_missed_count: count, q1_missed_amount: amount, q4_corrections_count: corrections };
}

// Builds the row to store. The id is fixed per week, so answering the same week again
// REPLACES that week's row instead of adding a second one.
// answers: {q2_ease, q3_annoyance, q1_missed_count?, q1_missed_amount?}; the Q1 fields are
// the owner's confirmation and win over the auto-filled figures when given.
export function planSurveyResponse(autoFilled, answers) {
  const response = {
    id: "survey:" + autoFilled.week_start,
    week_start: autoFilled.week_start, week_end: autoFilled.week_end,
    q1_missed_count: answers.q1_missed_count ?? autoFilled.q1_missed_count,
    q1_missed_amount: answers.q1_missed_amount ?? autoFilled.q1_missed_amount,
    q2_ease: answers.q2_ease,
    q3_annoyance: answers.q3_annoyance ?? "",
    q4_corrections_count: autoFilled.q4_corrections_count,
  };
  const violations = validateShape("SurveyResponse", response);
  return { ok: violations.length === 0, violations, response };
}

// The review view: one row per week, oldest first, Unlogged trend alongside Q1-Q4.
// `ready` turns true once there are about 4 weeks of answers (addendum 2).
export function surveyReview(state, responses, unloggedCategoryId, minWeeks = 4) {
  const rows = [...responses].sort((a, b) => (a.week_start < b.week_start ? -1 : 1)).map((r) => ({
    week_start: r.week_start, week_end: r.week_end,
    unlogged_net: unloggedTotal(state, unloggedCategoryId, r.week_start, r.week_end),
    q1_missed_count: r.q1_missed_count, q1_missed_amount: r.q1_missed_amount,
    q2_ease: r.q2_ease, q3_annoyance: r.q3_annoyance, q4_corrections_count: r.q4_corrections_count,
  }));
  const trend = rows.length < 2 ? null : {
    first: rows[0].unlogged_net, last: rows.at(-1).unlogged_net, change: rows.at(-1).unlogged_net - rows[0].unlogged_net,
  };
  return { ready: rows.length >= minWeeks, weeks: rows, trend };
}
