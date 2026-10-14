import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { COLLECTION_NAMES, LEDGER_VERSION, parseLedger, chooseLedger, upgradeLedger, fingerprint, naturalBalance, backupFileName, FIRST_RUN_NOTICE } from "../src/model/index.js";

// The app is called fo/und, WITH the slash, on the screen only. Nothing technical carries the slash, and nothing that holds data was renamed:
// renaming a storage key or database would leave every existing ledger where the app no longer looks.
const ROOT = new URL("../", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("the display name fo/und (with the slash) is in the manifest, the page title, the iPhone title and the first-run notice", () => {
  const m = JSON.parse(read("app/manifest.json"));
  assert.equal(m.name, "fo/und");
  assert.equal(m.short_name, "fo/und");
  const html = read("app/index.html");
  assert.match(html, /<title>fo\/und<\/title>/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="fo\/und">/);
  assert.ok(FIRST_RUN_NOTICE.title.includes("fo/und"));
});

test("Help carries the one line about getting the new icon and name on iPhone, under Setup", async () => {
  const { TOPICS } = await import("../src/model/help.js");
  const setup = TOPICS.find((t) => t.tab === "setup");
  assert.ok(setup.lines.includes("To get the new icon and name on iPhone: make a backup first, then add the app to your Home Screen again. Do not remove the old one until the backup is checked."));
});

test("nothing technical carries the slash: no file or folder name, no element id, no storage name, no backup file name", () => {
  const walk = (dir) => readdirSync(join(ROOT, dir)).filter((n) => n !== ".git" && n !== "node_modules" && n !== "vendor").flatMap((n) => {
    const rel = dir ? dir + "/" + n : n;
    return statSync(join(ROOT, rel)).isDirectory() ? [rel, ...walk(rel)] : [rel];
  });
  const files = walk("");
  assert.ok(files.length > 50);
  assert.ok(files.every((f) => !/fo\/und|fo\\und/i.test(f.split("/").pop())), "no file is named with the slash (a slash cannot be in a file name anyway)");
  for (const f of ["app/index.html", "app/app.js"]) for (const m of read(f).matchAll(/\bid="([^"$]*)"/g)) assert.ok(!m[1].includes("/"), f + ": element id " + m[1]);
  assert.ok(!backupFileName("2026-10-03").includes("/") && backupFileName("2026-10-03").endsWith("2026-10-03.json"));
});

test("the storage names are exactly what they were: the ledger key, the database, the pre-upgrade copies and the trial pair", () => {
  const store = read("app/store.js");
  assert.match(store, /let LS_KEY = "financialTracker\.ledger", DB_NAME = "financialTracker";/);
  assert.match(store, /let COPIES_KEY = "financialTracker\.preupgrade";/);
  assert.match(store, /LS_KEY = "financialTracker\.trial\.ledger"; COPIES_KEY = "financialTracker\.trial\.preupgrade"; DB_NAME = "financialTracker-trial";/);
  assert.match(store, /const STORE = "kv", KEY = "ledger", PHOTOS = "photos", SAFETY = "safety";/);
  const names = [...store.matchAll(/"(financialTracker[\w.-]*)"/g)].map((m) => m[1]);
  assert.ok(names.every((n) => !/fo|und/.test(n)), "no storage name mentions the new name");
});

// A copy saved by data version 4, written out by hand (invented names and amounts), as it sits in the phone's two stores.
const TS = "2026-03-04T09:00:00.000+08:00";
function v4Saved() {
  const state = Object.fromEntries(COLLECTION_NAMES.map((k) => [k, []]));
  state.accounts = [{ id: "wal", name: "Test Wallet", class: "asset", role: "", hidden_by_default: false, archived: false, opening_balance: 100000, opening_date: "2026-01-01" }];
  state.categories = [{ id: "cat-food", name: "Food", kind: "expense" }, { id: "cat-fun", name: "Fun", kind: "expense" }];
  state.transactions = [{ id: "t1", date: "2026-03-04", payee: "Sample Shop", memo: "", status: "verified", source: "manual", created_at: TS, verified_at: TS }];
  state.entries = [{ transaction_id: "t1", category_id: "cat-food", amount: 9500 }, { transaction_id: "t1", account_id: "wal", amount: -9500 }];
  return { v: 4, rev: 31, saved_at: TS, state, settings: { last_backup_at: TS } };
}

test("a version 4 saved copy is still found under the unchanged names and keeps its data: same accounts, entries and balance after the upgrade", () => {
  const text = JSON.stringify(v4Saved());
  const found = chooseLedger(text, text);   // what the app does at start with the text it read from localStorage and IndexedDB
  assert.equal(found.status, "OK");
  assert.equal(found.ledger.v, 4);
  assert.ok(parseLedger(text).older, "an older data version, to be upgraded with a copy kept first");
  const up = upgradeLedger(found.ledger);
  assert.ok(up.ok, up.error);
  assert.equal(up.ledger.v, LEDGER_VERSION);
  assert.deepEqual(up.ledger.state.accounts.map((a) => [a.id, a.name]), [["wal", "Test Wallet"]]);
  assert.deepEqual(up.ledger.state.transactions.map((t) => [t.id, t.payee, t.status]), [["t1", "Sample Shop", "verified"]]);
  assert.equal(up.ledger.state.entries.length, 2);
  assert.equal(naturalBalance(up.ledger.state.accounts[0], up.ledger.state.entries), 90500);
  assert.equal(fingerprint(up.ledger), fingerprint(found.ledger), "the totals did not move");
});
