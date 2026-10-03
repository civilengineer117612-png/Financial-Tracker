// The three kinds of row in a transaction list, for a light tint (text stays black; a word names the group too):
//   fixed     fixed costs: Rent, Food
//   everyday  everyday spending: Lakat/Date, Family, Shopping, Essentials, Upskill, Subscription, and any category of your own
//   goals     money moved into a goal
// Anything else (income, other transfers, Unlogged) has no tint. Pure; a category is told by its name.
export const GROUPS = [["fixed", "Fixed costs"], ["everyday", "Everyday spending"], ["goals", "Into goals"]];
const FIXED = new Set(["rent", "food"]);

export function rowGroup(state, transaction) {
  const es = state.entries.filter((e) => e.transaction_id === transaction.id);
  const cat = es.find((e) => e.category_id != null);
  if (cat) {
    const c = state.categories.find((x) => x.id === cat.category_id);
    if (!c || c.kind !== "expense" || c.id === "cat-unlogged") return null;
    return FIXED.has(c.name.trim().toLowerCase()) ? "fixed" : "everyday";
  }
  const goalAccounts = new Set((state.goals ?? []).map((g) => g.account_id));
  return es.filter((e) => goalAccounts.has(e.account_id)).reduce((n, e) => n + e.amount, 0) > 0 ? "goals" : null;
}
