// Balances are derived from entries, never stored (so they cannot drift).
//
// Storage sign: debit +, credit -. Assets and expenses grow with debits; liabilities
// and income grow with credits. So an account's "natural" balance is
//   asset:     opening + sum(entries)
//   liability: opening - sum(entries)     (positive = amount owed)

// What counts toward a balance: the opening balance is what the account held on the day it was added ("How much is in it today"), so an entry dated
// BEFORE that day is already inside it and is not counted again. Entries on that day or later count (on the day itself they count: showing a little too
// little is the safer mistake). History, reports and budgets still see every entry; only balances skip the early ones.
const cache = new WeakMap();
export function countedEntries(state) {
  const entries = state.entries ?? [], hit = cache.get(entries);
  if (hit && hit.tx === state.transactions && hit.accounts === state.accounts) return hit.out;
  const dateOf = new Map((state.transactions ?? []).map((t) => [t.id, t.date])), start = new Map((state.accounts ?? []).map((a) => [a.id, a.opening_date]));
  const out = entries.filter((e) => { if (e.account_id == null) return true; const d = dateOf.get(e.transaction_id), s = start.get(e.account_id); return !d || !s || d >= s; });
  cache.set(entries, { tx: state.transactions, accounts: state.accounts, out });
  return out;
}

// Accounts whose balance the rule above changes (entries dated before the account was added): [{account_id, name, by}], by = how much more it now shows.
export function earlyEntryChanges(state) {
  const counted = countedEntries(state);
  return (state.accounts ?? []).map((a) => ({ account_id: a.id, name: a.name, by: naturalBalance(a, counted) - naturalBalance(a, state.entries ?? []) })).filter((x) => x.by !== 0);
}

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

// For every reserve account: how much of it the card it covers is owed (kept) and how much is free to spend, and the owed part as a share of it (0 to 1, for a bar).
// A reserve with nothing in it that is owed something is a full bar. Reads what reserveShortfalls reads; nothing is stored.
export function reserveCover(accounts, entries) {
  return reserveShortfalls(accounts, entries).map((r) => {
    const balance = Math.max(0, r.reserve), kept = Math.min(balance, Math.max(0, r.outstanding));
    return { reserve_id: r.reserve_id, card_id: r.card_id, balance: r.reserve, owed: Math.max(0, r.outstanding), kept, free: balance - kept,
      share: balance > 0 ? kept / balance : r.outstanding > 0 ? 1 : 0 };
  });
}

// The net of the Cards screen: what you have, what the cards are owed, what is truly free, and the owed part of what you have as a share (0 to 1) for the bar.
export function netPosition(held, owe) {
  const have = Math.max(0, held), owed = Math.max(0, owe);
  return { have, owed, free: held - owed, share: have > 0 ? Math.min(1, owed / have) : owed > 0 ? 1 : 0 };
}
