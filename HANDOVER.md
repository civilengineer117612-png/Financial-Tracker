# Hand-over

## What is built
Log, Verify, Cash flow, Cards (with transfers), Budget (Goals, Pay plan), Scheduled payments, Trips, Buffer, Weekly
review (Checks), Scan and import of old spending, Help, Setup, encrypted backup and restore, safe data upgrades
(data version 9), the Ledger Paper look. Rules for all of it are in `CLAUDE.md`; the model is in `src/model/`.

## What is parked
- Scheduled paydays / expected payslips: the owner said no.
- Suggested schedules (from history or the Pay plan): waiting for the owner's pick.
- Savings ratchet screen, money owed to me, CSV export: ideas only.
- By account and Trends views: owner's comments pending.

## Back up and restore
Setup > Back up now makes one encrypted file (keep the passphrase: it cannot be recovered). Setup > Restore replaces the
phone's data after showing what changes. Before every data upgrade the app keeps a copy; Setup > "Restore the copy from
before the last update" puts it back. Take a fresh backup before merging any change that raises the data version.

## How a change reaches the phone
1. Work on a branch, run `npm test` and `node e2e/run.mjs`, open a PR. CI runs "test" and "e2e".
2. The owner merges (only when asked). `.github/workflows/pages.yml` publishes to GitHub Pages.
3. The phone loads the new copy on the next open (network first); Setup shows the app version and update date, and
   "What's new" appears once.
4. Adding a data field: raise `LEDGER_VERSION`, add a migration, add an old-version backup to `tests/migrate.test.js`.
