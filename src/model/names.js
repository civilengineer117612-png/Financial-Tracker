// The ONE place the screens' names are written. The menu, the bottom bar, the Help topics and the Help drawings all read them from here, so renaming a
// screen changes every one of them together (tests/helpart.test.js proves a drawing follows a rename).
export const SCREEN_NAMES = {
  log: "Log", verify: "Verify", money: "Cash flow", income: "Income", cards: "Cards", budget: "Budget", goals: "Goals", plan: "Pay plan (optional)", checks: "Checks",
  trips: "Trips", buffer: "Buffer", scan: "Scan", checkin: "Weekly review", help: "Help", setup: "Setup",
};

// The menu, in order: [group, [screen ids]]. Setup and Help are pinned at the bottom of the menu by the app.
export const MENU_GROUPS = [["Overview", ["money", "cards", "budget", "goals", "plan", "checks", "trips", "buffer"]], ["Capture", ["scan"]], ["Weekly", ["checkin"]]];

// Menu entries hidden when the owner has switched on the new Budget (Setup, "Try the new Budget"): the pay plan lives inside Budget, under By payday.
// With the switch off nothing is hidden. The screen itself still exists for one more release (and Help still has its topic).
export const menuHidden = (settings) => new Set(settings?.try_new_budget ? ["plan"] : []);

// Words the drawings use that are not screens: the steps an entry goes through, and the four numbers of a month.
export const TERMS = {
  draft: "Draft", ledger: "Ledger", reports: "Reports", photo: "Photo", backupFile: "Backup file",
  in: "IN", spent: "SPENT", saved: "SAVED", left: "LEFT", owed: "Owed", reserve: "Reserve", setAside: "Set aside",
};
