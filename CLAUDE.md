# Notes for working on this repo

Personal finance app for one owner. A web app installed to the iPhone Home Screen. The ledger lives ONLY on that
iPhone (local-first, no server, no sync). This repository is PUBLIC: never commit real financial data, screenshots,
payslips, account numbers or balances, and never ship brand logos (account pictures are chosen on the phone).

## Layout and checks
- `src/model/` all money rules, pure and tested. `app/` the screens. `index.html`, `sw.js` at the root are the storage
  probe, which must stay untouched while it is still running.
- Screens: Log and Verify on the bottom bar; everything else is in the menu at the upper left (Spending, Income, Budget, Goals,
  Pay plan, Checks, Trips, Buffer, Scan, Check-in, Setup). The menu is plain icon-and-text rows, no filled highlight.
- Real plan numbers, paydays and account balances live only in the owner's phone (settings and ledger), never in this
  repo, tests or README: tests and examples use invented numbers. Plans are dated and append-only like budgets.
- Bank logos: names and website domains only (`src/model/banks.js`). The phone fetches the logos of ALL listed banks by
  itself (so no service learns which banks the owner uses) and keeps them in its settings; a screenshot chosen on the
  phone wins over them. Logos are never committed.
- Photo scanner: the main reader is PaddleOCR (Apache 2.0) run by ONNX Runtime Web (MIT) from `src/vendor/paddle` (about 30 MB, downloaded once, `app/paddle.js`); `app/ocr.js` falls back to Tesseract if it cannot run. `linesFromBoxes` pairs labels with amounts. Handwriting stays unsupported. Same rule for both: the reader (Apache 2.0) is copied unchanged into `src/vendor/ocr` and served from our own site, so no
  photo ever leaves the phone; never load it from a CDN (a test enforces this). Picture files are kept only on the phone
  (IndexedDB `photos`), never in the ledger text or backup. Never commit a real receipt or payslip image: e2e draws an invented one.
- `npm test` (also runs in CI). `node e2e/run.mjs` drives the app in an iPhone-like browser (serve the repo with
  `python3 -m http.server 8124` first). A new file under `src/model/` must also be added to the list in `app/sw.js`;
  a test enforces it.
- After writing a check, break the code on purpose and confirm the check fails (mutation check).
- Deploys happen on merge to `main` (GitHub Pages). Merge only when the owner asks.

## How the owner wants to work
- FIXED DECISION (owner, no budget): the app stays free. Never add a paid or AI service, an API key, or a button that sends a
  photo, text or audio to a paid service (no "Read with AI"). Reading photos stays the free on-phone reader; handwriting reading
  poorly is accepted. The only outside talk allowed is the free lookups already there (bank logos, the phone's own speech-to-text).
  Do not offer or re-ask this; if a task seems to need it, say so and stop.
- Keep building without asking. Ask only when an answer changes how the app behaves or needs the owner's own
  experience. Put questions in ONE copy-paste box, at most 4, each with an `ANSWER:` line, and no recommendation under
  a question. Keep replies short and in plain words; no jargon without a one-line explanation.
- Screen-by-screen review: the owner reviews one screen at a time from a text summary (Home screen first, then the menu screens). Revise at most 5 items per round, then stop and report; the rest wait for the next round.
- A major change: say so, or give a PDF. Calendar and other outward actions need an explicit yes.
- The owner is a VISUAL person: charts and account pictures matter. Charts: one color for a single series, values at the
  bar tip, a list twin for every chart (see the dataviz skill's rules).
- No row tints or group labels (Fixed costs, Everyday spending) in the transaction lists: the owner removed them as pointless. Rows stay plain.
- Tone is firm, never harsh: nothing blocks logging, red appears only on budget charts when a category is strictly over its budget (owner's choice), always with a shape and words, facts are stated once. Verification is one entry at
  a time with no "all correct" button; entries can be verified the day they are logged.

## Screen-by-screen review (in progress)
The owner reviews one screen at a time from a text summary and writes a RATING (KEEP / CHANGE / REMOVE) and a COMMENT per item. Revise at most 5 items per round, then stop and report; the rest wait for the next round. After the Home screen come the menu screens, one at a time.

### PART 1 OF N: HOME SCREEN (LOG) - assessment (the owner's ratings and comments are added in chat)
1. TOP BAR: menu button (three lines) at the left, the title "Log", then a microphone button and a scanner button at the right, both black squares with a white icon. They are the most eye-catching thing, which fits (fastest ways to log), but microphone and scanner look alike at a glance.
2. TRIAL BANNER (Android trial copy only): a boxed note saying this is not the real ledger, with "Start the trial over". Long, takes space at the top; never shows on the iPhone.
3. NOTES UNDER THE TITLE (only when needed): the date, then one-line notes: photos waiting to be read, entries from before today that need verifying, "No backup yet" or "Last backup N days ago", "Tagging new entries: [trip]". Useful, but they stack as plain links and none looks more urgent; the backup note appears often.
4. THE BIG NUMBER (the day's total) AND "Select date": a very large peso figure for the day being looked at (today by default); under it a small underlined "Select date" (or "Change date" and "Back to today"). Clear, but it does not say what it counts ("spent today"), and "including N not yet verified" is only in the hidden screen-reader text.
5. QUICK TILES (Breakfast, Lunch, Dinner with fixed amounts): grey tiles; tapping one asks which account paid, then saves a draft. Fastest way to log a common meal; only useful if the presets match what is really bought (editing them from this screen is unconfirmed).
6. "Other amount" BUTTON: wide black button that opens the window for any amount. The main action, and it looks like one.
7. TODAY LIST: under "TODAY", one row per entry (name, amount; under the name the account picture, the account, "draft" or "verified"); tapping a row opens its details, with "See the photo" for photo entries. Rows are plain as asked; how an entry was made (typed, photo, voice) is not visible without opening it; a long list pushes the bottom bar out of reach.
8. BOTTOM BAR (Log and Verify): two wide buttons, Log (black when active) and Verify (count badge when entries wait). Simple and thumb-reachable; everything else is behind the menu button, so a first-time user may not find Budget, Income or Spending.
9. SIZES AND SPACING: body 16 px, big total about 56 px, tile names bold, notes grey. The hierarchy is right (total, actions, list); the top notes compete with the total when several show.
10. ANYTHING MISSING OR ELSE: left to the owner.
