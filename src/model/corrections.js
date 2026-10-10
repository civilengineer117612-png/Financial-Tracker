// Corrections at the Weekly review. A verified entry is final: it is never edited and never deleted. A mistake found at the weekly count is put right
// the way a bookkeeper does it: a NEW verified entry that cancels the old one (`reverses` names it), and, for a plain expense, a fresh DRAFT with the old
// values (`corrects` names the entry it replaces) that waits in Verify for the right amount. All three stay visible; nothing is rewritten.
import { checkTransactionSave } from "./index.js";
import { planExpense, applyDrafts } from "./drafts.js";
import { isFeeId } from "./transfers.js";
import { phTimestamp } from "./util.js";

export const CORRECTION_DAYS = 14;   // an entry verified in the last 14 days (this week and the one before) can be corrected
const NOT_CORRECTABLE = ["reconciliation", "correction", "template"];   // a count gap, a correction itself, and scheduled payments (they have their own "new amount")
const partnerIds = (id) => ["rsv:" + id, "fee:" + id];
const isGenerated = (t) => t.id.startsWith("rsv:") || isFeeId(t.id);
const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }], transactions: [], entries: [], redo: null });
const dayOf = (iso) => String(iso ?? "").slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

export const isReversed = (state, id) => state.transactions.some((t) => t.reverses === id);

// The verified entries that can still be corrected, newest first.
export function correctable(state, today) {
  const from = addDays(today, 1 - CORRECTION_DAYS);
  return state.transactions
    .filter((t) => t.status === "verified" && !isGenerated(t) && !NOT_CORRECTABLE.includes(t.source) && !isReversed(state, t.id) && dayOf(t.verified_at) >= from)
    .sort((a, b) => (a.verified_at < b.verified_at ? 1 : -1));
}

// "Corrected" for an entry that has been cancelled, "Correction" for the cancelling entry itself, else null.
export const correctionTag = (state, t) => (t.reverses ? "Correction" : isReversed(state, t.id) ? "Corrected" : null);

// input: {id, redo_id, reserve_source_id?, today, now?}.
// Returns {ok, violations, transactions, entries, redo}: the cancelling entries to add (the entry and its generated reserve transfer or fee), and the draft to wait in Verify
// ({transaction, entries}[] or null when the entry is not a plain expense; then the right entry is logged again by hand).
export function planCorrection(state, input, now = new Date()) {
  const original = state.transactions.find((t) => t.id === input.id);
  if (!original) return fail("UNKNOWN_TRANSACTION", "no transaction " + input.id);
  if (!correctable(state, input.today).some((t) => t.id === original.id)) return fail("NOT_CORRECTABLE", "this entry can no longer be corrected here");
  const group = [original, ...state.transactions.filter((t) => partnerIds(original.id).includes(t.id) && t.status === "verified" && !isReversed(state, t.id))];
  const stamp = phTimestamp(now);
  let probe = state;
  const transactions = [], entries = [];
  for (const t of group) {
    const rev = {
      id: "rev:" + t.id, date: t.date, payee: t.payee, memo: "Correction of " + (t.payee || "an entry") + (t.memo ? " (" + t.memo + ")" : ""),
      status: "verified", source: "correction", reverses: t.id, created_at: stamp, verified_at: stamp,
    };
    const es = state.entries.filter((e) => e.transaction_id === t.id).map(({ transaction_id, ...e }) => ({ ...e, transaction_id: rev.id, amount: -e.amount }));
    const check = checkTransactionSave(probe, { transaction: rev, entries: es });
    if (!check.ok) return { ok: false, violations: check.violations, transactions: [], entries: [], redo: null };
    probe = { ...probe, transactions: [...probe.transactions, rev], entries: [...probe.entries, ...es] };
    transactions.push(rev); entries.push(...es);
  }
  const mine = state.entries.filter((e) => e.transaction_id === original.id);
  const cat = mine.find((e) => e.category_id != null), acct = mine.find((e) => e.account_id != null);
  const plain = mine.length === 2 && cat && acct && cat.amount > 0 && acct.amount < 0
    && (probe.categories.find((c) => c.id === cat.category_id)?.kind === "expense");
  let redo = null;
  if (plain) {
    const p = planExpense(probe, {
      transaction_id: input.redo_id, date: original.date, payee: original.payee, memo: original.memo, category_id: cat.category_id, amount: cat.amount,
      account_id: acct.account_id, source: ["manual", "preset", "photo", "voice", "import"].includes(original.source) ? original.source : "manual",
      reserve_source_id: input.reserve_source_id, ...(original.trip_add ? { tag_id: original.trip_add } : {}),
    }, now);
    if (!p.ok) return { ok: false, violations: p.violations, transactions: [], entries: [], redo: null };
    redo = p.drafts.map((d, i) => (i === 0 ? { ...d, transaction: { ...d.transaction, corrects: original.id } } : d));
  }
  return { ok: true, violations: [], transactions, entries, redo };
}

// The state after a correction: the cancelling entries added and the fresh draft(s) waiting in Verify. Existing rows are untouched.
export function applyCorrection(state, plan) {
  const next = { ...state, transactions: [...state.transactions, ...plan.transactions], entries: [...state.entries, ...plan.entries] };
  return plan.redo ? applyDrafts(next, plan.redo) : next;
}
