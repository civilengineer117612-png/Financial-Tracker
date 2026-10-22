import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTransactionSave, planPayslip, countedEntries, cardsSummary, reserveShortfalls } from "../src/model/index.js";
import { makeState, commit, cardPurchase } from "./fixtures.js";

const oldCardHistory = () => {
  const state = makeState();
  state.accounts = state.accounts.map((a) => ({ ...a, opening_date: "2026-10-01", opening_balance: a.id === "card" || a.id === "res" ? 50000 : 100000 }));
  state.categories.push({ id: "cat-salary", name: "Salary", kind: "income" }, { id: "cat-overtime", name: "Overtime", kind: "income" });
  commit(state, cardPurchase("old-charge", 90000, "posted", { date: "2023-07-10" }));
  return state;
};
test("adding an older payslip does not bring historical card debt back into the save warning", () => {
  const state = oldCardHistory();
  const input = { id: "old-slip", transaction_id: "old-pay", employer: "Sample Services", period_from: "2023-07-01", period_to: "2023-07-15", pay_date: "2023-07-20", account_id: "chk", printed_gross: 80000, printed_net: 80000, deposit: 80000, earnings: [{ kind: "basic", amount: 80000 }], deductions: [] };
  const result = planPayslip(state, input, new Date("2026-10-22T03:00:00Z"));
  assert.equal(result.ok, true);
  assert.equal(result.violations.find((v) => v.code === "RESERVE_BELOW_OUTSTANDING"), undefined);
  assert.equal(cardsSummary(result.state, { from: "2026-10-01", to: "2026-10-31" }).owe, 50000);
  assert.equal(reserveShortfalls(state.accounts, countedEntries(result.state))[0].shortfall, 0);
  assert.equal(result.state.payslips[0].pay_date, "2023-07-20");
});
test("a new uncovered card purchase still warns, using the same current balance as Cards", () => {
  const state = oldCardHistory();
  const result = checkTransactionSave(state, cardPurchase("new-charge", 1000, "pending", { date: "2026-10-22" }));
  const warning = result.violations.find((v) => v.code === "RESERVE_BELOW_OUTSTANDING");
  assert.equal(warning.shortfall, 1000);
  assert.equal(warning.worsened, true);
});
test("editing an old entry across the opening date updates what the reserve check counts", () => {
  const state = oldCardHistory();
  const changed = cardPurchase("old-charge", 90000, "posted", { date: "2026-10-22" });
  const result = checkTransactionSave(state, changed);
  assert.equal(result.violations.find((v) => v.code === "RESERVE_BELOW_OUTSTANDING").shortfall, 90000);
  commit(state, changed);
  const movedBack = checkTransactionSave(state, cardPurchase("old-charge", 90000, "posted", { date: "2023-07-10" }));
  assert.equal(movedBack.violations.find((v) => v.code === "RESERVE_BELOW_OUTSTANDING"), undefined);
});
