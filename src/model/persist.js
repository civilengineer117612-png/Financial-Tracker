// Saving and recovering the ledger across the TWO stores (localStorage and IndexedDB).
// The same text is written to both. On load the stores are compared so that one failed write
// or one cleared store is noticed and repaired from the survivor instead of silently trusted.
// Pure logic only; the app does the actual reading and writing.
import { validateState } from "./validate.js";
import { phTimestamp } from "./util.js";

export const LEDGER_VERSION = 1;
const COLLECTIONS = ["accounts", "goals", "envelopes", "transactions", "entries", "categories", "categoryMaps", "rules",
  "templates", "presets", "payeeRules", "subscriptions", "checkIns", "attachments", "tags", "foreignAmounts", "surveyResponses", "payslips", "payslipLines", "payslipRevisions"];

export const emptyState = () => Object.fromEntries(COLLECTIONS.map((k) => [k, []]));

// settings hold app choices that are not ledger records (e.g. which account hosts the reserve).
export const emptyLedger = () => ({ v: LEDGER_VERSION, rev: 0, saved_at: null, state: emptyState(), settings: {} });

// Every save bumps `rev`; the higher rev is the newer truth if the two stores ever disagree.
export function nextLedger(ledger, state, settings, now = new Date()) {
  return { v: LEDGER_VERSION, rev: ledger.rev + 1, saved_at: phTimestamp(now), state, settings };
}

export function parseLedger(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: "not valid JSON" }; }
  if (!raw || raw.v !== LEDGER_VERSION) return { ok: false, error: "unsupported version" };
  if (!Number.isSafeInteger(raw.rev) || raw.rev < 0) return { ok: false, error: "bad revision" };
  if (typeof raw.settings !== "object" || raw.settings === null) return { ok: false, error: "bad settings" };
  const problems = validateState(raw.state);
  if (problems.length) return { ok: false, error: problems[0].message };
  return { ok: true, ledger: raw };
}

// localText / idbText: the stored text, or null when that store holds nothing.
// status: NONE (first run), OK, REPAIR (copy `ledger` into `repairTo`), CORRUPT (neither is usable).
export function chooseLedger(localText, idbText) {
  if (localText == null && idbText == null) return { status: "NONE", ledger: emptyLedger(), repairTo: null };
  const l = localText == null ? null : parseLedger(localText);
  const i = idbText == null ? null : parseLedger(idbText);
  const okL = l?.ok === true, okI = i?.ok === true;
  if (!okL && !okI) return { status: "CORRUPT", ledger: null, repairTo: null, problems: [l?.error, i?.error].filter(Boolean) };
  if (okL && !okI) return { status: "REPAIR", ledger: l.ledger, repairTo: "idb" };
  if (!okL && okI) return { status: "REPAIR", ledger: i.ledger, repairTo: "local" };
  if (l.ledger.rev === i.ledger.rev) return { status: "OK", ledger: l.ledger, repairTo: null };
  return l.ledger.rev > i.ledger.rev
    ? { status: "REPAIR", ledger: l.ledger, repairTo: "idb" }
    : { status: "REPAIR", ledger: i.ledger, repairTo: "local" };
}

// Restoring a backup REPLACES what is on the phone. The result is stamped newer than both the
// current ledger and the backup, so if the two stores ever disagree afterwards the restore wins.
export function restoreLedger(current, restored, now = new Date()) {
  return { v: LEDGER_VERSION, rev: Math.max(current.rev, restored.rev) + 1, saved_at: phTimestamp(now), state: restored.state, settings: restored.settings };
}

// What a person needs to see before agreeing to replace one ledger with another.
export function summarizeLedger(ledger) {
  const s = ledger.state;
  const dates = s.transactions.map((t) => t.date).sort();
  return {
    accounts: s.accounts.length, transactions: s.transactions.length, entries: s.entries.length,
    latest_date: dates.length ? dates[dates.length - 1] : null, saved_at: ledger.saved_at,
  };
}

export const backupFileName = (date) => "finance-backup-" + date + ".json";

// Days since the last backup, or null if there never was one. Both dates are Philippine dates.
export function daysSinceBackup(settings, today) {
  if (!settings.last_backup_at) return null;
  return Math.round((Date.parse(today) - Date.parse(settings.last_backup_at.slice(0, 10))) / 86400000);
}
