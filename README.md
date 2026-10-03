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

**Menu:** the three-line button at the upper left opens Spending, Budget and Setup (and future items). The bottom bar
holds only Log and Verify; photo and audio capture will join it later.

**Spending tab (charts):** one big number (verified spending this month), then four views: by category,
budgets, paid from (by account), and by month (six columns). Every view has a "Show as list" twin with the same numbers.
Only verified spending counts; unverified drafts are mentioned, not counted. Without budgets every bar is one color;
amounts sit at the bar tip, and tapping a bar states its share in words.

**Pay plan (menu, Overview):** load a plan file (Setup or the Pay plan screen) with your two paydays, each payday's expected income and, per line, what is set aside from each. The app refuses a file unless every payday's lines add up to its expected income exactly, and unless the file declares its `unit`. The 2nd payday can be `"last"` (the last day of the month), so February and 31-day months are right. Plans are dated and append-only, like budgets: a change is a new plan with a later `effective_from`, a saved plan is never edited, and the plan in force on a date is the latest one that has started. The screen shows the plan table and, for the current cutoff (one payday up to the day before the next), what is planned, spent and left per line, using verified spending only. Expense lines are matched to categories by name; anything unmatched is said out loud, not guessed. The plan lives in the phone's settings and in encrypted backups, never in this repository. File shape (invented numbers, whole pesos):

```json
{ "schema_version": 1, "unit": "PHP_whole_pesos", "effective_from": "2026-10-15",
  "paydays": [{"id": "first", "day": 15, "label": "1st payday", "expected_income": 1000},
              {"id": "second", "day": "last", "label": "2nd payday", "expected_income": 2400}],
  "lines": [{"name": "Food", "kind": "expense", "first": 600, "second": 600},
            {"name": "Rent", "kind": "expense", "first": 0, "second": 500},
            {"name": "Apartment Fund", "kind": "goal", "first": 400, "second": 1300}],
  "ef_target_basis": ["Rent", "Food"], "ef_target_months": 3 }
```

`unit` is `PHP_whole_pesos` or `PHP_centavos`. `kind` is `expense` (tracked against the category of the same name), `goal` (savings, matched to a goal by name) or `buffer`. `ef_target_basis` and `ef_target_months` are optional, together: the emergency target is months times the monthly total of the basis lines. Amounts are stored as integer centavos.

**Income variance:** the plan holds planning income (overtime excluded). On the Pay plan screen, "Record pay received" saves what the payslip really said, in pesos and centavos (overtime as its own amount), as a verified entry in an account. The Income table shows plan against received for the last and current cutoff as a signed difference; the plan is never edited to match. The emergency target is always computed from the plan's `ef_target_basis`, never stored.

**Buffer (menu, Overview):** splits one account you choose (a wallet such as GCash, say) into two envelopes the ledger tracks apart (an everyday allowance, and the overrun buffer) without changing what the account holds. Spending from that account takes from the allowance first, then the buffer; the app says how much came out of the buffer and warns when the allowance is empty. The Buffer screen shows what is left, this month's draws by category, a note when one category draws the buffer in more than one month, an "Add to the buffer" top-up, and a month-end sweep (to the Mole Removal goal up to its target, then the Emergency Fund) saved as a draft.

**Spending (menu):** the period at the top ("October 2026 ▾") is a button: it opens a picker for a Month (by year), a whole Year, or a Date range (From and To on our own calendar with month and year arrows, plus This month, Last 30 days and This year). The arrows step a month or a year. Every view follows the period: By category, By account, By month (6 months for a month, 12 for a year, the months of a range); Budgets need a month. Tap the chart itself to flip bars and a donut; a tap shows nothing else.

**Trips (menu, Overview):** a trip is a tag with an optional budget (for example a trip abroad). Switch "Tag new entries with this trip" on and every new entry is tagged, with no extra taps; the Log screen says so and has a Stop link. A trip's page shows verified spending against its budget (graded, with words), spending by category, and unverified spending as a note. Trip spending still counts in the monthly charts like any other spending.

**Checks (menu, Overview):** the card reserve check (reserve balance against what the card owes, pending plus posted, in words: covered or short by how much), the weekly Unlogged chart (what your counts could not explain; a week nobody counted is left out, never shown as zero) and the weekly-questions review by week.

**Goals (menu, Overview):** a goal points at an account where the money really sits, with an optional target and finish date. Balances are hidden until you tap Show balances. "Put money in" saves a draft transfer from another account, counted once you verify it.

**Trend:** under "By month", a line chart of total budget against total actual for six months. A month with nothing budgeted or logged is a gap in the line, never an error or a fake zero. Tap a month to open its budgets.

**Home summary (Log screen):** four plain numbers for a month, with arrows to move between months: IN (pay, refunds, interest, other income), SPENT (expenses at the moment of purchase, including credit card), SAVED (net moved into goals) and LEFT = IN - SPENT - SAVED. Only verified entries count; unverified drafts are counted in words. Moving money between your own accounts is not IN or SPENT, paying the card bill is not SPENT again, and nothing asks you to classify an account.

**Income (menu):** a payslip is copied from paper as lines: employer, pay period, pay date, the account it landed in, earnings (basic, rice, skills, clothing, transportation, overtime with the month it was earned, 13th month, bonus, other) and deductions (tax, SSS, PhilHealth, Pag-IBIG, absences, lates, loans, other). No tax id, employee id or account number is stored or asked for. Four checks FLAG, never fix: gross must equal ALL earnings lines (a printed gross that leaves out overtime is named as such), net must equal gross minus deductions, the net must match what really arrived, and the net in words must match the figures. The pay is saved as one verified entry for what arrived, booked to Overtime (the overtime earned) and Salary (the rest, so deductions fall on base pay). A payslip with overtime also makes a DRAFT in Verify moving 60% of the overtime to the goal named Emergency Fund. The screen shows, for the chosen year: income by source per month and year to date (base, overtime, interest, refunds, other), net pay per payday (base and overtime stacked, with a table beneath), basic pay over time with raises, deductions per month and year to date (government vs pay lost), employers, and the pay plan against what arrived (variance only). Interest, Refund and Other income are income categories added to older ledgers automatically.

**Scan (menu):** take or choose a photo of a store receipt, payslip, GCash or bank screenshot, ride, bill or a written rent receipt. The phone reads it itself with an open-source reader that is part of this site (`src/vendor/ocr`), so the photo is never sent anywhere and no account or service is needed. `src/model/scan.js` turns the words into a guess: the kind of paper, the amount (the Total, not the subtotal, cash or change; the net pay on a payslip), the date (a year more than a year old, or in the future, is flagged and not used), the name, and a category. If the amount is also written in words and disagrees with the figures, it says so. A window shows the photo and the guess; you correct it and save. It is saved as a DRAFT of source "photo" (a payslip becomes a pay-received draft), and Verify shows the photo beside the entry, tap to enlarge. Fixing any field marks the draft as edited (for the survey). The picture files live in their own store on the phone (IndexedDB "photos") and are NOT in the backup file; the ledger only holds an attachment row. Deleting a draft deletes its photo. Handwriting reads poorly and split receipts are not handled yet. The first scan downloads about 7 MB of reader files; after that scanning works offline.

**Check-in (menu, Weekly):** count each account against what the bank or wallet really shows. The app compares it with the ledger and records any gap as a verified Unlogged entry; it never blocks anything. After the first count, three short weekly questions appear (missed transactions are filled in for you, plus ease 1 to 5 and what annoyed you).

**Budgets and thermal colors:** set a monthly budget per category in the Budget screen (a change starts next month).
Bars are graded by how much of the budget is used: green "On track" below 60%, yellow "Getting there" from 60%,
orange "Nearly used up" from 85%, red "Over budget" only when spending is strictly over. Every grade also has a shape
and words, never color alone. A black line marks how far through the month we are.

**Choosing a bank:** in Setup, the Bank button opens a scrollable list: GCash, Maya, GoTyme, MariBank, BDO, BPI, Metrobank, UnionBank, Landbank, Security Bank, Coins.ph, Cash, and "not in the list". Choosing one names the account for you and offers an optional "which part of the bank", so an Emergency Fund kept inside GoTyme becomes "GoTyme · Emergency Fund". Not in the list: leave the tiles alone and type a name. The list is in `src/model/banks.js`. No logos are stored in this repository; a picture chosen once for one account is shared by every account of the same bank, and new accounts of that bank start with it.

**Log screen:** the big centered number is the total for the day being looked at, with no label: today by default. "Select date" (a small link that opens a simple calendar of our own, not the phone's date wheel) turns it into that day's total with the date under it, and the list of entries under the buttons switches to that day too; "Change date" and "Back to today" appear then.

**Bank logos:** loaded by the app itself, for every listed bank at once (so no service learns which banks you use), as soon as the phone has internet, and kept in the phone's settings. It tries the bank's own website icon and a few icon services, refuses generated grey placeholders, and retries a missing one after a week (or "Try again" in the bank list). Any account of that bank, or named after it, shows the logo. A screenshot you add to an account always wins. Maya is the exception: the icon services only return a grey arrow for it, so the app skips them for Maya and finds its logo through its Wikipedia article instead (the only request the app makes, sending just a search phrase from the bank list). If that fails too, Maya's logo is added once from a screenshot. "Remove the picture" in an account's picture window drops a wrong bank logo for good (it is not fetched again).

**Check-in and backup:** the weekly check-in screen carries the backup reminder (when a backup is more than about a week old), and the weekly calendar reminder text mentions it too, so there is one reminder for both.

**Two ways to get a logo:** first the app tries services that allow the picture to be copied (it is then shrunk and kept in the ledger on the phone). Many icon services only allow showing a picture, not copying it; for those the app keeps just the service's address (only a short allow-list of services is accepted) and shows the picture from there, over the letter tile. The app remembers those pictures so they still show offline after the first time, and a real picture you add yourself always replaces the address.

**Generated letter tiles are not logos:** some icon services invent a flat grey tile with a letter when a site has no icon. "Get bank logos" now refuses those, throws away any saved by an earlier version, and retries. For a bank whose site has no usable icon (the failure line says so), add its picture once from a screenshot.

**Wrong logo on an account?** Each account row says "linked to <bank>" when its name does not already say the bank. In the picture window, choosing a bank other than the one the account's name plainly means asks for a second tap, and changing the link drops the old bank's logo, so a mistake can be put right.

**If a logo cannot be downloaded,** the reason is listed under the button for each bank and each icon service (could not be loaded, only a tiny placeholder, not allowed to be copied), so it can be fixed; the screenshot route always works.

**Account pictures:** in Setup, tap an account's tile to choose a picture (a screenshot of the app's icon works),
then zoom and drag to crop it. It is shrunk to 96 pixels and stored inside the account on the phone, so it appears on
every account button, in the charts, and inside your encrypted backup, and never goes anywhere else. No brand logos are
shipped in this repository.

**Rules the screens follow:** nothing blocks logging, nothing is red, over-budget and shortages are
stated once in plain words, and verification is one entry at a time with no "all correct" button.
