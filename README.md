# Storage Probe

A single-page PWA that answers one question: **does iOS keep a Home Screen web app's saved data over days?**

It stores nothing but timestamps you create by tapping a button. No real data belongs in this repo or in the app.

## How to run the experiment

1. Push to `main`. In the repo, Settings > Pages > Source: **GitHub Actions** (one-time).
2. Open the published URL in Safari on the iPhone, Share > Add to Home Screen.
3. Open it from the Home Screen icon (not Safari) and tap **Record check-in**.
4. Return every day or two. Record the reading before you tap anything.

Safari tab storage and Home Screen app storage are separate on iOS, so only the Home Screen copy tells you what you want to know.

## Files and their logic

**`index.html`** (all CSS and JS inline)
- *Two independent stores.* Each check-in is an ISO timestamp written to both localStorage (one JSON array under one key) and IndexedDB (one record per check-in). They are read back separately, so if iOS evicts one and not the other, you see it.
- *Status line per store.* "holds data (N entries)", "EMPTY", or "unavailable" (read threw an error). EMPTY after earlier check-ins is the eviction signal.
- *Merged history.* The list is the union of both stores keyed by timestamp, oldest first. The `[LI]` tag shows where each entry still exists: `[L-]` means IndexedDB lost it, `[-I]` means localStorage lost it. The first-ever timestamp is the oldest entry in the union, so it survives as long as either store does.
- *Persistence.* `navigator.storage.persist()` asks the browser to exempt this origin from eviction; `persisted()` reports the current state. It runs on load and again after each tap, since some browsers grant only after a user gesture. "denied" is an answer, not a bug.
- *Standalone line.* Confirms you are really running from the Home Screen.

**`manifest.json`** tells iOS the app name, start URL, `standalone` display (no Safari chrome) and icons.

**`sw.js`** is a service worker that caches the shell at install and serves it cache-first, so the app opens offline. It deletes only old caches on update; it never touches localStorage or IndexedDB, so it cannot distort the experiment.

**`icon-180.png`, `icon-512.png`** are plain gray placeholders, required for Home Screen install.

**`.github/workflows/pages.yml`** copies only the five site files into `_site/` and deploys with the official Pages actions on every push to `main` (or manually via "Run workflow"). Staging a folder keeps this README and the workflow itself out of the published site.

## Reading the results

| localStorage | IndexedDB | Meaning |
|---|---|---|
| holds | holds | Nothing evicted yet |
| EMPTY | holds | localStorage evicted, IndexedDB survived |
| holds | EMPTY | the reverse |
| EMPTY | EMPTY | Everything evicted, or the app was removed and re-added |

Changing the service worker cache name or the app's path does not erase data, but changing the **origin** (host or repo name) starts a fresh, empty store.
