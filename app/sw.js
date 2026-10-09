// Offline shell. Network first (so a new deploy shows up the next time you are online),
// falling back to the saved copy when offline. Never touches localStorage or IndexedDB.
// __VERSION__ is replaced with the commit id when the site is built, so every deploy
// installs a fresh worker and drops the old cache.
const VERSION = "__VERSION__";
const CACHE = "finance-app-" + VERSION;
const FILES = [
  "./", "index.html", "app.js", "store.js", "ocr.js", "paddle.js", "voice.js", "manifest.json", "icon-180.png", "icon-512.png", "fonts/OFL.txt", "fonts/ibm-plex-sans-latin-400-normal.woff2", "fonts/ibm-plex-sans-latin-500-normal.woff2", "fonts/ibm-plex-sans-latin-600-normal.woff2", "fonts/ibm-plex-sans-latin-ext-400-normal.woff2", "fonts/ibm-plex-sans-latin-ext-500-normal.woff2", "fonts/ibm-plex-sans-latin-ext-600-normal.woff2",
  "../src/model/index.js", "../src/model/util.js", "../src/model/schema.js", "../src/model/balances.js",
  "../src/model/invariants.js", "../src/model/rules.js", "../src/model/ratchet.js", "../src/model/checkin.js",
  "../src/model/buffer.js", "../src/model/templates.js", "../src/model/budget.js", "../src/model/inbox.js",
  "../src/model/goals.js", "../src/model/backup.js", "../src/model/survey.js", "../src/model/device.js",
  "../src/model/reminders.js", "../src/model/money.js", "../src/model/seed.js", "../src/model/drafts.js",
  "../src/model/persist.js", "../src/model/migrate.js", "../src/model/version.js", "../src/model/help.js", "../src/model/names.js", "../src/model/helpart.js", "../src/model/suggest.js", "../src/model/types.js", "../src/model/bucketwords.js", "../src/model/whatsnew.js", "../src/model/tips.js", "../src/model/importer.js", "../src/model/howto.js", "../src/model/buckets.js", "../src/model/savings.js", "../src/model/sinking.js", "../src/model/transfers.js", "../src/model/suggest-settings.js", "../src/model/budgetview.js", "../src/model/planwrite.js", "../src/model/validate.js", "../src/model/reports.js", "../src/model/plan.js", "../src/model/trips.js", "../src/model/banks.js", "../src/model/scan.js", "../src/model/income.js", "../src/model/summary.js", "../src/model/speech.js",
];

self.addEventListener("install", (e) => {
  // "reload" asks the server for every file: the browser's own saved copy (GitHub Pages lets it keep files for ten minutes) could hold the
  // old page next to the new code, which showed new screens with old styling.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))));
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
  const u = new URL(e.request.url);
  // Other sites are never handled, except the few icon services a bank logo may be shown from: those pictures are
  // remembered so the logos still appear offline after the first time.
  const ICON_HOSTS = /^(t[0-3]\.gstatic\.com|www\.google\.com|icons\.duckduckgo\.com)$/;
  const iconRequest = (ICON_HOSTS.test(u.hostname) && (u.pathname === "/faviconV2" || u.pathname === "/s2/favicons" || u.pathname.startsWith("/ip3/"))) || u.pathname === "/apple-touch-icon.png";   // a bank site's own icon
  if (u.origin !== location.origin && !iconRequest) return;
  e.respondWith(
    fetch(e.request, u.origin === location.origin ? { cache: "no-cache" } : undefined)   // same site: always check with the server, never reuse a stale saved copy
      .then((res) => {
        if (res.ok || (iconRequest && res.type === "opaque")) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: u.origin === location.origin }))   // an icon address differs by its query, so it must match exactly
  );
});
