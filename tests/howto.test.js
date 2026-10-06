import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHANGES, whatsNew, HOWTOS, HOWTO_HINT, clipData, howtoClip } from "../src/model/index.js";

// Invented names and numbers only.
const own = { date: "Tue, 7 Oct", tiles: [{ name: "Coffee shop", amount: 18000, category: "Food" }, { name: "Train", amount: 3000, category: "Transpo" }, { name: "Lunch", amount: 9500, category: "Food" }],
  account: { name: "Test Wallet", picture: '<span class="ico mono">T</span>' }, total: 20000 };

test("What's new: newest first, each one dated sentence, shown until the newest is seen, three at a time", () => {
  assert.ok(CHANGES.length >= 3);
  for (const c of CHANGES) { assert.match(c.date, /^\d{4}-\d{2}-\d{2}$/); assert.ok(c.text.length > 10 && c.text.length < 200 && /\.$/.test(c.text), c.id); }
  assert.equal(new Set(CHANGES.map((c) => c.id)).size, CHANGES.length, "ids are unique");
  assert.ok(CHANGES.every((c, i) => i === 0 || c.date <= CHANGES[i - 1].date), "newest first");
  assert.deepEqual(whatsNew({}).map((c) => c.id), CHANGES.slice(0, 3).map((c) => c.id));
  assert.deepEqual(whatsNew({ whatsnew_seen: CHANGES[0].id }), []);
  assert.equal(whatsNew({ whatsnew_seen: CHANGES[1].id }).length, 3, "an older one seen: the latest three show again");
});

test("the log clip is drawn from the owner's own tiles, account, date and total", () => {
  const h = howtoClip("log", own);
  for (const w of ["Coffee shop", "Train", "Lunch", "Test Wallet", "Tue, 7 Oct", "₱200.00", "₱30.00", "₱230.00"]) assert.ok(h.includes(w), w);
  assert.ok(h.includes('class="ico mono"'), "the account's own picture");
  assert.ok(!h.includes("Example"), "nothing is marked as an example");
  assert.match(h, /hw-tile hw-pick"><b>Train/, "the middle tile is the one tapped");
  assert.match(h, /role="img" aria-label="A finger taps the Train tile/);
});

test("with no tiles or no account yet, plainly marked examples stand in", () => {
  const h = howtoClip("log", { date: "Tue, 7 Oct", tiles: [], account: null, total: 0 });
  assert.ok(h.includes("Example") && h.includes("Wallet"));
  assert.equal(clipData({ date: "x", tiles: own.tiles, account: null }).example, true, "tiles without an account are still an example");
});

test("verify and scan clips use the same data; the scan clip draws an invented receipt and saves a draft", () => {
  const v = howtoClip("verify", own), sc = howtoClip("scan", own);
  assert.ok(v.includes("Correct") && v.includes("Train") && v.includes("Test Wallet") && v.includes("hw-verify"));
  assert.ok(sc.includes("SAMPLE STORE") && sc.includes("Save as a draft") && sc.includes("Test Wallet") && sc.includes("hw-scan"));
  assert.equal(howtoClip("nope", own), "");
});

test("names from the owner's screen are escaped, never run as markup", () => {
  const h = howtoClip("log", { ...own, tiles: [{ name: '<img src=x onerror="alert(1)">', amount: 100, category: "Food" }] });
  assert.ok(!h.includes("<img src=x") && h.includes("&lt;img src=x"));
});

test("every clip has one caption; the hint names the buttons that hold a how-to, and the app wires exactly those", () => {
  assert.deepEqual(HOWTOS.map((h) => h.id), ["log", "verify", "scan"]);
  for (const h of HOWTOS) assert.ok(h.caption && h.label && h.caption.length < 80, h.id);
  assert.match(HOWTO_HINT, /^Hold Log, Verify or the camera/);
  const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8"), css = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(app, /data-tab="\$\{id\}" data-howto="\$\{id\}"/); assert.match(app, /class="camicon" data-action="open-scan-pick" data-howto="scan"/);
  assert.match(app, /class="tile addtile" data-action="add-tile" data-howto="log"/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n    \.hw \*/, "Reduce Motion stops every clip");
  for (const k of ["hwLogFinger", "hwVerFinger", "hwScanFinger"]) assert.ok(css.includes(`@keyframes ${k}`), k);
});
