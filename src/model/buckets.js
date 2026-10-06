// Buckets: every spending category sits in one of NEEDS, WANTS or SAVINGS, or under "Other" until its Type or its bucket is known. The bucket follows from
// the category's TYPE; the owner can override any bucket. Pure functions; the answers live in the settings (`bucket_overrides`, `bucket_targets`), so no data
// version changes. A category with no stored Type is counted under the bucket of its NAME'S GUESS (types.js) and flagged unconfirmed until the owner taps.
import { guessType } from "./types.js";
export const BUCKETS = ["need", "want", "savings"];
export const BUCKET_LABELS = { need: "Needs", want: "Wants", savings: "Savings", other: "Other" };

// A category's bucket follows from its TYPE (stored in `role`). Family and Other have no default: the owner is asked once, Need or want.
export const BUCKET_BY_ROLE = {
  rent: "need", food: "need", transport: "need", utilities: "need", debt: "need", essentials: "need", health: "need",
  shopping: "want", dining: "want", fun: "want", subscription: "want",
  invest: "savings",   // spent rather than held: it counts as savings but is shown as "Invest in yourself" and is never part of the emergency fund
};
export const INVESTED_LABEL = "Invest in yourself";

// ONE table of targets, in basis points (5000 = 50%), editable on the Budget screen. A common rule of thumb, not advice.
export const DEFAULT_TARGETS = { need: 5000, want: 3000, savings: 2000 };
export const TARGET_SOURCE = "A common rule of thumb (Warren and Tyagi, All Your Worth, 2005), not advice.";

const whole = (n) => Number.isSafeInteger(n) && n >= 0;

// The targets in force: the owner's, if they are valid, else the defaults.
export function resolveTargets(given) {
  const t = { ...DEFAULT_TARGETS, ...(given ?? {}) };
  return BUCKETS.every((b) => whole(t[b])) && t.need + t.want + t.savings === 10000 ? t : { ...DEFAULT_TARGETS };
}

// Whole percents typed by the owner -> targets, or a plain message.
export function parseTargets({ need, want, savings }) {
  const p = [need, want, savings].map((x) => Number(String(x).trim()));
  if (!p.every((n) => Number.isInteger(n) && n >= 0 && n <= 100)) return { ok: false, message: "Use whole numbers from 0 to 100." };
  if (p[0] + p[1] + p[2] !== 100) return { ok: false, message: `The three must add up to 100. They add up to ${p[0] + p[1] + p[2]}.` };
  return { ok: true, targets: { need: p[0] * 100, want: p[1] * 100, savings: p[2] * 100 } };
}

// The bucket of one spending category: what the owner chose wins, then its Type's bucket, else (no Type yet) the bucket of the name's guess, else "other".
export function bucketOf(category, overrides = {}) {
  const chosen = overrides?.[category.id];
  if (BUCKETS.includes(chosen)) return chosen;
  const type = category.role ?? guessType(category.name);
  return BUCKET_BY_ROLE[type] ?? "other";
}

// Category id -> bucket for every spending category.
export const bucketMap = (categories, overrides) => new Map(categories.filter((c) => c.kind === "expense").map((c) => [c.id, bucketOf(c, overrides)]));

// Spending categories whose Type the owner has not confirmed (none stored): shown "(guess)" when the name suggests one. Never Unlogged.
export const unconfirmed = (categories, skipId) => categories.filter((c) => c.kind === "expense" && c.id !== skipId && !c.role);

// Family and Other have no default bucket: asked once, "Need or want?", and remembered.
export const askBucket = (categories, overrides) => categories.filter((c) => c.kind === "expense" && (c.role === "family" || c.role === "other") && !BUCKETS.includes(overrides?.[c.id]));

// The settings after the owner's answer (null clears it, so the role's default applies again). Only the three buckets can be chosen.
export function withBucket(settings, categoryId, bucket) {
  const next = { ...(settings.bucket_overrides ?? {}) };
  if (bucket == null) delete next[categoryId]; else if (BUCKETS.includes(bucket)) next[categoryId] = bucket; else return settings;
  return { ...settings, bucket_overrides: next };
}

// The starter ratios (basis points, adding to 10000) the suggestion engine uses, from the targets: needs and wants as they are, and the overrun buffer
// taken off the top of savings (never more than the savings target).
export function starterFromTargets(targets, buffer) {
  const t = resolveTargets(targets), b = Math.min(buffer, t.savings);
  return { needs: t.need, wants: t.want, savings: t.savings - b, buffer: b };
}

// The Budget screen's bucket block. budgets: {category_id: centavos} for the month; goals: monthly centavos set aside for Goals; buffer: monthly overrun buffer.
// Savings = Goals + categories in the savings bucket (shown separately as "Invested in yourself" when their role is invest). The buffer is NOT savings.
// Percent is tenths of a percent of the income (1000 = 100.0%), plainly rounded; nothing here ever says red.
export function bucketRows({ categories, overrides, targets, budgets, goals = 0, buffer = 0, income, skipId }) {
  const t = resolveTargets(targets), sum = { need: 0, want: 0, savings: 0, other: 0 };
  let invested = 0;
  const unsure = [];   // categories with a budget whose Type is not confirmed: counted under their guessed bucket (or Other) and flagged
  for (const c of categories) {
    if (c.kind !== "expense") continue;
    const amount = budgets[c.id] ?? 0, b = bucketOf(c, overrides);
    sum[b] += amount;
    if (b === "savings" && c.role === "invest") invested += amount;
    if (!c.role && c.id !== skipId && amount > 0) unsure.push({ id: c.id, name: c.name, amount });
  }
  sum.savings += goals;
  const pct = (a) => (income > 0 ? Math.floor((a * 2000 + income) / (2 * income)) : null);
  const rows = BUCKETS.map((b) => ({ bucket: b, label: BUCKET_LABELS[b], amount: sum[b], tenths: pct(sum[b]), target: t[b] / 10 }));
  if (sum.other > 0) rows.push({ bucket: "other", label: BUCKET_LABELS.other, amount: sum.other, tenths: pct(sum.other), target: null });
  return { rows, invested: { label: INVESTED_LABEL, amount: invested }, buffer: { label: "Overrun buffer", amount: buffer, tenths: pct(buffer) }, targets: t,
    unconfirmed: { amount: unsure.reduce((n, x) => n + x.amount, 0), count: unsure.length, ids: unsure.map((x) => x.id) } };
}
