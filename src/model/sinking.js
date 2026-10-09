// A SINKING FUND here is a spending category you are saving up for: insurance, Christmas, a car repair. Its monthly budget is a set-aside, and what is not
// spent carries over to the next month (so a big payment does not flag red in the month it falls due, when it was saved for).
//
// It is SPENDING, never savings (owner's decision; YNAB's "true expenses" works the same way, and the 50/30/20 sources do not agree on a bucket):
//   - its bucket stays the bucket of what it buys (read from its name, or chosen by hand);
//   - it is never counted in Saved, in a Goal or in the emergency fund;
//   - the money still sits in an account, so Cards says how much of "in your accounts" is set aside for planned spending.
// Stored without a data change: the setting `sinking_funds` = {category_id: "YYYY-MM"}, the first month that counts.
import { budgetFor, budgetStatus } from "./budget.js";

export const SINKING_LABEL = "Save up for a planned expense";
export const SINKING_NOTE = "Set aside for spending, not saved. It is not part of your savings or your emergency fund.";
export const SINKING_HELP = "What is not spent carries over to next month. It stays spending, never savings.";

const nextMonth = (m) => { const [y, mo] = m.split("-").map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };
const MAX_MONTHS = 60;

export const sinkingStart = (settings, categoryId) => settings?.sinking_funds?.[categoryId] ?? null;

// {months, setAside, spent, available, over}: what was set aside from `since` through `month`, what was spent of it, and what is left (negative = over).
export function sinkingBalance(state, { rules, categoryMaps = [], categoryId, since, month, asOf }) {
  let setAside = 0, spent = 0, months = 0;
  for (let m = since; m <= month && months < MAX_MONTHS; m = nextMonth(m)) {
    months++;
    setAside += budgetFor(rules, categoryId, m) ?? 0;
    spent += budgetStatus(state, { rules, categoryMaps, month: m, asOf: asOf ?? m + "-28" }).find((r) => r.category_id === categoryId)?.spent ?? 0;
  }
  return { months, setAside, spent, available: setAside - spent, over: spent > setAside };
}

// Every sinking category with its balance: [{category_id, name, ...balance}], biggest set-aside first. Categories that no longer exist are left out.
export function sinkingFunds(state, settings, { month, asOf }) {
  const starts = settings?.sinking_funds ?? {};
  return Object.entries(starts).map(([id, since]) => ({ cat: state.categories.find((c) => c.id === id && c.kind === "expense"), id, since }))
    .filter((x) => x.cat && x.since <= month)
    .map((x) => ({ category_id: x.id, name: x.cat.name, ...sinkingBalance(state, { rules: state.rules, categoryMaps: state.categoryMaps, categoryId: x.id, since: x.since, month, asOf }) }))
    .sort((a, b) => b.setAside - a.setAside || a.name.localeCompare(b.name));
}

// The total of what is waiting to be spent (never below zero: an overspent fund holds nothing).
export const setAsideForSpending = (funds) => funds.reduce((n, f) => n + Math.max(0, f.available), 0);

// Turns one category on (from `month`) or off. Returns the new settings value.
export function toggleSinking(settings, categoryId, month) {
  const cur = { ...(settings?.sinking_funds ?? {}) };
  if (cur[categoryId]) delete cur[categoryId]; else cur[categoryId] = month;
  return cur;
}
