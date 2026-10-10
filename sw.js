// Retired storage-probe worker. It only cleans up after itself: delete the old probe cache, unregister, and send open
// pages on to the app. It never touches the saved ledger.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("storage-probe")).map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((clients) => clients.forEach((c) => c.navigate("app/")))
  );
});
