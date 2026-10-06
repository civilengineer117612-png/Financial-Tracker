// Buckets: every spending category sits in NEEDS, WANTS, SAVINGS or OTHER. The bucket is READ FROM THE CATEGORY'S NAME (bucketwords.js), so there is no
// separate Type to set: "Food" is a need, "Netflix" a want, "Upskill" savings, "Misc" other. A name that is not clear ("Shabu Kain", or a word that depends on
// the person, like family, utang, gym) sits in Other and is asked once: Need, Want, Savings, or Keep in Other. The owner's answer, or any bucket they set by
// hand, is kept in the settings (`bucket_overrides`) and wins. Renaming reads the name again; if that disagrees with a bucket set by hand, the owner is asked.
// Pure functions; everything lives in the settings, so no data version changes.
import { readBucket } from "./bucketwords.js";
export const BUCKETS = ["need", "want", "savings"];
export const CHOICES = ["need", "want", "savings", "other"];   // what the owner can choose: the three, or Keep in Other
export const BUCKET_LABELS = { need: "Needs", want: "Wants", savings: "Savings", other: "Other" };
export const INVESTED_LABEL = "Invest in yourself";   // spending in Savings (a course, books): counted as savings, never part of the emergency fund

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

// The bucket of one spending category: what the owner chose wins, then what its name says, else Other (not clear yet).
export function bucketOf(category, overrides = {}) {
  const chosen = overrides?.[category.id];
  if (CHOICES.includes(chosen)) return chosen;
  return readBucket(category.name).bucket ?? "other";
}

// Category id -> bucket for every spending category.
export const bucketMap = (categories, overrides) => new Map(categories.filter((c) => c.kind === "expense").map((c) => [c.id, bucketOf(c, overrides)]));

// Spending categories whose name is not clear and that the owner has not answered: they sit in Other and are asked once. Never Unlogged.
export const unclear = (categories, overrides, skipId) => categories.filter((c) => c.kind === "expense" && c.id !== skipId && !CHOICES.includes(overrides?.[c.id]) && readBucket(c.name).bucket === null);

// After a rename: when the owner had set the bucket by hand and the new name clearly reads as another bucket, ask which to keep. null when nothing to ask.
export function renameConflict(category, newName, overrides) {
  const mine = overrides?.[category.id], read = readBucket(newName).bucket;
  return CHOICES.includes(mine) && read !== null && read !== mine ? { mine, read } : null;
}

// The settings after the owner's answer (null clears it, so the name is read again). Need, Want, Savings or Other.
export function withBucket(settings, categoryId, bucket) {
  const next = { ...(settings.bucket_overrides ?? {}) };
  if (bucket == null) delete next[categoryId]; else if (CHOICES.includes(bucket)) next[categoryId] = bucket; else return settings;
  return { ...settings, bucket_overrides: next };
}

// The starter ratios (basis points, adding to 10000) the suggestion engine uses, from the targets: needs and wants as they are, and the overrun buffer
// taken off the top of savings (never more than the savings target).
export function starterFromTargets(targets, buffer) {
  const t = resolveTargets(targets), b = Math.min(buffer, t.savings);
  return { needs: t.need, wants: t.want, savings: t.savings - b, buffer: b };
}

// The Budget screen's bucket block. budgets: {category_id: centavos} for the month; goals: monthly centavos set aside for Goals; buffer: monthly overrun buffer.
// Savings = Goals + spending categories in Savings (shown together as "Invest in yourself"). The buffer is NOT savings. Unclear names are counted in Other and
// flagged (amount and how many) until the owner answers.
// Percent is tenths of a percent of the income (1000 = 100.0%), plainly rounded; nothing here ever says red.
export function bucketRows({ categories, overrides, targets, budgets, goals = 0, buffer = 0, income, skipId }) {
  const t = resolveTargets(targets), sum = { need: 0, want: 0, savings: 0, other: 0 };
  let invested = 0;
  const unsure = [];   // unclear names with a budget, not yet answered: counted in Other and flagged
  for (const c of categories) {
    if (c.kind !== "expense") continue;
    const amount = budgets[c.id] ?? 0, b = bucketOf(c, overrides);
    sum[b] += amount;
    if (b === "savings") invested += amount;
    if (c.id !== skipId && amount > 0 && !CHOICES.includes(overrides?.[c.id]) && readBucket(c.name).bucket === null) unsure.push({ id: c.id, name: c.name, amount });
  }
  sum.savings += goals;
  const pct = (a) => (income > 0 ? Math.floor((a * 2000 + income) / (2 * income)) : null);
  const rows = BUCKETS.map((b) => ({ bucket: b, label: BUCKET_LABELS[b], amount: sum[b], tenths: pct(sum[b]), target: t[b] / 10 }));
  if (sum.other > 0) rows.push({ bucket: "other", label: BUCKET_LABELS.other, amount: sum.other, tenths: pct(sum.other), target: null });
  return { rows, invested: { label: INVESTED_LABEL, amount: invested }, buffer: { label: "Overrun buffer", amount: buffer, tenths: pct(buffer) }, targets: t,
    unconfirmed: { amount: unsure.reduce((n, x) => n + x.amount, 0), count: unsure.length, ids: unsure.map((x) => x.id) } };
}
