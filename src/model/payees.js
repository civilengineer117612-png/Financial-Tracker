// Who the money went to (owner, Oct 16). A bank statement only says "Transfer to 0917...4567" or "BDO ending 1234": it never says what the money was for,
// so the owner names a payee ONCE ("Sample Person", Family) and every payment to them follows. Payees with the same name are one person (a GCash number and a bank
// account, say), shown as one row that opens into its accounts.
// The names live only in the owner's settings (`payee_book`: {payeeKey: {name?, category_id?}}); no data shape changes. A verified entry is final: an entry
// still in Unlogged is SHOWN under its payee's category in the reports (`withPayeeBook`), and the stored entry stays as it was. Drafts are changed for real.
// Pure logic; amounts are centavos.
import { UNLOGGED_CATEGORY_ID } from "./seed.js";

// One key per payee: lower case, punctuation and extra spaces dropped ("BDO Unibank, Inc. ending 1234" and "bdo unibank inc ending 1234" are one).
export const payeeKey = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// How a payee is shown before it has a name: a phone or account number is shortened to its first four and last four digits.
export function payeeLabel(text) {
  const t = String(text ?? "").trim();
  return /^\d{10,}$/.test(t) ? `${t.slice(0, 4)}…${t.slice(-4)}` : t || "Someone";
}

const entryOf = (book, key) => (book && key ? book[key] : null) ?? null;
const nameKey = (name) => String(name ?? "").trim().toLowerCase();

// The reports' view of the ledger: an entry in Unlogged whose payee has a category takes that category. Nothing else changes and nothing is stored.
const lensCache = new WeakMap();
export function withPayeeBook(state, book) {
  if (!book || !Object.values(book).some((p) => p?.category_id)) return state;
  const hit = lensCache.get(state.entries);
  if (hit && hit.book === book && hit.tx === state.transactions) return hit.out;
  const payee = new Map(state.transactions.map((t) => [t.id, payeeKey(t.payee)]));
  const valid = new Set(state.categories.filter((c) => c.kind === "expense").map((c) => c.id));
  const entries = state.entries.map((e) => {
    if (e.category_id !== UNLOGGED_CATEGORY_ID) return e;
    const c = entryOf(book, payee.get(e.transaction_id))?.category_id;
    return c && valid.has(c) && c !== UNLOGGED_CATEGORY_ID ? { ...e, category_id: c } : e;
  });
  const out = { ...state, entries };
  lensCache.set(state.entries, { book, tx: state.transactions, out });
  return out;
}

// The spending in a range, one row per payee, grouped into people by name: [{id, name, named, category_id, total, count, members:[{key, label, total, count}]}],
// the biggest first. Verified spending only (as the other reports), Moves between your own accounts never (they carry no spending category).
export function spendingByPayee(state, book, { from, to }) {
  const expense = new Set(state.categories.filter((c) => c.kind === "expense").map((c) => c.id));
  const tx = new Map(state.transactions.map((t) => [t.id, t]));
  const byKey = new Map();
  for (const e of state.entries) {
    if (!e.category_id || !expense.has(e.category_id)) continue;
    const t = tx.get(e.transaction_id);
    if (!t || t.status !== "verified" || t.date < from || t.date > to) continue;
    const key = payeeKey(t.payee) || "(no name)";
    const m = byKey.get(key) ?? { key, label: payeeLabel(t.payee), total: 0, count: 0, txs: new Set(), cats: new Map() };
    m.total += e.amount;
    m.txs.add(t.id);
    m.cats.set(e.category_id, (m.cats.get(e.category_id) ?? 0) + e.amount);
    byKey.set(key, m);
  }
  const groups = new Map();
  for (const m of byKey.values()) {
    const p = entryOf(book, m.key), named = nameKey(p?.name);
    const id = named ? "name:" + named : "key:" + m.key;
    const g = groups.get(id) ?? { id, name: named ? p.name.trim() : m.label, named: !!named, category_id: null, total: 0, count: 0, members: [], cats: new Map() };
    g.total += m.total;
    g.count += m.txs.size;
    g.members.push({ key: m.key, label: m.label, total: m.total, count: m.txs.size });
    for (const [c, a] of m.cats) g.cats.set(c, (g.cats.get(c) ?? 0) + a);
    if (p?.category_id) g.category_id = p.category_id;
    groups.set(id, g);
  }
  return [...groups.values()].filter((g) => g.total !== 0).map((g) => {
    const top = [...g.cats].filter(([c]) => c !== UNLOGGED_CATEGORY_ID).sort((a, b) => b[1] - a[1])[0];
    const { cats, ...rest } = g;
    return { ...rest, category_id: g.category_id ?? top?.[0] ?? null, members: g.members.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)) };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

// One payee's spending month by month, the last `months` months up to `endMonth` ("YYYY-MM"): [{month, amount}], oldest first. Verified spending only.
export function payeeMonths(state, key, { endMonth, months = 6 }) {
  const expense = new Set(state.categories.filter((c) => c.kind === "expense").map((c) => c.id));
  const want = [];
  let [y, m] = endMonth.split("-").map(Number);
  for (let i = 0; i < months; i++) { want.unshift(`${y}-${String(m).padStart(2, "0")}`); if (--m === 0) { m = 12; y--; } }
  const sums = new Map(want.map((x) => [x, 0]));
  const tx = new Map(state.transactions.map((t) => [t.id, t]));
  for (const e of state.entries) {
    if (!e.category_id || !expense.has(e.category_id)) continue;
    const t = tx.get(e.transaction_id);
    if (!t || t.status !== "verified" || payeeKey(t.payee) !== key) continue;
    const mo = t.date.slice(0, 7);
    if (sums.has(mo)) sums.set(mo, sums.get(mo) + e.amount);
  }
  return want.map((month) => ({ month, amount: sums.get(month) }));
}

// Every payment to a payee (verified and drafts), so the window can say how many a name will cover.
export function payeeCount(state, key) {
  return state.transactions.filter((t) => payeeKey(t.payee) === key && state.entries.some((e) => e.transaction_id === t.id && e.category_id)).length;
}

// Name a payee and give it a category. Returns {ok, book, state}: the new book for settings, and the state with this payee's DRAFTS in Unlogged moved to the
// category (a draft can still change; a verified entry is final and only shows under it). A name may be left empty; the category is needed.
export function namePayee(state, book, key, { name = "", category_id }) {
  if (!key) return { ok: false, message: "There is no such payee." };
  const cat = state.categories.find((c) => c.id === category_id && c.kind === "expense");
  if (!cat || cat.id === UNLOGGED_CATEGORY_ID) return { ok: false, message: "Choose a category." };
  const clean = String(name ?? "").trim().slice(0, 40);
  const next = { ...(book ?? {}), [key]: { ...(clean ? { name: clean } : {}), category_id } };
  const drafts = new Set(state.transactions.filter((t) => t.status !== "verified" && payeeKey(t.payee) === key).map((t) => t.id));
  const entries = drafts.size ? state.entries.map((e) => (drafts.has(e.transaction_id) && e.category_id === UNLOGGED_CATEGORY_ID ? { ...e, category_id } : e)) : state.entries;
  return { ok: true, book: next, state: entries === state.entries ? state : { ...state, entries } };
}

// The category the owner gave this payee, for an import ("your name for them"); null when none.
export function categoryFromBook(state, book, name) {
  const c = entryOf(book, payeeKey(name))?.category_id;
  return c && state.categories.some((x) => x.id === c && x.kind === "expense") && c !== UNLOGGED_CATEGORY_ID ? c : null;
}
