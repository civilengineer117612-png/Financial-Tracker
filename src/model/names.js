// The ONE place the screens' names are written. The menu, the bottom bar, the Help topics and the Help drawings all read them from here, so renaming a
// screen changes every one of them together (tests/helpart.test.js proves a drawing follows a rename).
export const SCREEN_NAMES = {
  log: "Log", verify: "Verify", money: "Cash flow", income: "Income", cards: "Cards", budget: "Budget", goals: "Goals", plan: "Pay plan (optional)", checks: "Checks",
  trips: "Trips", buffer: "Buffer", scan: "Scan", checkin: "Weekly review", help: "Help", setup: "Setup",
};

// The menu, in order: [group, [screen ids]]. Setup and Help are pinned at the bottom of the menu by the app.
export const MENU_GROUPS = [["Your money", ["money", "cards", "budget", "goals", "plan"]], ["Tools", ["checkin", "checks", "scan", "trips", "buffer"]]];   // every screen, for Help; no one-row groups

// Screens that belong together share ONE menu row (the first id). On each of them a strip of pictures along the top switches between them, so the menu
// stays short: Budget holds Goals and the pay plan, Weekly review holds Checks. (Cards has its own row: it shows where your money is, not where it went.)
export const HUBS = { budget: ["budget", "goals", "plan"], checkin: ["checkin", "checks"] };
export const hubOf = (id) => Object.keys(HUBS).find((h) => HUBS[h].includes(id)) ?? null;
export const menuRows = (ids) => ids.filter((id) => !Object.values(HUBS).some((m) => m.slice(1).includes(id)));   // the menu shows the first screen of each hub
// Short names for the strip (the long one stays in the menu and Help).
export const STRIP_NAMES = { money: "Cash flow", cards: "Cards", budget: "Budget", goals: "Goals", plan: "Pay plan", checkin: "Weekly review", checks: "Checks" };

// Menu entries hidden when the owner has switched on the new Budget (Setup, "Try the new Budget"): the pay plan lives inside Budget, under By payday.
// With the switch off nothing is hidden. The screen itself still exists for one more release (and Help still has its topic).
export const menuHidden = (settings) => new Set(settings?.try_new_budget ? ["plan"] : []);

// Words the drawings use that are not screens: the steps an entry goes through, and the four numbers of a month.
export const TERMS = {
  draft: "Draft", ledger: "Ledger", reports: "Reports", photo: "Photo", backupFile: "Backup file",
  in: "IN", spent: "SPENT", saved: "SAVED", left: "LEFT", owed: "Owed", reserve: "Reserve", setAside: "Set aside",
};
