// Entry points. A "save" is validated against the state as it WOULD be after the save;
// nothing is written here. The caller persists only if result.ok is true.
import { validateShape } from "./schema.js";
import { checkEntriesBalance, checkReferences, checkReserve, checkDuplicate, checkRulesAppendOnly } from "./invariants.js";

export { SCHEMAS, validateShape } from "./schema.js";
export { naturalBalance, cardOutstanding, reserveShortfalls } from "./balances.js";
export { countsTowardBudget, splitByBudgetStatus } from "./invariants.js";
export { phTimestamp, isPhDate, isPhTimestamp, isCentavos } from "./util.js";

const result = (violations) => ({ ok: !violations.some((v) => v.severity === "error"), violations });

// state: {accounts, categories, envelopes, transactions, entries} (arrays of plain objects)
// proposed: {transaction, entries}; if transaction.id already exists, it is an edit.
export function checkTransactionSave(state, { transaction, entries }) {
  // Stage 1: shape. Later checks assume well-formed data, so stop here on failure.
  const shape = [
    ...validateShape("Transaction", transaction),
    ...(Array.isArray(entries) ? entries.flatMap((e) => validateShape("Entry", e)) : [{ code: "SHAPE", severity: "error", message: "entries must be an array" }]),
  ];
  if (shape.length) return result(shape);

  // Stage 2: the invariants, in the order the spec lists them.
  const entriesBefore = state.entries;
  const entriesAfter = [...state.entries.filter((e) => e.transaction_id !== transaction.id), ...entries];
  return result([
    ...checkEntriesBalance(entries),
    ...checkReferences(state, transaction, entries),
    ...checkReserve(state.accounts, entriesBefore, entriesAfter),
    ...checkDuplicate(state, transaction, entries),
  ]);
}

// previousRules: rows already saved. nextRules: the full list the caller wants saved.
export function checkRulesSave(previousRules, nextRules) {
  const shape = nextRules.flatMap((r) => validateShape("Rule", r));
  if (shape.length) return result(shape);
  return result(checkRulesAppendOnly(previousRules, nextRules));
}
export { ruleInEffect, rulesInEffect, reportingCategory, checkCategoryMapSave } from "./rules.js";
export { validateRatchetParams, wasMet, nextRatchet, ratchetSchedule, splitRatchet } from "./ratchet.js";
export { planCheckIn, ledgerBalanceFor, unloggedTotal } from "./checkin.js";
export { envelopeBalance, planGcashSpend, splitSweep, planMonthEndSweep, underBudgetedCategories } from "./buffer.js";
export { parseSchedule, isDue, datesBetween, categoryForPayee, draftId, draftFromTemplate, draftsForRange, planReserveTransfer } from "./templates.js";
export { budgetStatus } from "./budget.js";
export { pendingDrafts, verifyTransaction } from "./inbox.js";
