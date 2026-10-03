// Spec 8.2: each morning the previous day's drafts are verified; every entry passes the
// owner's eyes once. The inbox lists what is waiting; verifying flips draft -> verified.
import { validateShape } from "./schema.js";
import { phTimestamp, deepEqual } from "./util.js";
import { checkTransactionSave } from "./index.js";

// Drafts dated on or before `throughDate`, oldest first (older drafts never fall off the list).
// Within a day they come in the order they were captured, so verifying follows the day as it happened.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function pendingDrafts(state, throughDate) {
  return state.transactions
    .filter((t) => t.status === "draft" && t.date <= throughDate)
    .sort((a, b) => cmp(a.date, b.date) || cmp(a.created_at, b.created_at) || cmp(a.id, b.id));
}

// Returns {ok, violations, transaction}. The caller saves `transaction` only if ok.
export function verifyTransaction(state, transactionId, now = new Date()) {
  const t = state.transactions.find((x) => x.id === transactionId);
  const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }], transaction: null });
  if (!t) return fail("UNKNOWN_TRANSACTION", "no transaction " + transactionId);
  if (t.status === "verified") return fail("ALREADY_VERIFIED", transactionId + " is already verified");
  const verified = { ...t, status: "verified", verified_at: phTimestamp(now) };
  const shape = validateShape("Transaction", verified);
  return shape.length ? { ok: false, violations: shape, transaction: null } : { ok: true, violations: [], transaction: verified };
}

// Addendum 3: editing a DRAFT before verifying. For photo/voice drafts, any change to the
// transaction or its entries sets edited_before_verify (survey Q4 measures capture accuracy).
// The source is fixed at capture, and an edit cannot also verify: that stays a separate step.
const strip = (t) => { const { edited_before_verify, ...rest } = t; return rest; };
const canon = (entries) => entries.map((e) => JSON.stringify(Object.entries(e).sort())).sort();

export function editDraft(state, { transaction, entries }) {
  const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }], transaction: null, entries: [] });
  const original = state.transactions.find((t) => t.id === transaction.id);
  if (!original) return fail("UNKNOWN_TRANSACTION", "no transaction " + transaction.id);
  if (original.status !== "draft") return fail("NOT_A_DRAFT", transaction.id + " is already verified");
  if (transaction.status !== "draft") return fail("NOT_A_DRAFT", "an edit cannot verify; use verifyTransaction");
  if (transaction.source !== original.source) return fail("SOURCE_FIXED", "source is fixed at capture");

  const originalEntries = state.entries.filter((e) => e.transaction_id === original.id);
  const changed = !deepEqual(strip(original), strip(transaction)) || !deepEqual(canon(originalEntries), canon(entries));
  const capture = original.source === "photo" || original.source === "voice";
  const updated = capture ? { ...transaction, edited_before_verify: original.edited_before_verify === true || changed } : transaction;
  return { ...checkTransactionSave(state, { transaction: updated, entries }), transaction: updated, entries };
}
