// How the money set aside each month is shared between the Goals. Each savings category IS a Goal, so there is no second copy of anything: the
// owner's typed monthly amounts (settings `goal_monthly`, by goal id) and the shares (settings `goal_shares`, whole percents by goal id) are the only inputs
// besides the Goals themselves. Pure functions; the same rule is used by the suggestion engine and by the Budget screen.
//
// PRIORITY, in this order:
//  1. A typed amount pins: that goal gets exactly what was typed, and it comes out of the total first.
//  2. Goals with a finish date get what they need each month to make the date (never more than what is left).
//  3. The emergency fund (the goal holding that role) takes what is left, but only until its target is reached.
//  4. What is still left is shared between the other open goals by their percentages; with none set, equally.
// A goal that has reached its target gets nothing unless a figure was typed for it. Whatever no goal can take is shown as "Savings" (not placed yet).
import { requiredPerMonth } from "./goals.js";

export const UNPLACED_NAME = "Savings";
const whole = (n) => Number.isSafeInteger(n) && n >= 0;

// goals: [{id, name, role?, deadline?}]; progress: Map(goal_id -> goalProgress or null); total: centavos to set aside this month; month: "YYYY-MM".
// Returns {parts: [{goal_id?, name, amount, why, pinned?}], pinnedTotal}. The parts add up to max(total, pinned amounts), exactly.
export function splitSavings({ goals, progress, month, total, pins = {}, shares = {} }) {
  const known = goals.filter((g) => progress.get(g.id));
  const parts = [];
  const pinned = known.filter((g) => whole(pins[g.id]));
  for (const g of pinned) parts.push({ goal_id: g.id, name: g.name, amount: pins[g.id], why: "The amount you typed, so it is not changed.", pinned: true });
  const pinnedTotal = pinned.reduce((n, g) => n + pins[g.id], 0);
  let pool = Math.max(0, total - pinnedTotal);
  const free = known.filter((g) => !pinned.includes(g) && !progress.get(g.id).reached);
  const done = new Set();
  for (const g of free) {   // 2. finish dates
    if (!g.deadline) continue;
    const need = requiredPerMonth(progress.get(g.id), g.deadline.slice(0, 7), month);
    if (!need) continue;
    const give = Math.min(need.perMonth, pool);
    parts.push({ goal_id: g.id, name: g.name, amount: give, why: "Sized to reach its finish date." }); pool -= give; done.add(g.id);
  }
  const ef = free.find((g) => g.role === "emergency" && !done.has(g.id));   // 3. the emergency fund, until its target
  if (ef) {
    const p = progress.get(ef.id), give = Math.min(pool, p.remaining ?? pool);
    parts.push({ goal_id: ef.id, name: ef.name, amount: give, why: p.target == null ? "The emergency fund comes first." : "The emergency fund comes first, until it reaches its target." });
    pool -= give; done.add(ef.id);
  }
  const rest = free.filter((g) => !done.has(g.id));   // 4. the others, by their percentages
  if (rest.length && pool > 0) {
    const set = rest.some((g) => whole(shares[g.id]));
    let w = rest.map((g) => (set ? (whole(shares[g.id]) ? shares[g.id] : 0) : 1));
    if (w.every((x) => x === 0)) w = w.map(() => 1);   // every share typed as 0: share equally rather than lose the money
    const sum = w.reduce((a, b) => a + b, 0), out = w.map((x) => Math.floor((pool * x) / sum));
    const big = w.indexOf(Math.max(...w)); out[big] += pool - out.reduce((a, b) => a + b, 0);
    rest.forEach((g, i) => parts.push({ goal_id: g.id, name: g.name, amount: out[i], why: set ? "Shared by the percentages you set." : "Shared equally; set your own percentages in Budget." }));
    pool = 0;
  } else if (rest.length) rest.forEach((g) => parts.push({ goal_id: g.id, name: g.name, amount: 0, why: "Nothing left to share." }));
  if (pool > 0) parts.push({ name: UNPLACED_NAME, amount: pool, why: known.length ? "No open goal can take it yet. Add a savings category." : "You have no goal yet. Add a savings category to hold it." });
  return { parts, pinnedTotal };
}

// Whole percents typed by the owner -> basis points by goal id, or a plain message. The goals shown must add up to exactly 100.
export function parseShares(goalIds, typed) {
  const p = goalIds.map((id) => Number(String(typed[id] ?? "").trim()));
  if (!p.every((n) => Number.isInteger(n) && n >= 0 && n <= 100)) return { ok: false, message: "Use whole numbers from 0 to 100." };
  const sum = p.reduce((a, b) => a + b, 0);
  if (sum !== 100) return { ok: false, message: `The percentages must add up to 100. They add up to ${sum}.` };
  return { ok: true, shares: Object.fromEntries(goalIds.map((id, i) => [id, p[i] * 100])) };
}

// The goals that share the remainder (no finish date, not the emergency fund, not reached): the ones the percentages are for.
export const shareableGoals = (goals, progress) => goals.filter((g) => !g.deadline && g.role !== "emergency" && progress.get(g.id) && !progress.get(g.id).reached);
