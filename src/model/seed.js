// First-run defaults: category names and the three meal presets named in the spec.
// No accounts and no balances: those are typed on the device and never leave it.

// Where income comes from, for the Income screen: base pay, overtime, interest, refunds, anything else.
export const INCOME_CATEGORIES = [
  { id: "cat-salary", name: "Salary", kind: "income" }, { id: "cat-overtime", name: "Overtime", kind: "income" },
  { id: "cat-interest", name: "Interest", kind: "income" }, { id: "cat-refund", name: "Refund", kind: "income" }, { id: "cat-other-income", name: "Other income", kind: "income" },
];
// A ledger made before these existed gets the missing ones (in memory; saved with the next save).
export function ensureIncomeCategories(state) {
  const have = new Set(state.categories.map((c) => c.id));
  const add = INCOME_CATEGORIES.filter((c) => !have.has(c.id));
  return add.length ? { ...state, categories: [...state.categories, ...add] } : state;
}

// An earlier version added a "Credit card" spending category. A card is just one of the accounts, so the category is taken away again,
// unless something was already logged under it.
export function dropUnusedCardCategory(state) {
  if (!state.categories.some((c) => c.id === "cat-creditcard") || state.entries.some((e) => e.category_id === "cat-creditcard")) return state;
  return { ...state, categories: state.categories.filter((c) => c.id !== "cat-creditcard") };
}

export function defaultCategories() {
  const e = (id, name) => ({ id, name, kind: "expense" });
  return [
    e("cat-food", "Food"), e("cat-lakat", "Lakat/Date"), e("cat-family", "Family"), e("cat-shopping", "Shopping"),
    e("cat-essentials", "Essentials"), e("cat-upskill", "Upskill"), e("cat-subscription", "Subscription"),
    e("cat-rent", "Rent"), e("cat-unlogged", "Unlogged"),
    ...INCOME_CATEGORIES,
  ];
}

export function defaultPresets() {
  return [
    { id: "pre-breakfast", name: "Breakfast", amount: 2000, category_id: "cat-food" },
    { id: "pre-lunch", name: "Lunch", amount: 9500, category_id: "cat-food" },
    { id: "pre-dinner", name: "Dinner", amount: 9500, category_id: "cat-food" },
  ];
}

export const UNLOGGED_CATEGORY_ID = "cat-unlogged";
