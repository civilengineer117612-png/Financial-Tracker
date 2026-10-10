// The Help screen's words, kept here so they are easy to keep true. WHEN A SCREEN OR FEATURE IS ADDED OR CHANGED, UPDATE THIS FILE: a test
// (tests/help.test.js) fails if a screen in the menu has no topic. Keep every line short and plain; one topic = what it is for, and how to use it.

// Shown first on the Help screen, word for word.
export const QUICK_NOTES = [
  "It's still being built, so don't rely on it fully yet.",
  "Your data lives only on your phone. No one else can see it or recover it.",
  "Please make a backup now (Setup, then Backup). Write the passphrase on paper or keep it in Passwords on your phone. If you forget it, the backup can't be opened.",
  "iPhone: use it from the Home Screen icon, not a Safari tab.",
  "If something looks wrong, send me a screenshot. Never send your backup file.",
];

// Shown once on a brand-new install, and from Help whenever it is wanted. Plain words, nothing to decide.
export const FIRST_RUN_NOTICE = {
  title: "Before you start",
  lines: [
    "Your data stays on this phone. Nobody else can see it.",
    "A lost phone or a forgotten backup passphrase cannot be recovered. Nobody can help, not even me.",
    "Make a backup now: Setup, then Back up now.",
    "iPhone: add this app to the Home Screen first, and open it from the icon.",
    "Android: clearing the browser's site data erases the ledger. Keep a backup.",
  ],
};

import { SCREEN_NAMES as N } from "./names.js";

// tab: the screen's id in the app (app.js), so "Open" can go there. `label` is the name on the menu or the bottom bar.
export const TOPICS = [
  { tab: "log", label: N.log, drawing: "daily", lines: ["For spending you just made. Tap a quick tile (like Lunch) or Add expense, then Save.", "Each entry waits as a draft until you check it in Verify.", "Move money between accounts makes a Transfer draft, not spending.", "Money out shows a minus and money in a plus. Tap the entries line to show or hide today's list.", "Forgot a day? Tap Select date, pick it, then add the entry. Hold a tile to move or change it.", "This month shows what you spent against your budgets. Tap it to open Budget."] },
  { tab: "verify", label: N.verify, drawing: "daily", lines: ["A check before anything counts. You see one entry at a time.", "Correct if it is right, Edit to fix it, Delete to remove it. Swipe an entry to the right to mark it Correct.", "Entries from photos or voice show what the phone read. Compare it with the paper before you tap Correct."] },
  { tab: "money", label: N.money, drawing: "cashflow", lines: ["Shows where the month's money went. The big number is what you spent.", "Tabs: Category (slim bars, longest first), Budget (against your limits), Accounts (by account), Trends (month by month).", "Tap See every entry for the full list. On the other tabs, tap the chart or List to switch. Tap the title to switch to Income."] },
  { tab: "income", label: N.income, lines: ["Money coming in. Add income to type a payslip, photograph one, or add other income like interest.", "Overview shows gross, deductions and net pay. Earnings and Deductions show the lines. Open a payslip to change it."] },
  { tab: "cards", label: N.cards, drawing: "reserve", lines: ["What is in each account, and what you owe on each credit card.", "Use the arrows for another month. That changes what each account spent and paid, not the balances.", "Paying a card bill is not spending: the purchases were counted when you made them."] },
  { tab: "budget", label: N.budget, lines: ["Your monthly limit for each category. Tap a category to set it. A change starts next month unless you choose otherwise.", "Suggest a budget proposes limits from your own history. Nothing changes until you confirm.", "Spending, Saved and Buckets switch the view. Buckets group categories into Needs, Wants and Savings against a 50/30/20 target: a rule of thumb, not advice. You can change the targets.", "The bucket is read from each category's name: Food, Rent and Kuryente are needs; Netflix, Kape and Gimik are wants; Ipon and MP2 are savings. A name that is not clear is asked once.", "The new Budget is switched on in Setup, under Budget options. It also holds your pay plan, under By payday.", "Saving up for insurance, Christmas or a repair? Tap the category and turn on Save up for a planned expense. What you do not spend carries over, and it shows as set aside for spending, never as savings."] },
  { tab: "goals", label: N.goals, lines: ["Savings you are saving toward, each with a target and a balance. Balances stay hidden until you show them.", "Choose which goal is your emergency fund: overtime drafts and the Emergency Fund target use that goal, whatever it is called.", "A goal can start without an account. Choose one later, then use Put money in.", "Open it from Budget: tap Goals in the strip at the top."] },
  { tab: "plan", label: N.plan, lines: ["Your plan for each payday: how much goes to rent, daily spending and savings. You can skip it. Budget works without it.", "This divides each payday. Budget sets your limit per category for the month.", "With the new Budget switched on (Setup), the plan lives in Budget, under By payday."] },
  { tab: "checks", label: N.checks, drawing: "reserve", lines: ["Two checks. Card reserve: does the money you set aside still cover what you owe on the card? Weekly counts: how much money your counts could not explain.", "Open it from Weekly review: tap Checks in the strip at the top."] },
  { tab: "scheduled", label: N.scheduled, lines: ["Payments you make again and again, and items you pay in parts. Add rent, a subscription, or an installment plan with its total, number of payments and payments already made.", "Each payment becomes a draft in Verify on its due day. Nothing is confirmed for you: check the amount and date, then tap Correct.", "If you log the payment yourself first, the app offers to link it, so it is counted once. Skip a month, pay ahead, bring a skipped one back, or stop future payments from the plan. Past months never change.", "A new amount (a rent increase) starts from a date you choose. An installment counts as spent when you verify its payment, in the plan's category."] },
  { tab: "trips", label: N.trips, lines: ["Spending for a trip, kept apart from everyday spending.", "Give a trip a first and last day and entries on those days join it. Without dates, turn the trip on and new entries join it until you stop.", "Moves between your accounts, card bill payments and templates are left out. You can add or remove any entry by hand. Trips cannot overlap."] },
  { tab: "buffer", label: N.buffer, lines: ["Money kept aside in one account for when a category runs over its budget. Every draw is recorded against that category.", "At month end, choose which goals the leftover goes to, in order. Each is filled to its target; the last takes the rest."] },
  { tab: "scan", label: N.scan, drawing: "scan", lines: ["Take a photo of a receipt, payslip or payment screen. The phone reads it; nothing is sent anywhere.", "You check the guess, and the entry waits in Verify with the photo beside it.", "Money moved between your own accounts, or taken out as cash, becomes a Transfer, not spending. In Setup, give each account its last 4 digits so the app can tell them apart.", "Old spending from elsewhere: Import old spending reads a screenshot of your notes, or a CSV or Excel file. Every line waits in Verify."] },
  { tab: "checkin", label: N.checkin, lines: ["Once a week, look at each real balance (your bank app, your wallet) and type it in.", "The app shows the difference from what it expects. Any gap is recorded as Unlogged, so you see what went missing.", "Checks shows the weeks you counted."] },
  { tab: "setup", label: N.setup, drawing: "data", lines: ["Setup is a short list. Accounts: where your money is. Categories: kinds of spending (tap Bucket to change a category's bucket). Budget options: the new Budget switch. Backup and restore. About this app.", "An account starts with what is in it the day you add it. Spending dated earlier is history only and does not change that amount.", "A backup needs a passphrase. Your phone can make one and keep it in Passwords, or tap Make one for me. The app never keeps it.", "Pictures are not in a backup, so restored entries say \"picture not on this phone\"."] },
];

// Getting started: each step is done or not, worked out from your own data. `done` says what to look for; `tab` is where the step happens.
export function checklist(state, settings) {
  const spent = (state.transactions ?? []).length > 0;
  return [
    { id: "accounts", text: "Add the accounts you pay from", done: (state.accounts ?? []).length > 0, tab: "setup", button: "Open Setup" },
    { id: "entry", text: "Log your first expense", done: spent, tab: "log", button: "Open Log" },
    { id: "backup", text: "Make a backup", done: Boolean(settings?.last_backup_at), tab: "setup", button: "Open Setup" },
  ];
}
