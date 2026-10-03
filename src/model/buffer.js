// Spec 6.4: the overrun buffer. Money in the GCash wallet is split into envelopes
// (the ride/load allowance and the buffer). An envelope's balance is the sum of the
// entries tagged with it; debit +, so funding it is a debit and spending is a credit.
//
// The spec does not say how a draw on a NON-GCash overrun works, so only GCash
// spending and the month-end sweep are modelled here.
import { naturalBalance } from "./balances.js";
import { checkTransactionSave } from "./index.js";
import { phTimestamp } from "./util.js";

export const envelopeBalance = (entries, envelopeId) =>
  entries.filter((e) => e.envelope_id === envelopeId).reduce((s, e) => s + e.amount, 0);

const warn = (code, message, extra = {}) => ({ code, severity: "warning", message, ...extra });

// A spend paid from GCash takes from the allowance first; once that is empty the rest
// comes out of the buffer (a "draw", recorded by tagging that credit leg with the buffer
// envelope in the same transaction as the category). Anything beyond both is untagged.
// Real spending already happened, so these are warnings, never blocks.
// input: {transaction_id, date, payee, category_id, amount, gcash_account_id,
//         allowance_envelope_id, buffer_envelope_id}
export function planGcashSpend(state, input, now = new Date()) {
  const allowance = envelopeBalance(state.entries, input.allowance_envelope_id);
  const buffer = envelopeBalance(state.entries, input.buffer_envelope_id);
  const fromAllowance = Math.min(input.amount, Math.max(0, allowance));
  const rest = input.amount - fromAllowance;
  const fromBuffer = Math.min(rest, Math.max(0, buffer));
  const untracked = rest - fromBuffer;

  const transaction = {
    id: input.transaction_id, date: input.date, payee: input.payee, memo: "",
    status: "draft", source: "manual", created_at: phTimestamp(now),
  };
  const leg = (amount, envelope_id) => ({
    transaction_id: transaction.id, account_id: input.gcash_account_id, amount: -amount,
    ...(envelope_id ? { envelope_id } : {}),
  });
  const entries = [
    { transaction_id: transaction.id, category_id: input.category_id, amount: input.amount },
    ...(fromAllowance > 0 ? [leg(fromAllowance, input.allowance_envelope_id)] : []),
    ...(fromBuffer > 0 ? [leg(fromBuffer, input.buffer_envelope_id)] : []),
    ...(untracked > 0 ? [leg(untracked, null)] : []),
  ];

  const result = checkTransactionSave(state, { transaction, entries });
  const notes = [];
  if (allowance - fromAllowance <= 0) notes.push(warn("ALLOWANCE_EMPTY", "allowance is empty; further GCash spending draws the buffer"));
  if (fromBuffer > 0) notes.push(warn("BUFFER_DRAWN", fromBuffer + " centavos drawn from the buffer", { drawn: fromBuffer }));
  if (untracked > 0) notes.push(warn("BUFFER_EXHAUSTED", untracked + " centavos exceeded both allowance and buffer", { untracked }));
  return { ...result, violations: [...result.violations, ...notes], transaction, entries };
}

// Month-end: unused buffer goes to Mole Removal until it reaches its target, then the
// remainder goes to the Emergency Fund.
export function splitSweep(buffer, moleBalance, moleTarget) {
  const toMole = Math.min(Math.max(0, buffer), Math.max(0, moleTarget - moleBalance));
  return { toMole, toEmergency: Math.max(0, buffer) - toMole };
}

// Builds the sweep as a DRAFT template transaction (spec 8.1: templates create drafts;
// 8.2: you verify it in the morning). Returns transaction null if the buffer is empty.
// input: {transaction_id, date, gcash_account_id, buffer_envelope_id,
//         mole_account_id, emergency_account_id, mole_target}
export function planMonthEndSweep(state, input, now = new Date()) {
  const buffer = envelopeBalance(state.entries, input.buffer_envelope_id);
  const mole = state.accounts.find((a) => a.id === input.mole_account_id);
  if (!mole || !state.accounts.some((a) => a.id === input.emergency_account_id)) {
    return { ok: false, violations: [{ code: "UNKNOWN_ACCOUNT", severity: "error", message: "mole or emergency account not found" }], transaction: null, entries: [] };
  }
  if (buffer <= 0) return { ok: true, violations: [], transaction: null, entries: [] };

  const { toMole, toEmergency } = splitSweep(buffer, naturalBalance(mole, state.entries), input.mole_target);
  const transaction = {
    id: input.transaction_id, date: input.date, payee: "Month-end buffer sweep", memo: "",
    status: "draft", source: "template", created_at: phTimestamp(now),
  };
  const dest = (account_id, amount) => ({ transaction_id: transaction.id, account_id, amount });
  const entries = [
    ...(toMole > 0 ? [dest(input.mole_account_id, toMole)] : []),
    ...(toEmergency > 0 ? [dest(input.emergency_account_id, toEmergency)] : []),
    { transaction_id: transaction.id, account_id: input.gcash_account_id, envelope_id: input.buffer_envelope_id, amount: -buffer },
  ];
  return { ...checkTransactionSave(state, { transaction, entries }), transaction, entries };
}

// Repeated draws on one category signal an under-budgeted line (spec 6.4). A category
// is flagged when buffer draws hit it in at least `minMonths` different months.
// The spec gives no number, so minMonths is a parameter.
export function underBudgetedCategories(state, bufferEnvelopeId, minMonths) {
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const monthsByCategory = new Map();
  for (const e of state.entries) {
    if (e.envelope_id !== bufferEnvelopeId || e.amount >= 0) continue;   // only draws, not funding
    const tx = txById.get(e.transaction_id);
    const cat = state.entries.find((x) => x.transaction_id === e.transaction_id && x.category_id);
    if (!tx || !cat) continue;
    if (!monthsByCategory.has(cat.category_id)) monthsByCategory.set(cat.category_id, new Set());
    monthsByCategory.get(cat.category_id).add(tx.date.slice(0, 7));
  }
  return [...monthsByCategory].filter(([, m]) => m.size >= minMonths)
    .map(([category_id, m]) => ({ category_id, months: [...m].sort() }));
}
