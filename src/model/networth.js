// Net worth over time (owner, Oct 18): what you hold in your accounts minus what the cards are owed, at the end of each month and today. It is the same
// figure the Cards screen calls "free", so the last point always equals it. An account counts from the day it was added (the same rule as every balance);
// drafts count, as they do on Cards. Nothing is stored. Pure.
import { addMonths } from "./reports.js";

// state; options: today ("YYYY-MM-DD"), months: how many month-ends to go back (a number) or "all" (from the month of the oldest account).
// Returns {points: [{date, assets, owed, net}], change}: oldest first, the last point is today; change = the last net minus the first net shown (null with fewer than two points).
export function netWorthSeries(state, { today, months = 12 }) {
  const accounts = state.accounts ?? [];
  if (!accounts.length) return { points: [], change: null };
  const dateOf = new Map(state.transactions.map((t) => [t.id, t.date])), byAccount = new Map(accounts.map((a) => [a.id, []]));
  for (const e of state.entries) {
    const list = byAccount.get(e.account_id), d = dateOf.get(e.transaction_id);
    if (list && d) list.push([d, e.amount]);
  }
  const at = (date, upTo = date) => {   // upTo: the last day that counts; today's point counts every entry, a future-dated one too, exactly as Cards does
    let assets = 0, owed = 0;
    for (const a of accounts) {
      if (a.opening_date && a.opening_date > date) continue;
      const moved = byAccount.get(a.id).reduce((s, [d, amt]) => (d <= upTo && (!a.opening_date || d >= a.opening_date) ? s + amt : s), 0);
      if (a.class === "asset") assets += a.opening_balance + moved; else owed += a.opening_balance - moved;
    }
    return { date, assets, owed, net: assets - owed };
  };
  const thisMonth = today.slice(0, 7), oldest = accounts.map((a) => a.opening_date).filter(Boolean).sort()[0] ?? today;
  const first = months === "all" ? oldest.slice(0, 7) : addMonths(thisMonth, -months);
  const dates = [];
  for (let m = first; m < thisMonth; m = addMonths(m, 1)) dates.push(m + "-" + String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0"));   // the real last day of the month
  dates.push(today);
  const points = dates.map((d) => (d === today ? at(d, "9999-12-31") : at(d))).filter((p) => accounts.some((a) => !a.opening_date || a.opening_date <= p.date));
  return { points, change: points.length > 1 ? points[points.length - 1].net - points[0].net : null };
}
