// Serve the repo on port 8124, then node e2e/pdf-scan.mjs. All documents are invented.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emptyLedger, CHANGES } from "../src/model/index.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? execSync("npm root -g").toString().trim() + "/playwright");
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const base = process.env.BASE ?? "http://127.0.0.1:8124/app/index.html";
const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1" });
const errors = [], external = [];
ctx.on("request", (request) => { if (!request.url().startsWith(new URL(base).origin) && /^https?:/.test(request.url())) external.push({ url: request.url(), method: request.method(), data: request.postData() }); });
await ctx.route("**/*", (route) => new URL(route.request().url()).origin !== new URL(base).origin && /^https?:/.test(route.request().url()) ? route.abort() : route.continue());
await ctx.addInitScript(() => { Object.defineProperty(navigator, "standalone", { get: () => true }); sessionStorage.setItem("logOpen", "1"); });
const page = await ctx.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const fixture = (name) => fileURLToPath(new URL("./fixtures/" + name, import.meta.url));
const visible = (selector) => page.locator(selector).first().waitFor({ state: "visible", timeout: 180000 });
const scan = async (name) => {
  await page.locator('[data-action="open-scan-pick"]').first().click();
  await page.locator('input[data-scan="quick"]:not([capture])').setInputFiles(fixture(name));
};
const unlock = async (password) => { await visible("#pdf-pw"); await page.locator("#pdf-pw").fill(password); await page.locator('[data-action="pdf-open"]').click(); };
const checkPayslip = async () => {
  await page.locator("#p-net").waitFor({ state: "attached", timeout: 30000 });
  assert.equal(await page.locator("#p-net").inputValue(), "7400.00");
  assert.equal(await page.locator("#p-gross").inputValue(), "8000.00");
  assert.equal(await page.locator('[data-field="e_basic"]').inputValue(), "8000.00");
  assert.equal(await page.locator('[data-field="d_sss"]').inputValue(), "400.00");
  assert.equal(await page.locator('[data-field="d_tax"]').inputValue(), "200.00");
  assert.equal(await page.locator('[data-field="period_from"]').inputValue(), "2026-10-01");
  assert.equal(await page.locator('[data-field="period_to"]').inputValue(), "2026-10-15");
  assert.equal(await page.locator('[data-field="pay_date"]').inputValue(), "2026-10-20");
  assert.equal(await page.locator("#sheet img.shot").count(), 1);
};
try {
  await page.clock.setFixedTime(new Date("2026-10-22T03:00:00Z"));
  await page.goto(base); await visible("#nav button");
  const seed = emptyLedger(); seed.rev = 1; seed.saved_at = "2026-10-22T03:00:00Z";
  seed.settings = { notice_seen_at: seed.saved_at, whatsnew_seen: CHANGES[0].id, welcome_off: true,
    start_rule_seen: seed.saved_at, cat_card_seen: seed.saved_at, intro_off: { scan: true, income: true, money: true, log: true } };
  await page.evaluate(async (seed) => {
    const text = JSON.stringify(seed); localStorage.setItem("financialTracker.ledger", text);
    await new Promise((resolve, reject) => { const r = indexedDB.open("financialTracker", 3); r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(text, "ledger"); tx.oncomplete = () => { r.result.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; });
  }, seed);
  await page.reload(); await visible("#nav button");
  await scan("sample-payslip-open.pdf"); await checkPayslip();
  if (process.env.PDF_SCAN_SHOT) await page.screenshot({ path: process.env.PDF_SCAN_SHOT });
  await page.locator('#sheet [data-action="close-sheet"]').last().click();
  console.log("ok: an open two-page PDF is read into the payslip form, including its dates and amounts");
  await scan("sample-payslip-locked.pdf"); await unlock("wrong");
  await page.getByText("That password did not open it. Try again.").waitFor();
  await unlock("test1234"); await checkPayslip();
  const preview = await page.locator("#sheet img.shot").evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
  assert.ok(preview.height > preview.width * 2, "both pages are in the retained preview");
  assert.ok(!(await page.content()).includes("test1234"));
  assert.ok(!await page.evaluate(() => JSON.stringify({ ...localStorage }).includes("test1234")));
  await page.locator('#sheet [data-action="close-sheet"]').last().click();
  console.log("ok: AES-256 password retry opens the same form; the password is absent from the DOM and localStorage");
  for (const selector of ['[data-action="pdf-cancel"]', '#scrim', '#sheet [data-action="close-sheet"]']) {
    await scan("sample-payslip-locked.pdf"); await visible("#pdf-pw");
    await page.locator(selector).last().click();
    await page.locator("#sheet .sheet").waitFor({ state: "detached" });
    await page.waitForTimeout(200);
    assert.equal(await page.locator("#sheet .sheet").count(), 0);
  }
  console.log("ok: Cancel, the backdrop, and the sheet close button cancel password entry without reopening it");
  await page.locator('[data-action="open-menu"]').click();
  await page.locator('#menu [data-tab="money"]').click();
  await page.locator("#top .titleswitch").click();
  await page.locator('[data-action="open-payslip-choice"]').click();
  await page.locator('input[data-scan="payslip"]:not([capture])').setInputFiles(fixture("sample-payslip-locked.pdf"));
  await unlock("test1234"); await checkPayslip();
  await page.locator('#sheet [data-action="close-sheet"]').last().click();
  console.log("ok: Add income also accepts an encrypted PDF payslip");
  await page.locator('#nav [data-tab="log"]').click();
  // Exercise image-only PDF rendering and the real local OCR reader.
  await scan("sample-receipt-image-locked.pdf"); await unlock("test1234");
  await visible('#sheet [data-field="amount"]');
  assert.equal(await page.locator('#sheet [data-field="amount"]').inputValue(), "250.00", await page.locator("#sheet").textContent());
  assert.equal(await page.locator("#sheet img.shot").count(), 1);
  console.log("ok: an encrypted image-only PDF is rendered and read by the on-device OCR reader");
  assert.deepEqual(errors, []);
  assert.ok(external.every((request) => request.method === "GET" && request.data === null && !/test1234|SAMPLE|8000|7400/.test(request.url)), "only the app's existing public logo lookups may reach another origin; no file, text or password is uploaded");
} finally { await browser.close(); }
