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
  assert.match(js, /\$\("nav"\)\.innerHTML = tab\("log", "Log"\) \+ tab\("verify"/);
  assert.ok(!/tab\("(money|setup|budget)"/.test(js), "no menu screen is on the bottom bar");
  const menu = /const MENU = \[(.*?)\];/s.exec(js)[1];
  for (const id of ["money", "budget"]) assert.ok(menu.includes('"' + id + '"'), id + " is in the menu");
  assert.match(js, /item\("setup", "Setup"\)/, "Setup is pinned at the bottom of the menu");
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

