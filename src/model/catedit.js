// Editing the category list (Setup, the pencil): remove one nothing refers to, hide one that has history, show it again. Nothing is rewritten:
// a removed category was never used, and a hidden one keeps every entry, budget and report; it is only left out of the pickers (settings `hidden_categories`).
import { UNLOGGED_CATEGORY_ID } from "./seed.js";

// Does any saved record (apart from the category list itself) point at this id? Entries, budgets, rules, tiles, schedules: all are looked at the same way.
const mentions = (v, id) => (v === id) || (Array.isArray(v) ? v.some((x) => mentions(x, id)) : v && typeof v === "object" ? Object.values(v).some((x) => mentions(x, id)) : false);
export const categoryInUse = (state, id) => Object.entries(state).some(([k, v]) => k !== "categories" && mentions(v, id));

const find = (state, id) => state.categories.find((c) => c.id === id);
const isEditable = (c) => c && c.kind === "expense" && c.id !== UNLOGGED_CATEGORY_ID;

// "remove" when nothing refers to it, "hide" when it has history, null for a category that is part of the app.
export function removeKind(state, id) {
  const c = find(state, id);
  if (!isEditable(c)) return null;
  return categoryInUse(state, id) ? "hide" : "remove";
}

export function removeCategory(state, id) {
  if (removeKind(state, id) !== "remove") return { ok: false, violations: [{ code: "IN_USE", message: "That category has entries or settings, so it can only be hidden." }] };
  const index = state.categories.findIndex((c) => c.id === id);
  return { ok: true, violations: [], removed: { category: state.categories[index], index }, state: { ...state, categories: state.categories.filter((c) => c.id !== id) } };
}

// Puts a just-removed category back exactly as it was, in its old place (the Undo after a removal).
export function restoreCategory(state, { category, index }) {
  if (state.categories.some((c) => c.id === category.id || c.name.trim().toLowerCase() === category.name.trim().toLowerCase())) return { ok: false, violations: [{ code: "TAKEN", message: "A category with that name is already there." }] };
  const next = [...state.categories]; next.splice(Math.min(index, next.length), 0, category);
  return { ok: true, violations: [], state: { ...state, categories: next } };
}

export const hiddenCategoryIds = (settings) => settings?.hidden_categories ?? [];
export const isHiddenCategory = (settings, id) => hiddenCategoryIds(settings).includes(id);
export function hideCategory(settings, id) { return hiddenCategoryIds(settings).includes(id) ? settings : { ...settings, hidden_categories: [...hiddenCategoryIds(settings), id] }; }
export function showCategory(settings, id) { return { ...settings, hidden_categories: hiddenCategoryIds(settings).filter((x) => x !== id) }; }
// The categories the pickers offer: the hidden ones are left out.
export const pickable = (categories, settings) => categories.filter((c) => !isHiddenCategory(settings, c.id));
