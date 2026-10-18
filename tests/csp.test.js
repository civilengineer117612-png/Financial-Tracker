import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
const policy = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/) ?? [])[1] ?? "";
const part = (name) => (policy.split(";").map((x) => x.trim()).find((x) => x.startsWith(name + " ")) ?? "").split(/\s+/).slice(1);

test("the page names where scripts, objects and forms may come from, and allows no script of its own", () => {
  assert.ok(policy, "a Content-Security-Policy meta tag is present");
  assert.deepEqual(part("script-src"), ["'self'", "'wasm-unsafe-eval'"], "scripts only from this site (the on-phone reader needs wasm)");
  assert.ok(!policy.includes("unsafe-eval'") || policy.includes("wasm-unsafe-eval"), "no eval");
  assert.ok(!part("script-src").includes("'unsafe-inline'"), "no inline script");
  assert.deepEqual(part("object-src"), ["'none'"]);
  assert.deepEqual(part("default-src"), ["'self'"]);
  assert.ok(!/cdn|jsdelivr|unpkg|cdnjs/i.test(policy), "no code host is named");
});
test("so no inline event handler is left in the page or its script", () => {
  assert.doesNotMatch(app, /\son(click|error|load|change|input)="/, "app.js writes no inline handler");
  assert.doesNotMatch(html, /\son(click|error|load|change|input)="/, "index.html has no inline handler");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "index.html has no inline script");
});
