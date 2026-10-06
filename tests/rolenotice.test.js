import { test } from "node:test";
import assert from "node:assert/strict";
import { roleNoticeRows, setCategoryRole, defaultCategories, upgradeLedger, CATEGORY_ROLES } from "../src/model/index.js";

// Invented ledger as data version 5 left it: four categories hold a role only because of their exact names.
const cat = (id, name, role) => ({ id, name, kind: "expense", ...(role ? { role } : {}) });
const state = (cats) => ({ categories: cats });

test("the notice lists each category given a role by exact name, with its role", () => {
  const rows = roleNoticeRows(state([cat("a", "Shopping", "shopping"), cat("b", "fun ", "fun"), cat("c", "Utility", "utilities"), cat("d", "Dining out", "dining"), cat("e", "Food", "food")]), {});
  assert.deepEqual(rows.map((r) => [r.id, r.role]), [["a", "shopping"], ["b", "fun"], ["c", "utilities"], ["d", "dining"]]);
});

test("a category the owner renamed, or gave a role later, is not listed", () => {
  assert.deepEqual(roleNoticeRows(state([cat("a", "Treats", "fun"), cat("b", "Gifts", "shopping")]), {}), []);
});

test("nothing is listed once the notice was seen, or on a new install", () => {
  const s = state([cat("a", "Shopping", "shopping")]);
  assert.equal(roleNoticeRows(s, { roles_notice_seen: "2026-10-06T09:00:00.000+08:00" }).length, 0);
  assert.equal(roleNoticeRows(s, undefined).length, 1);
});

test("an upgraded v5 ledger lists exactly what step 5 gave", () => {
  const v5 = { v: 5, rev: 1, saved_at: null, settings: {}, state: state([cat("a", "Shopping"), cat("b", "Fun"), cat("c", "Rent", "rent"), cat("d", "Gifts")]) };
  const up = upgradeLedger(v5);
  const ledger = up.ledger ?? up;
  assert.deepEqual(roleNoticeRows(ledger.state, ledger.settings).map((r) => r.id), ["a", "b"]);
});

test("setCategoryRole changes, clears and refuses", () => {
  const s = { categories: [cat("a", "Shopping", "shopping"), cat("b", "Treats"), { id: "inc", name: "Salary", kind: "income" }] };
  const r = setCategoryRole(s, "a", "fun");
  assert.equal(r.ok, true); assert.equal(r.state.categories[0].role, "fun");
  assert.equal(setCategoryRole(s, "a", null).state.categories[0].role, undefined);
  assert.equal("role" in setCategoryRole(s, "a", null).state.categories[0], false);
  const shared = setCategoryRole(s, "b", "shopping");
  assert.equal(shared.ok, true, "many categories can share a Type");
  assert.deepEqual(shared.state.categories.filter((x) => x.role === "shopping").map((x) => x.id), ["a", "b"]);
  assert.equal(setCategoryRole(s, "b", "essentials").violations[0].code, "BAD_ROLE", "an older Type can be kept but not newly given");
  assert.equal(setCategoryRole({ categories: [cat("e", "Needs", "essentials")] }, "e", "essentials").ok, true);
  assert.equal(setCategoryRole(s, "b", "banana").violations[0].code, "BAD_ROLE");
  assert.equal(setCategoryRole(s, "inc", "fun").violations[0].code, "FIXED_CATEGORY");
  assert.equal(setCategoryRole(s, "zzz", "fun").violations[0].code, "UNKNOWN_CATEGORY");
});

test("every role in the list is accepted by the schema, and a new install is not in the notice", () => {
  assert.equal(CATEGORY_ROLES.length, 12);
  const base = { categories: defaultCategories() };
  assert.equal(roleNoticeRows(base, {}).length, 2);   // the starter Shopping and Fun carry roles: a new install sets roles_notice_seen at start (app), so it shows nothing
});
