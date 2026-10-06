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
export const LEDGER_VERSION = 5;
export const COLLECTION_NAMES = ["accounts", "goals", "envelopes", "transactions", "entries", "categories", "categoryMaps", "rules",
  "templates", "presets", "payeeRules", "subscriptions", "checkIns", "attachments", "tags", "foreignAmounts", "surveyResponses", "payslips", "payslipLines", "payslipRevisions"];

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
