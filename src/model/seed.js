// First-run defaults: category names and the three meal presets named in the spec.
// No accounts and no balances: those are typed on the device and never leave it.

export function defaultCategories() {
  const e = (id, name) => ({ id, name, kind: "expense" });
  return [
    e("cat-food", "Food"), e("cat-lakat", "Lakat/Date"), e("cat-family", "Family"), e("cat-shopping", "Shopping"),
    e("cat-essentials", "Essentials"), e("cat-upskill", "Upskill"), e("cat-subscription", "Subscription"),
    e("cat-rent", "Rent"), e("cat-unlogged", "Unlogged"),
    { id: "cat-salary", name: "Salary", kind: "income" }, { id: "cat-overtime", name: "Overtime", kind: "income" },
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
