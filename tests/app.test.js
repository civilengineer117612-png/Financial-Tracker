// Static checks on the app shell: the things that break silently on a phone (a file missing from the
// offline list, a typo'd function name) are caught here instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as M from "../src/model/index.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const sw = read("app/sw.js");
const filesBlock = sw.slice(sw.indexOf("const FILES = ["), sw.indexOf("];", sw.indexOf("const FILES = [")));   // only the offline list, not other strings in the worker
const listed = [...filesBlock.matchAll(/"([^"]+\.(?:js|json|png|html)|\.\/)"/g)].map((m) => m[1]);

test("the offline list contains every model file and every app file", () => {
  for (const f of readdirSync(new URL("../src/model/", import.meta.url))) assert.ok(listed.includes("../src/model/" + f), "missing from sw.js: src/model/" + f);
  for (const f of readdirSync(new URL("../app/", import.meta.url)).filter((x) => x !== "sw.js")) assert.ok(listed.includes(f), "missing from sw.js: app/" + f);
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
  assert.match(wf, /cp app\/\* _site\/app\//);
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
test("the app is black and gray except the chart blue, its shades for the budget grades, and one red, each written once", () => {
  const css = read("app/index.html");
  const TOKENS = { "--chart": "#2a78d6", "--good": "#74abe8", "--warn": "#4f93e0", "--serious": "#1b4f8f", "--critical": "#d03b3b" };
  const used = [...(css.match(/#[0-9a-fA-F]{3,6}\b/g) ?? [])];
  for (const [name, hex] of Object.entries(TOKENS)) {
    assert.ok(css.includes(name + ": " + hex + ";"), name + " is declared as " + hex);
    assert.equal(used.filter((h) => h.toLowerCase() === hex).length, 1, hex + " is written once, as a token, and used by name");
  }
  for (const hex of used) {
    if (Object.values(TOKENS).includes(hex.toLowerCase())) continue;
    const h = hex.slice(1), full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    assert.ok(r === g && g === b, hex + " is not a gray");
  }
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
  assert.match(js, /"spent that day" : "spent today"/, "the big number says what it is");
  assert.ok(!js.includes('id="menu-backup"'), "the backup line is not repeated in the menu: Log says it when it is due, Setup has the button");
  assert.match(js, /<span>\$\{list\.length\} \$\{list\.length === 1 \? "entry" : "entries"\}<\/span>/, "the folded heading says only how many: the day's total is the big number above");
  assert.match(js, /\$\{ui\.dayPick && ui\.dayPick !== today\(\) \? "" : `<p class="sub">/, "the date is written once: the top date hides when another day is picked");
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
  assert.match(js, /budget > 0 \? \(spent > budget \? `Over the month's budget by \$\{peso\(spent - budget\)\}` : `\$\{peso\(budget - spent\)\} left of \$\{peso\(budget\)\}`\)/, "the glance states over or left in words");
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
  assert.match(js, /pic = \{ log: '<path d="M5 12h14"\/>'/, "the Log icon is a minus, not a plus");
  assert.ok(js.includes('data-action="open-cal">Select date</button>') && js.includes('<p class="sub">${esc(longDate(today()))}</p>`}${photoNote}') && !js.includes('class="link topdate"'), "one date link (Select date); the date at the top is plain text");
  assert.match(js, /const sp = Math\.max\(0, r\.st\?\.spent \?\? 0\), t = Math\.min\(1000, M\.tenths\(sp, r\.now\)\);/, "a budget row's bar is spent over budget and never runs past full");
  assert.match(js, /\$\{peso\(sp\)\} spent \\u00b7 \$\{M\.showTenths\(t\)\}/, "with the figure written beside it");
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
