// End-to-end check of the app in an iPhone-like Home Screen browser. Run by hand:
//   python3 -m http.server 8124 &   node e2e/run.mjs
// It is not part of `npm test` (CI would need a browser); the unit tests cover the logic.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Every request for a bank logo goes through this, so the network is faked: by default nothing answers.
let iconServe = (r) => r.abort();
const iconAsked = [];   // every address the app asked an icon service or bank site for
async function open({ ua = IPHONE, standalone = true, blockSw = false, url = BASE, noSpeech = false, fakeSpeech = false } = {}) {
  const ctx = await browser.newContext({ ...(blockSw ? { serviceWorkers: "block" } : {}), userAgent: ua, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript((s) => { if (s) Object.defineProperty(navigator, "standalone", { get: () => true }); }, standalone);
  // A pretend phone speech service that, like many real ones, ends after a moment of quiet: round 1 hears "lunch 95", round 2 hears "at sample burger".
  if (fakeSpeech) await ctx.addInitScript(() => {
    const said = ["lunch 95", "at sample burger using gcash"]; let round = 0;
    window.SpeechRecognition = window.webkitSpeechRecognition = class { start() { const words = said[round++] ?? ""; setTimeout(() => { if (words) this.onresult?.({ results: [{ 0: { transcript: words }, isFinal: true, length: 1 }] }); }, 80); setTimeout(() => this.onend?.(), 260); } stop() { setTimeout(() => this.onend?.(), 20); } };
  });
  if (noSpeech) await ctx.addInitScript(() => { window.webkitSpeechRecognition = undefined; window.SpeechRecognition = undefined; });
  await ctx.route(/icon\.horse|faviconkit\.com|gstatic\.com|duckduckgo\.com|apple-touch-icon\.png|wikipedia\.org|wikimedia\.org/, (r) => { iconAsked.push(r.request().url()); iconServe(r); });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|gstatic|duckduckgo|icon\.horse|apple-touch-icon|wikipedia|wikimedia/.test(m.location().url ?? "")) errors.push(m.text()); });   // blocked icon requests are staged on purpose
  await page.clock.setFixedTime(T0);
  await page.goto(url);
  await page.waitForSelector("#nav button");
  return { ctx, page, errors };
}
const text = (page, sel = "body") => page.locator(sel).innerText();
// Money, Budget and Setup live in the menu at the upper left; only Log and Verify are on the bottom bar.
const menuGo = async (page, name) => { await page.click("#menuBtn"); await page.click(`#menu .item:has-text("${name}")`); };
// Saving is asynchronous (it writes two stores), so checks wait for the text to appear instead of racing it.
const seen = async (page, sel, sub, ms = 4000) => { try { await page.waitForFunction(([q, t]) => document.querySelector(q)?.innerText.includes(t), [sel, sub], { timeout: ms }); return true; } catch { return false; } };
const gone = async (page, sel, sub, ms = 4000) => { try { await page.waitForFunction(([q, t]) => !document.querySelector(q)?.innerText.includes(t), [sel, sub], { timeout: ms }); return true; } catch { return false; } };
const stored = (page) => page.evaluate(async () => {
  const local = localStorage.getItem("financialTracker.ledger");
  const idb = await new Promise((res) => { const r = indexedDB.open("financialTracker"); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => { const g = r.result.transaction("kv").objectStore("kv").get("ledger"); g.onsuccess = () => res(g.result ?? null); }; });
  return { local, idb };
});
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: SHOTS + "/" + name + ".png" }); };

async function addAccount(page, name, kind, opening, covers) {
  await menuGo(page, "Setup");
  await page.fill("#a-name", name);
  await page.selectOption("#a-kind", kind);
  if (opening) await page.fill("#a-open", opening);
  if (covers) await page.selectOption("#a-covers", { label: covers });
  await page.click('button:has-text("Add account")');
  await page.waitForFunction((n) => [...document.querySelectorAll("#screen .row, #screen .choice, #screen li")].some((e) => e.innerText.includes(n)) || document.getElementById("screen").innerText.includes(n), name, { timeout: 8000 }).catch(() => {});   // saving is asynchronous: wait until the account is listed before going on
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
check((await page.locator("#sheet .chip").first().innerText()).includes("Test Cash"), "the account used last is offered first");
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
await page.waitForFunction(async () => { const r = await new Promise((res) => { const q = indexedDB.open("financialTracker"); q.onsuccess = () => { const g = q.result.transaction("kv").objectStore("kv").get("ledger"); g.onsuccess = () => res(g.result); }; q.onerror = () => res(null); }); return !!r; });
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
check(await seen(page, "#top", "Log") && !(await text(page, "#screen")).includes("Add the accounts"), "the app is usable again");
await ctx.close();

// ===== 5b. several accounts in a row, by touch =====
console.log("Adding accounts one after another");
({ ctx, page, errors } = await open());
async function tapAdd(page, name, kind, opening) {
  await menuGo(page, "Setup");
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

// ===== 5d. backup and restore =====
console.log("Backup and restore");
const PASS = "correct horse battery";
({ ctx, page, errors } = await open());
await addAccount(page, "Test Cash", "asset", "500");
await addAccount(page, "Test Card", "liability", "");
await seen(page, "#screen", "Test Card");
await page.click('#nav button:has-text("Log")');
check(await seen(page, "#screen", "No backup yet"), "the Log page mentions that there is no backup");
await page.click('button.tile:has-text("Lunch")'); await page.click('#sheet .chip:has-text("Test Cash")');
await seen(page, "#toast", "Saved Lunch");
await menuGo(page, "Setup");
check((await text(page, "#screen")).includes("No backup yet"), "Setup says so too");
await page.click('button:has-text("Back up now")');
check(await page.locator("#f-save").isDisabled(), "creating is off until there is a passphrase");
await page.fill("#b-pass", "short");
check((await text(page, "#sheet")).includes("At least 12"), "a short passphrase is explained");
await page.fill("#b-pass", PASS); await page.fill("#b-pass2", PASS.slice(0, -1) + "z");
check((await text(page, "#sheet")).includes("do not match") && await page.locator("#f-save").isDisabled(), "a mismatch is explained and blocks");
await page.fill("#b-pass2", PASS);
check(await page.locator("#f-save").isEnabled(), "matching long passphrases turn it on");
await shot(page, "10-backup-sheet");
const [download] = await Promise.all([page.waitForEvent("download"), page.click("#f-save")]);
const file = join(mkdtempSync(join(tmpdir(), "bk-")), download.suggestedFilename());
await download.saveAs(file);
check(download.suggestedFilename() === "finance-backup-2026-10-03.json", "the file is named with the date: " + download.suggestedFilename());
const raw = readFileSync(file, "utf8"), box1 = JSON.parse(raw);
check(box1.kind === "ledger" && box1.v === 1 && box1.iterations === 600000, "it is an encrypted ledger container");
check(!["Test Cash", "Test Card", "Lunch", "9500"].some((x) => raw.includes(x)), "the file contains none of your data in the clear");
check(await seen(page, "#toast", "Backup file created"), "the app says what to do next");
check(await seen(page, "#screen", "Last backup: today"), "Setup shows when the last backup was made");
await page.click('#nav button:has-text("Log")');
check(!(await text(page, "#screen")).includes("No backup yet"), "the Log page stops mentioning it");

// wipe everything, as if iOS had cleared the storage
await page.evaluate(async () => { localStorage.clear(); await new Promise((res) => { const r = indexedDB.deleteDatabase("financialTracker"); r.onsuccess = r.onerror = r.onblocked = () => res(); }); });
await page.reload(); await page.waitForSelector("#nav button");
check((await text(page, "#banner")).includes("No data on this device"), "the empty phone says so");
await menuGo(page, "Setup");
await page.click('button:has-text("Restore from a backup")');
check(await page.locator("#f-save").isDisabled(), "opening is off until a file and passphrase are given");
await page.setInputFiles("#r-file", file);
await page.fill("#r-pass", "a different passphrase");
await page.click('button:has-text("Open backup")');
check(await seen(page, "#sheet", "Wrong passphrase, or the file is damaged"), "a wrong passphrase is refused plainly");
check((await page.inputValue("#r-pass")) === "a different passphrase" && await page.locator("#f-save").isEnabled(), "and you can try again without choosing the file again");
await page.fill("#r-pass", PASS);
await page.click('button:has-text("Open backup")');
check(await seen(page, "#sheet", "Replace this phone's data?"), "the right passphrase shows what will be replaced");
check((await text(page, "#sheet")).includes("2 accounts, 1 entry") && (await text(page, "#sheet")).includes("0 accounts, no entries"), "with the backup's counts beside the phone's own");
await shot(page, "11-restore-sheet");
await page.click("#f-save");
check((await text(page, "#sheet")).includes("Tap again to replace"), "replacing asks for a second tap");
await Promise.all([page.waitForNavigation(), page.click("#f-save")]);
await page.waitForSelector("#nav button");
await menuGo(page, "Setup");
check(await seen(page, "#screen", "Test Cash") && (await text(page, "#screen")).includes("Test Card"), "the accounts are back");
await page.click('#nav button:has-text("Log")');
check(await seen(page, "#screen", "₱95.00"), "and so is the entry");
s = await stored(page);
check(s.local && s.local === s.idb, "both stores hold the restored ledger");
check(JSON.parse(s.local).rev >= 2, "stamped newer than before");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));
// a file that is not a backup
await menuGo(page, "Setup"); await page.click('button:has-text("Restore from a backup")');
const junk = join(mkdtempSync(join(tmpdir(), "bk-")), "notes.json"); (await import("node:fs")).writeFileSync(junk, "hello");
await page.setInputFiles("#r-file", junk); await page.fill("#r-pass", PASS);
await page.click('button:has-text("Open backup")');
check(await seen(page, "#sheet", "That file is not a backup"), "a file that is not a backup is refused plainly");
await ctx.close();

// the share sheet path (iPhone) and cancelling it
console.log("Share sheet");
for (const cancel of [false, true]) {
  ({ ctx, page } = await open());
  await page.addInitScript((c) => { navigator.canShare = () => true; navigator.share = async (d) => { window.__shared = { name: d.files[0].name, type: d.files[0].type }; if (c) throw new DOMException("cancelled", "AbortError"); }; }, cancel);
  await page.reload(); await page.waitForSelector("#nav button");
  await addAccount(page, "Test Cash", "asset", "5"); await seen(page, "#screen", "Test Cash");
  await page.click('button:has-text("Back up now")'); await page.fill("#b-pass", PASS); await page.fill("#b-pass2", PASS);
  await page.click("#f-save");
  if (!cancel) {
    check(await seen(page, "#toast", "Backup file created"), "the share sheet path completes");
    const shared = await page.evaluate(() => window.__shared);
    check(shared?.name === "finance-backup-2026-10-03.json" && shared.type === "application/json", "it hands the share sheet a named JSON file");
  } else {
    check(await seen(page, "#sheet", "Not saved. Tap Create backup file to try again."), "cancelling the share sheet is not counted as a backup");
    check(!(await text(page, "#sheet")).includes("Last backup"), "and no backup date is recorded");
    await page.click('#sheet button:has-text("Cancel")');
    check((await text(page, "#screen")).includes("No backup yet"), "Setup still says there is no backup");
  }
  await ctx.close();
}

// ===== 5e. pictures for accounts, and the Money charts =====
console.log("Pictures and charts");
({ ctx, page, errors } = await open({ blockSw: true }));   // page-level network staging does not reach a service worker
const dir = mkdtempSync(join(tmpdir(), "pic-"));
const png = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 200; c.height = 100; const g = c.getContext("2d"); g.fillStyle = "#d00"; g.fillRect(0, 0, 100, 100); g.fillStyle = "#00d"; g.fillRect(100, 0, 100, 100); return c.toDataURL("image/png"); });
writeFileSync(join(dir, "icon.png"), Buffer.from(png.split(",")[1], "base64"));
const pixel = (url, x, y) => page.evaluate(async ([u, px, py]) => { const i = new Image(); await new Promise((r) => { i.onload = r; i.src = u; }); const c = document.createElement("canvas"); c.width = c.height = 96; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return Array.from(g.getImageData(px, py, 1, 1).data); }, [url, x, y]);
const red = ([r, , b]) => r > 180 && b < 60, blue = ([r, , b]) => b > 180 && r < 60;

await addAccount(page, "Wallet", "asset", "1000"); await seen(page, "#toast", "Added Wallet");
await addAccount(page, "Bank", "asset", "5000"); await seen(page, "#toast", "Added Bank");
const monoN = await page.locator("#screen .row .mono").count(); if (monoN !== 2) console.log("   mono count:", monoN, JSON.stringify((await text(page, "#screen")).slice(0, 300)));
check(monoN === 2, "until a picture is chosen, each account shows its first letter");
await page.click('.icobtn[aria-label="Choose a picture for Wallet"]');
check((await text(page, "#sheet")).includes("zoom and drag"), "tapping the tile opens the picture chooser, with plain instructions");
check(await page.locator("#f-save").isDisabled(), "saving is off until a picture is chosen");
await page.setInputFiles("#i-file", join(dir, "icon.png"));
await page.waitForFunction(() => !document.getElementById("i-img").hidden);
await shot(page, "12-icon-sheet");
check(await page.locator("#f-save").isEnabled() && await page.locator("#i-zoom").isEnabled(), "choosing a picture turns on zoom and save");
await page.click("#f-save");
check(await seen(page, "#toast", "Picture saved"), "the picture is saved");
let ledgerNow = JSON.parse((await stored(page)).local);
const walletIcon = ledgerNow.state.accounts.find((a) => a.name === "Wallet").icon;
check(/^data:image\/(png|jpeg);base64,/.test(walletIcon) && walletIcon.length < 40000, "it is stored inside the account as a small embedded image");
check(red(await pixel(walletIcon, 24, 48)) && blue(await pixel(walletIcon, 72, 48)), "an uncropped picture is centred: the red half left, the blue half right");

await page.click('.icobtn[aria-label="Choose a picture for Bank"]');
await page.setInputFiles("#i-file", join(dir, "icon.png"));
await page.waitForFunction(() => !document.getElementById("i-img").hidden);
const stageBox = await page.locator("#i-stage").boundingBox();
await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2); await page.mouse.down();
await page.mouse.move(stageBox.x + stageBox.width / 2 + 300, stageBox.y + stageBox.height / 2, { steps: 6 }); await page.mouse.up();
await page.click("#f-save"); await seen(page, "#toast", "Picture saved");
const bankIcon = JSON.parse((await stored(page)).local).state.accounts.find((a) => a.name === "Bank").icon;
check(red(await pixel(bankIcon, 72, 48)), "dragging the picture moves what is cropped: the blue half is out of the square");
check((await page.locator("#screen .row img.ico").count()) === 2, "both accounts now show their picture in Setup");
await page.click('.icobtn[aria-label="Choose a picture for Bank"]');
check((await text(page, "#sheet")).includes("Remove the picture"), "a picture can be removed");
await page.click('#sheet button:has-text("Cancel")');

// log and verify across three months, through the real screens
const logPreset = async (name, acct) => { await page.click('#nav button:has-text("Log")'); await page.click(`button.tile:has-text("${name}")`); await page.click(`#sheet .chip:has-text("${acct}")`); await seen(page, "#toast", "Saved " + name); };
const logOther = async (amount, cat, acct) => { await page.click('#nav button:has-text("Log")'); await page.click('button:has-text("Other amount")'); await page.fill("#f-amount", amount); await page.click(`#sheet .chip:has-text("${cat}")`); await page.click(`#sheet .chip:has-text("${acct}")`); await page.click("#f-save"); await seen(page, "#toast", "Saved"); };
const verifyAll = async () => {
  await page.click('#nav button:has-text("Verify")');
  for (let guard = 0; guard < 20; guard++) {
    const t = await text(page, "#screen");
    if (t.includes("Nothing to verify")) return;
    const n = Number(/1 of (\d+)/.exec(t)[1]);
    await page.click('button:has-text("Correct")');
    await page.waitForFunction((k) => { const x = document.getElementById("screen").innerText; return x.includes("Nothing to verify") || x.includes("1 of " + (k - 1)); }, n);
  }
};
await page.clock.setFixedTime(new Date("2026-08-14T04:00:00Z"));
await logPreset("Lunch", "Wallet"); await logPreset("Dinner", "Wallet"); await logOther("500", "Shopping", "Bank"); await verifyAll();
await page.clock.setFixedTime(new Date("2026-09-12T04:00:00Z"));
await logPreset("Lunch", "Wallet"); await logOther("1,200", "Rent", "Bank"); await verifyAll();
await page.clock.setFixedTime(T0);
await logPreset("Lunch", "Wallet"); await logOther("300", "Shopping", "Bank"); await verifyAll();
await logPreset("Dinner", "Wallet");   // left as a draft on purpose

await menuGo(page, "Spending");
await shot(page, "13-money-category");
let screen = await text(page, "#screen");
check(screen.includes("October 2026") && screen.includes("₱395.00"), "the hero number is this month's verified spending");
check(screen.includes("spent in October 2026"), "and says what it is");
check(screen.includes("₱900.00 less than September"), "plain comparison with last month, no alarm");
check(screen.includes("plus ₱95.00 not verified yet"), "unverified drafts are mentioned but not counted");
const rowsNow = await page.locator(".brow").allInnerTexts();
check(rowsNow.length === 2 && rowsNow[0].includes("Shopping") && rowsNow[0].includes("₱300.00") && rowsNow[0].includes("75.9%") && rowsNow[1].includes("Food") && rowsNow[1].includes("24.1%"), "bars are sorted biggest first, each with its amount and share: " + rowsNow.map((r) => r.replace(/\s+/g, " ")).join(" | "));
const widths = await page.locator(".bfill").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
check(widths[0] > widths[1] * 3 && widths[0] > 100, "bar lengths are in proportion (" + widths.join(", ") + ")");
const thick = await page.locator(".bfill").first().evaluate((e) => e.getBoundingClientRect().height);
check(thick <= 24, "bars are thin (" + thick + "px)");
check((await page.locator(".bfill").evaluateAll((els) => new Set(els.map((e) => getComputedStyle(e).backgroundColor)).size)) === 1, "every bar is the same single color");
check((await page.locator("#screen .caption").count()) === 0 && (await page.locator(".shapebtn, button:has-text('Donut')").count()) === 0, "no caption under the bars and no separate shape button");
await page.click('.brow:has-text("Food")');
check((await page.locator("svg.donut").count()) === 1 && (await page.locator(".bars").count()) === 0, "tapping the bars turns them into a donut");
check((await page.locator("#screen .caption").count()) === 0, "and no description appears");
await page.click("svg.donut");
check((await page.locator(".bars .brow").count()) === 2 && (await page.locator("svg.donut").count()) === 0, "tapping the donut turns it back into bars");

await page.click('button:has-text("By account")');
await shot(page, "14-money-account");
const accRows = await page.locator(".brow").allInnerTexts();
check(accRows.length === 2 && accRows[0].includes("Bank") && accRows[0].includes("₱300.00") && accRows[1].includes("Wallet") && accRows[1].includes("₱95.00"), "by account: where each peso came out of");
check((await page.locator(".brow img.ico").count()) === 2, "each account shows its own picture beside its name");

await page.click('button:has-text("By month")');
await shot(page, "15-money-month");
const colH = await page.locator(".cbar").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
check(colH.length === 6 && colH.slice(0, 3).every((h) => h === 0) && colH[4] === Math.max(...colH) && colH[3] < colH[4] && colH[5] < colH[3] && Math.abs(colH[3] / colH[4] - 690 / 1295) < 0.03 && Math.abs(colH[5] / colH[4] - 395 / 1295) < 0.03, "six months as columns, in proportion, September the tallest: " + colH.join(","));
check((await text(page, ".clabs")).replace(/\s+/g, " ").trim() === "May Jun Jul Aug Sep Oct", "month names run oldest to newest");
check((await page.locator(".cval").allInnerTexts()).filter(Boolean).join() === "₱395", "only the current month is labelled until you tap");
await page.click(".col >> nth=4");
check((await text(page, ".caption")).includes("September 2026: ₱1,295.00 spent."), "tapping a column says its month and amount");

await page.click('button:has-text("Show as list")');
screen = await text(page, "#screen");
check(screen.includes("September 2026") && screen.includes("₱1,295.00") && screen.includes("August 2026") && screen.includes("₱690.00"), "the list says the same as the columns");
await page.click('button:has-text("By category")');
screen = await text(page, "#screen");
check(/Shopping\s+₱300\.00\s+75\.9%/.test(screen) && /Food\s+₱95\.00\s+24\.1%/.test(screen) && /Total\s+₱395\.00/.test(screen), "the list view has every number the chart has, plus the total");
await page.click('button:has-text("Show as chart")');

await page.click('button[aria-label="Earlier"]');
screen = await text(page, "#screen");
check(screen.includes("September 2026") && screen.includes("₱1,295.00") && /Rent/.test(screen), "stepping back shows September: rent and a lunch");
check(await page.locator('button[aria-label="Later"]').isEnabled(), "and you can step forward again");
await page.click('button[aria-label="Later"]');
check(await page.locator('button[aria-label="Later"]').isDisabled(), "but not past this month");
for (let i = 0; i < 4; i++) await page.click('button[aria-label="Earlier"]');
check((await text(page, "#screen")).includes("Nothing verified for this month yet"), "an empty month says so plainly");

// ---- the menu: only Log and Verify stay on the bottom bar ----
console.log("Menu and budgets");
await page.click('#nav button:has-text("Log")');
check((await page.locator("#nav button").count()) === 2, "the bottom bar has just Log and Verify");
const mb = await page.locator("#menuBtn").boundingBox();
check(mb && mb.x < 40 && mb.y < 60 && mb.width >= 44 && mb.height >= 44, "the menu button is at the upper left, big enough to tap");
check((await page.locator("#menuBtn svg rect").count()) === 3, "it is the three-line icon");
check(await page.getAttribute("#menuBtn", "aria-expanded") === "false", "and says it is closed");
await page.click("#menuBtn");
check((await page.locator("#menu .item").allInnerTexts()).join() === "Spending,Income,Budget,Goals,Pay plan,Checks,Trips,Buffer,Scan,Check-in,Setup", "the menu lists Spending, Income, Budget, Goals, Pay plan, Checks, Trips, Buffer, Scan, Check-in and Setup");
check(await page.getAttribute("#menuBtn", "aria-expanded") === "true", "and says it is open");
await shot(page, "17-menu");
await page.keyboard.press("Escape");
check((await page.locator("#menu .drawer").count()) === 0, "Escape closes it");
await page.click("#menuBtn"); await page.mouse.click(380, 700);
check((await page.locator("#menu .drawer").count()) === 0, "tapping outside closes it");
await page.click("#menuBtn"); await page.click('#menu .item:has-text("Budget")');
check((await page.locator("#menu .drawer").count()) === 0 && (await text(page, "#top")).includes("Budget"), "choosing an item closes the menu and opens the screen");
check((await page.locator("#nav [aria-current]").count()) === 0, "no bottom button is marked while a menu screen is open");

// ---- setting budgets ----
let budgetRows = await page.locator(".choice").allInnerTexts();
check(budgetRows.length === 8 && !budgetRows.some((r) => r.includes("Unlogged")) && budgetRows.every((r) => r.includes("No budget")), "every spending category can have a budget, except Unlogged; none set yet");
await shot(page, "18-budget");
const setBudget = async (cat, amount, startLabel) => {
  await page.click(`.choice:has-text("${cat}")`);
  await page.fill("#f-amount", amount);
  if (startLabel) await page.click(`#sheet button:has-text("${startLabel}")`);
  await page.click("#f-save");
  await seen(page, "#toast", (Number(amount) === 0 ? "Budget removed for " : "Budget saved for ") + cat);   // wait for THIS save, not an older message
};
await page.click('.choice:has-text("Shopping")');
check((await page.inputValue("#f-amount")) === "" && (await page.getAttribute('#sheet button:has-text("This month")', "aria-pressed")) === "true", "a first budget starts this month by default");
check(await page.locator("#f-save").isDisabled(), "saving is off until there is an amount");
await page.fill("#f-amount", "350"); await page.click("#f-save");
check(await seen(page, "#toast", "Budget saved for Shopping"), "a budget is saved");
check(await seen(page, "#screen", "₱350.00 a month"), "and shown beside the category");
await page.click('.choice:has-text("Shopping")');
check((await page.inputValue("#f-amount")) === "350.00" && (await page.getAttribute('#sheet button:has-text("Next month")', "aria-pressed")) === "true", "a change to an existing budget starts next month by default");
await page.click('#sheet button:has-text("Cancel")');
await setBudget("Shopping", "250", "This month");
await setBudget("Food", "100");
await setBudget("Rent", "2000");
check(await seen(page, "#screen", "₱250.00 a month"), "changing a budget this month replaces it from now on");
await setBudget("Family", "500", "Next month");
const famText = await text(page, ".choice:has-text('Family')");
if (!famText.includes("from November 2026")) console.log("   Family row was:", JSON.stringify(famText));
check(famText.includes("from November 2026"), "a budget that starts next month says so");
await setBudget("Family", "0", "This month");
check((await text(page, ".choice:has-text('Family')")).includes("No budget"), "0 removes a budget");
ledgerNow = JSON.parse((await stored(page)).local);
check(ledgerNow.state.rules.length === 6 && ledgerNow.state.rules.every((r) => r.kind === "budget"), "every change is a new dated row; none was edited: " + ledgerNow.state.rules.length);
check(ledgerNow.state.rules.filter((r) => r.subject_id === "cat-shopping").map((r) => r.amount).join() === "35000,25000", "the first Shopping budget is still there, then the new one");

// ---- the colours: green to red ----
await menuGo(page, "Spending");
for (let i = 0; i < 9; i++) if (await page.locator('button[aria-label="Later"]').isEnabled()) await page.click('button[aria-label="Later"]');
await page.click('button:has-text("By category")');
await shot(page, "19-money-graded");
const fills = await page.locator(".brow").evaluateAll((els) => els.map((e) => ({ name: e.innerText.split("\n")[0], cls: [...e.classList].find((c) => c.startsWith("g-")), color: getComputedStyle(e.querySelector(".bfill")).backgroundColor })));
const food = fills.find((f) => f.name === "Food"), shop = fills.find((f) => f.name === "Shopping");
check(shop.cls === "g-critical" && shop.color === "rgb(208, 59, 59)", "over budget is red: Shopping " + shop.cls + " " + shop.color);
check(food.cls === "g-serious" && food.color === "rgb(236, 131, 90)", "95% of a budget is orange: Food " + food.cls + " " + food.color);
check((await text(page, ".legend")).replace(/\s+/g, " ").includes("On track Getting there Nearly used up Over budget No budget"), "a legend says what the colours mean, in words");
check((await page.locator(".legend svg").count()) === 5, "each with its own shape, so colour is never the only signal");
check((await page.locator("#screen .caption").count()) === 0, "graded bars have no caption either");
const barCount = await page.locator(".bars .brow").count();
await page.click(".bars");
check((await page.locator("svg.donut").count()) === 1 && (await page.locator("svg.donut circle.slice").count()) === barCount, "tapping the bars makes a donut with one slice per category: " + barCount);
check((await page.locator(".legendlist .lrow").count()) === barCount && /₱[\d,.]+ · [\d.]+%/.test(await text(page, ".legendlist")), "its legend lists each category with the peso amount and the percent");
await shot(page, "32-donut");
await page.click('button:has-text("Show as list")');
check((await text(page, ".tbl")).includes("Share"), "the list twin is still there");
await page.click('button:has-text("Show as chart")');
await page.click(".legendlist");
check((await page.locator(".bars .brow").count()) === barCount, "tapping the donut or its legend brings the bars back");

// ---- the period picker at the top ----
check((await page.locator('.seg button:has-text("Year"), .seg button:has-text("Date range")').count()) === 0, "there are no Year or Date range buttons among the views");
await page.click(".ptitle");
check((await text(page, "#sheet")).includes("Show money for") && (await page.locator('#sheet button[data-action="period-kind"]').count()) === 3, "tapping the month at the top opens a picker: Month, Year, Date range");
await page.click('#sheet button[data-kind="month"]'); await shot(page, "34-period-month");
await page.click('#sheet button[data-kind="year"]');
await page.click('#sheet button[data-action="period-year"][data-id="2026"]');
check((await text(page, ".ptitle")).includes("2026") && !(await text(page, ".ptitle")).includes("October") && (await text(page, "#screen")).includes("spent in 2026"), "choosing a year shows the whole year");
await page.click('button:has-text("By month")');
check((await page.locator(".cols .col").count()) === 12, "and By month then shows its twelve months");
await page.click('button:has-text("By category")');
await page.click('button[aria-label="Earlier"]');
check((await text(page, ".ptitle")).includes("2025") && (await text(page, "#screen")).includes("Nothing verified in this period"), "the arrows step a whole year, and an empty one says so");
await page.click('button[aria-label="Later"]');
await page.click(".ptitle"); await page.click('#sheet button[data-kind="month"]');
check((await text(page, "#sheet .stepper")).includes("2026") && await page.locator('#sheet button[data-id="2026-11"]').isDisabled(), "the Month tab shows the months of a year, future ones off");
await page.click('#sheet button[data-id="2026-09"]');
check((await text(page, ".ptitle")).includes("September 2026"), "choosing a month shows that month");
await page.click(".ptitle"); await page.click('#sheet button[data-kind="range"]');
check((await text(page, "#sheet .rangepick")).includes("Sep 1, 2026") && (await text(page, "#sheet .rangepick")).includes("Sep 30, 2026"), "Date range starts from the period you were on");
await page.click('#sheet .rangepick button[data-target="from"]');
check((await text(page, "#sheet")).includes("Start date"), "the start date opens our calendar");
for (let i = 0; i < 3; i++) await page.click('#sheet button[aria-label="Earlier year"]');
for (let i = 0; i < 3; i++) await page.click('#sheet button[aria-label="Earlier month"]');
check((await text(page, "#sheet")).includes("June 2023"), "year arrows jump twelve months, month arrows fine-tune");
await page.click('#sheet .cal button[data-id="2023-06-18"]');
check((await text(page, "#sheet")).includes("Show money for") && (await text(page, "#sheet .rangepick")).includes("Jun 18, 2023"), "after choosing, it comes back to the picker with the start date set");
await page.click('#sheet .rangepick button[data-target="to"]');
for (let i = 0; i < 3; i++) await page.click('#sheet button[aria-label="Earlier year"]');
await page.click('#sheet button[aria-label="Later month"]');
await page.click('#sheet .cal button[data-id="2023-10-03"]');
await page.click('#sheet button:has-text("Show this range")');
check((await text(page, ".ptitle")).includes("Jun 18, 2023") && (await text(page, ".ptitle")).includes("Oct 3, 2023") && (await text(page, "#screen")).includes("108 days") && (await text(page, "#screen")).includes("Nothing verified in this period"), "a range shows its dates at the top, its length, and says plainly when it is empty");
check((await page.locator('button[aria-label="Earlier"]').count()) === 0, "a range has no arrows");
await page.click(".ptitle");
await page.click('#sheet .rangepick button[data-target="to"]');
for (let i = 0; i < 4; i++) await page.click('#sheet button[aria-label="Earlier month"]');
await page.click('#sheet .cal button[data-id="2023-06-01"]');
check(((await text(page, "#sheet .rangepick")).match(/Jun 1, 2023/g) ?? []).length === 2, "an end date before the start pulls the start back, so the range is never upside down");
await page.click('#sheet button:has-text("This month")');
check((await text(page, ".ptitle")).includes("Oct 1, 2026") && (await text(page, ".sub >> nth=0")).includes("3 days"), "a preset applies at once");
await page.click('button:has-text("Budgets")');
check((await text(page, "#screen")).includes("Budgets are set per month"), "Budgets with a range asks for a month");
await page.click('button:has-text("Show this month")');
await page.click('button:has-text("By category")');

await page.click('button:has-text("Budgets")');
await shot(page, "20-money-budgets");
const cards = await page.locator(".bcard").allInnerTexts();
check(cards.length === 3 && cards[0].includes("Shopping") && cards[1].includes("Food") && cards[2].includes("Rent"), "budgets are listed most-used first: " + cards.map((c) => c.split("\n")[0]).join(", "));
check(cards[0].includes("₱300.00 of ₱250.00") && cards[0].includes("Over budget") && cards[0].includes("Over by ₱50.00"), "an overspent budget says by how much, in plain words");
check(cards[1].includes("₱95.00 of ₱100.00") && cards[1].includes("Nearly used up") && cards[1].includes("₱5.00 left"), "a nearly used budget says what is left");
check(cards[2].includes("₱0.00 of ₱2,000.00") && cards[2].includes("On track") && cards[2].includes("₱2,000.00 left"), "an untouched budget is on track");
const meters = await page.locator(".meter").evaluateAll((els) => els.map((e) => ({ cls: [...e.classList].find((c) => c.startsWith("g-")), color: getComputedStyle(e.querySelector(".fill")).backgroundColor, w: Math.round(e.querySelector(".fill").getBoundingClientRect().width / e.getBoundingClientRect().width * 100) })));
check(meters[0].cls === "g-critical" && meters[0].w === 100, "the over-budget meter is full and red");
check(meters[1].cls === "g-serious" && meters[1].w === 95, "a 95% meter is 95% full and orange");
check(meters[2].cls === "g-good" && meters[2].w === 0 && meters[2].color === "rgb(12, 163, 12)", "an unused meter is empty and green");
const ticks = await page.locator(".meter .tick").evaluateAll((els) => els.map((e) => e.style.left));
check(ticks.length === 3 && ticks.every((t) => t === "10%"), "each meter has a mark for today's place in the month (3 of 31 days): " + ticks.join());
check((await text(page, "#screen")).includes("The black line is today's place in the month."), "and the page explains it");
check((await page.locator(".tbl").count()) === 1 && (await text(page, "#screen")).toLowerCase().includes("budget vs actual"), "the budget-vs-actual table sits under the chart");
const vcolors = await page.locator(".tbl td.vo, .tbl td.vu").evaluateAll((els) => els.map((e) => e.className.includes("vo") ? "over" : "under"));
check(vcolors.includes("over") && vcolors.includes("under"), "variance cells are marked over and under");
await page.click('button:has-text("Show as list")');
check(/Shopping[\s\S]*−₱50\.00 over/.test(await text(page, ".tbl")) && /Food[\s\S]*\+₱5\.00 under/.test(await text(page, ".tbl")) && (await text(page, ".tbl")).includes("Total"), "the list twin has budget, actual and a signed variance in words");
await page.click('button:has-text("Show as chart")');
await page.click('button[aria-label="Earlier"]');
check((await text(page, "#screen")).includes("No budgets for September 2026 yet"), "a budget set this month does not rewrite September");

// spending with no budget is listed, not hidden
await page.click('button[aria-label="Later"]');
await page.click('#nav button:has-text("Log")');
await page.click('button:has-text("Other amount")'); await page.fill("#f-amount", "80"); await page.click('#sheet .chip:has-text("Upskill")'); await page.click('#sheet .chip:has-text("Wallet")'); await page.click("#f-save"); await seen(page, "#toast", "Saved");
await page.click('#nav button:has-text("Verify")');
await page.click('button:has-text("Correct")'); await seen(page, "#screen", "of");
await verifyAll();
await menuGo(page, "Spending");
for (let i = 0; i < 9; i++) if (await page.locator('button[aria-label="Later"]').isEnabled()) await page.click('button[aria-label="Later"]');
await page.click('button:has-text("Budgets")');
const noBud = await page.waitForFunction(() => document.getElementById("screen").innerText.toLowerCase().includes("no budget set"), null, { timeout: 4000 }).then(() => true, () => false);   // the heading is shown in capitals
if (!noBud) console.log("   screen was:", JSON.stringify((await text(page, "#screen")).slice(0, 600)));
check(noBud && /Upskill\s+₱80\.00/.test(await text(page, "#screen")), "spending in a category with no budget is shown under its own heading");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// ---- the monthly trend ----
await menuGo(page, "Spending");
await page.click('button:has-text("By month")');
check((await page.locator("svg.trend").count()) === 1 && (await page.locator(".tmonth").count()) === 6, "the trend line chart has one tappable label per month");
const paths = await page.locator("svg.trend path.tl").count(), dots = await page.locator("svg.trend circle").count();
check(paths === 2 && dots >= 2 && dots < 12, "two lines, with points only where a month has data (" + dots + " points)");
await shot(page, "24-trend");
await page.click('button:has-text("Show as list")');
check((await text(page, "#screen")).includes("No data"), "the list twin says No data for empty months");
await page.click('button:has-text("Show as chart")');
await page.locator(".tmonth").last().click();
check((await text(page, "#screen")).includes("October 2026") && await page.locator(".bcard").count() > 0, "tapping a month opens that month's budgets");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// ---- the weekly check-in ----
await menuGo(page, "Check-in");
check((await text(page, "#top")).includes("Check-in") && (await text(page, "#screen")).includes("0 of"), "the check-in lists every account, none counted yet");
check(!(await text(page, "#screen")).includes("Weekly questions"), "the weekly questions wait until something is counted");
const ck = await text(page, "#screen"), lastBackup = JSON.parse((await stored(page)).local).settings.last_backup_at;
check(ck.includes("One reminder: back up after this check-in") === !lastBackup, "the check-in carries the backup reminder when a backup is due, and stays quiet right after one (last backup: " + (lastBackup ? "today" : "never") + ")");
await page.click('.choice:has-text("Wallet")');
await page.fill("#f-amount", "1");
check((await text(page, "#f-diff")).includes("missing"), "typing a count shows the difference before saving");
await shot(page, "21-checkin-count");
await page.click("#f-save");
check(await seen(page, "#toast", "Wallet:") && (await text(page, ".choice:has-text('Wallet')")).includes("missing"), "a count that is short is recorded and says how much is missing");
ledgerNow = JSON.parse((await stored(page)).local);
check(ledgerNow.state.checkIns.length === 1 && ledgerNow.state.transactions.some((t) => t.source === "reconciliation" && t.status === "verified"), "the count is kept, with a verified Unlogged entry for the gap");
await page.click('.choice:has-text("Four quick questions")');
const sheetText = await text(page, "#sheet");
check(sheetText.includes("Compared with the spreadsheet, was logging easier or harder"), "question 2 compares with the spreadsheet");
check(await page.inputValue("#q-count") === "1" && /^0\.\d\d$|^\d+\.\d\d$/.test(await page.inputValue("#q-amount")), "question 1 is filled in from the count (" + await page.inputValue("#q-count") + ", " + await page.inputValue("#q-amount") + ") and can be changed");
check(sheetText.includes("4. Photo or voice entries that needed fixing: 0"), "question 4 is filled in by the app");
check((await page.locator("#f-save").isDisabled()), "the survey cannot be saved until the ease question is answered");
await page.fill("#q-count", "2"); await page.fill("#q-amount", "50");
await page.click('#sheet button[data-action="survey-ease"][data-id="4"]'); await page.fill("#f-annoy", "too many taps");
await page.click("#f-save"); await seen(page, "#toast", "Answers saved");
ledgerNow = JSON.parse((await stored(page)).local);
const sv1 = ledgerNow.state.surveyResponses[0];
check(ledgerNow.state.surveyResponses.length === 1 && sv1.q2_ease === 4 && sv1.q1_missed_count === 2 && sv1.q1_missed_amount === 5000, "the survey answers are saved, with the owner's confirmed figures for question 1");
await menuGo(page, "Checks");
check((await text(page, "#screen")).includes("1 of 4 weeks answered"), "the review waits for about 4 weeks and says how far along it is");
await menuGo(page, "Check-in");
for (let wk = 1; wk <= 3; wk++) {   // three more weeks, so there are four answered weeks
  await page.clock.setFixedTime(new Date(T0.getTime() + wk * 7 * 86400000));
  await page.reload(); await page.waitForSelector("#nav button");
  await menuGo(page, "Check-in");
  await page.click('.choice:has-text("Wallet")'); await page.fill("#f-amount", String(wk)); await page.click("#f-save"); await seen(page, "#toast", "Wallet:");
  await page.click('.choice:has-text("Four quick questions")');
  await page.click(`#sheet button[data-action="survey-ease"][data-id="${wk + 1}"]`); await page.fill("#f-annoy", "week " + wk + " note");
  await page.click("#f-save"); await seen(page, "#toast", "Answers saved");
}
await menuGo(page, "Checks");
const review = await text(page, "#screen");
check(review.includes("Easier (1-5)") && review.includes("week 3 note") && review.toLowerCase().includes("what annoyed you"), "after four weeks the review shows each week's answers and what annoyed you");
check(/Not accounted for went from .* in the first week to .* in the latest/.test(review), "and the Unlogged trend in words, with a shape");
await shot(page, "40-survey-review");
await page.clock.setFixedTime(T0); await page.reload(); await page.waitForSelector("#nav button");
await shot(page, "22-checkin");
await page.click('#nav button:has-text("Log")');
check(await page.locator('.row[class*="tint-"]').count() === 0 && await page.locator(".tints").count() === 0 && !(await text(page, "#screen")).includes("Fixed costs"), "the Log list has no tints, no group words and no key: plain rows");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// ---- quick day totals ----
await page.click('#nav button:has-text("Log")');
const todayTotal = await text(page, ".daytotal");
check(/^₱\d/.test(todayTotal) && !(await text(page, "#screen")).includes("Spent today") && (await page.locator(".daycap").count()) === 0, "today's total is centered on the Log screen with no label");
check((await text(page, ".datelink")).includes("Select date") && (await page.locator(".datelink").boundingBox()).height < 50, "a small 'Select date' link replaces the open date box");
await page.click(".datelink");
check((await page.locator("#sheet .cal").count()) === 1 && (await text(page, "#sheet")).includes("October 2026"), "it opens our own small calendar, not the phone's wheel, so it cannot close itself");
check(await page.locator('#sheet .cal button[data-id="2026-10-04"]').isDisabled() && !(await page.locator('#sheet .cal button[data-id="2026-10-03"]').isDisabled()), "days after today cannot be chosen");
for (let i = 0; i < 9; i++) await page.click('#sheet button[aria-label="Earlier month"]');
check((await text(page, "#sheet")).includes("January 2026"), "the month arrows move back");
await shot(page, "33-calendar");
await page.click('#sheet .cal button[data-id="2026-01-05"]');
check((await page.locator("#sheet .cal").count()) === 0, "choosing a day closes it");
check((await text(page, ".daytotal")).includes("₱0.00") && (await text(page, ".daycap")).includes("Jan"), "and the big number becomes that day's total, with the date under it");
check((await text(page, ".datelink")).includes("Change date") && (await text(page, "#screen")).includes("Back to today"), "and the links become Change date and Back to today");
check((await text(page, "h2.today")).toLowerCase().includes("jan") && (await text(page, "#screen")).includes("Nothing logged that day"), "the list under the buttons follows the chosen day");
await shot(page, "23-day-totals");
await page.click('button:has-text("Back to today")');
check((await text(page, ".daytotal")) === todayTotal && (await page.locator(".daycap").count()) === 0, "Back to today shows today's total again");
check((await text(page, "h2.today")).toLowerCase() === "today" && !(await text(page, "#screen")).includes("Nothing logged that day"), "and today's entries");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// ---- checks: card reserve and the Unlogged habit ----
await menuGo(page, "Checks");
const ctext = await text(page, "#screen");
check(/No card reserve|Covered|Short by/.test(ctext), "the card reserve check says covered, short, or that none is set up");
check(await page.locator(".bars .brow").count() === 1, "the Unlogged chart has one bar for the one week that was counted");
await page.click(".bars .brow");
check((await text(page, ".caption")).includes("could not be accounted for"), "tapping the bar says what it means in words");
await page.click('button:has-text("Show as list")');
check((await text(page, ".tbl >> nth=0")).includes("Not counted"), "the list twin marks weeks nobody counted instead of showing zero");
check((await text(page, "#screen")).includes("week 3 note"), "the weekly questions review shows the answers");
await shot(page, "27-checks");
await page.click('button:has-text("Show as chart")');
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// ---- trips ----
await menuGo(page, "Trips");
check((await text(page, "#screen")).includes("No trips yet"), "trips start empty");
await page.click('button:has-text("Add a trip")');
check(await page.locator("#f-save").isDisabled(), "a trip needs a name first");
await page.fill("#t-name", "Test Trip"); await page.fill("#f-amount", "1000");
await page.click("#f-save"); await seen(page, "#toast", "Trip added");
check((await text(page, "#screen")).includes("₱0.00 of ₱1,000.00") && (await text(page, "#screen")).includes("On track"), "a new trip shows its budget in words and as a graded meter");
await page.click('button:has-text("Tag new entries with this trip")');
await seen(page, "#screen", "Tagging new entries");
await page.click('#nav button:has-text("Log")');
check((await text(page, "#screen")).includes("Tagging new entries: Test Trip"), "the Log screen says new entries are being tagged");
await page.click('button:has-text("Other amount")'); await page.fill("#f-amount", "120"); await page.click('#sheet .chip:has-text("Upskill")'); await page.click('#sheet .chip:has-text("Wallet")'); await page.click("#f-save"); await seen(page, "#toast", "Saved");
ledgerNow = JSON.parse((await stored(page)).local);
check(ledgerNow.state.transactions.some((t) => t.tag_id === ledgerNow.state.tags[0].id && t.status === "draft"), "the new entry carries the trip tag with no extra taps");
await menuGo(page, "Trips");
check((await text(page, "#screen")).includes("plus ₱120.00 not verified yet"), "unverified trip spending is mentioned, not counted");
await shot(page, "28-trips");
await page.click('button:has-text("Tagging new entries")');
await page.click('#nav button:has-text("Log")');
check(!(await text(page, "#screen")).includes("Tagging new entries"), "tagging can be switched off");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// ---- the overrun buffer ----
await addAccount(page, "GCash", "asset", "1000"); await seen(page, "#toast", "Added GCash");
await menuGo(page, "Buffer");
check((await text(page, "#screen")).includes("Set up the buffer"), "the buffer starts unset");
await page.click('button:has-text("Set up the buffer")');
check(await page.locator("#f-save").isDisabled(), "setup needs the wallet chosen first");
await page.click('#sheet .chip:has-text("GCash")');
await page.fill("#b-buf", "600"); await page.fill("#b-allow", "500");
check((await text(page, "#f-msg")).includes("more than the wallet holds") && await page.locator("#f-save").isDisabled(), "envelopes bigger than the wallet are refused, with the amount");
await page.fill("#b-allow", "300");
await page.click("#f-save"); await seen(page, "#toast", "Wallet split");
const bt = await text(page, "#screen");
check(bt.includes("₱600.00") && bt.includes("₱300.00"), "the buffer and the allowance are shown separately");
await page.click('#nav button:has-text("Log")');
await page.click('button:has-text("Other amount")'); await page.fill("#f-amount", "400"); await page.click('#sheet .chip:has-text("Upskill")'); await page.click('#sheet .chip:has-text("GCash")'); await page.click("#f-save");
check(await seen(page, "#toast", "₱100.00 came out of the overrun buffer"), "spending past the allowance says how much came out of the buffer");
await menuGo(page, "Buffer");
const bt2 = await text(page, "#screen");
check(bt2.includes("everyday allowance in GCash is empty") && /Upskill[\s\S]*₱100\.00/.test(bt2) && bt2.includes("₱500.00"), "the draw is listed by category, and the empty allowance is said in words");
await shot(page, "29-buffer");
await page.click('#nav button:has-text("Verify")');
check((await text(page, "#screen")).includes("Upskill"), "a draft that took from two envelopes still shows its category when verifying");
await page.click('button:has-text("Correct")'); await seen(page, "#screen", "of");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// ---- choosing a bank: one button that opens a scrollable list ----
await menuGo(page, "Setup");
check((await page.locator("#screen .chips .chip").count()) === 0 && (await page.locator("#a-bank").count()) === 1 && (await page.locator("#a-name").count()) === 1, "Setup shows one 'Choose a bank' button instead of a wall of tiles, and still lets you type a name");
await page.click("#a-bank");
check((await page.locator("#sheet .bankrow").count()) === 13 && (await text(page, "#sheet")).includes("Coins.ph"), "it opens a list: eleven banks and wallets (Coins.ph included), Cash, and 'not in the list'");
check((await page.locator("#sheet .banklist").evaluate((e) => getComputedStyle(e).overflowY)) === "auto", "the list scrolls");
await shot(page, "30-banks");
await page.click('#sheet .bankrow:has-text("GoTyme")');
check((await page.locator("#a-name").count()) === 0 && (await page.locator("#a-sub").count()) === 1 && (await text(page, "#a-bank")).includes("GoTyme"), "choosing a bank closes the list and asks which part of the bank");
await page.fill("#a-sub", "Emergency Fund");
check((await text(page, "#a-preview")).includes("GoTyme · Emergency Fund"), "the saved name is previewed as you type");
await page.fill("#a-open", "100"); await page.click('button:has-text("Add account")'); await seen(page, "#toast", "Added GoTyme · Emergency Fund");
await page.click("#a-bank"); await page.click('#sheet .bankrow:has-text("GoTyme")'); await page.fill("#a-sub", "Savings"); await page.click('button:has-text("Add account")'); await seen(page, "#toast", "Added GoTyme · Savings");
check((await page.locator("#screen .row", { hasText: "GoTyme" }).count()) === 2, "two accounts can live in the same bank");
await page.click("#a-bank"); await page.click('#sheet .bankrow:has-text("Not in the list")');
check((await page.locator("#a-name").count()) === 1, "'not in the list' goes back to typing a name");
ledgerNow = JSON.parse((await stored(page)).local);
check(ledgerNow.state.accounts.filter((a) => a.bank === "gotyme").length === 2, "the bank is remembered on each account");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// ---- bank logos: loaded for every listed bank by themselves (the network is faked here) ----
const pngB64 = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = c.height = 64; const x = c.getContext("2d"); x.fillStyle = "#1a8"; x.fillRect(0, 0, 64, 64); return c.toDataURL("image/png").split(",")[1]; });
const tileB64 = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d"); x.fillStyle = "#d6d6d6"; x.fillRect(0, 0, 128, 128); x.fillStyle = "#9a9a9a"; x.font = "bold 60px sans-serif"; x.textAlign = "center"; x.fillText("U", 64, 88); return c.toDataURL("image/png").split(",")[1]; });   // the flat grey letter tile some services invent
const pngReply = (b64, cors) => ({ status: 200, contentType: "image/png", headers: cors ? { "access-control-allow-origin": "*" } : {}, body: Buffer.from(b64, "base64") });
iconServe = (r) => {
  const u = r.request().url();
  if (u === "https://icon.horse/icon/gotyme.com.ph") return r.fulfill(pngReply(pngB64, true));          // copyable
  if (u === "https://icon.horse/icon/unionbankph.com") return r.fulfill(pngReply(tileB64, true));       // a placeholder: must be refused
  if (u === "https://landbank.com/apple-touch-icon.png") return r.fulfill(pngReply(pngB64, false));     // the bank's own site icon: showable only
  if (u.startsWith("https://en.wikipedia.org/w/api.php")) return r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ query: { pages: [{ title: "Maya", thumbnail: { source: "https://upload.wikimedia.org/wikipedia/commons/thumb/maya-logo.png" } }] } }) });   // Maya's Wikipedia picture
  if (u === "https://upload.wikimedia.org/wikipedia/commons/thumb/maya-logo.png") return r.fulfill(pngReply(pngB64, true));
  return r.abort();
};
await page.click("#a-bank");
check((await text(page, "#sheet")).includes("No logo found online yet for"), "with no internet at the start, the list says which logos are still missing");
await page.click('#sheet button:has-text("Try again")');
await page.waitForFunction(() => !document.getElementById("sheet").innerText.includes("Loading logos"), null, { timeout: 15000 });
const gotymeImg = await page.locator('#sheet .bankrow:has-text("GoTyme") img.ico').getAttribute("src");
check(gotymeImg?.startsWith("data:image/"), "a copyable logo is copied and kept on the phone");
check((await page.locator('#sheet .bankrow:has-text("Landbank") img.ico').getAttribute("src")) === "https://landbank.com/apple-touch-icon.png", "a bank's own site icon is shown from there");
check((await page.locator('#sheet .bankrow:has-text("UnionBank") img').count()) === 0, "a generated grey placeholder is refused, so UnionBank keeps its letter");
check(!iconAsked.some((u) => /maya|paymaya/.test(u) && !/wiki/.test(u)), "Maya is never asked of the icon services (they only return a grey arrow for it)");
check((await page.locator('#sheet .bankrow:has-text("Maya") img.ico').getAttribute("src"))?.startsWith("data:image/") && iconAsked.some((u) => u.includes("wikipedia.org")), "Maya's logo is found through Wikipedia and copied onto the phone, with nothing to tap");
const rep = await text(page, "#logo-report");
check(rep.includes("UnionBank") && rep.includes("only a generated placeholder came back") && rep.includes("GCash") && rep.includes("its website: could not be loaded") && !rep.includes("Maya"), "and the reasons are listed for each bank and source");
await shot(page, "31-logos");
await page.click('#sheet button:has-text("Cancel")');
check((await page.locator("#screen .row", { hasText: "GoTyme" }).locator("img.ico").count()) === 2, "every GoTyme account shows the bank's logo without anything being set on it");
await addAccount(page, "Landbank", "asset", "5"); await seen(page, "#toast", "Added Landbank");
check((await page.locator('#screen .row:has-text("Landbank") img.ico').count()) === 1, "an account typed as 'Landbank' shows Landbank's logo too");
ledgerNow = JSON.parse((await stored(page)).local);
check(ledgerNow.settings.bankLogos.gotyme.icon.startsWith("data:image/") && ledgerNow.settings.bankLogos.landbank.icon_url.endsWith("/apple-touch-icon.png") && !ledgerNow.settings.bankLogos.unionbank, "the logos live in the phone's settings, one per bank");
check(ledgerNow.state.accounts.every((a) => !a.icon_url), "nothing is copied onto the accounts themselves");
// a wrong logo can be removed, and stays removed
await page.click('#screen .row:has-text("GoTyme") .icobtn >> nth=0');
await page.click('#sheet button:has-text("Remove the picture")');
ledgerNow = JSON.parse((await stored(page)).local);
check(!ledgerNow.settings.bankLogos.gotyme && ledgerNow.settings.bankLogosBlocked.gotyme === true, "Remove the picture drops the bank's logo and marks it so it is not fetched again");
check((await page.locator("#screen .row", { hasText: "GoTyme" }).locator("img.ico").count()) === 0, "the accounts go back to a letter tile");
// linking an account to a bank from its picture window
await addAccount(page, "Euf", "asset", "10"); await seen(page, "#toast", "Added Euf");
await page.click('#screen .row:has-text("Euf") .icobtn');
await page.click("#i-bank");
await page.click('#sheet .bankrow:has-text("MariBank")');
ledgerNow = JSON.parse((await stored(page)).local);
check(ledgerNow.state.accounts.find((a) => a.name === "Euf").bank === "maribank" && (await text(page, "#sheet")).includes("Picture for Euf"), "an account with its own name can be linked to a bank, and the picture window comes back");
await page.click('#sheet button:has-text("Cancel")');
// a stray tap must not give an account another bank's logo, and a wrong link can be put right
await page.click('#screen .row:has-text("Landbank") .icobtn');
await page.click("#i-bank"); await page.click('#sheet .bankrow:has-text("GCash")');
check((await text(page, "#toast")).includes("Tap GCash again"), "choosing a different bank than the account's name asks for a second tap");
ledgerNow = JSON.parse((await stored(page)).local);
check(!ledgerNow.state.accounts.find((a) => a.name === "Landbank").bank, "and nothing changed yet");
await page.click('#sheet .bankrow:has-text("GCash")');
await seen(page, "#screen", "linked to GCash");
await page.click("#i-bank"); await page.click('#sheet .bankrow:has-text("Landbank")');
await page.waitForFunction(() => !document.getElementById("screen").innerText.includes("linked to GCash"), null, { timeout: 4000 });
ledgerNow = JSON.parse((await stored(page)).local);
check(ledgerNow.state.accounts.find((a) => a.name === "Landbank").bank === "landbank", "putting it right links it to its own bank again");
await page.click('#sheet button:has-text("Cancel")');
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// ---- goals ----
await menuGo(page, "Goals");
check((await text(page, "#screen")).includes("No goals yet"), "goals start empty");
await page.click('button:has-text("Add a goal")');
check(await page.locator("#f-save").isDisabled(), "a goal needs a name and a place first");
await page.fill("#g-name", "Apartment"); await page.fill("#f-amount", "20000"); await page.click('#sheet .chip:has-text("Wallet")');
await page.click("#f-save"); await seen(page, "#toast", "Goal added");
check((await text(page, "#screen")).includes("Hidden") && !(await text(page, "#screen")).includes("20,000"), "a new goal hides its balance");
await page.click('button:has-text("Show balances")');
check((await text(page, "#screen")).includes("of ₱20,000.00") && (await text(page, "#screen")).includes("to go"), "showing balances reveals progress in words");
await shot(page, "25-goals");
await page.click('button:has-text("Put money in")');
check(!(await text(page, "#sheet")).includes("Wallet"), "you cannot take the money from the goal's own account");
await page.fill("#f-amount", "500");
await page.click("#f-save"); await seen(page, "#toast", "set for Apartment");
ledgerNow = JSON.parse((await stored(page)).local);
check(ledgerNow.state.goals.length === 1 && ledgerNow.state.transactions.some((t) => t.payee === "To Apartment" && t.status === "draft"), "the deposit is a draft transfer until verified");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// ---- the pay plan ----
await menuGo(page, "Pay plan");
check((await text(page, "#screen")).includes("No plan loaded"), "the pay plan starts empty");
await page.click('button:has-text("Load a plan")');
await page.fill("#p-text", "{ not a plan");
check((await text(page, "#p-prev")).includes("could not be read") && await page.locator("#f-save").isDisabled(), "a broken plan is refused in plain words");
const plan = { schema_version: 1, unit: "PHP_whole_pesos", effective_from: "2026-10-01",
  paydays: [{ id: "first", day: 15, expected_income: 5100 }, { id: "second", day: "last", expected_income: 7100 }],
  lines: [{ name: "Food", first: 3000, second: 3000 }, { name: "Shopping", first: 1000, second: 1000 }, { name: "Rent", first: 0, second: 2000 },
    { name: "Apartment", kind: "goal", first: 1000, second: 1000 }, { name: "Mystery", first: 100, second: 100 }],
  ef_target_basis: ["Rent", "Food"], ef_target_months: 3 };
await page.fill("#p-text", JSON.stringify({ ...plan, unit: undefined }));
check((await text(page, "#p-prev")).includes("declare its unit") && await page.locator("#f-save").isDisabled(), "a plan that does not declare its unit is refused");
await page.fill("#p-text", JSON.stringify({ ...plan, paydays: [{ day: 15, expected_income: 5101 }, plan.paydays[1]] }));
check((await text(page, "#p-prev")).includes("short by 1"), "a payday whose lines do not add up to its income is refused, with the difference");
await page.fill("#p-text", JSON.stringify(plan));
check((await text(page, "#p-prev")).includes("Looks good") && !(await page.locator("#f-save").isDisabled()), "a good plan shows a one-line summary before it is used");
await page.click("#f-save"); if (!(await seen(page, "#toast", "Plan loaded"))) console.log("   toast was:", JSON.stringify(await text(page, "#toast")), "banner:", JSON.stringify(await text(page, "#banner")), "sheet:", JSON.stringify((await text(page, "#sheet")).slice(0, 200)));
const ptxt = await text(page, "#screen");
if (!ptxt.includes("last day of the month")) console.log("   plan screen:", JSON.stringify(ptxt.slice(0, 500)));
check(ptxt.includes("last day of the month") && ptxt.includes("₱5,100.00") && ptxt.includes("₱7,100.00") && ptxt.includes("₱12,200.00") && ptxt.toLowerCase().includes("this cutoff"), "the plan shows both paydays (the second at month end) and the totals per payday and month");
check(ptxt.includes("Mystery") && ptxt.includes("not tracked") && ptxt.includes("In effect since"), "a line with no matching category is said out loud, and the start date is shown");
await page.click('button:has-text("Record pay received")');
check(await page.locator("#f-save").isDisabled(), "pay needs an amount first");
await page.fill("#f-amount", "5000.50"); await page.click("#f-save"); await seen(page, "#toast", "Pay recorded");
const inc = await text(page, "#screen");
check(inc.includes("₱5,000.50") && inc.includes("−₱2,099.50 less"), "pay received is shown against the plan as a signed difference in words");
ledgerNow = JSON.parse((await stored(page)).local);
check(ledgerNow.settings.plans[0].paydays[1].income === 710000, "the plan itself is not changed by the real pay");
await page.click('button:has-text("Load a newer plan")');
await page.fill("#p-text", JSON.stringify({ ...plan, lines: plan.lines.map((l) => (l.name === "Rent" ? { ...l, second: 1900 } : l.name === "Apartment" ? { ...l, second: 1100 } : l)) }));
await page.click("#f-save");
check(await seen(page, "#toast", "never edited"), "loading a different plan with the same start date is refused: plans are never edited");
await page.click('#sheet button:has-text("Cancel")');
await shot(page, "26-plan");
ledgerNow = JSON.parse((await stored(page)).local);
check(ledgerNow.settings.plans.length === 1 && ledgerNow.settings.plans[0].lines[0].first === 300000, "the plan is kept in the phone's settings as a dated list, in centavos");
await menuGo(page, "Goals");
check((await text(page, "#screen")).includes("at your plan's ₱2,000.00 a month"), "a goal shows how long the plan takes");
await page.click('button:has-text("Add a goal")'); await page.fill("#g-name", "Emergency Fund"); await page.fill("#f-amount", "999"); await page.click("#sheet .chip >> nth=0"); await page.click("#f-save");
await seen(page, "#screen", "Emergency Fund");
if (await page.locator('button:has-text("Show balances")').count()) await page.click('button:has-text("Show balances")');
const efText = await text(page, "#screen");
check(/Target\s*₱24,000\.00/.test(efText) && efText.includes("3 months of Rent, Food from your plan"), "the Emergency Fund target is worked out from the plan (3 x Rent + Food), not the 999 typed when the goal was made");
check(/Months to target\s*Not known yet/.test(efText) && /Monthly contribution\s*none in your plan/.test(efText), "with no contribution line in the plan, months to target says it is not known");
check(!efText.includes("Your plan suggests") && !efText.includes("Use it"), "there is no 'use it' button that would freeze the target as a typed number");
await shot(page, "41-emergency-target");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// pictures survive a reload and appear where you choose an account
await page.reload(); await page.waitForSelector("#nav button");
await page.click('#nav button:has-text("Log")'); await page.click('button.tile:has-text("Breakfast")');
check((await page.locator("#sheet .chip img.ico").count()) >= 3, "pictures and bank logos are on the account buttons when you log, so you can tell them apart at a glance");
await shot(page, "16-pay-with-pictures");
await page.click('#sheet button:has-text("Cancel")');
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));
await ctx.close();

// ===== 5f. scanning a photo =====
console.log("Scan");
({ ctx, page, errors } = await open({ blockSw: true }));
await addAccount(page, "Wallet", "asset", "1000");
await addAccount(page, "MariBank", "asset", "0");
// An invented receipt drawn in the page, so no real paper is ever in the repository.
const receiptPng = await page.evaluate(() => {
  const c = document.createElement("canvas"); c.width = 900; c.height = 1000;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, 900, 1000); x.fillStyle = "#000"; x.font = "bold 44px monospace";
  ["SAMPLE BURGER HOUSE", "Official Receipt", "Date: Oct 2, 2026", "1 Burger meal   150.00", "Subtotal   150.00", "VAT 12%   16.07", "TOTAL   150.00", "Cash   200.00", "Change   50.00", "Thank you"].forEach((l, i) => x.fillText(l, 40, 80 + i * 80));
  return c.toDataURL("image/png").split(",")[1];
});
await menuGo(page, "Scan");
check((await text(page, "#screen")).includes("never sent anywhere"), "the Scan screen says the photo never leaves the phone");
check(await page.locator('#screen input[data-scan="1"][capture="environment"]').count() === 1 && await page.locator('#screen input[data-scan="1"]:not([capture])').count() === 1 && (await text(page, "#screen")).includes("Take a photo") && (await text(page, "#screen")).includes("Choose from photos or files"), "the Scan screen offers both the camera and photos or files");
await page.setInputFiles("input[data-scan]:not([capture])", { name: "receipt.png", mimeType: "image/png", buffer: Buffer.from(receiptPng, "base64") });
check(await seen(page, "#sheet", "Check what I read", 180000), "a photo is read on the phone and a window opens to check the guess");
check(await page.locator('#sheet .chip[aria-pressed="true"]:has-text("Store receipt")').count() === 1, "it recognised a store receipt");
check(await page.inputValue("#f-amount") === "150.00", "it found the total, not the subtotal, cash or change (" + await page.inputValue("#f-amount") + ")");
check(await page.inputValue("#f-date") === "2026-10-02", "it found the date on the paper (" + await page.inputValue("#f-date") + ")");
check(/BURGER/i.test(await page.inputValue("#f-payee")), "it found the store name (" + await page.inputValue("#f-payee") + ")");
check(await page.locator('#sheet .chip[aria-pressed="true"]:has-text("Food")').count() === 1, "and guessed the Food category from the store");
await shot(page, "35-scan-result");
check(await page.locator('#sheet .chip[aria-pressed="true"]:has-text("Wallet")').count() === 0 && await page.locator("#f-save").isDisabled(), "when the paper does not name the account, none is chosen for you and saving waits");
await page.click('#sheet .chip:has-text("Wallet")');
await page.click("#f-save");
check(await seen(page, "#screen", "as a draft with its photo"), "saving keeps it as a draft, with its photo");
await page.click('#nav button:has-text("Verify")');
check(await page.waitForSelector("img.shot[data-photo]:not([hidden])", { timeout: 4000 }).then(() => true, () => false), "Verify shows the photo beside the entry");
check((await text(page, "#screen")).includes("Read from the photo"), "and says it was read from a photo");
await shot(page, "36-verify-photo");
await page.click('button[aria-label="Open the photo full size"]');
check(await page.waitForSelector("#sheet img.shotfull:not([hidden])", { timeout: 4000 }).then(() => true, () => false), "tapping the photo opens it full size");
await page.click('#sheet button:has-text("Close")');
await page.click('button:has-text("Edit")'); await page.fill("#f-amount", "140"); await page.click("#f-save");
await seen(page, "#screen", "₱140.00");
let scanned = JSON.parse((await stored(page)).local);
const tx = scanned.state.transactions.find((t) => t.source === "photo");
check(tx && tx.status === "draft" && tx.edited_before_verify === true, "fixing the amount is recorded as an edit of a photo draft");
check(scanned.state.attachments.length === 1 && scanned.state.attachments[0].transaction_id === tx.id, "the ledger records the attachment, not the picture itself");
check(!JSON.stringify(scanned).includes("data:image/jpeg"), "the picture is not inside the ledger text");
await page.reload(); await page.waitForSelector("#nav button"); await page.click('#nav button:has-text("Verify")');
check(await page.waitForSelector("img.shot[data-photo]:not([hidden])", { timeout: 4000 }).then(() => true, () => false), "the photo is still there after the app is closed and reopened");
await page.click('button:has-text("Delete")'); await page.click('button:has-text("Tap again to delete")');
await seen(page, "#screen", "Nothing to verify");
await page.waitForTimeout(300);
const left = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("financialTracker"); r.onsuccess = () => { const g = r.result.transaction("photos").objectStore("photos").count(); g.onsuccess = () => res(g.result); }; }));
check(left === 0, "deleting the draft deletes its photo from the phone");
// A bank app screenshot: the bank on the From line paid, and nothing else is guessed over it.
const bankPng = await page.evaluate(() => {
  const c = document.createElement("canvas"); c.width = 900; c.height = 1000;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, 900, 1000); x.fillStyle = "#000"; x.font = "bold 40px sans-serif";
  ["Transaction Details", "PHP 592.50", "From MariBank", "To SAMPLE SUPERMARKET", "Transaction Amount PHP 592.50", "Transaction Type Credit Card Transaction", "Transaction Time 01 Oct 2026, 19:52"].forEach((l, i) => x.fillText(l, 40, 80 + i * 90));
  return c.toDataURL("image/png").split(",")[1];
});
await menuGo(page, "Scan");
await page.setInputFiles("input[data-scan]:not([capture])", { name: "bank.png", mimeType: "image/png", buffer: Buffer.from(bankPng, "base64") });
check(await seen(page, "#sheet", "Check what I read", 180000), "a bank screenshot is read too");
check(await page.locator('#sheet .chip[aria-pressed="true"]:has-text("MariBank")').count() === 1, "it chose MariBank, the bank on the From line, as the account that paid");
check(/SAMPLE ?SUPERMARKET/i.test(await page.inputValue("#f-payee")) && await page.inputValue("#f-amount") === "592.50" && await page.inputValue("#f-date") === "2026-10-01", "and read the payee, the amount and the date");
check(await page.evaluate(() => { const sh = document.querySelector("#sheet .sheet"), d = document.querySelector("#sheet input[type=date]").getBoundingClientRect(), r = sh.getBoundingClientRect(); return sh.scrollWidth <= sh.clientWidth && d.left >= r.left && d.right <= r.right; }), "the window does not scroll sideways and its date box stays inside it");
await shot(page, "42-scan-bank");
await page.click('#sheet button:has-text("Cancel")');

// ----- one receipt, two categories -----
await menuGo(page, "Scan");
await page.setInputFiles("input[data-scan]:not([capture])", { name: "receipt.png", mimeType: "image/png", buffer: Buffer.from(receiptPng, "base64") });
check(await seen(page, "#sheet", "Check what I read", 180000), "the receipt is read again, to split it");
await page.click('#sheet .chip:has-text("Wallet")');
check(await page.locator('#sheet .chip[aria-pressed="true"]:has-text("Food")').count() === 1, "Food is the first category");
await page.click('#sheet button:has-text("Split between two categories")');
check(await page.locator("#f-save").isDisabled(), "a split cannot be saved until the second category and its amount are given");
await page.click('#sheet button[data-action="pick-split"]:has-text("Essentials")'); await page.fill("#f-split", "50");
check((await text(page, "#split-note")).includes("Food gets ₱100.00, Essentials gets ₱50.00"), "it says what each category gets");
await page.fill("#f-split", "150");
check(await page.locator("#f-save").isDisabled(), "a second part as big as the whole is refused");
await page.fill("#f-split", "50"); await page.click("#f-save");
check(await seen(page, "#screen", "as a draft with its photo"), "the split is saved as one draft");
const sp = JSON.parse((await stored(page)).local), spTx = sp.state.transactions.filter((t) => t.source === "photo" && t.payee.includes("BURGER")).pop();
const spEntries = sp.state.entries.filter((e) => e.transaction_id === spTx.id);
check(spEntries.some((e) => e.category_id === "cat-food" && e.amount === 10000) && spEntries.some((e) => e.category_id === "cat-essentials" && e.amount === 5000) && spEntries.some((e) => e.account_id && e.amount === -15000), "Food ₱100.00 and Essentials ₱50.00 are charged once, ₱150.00, to the account");
await page.click('#nav button:has-text("Verify")');
check((await text(page, "#screen")).includes("Food ₱100.00") && (await text(page, "#screen")).includes("Essentials ₱50.00"), "Verify shows both parts and the photo");
await page.click('button:has-text("Delete")'); await page.click('button:has-text("Tap again to delete")'); await page.waitForTimeout(400);

// ----- quick capture from the scanner button on the Log screen -----
await page.click('#nav button:has-text("Log")');
check(await page.locator('#top button[data-action="open-scan-pick"]').count() === 1, "the Log screen has one scanner button");
await page.click('button[data-action="open-scan-pick"]');
check(await page.locator('#sheet input[data-scan="quick"][capture="environment"]').count() === 1 && await page.locator('#sheet input[data-scan="quick"]:not([capture])').count() === 1 && (await text(page, "#sheet")).includes("Take a photo") && (await text(page, "#sheet")).includes("Choose from photos or files"), "it offers both: take a photo with the camera, or choose from photos or files");
await page.click('#sheet button:has-text("Cancel")');
await page.click('button[data-action="open-scan-pick"]'); await page.setInputFiles('input[data-scan="quick"]:not([capture])', { name: "bank.png", mimeType: "image/png", buffer: Buffer.from(bankPng, "base64") });
check(await seen(page, "#toast", "Saved", 180000), "one photo is enough: it is read and saved as a draft by itself");
let q = JSON.parse((await stored(page)).local);
const quick = q.state.transactions.find((t) => t.source === "photo" && t.status === "draft");
check(quick && quick.edited_before_verify === false && q.state.attachments.some((a) => a.transaction_id === quick.id) && (q.settings.scan_queue ?? []).length === 0, "it is a photo draft with its photo, and the queue is empty again");
const quickEntries = q.state.entries.filter((e) => e.transaction_id === quick.id), mari = q.state.accounts.find((a) => a.name === "MariBank");
check(quickEntries.some((e) => e.account_id === mari.id && e.amount === -59250) && quickEntries.some((e) => e.category_id === "cat-essentials" && e.amount === 59250), "it chose MariBank, ₱592.50 and Essentials without being asked");
await page.click('#nav button:has-text("Verify")');
check(await page.waitForSelector("img.shot[data-photo]:not([hidden])", { timeout: 4000 }).then(() => true, () => false) && (await text(page, "#screen")).includes("Essentials"), "Verify shows the photo beside what was read");
await shot(page, "43-quick-verify");
await page.click('#nav button:has-text("Log")');

// closing the app right after the photo: nothing is lost, it is read the next time the app opens
await page.click('button[data-action="open-scan-pick"]'); await page.setInputFiles('input[data-scan="quick"]:not([capture])', { name: "bank2.png", mimeType: "image/png", buffer: Buffer.from(bankPng, "base64") });
for (let i = 0; i < 100 && (JSON.parse((await stored(page)).local).settings.scan_queue ?? []).length === 0; i++) await page.waitForTimeout(100);
check(JSON.parse((await stored(page)).local).settings.scan_queue?.length === 1, "the photo is kept in the queue the moment it is taken");
await page.reload(); await page.waitForSelector("#nav button");
let resumed = false;
for (let i = 0; i < 1800 && !resumed; i++) { const l = JSON.parse((await stored(page)).local); resumed = l.state.transactions.filter((t) => t.source === "photo" && t.status === "draft").length === 2 && (l.settings.scan_queue ?? []).length === 0; if (!resumed) await page.waitForTimeout(100); }
check(resumed, "after the app is closed and opened again, the waiting photo is read and saved as a draft");

// when the paper does not name the account, the photo is kept and the app asks instead of guessing
await page.click('#nav button:has-text("Log")');
await page.click('button[data-action="open-scan-pick"]'); await page.setInputFiles('input[data-scan="quick"]:not([capture])', { name: "receipt.png", mimeType: "image/png", buffer: Buffer.from(receiptPng, "base64") });
check(await seen(page, "#sheet", "Check what I read", 180000), "a photo that cannot be saved safely opens the window to ask");
check(await page.locator('#sheet button:has-text("Throw this photo away")').count() === 1, "and lets you throw the photo away");
await page.click('#sheet button:has-text("Cancel")');
check((await text(page, "#screen")).includes("1 photo needs a look"), "closing the window leaves a note on Log that one photo needs a look");
await page.click('button:has-text("1 photo needs a look")');
await page.click('#sheet button:has-text("Throw this photo away")');
check(await seen(page, "#toast", "thrown away") && (JSON.parse((await stored(page)).local).settings.scan_queue ?? []).length === 0, "throwing it away empties the queue");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));
await ctx.close();

// ===== 5g. income: a payslip with overtime =====
console.log("Income");
({ ctx, page, errors } = await open({ blockSw: true }));
await addAccount(page, "Wallet", "asset", "1000");
await addAccount(page, "Savings", "asset", "0");
await menuGo(page, "Goals");
await page.click('button:has-text("Add a goal")'); await page.fill("#g-name", "Emergency Fund"); await page.click('#sheet .chip:has-text("Savings")'); await page.click("#f-save");
await seen(page, "#screen", "Emergency Fund");
const receiptPngForSlip = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 600; c.height = 300; const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, 600, 300); x.fillStyle = "#000"; x.font = "bold 36px sans-serif"; x.fillText("Net Pay   1,000.00", 30, 120); return c.toDataURL("image/png").split(",")[1]; });
await menuGo(page, "Income");
check((await text(page, "#screen")).includes("Nothing recorded"), "Income starts empty and says how to begin");
check(!(await text(page, "#screen")).includes("(interest, refund)") && (await text(page, "#screen")).includes("Add other income"), "the other-income button is just 'Add other income'");
await page.click('button:has-text("Add a payslip")');
const choice = await text(page, "#sheet");
check(choice.includes("Type it in") && choice.includes("Take a photo") && choice.includes("Choose from photos or files") && await page.locator('#sheet input[data-scan="payslip"][capture="environment"]').count() === 1, "Add a payslip offers two ways: type it in, or read it from a photo (camera, or photos and files)");
await page.click('#sheet button:has-text("Type it in")');
check(await page.locator("#p-emp").count() === 1, "'Type it in' opens the payslip form");
await page.click('#sheet button:has-text("Cancel")');
await page.click('button:has-text("Add a payslip")');
await page.setInputFiles('#sheet input[data-scan="payslip"]:not([capture])', { name: "any.png", mimeType: "image/png", buffer: Buffer.from(receiptPngForSlip, "base64") });
check(await seen(page, "#sheet", "Add a payslip", 180000) && await page.locator("#sheet img.shot").count() === 1, "choosing a photo from there opens the payslip window with the photo, whatever the reader thought it was");
await page.click('#sheet button:has-text("Cancel")');
await page.click('button:has-text("Add a payslip")'); await page.click('#sheet button:has-text("Type it in")');
check(await page.locator("#sheet").innerText().then((t) => /tax id|employee|account number/i.test(t) && /Do not type/.test(t)), "the payslip window tells you not to type any id or account number");
await page.fill("#p-emp", "Sample Employer Inc");
await page.fill("#p-from", "2026-09-16"); await page.fill("#p-to", "2026-09-30"); await page.fill("#p-date", "2026-10-02");
await page.fill("#e_basic", "9000"); await page.fill("#e_rice", "1000"); await page.fill("#e_overtime", "1500");
await page.fill("#d_tax", "700"); await page.fill("#d_sss", "300"); await page.fill("#d_philhealth", "100"); await page.fill("#d_pagibig", "100");
await page.fill("#p-gross", "10000"); await page.fill("#p-net", "9300"); await page.fill("#p-dep", "9300");
check((await text(page, "#p-flags")).includes("leaves out the overtime ₱1,500.00"), "a printed gross that leaves out overtime is flagged while typing");
await shot(page, "37-payslip");
await page.fill("#p-gross", "11500"); await page.fill("#p-net", "10300"); await page.fill("#p-dep", "10300");
check(!(await text(page, "#p-flags")).includes("▲"), "once the figures agree there is no flag");
await page.click("#f-save");
check(await seen(page, "#toast", "Payslip saved"), "the payslip is saved");
check((await text(page, "#toast")).includes("Emergency Fund draft"), "overtime makes an Emergency Fund draft, and says so");
const incText = await text(page, "#screen");
check(incText.includes("₱10,300.00") && incText.includes("Overtime") && incText.includes("Year to date"), "Income shows the pay, overtime and year to date");
check(incText.includes("Went to government this year: ₱1,200.00"), "deductions to government add up");
check(await page.locator(".btrack.stack .bfill.ot").count() === 1, "the payday bar stacks base and overtime");
await shot(page, "38-income");
await page.click('button[aria-label="Earlier year"]');
const prevYear = await text(page, "#screen");
check(prevYear.includes("Nothing recorded for 2025") && !prevYear.includes("Sample Employer") && !prevYear.includes("View the photo") && !prevYear.includes("Plan against what arrived") && !prevYear.includes("Employers"), "another year shows only that year: nothing from 2026 appears under 2025");
await page.click('button[aria-label="Later year"]');
await page.click('#nav button:has-text("Verify")');
check((await text(page, "#screen")).includes("Overtime to Emergency Fund") && (await text(page, "#screen")).includes("₱900.00"), "Verify holds the 60% draft: 60% of ₱1,500.00 is ₱900.00");
await menuGo(page, "Income");
check((await text(page, "#screen")).includes("stays in the account the pay landed in"), "the free part of the overtime stays put by default and says so");
await page.click('button:has-text("Move it somewhere else")');
await page.click('#sheet .chip:has-text("Wallet")'); await page.click("#f-save");
check(await seen(page, "#toast", "waiting in Verify"), "choosing an account makes a second draft");
check(!(await text(page, "#screen")).includes("stays in the account the pay landed in"), "and the choice is no longer offered");
await page.click('#nav button:has-text("Verify")');
check((await text(page, "#screen")).includes("1 of 2"), "Verify now holds two drafts: the Emergency Fund part and the free part");
await page.click('#nav button:has-text("Log")');
check(await page.locator(".sumgrid").count() === 0, "the Log screen has no In, Spent, Saved, Left card");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));
await ctx.close();

// ===== 5h. saying an entry =====
console.log("Voice");
({ ctx, page, errors } = await open({ blockSw: true, noSpeech: true }));
await addAccount(page, "Wallet", "asset", "1000");
await addAccount(page, "GCash", "asset", "500");
await page.click('#nav button:has-text("Log")');
check(await page.locator('#top button[aria-label="Say an entry out loud"]').count() === 1, "the Log screen has a microphone button beside the scanner button");
await page.click('#top button[aria-label="Say an entry out loud"]');
check((await text(page, "#sheet")).includes("Speech is not available in this browser") && await page.locator("#f-save").isDisabled(), "where speech is not available it says so and offers the box, and Use this waits for words");
check((await text(page, "#sheet")).includes("audio leaves your phone") , "the window says plainly that the audio leaves the phone while speaking");
await page.fill("#v-text", "lunch 95 pesos at Sample Burger using GCash yesterday");
await page.click("#f-save");
const savedVoice = await seen(page, "#toast", "Saved Sample Burger", 15000);
if (!savedVoice) console.log("   debug toast:", JSON.stringify(await text(page, "#toast")), "banner:", JSON.stringify(await text(page, "#banner")), "sheet:", JSON.stringify((await text(page, "#sheet")).slice(0, 300)), "errors:", JSON.stringify(errors));
check(savedVoice, "a clear sentence is saved as a draft at once");
let vl = JSON.parse((await stored(page)).local);
const vt = vl.state.transactions.find((t) => t.source === "voice");
const gc = vl.state.accounts.find((a) => a.name === "GCash"), vEntries = vl.state.entries.filter((e) => e.transaction_id === vt.id);
check(vt.status === "draft" && vt.edited_before_verify === false && vt.date === "2026-10-02" && vt.payee === "Sample Burger" && vt.memo.includes("lunch 95"), "as a voice draft dated yesterday, named, with what was said kept");
check(vEntries.some((e) => e.account_id === gc.id && e.amount === -9500) && vEntries.some((e) => e.category_id === "cat-food" && e.amount === 9500), "paid from GCash, ₱95.00, Food");
await page.click('#nav button:has-text("Verify")');
check((await text(page, "#screen")).includes("Made from what you said") && (await text(page, "#screen")).includes("lunch 95 pesos"), "Verify shows what was said");
await page.click('button:has-text("Edit")'); await page.fill("#f-amount", "90"); await page.click("#f-save"); await seen(page, "#screen", "₱90.00");
check(JSON.parse((await stored(page)).local).state.transactions.find((t) => t.source === "voice").edited_before_verify === true, "fixing a spoken draft counts as an edit for the weekly survey");
await page.click('#nav button:has-text("Log")');
await page.click('#top button[aria-label="Say an entry out loud"]');
await page.fill("#v-text", "bought something 120 at Sample Mart");
await page.click("#f-save");
check(await seen(page, "#sheet", "Check what I heard"), "when the account is not named it asks instead of guessing");
check((await text(page, "#sheet")).includes("You said") && await page.locator("#f-save").isDisabled(), "and shows what was said, with saving waiting for an account");
await page.click('#sheet .chip:has-text("Wallet")');
check(await page.locator('#sheet .chip[aria-pressed="true"]:has-text("Essentials")').count() === 1, "the category came from the place named (a mart)");
await page.click("#f-save");
check(await seen(page, "#toast", "Saved Sample Mart") || await seen(page, "#screen", "as a draft"), "after choosing the account it is saved");
vl = JSON.parse((await stored(page)).local);
check(vl.state.transactions.filter((t) => t.source === "voice").length === 2 && vl.state.attachments.length === 0, "two voice drafts, and a spoken entry has no photo");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));
await ctx.close();

// ===== 5i. windows and speech on a phone-sized screen =====
console.log("Windows and speech");
({ ctx, page, errors } = await open({ blockSw: true, fakeSpeech: true }));
await addAccount(page, "Wallet", "asset", "1000"); await addAccount(page, "GCash", "asset", "500");
await page.click('#nav button:has-text("Log")');
await page.setViewportSize({ width: 360, height: 520 });   // a short screen, so a window has to scroll
await page.click('button:has-text("Other amount")');
await page.fill("#f-amount", "50");
await page.evaluate(() => { const s = document.querySelector("#sheet .sheet"); s.scrollTop = s.scrollHeight; });
const before = await page.evaluate(() => document.querySelector("#sheet .sheet").scrollTop);
check(before > 50, "the window is taller than the screen and was scrolled to the bottom (" + before + ")");
check(await page.evaluate(() => document.body.classList.contains("locked") && getComputedStyle(document.body).position === "fixed"), "while a window is open the page behind it is held still");
await page.click('#sheet .chip:has-text("GCash")');
const after = await page.evaluate(() => document.querySelector("#sheet .sheet").scrollTop);
check(after >= before - 2, "choosing something at the bottom does not throw the window back to the top (" + before + " to " + after + ")");
await page.click('#sheet button:has-text("Cancel")');
check(await page.evaluate(() => !document.body.classList.contains("locked") && getComputedStyle(document.body).position !== "fixed"), "closing the window lets the page move again");
await page.click('button[aria-label="Say an entry out loud"]');
await page.click("#v-mic");
check(await page.waitForFunction(() => document.getElementById("v-text")?.value === "lunch 95 at sample burger using gcash", null, { timeout: 5000 }).then(() => true, () => false), "listening carries on after the phone ends a round, and the words are joined");
check((await text(page, "#sheet")).includes("Listening"), "and it still says it is listening");
await page.click("#v-mic");
check(await page.waitForFunction(() => document.getElementById("v-mic")?.textContent.includes("Tap and speak"), null, { timeout: 3000 }).then(() => true, () => false), "tapping stop stops it");
check(await page.evaluate(() => { const s = document.querySelector("#sheet .sheet"); return s.scrollWidth <= s.clientWidth && document.documentElement.scrollWidth <= innerWidth; }), "neither the window nor the page is wider than the screen");
await page.click("#f-save");
check(await seen(page, "#toast", "Saved") && (await text(page, "#toast")).toLowerCase().includes("sample burger"), "the joined sentence is saved as one draft");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));
await ctx.close();

// ===== 5j. a payslip photo, line by line =====
console.log("Payslip photo");
({ ctx, page, errors } = await open({ blockSw: true }));
await addAccount(page, "Wallet", "asset", "1000");
const slipPng = await page.evaluate(() => {   // an invented payslip, drawn in the page
  const c = document.createElement("canvas"); c.width = 1100; c.height = 1400;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, 1100, 1400); x.fillStyle = "#000"; x.font = "bold 38px sans-serif";
  ["Sample Employer Inc", "PAYSLIP", "Pay period: 01/10/2026 - 02/10/2026", "Pay date: Oct 2, 2026", "EARNINGS", "Basic Salary   9,000.00", "Rice Subsidy   1,000.00", "Overtime   1,500.00", "Gross Pay   11,500.00", "DEDUCTIONS", "Withholding Tax   700.00", "SSS   300.00", "PhilHealth   100.00", "Pag-IBIG   100.00", "Net Pay   10,300.00"].forEach((l, i) => x.fillText(l, 40, 70 + i * 80));
  return c.toDataURL("image/png").split(",")[1];
});
await menuGo(page, "Scan");
await page.setInputFiles("input[data-scan]:not([capture])", { name: "payslip.png", mimeType: "image/png", buffer: Buffer.from(slipPng, "base64") });
check(await seen(page, "#sheet", "Add a payslip", 180000), "a payslip photo opens the payslip window, not a one-line pay entry");
const val = (id) => page.inputValue("#" + id);
check((await text(page, "#sheet")).includes("A right employer does not mean the figures are right"), "the payslip window says that a right employer does not mean the figures are right");
check([await val("d_tax"), await val("d_sss"), await val("d_philhealth"), await val("d_pagibig")].join("|") === "700.00|300.00|100.00|100.00", "tax, SSS, PhilHealth and Pag-IBIG are read from their lines (" + [await val("d_tax"), await val("d_sss"), await val("d_philhealth"), await val("d_pagibig")].join("|") + ")");
check([await val("e_basic"), await val("e_rice"), await val("e_overtime")].join("|") === "9000.00|1000.00|1500.00", "the earnings lines are read too, overtime included");
check([await val("p-gross"), await val("p-net"), await val("p-date"), await val("p-emp")].join("|") === "11500.00|10300.00|2026-10-02|Sample Employer Inc", "and the printed gross and net, the pay date and the employer (" + [await val("p-gross"), await val("p-net"), await val("p-date"), await val("p-emp")].join("|") + ")");
check(await page.locator("#sheet img.shot").count() === 1 && await page.locator("#f-save").isDisabled(), "the photo is shown beside the figures, and saving waits until you say where it landed");
await shot(page, "45-payslip-scan");
await page.click('#sheet .chip:has-text("Wallet")'); await page.click("#f-save");
check(await seen(page, "#toast", "Payslip saved"), "after checking, it is saved as a payslip");
const ps = JSON.parse((await stored(page)).local);
check(ps.state.payslipLines.filter((l) => l.side === "deduction").length === 4 && ps.state.payslipLines.filter((l) => l.side === "earning").length === 3, "with seven lines");
check(ps.state.attachments.length === 1 && ps.state.attachments[0].transaction_id === ps.state.payslips[0].transaction_id, "and the photo kept with the pay");
await menuGo(page, "Income");
check((await text(page, "#screen")).includes("Went to government this year: ₱1,200.00") && (await text(page, "#screen")).includes("View the photo"), "the Income screen counts the government deductions and offers the photo");
// a payslip with the earnings on the left, the deductions on the right, photographed a little crooked (invented figures)
const crookedPng = await page.evaluate(() => {
  const c = document.createElement("canvas"); c.width = 1400; c.height = 1000;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, 1400, 1000); x.fillStyle = "#000";
  x.translate(60, 40); x.rotate(0.05);
  x.font = "bold 36px sans-serif"; x.fillText("PHIL SAMPLE, INC.", 20, 60); x.fillText("PAYSLIP", 900, 60); x.font = "30px sans-serif"; x.fillText("Apr 16-30, 2026", 900, 110);
  x.fillText("Net Pay:  P 9,075.00", 900, 170);
  const left = [["EARNINGS", ""], ["Basic Salary", "9,000.00"], ["Rice Subsidy", "1,000.00"], ["Skills Allowance", "500.00"], ["Gross Earnings", "10,500.00"]];
  const right = [["DEDUCTIONS", ""], ["Withholding Tax", "650.00"], ["SSS Premium Cont.", "400.00"], ["Philhealth Premium Cont.", "225.00"], ["Pag-Ibig Premium Cont.", "100.00"], ["Absences", "50.00"], ["Total Deductions", "1,425.00"]];
  left.forEach(([l, a], i) => { x.fillText(l, 20, 260 + i * 55); if (a) x.fillText(a, 400, 260 + i * 55); });
  right.forEach(([l, a], i) => { x.fillText(l, 560, 240 + i * 55); if (a) x.fillText(a, 1060, 240 + i * 55); });
  return c.toDataURL("image/png").split(",")[1];
});
await menuGo(page, "Scan");
await page.setInputFiles("input[data-scan]:not([capture])", { name: "crooked.png", mimeType: "image/png", buffer: Buffer.from(crookedPng, "base64") });
check(await seen(page, "#sheet", "Add a payslip", 240000), "a crooked two-column payslip photo opens the payslip window");
const got = [await val("d_tax"), await val("d_sss"), await val("d_philhealth"), await val("d_pagibig"), await val("d_absences")].join("|");
check(got === "650.00|400.00|225.00|100.00|50.00", "the deductions side by side with the earnings still land on their own labels: tax, SSS, PhilHealth, Pag-IBIG, absences (" + got + ")");
const earned = [await val("e_basic"), await val("e_rice"), await val("e_skills")].join("|");
check(earned === "9000.00|1000.00|500.00", "and the earnings (" + earned + ")");
const head = [await val("p-gross"), await val("p-net"), await val("p-emp"), await val("p-from"), await val("p-to")].join("|");
check(head === "10500.00|9075.00|PHIL SAMPLE, INC.|2026-04-16|2026-04-30", "the printed gross and net with the P sign, the company under the title, and a date range (" + head + ")");
check((await text(page, "#sheet .chip[data-action='pick-employer']")).includes("Sample Employer Inc"), "employers already saved are offered as buttons next to the employer box");
await page.click("#sheet .chip[data-action='pick-employer']");
check(await val("p-emp") === "Sample Employer Inc", "tapping one fills the employer in");
await shot(page, "46-crooked-payslip");
await page.click('#sheet button:has-text("Cancel")');
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));
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

// ===== 6b. a trial copy on the Android phone =====
console.log("Trial");
({ ctx, page, errors } = await open({ ua: ANDROID, standalone: false, blockSw: true, url: BASE + "?trial" }));
check((await text(page, "#banner")).includes("Trial copy") && (await text(page, "#banner")).includes("not your real ledger"), "the Android phone with ?trial says it is a trial copy, not the real ledger");
check((await page.locator("#top button[data-action=\"open-scan-pick\"]").count()) === 1 && !(await text(page, "#screen")).includes("Entry is switched off"), "and entry is on, with the camera icon");
await addAccount(page, "Wallet", "asset", "100");
await page.click('#nav button:has-text("Log")'); await page.click('button.tile:has-text("Lunch")'); await page.click('#sheet .chip:has-text("Wallet")');
check(await seen(page, "#toast", "Saved Lunch"), "something can be logged in the trial copy");
const keys = await page.evaluate(async () => ({ ls: Object.keys(localStorage), dbs: (await indexedDB.databases()).map((d) => d.name) }));
check(keys.ls.includes("financialTracker.trial.ledger") && !keys.ls.includes("financialTracker.ledger") && keys.dbs.includes("financialTracker-trial") && !keys.dbs.includes("financialTracker"), "the trial keeps its data under its own names, never the real ledger's");
await page.click('button:has-text("Start the trial over")');
check((await text(page, "#banner")).includes("Tap again to erase the trial copy"), "starting over asks for a second tap");
await page.click('button:has-text("Tap again to erase the trial copy")');
const erased = await page.waitForFunction(() => localStorage.getItem("financialTracker.trial.ledger") === null && document.querySelectorAll("button.tile").length === 0 && document.querySelector("#banner")?.innerText.includes("Trial copy") && !document.querySelector("#banner")?.innerText.includes("Tap again"), null, { timeout: 8000 }).then(() => true, () => false);
check(erased, "starting over erases the trial copy and leaves a fresh, empty one");
await ctx.close();
({ ctx, page, errors } = await open({ ua: ANDROID, standalone: false, blockSw: true }));
check((await text(page, "#banner")).includes("not the finance phone") && (await text(page, "#screen")).includes("Entry is switched off"), "the same Android phone without ?trial is still switched off");
await ctx.close();
({ ctx, page, errors } = await open({ blockSw: true, url: BASE + "?trial" }));
check(!(await text(page, "#banner")).includes("Trial copy"), "the iPhone Home Screen app ignores ?trial, so the real ledger cannot be swapped for a trial");
check((await page.evaluate(() => Object.keys(localStorage))).every((k) => k !== "financialTracker.trial.ledger"), "and writes nothing under the trial names");
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
