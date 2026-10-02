// Invented data only. Names and amounts are made up and mirror nothing real.
const ts = "2026-01-05T09:00:00.000+08:00";

export const account = (o) => ({ role: "", hidden_by_default: false, archived: false, opening_balance: 0, opening_date: "2026-01-01", ...o });

export function makeState() {
  return {
    accounts: [
      account({ id: "chk", name: "Test Checking", class: "asset", opening_balance: 100000 }),
      account({ id: "res", name: "Test Reserve", class: "asset", reserve_for: "card" }),
      account({ id: "card", name: "Test Card", class: "liability" }),
    ],
    categories: [{ id: "food", name: "Food", kind: "expense" }, { id: "pay", name: "Pay", kind: "income" }],
    envelopes: [{ id: "env1", account_id: "chk", name: "Buffer", purpose: "test" }],
    transactions: [],
    entries: [],
  };
}

export const tx = (o) => ({ id: "t1", date: "2026-01-05", payee: "Shop", memo: "", status: "draft", source: "manual", created_at: ts, ...o });
export const entry = (o) => ({ transaction_id: "t1", ...o });

// A card purchase of `amt` plus the matching reserve set-aside (spec 2.1 pairs).
export function cardPurchase(id, amt, state = "posted", extra = {}) {
  return {
    transaction: tx({ id, ...extra }),
    entries: [
      entry({ transaction_id: id, category_id: "food", amount: amt }),
      entry({ transaction_id: id, account_id: "card", amount: -amt, card_state: state }),
    ],
  };
}
export function reserveSetAside(id, amt) {
  return {
    transaction: tx({ id }),
    entries: [
      entry({ transaction_id: id, account_id: "res", amount: amt }),
      entry({ transaction_id: id, account_id: "chk", amount: -amt }),
    ],
  };
}

// Apply a proposed save to the state, as the caller would after ok === true.
export function commit(state, { transaction, entries }) {
  state.transactions = [...state.transactions.filter((t) => t.id !== transaction.id), transaction];
  state.entries = [...state.entries.filter((e) => e.transaction_id !== transaction.id), ...entries];
}

export const rule = (o) => ({ id: "r1", kind: "budget", subject_id: "food", amount: 400000, effective_from: "2026-01-01", created_at: ts, ...o });
