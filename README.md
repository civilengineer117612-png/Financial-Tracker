# Financial Tracker

The storage test (Oct 2 to Oct 10, 2026) passed: the data survived on the phone in both localStorage and IndexedDB, persistent
storage was granted, and the app ran from the Home Screen. The site root now only forwards to `/app/`.

---

# Finance app (`app/`)

A personal finance app for one owner, installed to the phone's Home Screen from `/app/` on the same site (the
site root forwards there). The ledger lives only on that phone: no server, no sync, no account, no paid
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
