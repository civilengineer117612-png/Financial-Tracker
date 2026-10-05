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
- A major change: say so, or give a PDF. Calendar and other outward actions need an explicit yes.
- The owner is a VISUAL person: charts and account pictures matter. Charts: one color for a single series, values at the
  bar tip, a list twin for every chart (see the dataviz skill's rules).
- No row tints or group labels (Fixed costs, Everyday spending) in the transaction lists: the owner removed them as pointless. Rows stay plain.
- Tone is firm, never harsh: nothing blocks logging, red appears only on budget charts when a category is strictly over its budget (owner's choice), always with a shape and words, facts are stated once. Verification is one entry at
  a time with no "all correct" button; entries can be verified the day they are logged.

## Friend trial: upgrade safety and Help (owner's rules; friends now use the app)
- Changing the SHAPE of saved data = a data migration. Raise `LEDGER_VERSION` and add the step to `MIGRATIONS` in `src/model/migrate.js`, add a hand-written backup of the old version to `tests/migrate.test.js`, and mutation-check. A migration NEVER deletes or renames a field: add new fields and stop using the old ones (a test enforces it).
- Before a migration runs, the app keeps a copy of the data (the last 2 pre-upgrade copies; Setup shows "Restore the copy from before the last update"). After it, the self-check runs (every transaction's entries sum to zero, the card reserve check computes, totals unchanged). If any step fails the old data stays or the copy is put back, with a plain message. Never leave half-converted data. Restoring a backup keeps the backup's own data version, so it is upgraded (with a copy) on the next start.
- Setup shows the app version and update date (the deploy stamps `src/model/version.js`) and the data format.
- HELP: the Help screen (menu, above Setup) reads `src/model/help.js`: the five quick notes (word for word), a getting-started list, and one short topic per screen. When a screen or feature is added or changed, update that file in the same PR (a test fails if a menu screen has no topic). Keep it short, plain, and in our look.

## One thing at a time (owner's rule)
One open item at a time: finish the current review round and its PR before starting anything else. A new problem that shows up mid-review
(a bug, an idea) is NOT worked on at once: put it in a short "Waiting" list, tell the owner it was noted (one line), and raise it when
the round ends. Only something that loses data or blocks logging may cut the line, and then say so. Keep the Waiting list in the reply,
never more than 5 lines, so the owner always sees what is open.

## How screens are reviewed (the owner's process)
The owner names the screen or section and gives their comments up front (no questionnaire boxes from me). I revise at most 5 items per round, open the PR, and stop. After the owner merges, I add a SHORT list (at most 5 bullets) of things I think need work in that part that they may have overlooked, each one line with the reason; the owner picks which to do. Always end that list with a copy-paste box of one plain number per line ("1", "2", ...; no "DO"), plus a separate "ALL" box, so the owner can keep the lines they want and send them without typing. When two lists are open, prefix the lines with the screen name (for example "INCOME 4"). Likewise end every PR message with a "Merge PR n" copy box. Reviewed so far: Home screen (Log), the menu, Cash flow (Spending, By category, Budget view names, chart/list switch), Income (year label, Other column, Payslips window); Income suggestions 1 to 5 were sent and await the owner's pick. Quick tiles (hold to arrange, move, change, remove, add; category label) are done. Next: the Budget, By account and Trends views, then the other menu screens.
