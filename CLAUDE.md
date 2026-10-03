# Notes for working on this repo

Personal finance app for one owner. A web app installed to the iPhone Home Screen. The ledger lives ONLY on that
iPhone (local-first, no server, no sync). This repository is PUBLIC: never commit real financial data, screenshots,
payslips, account numbers or balances, and never ship brand logos (account pictures are chosen on the phone).

## Layout and checks
- `src/model/` all money rules, pure and tested. `app/` the screens. `index.html`, `sw.js` at the root are the storage
  probe, which must stay untouched while it is still running.
- Screens: Log and Verify on the bottom bar; everything else is in the menu at the upper left (Money, Budget, Goals,
  Pay plan, Checks, Trips, Buffer, Check-in, Setup). The menu is plain icon-and-text rows, no filled highlight.
- Real plan numbers, paydays and account balances live only in the owner's phone (settings and ledger), never in this
  repo, tests or README: tests and examples use invented numbers. Plans are dated and append-only like budgets.
- Bank logos: names and website domains only (`src/model/banks.js`). The phone fetches the logos of ALL listed banks by
  itself (so no service learns which banks the owner uses) and keeps them in its settings; a screenshot chosen on the
  phone wins over them. Logos are never committed.
- `npm test` (also runs in CI). `node e2e/run.mjs` drives the app in an iPhone-like browser (serve the repo with
  `python3 -m http.server 8124` first). A new file under `src/model/` must also be added to the list in `app/sw.js`;
  a test enforces it.
- After writing a check, break the code on purpose and confirm the check fails (mutation check).
- Deploys happen on merge to `main` (GitHub Pages). Merge only when the owner asks.

## How the owner wants to work
- Keep building without asking. Ask only when an answer changes how the app behaves or needs the owner's own
  experience. Put questions in ONE copy-paste box, at most 4, each with an `ANSWER:` line, and no recommendation under
  a question. Keep replies short and in plain words; no jargon without a one-line explanation.
- A major change: say so, or give a PDF. Calendar and other outward actions need an explicit yes.
- The owner is a VISUAL person: charts and account pictures matter. Charts: one color for a single series, values at the
  bar tip, a list twin for every chart (see the dataviz skill's rules).
- Tone is firm, never harsh: nothing blocks logging, red appears only on budget charts when a category is strictly over its budget (owner's choice), always with a shape and words, facts are stated once. Verification is one entry at
  a time with no "all correct" button; entries can be verified the day they are logged.
