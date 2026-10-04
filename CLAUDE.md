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
The owner reviews one screen at a time. Every copy-paste review box I give has at most 5 items (10 was overwhelming), each with a short plain assessment, a RATING line (KEEP / CHANGE / REMOVE) and a COMMENT line. Revise at most 5 items per round, then stop and report. Order: Home screen (Log) first, then the menu screens one at a time.
Progress: Home screen, box 1 (top bar, notes under the title, the day's big number, quick tiles, Other amount) sent. Box 2 still to send (Today list, bottom bar, sizes and spacing, trial banner, anything missing).
