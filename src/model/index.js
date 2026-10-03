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
export { envelopeBalance, planGcashSpend, splitSweep, planMonthEndSweep, underBudgetedCategories, planEnvelopeSetup, planBufferFunding, bufferSummary } from "./buffer.js";
export { parseSchedule, isDue, datesBetween, categoryForPayee, draftId, draftFromTemplate, draftsForRange, planReserveTransfer } from "./templates.js";
export { budgetStatus, budgetTrend, budgetGrade, GRADE_AT, monthElapsedPercent, suggestedBudgetStart, budgetFor, planBudgetChange } from "./budget.js";
export { pendingDrafts, verifyTransaction } from "./inbox.js";
export { goalProgress, requiredPerMonth, visibleGoals, emergencyTarget, splitOvertime, planOvertimeTransfer, planGoal, planGoalDeposit, setGoalTarget } from "./goals.js";
export { validateState, encryptBackup, decryptBackup, encryptLedgerBackup, decryptLedgerBackup, MIN_PASSPHRASE } from "./backup.js";
export { weekEndingOn, autoFillSurvey, planSurveyResponse, surveyReview, unloggedByWeek } from "./survey.js";
export { editDraft } from "./inbox.js";
export { detectPlatform, assessDevice, trialAllowed } from "./device.js";
export { buildReminderCalendar, defaultReminders, validateReminder, foldLine } from "./reminders.js";
export { parsePesos, formatPesos, formatPesosWhole } from "./money.js";
export { defaultCategories, defaultPresets, UNLOGGED_CATEGORY_ID, ensureIncomeCategories, INCOME_CATEGORIES } from "./seed.js";
export { applyDrafts, planExpense, discardDraft, verifyDraft, editDraftFields, setAccountIcon, planAttachment, attachmentsFor, planSplitExpense, splitCategoryEntry } from "./drafts.js";
export { LEDGER_VERSION, emptyState, emptyLedger, nextLedger, parseLedger, chooseLedger, restoreLedger, summarizeLedger, backupFileName, daysSinceBackup } from "./persist.js";
export { monthOf, addMonths, monthLabel, spendingByCategory, spendingByRange, spendingByAccount, monthlySpending, dayTotal } from "./reports.js";
export { parsePlan, addPlan, planInEffect, planTotals, planEmergencyTarget, emergencyFundStatus, DEFAULT_EF, cutoffFor, planProgress, planIncome, planPayReceived } from "./plan.js";
export { planTag, tagSummary } from "./trips.js";
export { BANKS, CASH, bankById, bankForName, planAccount, linkAccountBank, setBankIconUrl, bankPicture, isPlaceholderAddress, dropPlaceholderAddresses } from "./banks.js";
export { KINDS, kindById, wordsToCentavos, readScan, categoryFromHistory } from "./scan.js";
export { EARNINGS, DEDUCTIONS, GOVERNMENT, LOST, SOURCES, OVERTIME_SHARE, linesOf, payslipTotals, payslipChecks, planPayslip, overtimeDraft, overtimeFreeDraft, incomeBySource, incomeByMonth, netPerPayday, raiseHistory, deductionsByMonth, employerHistory } from "./income.js";
export { homeSummary } from "./summary.js";
export { GROUPS, rowGroup } from "./groups.js";
