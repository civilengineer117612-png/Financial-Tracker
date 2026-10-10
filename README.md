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


---
---

# Finance app (`app/`)

A personal finance app for one owner, installed to the phone's Home Screen from `/app/` on the same site (the
probe at the site root is untouched). The ledger lives only on that phone: no server, no sync, no account, no paid
or AI service. This repository is public, so it holds no real money data, screenshots or brand logos.

**What it does**
- Log (bottom bar): type or speak an entry, quick tiles, photo scan. Verify (bottom bar): check entries one at a time.
- Menu (upper left): Cash flow (spending by category, income, trends), Cards (where the money is, moving money between
  accounts), Budget (with Goals and the Pay plan), Scheduled (repeating payments and installments), Trips, Buffer,
  Weekly review (with Checks), Scan, Help, Setup.
- Transfers keep a fee and a foreign amount; accounts can carry a last 4 digits so a scanned transfer finds its account.
- Scheduled payments become drafts in Verify on their due day; nothing is confirmed by itself.
- Photos are read on the phone (PaddleOCR, Tesseract as fallback, both served from this site). No photo leaves it.
- The look is "Ledger Paper": colours are variables on `:root` in `app/index.html`, IBM Plex Sans is bundled in `app/fonts`.

**How it is organised**
- `src/model/` holds every money rule. Pure, no screens, no storage, covered by `npm test`.
- `app/app.js` draws the screens and handles taps. It only calls the model.
- `app/store.js` is the only file that touches storage (localStorage and IndexedDB, repaired by `src/model/persist.js`).
- `app/sw.js` makes the app open offline. A new file under `src/model/` must be listed there (a test enforces it).
- The saved data has a version (now 8). A change of its shape is a migration in `src/model/migrate.js`: additive only,
  with a copy kept before it runs and a self-check after it. See `HANDOVER.md`.

**Checks**
- `npm test` runs the logic and static checks (CI "test" job).
- `node e2e/run.mjs` drives the app in an iPhone-like browser; serve the repo first with `python3 -m http.server 8124`
  (CI "e2e" job, about 10 minutes).

**Backup:** Setup has Back up now and Restore. A backup is one encrypted file (PBKDF2 + AES-GCM, passphrase of at least
12 characters, never stored). Restore shows what will be replaced and asks for a second tap; a wrong passphrase or a
damaged file is refused. Setup also keeps the last 2 copies from before an update.

**Deploy:** merging to `main` publishes to GitHub Pages (`.github/workflows/pages.yml`). The deploy stamps the version
and the offline cache name. `CLAUDE.md` holds the owner's working rules.
