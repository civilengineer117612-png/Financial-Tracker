// Spec 8.3, the weekly check-in: you enter an account's real balance, the app
// compares it with the ledger, and any difference becomes a reconciliation entry
// against the Unlogged category. Unlogged's weekly size measures logging discipline.
//
// Nothing is stored here: planCheckIn returns what WOULD be saved, already checked
// by the same save-time rules as any other transaction.
import { validateShape } from "./schema.js";
import { naturalBalance, cardOutstanding, countedEntries } from "./balances.js";
import { checkTransactionSave } from "./index.js";
import { phTimestamp } from "./util.js";

const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }] });

// The ledger figure to compare with what you counted. A card's bank screen shows
// POSTED charges only (spec 7.1), so for a liability we compare the posted portion;
// pending charges are the ledger's own and are left alone.
export function ledgerBalanceFor(account, entries) {
  return account.class === "liability" ? cardOutstanding(account, entries).posted : naturalBalance(account, entries);
}

// input: {id, transaction_id, date, account_id, counted_balance, unlogged_category_id, now?}
// returns {ok, violations, checkIn, transaction, entries}; transaction is null when the
// count matched the ledger exactly (the check-in itself is still recorded).
export function planCheckIn(state, input, now = new Date()) {
  const account = state.accounts.find((a) => a.id === input.account_id);
  if (!account) return fail("UNKNOWN_ACCOUNT", "no account " + input.account_id);
  if (!state.categories.some((c) => c.id === input.unlogged_category_id)) {
    return fail("UNKNOWN_CATEGORY", "no category " + input.unlogged_category_id);
  }

  const ledger = ledgerBalanceFor(account, countedEntries(state));
  const difference = input.counted_balance - ledger;   // + means you hold more than the ledger says
  const checkIn = {
    id: input.id, date: input.date, account_id: account.id,
    counted_balance: input.counted_balance, ledger_balance: ledger, difference,
  };
  const shape = validateShape("CheckIn", checkIn);
  if (shape.length) return { ok: false, violations: shape, checkIn, transaction: null, entries: [] };
  if (difference === 0) return { ok: true, violations: [], checkIn, transaction: null, entries: [] };

  // Storage sign: debit +, credit -. An asset that holds MORE than the ledger is a
  // debit to it; a liability that owes MORE is a credit to it. The other leg is
  // Unlogged: positive = unexplained spending, negative = unexplained gain.
  const accountLeg = account.class === "asset" ? difference : -difference;
  const stamp = phTimestamp(now);
  const transaction = {
    id: input.transaction_id, date: input.date, payee: "Weekly check-in",
    memo: "Reconciliation: counted " + input.counted_balance + ", ledger " + ledger,
    // Counting the money is the owner's deliberate look (spec 8.2), so it is verified.
    status: "verified", source: "reconciliation", created_at: stamp, verified_at: stamp,
  };
  const entries = [
    { transaction_id: transaction.id, account_id: account.id, amount: accountLeg,
      ...(account.class === "liability" ? { card_state: "posted" } : {}) },
    { transaction_id: transaction.id, category_id: input.unlogged_category_id, amount: -accountLeg },
  ];
  const result = checkTransactionSave(state, { transaction, entries });
  return { ...result, checkIn, transaction, entries };
}

// Net unexplained spending on Unlogged between two dates, inclusive.
// Positive = money went missing; this is the discipline gauge.
export function unloggedTotal(state, unloggedCategoryId, from, to) {
  const dates = new Map(state.transactions.map((t) => [t.id, t.date]));
  return state.entries
    .filter((e) => e.category_id === unloggedCategoryId)
    .filter((e) => { const d = dates.get(e.transaction_id); return d >= from && d <= to; })
    .reduce((s, e) => s + e.amount, 0);
}
