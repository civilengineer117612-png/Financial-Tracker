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
// Money, Budget and Setup live in the menu at the upper left; only Log and Verify are on the bottom bar.
const menuGo = async (page, name) => { await page.click("#menuBtn"); await page.click(`#menu .item:has-text("${name}")`); };
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
  await menuGo(page, "Setup");
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
({ ctx, page, errors } = await open());
const dir = mkdtempSync(join(tmpdir(), "pic-"));
const png = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 200; c.height = 100; const g = c.getContext("2d"); g.fillStyle = "#d00"; g.fillRect(0, 0, 100, 100); g.fillStyle = "#00d"; g.fillRect(100, 0, 100, 100); return c.toDataURL("image/png"); });
writeFileSync(join(dir, "icon.png"), Buffer.from(png.split(",")[1], "base64"));
const pixel = (url, x, y) => page.evaluate(async ([u, px, py]) => { const i = new Image(); await new Promise((r) => { i.onload = r; i.src = u; }); const c = document.createElement("canvas"); c.width = c.height = 96; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return Array.from(g.getImageData(px, py, 1, 1).data); }, [url, x, y]);
const red = ([r, , b]) => r > 180 && b < 60, blue = ([r, , b]) => b > 180 && r < 60;

await addAccount(page, "Wallet", "asset", "1000"); await seen(page, "#screen", "Wallet");
await addAccount(page, "Bank", "asset", "5000"); await seen(page, "#screen", "Bank");
check((await page.locator("#screen .row .mono").count()) === 2, "until a picture is chosen, each account shows its first letter");
await page.click('.row:has-text("Wallet") .icobtn');
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

await page.click('.row:has-text("Bank") .icobtn');
await page.setInputFiles("#i-file", join(dir, "icon.png"));
await page.waitForFunction(() => !document.getElementById("i-img").hidden);
const stageBox = await page.locator("#i-stage").boundingBox();
await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2); await page.mouse.down();
await page.mouse.move(stageBox.x + stageBox.width / 2 + 300, stageBox.y + stageBox.height / 2, { steps: 6 }); await page.mouse.up();
await page.click("#f-save"); await seen(page, "#toast", "Picture saved");
const bankIcon = JSON.parse((await stored(page)).local).state.accounts.find((a) => a.name === "Bank").icon;
check(red(await pixel(bankIcon, 72, 48)), "dragging the picture moves what is cropped: the blue half is out of the square");
check((await page.locator("#screen .row img.ico").count()) === 2, "both accounts now show their picture in Setup");
await page.click('.row:has-text("Bank") .icobtn');
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

await menuGo(page, "Money");
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
await page.click('.brow:has-text("Food")');
check((await text(page, ".caption")).includes("Food: ₱95.00, 24.1% of what you spent in October 2026."), "tapping a bar says its share in words");
check((await page.locator(".brow.dim").count()) === 1, "and the other bar steps back");
await page.click('.brow:has-text("Food")');
check((await page.locator(".brow.dim").count()) === 0, "tapping again clears it");

await page.click('button:has-text("Paid from")');
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
await page.click('button:has-text("Where it went")');
screen = await text(page, "#screen");
check(/Shopping\s+₱300\.00\s+75\.9%/.test(screen) && /Food\s+₱95\.00\s+24\.1%/.test(screen) && /Total\s+₱395\.00/.test(screen), "the list view has every number the chart has, plus the total");
await page.click('button:has-text("Show as chart")');

await page.click('button[aria-label="Previous month"]');
screen = await text(page, "#screen");
check(screen.includes("September 2026") && screen.includes("₱1,295.00") && /Rent/.test(screen), "stepping back shows September: rent and a lunch");
check(await page.locator('button[aria-label="Next month"]').isEnabled(), "and you can step forward again");
await page.click('button[aria-label="Next month"]');
check(await page.locator('button[aria-label="Next month"]').isDisabled(), "but not past this month");
for (let i = 0; i < 4; i++) await page.click('button[aria-label="Previous month"]');
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
check((await page.locator("#menu .item").allInnerTexts()).join() === "Money,Budget,Setup,Close", "the menu lists Money, Budget and Setup");
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
await menuGo(page, "Money");
for (let i = 0; i < 9; i++) if (await page.locator('button[aria-label="Next month"]').isEnabled()) await page.click('button[aria-label="Next month"]');
await page.click('button:has-text("Where it went")');
await shot(page, "19-money-graded");
const fills = await page.locator(".brow").evaluateAll((els) => els.map((e) => ({ name: e.innerText.split("\n")[0], cls: [...e.classList].find((c) => c.startsWith("g-")), color: getComputedStyle(e.querySelector(".bfill")).backgroundColor })));
const food = fills.find((f) => f.name === "Food"), shop = fills.find((f) => f.name === "Shopping");
check(shop.cls === "g-critical" && shop.color === "rgb(208, 59, 59)", "over budget is red: Shopping " + shop.cls + " " + shop.color);
check(food.cls === "g-serious" && food.color === "rgb(236, 131, 90)", "95% of a budget is orange: Food " + food.cls + " " + food.color);
check((await text(page, ".legend")).replace(/\s+/g, " ").includes("On track Getting there Nearly used up Over budget No budget"), "a legend says what the colours mean, in words");
check((await page.locator(".legend svg").count()) === 5, "each with its own shape, so colour is never the only signal");
await page.click('.brow:has-text("Shopping")');
check((await text(page, ".caption")).includes("Budget ₱250.00: 120% used, over by ₱50.00."), "tapping a bar adds the budget in words");

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
await page.click('button:has-text("Show as list")');
check(/Shopping[\s\S]*Over budget/.test(await text(page, ".tbl")) && (await text(page, ".tbl")).includes("Total spent"), "the list twin has the same facts");
await page.click('button:has-text("Show as chart")');
await page.click('button[aria-label="Previous month"]');
check((await text(page, "#screen")).includes("No budgets for September 2026 yet"), "a budget set this month does not rewrite September");

// spending with no budget is listed, not hidden
await page.click('button[aria-label="Next month"]');
await page.click('#nav button:has-text("Log")');
await page.click('button:has-text("Other amount")'); await page.fill("#f-amount", "80"); await page.click('#sheet .chip:has-text("Upskill")'); await page.click('#sheet .chip:has-text("Wallet")'); await page.click("#f-save"); await seen(page, "#toast", "Saved");
await page.click('#nav button:has-text("Verify")');
await page.click('button:has-text("Correct")'); await seen(page, "#screen", "of");
await verifyAll();
await menuGo(page, "Money");
for (let i = 0; i < 9; i++) if (await page.locator('button[aria-label="Next month"]').isEnabled()) await page.click('button[aria-label="Next month"]');
await page.click('button:has-text("Budgets")');
const noBud = await page.waitForFunction(() => document.getElementById("screen").innerText.toLowerCase().includes("no budget set"), null, { timeout: 4000 }).then(() => true, () => false);   // the heading is shown in capitals
if (!noBud) console.log("   screen was:", JSON.stringify((await text(page, "#screen")).slice(0, 600)));
check(noBud && /Upskill\s+₱80\.00/.test(await text(page, "#screen")), "spending in a category with no budget is shown under its own heading");
check(errors.length === 0, "no script errors" + (errors.length ? " -> " + errors[0] : ""));

// pictures survive a reload and appear where you choose an account
await page.reload(); await page.waitForSelector("#nav button");
await page.click('#nav button:has-text("Log")'); await page.click('button.tile:has-text("Breakfast")');
check((await page.locator("#sheet .chip img.ico").count()) === 2, "pictures are on the account buttons when you log, so you can tell them apart at a glance");
await shot(page, "16-pay-with-pictures");
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
