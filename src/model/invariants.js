// Section 7.1 "Checks on Every Save". Each check is a pure function that returns
// a list of violations ({code, severity, message}); none of them touch storage.
import { deepEqual } from "./util.js";
import { reserveShortfalls } from "./balances.js";

const err = (code, message, extra = {}) => ({ code, severity: "error", message, ...extra });
const warn = (code, message, extra = {}) => ({ code, severity: "warning", message, ...extra });

// 1. Entries of each transaction sum to zero (and there are at least two of them).
export function checkEntriesBalance(entries) {
  if (entries.length < 2) return [err("TOO_FEW_ENTRIES", "a transaction needs at least two entries")];
  const sum = entries.reduce((s, e) => s + e.amount, 0);
  return sum === 0 ? [] : [err("UNBALANCED", "entries sum to " + sum + " centavos, expected 0", { sum })];
}

// Everything an entry points at must exist, or the balance maths silently skips it.
export function checkReferences(state, transaction, entries) {
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  const categories = new Set(state.categories.map((c) => c.id));
  const envelopes = new Map(state.envelopes.map((e) => [e.id, e]));
  const out = [];
  for (const e of entries) {
    if (e.transaction_id !== transaction.id) out.push(err("WRONG_TRANSACTION", "entry belongs to " + e.transaction_id));
    const account = e.account_id != null ? accounts.get(e.account_id) : null;
    if (e.account_id != null && !account) out.push(err("UNKNOWN_ACCOUNT", "no account " + e.account_id));
    if (e.category_id != null && !categories.has(e.category_id)) out.push(err("UNKNOWN_CATEGORY", "no category " + e.category_id));
    if (e.envelope_id != null) {
      const env = envelopes.get(e.envelope_id);
      if (!env) out.push(err("UNKNOWN_ENVELOPE", "no envelope " + e.envelope_id));
      else if (env.account_id !== e.account_id) out.push(err("ENVELOPE_MISMATCH", "envelope " + env.id + " is not inside account " + e.account_id));
    }
    // Pending/posted only means something on a card liability, and is required there.
    const isCard = Boolean(account) && account.class === "liability";
    if (isCard && e.card_state == null) out.push(err("CARD_STATE_MISSING", "entry on card account " + account.id + " needs card_state"));
    if (account && !isCard && e.card_state != null) out.push(err("CARD_STATE_UNEXPECTED", "card_state only applies to liability accounts"));
  }
  return out;
}

// 2. Reserve balance >= card outstanding (pending + posted).
// WARN ONLY, never block: the card purchase already happened in real life, so refusing
// to record it would make the ledger lie. `worsened` tells the UI whether this save
// created or deepened the shortfall.
export function checkReserve(accounts, entriesBefore, entriesAfter) {
  const before = new Map(reserveShortfalls(accounts, entriesBefore).map((r) => [r.reserve_id, r.shortfall]));
  const out = [];
  for (const r of reserveShortfalls(accounts, entriesAfter)) {
    if (r.shortfall === 0) continue;
    out.push(warn("RESERVE_BELOW_OUTSTANDING",
      "reserve " + r.reserve_id + " is " + r.shortfall + " centavos short of card outstanding",
      { reserve_id: r.reserve_id, card_id: r.card_id, shortfall: r.shortfall, worsened: r.shortfall > (before.get(r.reserve_id) ?? 0) }));
  }
  return out;
}

// 4. Duplicate: the same payment shown twice (a screenshot taken again). It is a WARNING with the older entry named, never a refusal: the app offers to
// link the new photo to the entry already there instead of adding a second. Two ways to be the same:
//  - the same reference number and the same amount, within 3 days of each other;
//  - the same two accounts, the same amount, the same day and the same time on the screenshot.
// Amount alone is never enough, and an entry with neither a reference nor a screenshot time can never be flagged.
// "Amount" of a transaction = sum of its positive entries (its gross size).
const grossAmount = (entries) => entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
const dayGap = (a, b) => Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000;
const ends = (entries) => ({ from: entries.find((e) => e.account_id != null && e.amount < 0)?.account_id ?? null, to: entries.find((e) => e.account_id != null && e.amount > 0)?.account_id ?? null });

// The id of the entry already saved that this one repeats, or null.
export function findDuplicate(state, transaction, entries) {
  const ref = (transaction.reference_no ?? "").trim(), time = (transaction.shot_time ?? "").trim();
  if (!ref && !time) return null;
  const amount = grossAmount(entries), mine = ends(entries);
  for (const other of state.transactions) {
    if (other.id === transaction.id) continue;
    const oe = state.entries.filter((e) => e.transaction_id === other.id);
    if (grossAmount(oe) !== amount) continue;
    if (ref && (other.reference_no ?? "").trim() === ref && dayGap(other.date, transaction.date) <= 3) return other.id;
    const theirs = ends(oe);
    if (time && (other.shot_time ?? "").trim() === time && other.date === transaction.date && mine.from && mine.from === theirs.from && mine.to === theirs.to) return other.id;
  }
  return null;
}

export function checkDuplicate(state, transaction, entries) {
  const other = findDuplicate(state, transaction, entries);
  return other ? [warn("DUPLICATE_REFERENCE", "looks like transaction " + other + " (same payment shown again)", { duplicate_of: other })] : [];
}

// 5. Rules are append-only: every previously saved row must still be present and
// byte-for-byte unchanged. New rows (new ids) are the only allowed difference.
export function checkRulesAppendOnly(previousRules, nextRules) {
  const out = [];
  const next = new Map();
  for (const r of nextRules) {
    if (next.has(r.id)) out.push(err("RULE_DUPLICATE_ID", "two rules share id " + r.id));
    next.set(r.id, r);
  }
  for (const old of previousRules) {
    const now = next.get(old.id);
    if (!now) out.push(err("RULE_DELETED", "rule " + old.id + " was removed"));
    else if (!deepEqual(old, now)) out.push(err("RULE_EDITED", "rule " + old.id + " was edited; add a new dated row instead"));
  }
  return out;
}

// 3. Only verified transactions count toward budgets; drafts show as pending.
// This is a read-time filter rather than a save rejection.
export const countsTowardBudget = (transaction) => transaction.status === "verified";

export function splitByBudgetStatus(transactions) {
  return {
    counted: transactions.filter(countsTowardBudget),
    pending: transactions.filter((t) => !countsTowardBudget(t)),
  };
}
