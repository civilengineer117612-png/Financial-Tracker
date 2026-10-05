import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QUICK_NOTES, TOPICS, checklist } from "../src/model/help.js";

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
  const menu = app.match(/const MENU = (\[\[.*\]\]);/)[1];
  const screens = [...menu.matchAll(/\["([a-z]+)", "([^"]+)"\]/g)].map((m) => m[1]);
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
