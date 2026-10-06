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
  { tab: "log", label: N.log, drawing: "daily", lines: ["Record what you spend. Tap a quick tile, or Add expense.", "It waits as a draft until you verify it.", "Tap the date at the top to add something you forgot on an earlier day. Hold a tile to move or change it."] },
  { tab: "verify", label: N.verify, drawing: "daily", lines: ["Look at one entry at a time: Correct, Edit or Delete.", "Entries from photos and voice show what was read, so compare before you tap Correct."] },
  { tab: "money", label: N.money, drawing: "cashflow", lines: ["Where your money went. Switch between Category, Budget, Accounts and Trends, and between chart and list.", "Tap the title to switch to Income."] },
  { tab: "income", label: N.income, lines: ["Add income: type a payslip, photograph it, or add other income.", "Overview shows gross, deductions and net. Earnings shows each kind of pay. Payslips lists them, and a payslip can be changed later."] },
  { tab: "cards", label: N.cards, drawing: "reserve", lines: ["What is in each account, and what you owe on each credit card."] },
  { tab: "budget", label: N.budget, lines: ["Set how much to spend on each kind of thing each month.", "A new budget never rewrites the past. See how you are doing in Cash flow, Budget.", "Try the new Budget (Setup) shows your income, each limit as a share of it, and what you save. Suggest a budget proposes limits from your own history. Nothing changes until you confirm.", "By payday (in the new Budget) holds your pay plan. Loading a plan also sets the budgets it implies, and Budget tells you if they ever differ."] },
  { tab: "goals", label: N.goals, lines: ["Savings you are building, with a target and a balance. Balances are hidden until you choose to show them.", "Choose which goal is your emergency fund: overtime drafts and the Emergency Fund target use that goal, whatever it is called."] },
  { tab: "plan", label: N.plan, lines: ["Your plan for each payday: how much goes to rent, daily spending and savings. You can skip it. Budget works without it.", "This divides each payday. Budget sets your limit per category for the month.", "With the new Budget switched on (Setup), the plan lives in Budget, under By payday."] },
  { tab: "checks", label: N.checks, drawing: "reserve", lines: ["Is your card reserve covering what you owe, and how often did you count your accounts?"] },
  { tab: "trips", label: N.trips, lines: ["Spending for a trip, kept apart from everyday spending. Give a trip its first and last day and the entries on those days join it by themselves.", "Moves between your own accounts, card bill payments and entries from templates are left out. You can add or take off any single entry by hand. Trips cannot overlap.", "Without dates, turn a trip on and new entries are tagged to it until you stop."] },
  { tab: "buffer", label: N.buffer, lines: ["Money set aside inside one account for overruns, apart from your everyday allowance.", "At month end, choose which goals the leftover goes to, in order. Each is filled up to its target; the last takes the rest."] },
  { tab: "scan", label: N.scan, drawing: "scan", lines: ["Photograph a receipt, a payslip or a payment screen. The phone reads it; nothing is sent anywhere.", "You check the guess, and the entry waits in Verify with the photo beside it."] },
  { tab: "checkin", label: N.checkin, lines: ["Once a week, count each account for real and type the balance. The app shows the difference from what it expects."] },
  { tab: "setup", label: N.setup, drawing: "data", lines: ["Add accounts, rename or add spending categories, back up, restore or check a backup file, and see which version of the app you have.", "A backup needs a passphrase. Your phone can make one and keep it in Passwords, or tap \"Make one for me\". The app never keeps it.", "Pictures of receipts are not in a backup, so restored entries show \"picture not on this phone\"."] },
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
