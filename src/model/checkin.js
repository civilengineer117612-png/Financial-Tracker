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
import { planTransfer } from "./transfers.js";

const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }] });

// The ledger figure to compare with what you counted. A card's bank screen shows
// POSTED charges only (spec 7.1), so for a liability we compare the posted portion;
// pending charges are the ledger's own and are left alone.
export function ledgerBalanceFor(account, entries) {
  return account.class === "liability" ? cardOutstanding(account, entries).posted : naturalBalance(account, entries);
}

// A card purchase stays "pending" until the bank shows it. Marking it posted is a new entry pair
// (nothing is edited): the pending charge is cancelled and the same amount is written as posted, so what you owe does not change.
// The memo lists the purchases it moved ("Posted by the bank: id id"), which is how they leave the pending list.
const POSTED_MEMO = "Posted by the bank: ";
export function pendingPurchases(state, account) {
  if (account.class !== "liability") return [];
  const moved = new Set(state.transactions.filter((t) => t.source === "reconciliation" && (t.memo ?? "").startsWith(POSTED_MEMO)).flatMap((t) => t.memo.slice(POSTED_MEMO.length).split(" ")));
  const byId = new Map(state.transactions.map((t) => [t.id, t]));
  const out = [];
  for (const e of countedEntries(state)) {
    if (e.account_id !== account.id || e.card_state !== "pending" || e.amount >= 0 || moved.has(e.transaction_id)) continue;
    const t = byId.get(e.transaction_id);
    if (t && t.source !== "reconciliation") out.push({ transaction_id: t.id, date: t.date, payee: t.payee, amount: -e.amount });
  }
  return out.sort((a, b) => a.date < b.date ? 1 : -1);
}

// input: {id, transaction_id, date, account_id, counted_balance, unlogged_category_id, now?,
//         basis?: "posted" (default) | "owed", posted_tx_ids?: [ids of pending purchases the bank now shows], posting_transaction_id?}
// basis "owed" compares what you counted with EVERYTHING you owe (posted and pending); "posted" compares with the posted part only,
// after the ticked purchases are moved from pending to posted. Only a card has a basis.
// returns {ok, violations, checkIn, transaction, entries}; transaction is null when the
// count matched the ledger exactly (the check-in itself is still recorded).
export function planCheckIn(state, input, now = new Date()) {
  const account = state.accounts.find((a) => a.id === input.account_id);
  if (!account) return fail("UNKNOWN_ACCOUNT", "no account " + input.account_id);
  if (!state.categories.some((c) => c.id === input.unlogged_category_id)) {
    return fail("UNKNOWN_CATEGORY", "no category " + input.unlogged_category_id);
  }

  const isCard = account.class === "liability";
  let basisState = state, posting = null;
  const ticked = isCard && input.basis !== "owed" ? (input.posted_tx_ids ?? []) : [];
  if (ticked.length) {
    const pend = pendingPurchases(state, account).filter((p) => ticked.includes(p.transaction_id));
    if (pend.length) {
      const stamp0 = phTimestamp(now), id = input.posting_transaction_id ?? input.transaction_id + "-posted";
      const t = { id, date: input.date, payee: "Posted by the bank", memo: POSTED_MEMO + pend.map((p) => p.transaction_id).join(" "), status: "verified", source: "reconciliation", created_at: stamp0, verified_at: stamp0 };
      const sum = pend.reduce((a, p) => a + p.amount, 0);
      const es = [{ transaction_id: id, account_id: account.id, amount: sum, card_state: "pending" }, { transaction_id: id, account_id: account.id, amount: -sum, card_state: "posted" }];
      posting = { transaction: t, entries: es };
      basisState = { ...state, transactions: [...state.transactions, t], entries: [...state.entries, ...es] };
    }
  }
  const ledger = isCard && input.basis === "owed" ? cardOutstanding(account, countedEntries(basisState)).total : ledgerBalanceFor(account, countedEntries(basisState));
  const difference = input.counted_balance - ledger;   // + means you hold more than the ledger says
  // "Not sure: just match it" (owner, Oct 20): a bank or wallet count with a gap nobody explained. Found money (more than the ledger) is never
  // spending going down, so that entry is an `adjustment` the spending reports skip; money missing stays unlogged spending, as before.
  const matched = !isCard && input.why === "match" && difference !== 0;
  const checkIn = {
    id: input.id, date: input.date, account_id: account.id,
    counted_balance: input.counted_balance, ledger_balance: ledger, difference,
    ...(matched ? { matched: true } : {}),
  };
  const shape = validateShape("CheckIn", checkIn);
  if (shape.length) return { ok: false, violations: shape, checkIn, transaction: null, entries: [], posting };
  if (difference === 0) return { ok: true, violations: [], checkIn, transaction: null, entries: [], posting };

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
    ...(matched && difference > 0 ? { adjustment: true } : {}),
  };
  const entries = [
    { transaction_id: transaction.id, account_id: account.id, amount: accountLeg,
      ...(account.class === "liability" ? { card_state: "posted" } : {}) },
    { transaction_id: transaction.id, category_id: input.unlogged_category_id, amount: -accountLeg },
  ];
  const result = checkTransactionSave(basisState, { transaction, entries });
  return { ...result, checkIn, transaction, entries, posting };
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

// A count of a bank, wallet or cash account that shows a gap the owner can explain as a MOVE to or from another of their own accounts (owner, Oct 20):
// the move is made as a DRAFT first (money in when the count is higher, out when lower), so the count then matches and no gap is recorded.
// input: the planCheckIn input. other: {account_id, move_id}. Returns {ok, violations, state, plan, move_id}.
export function planCheckInWithMove(state, input, other, now = new Date()) {
  const account = state.accounts.find((a) => a.id === input.account_id), from = state.accounts.find((a) => a.id === other.account_id);
  if (!account || account.class !== "asset") return fail("NOT_AN_ASSET", "a move needs a bank, wallet or cash account");
  if (!from || from.class !== "asset" || from.id === account.id) return fail("BAD_OTHER", "choose a different bank, wallet or cash account");
  const gap = input.counted_balance - ledgerBalanceFor(account, countedEntries(state));
  if (gap === 0) return fail("NO_GAP", "the count already matches");
  const moved = planTransfer(state, { transaction_id: other.move_id, date: input.date, from_account_id: gap > 0 ? from.id : account.id, to_account_id: gap > 0 ? account.id : from.id,
    amount: Math.abs(gap), payee: gap > 0 ? "Moved in (found at count)" : "Moved out (found at count)", source: "manual" }, now);
  if (!moved.ok) return { ok: false, violations: moved.violations };
  const plan = planCheckIn(moved.state, { ...input, why: "move" }, now);
  return { ok: plan.ok, violations: plan.violations, state: moved.state, plan, move_id: other.move_id };
}
