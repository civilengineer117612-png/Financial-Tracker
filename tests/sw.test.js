import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Runs the real app/sw.js against stand-ins for the browser's cache, so what it keeps and what it deletes is proved, not read off the page.
const src = readFileSync(new URL("../app/sw.js", import.meta.url), "utf8").replace('"__VERSION__"', '"v-new"');
function boot(existing = {}) {
  const handlers = {}, stores = new Map(Object.entries(existing).map(([k, v]) => [k, new Map(Object.entries(v))])), calls = { fetch: [], deleted: [] };
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (k) => { calls.deleted.push(k); return stores.delete(k); },
    open: async (k) => { if (!stores.has(k)) stores.set(k, new Map()); const m = stores.get(k); return { match: async (r) => m.get(r.url ?? r), put: async (r, res) => { m.set(r.url ?? r, res); }, addAll: async () => {} }; },
    match: async (r) => { for (const m of stores.values()) if (m.has(r.url ?? r)) return m.get(r.url ?? r); },
  };
  const self = { addEventListener: (n, f) => { handlers[n] = f; }, skipWaiting() {}, clients: { claim: async () => {} }, location: { origin: "https://x.test" } };
  const fetchStub = async (r) => { calls.fetch.push(r.url); return { ok: true, status: 200, clone() { return this; }, type: "basic", body: "file" }; };
  vm.runInNewContext(src, { self, caches, location: self.location, fetch: fetchStub, URL, Request: class { constructor(u) { this.url = u; } } });
  return { handlers, stores, calls };
}
const request = (url, range = false) => ({ url, method: "GET", headers: { has: (h) => range && h === "range" } });
const ask = async (h, url, range) => { let p; h.fetch({ request: request(url, range), respondWith: (x) => { p = x; } }); return p; };

test("a deploy deletes the old app caches but keeps the photo reader's cache", async () => {
  const { handlers, stores, calls } = boot({ "finance-app-old": {}, "finance-app-v-new": {}, "finance-reader-v1": { "https://x.test/src/vendor/paddle/a.onnx": "kept" }, "storage-probe-v1": {} });
  let done; handlers.activate({ waitUntil: (p) => { done = p; } }); await done;
  assert.deepEqual(calls.deleted.sort(), ["finance-app-old", "storage-probe-v1"]);
  assert.ok(stores.has("finance-reader-v1") && stores.get("finance-reader-v1").size === 1 && stores.has("finance-app-v-new"));
});

test("the reader is downloaded once and then served from the phone; other files still check the server", async () => {
  const { handlers, calls } = boot();
  const url = "https://x.test/src/vendor/paddle/ch_det.onnx";
  await ask(handlers, url); await ask(handlers, url); await ask(handlers, url);
  assert.equal(calls.fetch.filter((u) => u === url).length, 1, "one download, then the saved copy");
  const page = "https://x.test/app/app.js";
  await ask(handlers, page); await ask(handlers, page);
  assert.equal(calls.fetch.filter((u) => u === page).length, 2, "app files are still checked every time");
});

test("a partial (range) request for the reader never reaches the reader cache", async () => {
  const { handlers, stores } = boot();
  await ask(handlers, "https://x.test/src/vendor/paddle/part.onnx", true);
  assert.ok(!stores.has("finance-reader-v1") || stores.get("finance-reader-v1").size === 0, "half a file is never saved as the whole");
});
