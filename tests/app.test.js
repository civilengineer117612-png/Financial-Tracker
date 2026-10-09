// Static checks on the app shell: the things that break silently on a phone (a file missing from the
// offline list, a typo'd function name) are caught here instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as M from "../src/model/index.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const sw = read("app/sw.js");
const filesBlock = sw.slice(sw.indexOf("const FILES = ["), sw.indexOf("];", sw.indexOf("const FILES = [")));   // only the offline list, not other strings in the worker
const listed = [...filesBlock.matchAll(/"([^"]+\.(?:js|json|png|html|woff2|txt)|\.\/)"/g)].map((m) => m[1]);

test("the offline list contains every model file and every app file", () => {
  for (const f of readdirSync(new URL("../src/model/", import.meta.url))) assert.ok(listed.includes("../src/model/" + f), "missing from sw.js: src/model/" + f);
  for (const f of readdirSync(new URL("../app/", import.meta.url)).filter((x) => x !== "sw.js" && x !== "fonts")) assert.ok(listed.includes(f), "missing from sw.js: app/" + f);
  for (const f of readdirSync(new URL("../app/fonts/", import.meta.url))) assert.ok(listed.includes("fonts/" + f), "missing from sw.js: app/fonts/" + f);
});
test("every file in the offline list exists", () => {
  for (const f of listed.filter((x) => x !== "./")) assert.ok(existsSync(new URL("../app/" + f, import.meta.url)), "not found: " + f);
});
test("the worker carries a version placeholder that the deploy replaces", () => {
  assert.match(sw, /const VERSION = "__VERSION__";/);
  assert.match(read(".github/workflows/pages.yml"), /sed -i "s\/__VERSION__\/\$\{GITHUB_SHA::12\}\/" _site\/app\/sw\.js/);
});
test("the deploy publishes the app and the model, and leaves the probe at the root", () => {
  const wf = read(".github/workflows/pages.yml");
  assert.match(wf, /cp -r app\/\* _site\/app\//);
  assert.match(wf, /cp -r src\/model _site\/src\/model/);
  assert.match(wf, /cp index\.html manifest\.json sw\.js icon-180\.png icon-512\.png _site\//);
});
test("the page loads the manifest, the icon and the app script, and each exists", () => {
  const html = read("app/index.html");
  for (const ref of ["manifest.json", "icon-180.png", "app.js"]) { assert.ok(html.includes(ref), ref); assert.ok(existsSync(new URL("../app/" + ref, import.meta.url)), ref); }
  assert.match(html, /type="module" src="app\.js"/);
});
test("the manifest is its own app, separate from the probe", () => {
  const m = JSON.parse(read("app/manifest.json"));
  assert.equal(m.display, "standalone");
  assert.equal(m.scope, "./");
  assert.equal(m.start_url, "./index.html");
  for (const i of m.icons) assert.ok(existsSync(new URL("../app/" + i.src, import.meta.url)), i.src);
  assert.notEqual(m.name, JSON.parse(read("manifest.json")).name);
});
test("everything the app takes from the model is really exported", () => {
  const used = new Set([...read("app/app.js").matchAll(/\bM\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
  assert.ok(used.size > 10);
  for (const name of used) assert.ok(name in M, "app.js uses M." + name + " but the model does not export it");
});
test("Ledger Paper: every colour is a token written once; red is only for over budget; the screens hard-code none", () => {
  const html = read("app/index.html"), css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const TOKENS = { "--ground": "#F5F3EE", "--surface": "#FFFFFF", "--ink": "#1B1D1F", "--muted": "#5C6166", "--line": "#E2DDD3", "--track": "#ECE8DF", "--accent": "#1E5B47", "--dashed": "#A39B8B", "--critical": "#D03B3B" };
  const used = [...(css.match(/#[0-9a-fA-F]{3,6}\b/g) ?? [])].map((h) => h.toUpperCase());
  for (const [name, hex] of Object.entries(TOKENS)) assert.ok(css.includes(name + ": " + hex + ";"), name + " is declared as " + hex);
  for (const hex of new Set(used)) assert.ok(Object.values(TOKENS).includes(hex) || ["#7FB09E", "#4F8C75", "#1E5B47", "#000"].includes(hex), hex + " is not a token");
  for (const hex of Object.values(TOKENS)) assert.ok(used.filter((h) => h === hex).length <= 2, hex + " is written as a token, then used by name");
  assert.match(html, /<meta name="theme-color" content="#F5F3EE">/, "the phone's status bar matches the page");
  assert.ok(!/#[0-9a-fA-F]{6}\b/.test(read("app/app.js")), "the screens' code writes no colour of its own");
  assert.ok(css.includes("--chart: var(--accent)") && css.includes("--paper: var(--surface)") && css.includes("--mid: var(--muted)"), "the older names point at the tokens");
  assert.ok(!/rgba?\(0, ?0, ?0/.test(css), "no stray black shadows or scrims: they are tokens too");
  const js = read("app/app.js");
  assert.ok(!/XMLHttpRequest|WebSocket|navigator\.sendBeacon/.test(js), "the app must not talk to a server");
  // The one exception: looking up a bank's logo on Wikipedia, which sends only a search phrase from the bank list, nothing of the owner's.
  const fetches = js.split("\n").filter((l) => /\bfetch\(/.test(l));
  assert.equal(fetches.length, 1, "exactly one fetch() in the app: " + fetches.length);
  assert.ok(fetches[0].includes("https://en.wikipedia.org/w/api.php") && fetches[0].includes("gsrsearch="), "and it is the Wikipedia logo lookup");
});
test("the bottom bar holds only Log and Verify; everything else is in the menu", () => {
  const js = read("app/app.js");
  assert.match(js, /\$\("nav"\)\.innerHTML = tab\("log", M\.SCREEN_NAMES\.log\) \+ tab\("verify"/);
  assert.ok(!/tab\("(money|setup|budget)"/.test(js), "no menu screen is on the bottom bar");
  assert.match(js, /const MENU = M\.MENU_GROUPS\.map/);
  const menu = readFileSync(new URL("../src/model/names.js", import.meta.url), "utf8").match(/MENU_GROUPS = (\[\[.*\]\]);/)[1];
  for (const id of ["money", "budget"]) assert.ok(menu.includes('"' + id + '"'), id + " is in the menu");
  assert.match(js, /item\("setup", M\.SCREEN_NAMES\.setup\)/, "Setup is pinned at the bottom of the menu");
});

test("the icon lookup asks for 'not found' instead of a placeholder picture when a bank has no icon", () => {
  const js = read("app/app.js");
  const line = js.split("\n").find((l) => l.includes("t2.gstatic.com/faviconV2"));
  assert.ok(line && line.includes("nfrp=2") && !line.includes("fallback_opts"), "the Google icon address must not request a placeholder");
});

test("the photo reader is a set of files of this site, deployed with it, and never loaded from another address", () => {
  const dir = "src/vendor/ocr/";
  for (const f of ["tesseract.min.js", "worker.min.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js", "eng.traineddata.gz", "LICENSE-core.txt"]) assert.ok(existsSync(new URL("../" + dir + f, import.meta.url)), "missing " + dir + f);
  assert.match(read(".github/workflows/pages.yml"), /cp -r src\/vendor _site\/src\/vendor/);
  const ocr = read("app/ocr.js");
  assert.ok(!/https?:\/\//.test(ocr.replace(/\/\/.*$/gm, "")), "ocr.js must not name any other site");
  assert.match(ocr, /new URL\("\.\.\/src\/vendor\/ocr\/", import\.meta\.url\)/);
  assert.ok(!/cdn\.jsdelivr|unpkg|cdnjs/.test(ocr), "no CDN");
});

test("the stronger photo reader is also files of this site, tried first, with the plain reader as the fallback", () => {
  const dir = "src/vendor/paddle/";
  for (const f of ["ch_PP-OCRv4_det_infer.onnx", "ch_PP-OCRv4_rec_infer.onnx", "ppocr_keys_v1.txt", "ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "LICENSE-onnxruntime.txt", "README.md"]) assert.ok(existsSync(new URL("../" + dir + f, import.meta.url)), "missing " + dir + f);
  const paddle = read("app/paddle.js");
  assert.ok(!/https?:\/\//.test(paddle.replace(/\/\/.*$/gm, "")), "paddle.js must not name any other site");
  assert.match(paddle, /new URL\("\.\.\/src\/vendor\/paddle\/", import\.meta\.url\)/);
  assert.ok(!/cdn\.jsdelivr|unpkg|cdnjs/.test(paddle), "no CDN");
  assert.match(read("app/sw.js"), /"paddle\.js"/);
  const ocr = read("app/ocr.js");
  assert.ok(ocr.indexOf('import("./paddle.js")') > 0 && ocr.indexOf("readPlain(blob, progress)") > ocr.indexOf('import("./paddle.js")'), "paddle first, plain reader after");
});

test("windows cannot scroll sideways: the phone's date box is held inside the window", () => {
  const css = read("app/index.html");
  assert.match(css, /\.sheet \{[^}]*overflow-x: hidden/);
  assert.match(css, /input\[type=date\] \{[^}]*appearance: none[^}]*max-width: 100%/);
  assert.match(css, /html \{[^}]*overflow-x: hidden/);
});

test("a window holds the page still behind it and keeps its place when redrawn", () => {
  const css = read("app/index.html"), js = read("app/app.js");
  assert.match(css, /body\.locked \{[^}]*position: fixed[^}]*overflow: hidden/);
  assert.match(js, /function lockPage\(on\)/);
  assert.match(js, /keepAt = lastSheetKey === key/, "the window's scroll position is kept when it is redrawn after a tap");
});
test("listening is one round per tap: no restart loop, no language buttons, the other language is tried by itself", () => {
  const v = read("app/voice.js"), js = read("app/app.js");
  assert.match(v, /rec\.continuous = false/);
  assert.ok(!/begin\(\)/.test(v) && !/setTimeout/.test(v), "an ended recognition is not started again");
  assert.match(v, /export const other = /);
  assert.ok(!js.includes("voice-lang"), "no English/Filipino buttons");
  assert.match(js, /ui\.form\.lang = other\(lang\)/);
});


test("tidy-up: the menu has no one-row groups, the notice has one answer, an empty phone is explained on Log with a Restore button", async () => {
  const js = read("app/app.js"), { MENU_GROUPS } = await import("../src/model/names.js");
  const { menuRows } = await import("../src/model/names.js");
  assert.ok(MENU_GROUPS.length >= 2 && MENU_GROUPS.every(([, ids]) => menuRows(ids).length >= 2), "every menu group shows at least two rows");
  assert.match(js, /const closer = sh\.type === "notice" \? "" :/, "the first-run notice has no Cancel");
  assert.match(js, /device\.status !== "OK" && device\.status !== "EMPTY"/, "an empty phone is not a banner");
  assert.match(js, /device\.status === "EMPTY" \? `<div class="card" id="first-run"><p>\$\{esc\(device\.message\)\}<\/p><p><button data-action="open-restore"/, "it is said on Log, with Restore");
  assert.match(js, /"Spent that day" : "Spent today"/, "the big number says what it is");
  assert.ok(!js.includes('id="menu-backup"'), "the backup line is not repeated in the menu: Log says it when it is due, Setup has the button");
  assert.match(js, /<span>\$\{list\.length\} \$\{list\.length === 1 \? "entry" : "entries"\}<\/span>/, "the folded heading says only how many: the day's total is the big number above");
  assert.match(js, /<span class="sub">\$\{ui\.dayPick && ui\.dayPick !== today\(\) \? "" : esc\(longDate\(today\(\)\)\)\}<\/span>/, "the date is written once: the top date hides when another day is picked");
  assert.match(js, /<span class="mn wn"><small>\$\{esc\(longDate\(c\.date\)\)\}<\/small>/, "a change's date sits on its own line");
  assert.ok(js.includes("downloads the reader (about 30 MB)") && !js.includes("about 7 MB"), "the reader's size is stated once, correctly");
});

test("hubs: screens that belong together share one menu row and a picture strip; Log shows this month at a glance", async () => {
  const { HUBS, hubOf, menuRows, MENU_GROUPS, STRIP_NAMES } = await import("../src/model/names.js");
  const all = MENU_GROUPS.flatMap(([, ids]) => ids);
  assert.deepEqual(menuRows(all), ["money", "cards", "budget", "checkin", "scan", "trips", "buffer"], "the menu shows seven rows");
  for (const [h, ids] of Object.entries(HUBS)) { assert.equal(ids[0], h); for (const id of ids) { assert.equal(hubOf(id), h); assert.ok(STRIP_NAMES[id], id); assert.ok(all.includes(id), id + " still has its Help topic"); } }
  assert.equal(hubOf("cards"), null, "Cards has its own menu row"); assert.equal(hubOf("trips"), null);
  const js = read("app/app.js");
  assert.match(js, /\$\("screen"\)\.innerHTML = hubStrip\(\) \+/, "the strip is drawn on every hub screen");
  assert.match(js, /const current = \(id\) => ui\.tab === id \|\| M\.hubOf\(ui\.tab\) === id \|\| \(id === "money" && ui\.tab === "income"\);/, "the hub's menu row stays marked");
  assert.match(js, /\$\{monthGlance\(\)\}/, "Log shows this month");
  assert.match(js, /\$\{budget > 0 && spent > budget \? `<span class="mc-sub">\$\{glyph\("critical"\)\} \$\{esc\(words\)\}<\/span>` : ""\}<\/button>`;/, "under the bar there are words only when over budget, with their shape");
  assert.ok(js.includes("left of ${peso(budget)}, ${M.showTenths(t)} used"), "the card still says what is left, to a screen reader");
  assert.ok(js.includes("`Over the month's budget by ${peso(spent - budget)}`") && js.includes("`${peso(budget - spent)} left of ${peso(budget)}, ${M.showTenths(t)} used`") && js.includes('"No budget set yet"'), "the card states over, left or no budget in words (read aloud; shown only when over)");
  assert.match(js, /const t = budget > 0 \? M\.tenths\(spent, budget\) : null, w = t === null \? 0 : Math\.min\(100, t \/ 10\);/, "the bar never runs past full");
});

test("signs, folded entries, Budget bars, one date link: money out has a minus, money in a plus; the day's entries are hidden until the heading is tapped", () => {
  const js = read("app/app.js");
  assert.match(js, /const signed = \(d\) => \(d\.kind === "income" \? "\+" : d\.kind === "expense" \|\| d\.kind === "split" \? "\\u2212" : ""\) \+ peso\(d\.amount\);/, "out is minus, in is plus, a move between your accounts has neither");
  assert.match(js, /<div class="amt\$\{d\.kind === "income" \? " in" : ""\}">\$\{signed\(d\)\}<\/div>/, "rows show the sign");
  assert.ok(js.includes('"money in "') && js.includes('"money out "'), "a screen reader hears the direction in words");
  assert.match(js, /<div id="entries-list"\$\{open \? "" : " hidden"\}\$\{anim && open/, "the list is hidden unless opened");
  assert.match(js, /const logOpen = \(\) => \{ try \{ return sessionStorage\.getItem\("logOpen"\) === "1"; \} catch \{ return false; \} \};/, "closed by default, even if storage fails");
  assert.match(js, /case "toggle-entries":/);
  assert.match(js, /pic = \{ log: '<path d="M7 17 17 7M8 7h9v9"\/>'/, "the Log icon is an arrow going out (money out), not a plus");
  assert.ok(js.includes('data-action="open-cal">Select date</button>') && js.includes('<div class="logmeta"><span class="sub">${ui.dayPick && ui.dayPick !== today() ? "" : esc(longDate(today()))}</span>${backupLink}</div>') && !js.includes('class="link topdate"'), "one date link (Select date); the date at the top is plain text");
  assert.match(js, /const sp = Math\.max\(0, r\.st\?\.spent \?\? 0\), t = Math\.min\(1000, M\.tenths\(sp, r\.now\)\);/, "a budget row's bar is spent over budget and never runs past full");
  assert.match(js, /\$\{flow\(true, sp\)\}\$\{M\.showTenths\(t\)\}/, "with the figure written beside it, an arrow standing for spent");
});

test("motion and icons: taps press, bars grow, the folded list drops in only on the tap, everything stops for Reduce Motion; Goals is a flag", () => {
  const js = read("app/app.js"), css = read("app/index.html");
  assert.match(js, /goals: '<path d="M5 21V4M5 4h12l-2\.5 4 2\.5 4H5"\/>'/, "Goals is a flag, not a target");
  assert.match(js, /const anim = ui\.entriesAnim; ui\.entriesAnim = false;/, "only the tap animates, not every redraw");
  assert.match(js, /case "toggle-entries": ui\.entriesAnim = true;/);
  for (const k of ["flipchev", "dropin"]) assert.ok(css.includes("@keyframes " + k + " {"), k);
  assert.match(css, /\.hub button:active, \.glance:active, \.entrieshead:active, \.choice:active \{ transform: scale\(\.99\); \}/, "every tappable thing gives a small press");
  assert.match(css, /-webkit-tap-highlight-color: transparent; touch-action: manipulation;/, "no grey flash, no tap delay");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.chev\.up\.flip, #entries-list\.drop \{ animation: none; \} button \{ transition: none; \} \}/, "Reduce Motion stops the new motion");
  assert.ok(!css.includes("@keyframes growbar") && !css.includes("@keyframes popin"), "bars do not animate while they are measured; nothing pops");
});

test("simple wording: the long notes were cut, and none of the old long sentences is left", () => {
  const js = read("app/app.js");
  for (const old of ["This phone reads the photo itself. The photo is never sent anywhere.", "while you are online. After that it works with no internet", "a backup that only sits on a lost phone is lost too", "Hidden by default so they do not tempt you", "Speech is not available in this browser. Type below, or tap the box"]) assert.ok(!js.includes(old), old);
  const long = [...js.matchAll(/<p class="(?:note|sub)[^"]*"[^>]*>([^<$`]{150,})<\/p>/g)].map((m) => m[1].slice(0, 50));
  assert.deepEqual(long, [], "no plain note is longer than 150 characters");
});

test("one thing, said once: the donut has no second total, Verify states its count once, a strip screen has one visible title", () => {
  const js = read("app/app.js"), css = read("app/index.html");
  assert.ok(!js.includes('class="dtotal"') && !js.includes('class="dsub"'), "the donut's centre does not repeat the headline total");
  assert.match(js, /`\$\{list\.length\} to check`, due \? `\$\{due\} from before today` : "ready whenever you are"/, "Verify says how many once, in the line under the title");
  assert.ok(!js.includes('<p class="note">1 of ${list.length}</p>'), "no second 'n of m'");
  assert.match(js, /\(hub \? `<h1 class="sr">\$\{esc\(title\)\}<\/h1>` : titleOf\(title\)\)/, "on a strip screen the strip names the screen; the title is only read aloud");
  assert.match(css, /\.sr \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect\(0 0 0 0\); white-space: nowrap; \}/);
});

test("polish: a slim bottom bar with a quiet marker, themed focus and selection, clips fade at their loop point and the Verify clip shows its edit", () => {
  const css = read("app/index.html");
  assert.match(css, /#nav button\[aria-current="page"\]::after \{ content: ""; position: absolute; top: 0;/, "the current tab has a small marker, not a filled box");
  assert.match(css, /#nav button \{ position: relative; flex-direction: column; gap: 2px; min-height: 50px;/, "the bar is slim");
  assert.match(css, /padding: max\(12px, env\(safe-area-inset-top\)\) 16px calc\(72px/, "less room kept for the bar");
  assert.match(css, /::selection \{ background: var\(--ink\); color: var\(--paper\); \}/);
  assert.match(css, /\.hw \{ animation: hwLoop 8s infinite linear; \}/, "every clip fades out and in at the loop point");
  assert.match(css, /\.hw-verify \.hw-type \{ border-radius: 8px; animation-name: hwEdit; \}/, "the amount is outlined while it is edited");
  assert.match(css, /\.hw-verify \.hw-card \{ opacity: 1; \} \.hw-verify \.hw-empty \{ opacity: 0; \} \.hw \{ animation: none; \}/, "with Reduce Motion the Verify clip shows the corrected card, not an empty screen");
});

test("polish: the strip matches the bottom bar (marker, no filled box), budget bars span the row, the income figure does not wrap", () => {
  const css = read("app/index.html");
  assert.match(css, /\.hub button\[aria-current="page"\]::after \{ content: ""; position: absolute; bottom: -1px;/);
  assert.match(css, /\.choice > span:first-child \{ flex: 1; min-width: 0; \} \.choice \.meter \{ width: 100%; \}/);
  assert.match(css, /\.card dd\.big \{ font-size: 20px; overflow-wrap: normal; \}/);
});

test("round 3: the Setup form waits behind a button once there are accounts, goals draw a ring, an entry swiped right is marked Correct, long notes fold under Why?", () => {
  const js = read("app/app.js"), css = read("app/index.html"), help = read("src/model/help.js");
  assert.match(js, /const formOpen = ui\.setupAdd \|\| S\(\)\.accounts\.length === 0;/, "a new phone opens on the form; after that it is behind a button");
  assert.match(js, /ui\.setupError = null; ui\.setupAdd = false;/, "adding an account puts the form away");
  assert.match(js, /case "toggle-add-account": ui\.setupAdd = !ui\.setupAdd;/);
  assert.match(js, /const ring = \(pct, label\) => `<svg class="ring"/);
  assert.ok(js.includes("Math.max(0, Math.min(100, pct)) / 100 * 113.1"), "the ring never runs past full or below empty");
  assert.match(js, /\$\{ring\(ef\.percent, ef\.percent \+ "% of the target"\)\}/); assert.match(js, /\$\{ring\(p\.percent, p\.percent \+ "% of the goal"\)\}/);
  assert.ok(!js.includes('aria-label="${p.percent}% of the goal"><span class="fill"'), "no bar left beside the ring");
  assert.match(js, /if \(dx > 90 && Math\.abs\(dy\) < 40 && dx > Math\.abs\(dy\) \* 2\.5\) \{ s0\.c\.querySelector\('button\[data-action="verify-ok"\]'\)\?\.click\(\); \}/, "only a clear swipe to the right counts");
  assert.ok(!js.includes('verify-delete"]\')?.click'), "a swipe never deletes");
  assert.match(help, /Swipe an entry to the right to mark it Correct\./);
  assert.match(js, /const why = \(html, label = "Why\?"\) => `<details class="why"><summary>\$\{label\}<\/summary><p class="note">\$\{html\}<\/p><\/details>`;/);
  assert.ok((js.match(/\$\{why\(/g) ?? []).length >= 4, "the long notes on Budget, Cards, Weekly review and Setup are folded");
  assert.match(css, /\.seg\[aria-label="What to show"\] button\[aria-pressed="true"\]::after/, "Cash flow's views are tabs with a line under the current one");
  assert.match(css, /\.ring \{ width: 64px; height: 64px; flex: none; \}/);
});

test("Setup is a short list of pages and Help runs in a clear order with a small What's new", async () => {
  const js = read("app/app.js"), css = read("app/index.html");
  for (const id of ["accounts", "categories", "budget", "backup", "about"]) assert.ok(js.includes(`["${id}", `), "a Setup row for " + id);
  assert.match(js, /const page = ui\.setupPage && blocks\[ui\.setupPage\] \? ui\.setupPage : null;/);
  assert.match(js, /if \(ui\.tab !== "setup"\) ui\.setupPage = null;/, "leaving Setup returns it to the list");
  assert.match(js, /case "setup-page": ui\.setupPage = el\.dataset\.id \|\| null;/);
  assert.match(js, /data-tab="setup" data-page="accounts">Add accounts/, "Add accounts goes straight to its page");
  assert.match(js, /data-tab="setup" data-page="backup"/, "backup links go straight to the backup page");
  assert.ok(js.includes("const setupFlat = () =>") && js.includes('sessionStorage.getItem("setupFlat") === "1"'), "the one-long-page layout is only for the tests");
  const order = [...js.slice(js.indexOf("function viewHelp()")).matchAll(/<h2>([^<]+)<\/h2>/g)].slice(0, 5).map((m) => m[1]);
  assert.deepEqual(order, ["Start here", "Good to know", "Watch how it works", "Guides", "What's new"], "Help runs in one clear order");
  assert.match(js, /news = all \? M\.CHANGES : M\.CHANGES\.slice\(0, 3\)/, "What's new shows three, and Show all shows the rest");
  assert.ok(!js.includes("<h2>Each screen</h2>") && !js.includes("<h2>How-tos</h2>"), "the vague headings are gone");
  assert.match(css, /\.mn\.wn \{ font-size: 14px; line-height: 1\.35; \}/, "What's new is set in small type");
  assert.match(css, /\.setrow \.st b \{ font-weight: 600; font-size: 16px; \}/);
});

test("pictures and signs instead of little sentences under figures: Cards", () => {
  const js = read("app/app.js");
  for (const gone of ["<span>in your accounts</span>", "<span>owed on cards</span>", "<small>you owe</small>", "<small>in it</small>", "`spent ${peso(m.spent)}`"]) assert.ok(!js.includes(gone), gone + " is gone");
  assert.match(js, /\$\{c\.owe > 0 \? "\\u2212" : ""\}\$\{peso\(c\.owe\)\}<span class="sr"> you owe<\/span>/, "a card's debt has a minus, and a screen reader still hears 'you owe'");
  assert.match(js, /const flow = \(up, amt\) => `<span class="flow">\$\{arrow\(up\)\}<span class="sr">\$\{up \? "spent " : "paid "\}<\/span>\$\{peso\(amt\)\}<\/span>`;/, "an arrow up is spent, an arrow down is paid; both are read aloud");
  assert.match(js, /m\.spent > 0 \? flow\(true, m\.spent\) : ""/, "an account that spent nothing shows nothing");
  assert.match(js, /aria-label="In your accounts \$\{esc\(peso\(o\.held\)\)\}"/); assert.match(js, /aria-label="Owed on cards /);
});
