// One account's history with a running balance (owner, Oct 18): the opening balance, then every entry on the account in date order, each with the balance
// right after it. It reads what the account screens already count (drafts included, entries dated before the account began left out), so the last balance
// is exactly the account's balance today. A card shows what is OWED: a purchase raises it, a payment lowers it. Nothing is stored.
import { countedEntries } from "./balances.js";

// Returns {opening, closing, rows: [{transaction, change, balance, pending}]} oldest first; `change` is how the balance moved (money in is plus for an
// account you hold, a purchase is plus for a card's debt), `pending` marks a card charge the bank has not posted yet.
export function accountRegister(state, accountId) {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return null;
  const sign = account.class === "asset" ? 1 : -1, byTx = new Map(state.transactions.map((t) => [t.id, t]));
  const per = new Map();
  for (const e of countedEntries(state)) {
    if (e.account_id !== accountId) continue;
    const t = byTx.get(e.transaction_id); if (!t) continue;
    const row = per.get(t.id) ?? { transaction: t, change: 0, pending: false };
    row.change += sign * e.amount; row.pending = row.pending || e.card_state === "pending";
    per.set(t.id, row);
  }
  const rows = [...per.values()].sort((a, b) => (a.transaction.date < b.transaction.date ? -1 : a.transaction.date > b.transaction.date ? 1 : a.transaction.created_at < b.transaction.created_at ? -1 : a.transaction.created_at > b.transaction.created_at ? 1 : a.transaction.id < b.transaction.id ? -1 : 1));
  let balance = account.opening_balance;
  for (const r of rows) { balance += r.change; r.balance = balance; }
  return { opening: account.opening_balance, opening_date: account.opening_date, closing: balance, rows };
}
