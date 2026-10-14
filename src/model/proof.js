// Statement proof (data version 10). A bank statement is kept as one record with its lines; a month is PROVED when its lines add up to the
// closing balance exactly and its opening balance is the closing balance of the month before. "Accept this month" then turns the spending and
// fee lines of a proved month into VERIFIED entries (source "statement"). Moves, money in and unsure lines are not turned into entries here
// (the next phase matches those); they are counted. Pure logic: the app reads files and saves; every amount is in centavos.
import { applyDrafts, planExpense, verifyDraft } from "./drafts.js";
import { categoryFor } from "./importer.js";
import { phTimestamp } from "./util.js";

const key = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const signed = (l) => (l.direction === "in" ? l.amount : -l.amount);
const lastDay = (month) => { const [y, m] = month.split("-").map(Number); return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
const monthBefore = (month) => { const [y, m] = month.split("-").map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0"); };

// A parsed statement (statement.js parseStatement, ok) as the rows to keep: one record and its lines, ids made from `id`. The statement is kept as read.
export function recordFromParse(parsed, { account_id, id, now = new Date() }) {
  const sum = parsed.summary ?? {}, pick = (...v) => v.find((x) => Number.isSafeInteger(x));
  const record = {
    id, account_id, style: parsed.style, line_count: parsed.lines.length, checked: !!parsed.check?.ok, added_at: phTimestamp(now),
    ...(parsed.bank ? { bank: parsed.bank } : {}),
    ...(parsed.period?.from && parsed.period?.to ? { period_from: parsed.period.from, period_to: parsed.period.to } : {}),
    ...(pick(sum.opening) !== undefined ? { opening: sum.opening } : {}), ...(pick(sum.closing) !== undefined ? { closing: sum.closing } : {}),
    ...(pick(sum.credits, sum.incoming) !== undefined ? { in_total: pick(sum.credits, sum.incoming) } : {}), ...(pick(sum.debits, sum.outgoing) !== undefined ? { out_total: pick(sum.debits, sum.outgoing) } : {}),
  };
  const lines = parsed.lines.map((l, n) => ({
    id: `${id}:${n}`, record_id: id, n, date: l.date, text: l.text ?? "", payee: l.payee ?? l.text ?? "", type: l.type ?? "", amount: l.amount, direction: l.direction,
    ...(Number.isSafeInteger(l.balance) ? { balance: l.balance } : {}), meaning: l.meaning, ...(l.own ? { own: true } : {}), ...(l.last4 ? { last4: l.last4 } : {}),
  }));
  return { record, lines };
}

// The lines of one account across all its statements, oldest first. Two statements that overlap show the same line twice: a line already taken
// from ANOTHER statement is left out (two genuine identical lines inside one statement both stay).
export function accountLines(state, accountId) {
  const ids = new Set((state.statementRecords ?? []).filter((r) => r.account_id === accountId).map((r) => r.id));
  const raw = (state.statementLines ?? []).filter((l) => ids.has(l.record_id)).sort((a, b) => a.date.localeCompare(b.date) || a.record_id.localeCompare(b.record_id) || a.n - b.n);
  const owner = new Map(), out = [];
  for (const l of raw) {
    const k = [l.date, l.text, l.amount, l.direction, l.balance ?? ""].join("|");
    if (owner.has(k) && owner.get(k) !== l.record_id) continue;
    owner.set(k, l.record_id); out.push(l);
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
// A first statement that starts from a ZERO balance (the account was opened that day): nothing came before it, so it covers its first month in full even though its period starts mid-month.
const firstFromZero = (records, r) => r.opening === 0 && r.period_from && !records.some((x) => x.period_from && x.period_from < r.period_from);
const coversWhole = (records, r, month) => r.period_to === lastDay(month) && (r.period_from === month + "-01" || (firstFromZero(records, r) && r.period_from.slice(0, 7) === month));
// Why a month has nothing to be checked against: the statement does not cover all of it, or it covers it but prints no balance on each line.
function noBalanceReason(records, month) {
  const first = month + "-01", last = lastDay(month), over = records.find((r) => r.period_from && r.period_to && r.period_from <= last && r.period_to >= first);
  if (!over) return "This statement has no balances to check this month against.";
  if (!coversWhole(records, over, month) && (over.period_from > first || over.period_to < last)) return `The statement runs from ${shortDate(over.period_from)} to ${shortDate(over.period_to)}, so this month is only partly covered.`;
  return `The statement has no balance on each line, so this month cannot be proved on its own (it covers ${shortDate(over.period_from)} to ${shortDate(over.period_to)}).`;
}

// Every month an account has statement lines for, with its proof. status:
//   "proved"     the lines add up to the closing balance and the opening is the closing of the month before (or it is the first month).
//   "broken"     the lines do not add up, or a line does not follow from the balance before it.
//   "mismatch"   the opening is not the closing of the month before.
//   "gap"        the month before has no statement, so the opening cannot be checked.
//   "no-balance" the statement has no balances to prove this month with.
// Each: {month, opening, closing, moneyIn, moneyOut, count, status, reason, accepted}.
export function proveMonths(state, accountId) {
  const lines = accountLines(state, accountId), records = (state.statementRecords ?? []).filter((r) => r.account_id === accountId);
  const accepted = new Set((state.statementAccepts ?? []).filter((a) => a.account_id === accountId).map((a) => a.month));
  const months = [...new Set(lines.map((l) => l.date.slice(0, 7)))].sort();
  const out = [];
  for (const month of months) {
    const ml = lines.filter((l) => l.date.slice(0, 7) === month);
    const moneyIn = ml.filter((l) => l.direction === "in").reduce((n, l) => n + l.amount, 0), moneyOut = ml.filter((l) => l.direction === "out").reduce((n, l) => n + l.amount, 0);
    const row = { month, opening: null, closing: null, moneyIn, moneyOut, count: ml.length, status: "no-balance", reason: noBalanceReason(records, month), accepted: accepted.has(month) };
    const whole = records.find((r) => coversWhole(records, r, month) && Number.isSafeInteger(r.opening) && Number.isSafeInteger(r.closing));
    if (ml.every((l) => Number.isSafeInteger(l.balance))) {
      row.opening = ml[0].balance - signed(ml[0]); row.closing = ml[ml.length - 1].balance;
      const bad = ml.filter((l, i) => (i === 0 ? row.opening : ml[i - 1].balance) + signed(l) !== l.balance).length;
      if (bad) Object.assign(row, { status: "broken", reason: `${bad} ${bad === 1 ? "line does" : "lines do"} not follow from the balance before it.` });
      else if (whole && (whole.opening !== row.opening || whole.closing !== row.closing)) Object.assign(row, { status: "broken", reason: "The balances on the lines do not match the opening and closing balance printed at the top." });
      else row.status = "proved";
    } else if (whole) { row.opening = whole.opening; row.closing = whole.closing; row.status = "proved"; }
    if (row.status === "proved" && row.opening + moneyIn - moneyOut !== row.closing) Object.assign(row, { status: "broken", reason: "The lines do not add up to the closing balance." });
    out.push(row);
  }
  // The chain: each month opens where the one before closed. A month between with no lines is QUIET (nothing happened) when a statement covers it in full
  // (its period spans the whole month); with no statement over it, it is a GAP, and everything after it cannot be checked until that month is added.
  const covers = (month) => records.some((r) => r.period_from && r.period_to && r.period_from <= month + "-01" && r.period_to >= lastDay(month));
  const byMonth = new Map(out.map((r) => [r.month, r]));
  out.forEach((row, i) => {
    if (row.status !== "proved" || i === 0) return;
    let m = monthBefore(row.month), quiet = 0, before = byMonth.get(m);
    while (!before && covers(m) && m > out[0].month) { quiet++; m = monthBefore(m); before = byMonth.get(m); }
    if (!before) { Object.assign(row, { status: "gap", reason: "The month before has no statement, so the opening balance cannot be checked." }); return; }
    if (before.closing !== null && before.closing !== row.opening) { Object.assign(row, { status: "mismatch", reason: "This month opens with a different balance than the month before closed with." }); return; }
    row.reason = quiet ? `The lines add up to the closing balance, and the opening matches the last month with activity (${quiet === 1 ? "one month" : quiet + " months"} between had none).` : "The lines add up to the closing balance, and the opening matches the month before.";
  });
  out.forEach((row) => { if (row.status === "proved" && row === out[0]) row.reason = "The lines add up to the closing balance. This is the first month, so it starts here."; });
  return out;
}

// Accepting a proved month: its spending and fee lines become VERIFIED entries (source "statement"), in the category the import would choose.
// A line already in the ledger (same date, name and amount) is not made twice: a draft of it is verified, a verified one is left as it is.
// Nothing is changed unless the whole month goes through. Returns {ok, state, made, verified, alreadyLogged, leftOut:{moves, moneyIn, unsure}} or {ok:false, message}.
export function acceptMonth(state, accountId, month, { newId, now = new Date() }) {
  const row = proveMonths(state, accountId).find((r) => r.month === month);
  if (!row) return { ok: false, message: "There is no statement for that month." };
  if (row.accepted) return { ok: false, message: "That month was already accepted." };
  if (row.status !== "proved") return { ok: false, message: "That month is not proved: " + row.reason };
  const ml = accountLines(state, accountId).filter((l) => l.date.slice(0, 7) === month);
  const spend = ml.filter((l) => l.direction === "out" && (l.meaning === "spending" || l.meaning === "fee"));
  const leftOut = { moves: ml.filter((l) => l.meaning === "move").length, moneyIn: ml.filter((l) => l.meaning === "in").length, unsure: ml.filter((l) => l.meaning === "unsure").length };
  const amountOf = (t, s) => s.entries.find((e) => e.transaction_id === t.id && e.category_id)?.amount;
  let next = state, made = 0, verified = 0, alreadyLogged = 0;
  const used = new Set();
  for (const l of spend) {
    const name = l.payee || l.text, item = { name };
    const same = next.transactions.find((t) => !used.has(t.id) && t.date === l.date && key(t.payee) === key(name) && amountOf(t, next) === l.amount && !t.reverses);
    if (same) {
      used.add(same.id);
      if (same.status === "draft") { const v = verifyDraft(next, same.id, now); if (!v.ok) return { ok: false, message: `${name} (${l.date}): ${v.violations[0].message}` }; next = v.state; verified++; } else alreadyLogged++;
      continue;
    }
    const id = newId(), r = planExpense(next, { transaction_id: id, date: l.date, payee: name, category_id: categoryFor(next, item).category_id, amount: l.amount, account_id: accountId, source: "statement" }, now);
    if (!r.ok) return { ok: false, message: `${name} (${l.date}): ${r.violations[0].message}` };
    next = applyDrafts(next, r.drafts);
    const v = verifyDraft(next, id, now);
    if (!v.ok) return { ok: false, message: `${name} (${l.date}): ${v.violations[0].message}` };
    next = v.state; used.add(id); made++;
  }
  next = { ...next, statementAccepts: [...(next.statementAccepts ?? []), { id: newId(), account_id: accountId, month, made, verified, accepted_at: phTimestamp(now) }] };
  return { ok: true, state: next, made, verified, alreadyLogged, leftOut };
}

// What the month window shows before "Accept this month": the proof, and how the month's lines divide. spend: the lines that would become entries (spending and fees),
// with how many are already in the ledger; leftOut: moves, money in and unsure lines (counted, not made into entries here).
export function monthSummary(state, accountId, month) {
  const row = proveMonths(state, accountId).find((r) => r.month === month);
  if (!row) return null;
  const ml = accountLines(state, accountId).filter((l) => l.date.slice(0, 7) === month), sum = (xs) => xs.reduce((n, l) => n + l.amount, 0);
  const spend = ml.filter((l) => l.direction === "out" && (l.meaning === "spending" || l.meaning === "fee")), rest = ml.filter((l) => !spend.includes(l));
  const logged = new Set(state.transactions.map((t) => `${t.date}|${key(t.payee)}|${state.entries.find((e) => e.transaction_id === t.id && e.category_id)?.amount}`));
  const already = spend.filter((l) => logged.has(`${l.date}|${key(l.payee || l.text)}|${l.amount}`)).length;
  return { row, spend: { count: spend.length, total: sum(spend), already },
    leftOut: { count: rest.length, total: sum(rest), moves: rest.filter((l) => l.meaning === "move").length, moneyIn: rest.filter((l) => l.meaning === "in").length, unsure: rest.filter((l) => l.meaning === "unsure").length } };
}

// The same statement twice (the same account, period and lines) is kept once.
export function alreadyKept(state, record, lines) {
  const mine = (state.statementRecords ?? []).filter((r) => r.account_id === record.account_id && r.period_from === record.period_from && r.period_to === record.period_to && r.line_count === record.line_count);
  const sig = (ls) => ls.map((l) => [l.date, l.amount, l.direction, l.balance ?? ""].join("|")).join(";");
  return mine.some((r) => sig((state.statementLines ?? []).filter((l) => l.record_id === r.id).sort((a, b) => a.n - b.n)) === sig(lines));
}

// A kept statement, with its lines, can be removed when no month it touches has been accepted (a statement filed under the wrong account, or kept twice).
// It never touches an entry or a draft: it is only the proof record.
export function removeStatement(state, recordId) {
  const r = (state.statementRecords ?? []).find((x) => x.id === recordId);
  if (!r) return { ok: false, message: "That statement is not kept." };
  const months = new Set((state.statementLines ?? []).filter((l) => l.record_id === recordId).map((l) => l.date.slice(0, 7)));
  const blocked = (state.statementAccepts ?? []).some((a) => a.account_id === r.account_id && months.has(a.month));
  if (blocked) return { ok: false, message: "A month from this statement was accepted, so it stays." };
  return { ok: true, state: { ...state, statementRecords: state.statementRecords.filter((x) => x.id !== recordId), statementLines: (state.statementLines ?? []).filter((l) => l.record_id !== recordId) } };
}
