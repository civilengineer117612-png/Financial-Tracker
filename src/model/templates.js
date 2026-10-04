// Spec 8.1, load reduction: templates create DRAFTS on their dates (rent, subscriptions,
// family fund, payday transfers) and a reserve transfer is generated with each card
// purchase. Drafts are verified by you the next morning (8.2); nothing here is final.
//
// Schedule format (the spec leaves it open, this is the choice made here):
//   "monthly:20"        on the 20th        "monthly:15,last"   on the 15th and month end
// A day past the end of a short month falls on that month's last day.
//
// A template with ONE account is an expense (its category comes from a PayeeRule match
// on the payee); with TWO accounts it is a transfer [source, destination].
import { validateShape } from "./schema.js";
import { checkTransactionSave } from "./index.js";
import { phTimestamp } from "./util.js";

const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m = 1..12

export function parseSchedule(s) {
  const m = /^monthly:(.+)$/.exec(s);
  if (!m) return null;
  const days = m[1].split(",").map((x) => x.trim());
  const ok = days.every((d) => d === "last" || (/^\d{1,2}$/.test(d) && Number(d) >= 1 && Number(d) <= 31));
  return ok ? days.map((d) => (d === "last" ? "last" : Number(d))) : null;
}

export function isDue(schedule, date) {
  const days = parseSchedule(schedule);
  if (!days) return false;
  const [y, m, d] = date.split("-").map(Number);
  const end = lastDay(y, m);
  return days.some((x) => (x === "last" ? end : Math.min(x, end)) === d);
}

// Every date from..to inclusive, so days the app was not opened still get their drafts.
export function datesBetween(from, to) {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// Most specific match wins: the longest pattern found inside the payee, ignoring case.
export function categoryForPayee(payeeRules, payee) {
  const hit = payeeRules
    .filter((r) => payee.toLowerCase().includes(r.payee_pattern.toLowerCase()))
    .sort((a, b) => b.payee_pattern.length - a.payee_pattern.length)[0];
  return hit ? hit.category_id : null;
}

const err = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }], transaction: null, entries: [] });

// The deterministic id means running the same date twice never makes a second draft.
export const draftId = (templateId, date) => "tpl:" + templateId + ":" + date;

export function draftFromTemplate(state, template, payeeRules, date, now = new Date()) {
  const shape = validateShape("Template", template);
  if (shape.length) return { ok: false, violations: shape, transaction: null, entries: [] };
  if (!parseSchedule(template.schedule)) return err("BAD_SCHEDULE", "unreadable schedule " + template.schedule);
  const id = draftId(template.id, date);
  if (state.transactions.some((t) => t.id === id)) return { skipped: true, ok: true, violations: [], transaction: null, entries: [] };

  const byId = new Map(state.accounts.map((a) => [a.id, a]));
  // A card leg needs its pending/posted state: a new charge is pending, a payment is posted.
  const leg = (account_id, amount, state_) => ({
    transaction_id: id, account_id, amount,
    ...(byId.get(account_id)?.class === "liability" ? { card_state: state_ } : {}),
  });

  let entries;
  if (template.accounts.length === 1) {
    const category_id = categoryForPayee(payeeRules, template.payee);
    if (!category_id) return err("NO_CATEGORY", "no payee rule matches " + template.payee);
    entries = [{ transaction_id: id, category_id, amount: template.amount }, leg(template.accounts[0], -template.amount, "pending")];
  } else if (template.accounts.length === 2) {
    const [source, destination] = template.accounts;
    entries = [leg(destination, template.amount, "posted"), leg(source, -template.amount, "pending")];
  } else {
    return err("BAD_TEMPLATE_ACCOUNTS", "a template needs one account (expense) or two (transfer)");
  }

  const transaction = {
    id, date, payee: template.payee, memo: "", status: "draft", source: "template", created_at: phTimestamp(now),
  };
  return { ...checkTransactionSave(state, { transaction, entries }), transaction, entries };
}

// All drafts due in a date range. Each draft is judged against the state as it stands;
// the caller saves the ok ones and may call again with the grown state.
export function draftsForRange(state, templates, payeeRules, from, to, now = new Date()) {
  const out = [];
  for (const date of datesBetween(from, to)) {
    for (const t of templates) {
      if (!isDue(t.schedule, date)) continue;
      const r = draftFromTemplate(state, t, payeeRules, date, now);
      if (!r.skipped) out.push({ template_id: t.id, date, ...r });
    }
  }
  return out;
}

// Card reserve transfer, generated with each credit purchase (spec 8.1): for every card
// that a reserve account covers, move the amount the purchase added from the source
// account (the debit account hosting the reserve) into that reserve. Payments and refunds
// reduce what is owed and generate nothing.
export function planReserveTransfer(state, { transaction, entries }, sourceAccountId, now = new Date()) {
  const byId = new Map(state.accounts.map((a) => [a.id, a]));
  const out = [];
  for (const reserve of state.accounts.filter((a) => a.reserve_for)) {
    const added = -entries.filter((e) => e.account_id === reserve.reserve_for).reduce((s, e) => s + e.amount, 0);
    if (added <= 0 || !byId.has(sourceAccountId)) continue;
    const id = "rsv:" + transaction.id;
    const t = { id, date: transaction.date, payee: "Card reserve", memo: "for " + transaction.id,
                status: "draft", source: "template", created_at: phTimestamp(now) };
    const es = [
      { transaction_id: id, account_id: reserve.id, amount: added },
      { transaction_id: id, account_id: sourceAccountId, amount: -added },
    ];
    out.push({ ...checkTransactionSave(state, { transaction: t, entries: es }), transaction: t, entries: es });
  }
  return out;
}

// A quick tile on the Log screen, changed by the owner: its name, amount (centavos) and spending category. Only the tile changes;
// nothing is logged. Returns {ok, state} or {ok: false, error} in plain words.
export function updatePreset(state, id, { name, amount, category_id }) {
  const p = (state.presets ?? []).find((x) => x.id === id);
  if (!p) return { ok: false, error: "That tile is no longer there." };
  const n = String(name ?? "").trim();
  if (!n) return { ok: false, error: "Give the tile a name." };
  if (n.length > 24) return { ok: false, error: "Keep the name short: 24 letters at most." };
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, error: "Type an amount above zero." };
  if (!(state.categories ?? []).some((c) => c.id === category_id && c.kind === "expense")) return { ok: false, error: "Choose a spending category." };
  return { ok: true, state: { ...state, presets: state.presets.map((x) => (x.id === id ? { ...x, name: n, amount, category_id } : x)) } };
}

// Up to six quick tiles on the Log screen. Add, remove and move them; none of this logs anything.
export const MAX_PRESETS = 6;
const checkTile = (state, { name, amount, category_id }) => {
  const n = String(name ?? "").trim();
  if (!n) return { error: "Give the tile a name." };
  if (n.length > 24) return { error: "Keep the name short: 24 letters at most." };
  if (!Number.isSafeInteger(amount) || amount <= 0) return { error: "Type an amount above zero." };
  if (!(state.categories ?? []).some((c) => c.id === category_id && c.kind === "expense")) return { error: "Choose a spending category." };
  return { n };
};
export function addPreset(state, tile, id) {
  if ((state.presets ?? []).length >= MAX_PRESETS) return { ok: false, error: "Six tiles is the most. Remove one first." };
  if ((state.presets ?? []).some((p) => p.id === id)) return { ok: false, error: "That tile already exists." };
  const c = checkTile(state, tile);
  if (c.error) return { ok: false, error: c.error };
  return { ok: true, state: { ...state, presets: [...(state.presets ?? []), { id, name: c.n, amount: tile.amount, category_id: tile.category_id }] } };
}
export function removePreset(state, id) {
  if (!(state.presets ?? []).some((p) => p.id === id)) return { ok: false, error: "That tile is no longer there." };
  return { ok: true, state: { ...state, presets: state.presets.filter((p) => p.id !== id) } };
}
// ids: every tile's id, in the new order (nothing missing, nothing added).
export function reorderPresets(state, ids) {
  const have = (state.presets ?? []).map((p) => p.id);
  if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((i) => have.includes(i))) return { ok: false, error: "The new order does not match the tiles." };
  return { ok: true, state: { ...state, presets: ids.map((i) => state.presets.find((p) => p.id === i)) } };
}
