// Spec 6.4: the overrun buffer. Money in the account the owner chooses is split into envelopes
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
  if (allowance - fromAllowance <= 0) notes.push(warn("ALLOWANCE_EMPTY", "allowance is empty; further spending from this account draws the buffer"));
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

const failv = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }] });

// First-time setup of an account's two envelopes (spec 6.4): an everyday allowance and the overrun buffer. The owner
// chooses the account (a wallet such as GCash is just the usual example).
// Each is funded by a balanced transaction inside the same account (+amount tagged with the envelope, -amount
// untagged), so the account balance does not change. Saved VERIFIED: it is the owner's own split of money they hold.
// input: {gcash_account_id, allowance_envelope_id, buffer_envelope_id, allowance_amount, buffer_amount, date, transaction_ids:[a, b]}
export function planEnvelopeSetup(state, input, now = new Date()) {
  const account = state.accounts.find((a) => a.id === input.gcash_account_id);
  if (!account || account.class !== "asset") return failv("UNKNOWN_ACCOUNT", "choose the GCash account");
  const ok = (n) => Number.isSafeInteger(n) && n >= 0;
  if (!ok(input.allowance_amount) || !ok(input.buffer_amount)) return failv("BAD_AMOUNT", "amounts must be whole centavos, zero or more");
  const held = naturalBalance(account, state.entries);
  if (input.allowance_amount + input.buffer_amount > held) return failv("MORE_THAN_HELD", "the envelopes cannot hold more than the account does");
  const ids = [input.allowance_envelope_id, input.buffer_envelope_id];
  if (ids.some((id) => (state.envelopes ?? []).some((e) => e.id === id))) return failv("DUPLICATE_ID", "the envelopes already exist");
  const envelopes = [
    { id: input.allowance_envelope_id, account_id: account.id, name: "Allowance", purpose: "allowance" },
    { id: input.buffer_envelope_id, account_id: account.id, name: "Overrun Buffer", purpose: "buffer" },
  ];
  let next = { ...state, envelopes: [...(state.envelopes ?? []), ...envelopes] };
  const stamp = phTimestamp(now);
  for (const [i, amount, name] of [[0, input.allowance_amount, "Allowance"], [1, input.buffer_amount, "Overrun Buffer"]]) {
    if (amount === 0) continue;
    const transaction = { id: input.transaction_ids[i], date: input.date, payee: "Set aside: " + name, memo: "", status: "verified", source: "manual", created_at: stamp, verified_at: stamp };
    const entries = [
      { transaction_id: transaction.id, account_id: account.id, envelope_id: ids[i], amount },
      { transaction_id: transaction.id, account_id: account.id, amount: -amount },
    ];
    const result = checkTransactionSave(next, { transaction, entries });
    if (!result.ok) return { ok: false, violations: result.violations };
    next = { ...next, transactions: [...next.transactions, transaction], entries: [...next.entries, ...entries] };
  }
  return { ok: true, violations: [], envelopes, state: next };
}

// Money moved INTO the buffer from another account, saved verified like the setup (a deliberate top-up).
// input: {transaction_id, date, amount, from_account_id, gcash_account_id, buffer_envelope_id}
export function planBufferFunding(state, input, now = new Date()) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) return failv("BAD_AMOUNT", "amount must be more than zero");
  if (input.from_account_id === input.gcash_account_id) return failv("SAME_ACCOUNT", "choose a different account to take the money from");
  if (!state.accounts.some((a) => a.id === input.from_account_id)) return failv("UNKNOWN_ACCOUNT", "no account " + input.from_account_id);
  const stamp = phTimestamp(now);
  const transaction = { id: input.transaction_id, date: input.date, payee: "To Overrun Buffer", memo: "", status: "verified", source: "manual", created_at: stamp, verified_at: stamp };
  const entries = [
    { transaction_id: transaction.id, account_id: input.gcash_account_id, envelope_id: input.buffer_envelope_id, amount: input.amount },
    { transaction_id: transaction.id, account_id: input.from_account_id, amount: -input.amount },
  ];
  const result = checkTransactionSave(state, { transaction, entries });
  return { ...result, transaction, entries, state: result.ok ? { ...state, transactions: [...state.transactions, transaction], entries: [...state.entries, ...entries] } : state };
}

// What the buffer screen shows. draws = this month's spending that took from the buffer, by category, biggest first
// (a draw is a buffer-tagged credit inside a transaction that has a category; the month-end sweep is not a draw).
export function bufferSummary(state, { allowance_envelope_id, buffer_envelope_id, month }) {
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const names = new Map(state.categories.map((c) => [c.id, c.name]));
  const byCat = new Map();
  for (const e of state.entries) {
    if (e.envelope_id !== buffer_envelope_id || e.amount >= 0) continue;
    const t = txById.get(e.transaction_id);
    const cat = state.entries.find((x) => x.transaction_id === e.transaction_id && x.category_id != null);
    if (!t || !cat || t.date.slice(0, 7) !== month) continue;
    const row = byCat.get(cat.category_id) ?? { category_id: cat.category_id, name: names.get(cat.category_id) ?? cat.category_id, amount: 0, pending: 0 };
    if (t.status === "verified") row.amount -= e.amount; else row.pending -= e.amount;
    byCat.set(cat.category_id, row);
  }
  const draws = [...byCat.values()].sort((a, b) => b.amount + b.pending - (a.amount + a.pending) || a.name.localeCompare(b.name));
  return {
    allowance: envelopeBalance(state.entries, allowance_envelope_id), buffer: envelopeBalance(state.entries, buffer_envelope_id),
    draws, drawn: draws.reduce((n, d) => n + d.amount + d.pending, 0),
  };
}
