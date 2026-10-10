// Upgrading saved data. The ledger on the phone says which data version wrote it (`v`). When the app expects a newer one, the data is
// converted step by step, checked, and only then saved. Rules, from the owner:
//  - Never delete or rename a field in a migration: add new fields and stop using the old ones.
//  - Before any migration a copy of the data is kept (the last two copies are kept; see rotateCopies).
//  - After any migration a self-check runs; if it fails nothing is saved (the app keeps the old data), and a bad write is undone from the copy.
// Pure logic only; the app does the reading and writing (app/store.js, app/app.js).
import { validateState } from "./validate.js";
import { reserveShortfalls, naturalBalance } from "./balances.js";
import { phTimestamp } from "./util.js";

// Version 2 is the first with named migrations. To change the data's shape: raise this number, add the step from the old number to MIGRATIONS,
// add a backup fixture of the old version to tests/migrate.test.js, and add the new collection to COLLECTION_NAMES.
export const LEDGER_VERSION = 9;
export const COLLECTION_NAMES = ["accounts", "goals", "envelopes", "transactions", "entries", "categories", "categoryMaps", "rules",
  "templates", "presets", "payeeRules", "subscriptions", "checkIns", "attachments", "tags", "foreignAmounts", "surveyResponses", "payslips", "payslipLines", "payslipRevisions", "schedules", "scheduleChanges"];

// Each step takes a ledger of version N and returns one of N + 1 (the runner sets `v`). Steps only add.
export const MIGRATIONS = {
  // 1 to 2: ledgers saved before payslips, earlier figures and the like lack some collections. Every missing one is added, empty.
  1: (ledger) => ({ ...ledger, state: { ...Object.fromEntries(COLLECTION_NAMES.map((k) => [k, []])), ...ledger.state } }),
  // 2 to 3: roles instead of name matching. Each is given ONCE, from what the old code looked for by name, so the data behaves exactly as before.
  //  - A category named Food, Essentials, Subscription or Rent (any capitals) gets that role, so the scanner's guess no longer depends on the name.
  //  - The FIRST goal whose name has "emergency" in it gets the role "emergency" (the old code took the first match).
  //  - A goal with "mole" and one with "emergency" in the name (the old month-end sweep) become the sweep order [that goal, the emergency goal]; the
  //    first one's own target caps it, as before. With either missing there was no sweep before, so none is set.
  2: (ledger) => {
    const state = ledger.state, settings = ledger.settings ?? {};
    const ROLE_OF = { food: "food", essentials: "essentials", subscription: "subscription", rent: "rent" };
    const categories = (state.categories ?? []).map((c) => (c.role === undefined && c.kind === "expense" && ROLE_OF[String(c.name).trim().toLowerCase()] ? { ...c, role: ROLE_OF[String(c.name).trim().toLowerCase()] } : c));
    const goalsIn = state.goals ?? [], emergency = goalsIn.find((g) => /emergency/i.test(g.name)), mole = goalsIn.find((g) => /mole/i.test(g.name));
    const goals = goalsIn.map((g) => (g === emergency && g.role === undefined ? { ...g, role: "emergency" } : g));
    const sweep = settings.sweep_order === undefined && emergency && mole && mole !== emergency ? { sweep_order: [{ goal_id: mole.id }, { goal_id: emergency.id }] } : {};
    return { ...ledger, state: { ...state, categories, goals }, settings: { ...settings, ...sweep } };
  },
  // 3 to 4: trips have dates, and membership is worked out from them. The old "tag_id" on a transaction (put on a trip by hand or by a manual start)
  // becomes the new field "trip_add" (a hand-added entry that overrides the dates). tag_id itself is left in place, unread. Trips get no dates, so
  // every existing trip counts exactly the entries it counted before.
  3: (ledger) => ({ ...ledger, state: { ...ledger.state, transactions: (ledger.state.transactions ?? []).map((t) => (t.tag_id != null && t.trip_add === undefined ? { ...t, trip_add: t.tag_id } : t)) } }),
  // 4 to 5: two more category roles, so the starter budget can tell a need from a want by ROLE and not by name: transport and health. They are given ONCE,
  // to expense categories that have no role yet and whose name starts the way the starter names do ("Transport...", "Health..."). Nothing else changes.
  4: (ledger) => ({ ...ledger, state: { ...ledger.state, categories: (ledger.state.categories ?? []).map((c) => {
    if (c.role !== undefined || c.kind !== "expense") return c;
    const n = String(c.name).trim().toLowerCase();
    return /^transpo/.test(n) ? { ...c, role: "transport" } : /^health(care)?\b/.test(n) ? { ...c, role: "health" } : c;
  }) } }),
  // 5 to 6: more category roles, so a category's bucket (need, want, savings) can come from its role, and a goal may have no account yet.
  //  - Roles are given ONCE, to expense categories that have no role, by the exact starter names: Shopping, Fun, Utilities (or Utility), Dining (or Dining out). Nothing else changes.
  //  - Goals may now leave out account_id (a goal not tied to an account yet). Existing goals all have one, so nothing is converted; the step is the version.
  5: (ledger) => ({ ...ledger, state: { ...ledger.state, categories: (ledger.state.categories ?? []).map((c) => {
    if (c.role !== undefined || c.kind !== "expense") return c;
    const n = String(c.name).trim().toLowerCase();
    return n === "shopping" ? { ...c, role: "shopping" } : n === "fun" ? { ...c, role: "fun" } : n === "utilities" || n === "utility" ? { ...c, role: "utilities" } : n === "dining" || n === "dining out" ? { ...c, role: "dining" } : c;
  }) } }),
  // 6 to 7: an account may hold the last 4 digits of its number (`last4`), so a payment screenshot can tell the owner's own accounts apart; a transaction may
  // hold the time its screenshot showed (`shot_time`); a category may hold the role "bank_fees". Every account gets last4 "" (none given). Nothing is removed or renamed.
  6: (ledger) => ({ ...ledger, state: { ...ledger.state, accounts: (ledger.state.accounts ?? []).map((a) => (a.last4 === undefined ? { ...a, last4: "" } : a)) } }),
  // 7 to 8: scheduled payments. Two new collections, `schedules` and `scheduleChanges`, start empty; a transaction may name the schedule it belongs to.
  // Nothing existing is changed, so every total is the same.
  7: (ledger) => ({ ...ledger, state: { ...ledger.state, schedules: ledger.state.schedules ?? [], scheduleChanges: ledger.state.scheduleChanges ?? [] } }),
  // 8 to 9: corrections at the Weekly review. A transaction may carry `reverses` (the verified entry it cancels) or `corrects` (the entry a fresh draft replaces),
  // and a new source "correction" exists. Nothing existing has these, so nothing is changed and every total is the same; the version number only stops an older app from
  // reading data it does not understand.
  8: (ledger) => ({ ...ledger }),
};

const clone = (x) => JSON.parse(JSON.stringify(x));

// Plain-words problems found in a ledger; an empty list means it is sound. `reserve` is the card reserve check (replaceable for a test).
export function selfCheck(ledger, { reserve = reserveShortfalls } = {}) {
  const out = [], s = ledger?.state;
  if (!s || typeof s !== "object") return ["The saved data has no records in it."];
  const bad = validateState(s);
  if (bad.length) out.push("A record is not in the right shape: " + bad[0].message);
  const sums = new Map();
  for (const e of s.entries ?? []) sums.set(e.transaction_id, (sums.get(e.transaction_id) ?? 0) + e.amount);
  const off = (s.transactions ?? []).filter((t) => (sums.get(t.id) ?? 0) !== 0);
  if (off.length) out.push(off.length + (off.length === 1 ? " entry does" : " entries do") + " not add up to zero.");
  try { if (!Array.isArray(reserve(s.accounts ?? [], s.entries ?? []))) out.push("The card reserve check gave no answer."); }
  catch { out.push("The card reserve check could not be worked out."); }
  return out;
}

// What must be the same before and after an upgrade: how many records, and what every account holds.
export function fingerprint(ledger) {
  const s = ledger.state ?? {};
  return JSON.stringify({
    counts: Object.fromEntries(Object.entries(s).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]).filter(([, n]) => n > 0).sort()),
    balances: (s.accounts ?? []).map((a) => [a.id, naturalBalance(a, s.entries ?? [])]),
  });
}

const fail = (error) => ({ ok: false, error });

// Converts a ledger of an older version to the current one. Returns {ok, ledger, steps} or {ok:false, error, problems?}. The input is never changed.
export function upgradeLedger(ledger, { migrations = MIGRATIONS, check = selfCheck, now = new Date() } = {}) {
  if (ledger?.v === LEDGER_VERSION) return { ok: true, ledger, steps: 0 };
  if (!Number.isInteger(ledger?.v) || ledger.v < 1 || ledger.v > LEDGER_VERSION) return fail("This data was written by a version this app does not know.");
  const before = fingerprint(ledger);
  let cur = clone(ledger), steps = 0;
  for (let v = ledger.v; v < LEDGER_VERSION; v++) {
    const step = migrations[v];
    if (typeof step !== "function") return fail("There is no way to update data from version " + v + ".");
    try { cur = { ...step(cur), v: v + 1 }; steps++; } catch { return fail("The update of your data stopped part way."); }
  }
  cur = { ...cur, rev: ledger.rev + 1, saved_at: phTimestamp(now) };
  const problems = check(cur);
  if (problems.length) return { ok: false, error: "A check found a problem after the update: " + problems[0], problems };
  if (fingerprint(cur) !== before) return fail("The totals were not the same after the update.");
  return { ok: true, ledger: cur, steps };
}

// The data without the bookkeeping that changes on every save, to tell whether two copies hold the same thing.
const content = (l) => JSON.stringify({ v: l.v, state: l.state, settings: l.settings });

// The copies kept from before an upgrade, newest first, at most `keep`. `copies` is [{at, from_version, build, text}]. A copy of data that is
// already the newest copy is not added again (restoring a copy and upgrading again would otherwise push the older ones out).
export function rotateCopies(copies, text, meta, keep = 2) {
  const list = Array.isArray(copies) ? copies : [];
  try { if (list[0] && content(JSON.parse(list[0].text)) === content(JSON.parse(text))) return list.slice(0, keep); } catch { /* an unreadable older copy is simply replaced */ }
  return [{ ...meta, text }, ...list].slice(0, keep);
}

// A stored copy ready to put back: it keeps its own data version (the app upgrades it again on the next start) and is stamped newer than what
// is on the phone, so the restore wins if the two stores ever disagree.
export function restorableCopy(copy, currentRev, now = new Date()) {
  const l = JSON.parse(copy.text);
  return { ...l, rev: Math.max(currentRev, l.rev) + 1, saved_at: phTimestamp(now) };
}
