# Notes for working on this repo

Personal finance app for one owner. A web app installed to the iPhone Home Screen. The ledger lives ONLY on that
iPhone (local-first, no server, no sync). This repository is PUBLIC: never commit real financial data, screenshots,
payslips, account numbers or balances, and never ship brand logos (account pictures are chosen on the phone).

## Layout and checks
- `src/model/` all money rules, pure and tested. `app/` the screens. `index.html`, `sw.js` at the root only forward to the app and retire the old
  storage probe (the storage test passed Oct 10, 2026).
- Screens: Log and Verify on the bottom bar; everything else is in the menu at the upper left (Cash flow, Cards, Budget with Goals and Pay plan, Scheduled,
  Weekly review with Checks, Scan, Trips, Buffer, Help, Setup; the names live in `src/model/names.js`). The menu is plain icon-and-text rows, no filled highlight.
- Real plan numbers, paydays and account balances live only in the owner's phone (settings and ledger), never in this
  repo, tests or README: tests and examples use invented numbers. Plans are dated and append-only like budgets.
- Bank logos: names and website domains only (`src/model/banks.js`). The phone fetches the logos of ALL listed banks by
  itself (so no service learns which banks the owner uses) and keeps them in its settings; a screenshot chosen on the
  phone wins over them. Logos are never committed.
- Photo scanner: the main reader is PaddleOCR (Apache 2.0) run by ONNX Runtime Web (MIT) from `src/vendor/paddle` (about 30 MB, downloaded once and kept in its own cache `finance-reader-v1` in `app/sw.js`, which a deploy does not delete; rename it if the reader is ever replaced; `app/paddle.js`); `app/ocr.js` falls back to Tesseract if it cannot run. `linesFromBoxes` pairs labels with amounts. Handwriting stays unsupported. Same rule for both: the reader (Apache 2.0) is copied unchanged into `src/vendor/ocr` and served from our own site, so no
  photo ever leaves the phone; never load it from a CDN (a test enforces this). Picture files are kept only on the phone
  (IndexedDB `photos`), never in the ledger text or backup. Never commit a real receipt or payslip image: e2e draws an invented one.
- `npm test` (also runs in CI). `node e2e/run.mjs` (also runs in CI, as the "e2e" job) drives the app in an iPhone-like browser (serve the repo with
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
- SUGGESTION ENGINE (model only, no screen yet): `src/model/suggest.js` builds a suggested plan from payslips, verified spending, subscriptions, scheduled payments (an input list), goals and the ratchet amount (an input). Its ONE settings table, including the starter ratios, is `src/model/suggest-settings.js`; the ratios are used nowhere else and the owner approves them. Lines + unallocated - short equal each payday's income exactly; no line is ever cut.
- NAMES AND DRAWINGS: screen and menu names live ONLY in `src/model/names.js` (menu, bottom bar, Help topics and drawings all read it). Help drawings are pure SVG functions in `src/model/helpart.js` (vertical stacks, 288 wide, theme classes only, no red, one caption each); a topic gets one with its `drawing` field in `help.js`. Data version unchanged.
- HELP: the Help screen (menu, above Setup) reads `src/model/help.js`: the five quick notes (word for word), a getting-started list, and one short topic per screen. When a screen or feature is added or changed, update that file in the same PR (a test fails if a menu screen has no topic). Keep it short, plain, and in our look.

- ROLES, NOT NAMES: never find a goal or a category by its NAME in code, except the bucket word list (see BUCKETS FROM THE NAME), which the owner chose. A goal may hold the role "emergency" (the overtime draft, the Emergency Fund status and messages use it; the owner chooses it on Goals); the month-end sweep follows the setting `sweep_order` ([{goal_id, target?}], the last goal takes the rest). A spending category may hold an old Type out of sight (see BUCKETS FROM THE NAME); the scanner and the voice guess by it. Messages say "Choose which goal is your emergency fund", never a fixed name. Plan lines still match categories and goals by the plan file's own names (the owner's file).
- A goal may have no account yet (it holds nothing until one is chosen). A NEW install is neutral: plain starter categories (Food, Essentials, Transport, Rent, Subscription, Shopping, Health, Fun, Other), no quick tiles, no owner names or amounts in code, tests or Help. Categories can be added and renamed in Setup (a rename keeps the id and role). A brand-new install shows the first-run notice once (`FIRST_RUN_NOTICE` in `src/model/help.js`); Help shows it again on request. Existing ledgers are never reset to these defaults; a migration gives roles to what already exists, once, by the old names.

- BUCKETS FROM THE NAME (owner's design, replaces the visible Type): the screens show no Type and no Role. A spending category's bucket (Needs, Wants, Savings, Other) is READ FROM ITS NAME by `readBucket` in `src/model/bucketwords.js`, the ONE word list (English, Filipino, Taglish, shorthand; whole words, longest match wins, "other" words only when nothing clearer is there). Words that depend on the person (family, padala, utang, loan, credit card, sapatos, gym, pets, gifts) and names with no known word are NOT read: they sit in Other and are asked once with four answers, Need, Want, Savings or Keep in Other. A clear name is set with no tap. Any bucket can be set by hand (settings `bucket_overrides`, which wins). Renaming reads the name again; when that disagrees with a bucket set by hand the owner is asked ("You set this to X. The new name reads as Y."). Rows read "Name · Bucket". Unclear names with a budget are counted in Other with one line, "Includes P[amount] from [n] unconfirmed categories - confirm them". Spending in Savings shows as "Invest in yourself", never part of the emergency fund. The stored `role` field (old Types) is kept, never deleted, and still used out of sight where one kind matters (rent, food, essentials for the Emergency Fund, the scanner, the typed rent), with `guessType` as its fallback; it no longer decides a bucket. `src/model/buckets.js` holds the rules. Targets: ONE table, `bucket_targets`, default 50/30/20 (Warren and Tyagi, All Your Worth, 2005, a rule of thumb, not advice); the starter suggestion reads them, the overrun buffer comes off the top of savings and is its own line, never savings. Buckets are never red.
- SAVINGS AS GOALS: `src/model/savings.js`. Each savings category IS a Goal (a goal may have no account and no target); nothing is stored twice. The only new settings are `goal_monthly` ({goal_id: centavos} the owner typed) and `goal_shares` ({goal_id: basis points}, set once). One rule shares the money set aside, used by the suggestion engine and the Budget screen: typed amounts first, goals with a finish date, the emergency fund until its target, then the other open goals by their percentages (equal when none set); what no goal can take shows as "Savings, not placed yet". "Saved" counts Goals only; the overrun buffer is its own line and never savings. No data version change.

- WHAT'S NEW AND HOW-TOS: every PR that changes what a user sees or does adds ONE plain sentence at the top of `CHANGES` in `src/model/whatsnew.js` (owner: even small fixes). After an update the app shows the latest three once ("Got it"; settings `whatsnew_seen`); Help lists them all. How-to clips (`src/model/howto.js`, motion in app/index.html `hw-*`, Reduce Motion shows the last frame) are drawn from the owner's own screen (tiles, account and picture, date, total), never log anything, use marked examples when there is nothing yet, and have one caption each. Holding a button with `data-howto` plays its clip; quick tiles keep their own hold (arrange). Never a real receipt in a clip.

- IMPORT OLD SPENDING: `src/model/importer.js` (Scan window, "Import old spending"). Reads a notes screenshot (the on-phone reader, lines rebuilt with `linesByRow`), a CSV, or an .xlsx (our own small zip reader and the browser's DecompressionStream: no library, nothing leaves the phone). The date order (day/month or month/day) is decided per file from the dates themselves (a number above 12; else the number that changes is the day; else fewer future dates; else asked). Categories: the file's own category name, then a quick tile of that name, then the kind read from the name, else Unlogged. Lines already logged (same date, name, amount) are left out. Every line becomes a DRAFT (source "import") that waits in Verify; all or nothing.

## LEDGER PAPER (the look; owner approved)
Colours are the CSS variables on `:root` in `app/index.html` (ground, surface, ink, muted, line, track, accent, dashed); screens write no colour of their own. Font: IBM Plex Sans bundled in `app/fonts` with its OFL license, listed in `app/sw.js`, never a network font; money uses the same face with tabular digits. Exactly ONE filled (accent) button per screen; cards are white, 1px line, 14px radius, no shadows, no side stripes. Red only for strictly-over-budget charts. Under a figure use a small picture or sign rather than a sentence. `tests/theme.test.js` enforces this.

## SCHEDULED PAYMENTS (owner's rules)
`src/model/schedules.js`: rows in `schedules` and dated rows in `scheduleChanges` (only ever added to: a new amount, a skip, an end, a paid-off or a payment request is a new row, never an edit). A due payment becomes a DRAFT (id `sch:<schedule>:<key>`, source "template") in Verify on its due day; nothing is auto-confirmed. Ending or deleting stops FUTURE payments only. A payment logged by hand or scanned near a due draft is OFFERED a link, never doubled. An installment counts as spent when verified, in the plan's category (the plan is recorded once). The Shopping default is found by ROLE, never by name. Data version 8.

SUGGESTED SCHEDULES (`src/model/schedulehints.js`): the Scheduled screen offers "Maybe add" from the owner's own history (the same payee in 3 or more of the last 6 months, around the same day, a steady amount or an "about" one) and from the Pay plan (a plan line whose category ROLE is rent, utilities, subscription or debt). Only suggestions: Add opens the usual form filled in and the owner saves it; Not this is remembered (`schedule_hints_dismissed`). Never auto-added.

## PICTURES (owner's rules, data version unchanged)
Pictures live only on the phone. A picture is kept as taken for 3 months, then shrunk once to 1600 px (`src/model/pictures.js`, `app/shrink.js`, setting `photos_shrunk_through`); nothing is deleted. A separate encrypted Pictures file (`src/model/picturebackup.js`, extension .fpics, same passphrase idea, written in parts of about 120 MB that each open on their own) backs them up; restoring adds only the pictures missing on the phone. The photo reader lives in its own cache `finance-reader-v1`.

## CORRECTIONS (owner's rule, data version 9)
A verified entry is FINAL: never edited, never deleted. A mistake in one is put right ONLY at the Weekly review ("Put right a verified entry", entries verified in the last 14 days, `src/model/corrections.js`): a new verified entry (source "correction", `reverses`) cancels it, and a plain expense or a move between accounts (with its fee) also gets a fresh draft (`corrects`) in Verify; income and split purchases are cancelled only. Nothing is rewritten; the old entry shows "cancelled". Scheduled payments, count gaps and corrections cannot be corrected here. The first-run notice, Verify and Help say "final once verified". Drafts stay editable in Verify. Cancelled pairs are left out of the lists unless "Show cancelled" is tapped. An account with entries is never removed; at a zero balance it can be HIDDEN (`archived`, shown again from Setup).

## Every PR message starts with a MERGE CHECK (owner's rule)
The PR message must START with a block titled "MERGE CHECK", exactly these six lines, each answered in one short line:
1. Data version: before -> after (or "unchanged").
2. Fresh encrypted backup needed before merge: YES or NO.
3. New Setup switch, default value: (or "none").
4. Tests: unit count and e2e result.
5. Does anything change for an existing user with the switch off: YES or NO (if YES, what).
6. Help or screen wording the user must read: the exact text, or "none".
Then the rest of the PR message. The "Merge PR n" box stays last.

## One thing at a time (owner's rule)
One open item at a time: finish the current review round and its PR before starting anything else. A new problem that shows up mid-review
(a bug, an idea) is NOT worked on at once: put it in a short "Waiting" list, tell the owner it was noted (one line), and raise it when
the round ends. Only something that loses data or blocks logging may cut the line, and then say so. Keep the Waiting list in the reply,
never more than 5 lines, so the owner always sees what is open.

## How screens are reviewed (the owner's process)
The owner names the screen or section and gives their comments up front (no questionnaire boxes from me). I revise at most 5 items per round, open the PR, and stop. After the owner merges, I add a SHORT list (at most 5 bullets) of things I think need work in that part that they may have overlooked, each one line with the reason; the owner picks which to do. Always end that list with a copy-paste box of one plain number per line ("1", "2", ...; no "DO"), plus a separate "ALL" box, so the owner can keep the lines they want and send them without typing. When two lists are open, prefix the lines with the screen name (for example "INCOME 4"). Likewise end every PR message with a "Merge PR n" copy box. Reviewed so far: Log, the menu, Cash flow (Spending, By category, Budget view), Income, quick tiles, Cards and transfers, Scheduled, the Ledger Paper look. Still open: By account and Trends comments. The build is in cleanup (see HANDOVER.md).
