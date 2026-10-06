import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MENU_GROUPS } from "../src/model/names.js";
import { QUICK_NOTES, FIRST_RUN_NOTICE, TOPICS, checklist } from "../src/model/help.js";

const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");

test("the five quick notes are there, in the owner's words", () => {
  assert.equal(QUICK_NOTES.length, 5);
  assert.match(QUICK_NOTES[0], /still being built/);
  assert.match(QUICK_NOTES[1], /only on your phone/);
  assert.match(QUICK_NOTES[2], /Setup, then Backup/); assert.match(QUICK_NOTES[2], /passphrase/); assert.match(QUICK_NOTES[2], /can't be opened/);
  assert.match(QUICK_NOTES[3], /Home Screen icon, not a Safari tab/);
  assert.match(QUICK_NOTES[4], /screenshot/); assert.match(QUICK_NOTES[4], /Never send your backup file/);
});

test("every screen in the menu, and the bottom bar, has a help topic (so adding a screen means writing its help)", () => {
  assert.match(app, /const MENU = M\.MENU_GROUPS\.map/, "the menu is built from the shared names");
  const screens = MENU_GROUPS.flatMap(([, ids]) => ids);
  assert.ok(screens.length >= 10, "found the menu screens: " + screens.join());
  const have = new Set(TOPICS.map((t) => t.tab));
  for (const id of [...screens, "setup", "log", "verify", "income"]) assert.ok(have.has(id), "a help topic for " + id);
  for (const t of TOPICS) { assert.ok(t.label && t.lines.length >= 1 && t.lines.every((l) => l.length < 260), t.tab + " is short and has words"); }
  assert.equal(new Set(TOPICS.map((t) => t.tab)).size, TOPICS.length, "no screen twice");
});

test("every topic opens a screen the app really has", () => {
  const known = new Set([...app.matchAll(/ui\.tab === "([a-z]+)"/g)].map((m) => m[1]));
  for (const t of TOPICS) assert.ok(known.has(t.tab) || t.tab === "log", t.tab + " is a screen in app.js");
});

test("the getting-started steps tick themselves from the data", () => {
  const empty = checklist({ accounts: [], transactions: [] }, {});
  assert.deepEqual(empty.map((s) => s.done), [false, false, false]);
  const some = checklist({ accounts: [{ id: "a" }], transactions: [{ id: "t" }] }, { last_backup_at: "2026-10-05T09:00:00.000+08:00" });
  assert.deepEqual(some.map((s) => s.done), [true, true, true]);
  assert.deepEqual(checklist({ accounts: [{ id: "a" }], transactions: [] }, {}).map((s) => s.done), [true, false, false]);
});

test("the first-run notice says the five plain things: data stays here, nothing recovers a lost phone or passphrase, back up now, iPhone Home Screen, Android site data", () => {
  const all = FIRST_RUN_NOTICE.lines.join(" ");
  assert.equal(FIRST_RUN_NOTICE.lines.length, 5);
  assert.match(FIRST_RUN_NOTICE.lines[0], /stays on this phone/);
  assert.match(FIRST_RUN_NOTICE.lines[1], /lost phone/); assert.match(FIRST_RUN_NOTICE.lines[1], /forgotten backup passphrase/); assert.match(FIRST_RUN_NOTICE.lines[1], /cannot be recovered/);
  assert.match(FIRST_RUN_NOTICE.lines[2], /backup now/);
  assert.match(FIRST_RUN_NOTICE.lines[3], /^iPhone: add this app to the Home Screen first/);
  assert.match(FIRST_RUN_NOTICE.lines[4], /^Android: clearing the browser's site data erases the ledger/);
  assert.ok(all.length < 520, "short enough to read at a glance");
});

test("Help words never name an owner-specific goal or category, and the goals topic speaks of roles", () => {
  const words = TOPICS.flatMap((t) => t.lines).join(" ") + QUICK_NOTES.join(" ") + FIRST_RUN_NOTICE.lines.join(" ");
  for (const owner of ["Mole", "Lakat", "Upskill", "Family"]) assert.ok(!words.includes(owner), owner);
  assert.match(TOPICS.find((t) => t.tab === "goals").lines.join(" "), /Choose which goal is your emergency fund/);
});
