// Scheduled payments: things you pay again and again (rent, subscriptions, Family) and installment plans (an item paid in parts).
//
// What it does, in the owner's words:
//  - Each due payment appears as a DRAFT in Verify around its due date. Never auto-confirmed. Date, amount and note stay editable.
//  - When a payment is logged by hand or scanned and a due draft of about the same payee and amount is near, the app OFFERS to link them. Never a second.
//  - Skip a month, pay ahead, mark paid off. Ending a schedule stops FUTURE payments only; past months never change.
//  - A new amount (a rent increase) is a new dated row, never an edit. Every change is a dated row in `scheduleChanges`, which is only ever added to.
//  - Each installment counts as spent when it is verified, in the plan's category. The plan is recorded once; the purchase is never logged separately.
//
// Data: `schedules` (one row per plan) and `scheduleChanges` (dated rows). A draft carries `schedule_id` and `schedule_key` (the month "2026-10" for a
// repeating payment, the payment number "3" for an installment) and has the id "sch:<schedule>:<key>", so the same payment is never made twice.
// The due-day rule is the one in templates.js ("monthly:5": the 5th, or the last day of a short month).
import { isDue, datesBetween, parseSchedule } from "./templates.js";
import { planExpense, discardDraft } from "./drafts.js";
import { validateShape } from "./schema.js";
import { phTimestamp } from "./util.js";
import { checkTransactionSave } from "./index.js";

export const INTEREST_ROLE = "interest_fees";
export const SCHEDULE_WINDOW_DAYS = 0;   // a payment becomes a draft this many days before it is due (0: on its due date, where Verify lists it)
export const CATCH_UP_DAYS = 92;   // and, if the app was closed, for payments that fell due up to this long ago
export const draftIdFor = (scheduleId, key) => "sch:" + scheduleId + ":" + key;
export const isScheduleDraftId = (id) => String(id).startsWith("sch:");

const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }], state: null });
const pad = (n) => String(n).padStart(2, "0");
const addDaysIso = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);   // b - a

// The date of the k-th month after `first` (k = 0 is first itself), on the same day of the month, or the last day of a shorter month.
export function monthsAfter(first, k) {
  const [y, m, d] = first.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + k, yy = Math.floor(total / 12), mm = (total % 12) + 1;
  return yy + "-" + pad(mm) + "-" + pad(Math.min(d, lastDay(yy, mm)));
}

const rowsOf = (state, id) => (state.scheduleChanges ?? []).filter((c) => c.schedule_id === id);

// What happened to a schedule so far, read from its dated rows.
export function historyOf(state, s) {
  const rows = rowsOf(state, s.id);
  const stops = rows.filter((c) => c.kind === "end" || c.kind === "paid_off").map((c) => c.effective_from).sort();
  return {
    endedOn: stops[0] ?? null,   // no payment falls due AFTER this date
    paidOff: rows.some((c) => c.kind === "paid_off"),
    skipped: new Set(rows.filter((c) => c.kind === "skip").map((c) => c.key)),
    amounts: rows.filter((c) => c.kind === "amount").sort((a, b) => (a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : a.created_at < b.created_at ? -1 : 1)),
    requests: new Map(rows.filter((c) => c.kind === "due").map((c) => [c.key, c.amount])),   // a payment request read from a screen sets one payment's amount
  };
}

// ---------- the payments of a schedule ----------
const split = (total, n, k) => { const base = Math.floor(total / n); return k === n ? total - base * (n - 1) : base; };   // k = 1..n; the last one takes the remainder so they add up exactly

// Every payment the schedule has or had: [{key, k?, due, amount, interest}] in order. A repeating one runs from its start with no end (the end is
// read from its rows); an installment plan has exactly `count` payments, the first `made` of them already paid before the plan was entered.
export function paymentsOf(state, s, { through }) {
  const h = historyOf(state, s), out = [];
  if (s.kind === "installment") {
    for (let k = (s.made ?? 0) + 1; k <= s.count; k++) {
      const due = monthsAfter(s.start, k - 1);
      out.push({ key: String(k), k, due, amount: h.requests.get(String(k)) ?? split(s.total, s.count, k), interest: s.interest ? split(s.interest, s.count, k) : 0 });
    }
    return out;
  }
  const schedule = "monthly:" + s.day;
  for (const date of datesBetween(s.start, through)) {
    if (!isDue(schedule, date)) continue;
    const amount = h.amounts.filter((a) => a.effective_from <= date).pop()?.amount ?? s.amount;
    out.push({ key: date.slice(0, 7), due: date, amount: h.requests.get(date.slice(0, 7)) ?? amount, interest: 0 });
  }
  return out;
}

// A payment's state: "verified" or "draft" (a transaction with its key exists), "skipped", or "open" (nothing yet).
export function paymentState(state, s, key) {
  const t = state.transactions.find((x) => x.schedule_id === s.id && x.schedule_key === key);
  if (t) return t.status;
  return historyOf(state, s).skipped.has(key) ? "skipped" : "open";
}

// ---------- drafts ----------
// Makes the drafts that are due: every open payment whose due date is no more than `windowDays` ahead and no more than CATCH_UP_DAYS behind, and not
// after the schedule ended. Returns {state, made: [transaction ids]}. Running it again changes nothing. Nothing is ever verified here.
export function makeDueDrafts(state, today, { reserve_source_id, now = new Date(), windowDays = SCHEDULE_WINDOW_DAYS } = {}) {
  let next = state; const made = [];
  for (const s of state.schedules ?? []) {
    const h = historyOf(state, s);
    for (const p of paymentsOf(state, s, { through: addDaysIso(today, windowDays) })) {
      if (p.due > addDaysIso(today, windowDays) || p.due < addDaysIso(today, -CATCH_UP_DAYS)) continue;
      if (h.endedOn !== null && p.due > h.endedOn) continue;
      if (paymentState(next, s, p.key) !== "open") continue;
      const r = draftFor(next, s, p, { reserve_source_id, now });
      if (r.ok) { next = r.state; made.push(draftIdFor(s.id, p.key)); }
    }
  }
  return { state: next, made };
}

// One payment as a draft, now (also used by "Pay now"). A plan with an interest part is split in two lines; one in a foreign currency keeps it.
export function draftFor(state, s, p, { reserve_source_id, now = new Date(), date = p.due } = {}) {
  const id = draftIdFor(s.id, p.key);
  const input = { transaction_id: id, date, payee: s.name, category_id: s.category_id, amount: p.amount, account_id: s.account_id, source: "template", reserve_source_id };
  const planned = planExpense(state, { ...input, reserve_source_id: reserved(state, s) ? undefined : reserve_source_id }, now);   // a card plan with its reserve already set aside needs no more per payment
  if (!planned.ok) return { ok: false, violations: planned.violations, state };
  let drafts = planned.drafts;
  const tx0 = drafts[0].transaction;
  drafts[0] = { ...drafts[0], transaction: { ...tx0, schedule_id: s.id, schedule_key: p.key, memo: "" } };
  if (p.interest > 0 && p.interest < p.amount) {   // "Interest and fees" is its own line; the rest stays in the plan's category
    const withCat = ensureInterestCategory(state);
    drafts[0] = { ...drafts[0], entries: drafts[0].entries.map((e) => (e.category_id === s.category_id ? { ...e, amount: p.amount - p.interest } : e)).concat([{ transaction_id: id, category_id: withCat.category_id, amount: p.interest }]) };
    state = withCat.state;
  }
  let out = { ...state, transactions: [...state.transactions.filter((t) => !drafts.some((d) => d.transaction.id === t.id)), ...drafts.map((d) => d.transaction)], entries: [...state.entries.filter((e) => !drafts.some((d) => d.transaction.id === e.transaction_id)), ...drafts.flatMap((d) => d.entries)] };
  if (s.foreign_currency && s.foreign_amount) {
    out = { ...out, foreignAmounts: [...(out.foreignAmounts ?? []).filter((f) => f.transaction_id !== id), { transaction_id: id, currency: s.foreign_currency, foreign_amount: s.foreign_amount, rate: p.amount / s.foreign_amount }] };
  }
  return { ok: true, violations: [], state: out };
}

// A plan on a credit card: the part billed each month counts when billed, and the card's reserve covers the amount still owed. So when the plan is made, ONE
// draft transfer puts the whole amount still to be billed into the reserve (verified like any other); the payments after it then add no reserve of their own.
export const reserveIdFor = (scheduleId) => "sch-rsv:" + scheduleId;
const reserved = (state, s) => state.transactions.some((t) => t.id === reserveIdFor(s.id));
export function reserveForPlan(state, s, { reserve_source_id, today, now = new Date() } = {}) {
  const card = state.accounts.find((a) => a.id === s.account_id);
  const none = { ok: true, violations: [], state, id: null, amount: 0 };
  if (s.kind !== "installment" || card?.class !== "liability" || !reserve_source_id || reserved(state, s)) return none;
  const reserve = state.accounts.find((a) => a.reserve_for === card.id);
  if (!reserve || reserve.id === reserve_source_id || !state.accounts.some((a) => a.id === reserve_source_id)) return none;
  const amount = paymentsOf(state, s, { through: addDaysIso(today, 800) }).filter((p) => paymentState(state, s, p.key) === "open").reduce((n, p) => n + p.amount, 0);
  if (amount <= 0) return none;
  const id = reserveIdFor(s.id), t = { id, date: today, payee: "Reserve for " + s.name, memo: "", status: "draft", source: "template", created_at: phTimestamp(now) };
  const es = [{ transaction_id: id, account_id: reserve.id, amount }, { transaction_id: id, account_id: reserve_source_id, amount: -amount }];
  const check = checkTransactionSave(state, { transaction: t, entries: es });
  if (!check.ok) return { ok: false, violations: check.violations, state, id: null, amount: 0 };
  return { ok: true, violations: check.violations, state: { ...state, transactions: [...state.transactions, t], entries: [...state.entries, ...es] }, id, amount };
}

// The category "Interest and fees": the one with the role interest_fees; made on first use. Nothing finds it by name.
export function ensureInterestCategory(state) {
  const have = state.categories.find((c) => c.role === INTEREST_ROLE && c.kind === "expense");
  if (have) return { state, category_id: have.id };
  return { state: { ...state, categories: [...state.categories, { id: "cat-interest-fees", name: "Interest and fees", kind: "expense", role: INTEREST_ROLE }] }, category_id: "cat-interest-fees" };
}

// ---------- making and changing schedules ----------
// input: {id, kind: "repeating" | "installment", name, category_id, account_id, start, created_at?,
//   repeating: amount, day   installment: total, count, made, interest?   either: foreign?: {currency, amount}}
export function addSchedule(state, input, now = new Date()) {
  const name = String(input.name ?? "").trim();
  if (!name) return fail("NO_NAME", "give it a name");
  if (!state.categories.some((c) => c.id === input.category_id && c.kind === "expense")) return fail("NO_CATEGORY", "choose a category");
  if (!state.accounts.some((a) => a.id === input.account_id)) return fail("NO_ACCOUNT", "choose the paying account");
  if ((state.schedules ?? []).some((s) => s.id === input.id)) return fail("DUPLICATE_ID", "that schedule already exists");
  const base = { id: input.id, kind: input.kind, name, category_id: input.category_id, account_id: input.account_id, start: input.start, created_at: phTimestamp(now),
    ...(input.foreign ? { foreign_currency: input.foreign.currency, foreign_amount: input.foreign.amount } : {}) };
  let row;
  if (input.kind === "repeating") {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) return fail("BAD_AMOUNT", "the amount must be more than zero");
    if (!parseSchedule("monthly:" + input.day)) return fail("BAD_DAY", "the due day must be 1 to 31");
    row = { ...base, amount: input.amount, day: Number(input.day) };
  } else if (input.kind === "installment") {
    if (!Number.isSafeInteger(input.total) || input.total <= 0) return fail("BAD_TOTAL", "the total to pay must be more than zero");
    if (!Number.isInteger(input.count) || input.count < 1) return fail("BAD_COUNT", "the number of payments must be 1 or more");
    const made = input.made ?? 0;
    if (!Number.isInteger(made) || made < 0 || made > input.count) return fail("BAD_MADE", "payments already made must be between 0 and the number of payments");
    if (input.interest != null && (!Number.isSafeInteger(input.interest) || input.interest < 0 || input.interest >= input.total)) return fail("BAD_INTEREST", "the interest part must be less than the total");
    row = { ...base, total: input.total, count: input.count, made, ...(input.interest ? { interest: input.interest } : {}) };
  } else return fail("BAD_KIND", "choose repeating or installment");
  const bad = validateShape("Schedule", row);
  if (bad.length) return { ok: false, violations: bad, state: null };
  return { ok: true, violations: [], state: { ...state, schedules: [...(state.schedules ?? []), row] }, schedule: row };
}

let counter = 0;
const changeRow = (s, kind, extra, now) => ({ id: "chg-" + s.id + "-" + kind + "-" + (extra.key ?? extra.effective_from) + "-" + now.getTime() + "-" + (++counter), schedule_id: s.id, kind, created_at: phTimestamp(now), ...extra });
function addChange(state, scheduleId, kind, extra, now) {
  const s = (state.schedules ?? []).find((x) => x.id === scheduleId);
  if (!s) return fail("UNKNOWN_SCHEDULE", "no schedule " + scheduleId);
  const row = changeRow(s, kind, extra, now), bad = validateShape("ScheduleChange", row);
  if (bad.length) return { ok: false, violations: bad, state: null };
  return { ok: true, violations: [], state: { ...state, scheduleChanges: [...(state.scheduleChanges ?? []), row] } };
}
// A new amount from a date on (a rent increase). Earlier months keep what they had.
export function setNewAmount(state, scheduleId, amount, effective_from, now = new Date()) {
  const s = (state.schedules ?? []).find((x) => x.id === scheduleId);
  if (s && s.kind !== "repeating") return fail("NOT_REPEATING", "only a repeating payment has a new amount");
  if (!Number.isSafeInteger(amount) || amount <= 0) return fail("BAD_AMOUNT", "the amount must be more than zero");
  return addChange(state, scheduleId, "amount", { effective_from, amount }, now);
}
// Skip one payment: no draft is made for it (an installment payment skipped stays owed).
export const skipPayment = (state, scheduleId, key, effective_from, now = new Date()) => addChange(state, scheduleId, "skip", { effective_from, key }, now);
// Stop FUTURE payments after `date`; everything before it stays as it was.
export const endSchedule = (state, scheduleId, date, now = new Date()) => addChange(state, scheduleId, "end", { effective_from: date }, now);
// An installment plan paid off early: the same as ending it, and it says so.
export const markPaidOff = (state, scheduleId, date, now = new Date()) => {
  const s = (state.schedules ?? []).find((x) => x.id === scheduleId);
  if (s && s.kind !== "installment") return fail("NOT_INSTALLMENT", "only an installment plan is marked paid off");
  return addChange(state, scheduleId, "paid_off", { effective_from: date }, now);
};
// A payment request read from a screen sets the amount of the next open payment (a reminder; it is not an expense).
export function markNextDue(state, scheduleId, amount, today, now = new Date()) {
  const s = (state.schedules ?? []).find((x) => x.id === scheduleId);
  if (!s) return fail("UNKNOWN_SCHEDULE", "no schedule " + scheduleId);
  const next = paymentsOf(state, s, { through: addDaysIso(today, 400) }).find((p) => paymentState(state, s, p.key) === "open");
  if (!next) return fail("NOTHING_DUE", "there is no payment left to mark");
  if (!Number.isSafeInteger(amount) || amount <= 0) return fail("BAD_AMOUNT", "the amount must be more than zero");
  const r = addChange(state, scheduleId, "due", { effective_from: today, key: next.key, amount }, now);
  return r.ok ? { ...r, payment: { ...next, amount } } : r;
}
// "Pay now" / pay ahead: the next open payment becomes a draft today, whatever its due date.
export function payNext(state, scheduleId, today, { reserve_source_id, now = new Date() } = {}) {
  const s = (state.schedules ?? []).find((x) => x.id === scheduleId);
  if (!s) return fail("UNKNOWN_SCHEDULE", "no schedule " + scheduleId);
  const h = historyOf(state, s);
  const next = paymentsOf(state, s, { through: addDaysIso(today, 400) }).find((p) => (h.endedOn === null || p.due <= h.endedOn) && ["open", "skipped"].includes(paymentState(state, s, p.key)));
  if (!next) return fail("NOTHING_DUE", "there is no payment left");
  const r = draftFor(state, s, next, { reserve_source_id, now, date: next.due < today ? next.due : today });   // a skipped payment stays skipped in its rows; having a draft is what counts
  if (!r.ok) return { ok: false, violations: r.violations, state: null };
  return { ok: true, violations: [], state: r.state, payment: next };
}
// A skipped (or deleted) payment can be brought back: it becomes a draft now. (Having a draft is what counts, so no row is removed.)
export function payKey(state, scheduleId, key, today, { reserve_source_id, now = new Date() } = {}) {
  const s = (state.schedules ?? []).find((x) => x.id === scheduleId);
  if (!s) return fail("UNKNOWN_SCHEDULE", "no schedule " + scheduleId);
  const p = paymentsOf(state, s, { through: addDaysIso(today, 400) }).find((x) => x.key === key);
  if (!p || paymentState(state, s, key) !== "skipped") return fail("NOT_SKIPPED", "that payment is not skipped");
  const r = draftFor(state, s, p, { reserve_source_id, now, date: p.due < today ? p.due : today });
  return r.ok ? { ok: true, violations: [], state: r.state, payment: p } : { ok: false, violations: r.violations, state: null };
}
// The next payment that has no draft yet (and is not skipped or after the end): the one "Skip" and "Pay ahead" mean. The next DUE payment may already be a draft.
export function nextOpenPayment(state, s, today) {
  const h = historyOf(state, s);
  return paymentsOf(state, s, { through: addDaysIso(today, 400) }).find((p) => (h.endedOn === null || p.due <= h.endedOn) && !h.paidOff && paymentState(state, s, p.key) === "open") ?? null;
}
// The skipped payments of a schedule, newest first: [{key, due, amount}].
export function skippedOf(state, s, today) {
  return paymentsOf(state, s, { through: addDaysIso(today, 400) }).filter((p) => paymentState(state, s, p.key) === "skipped").reverse();
}
// A due draft that is deleted in Verify is not made again: its payment is skipped.
export function skipOnDelete(state, tx, today, now = new Date()) {
  if (!tx.schedule_id) return { ok: true, violations: [], state };
  return skipPayment(state, tx.schedule_id, tx.schedule_key, today, now);
}

// ---------- reading them ----------
// The view of one schedule: how much is paid, what is left, the next payment.
export function viewOf(state, s, today) {
  const h = historyOf(state, s), all = paymentsOf(state, s, { through: addDaysIso(today, 400) });
  const stopped = (p) => h.endedOn !== null && p.due > h.endedOn;
  if (s.kind === "installment") {
    const verified = all.filter((p) => paymentState(state, s, p.key) === "verified");
    const left = all.filter((p) => paymentState(state, s, p.key) !== "verified");
    const next = h.paidOff ? null : left.find((p) => paymentState(state, s, p.key) !== "skipped") ?? left[0] ?? null;
    return { kind: "installment", paid: (s.made ?? 0) + verified.length, of: s.count, stillToPay: h.paidOff ? 0 : left.reduce((n, p) => n + p.amount, 0), next, active: !h.paidOff && !!next, ended: h.paidOff, paidOff: h.paidOff };
  }
  const pending = all.filter((p) => !stopped(p) && !["verified", "skipped"].includes(paymentState(state, s, p.key)) && p.due >= addDaysIso(today, -CATCH_UP_DAYS));
  const upcoming = h.endedOn === null || today <= h.endedOn;
  return { kind: "repeating", next: upcoming ? pending[0] ?? null : null, active: upcoming, ended: !upcoming, endedOn: h.endedOn };
}

// "Due soon" on Log: payments not yet verified and due within `days` (or overdue), as plain facts: name, amount, days left.
export function dueSoon(state, today, { days = 7 } = {}) {
  const out = [];
  for (const s of state.schedules ?? []) {
    const h = historyOf(state, s);
    for (const p of paymentsOf(state, s, { through: addDaysIso(today, days) })) {
      if (p.due > addDaysIso(today, days) || p.due < addDaysIso(today, -CATCH_UP_DAYS)) continue;
      if (h.endedOn !== null && p.due > h.endedOn) continue;
      const st = paymentState(state, s, p.key);
      if (st === "verified" || st === "skipped") continue;
      out.push({ schedule_id: s.id, name: s.name, amount: p.amount, due: p.due, days: daysBetween(today, p.due), key: p.key, draft: st === "draft" });
    }
  }
  return out.sort((a, b) => a.days - b.days);
}
// "in 3 days", "today", "tomorrow", "2 days overdue": plain words, no colour.
export const daysText = (days) => (days === 0 ? "due today" : days === 1 ? "due tomorrow" : days > 1 ? "due in " + days + " days" : days === -1 ? "1 day overdue" : Math.abs(days) + " days overdue");

// What the plan takes each month, and what the category's budget is: the one plain line shown when a plan is made. A note only; it never blocks.
export function planLine({ perMonth, months, categoryName, budget }, peso) {
  return "This plan takes " + peso(perMonth) + " a month for " + months + " month" + (months === 1 ? "" : "s") + "." + (budget != null ? " " + categoryName + " budget: " + peso(budget) + "." : "");
}

// What installments commit in a category this month: payments that fall due in the month and are not paid yet (a draft or still to come).
export function committedIn(state, categoryId, month, today) {
  let sum = 0;
  for (const s of state.schedules ?? []) {
    if (s.kind !== "installment" || s.category_id !== categoryId) continue;
    const h = historyOf(state, s);
    for (const p of paymentsOf(state, s, { through: month + "-31" })) {
      if (p.due.slice(0, 7) !== month || h.paidOff) continue;
      if (["verified", "skipped"].includes(paymentState(state, s, p.key))) continue;
      sum += p.amount;
    }
  }
  return sum;
}

// ---------- the guard: logged by hand or scanned while a due draft exists ----------
const near = (a, b) => Math.abs(a - b) <= Math.max(100, Math.round(Math.max(a, b) * 0.1));   // about the same amount: within 10%
const sameName = (a, b) => { const x = String(a ?? "").trim().toLowerCase(), y = String(b ?? "").trim().toLowerCase(); return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x)); };
// The due draft this new payment probably is: a scheduled DRAFT of about the same payee and amount, due within 7 days of the payment's date.
export function matchDueDraft(state, { payee, amount, date }) {
  const hit = state.transactions.find((t) => t.status === "draft" && t.schedule_id && sameName(t.payee, payee) && Math.abs(daysBetween(t.date, date)) <= 7
    && near(state.entries.filter((e) => e.transaction_id === t.id && e.amount > 0).reduce((n, e) => n + e.amount, 0), amount));
  return hit?.id ?? null;
}
// Link: the payment you made takes the place of the due draft (it keeps its photo, its note, its date); the due draft goes away. No second entry.
export function linkToDue(state, newId, dueId) {
  const due = state.transactions.find((t) => t.id === dueId && t.schedule_id), mine = state.transactions.find((t) => t.id === newId);
  if (!due || !mine) return fail("UNKNOWN_TRANSACTION", "nothing to link");
  const gone = discardDraft(state, dueId);
  if (!gone.ok) return { ok: false, violations: gone.violations, state: null };
  return { ok: true, violations: [], state: { ...gone.state, transactions: gone.state.transactions.map((t) => (t.id === newId ? { ...t, schedule_id: due.schedule_id, schedule_key: due.schedule_key } : t)) } };
}

// ---------- the scanner link ----------
// A scanned payment request (a QR repayment, a billing statement) names a plan: the plan's name appears in the words read. Returns the plan or null.
export function planInText(state, text) {
  const t = String(text ?? "").toLowerCase();
  return (state.schedules ?? []).find((s) => s.kind === "installment" && s.name.trim().length >= 4 && t.includes(s.name.trim().toLowerCase())) ?? null;
}
