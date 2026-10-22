// Invented ledger only. Serve the repo on port 8124 before running this check.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { emptyLedger, CHANGES } from "../src/model/index.js";
import { makeState, commit, tx } from "../tests/fixtures.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? execSync("npm root -g").toString().trim() + "/playwright");
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const base = process.env.BASE ?? "http://127.0.0.1:8124/app/index.html";
const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1" });
await ctx.route("**/*", (r) => new URL(r.request().url()).origin === new URL(base).origin ? r.continue() : r.abort());
await ctx.addInitScript(() => { Object.defineProperty(navigator, "standalone", { get: () => true }); sessionStorage.setItem("logOpen", "1"); });
const page = await ctx.newPage(), errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const close = () => page.locator('#sheet [data-action="close-sheet"]').last().click();
try {
  await page.clock.setFixedTime(new Date("2026-10-22T03:00:00Z"));
  await page.goto(base); await page.locator("#nav button").first().waitFor();
  const seed = emptyLedger(), state = makeState();
  state.categories.push({ id: "travel", name: "Travel", kind: "expense" }, { id: "old-food", name: "Old Food", kind: "expense" });
  const add = (id, date, entries, extra = {}) => commit(state, { transaction: tx({ id, date, payee: "Sample " + id, status: "verified", verified_at: "2026-10-22T08:00:00.000+08:00", ...extra }), entries: entries.map((e) => ({ transaction_id: id, ...e })) });
  add("split", "2026-10-20", [{ category_id: "food", amount: 20000 }, { category_id: "travel", amount: 10000 }, { account_id: "chk", amount: -30000 }]);
  add("refund", "2026-10-21", [{ category_id: "food", amount: -5000 }, { account_id: "chk", amount: 5000 }]);
  add("merged", "2026-03-01", [{ category_id: "old-food", amount: 4000 }, { account_id: "card", amount: -4000, card_state: "posted" }]);
  add("older", "2025-10-20", [{ category_id: "food", amount: 7000 }, { account_id: "chk", amount: -7000 }]);
  add("draft", "2026-10-20", [{ category_id: "food", amount: 1000 }, { account_id: "chk", amount: -1000 }], { status: "draft", verified_at: undefined });
  state.categoryMaps = [{ from: "old-food", to: "food", effective_from: "2026-01-01" }];
  seed.state = { ...seed.state, ...state }; seed.rev = 1; seed.saved_at = "2026-10-22T03:00:00Z";
  seed.settings = { notice_seen_at: seed.saved_at, whatsnew_seen: CHANGES[0].id, welcome_off: true, cat_card_seen: seed.saved_at, start_rule_seen: seed.saved_at,
    intro_off: { log: true, money: true, income: true }, tile_hint_done: true };
  await page.evaluate(async (seed) => {
    const text = JSON.stringify(seed); localStorage.setItem("financialTracker.ledger", text);
    await new Promise((resolve) => { const r = indexedDB.open("financialTracker", 3); r.onsuccess = () => { const t = r.result.transaction("kv", "readwrite"); t.objectStore("kv").put(text, "ledger"); t.oncomplete = () => { r.result.close(); resolve(); }; }; });
  }, seed);
  await page.reload(); await page.locator("#menuBtn").click(); await page.locator('#menu [data-tab="money"]').click();
  await page.locator('[data-action="spending-category"][data-id="food"]').click();
  assert.equal(await page.locator("#sheet .bigamt").innerText(), "₱150.00");
  assert.equal(await page.locator('#sheet [data-action="open-tx"]').count(), 2);
  assert.equal(await page.locator('#sheet [data-id="split"] .amt').innerText(), "₱200.00");
  await page.locator('#sheet [data-id="split"]').click();
  assert.equal(await page.locator("#sheet .bigamt").innerText(), "₱300.00");
  await page.locator('[data-action="spending-back"]').click();
  assert.equal(await page.locator("#sheet .bigamt").innerText(), "₱150.00"); await close();
  console.log("ok: a category opens matching transactions and split portions, with details and Back");
  await page.locator('[data-action="open-period"]').click(); await page.locator('[data-action="period-kind"][data-kind="year"]').click(); await page.locator('[data-action="period-year"][data-id="2026"]').click();
  await page.locator('[data-action="spending-category"][data-id="food"]').click();
  assert.equal(await page.locator("#sheet .bigamt").innerText(), "₱190.00");
  assert.equal(await page.locator('#sheet [data-action="open-tx"]').count(), 3);
  assert.equal(await page.locator('#sheet [data-id="older"]').count(), 0); assert.equal(await page.locator('#sheet [data-id="draft"]').count(), 0);
  if (process.env.SPENDING_SHOT) await page.screenshot({ path: process.env.SPENDING_SHOT });
  await close();
  console.log("ok: whole-year details include merged categories and exclude other years and drafts");
  await page.locator('[data-action="chart-view"][data-view="account"]').click();
  await page.locator('[data-action="spending-account"][data-id="chk"]').click();
  assert.equal(await page.locator("#sheet .bigamt").innerText(), "₱250.00");
  assert.equal(await page.locator('#sheet [data-action="open-tx"]').count(), 2); await close();
  await page.locator('[data-action="chart-mode"][data-mode="list"]').click();
  await page.locator('[data-action="spending-account"][data-id="card"]').click();
  assert.equal(await page.locator("#sheet .bigamt").innerText(), "₱40.00");
  assert.equal(await page.locator('#sheet [data-action="open-tx"]').count(), 1);
  console.log("ok: account bars and their list open the entries for that account and period");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
