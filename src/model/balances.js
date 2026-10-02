// Balances are derived from entries, never stored (so they cannot drift).
//
// Storage sign: debit +, credit -. Assets and expenses grow with debits; liabilities
// and income grow with credits. So an account's "natural" balance is
//   asset:     opening + sum(entries)
//   liability: opening - sum(entries)     (positive = amount owed)

export function naturalBalance(account, entries) {
  const sum = entries.filter((e) => e.account_id === account.id).reduce((s, e) => s + e.amount, 0);
  return account.class === "asset" ? account.opening_balance + sum : account.opening_balance - sum;
}

// Card liability split into posted and pending (spec 7.1: the bank shows posted only,
// the reserve must cover both). The opening balance is treated as already posted.
export function cardOutstanding(card, entries) {
  let posted = card.opening_balance, pending = 0;
  for (const e of entries) {
    if (e.account_id !== card.id) continue;
    if (e.card_state === "pending") pending -= e.amount; else posted -= e.amount;
  }
  return { posted, pending, total: posted + pending };
}

// For every reserve account: how far it falls short of the card it covers (0 = covered).
export function reserveShortfalls(accounts, entries) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = [];
  for (const reserve of accounts) {
    if (!reserve.reserve_for) continue;
    const card = byId.get(reserve.reserve_for);
    if (!card) continue;   // dangling link is reported by the reference check
    const outstanding = cardOutstanding(card, entries).total;
    const balance = naturalBalance(reserve, entries);
    out.push({ reserve_id: reserve.id, card_id: card.id, reserve: balance, outstanding, shortfall: Math.max(0, outstanding - balance) });
  }
  return out;
}
