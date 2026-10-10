// "What's new": one plain sentence per update, newest first. The app shows the latest three once after an update (until "Got it"), and Help keeps
// the whole list. Every PR that changes what a user sees or does adds its sentence at the TOP of this list (owner's rule: even small fixes).
export const CHANGES = [
  { id: "2026-10-10-quiet-budget", date: "2026-10-10", text: "Spending, Budget: one slim line per category (tap one to see what is left), a shorter key, and Move money between accounts now lives on Cards, not on Log." },
  { id: "2026-10-10-scheduled-more", date: "2026-10-10", text: "Scheduled: a skipped payment can be brought back, a plan on a credit card sets its reserve aside once, and there is a how-to clip (hold its menu row)." },
  { id: "2026-10-10-scheduled", date: "2026-10-10", text: "New Scheduled screen: repeating payments and installment plans become drafts in Verify on their due day, Log shows what is due soon, and a payment you log yourself is linked, not doubled." },
  { id: "2026-10-10-move-money", date: "2026-10-10", text: "Log can move money between your accounts by hand, Cards shows each account's last 4 digits, a foreign withdrawal hints at your last rate, and Bank fees counts as a need." },
  { id: "2026-10-09-transfers", date: "2026-10-09", text: "A payment screenshot between your own accounts, or a cash withdrawal, now becomes a Transfer with its fee, not spending: add each account's last 4 digits in Setup." },
  { id: "2026-10-09-quiet-figures", date: "2026-10-09", text: "Budget rows and the Cards clip use small arrows and percents instead of little sentences, and clip buttons are green like the app." },
  { id: "2026-10-09-ledger", date: "2026-10-09", text: "A new quiet look: warm paper background, white cards, one green button per screen, a simpler number font, and Spending shows slim bars instead of a donut." },
  { id: "2026-10-09-sinking", date: "2026-10-09", text: "Saving up for a planned expense (insurance, Christmas) is now a switch on a category's budget: it carries over and is never counted as savings." },
  { id: "2026-10-09-setup-help", date: "2026-10-09", text: "Setup is now a short list of pages, Help runs in a clearer order with plainer guides, and What's new is smaller." },
  { id: "2026-10-09-howto-rest", date: "2026-10-09", text: "New how-to clips for Cards, Weekly review, Checks and Buffer: hold their menu rows to watch." },
  { id: "2026-10-09-round3", date: "2026-10-09", text: "Cash flow views are quiet tabs, goals show a ring, swipe an entry right in Verify to mark it Correct, Setup keeps Add an account behind a button, and long notes fold under Why?." },
  { id: "2026-10-09-polish", date: "2026-10-09", text: "A calmer look: a slim bottom bar, lighter buttons and strips, new icons for Log and Weekly review, and how-to clips that fade between loops." },
  { id: "2026-10-09-signs", date: "2026-10-09", text: "Money out shows a minus and money in a plus, the day's entries stay folded until tapped, Budget rows have a bar, Cards is back in the menu, and Select date is the one date link." },
  { id: "2026-10-09-simpler", date: "2026-10-09", text: "A shorter menu: Cards sits in Cash flow, Goals in Budget, Checks in Weekly review, and Log shows this month at a glance." },
  { id: "2026-10-09-tidy", date: "2026-10-09", text: "Budget now shows Spending, Saved and Buckets one at a time under the overview, and the day total says what it is." },
  { id: "2026-10-09-howto-more", date: "2026-10-09", text: "A new how-to for Import old spending (in Help), the Goals clip covers the emergency fund, and the hold hint is now one short line." },
  { id: "2026-10-09-howto-goals", date: "2026-10-09", text: "Hold Goals in the menu to watch how putting money toward a goal grows its bar, drawn from your own goal." },
  { id: "2026-10-09-howto-backup", date: "2026-10-09", text: "Hold Back up now in Setup to watch how to back up; the menu now says rows can be held, and the Trips and Verify clips show more." },
  { id: "2026-10-09-howto-trips", date: "2026-10-09", text: "Hold Trips in the menu to watch how a trip keeps its spending apart, and the Verify clip now shows fixing an amount before tapping Correct." },
  { id: "2026-10-07-import", date: "2026-10-07", text: "Import old spending from a screenshot of your notes or a spreadsheet (CSV or Excel): tap the camera, then Import old spending. Every line waits in Verify." },
  { id: "2026-10-07-tips-yours", date: "2026-10-07", text: "Budgeting tips now show your own figures beside them, two Philippine tips were added, and notes are in italics everywhere." },
  { id: "2026-10-07-tips", date: "2026-10-07", text: "Suggest a budget is shorter: the repeated starter note is gone, and budgeting tips with their sources sit at the bottom." },
  { id: "2026-10-07-start-date", date: "2026-10-07", text: "Spending dated before the day you added an account is now history only; it no longer comes off that account's balance." },
  { id: "2026-10-07-howto-budget", date: "2026-10-07", text: "Hold Budget in the menu to watch how to set a monthly limit, drawn from your own budgets." },
  { id: "2026-10-07-howto", date: "2026-10-07", text: "Hold Log, Verify or the camera for a moment to watch a short how-to drawn from your own screen. Help lists them all." },
  { id: "2026-10-06-ef-names", date: "2026-10-06", text: "New categories like Groceries now count toward your Emergency Fund, and the bucket bars can be shown as a table." },
  { id: "2026-10-06-bucket-names", date: "2026-10-06", text: "Each category's bucket (Needs, Wants, Savings or Other) is now read from its name. Setup shows just Name and Bucket." },
  { id: "2026-10-06-savings-goals", date: "2026-10-06", text: "Savings categories are Goals now: type a monthly amount for one, and the others share what is left." },
  { id: "2026-10-06-buckets", date: "2026-10-06", text: "The new Budget shows your Needs, Wants and Savings against 50/30/20, a rule of thumb you can change." },
];

// What to show in the pop-up: the latest few, or nothing once the newest one has been seen.
export function whatsNew(settings, n = 3) {
  return settings?.whatsnew_seen === CHANGES[0].id ? [] : CHANGES.slice(0, n);
}
