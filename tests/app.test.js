// Static checks on the app shell: the things that break silently on a phone (a file missing from the
// offline list, a typo'd function name) are caught here instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as M from "../src/model/index.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const sw = read("app/sw.js");
const listed = [...sw.matchAll(/"([^"]+\.(?:js|json|png|html)|\.\/)"/g)].map((m) => m[1]);

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
test("the app code stays free of colour and network calls", () => {
  const css = read("app/index.html");
  for (const hex of css.match(/#[0-9a-fA-F]{3,6}\b/g) ?? []) {
    const h = hex.slice(1), full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    assert.ok(r === g && g === b, hex + " is not a gray");
  }
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|navigator\.sendBeacon/.test(read("app/app.js")), "the app must not talk to a server");
});
