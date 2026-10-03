// The four plain numbers for a month: IN, SPENT, SAVED, LEFT (LEFT = IN - SPENT - SAVED). Only VERIFIED entries count.
//   IN     money that came in under an income category: pay, refunds, interest, other income.
//   SPENT  expenses at the moment of purchase, whatever paid them: cash, debit, e-wallet or credit card.
//   SAVED  net money moved into goals (a transfer into an account that holds a goal; a withdrawal takes it back out).
// Moving money between your own accounts is neither IN nor SPENT, and paying a card bill is not SPENT (the purchases
// already were). Nothing asks the owner to classify an account as an asset or a liability.
export function homeSummary(state, { from, to }) {
  const kind = new Map(state.categories.map((c) => [c.id, c.kind]));
  const goalAccounts = new Set((state.goals ?? []).map((g) => g.account_id));
  const byTx = new Map();
  for (const e of state.entries) { const l = byTx.get(e.transaction_id); if (l) l.push(e); else byTx.set(e.transaction_id, [e]); }
  let incoming = 0, spent = 0, saved = 0, drafts = 0;
  for (const t of state.transactions) {
    if (t.date < from || t.date > to) continue;
    if (t.status !== "verified") { drafts += 1; continue; }
    const es = byTx.get(t.id) ?? [];
    let hasCategory = false;
    for (const e of es) {
      if (e.category_id == null) continue;
      hasCategory = true;
      if (kind.get(e.category_id) === "income") incoming -= e.amount;   // income is a credit, stored negative
      else if (kind.get(e.category_id) === "expense") spent += e.amount;
    }
    // A pure transfer: whatever it adds to the accounts that hold goals is saved. Pay landing in such an account is income, not saving.
    if (!hasCategory) saved += es.filter((e) => goalAccounts.has(e.account_id)).reduce((n, e) => n + e.amount, 0);
  }
  return { in: incoming, spent, saved, left: incoming - spent - saved, drafts };
}
