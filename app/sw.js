// Offline shell. Network first (so a new deploy shows up the next time you are online),
// falling back to the saved copy when offline. Never touches localStorage or IndexedDB.
// __VERSION__ is replaced with the commit id when the site is built, so every deploy
// installs a fresh worker and drops the old cache.
const VERSION = "__VERSION__";
const CACHE = "finance-app-" + VERSION;
const FILES = [
  "./", "index.html", "app.js", "store.js", "manifest.json", "icon-180.png", "icon-512.png",
  "../src/model/index.js", "../src/model/util.js", "../src/model/schema.js", "../src/model/balances.js",
  "../src/model/invariants.js", "../src/model/rules.js", "../src/model/ratchet.js", "../src/model/checkin.js",
  "../src/model/buffer.js", "../src/model/templates.js", "../src/model/budget.js", "../src/model/inbox.js",
  "../src/model/goals.js", "../src/model/backup.js", "../src/model/survey.js", "../src/model/device.js",
  "../src/model/reminders.js", "../src/model/money.js", "../src/model/seed.js", "../src/model/drafts.js",
  "../src/model/persist.js", "../src/model/validate.js", "../src/model/reports.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
