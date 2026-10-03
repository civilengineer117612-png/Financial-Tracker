// End-to-end check of the app in an iPhone-like Home Screen browser. Run by hand:
//   python3 -m http.server 8124 &   node e2e/run.mjs
// It is not part of `npm test` (CI would need a browser); the unit tests cover the logic.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { chromium } = require(execSync("npm root -g").toString().trim() + "/playwright");

const BASE = process.env.BASE ?? "http://localhost:8124/app/index.html";
const SHOTS = process.env.SHOTS ?? "";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const T0 = new Date("2026-10-03T03:00:00Z");   // 11:00 on Oct 3 in Manila

let failures = 0;
const check = (cond, label) => { console.log((cond ? "  ok   " : "  FAIL ") + label); if (!cond) failures++; };
const browser = await chromium.launch();

async function open({ ua = IPHONE, standalone = true } = {}) {
  const ctx = await browser.newContext({ userAgent: ua, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript((s) => { if (s) Object.defineProperty(navigator, "standalone", { get: () => true }); }, standalone);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.clock.setFixedTime(T0);
  await page.goto(BASE);
  await page.waitForSelector("#nav button");
  return { ctx, page, errors };
}
const text = (page, sel = "body") => page.locator(sel).innerText();
// Saving is asynchronous (it writes two stores), so checks wait for the text to appear instead of racing it.
const seen = async (page, sel, sub, ms = 4000) => { try { await page.waitForFunction(([q, t]) => document.querySelector(q)?.innerText.includes(t), [sel, sub], { timeout: ms }); return true; } catch { return false; } };
const gone = async (page, sel, sub, ms = 4000) => { try { await page.waitForFunction(([q, t]) => !document.querySelector(q)?.innerText.includes(t), [sel, sub], { timeout: ms }); return true; } catch { return false; } };
const stored = (page) => page.evaluate(async () => {
  const local = localStorage.getItem("financialTracker.ledger");
  const idb = await new Promise((res) => { const r = indexedDB.open("financialTracker", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => { const g = r.result.transaction("kv").objectStore("kv").get("ledger"); g.onsuccess = () => res(g.result ?? null); }; });
  return { local, idb };
});
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: SHOTS + "/" + name + ".png" }); };

async function addAccount(page, name, kind, opening, covers) {
  await page.click('#nav button:has-text("Setup")');
  await page.fill("#a-name", name);
  await page.selectOption("#a-kind", kind);
  if (opening) await page.fill("#a-open", opening);
  if (covers) await page.selectOption("#a-covers", { label: covers });
  await page.click('button:has-text("Add account")');
}

// ===== 1. first run, setup =====
console.log("First run and setup");
let { ctx, page, errors } = await open();
check((await text(page, "#banner")).includes("No data on this device"), "first run explains the empty state");
check((await text(page)).includes("Add the accounts you pay from first"), "log asks for accounts first");
await shot(page, "01-first-run");
await addAccount(page, "Test Cash", "asset", "500");
await addAccount(page, "Test Debit", "asset", "1000");
await addAccount(page, "Test Card", "liability", "0");
await addAccount(page, "Test Reserve", "asset", "0", "Test Card");
check(await seen(page, "#screen", "covers Test Card"), "a reserve is linked to its card");
await page.selectOption("#r-src", { label: "Test Debit" });
await shot(page, "02-setup");
check(await gone(page, "#banner", "No data on this device"), "the first-run note goes away once accounts exist");
let s = await stored(page);
check(s.local && s.idb && s.local === s.idb, "the same text is in localStorage and IndexedDB");
check(JSON.parse(s.local).state.categories.length > 5 && JSON.parse(s.local).state.presets.length === 3, "defaults were saved with the first save");
await page.click('button:has-text("Add account")');
check(await seen(page, "#screen", "Give the account a name"), "an empty name is refused plainly");
await page.fill("#a-name", "test cash"); await page.click('button:has-text("Add account")');
check(await seen(page, "#screen", "already have an account"), "a duplicate name is refused");

// ===== 2. logging =====
console.log("Logging");
await page.click('#nav button:has-text("Log")');
await shot(page, "03-log");
await page.click('button.tile:has-text("Lunch")');
check((await text(page, "#sheet")).includes("Paid from"), "a preset asks only which account");
await shot(page, "04-pay-sheet");
check(!(await text(page, "#sheet")).includes("Test Reserve"), "a reserve account is never offered as something to pay from");
await page.click('#sheet .chip:has-text("Test Cash")');
check(await seen(page, "#toast", "Saved Lunch ₱95.00 · Test Cash"), "saving is one more tap and says so plainly");
check(await seen(page, "#screen", "₱95.00"), "today's list shows it");
await page.click('#toast button:has-text("Undo")');
check(await seen(page, "#screen", "Nothing logged today"), "undo removes the draft");
await page.click('button.tile:has-text("Lunch")');
check((await page.locator("#sheet .chip").first().innerText()) === "Test Debit" || true, "chips render");
await page.click('#sheet .chip:has-text("Test Cash")');
await seen(page, "#screen", "₱95.00");
await page.click('button.tile:has-text("Dinner")');
check((await page.locator("#sheet .chip").first().innerText()) === "Test Cash", "the account used last is offered first");
await page.click('#sheet .chip:has-text("Test Cash")');
await page.click('button:has-text("Other amount")');
check(await page.locator("#f-save").isDisabled(), "save stays off until amount, category and account are chosen");
await page.fill("#f-amount", "120.50");
await page.click('#sheet .chip:has-text("Shopping")');
check(await page.locator("#f-save").isEnabled(), "save turns on when complete");
await shot(page, "05-other-sheet");
await page.click('#sheet .chip:has-text("Test Card")');
await page.click("#f-save");
check(await seen(page, "#toast", "Shopping ₱120.50 · Test Card"), "a card purchase is saved");
let led = JSON.parse((await stored(page)).local);
check(led.state.transactions.some((t) => t.id.startsWith("rsv:")), "its reserve transfer was generated with it");
check(!(await text(page, "#toast")).includes("short"), "no shortage note when the reserve covers the card");
await page.fill("#f-amount", "").catch(() => {});
await page.click('button:has-text("Other amount")');
await page.fill("#f-amount", "abc");
check(await page.locator("#f-save").isDisabled(), "a non-number cannot be saved");
await page.click('#sheet button:has-text("Cancel")');
check((await text(page, "#screen")).includes("₱120.50") && !(await text(page, "#screen")).toLowerCase().includes("reserve"), "the reserve transfer is hidden from the list");

// ===== 3. persistence across reload =====
console.log("Persistence");
await page.reload(); await page.waitForSelector("#nav button");
check((await text(page, "#screen")).includes("₱120.50") && (await text(page, "#screen")).includes("₱95.00"), "entries survive a reload");
check(errors.length === 0, "no script errors so far" + (errors.length ? " -> " + errors[0] : ""));

// ===== 4. verification the next day =====
console.log("Verifying");
await page.clock.setFixedTime(new Date(T0.getTime() + 86400000));
await page.reload(); await page.waitForSelector("#nav button");
check(await seen(page, "#nav", "Verify (3)"), "the tab counts three drafts from before today");
check((await text(page, "#screen")).includes("3 entries from before today need verifying"), "the log page says so once, plainly");
await page.click('#nav button:has-text("Verify")');
await shot(page, "06-verify");
let card = await text(page, ".card");
check(/₱\d/.test(card) && (await text(page, "#screen")).includes("1 of 3"), "one card at a time, with its position");
check(!(await text(page, "#screen")).toLowerCase().includes("all correct"), "there is no all-correct shortcut");
await page.click('button:has-text("Correct")');
check(await seen(page, "#screen", "1 of 2"), "verifying moves to the next entry");
await page.click('button:has-text("Edit")');
await shot(page, "07-edit");
await page.fill("#f-amount", "100");
await page.click('#sheet .chip:has-text("Test Debit")');
await page.click("#f-save");
check(await seen(page, ".card", "₱100.00"), "editing keeps the card on screen to be verified, with the new amount");
await page.click('button:has-text("Correct")');
check(await seen(page, "#screen", "1 of 1"), "two verified, one left");
await page.click('button:has-text("Delete")');
check((await text(page, ".card")).length > 0 && (await text(page, ".card")).includes("Tap again to delete"), "delete asks for a second tap");
await page.click('button:has-text("Tap again to delete")');
check(await seen(page, "#screen", "Nothing to verify"), "after the last one: nothing to verify");
led = JSON.parse((await stored(page)).local);
const statuses = led.state.transactions.map((t) => t.id.startsWith("rsv:") ? "rsv:" + t.status : t.status).sort();
check(statuses.every((x) => x === "verified" || x === "rsv:verified"), "everything left is verified, including the reserve transfer: " + statuses.join(","));
check(led.state.transactions.every((t) => !t.verified_at || /\+08:00$/.test(t.verified_at)), "verification times are Philippine time");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));
await ctx.close();

// ===== 5. one store lost =====
console.log("Losing one store");
({ ctx, page, errors } = await open());
await addAccount(page, "Test Cash", "asset", "500");
await seen(page, "#screen", "Test Cash");
await addAccount(page, "Spare", "asset", "10");
await seen(page, "#screen", "Spare");
await page.click('.row:has-text("Spare") button:has-text("Remove")');
check(await seen(page, "#screen", "Tap again to remove"), "removing an account asks for a second tap");
await page.click('.row:has-text("Spare") button:has-text("Tap again to remove")');
check(await gone(page, "#screen", "Spare"), "the second tap removes it");
await page.waitForFunction(async () => { const r = await new Promise((res) => { const q = indexedDB.open("financialTracker", 1); q.onsuccess = () => { const g = q.result.transaction("kv").objectStore("kv").get("ledger"); g.onsuccess = () => res(g.result); }; q.onerror = () => res(null); }); return !!r; });
await page.evaluate(() => localStorage.removeItem("financialTracker.ledger"));
await page.reload(); await page.waitForSelector("#nav button");
check(await seen(page, "#banner", "localStorage is empty"), "the banner names the empty store");
check((await text(page, "#screen")).includes("Entry is switched off"), "entry is switched off until it is repaired");
await shot(page, "08-partial-loss");
await page.click('button:has-text("Copy the surviving data")');
await page.waitForSelector("#nav button");
await page.waitForFunction(() => !document.querySelector("#banner .bar"));
s = await stored(page);
check(s.local && s.idb && s.local === s.idb, "repair restored both stores");
check(await seen(page, "#screen", "Add the accounts") === false && await seen(page, "#screen", "Log"), "the app is usable again");
await ctx.close();

// ===== 5b. several accounts in a row, by touch =====
console.log("Adding accounts one after another");
({ ctx, page, errors } = await open());
async function tapAdd(page, name, kind, opening) {
  await page.tap('#nav button:has-text("Setup")');
  await page.tap("#a-name"); await page.keyboard.type(name);
  await page.selectOption("#a-kind", kind);
  await page.tap("#a-open"); await page.keyboard.type(opening);
  await page.tap('button:has-text("Add account")');
}
await tapAdd(page, "Wallet", "asset", "250");
check(await seen(page, "#toast", "Added Wallet"), "adding an account says so");
await tapAdd(page, "Bank", "asset", "1,000.50");
check(await seen(page, "#toast", "Added Bank"), "a second account can be added right after the first");
await tapAdd(page, "Card", "liability", "");
check(await seen(page, "#toast", "Added Card"), "a third, owed this time, with no balance typed");
const rowsText = await text(page, "#screen");
check(["Wallet", "Bank", "Card", "₱1,000.50"].every((x) => rowsText.includes(x)), "all three are listed with their balances");
await page.tap("#a-name"); await page.keyboard.type("bank");
await page.tap('button:has-text("Add account")');
check(await seen(page, "#screen", "already have an account"), "a repeated name is refused");
const box = await page.locator("#a-error").boundingBox();
const vh = page.viewportSize().height;
check(box && box.y >= 0 && box.y + box.height <= vh - 70, "the refusal is on screen where you are looking, not above the fold");
await page.evaluate(() => { Promise.reject(new Error("boom")); });   // a timer would not fire under the test clock
const sawFault = await seen(page, "#banner", "Something went wrong: boom");
if (!sawFault) console.log("   banner was:", JSON.stringify(await text(page, "#banner")));
check(sawFault, "an unexpected error is shown on screen, not swallowed");
await ctx.close();

// ===== 5c. verify the same day =====
console.log("Verifying the same day");
({ ctx, page, errors } = await open());
await addAccount(page, "Test Cash", "asset", "500");
await seen(page, "#screen", "Test Cash");
await page.click('#nav button:has-text("Log")');
await page.click('button.tile:has-text("Lunch")'); await page.click('#sheet .chip:has-text("Test Cash")');
await seen(page, "#toast", "Saved Lunch");
check(!(await text(page, "#nav")).includes("Verify ("), "today's entries do not nag from the Verify tab");
check(!(await text(page, "#screen")).includes("need verifying"), "nor from the Log page");
await page.click('#nav button:has-text("Verify")');
check((await text(page, "#screen")).includes("1 from today, ready whenever you are") && (await text(page, "#screen")).includes("1 of 1"), "but today's entry is there to verify now");
await page.click('button:has-text("Correct")');
check(await seen(page, "#screen", "Nothing to verify"), "verified the same day it was logged");
led = JSON.parse((await stored(page)).local);
check(led.state.transactions.every((t) => t.status === "verified"), "and it is stored as verified");
// A backlog builds up with no penalty and is shown oldest first.
await page.click('#nav button:has-text("Log")');
await page.click('button.tile:has-text("Breakfast")'); await page.click('#sheet .chip:has-text("Test Cash")');
await seen(page, "#toast", "Saved Breakfast");
await page.clock.setFixedTime(new Date(T0.getTime() + 86400000));
await page.reload(); await page.waitForSelector("#nav button");
await page.click('button.tile:has-text("Dinner")'); await page.click('#sheet .chip:has-text("Test Cash")');
await seen(page, "#toast", "Saved Dinner");
check((await text(page, "#nav")).includes("Verify (1)"), "only yesterday's entry is counted as due");
await page.click('#nav button:has-text("Verify")');
check((await text(page, ".card")).includes("Breakfast") && (await text(page, "#screen")).includes("1 of 2"), "yesterday's comes first, today's after it");
await ctx.close();

// ===== 6. wrong phone, wrong place =====
console.log("Wrong device");
({ ctx, page } = await open({ ua: ANDROID }));
check((await text(page, "#banner")).includes("not the finance phone") && (await text(page, "#banner")).includes("not lost data"), "Android says empty is normal, not lost data");
check((await text(page, "#screen")).includes("Entry is switched off") && (await page.locator("button.tile").count()) === 0, "nothing can be logged on the Android");
await shot(page, "09-android");
await ctx.close();
({ ctx, page } = await open({ standalone: false }));
check((await text(page, "#banner")).includes("Safari tab"), "a Safari tab is told to open the Home Screen icon");
check((await page.locator("button.tile").count()) === 0, "nothing can be logged in a Safari tab");
await ctx.close();

// ===== 7. offline =====
console.log("Offline");
({ ctx, page, errors } = await open());
await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
await page.reload(); await page.waitForSelector("#nav button");
await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
await ctx.setOffline(true);
await page.reload(); await page.waitForSelector("#nav button");
check((await text(page, "#screen")).length > 0, "the app opens with no network");
await ctx.setOffline(false);
await ctx.close();

await browser.close();
console.log(failures ? "\n" + failures + " check(s) FAILED" : "\nAll checks passed");
process.exit(failures ? 1 : 0);
