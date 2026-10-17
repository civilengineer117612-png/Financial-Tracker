// The order the owner arranged by hand for categories and accounts (settings `category_order` and `account_order`, lists of ids).
// Nothing arranged: A to Z. Arranged: those first, in that order; anything new (or never moved) follows A to Z. An id that no longer exists is ignored.
const az = (a, b) => a.name.localeCompare(b.name);
export function arranged(list, ids = []) {
  const rank = new Map((ids ?? []).map((id, i) => [id, i]));
  const mine = list.filter((x) => rank.has(x.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  return [...mine, ...list.filter((x) => !rank.has(x.id)).sort(az)];
}
// After a drag: the whole list's ids in their new order (every shown item is now placed, so the saved order is complete and stable).
export const orderFrom = (ids) => [...new Set(ids)];
