// Paying a credit card (owner, Oct 17): tap a card on Cards and a small window opens: what you owe NOW, the last statement and the due day (when the owner gave
// them), "Paid from" already set to the account that backs the card, and one button that makes the payment. The payment is a DRAFT transfer into the card
// (never spending, never verified by itself). The due day and the last statement balance are typed once per card; a statement the owner KEPT for that card wins.
// Pure logic; amounts are centavos, dates are "YYYY-MM-DD".
import { planTransfer } from "./transfers.js";

const fail = (message) => ({ ok: false, message });
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1 to 12
const pad = (n) => String(n).padStart(2, "0");
const days = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);   // b - a

// The debit account that backs this card (its reserve), or null: the one the Cards screen already puts right before the card.
export const payerFor = (state, cardId) => state.accounts.find((a) => !a.archived && a.class === "asset" && a.reserve_for === cardId)?.id ?? null;

// The next date a due day falls on, today included: {date, days}. A short month uses its last day. Null when there is no due day.
export function nextDue(dueDay, today) {
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return null;
  const [y, m] = today.split("-").map(Number);
  const inMonth = (yy, mm) => `${yy}-${pad(mm)}-${pad(Math.min(dueDay, lastDay(yy, mm)))}`;
  let date = inMonth(y, m);
  if (date < today) date = m === 12 ? inMonth(y + 1, 1) : inMonth(y, m + 1);
  return { date, days: days(today, date) };
}

// The last statement balance of a card: a statement the owner kept (the newest one's closing figure) wins over a balance typed once.
// {balance, date, from: "statement" | "typed"} or null. A statement shows what was owed, so the figure is read as a positive amount.
export function cardStatement(state, cardId) {
  const card = state.accounts.find((a) => a.id === cardId);
  const records = (state.statementRecords ?? []).filter((r) => r.account_id === cardId && Number.isSafeInteger(r.closing) && r.period_to).sort((a, b) => b.period_to.localeCompare(a.period_to));
  if (records[0]) return { balance: Math.abs(records[0].closing), date: records[0].period_to, from: "statement" };
  if (card && Number.isSafeInteger(card.statement_balance) && card.statement_balance > 0) return { balance: card.statement_balance, date: card.statement_date ?? null, from: "typed" };
  return null;
}

// Save a card's due day and typed statement balance. `due_day`: 1 to 31, or "" to clear. `statement_balance`: centavos (more than 0), or null to clear.
export function setCardDetails(state, cardId, { due_day = "", statement_balance = null, date }) {
  const card = state.accounts.find((a) => a.id === cardId);
  if (!card || card.class !== "liability") return fail("Only a credit card has a due day.");
  const day = due_day === "" || due_day === null ? null : Number(due_day);
  if (day !== null && (!Number.isInteger(day) || day < 1 || day > 31)) return fail("The due day is a day of the month, from 1 to 31.");
  if (statement_balance !== null && (!Number.isSafeInteger(statement_balance) || statement_balance <= 0)) return fail("The statement balance must be more than zero.");
  const { due_day: _d, statement_balance: _b, statement_date: _s, ...rest } = card;
  const next = { ...rest, ...(day !== null ? { due_day: day } : {}), ...(statement_balance !== null ? { statement_balance, statement_date: date } : {}) };
  return { ok: true, state: { ...state, accounts: state.accounts.map((a) => (a.id === cardId ? next : a)) } };
}

// The payment: ONE draft transfer from the paying account into the card (it lowers what is owed; it is not spending).
export function planCardPayment(state, { card_id, from_id, amount, date, newId, now = new Date() }) {
  const card = state.accounts.find((a) => a.id === card_id), from = state.accounts.find((a) => a.id === from_id);
  if (!card || card.class !== "liability") return fail("Choose a credit card to pay.");
  if (!from || from.class !== "asset") return fail("Choose the account the money comes from.");
  const r = planTransfer(state, { transaction_id: newId(), date, from_account_id: from_id, to_account_id: card_id, amount, payee: "Card payment", source: "manual" }, now);
  return r.ok ? { ok: true, state: r.state } : fail(r.violations[0].message);
}
