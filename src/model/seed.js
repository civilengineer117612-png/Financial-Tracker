// First-run defaults: plain category names and no quick tiles.
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

// What a NEW install starts with: plain categories anyone can use, and no quick tiles (nobody's names or amounts). Eight carry a ROLE so the scanner
// and the voice guess can find them whatever they are renamed to. Existing ledgers are never touched (migrate.js gave them roles by name, once).
export function defaultCategories() {
  const e = (id, name, role) => ({ id, name, kind: "expense", ...(role ? { role } : {}) });
  return [
    e("cat-food", "Food", "food"), e("cat-essentials", "Essentials", "essentials"), e("cat-transport", "Transport", "transport"), e("cat-rent", "Rent", "rent"),
    e("cat-subscription", "Subscription", "subscription"), e("cat-shopping", "Shopping", "shopping"), e("cat-health", "Health", "health"), e("cat-fun", "Fun", "fun"), e("cat-other", "Other"),
    e("cat-unlogged", "Unlogged"),
    ...INCOME_CATEGORIES,
  ];
}

export function defaultPresets() {
  return [];   // quick tiles are the owner's own: add them on the Log screen (the "+")
}

export const UNLOGGED_CATEGORY_ID = "cat-unlogged";

// Spending categories the owner can add and rename (Setup). A rename keeps the id, so every entry, budget and role stays attached. Unlogged and the
// income categories are the app's own and are left alone. Names are unique ignoring capitals, 1 to 40 characters.
const catFail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }] });
const checkName = (state, name, exceptId) => {
  const n = String(name ?? "").trim();
  if (!n) return catFail("BAD_NAME", "Give the category a name.");
  if (n.length > 40) return catFail("BAD_NAME", "Keep the name to 40 characters or less.");
  if (state.categories.some((c) => c.id !== exceptId && c.name.trim().toLowerCase() === n.toLowerCase())) return catFail("DUPLICATE_NAME", "You already have a category with that name.");
  return { ok: true, name: n };
};
export function addCategory(state, { id, name }) {
  const v = checkName(state, name, null);
  if (!v.ok) return v;
  if (state.categories.some((c) => c.id === id)) return catFail("DUPLICATE_ID", "that category already exists");
  return { ok: true, violations: [], category: { id, name: v.name, kind: "expense" }, state: { ...state, categories: [...state.categories, { id, name: v.name, kind: "expense" }] } };
}
export function renameCategory(state, id, name) {
  const c = state.categories.find((x) => x.id === id);
  if (!c) return catFail("UNKNOWN_CATEGORY", "no category " + id);
  if (c.kind !== "expense" || id === UNLOGGED_CATEGORY_ID) return catFail("FIXED_CATEGORY", "That category is part of the app and keeps its name.");
  const v = checkName(state, name, id);
  if (!v.ok) return v;
  return { ok: true, violations: [], state: { ...state, categories: state.categories.map((x) => (x.id === id ? { ...x, name: v.name } : x)) } };
}

// The spending category that holds a role (food, essentials, subscription, rent, transport, health, utilities, debt, shopping, fun, dining, invest), or null. Nothing finds a category by its NAME.
export const categoryByRole = (categories, role) => (categories ?? []).find((c) => c.kind === "expense" && c.role === role) ?? null;

// The roles a spending category can hold, with the words the screens use for them (the schema's list, in the order the pickers show them).
export const CATEGORY_ROLES = ["food", "essentials", "subscription", "rent", "transport", "health", "utilities", "debt", "shopping", "fun", "dining", "invest"];
export const ROLE_LABELS = { food: "Food", essentials: "Essentials", subscription: "Subscription", rent: "Rent", transport: "Transport", health: "Health", utilities: "Utilities",
  debt: "Debt", shopping: "Shopping", fun: "Fun", dining: "Dining out", invest: "Invested in yourself" };

// The one-time notice about roles the last data upgrade (5 to 6) gave by EXACT name: Shopping, Fun, Utilities (or Utility), Dining (or Dining out).
// Nothing was stored when it ran, so the same rule finds them again: a spending category that holds one of those four roles and still has that name.
// Once the owner has seen the notice (settings.roles_notice_seen) there is nothing to show. A brand-new install sets that at the start.
const NOTICE_NAMES = { shopping: ["shopping"], fun: ["fun"], utilities: ["utilities", "utility"], dining: ["dining", "dining out"] };
export function roleNoticeRows(state, settings) {
  if (settings?.roles_notice_seen) return [];
  return (state.categories ?? []).filter((c) => c.kind === "expense" && NOTICE_NAMES[c.role]?.includes(String(c.name).trim().toLowerCase()))
    .map((c) => ({ id: c.id, name: c.name, role: c.role }));
}

// Give a spending category a role, or none (role null). A role belongs to one category at a time, because the app looks a category up by its role.
export function setCategoryRole(state, id, role) {
  const c = state.categories.find((x) => x.id === id);
  if (!c) return catFail("UNKNOWN_CATEGORY", "no category " + id);
  if (c.kind !== "expense" || id === UNLOGGED_CATEGORY_ID) return catFail("FIXED_CATEGORY", "That category is part of the app and has no role.");
  if (role != null && !CATEGORY_ROLES.includes(role)) return catFail("BAD_ROLE", "That is not a role.");
  const holder = role == null ? null : state.categories.find((x) => x.kind === "expense" && x.role === role && x.id !== id);
  if (holder) return catFail("ROLE_TAKEN", `${holder.name} already has the role ${ROLE_LABELS[role]}. Take it off there first.`);
  const next = { ...c }; if (role == null) delete next.role; else next.role = role;
  return { ok: true, violations: [], state: { ...state, categories: state.categories.map((x) => (x.id === id ? next : x)) } };
}
