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

# Finance app (`app/`)

The ledger app, separate from the storage probe above. It installs as its own Home Screen app from
`/app/` on the same site; the probe at the site root is untouched.

**How it is organised**
- `src/model/` holds every rule (accounts, drafts, verification, budgets, reserve, backup...). It has no
  screens and no storage, and is covered by `npm test`.
- `app/app.js` draws the screens and handles taps. It only calls the model.
- `app/store.js` is the only file that touches storage. It writes the same text to localStorage and
  IndexedDB, and the model (`persist.js`) notices and repairs a lost or failed store.
- `app/sw.js` makes the app open offline (network first, saved copy as the fallback). The deploy stamps
  it with the commit id so each deploy installs a fresh copy.

**Checks**
- `npm test` runs the logic and static checks (CI runs it on every push).
- `node e2e/run.mjs` drives the app in an iPhone-like browser (setup, logging, undo, verify, edit,
  a lost store, wrong device, offline). Serve the repo first: `python3 -m http.server 8124`.
  It is not part of CI because it needs a browser.

**Backup:** Setup has Back up now and Restore. A backup is one encrypted file (PBKDF2 + AES-GCM, passphrase of at
least 12 characters, never stored) holding every record and the app's settings; on iPhone it opens the share sheet
(Save to Files), elsewhere it downloads. Restore replaces what is on the phone, shows what will be replaced first, and
asks for a second tap. Wrong passphrase, damaged or edited files are refused, and the file's own key-stretching
setting is range-checked.

**Menu:** the three-line button at the upper left opens Money, Budget and Setup (and future items). The bottom bar
holds only Log and Verify; photo and audio capture will join it later.

**Money tab (charts):** one big number (verified spending this month), then four views: where it went (by category),
budgets, paid from (by account), and by month (six columns). Every view has a "Show as list" twin with the same numbers.
Only verified spending counts; unverified drafts are mentioned, not counted. Without budgets every bar is one color;
amounts sit at the bar tip, and tapping a bar states its share in words.

**Pay plan (menu, Overview):** load a small plan file (Setup or the Pay plan screen) with your two paydays and, per line, what to set aside from each. It shows the plan table and, for the current cutoff (from one payday to the day before the next), what is planned, spent and left per line, using verified spending only. Lines are matched to categories by name; an unmatched line is said out loud, not guessed. The plan lives in the phone's settings and in encrypted backups, never in this repository. File shape (invented numbers, pesos):

```json
{ "v": 1,
  "paydays": [{"day": 15, "label": "1st payday"}, {"day": 30, "label": "2nd payday"}],
  "lines": [{"name": "Rent", "first": 0, "second": 5000},
            {"name": "Food", "first": 1500, "second": 2500},
            {"name": "Emergency Fund", "kind": "goal", "first": 500, "second": 500}],
  "essentials": ["Rent", "Food"],
  "emergency_months": 3 }
```

`kind` is `expense` (default) or `goal`. `essentials` names the lines that make up the emergency target (months x their monthly totals).

**Goals (menu, Overview):** a goal points at an account where the money really sits, with an optional target and finish date. Balances are hidden until you tap Show balances. "Put money in" saves a draft transfer from another account, counted once you verify it.

**Trend:** under "By month", a line chart of total budget against total actual for six months. A month with nothing budgeted or logged is a gap in the line, never an error or a fake zero. Tap a month to open its budgets.

**Check-in (menu, Weekly):** count each account against what the bank or wallet really shows. The app compares it with the ledger and records any gap as a verified Unlogged entry; it never blocks anything. After the first count, three short weekly questions appear (missed transactions are filled in for you, plus ease 1 to 5 and what annoyed you).

**Budgets and thermal colors:** set a monthly budget per category in the Budget screen (a change starts next month).
Bars are graded by how much of the budget is used: green "On track" below 60%, yellow "Getting there" from 60%,
orange "Nearly used up" from 85%, red "Over budget" only when spending is strictly over. Every grade also has a shape
and words, never color alone. A black line marks how far through the month we are.

**Account pictures:** in Setup, tap an account's tile to choose a picture (a screenshot of the app's icon works),
then zoom and drag to crop it. It is shrunk to 96 pixels and stored inside the account on the phone, so it appears on
every account button, in the charts, and inside your encrypted backup, and never goes anywhere else. No brand logos are
shipped in this repository.

**Rules the screens follow:** nothing blocks logging, nothing is red, over-budget and shortages are
stated once in plain words, and verification is one entry at a time with no "all correct" button.
