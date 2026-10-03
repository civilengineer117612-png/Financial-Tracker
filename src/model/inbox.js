// Spec 8.2: each morning the previous day's drafts are verified; every entry passes the
// owner's eyes once. The inbox lists what is waiting; verifying flips draft -> verified.
import { validateShape } from "./schema.js";
import { phTimestamp } from "./util.js";

// Drafts dated on or before `throughDate`, oldest first (older drafts never fall off the list).
export function pendingDrafts(state, throughDate) {
  return state.transactions
    .filter((t) => t.status === "draft" && t.date <= throughDate)
    .sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
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
