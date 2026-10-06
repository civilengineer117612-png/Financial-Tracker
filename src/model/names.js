// The ONE place the screens' names are written. The menu, the bottom bar, the Help topics and the Help drawings all read them from here, so renaming a
// screen changes every one of them together (tests/helpart.test.js proves a drawing follows a rename).
export const SCREEN_NAMES = {
  log: "Log", verify: "Verify", money: "Cash flow", income: "Income", cards: "Cards", budget: "Budget", goals: "Goals", plan: "Pay plan (optional)", checks: "Checks",
  trips: "Trips", buffer: "Buffer", scan: "Scan", checkin: "Weekly review", help: "Help", setup: "Setup",
};

// The menu, in order: [group, [screen ids]]. Setup and Help are pinned at the bottom of the menu by the app.
export const MENU_GROUPS = [["Overview", ["money", "cards", "budget", "goals", "plan", "checks", "trips", "buffer"]], ["Capture", ["scan"]], ["Weekly", ["checkin"]]];

// Words the drawings use that are not screens: the steps an entry goes through, and the four numbers of a month.
export const TERMS = {
  draft: "Draft", ledger: "Ledger", reports: "Reports", photo: "Photo", backupFile: "Backup file",
  in: "IN", spent: "SPENT", saved: "SAVED", left: "LEFT", owed: "Owed", reserve: "Reserve", setAside: "Set aside",
};
