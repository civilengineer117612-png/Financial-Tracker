// "What's new": one plain sentence per update, newest first. The app shows the latest three once after an update (until "Got it"), and Help keeps
// the whole list. Every PR that changes what a user sees or does adds its sentence at the TOP of this list (owner's rule: even small fixes).
export const CHANGES = [
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
