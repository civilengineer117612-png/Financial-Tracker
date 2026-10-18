import { test } from "node:test";
import assert from "node:assert/strict";
import { netWorthSeries, accountsOverview, netPosition } from "../src/model/index.js";
import { makeState, account, tx, entry, commit } from "./fixtures.js";

// Invented numbers only.
function ledger() {
  const s = makeState();
  s.accounts = [
    account({ id: "w", name: "Test Wallet", class: "asset", opening_balance: 100000, opening_date: "2026-01-01" }),
    account({ id: "b", name: "Test Bank", class: "asset", opening_balance: 500000, opening_date: "2026-03-01" }),
    account({ id: "c", name: "Test Card", class: "liability", opening_balance: 20000, opening_date: "2026-01-01" }),
  ];
  s.categories.push({ id: "pay", name: "Pay", kind: "income" });
  const move = (id, date, acct, amt, cat = "food", extra = {}) => commit(s, { transaction: tx({ id, date, status: "verified" }), entries: [entry({ transaction_id: id, category_id: cat, amount: cat === "pay" ? -amt : amt }), entry({ transaction_id: id, account_id: acct, amount: cat === "pay" ? amt : -amt, ...extra })] });
  move("a", "2026-02-10", "w", 30000);                          // spent from the wallet in February
  move("p", "2026-04-02", "b", 200000, "pay");                  // pay arrives in the bank in April
  move("k", "2026-04-15", "c", 50000, "food", { card_state: "posted" });   // a card purchase: the card is owed 50,000 more
  move("d", "2026-05-03", "w", 10000);                          // May, still before "today"
  return s;
}
const net = (r) => r.points.map((p) => [p.date, p.net]);

test("a point at each month-end and one for today; an account counts from the day it was added", () => {
  const r = netWorthSeries(ledger(), { today: "2026-05-20", months: 5 });
  assert.deepEqual(net(r), [
    ["2026-01-31", 100000 - 20000],                 // wallet 1,000 - card owed 200
    ["2026-02-28", 70000 - 20000],                  // spent 300 in February
    ["2026-03-31", 70000 + 500000 - 20000],         // the bank was added on Mar 1
    ["2026-04-30", 70000 + 700000 - 70000],         // pay in, the card is owed 500 more
    ["2026-05-20", 60000 + 700000 - 70000],
  ]);
});
test("the last point is the same figure Cards calls free", () => {
  const s = ledger(), r = netWorthSeries(s, { today: "2026-05-20", months: 3 }), o = accountsOverview(s, { from: "2026-05-01", to: "2026-05-31" });
  assert.equal(r.points.at(-1).net, netPosition(o.held, o.owe).free);
  assert.equal(r.points.at(-1).assets - r.points.at(-1).owed, r.points.at(-1).net);
});
test("an entry dated after today still counts in today's point, as Cards counts it, but not in an earlier month-end", () => {
  const s = ledger(); commit(s, { transaction: tx({ id: "f", date: "2026-05-25", status: "verified" }), entries: [entry({ transaction_id: "f", category_id: "food", amount: 14000 }), entry({ transaction_id: "f", account_id: "w", amount: -14000 })] });
  const r = netWorthSeries(s, { today: "2026-05-20", months: 3 }), o = accountsOverview(s, { from: "2026-05-01", to: "2026-05-31" });
  assert.equal(r.points.at(-1).net, netPosition(o.held, o.owe).free);
  assert.equal(r.points.at(-2).net, 70000 + 700000 - 70000, "April's month-end is untouched");
});
test("All starts at the month of the oldest account, and months before any account are left out", () => {
  const r = netWorthSeries(ledger(), { today: "2026-05-20", months: "all" });
  assert.equal(r.points[0].date, "2026-01-31");
  const late = ledger(); late.accounts.forEach((a) => { a.opening_date = "2026-04-01"; });
  const l = netWorthSeries(late, { today: "2026-05-20", months: 5 });
  assert.equal(l.points[0].date, "2026-04-30", "no point before the first account existed");
});
test("change is the last net minus the first one shown, and null with a single point", () => {
  const r = netWorthSeries(ledger(), { today: "2026-05-20", months: 4 });
  assert.equal(r.change, r.points.at(-1).net - r.points[0].net);
  assert.equal(netWorthSeries(makeState(), { today: "2026-01-15", months: 0 }).change, null);
  assert.deepEqual(netWorthSeries({ ...makeState(), accounts: [], transactions: [], entries: [] }, { today: "2026-01-15" }), { points: [], change: null });
});
test("it changes nothing", () => {
  const s = ledger(), before = JSON.stringify(s);
  netWorthSeries(s, { today: "2026-05-20", months: "all" });
  assert.equal(JSON.stringify(s), before);
});
