// The Help screen's words, kept here so they are easy to keep true. WHEN A SCREEN OR FEATURE IS ADDED OR CHANGED, UPDATE THIS FILE: a test
// (tests/help.test.js) fails if a screen in the menu has no topic. Keep every line short and plain; one topic = what it is for, and how to use it.

// Shown first on the Help screen, word for word.
export const QUICK_NOTES = [
  "It's still being built, so don't rely on it fully yet.",
  "Your data lives only on your phone. No one else can see it or recover it.",
  "Please make a backup now (Setup, then Backup). Write the passphrase on paper or keep it in a secured passkey on your phone. If you forget it, the backup can't be opened.",
  "iPhone: use it from the Home Screen icon, not a Safari tab.",
  "If something looks wrong, send me a screenshot. Never send your backup file.",
];

// tab: the screen's id in the app (app.js), so "Open" can go there. `label` is the name on the menu or the bottom bar.
export const TOPICS = [
  { tab: "log", label: "Log", lines: ["Record what you spend. Tap a quick tile, or Add expense.", "It waits as a draft until you verify it.", "Tap the date at the top to add something you forgot on an earlier day. Hold a tile to move or change it."] },
  { tab: "verify", label: "Verify", lines: ["Look at one entry at a time: Correct, Edit or Delete.", "Entries from photos and voice show what was read, so compare before you tap Correct."] },
  { tab: "money", label: "Cash flow", lines: ["Where your money went. Switch between Category, Budget, Accounts and Trends, and between chart and list.", "Tap the title to switch to Income."] },
  { tab: "income", label: "Income", lines: ["Add income: type a payslip, photograph it, or add other income.", "Overview shows gross, deductions and net. Earnings shows each kind of pay. Payslips lists them, and a payslip can be changed later."] },
  { tab: "cards", label: "Cards", lines: ["What is in each account, and what you owe on each credit card."] },
  { tab: "budget", label: "Budget", lines: ["Set how much to spend on each kind of thing each month.", "A new budget never rewrites the past. See how you are doing in Cash flow, Budget."] },
  { tab: "goals", label: "Goals", lines: ["Savings you are building, with a target and a balance. Balances are hidden until you choose to show them."] },
  { tab: "plan", label: "Pay plan", lines: ["What to set aside from each payday. Load a plan once; the app compares it with the pay you actually receive."] },
  { tab: "checks", label: "Checks", lines: ["Is your card reserve covering what you owe, and how often did you count your accounts?"] },
  { tab: "trips", label: "Trips", lines: ["Spending for a trip, kept apart from everyday spending. Turn a trip on and new entries are tagged to it."] },
  { tab: "buffer", label: "Buffer", lines: ["Money set aside inside one account for overruns, apart from your everyday allowance."] },
  { tab: "scan", label: "Scan", lines: ["Photograph a receipt, a payslip or a payment screen. The phone reads it; nothing is sent anywhere.", "You check the guess, and the entry waits in Verify with the photo beside it."] },
  { tab: "checkin", label: "Weekly review", lines: ["Once a week, count each account for real and type the balance. The app shows the difference from what it expects."] },
  { tab: "setup", label: "Setup", lines: ["Add accounts, back up and restore your data, and see which version of the app you have."] },
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
