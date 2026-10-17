// Statement proof, phase 2: what the statements say about money moving between the owner's OWN accounts, and about pay arriving.
//  - A transfer OUT of one account and the matching money IN to another is ONE move, not spending and not income. `pairMoves` finds them by the bank account
//    a line names (its last four digits), the amount, and the day. A small difference is a fee and is shown, not hidden.
//  - Money in that equals a payslip's deposit near its pay date is the payslip arriving, not new income: `matchPayslips`.
//  - Nothing is added by itself. `planPairedMove` makes ONE draft transfer (source "statement") when the owner taps; a move already in the ledger is not made twice.
// Pure logic; amounts are centavos, dates are "YYYY-MM-DD".
import { accountLines, proveMonths } from "./proof.js";
import { accountByLast4, planTransfer, setAccountLast4 } from "./transfers.js";
import { isPocket, planAccount } from "./banks.js";
import { countedEntries } from "./balances.js";
import { categoryFor } from "./importer.js";
import { applyDrafts, planExpense } from "./drafts.js";
import { planPayReceived } from "./plan.js";
import { categoryFromBook } from "./payees.js";
import { UNLOGGED_CATEGORY_ID } from "./seed.js";

const DAY = 86400000;
const gap = (a, b) => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / DAY));

// Every kept statement line with the account it belongs to, oldest first.
const allLines = (state) => (state.accounts ?? []).flatMap((a) => accountLines(state, a.id).map((l) => ({ ...l, account_id: a.id })));

// Pairs: an OUT line and an IN line in two of your accounts where AT LEAST ONE of them names the other account (by its last four digits), the same amount (the IN may be smaller by a fee up to
// `maxFee`), within `days` of each other. Each line is used once; the closest pair is taken first. Returns {pairs, loneOut, loneIn}: lines that name your own
// account but found no partner (the other statement may not be kept yet).
export function pairMoves(state, { days = 3, maxFee = 10000 } = {}) {
  const lines = allLines(state);
  const outs = lines.filter((l) => l.direction === "out" && (l.meaning === "move" || l.meaning === "unsure"));
  const ins = lines.filter((l) => l.direction === "in" && (l.meaning === "in" || l.meaning === "move"));
  const pointer = (l) => (l.last4 ? accountByLast4(state.accounts, l.last4) : null);   // the account of yours a line names
  // A Go Save pocket and the main account of the same bank name each other only as "Go Save account" / "Deposit account", with no digits: they pair when exactly one
  // of the two accounts is a pocket, the amount is the same and the days are close, and ONLY when the match is the one possibility on both sides (never a guess between pockets).
  const acct = (id) => (state.accounts ?? []).find((a) => a.id === id);
  const goText = (l) => /go\s*save|deposit account/i.test(l.payee || l.text || "");
  const pocketLink = (o, i) => { const ao = acct(o.account_id), ai = acct(i.account_id); return !!(ao && ai && ao.bank && ao.bank === ai.bank && isPocket(ao) !== isPocket(ai) && goText(o) && goText(i)); };
  const cands = [];
  for (const o of outs) {
    const po = pointer(o);
    for (const i of ins) {
      if (i.account_id === o.account_id) continue;
      const pi = pointer(i), viaPocket = !po && !pi && pocketLink(o, i);
      // at least one end names the other account, and neither names a different one
      if ((!po && !pi && !viaPocket) || (po && po.id !== i.account_id) || (pi && pi.id !== o.account_id)) continue;
      const fee = o.amount - i.amount, d = gap(o.date, i.date);
      if (fee < 0 || fee > maxFee || d > days) continue;
      cands.push({ o, i, fee, d, viaPocket, from_id: o.account_id, to_id: i.account_id });
    }
  }
  const ambiguous = new Set(cands.filter((c) => c.viaPocket && (cands.filter((x) => x.viaPocket && x.o === c.o).length > 1 || cands.filter((x) => x.viaPocket && x.i === c.i).length > 1)));   // two pockets could fit: guess nothing
  for (let k = cands.length - 1; k >= 0; k--) if (ambiguous.has(cands[k])) cands.splice(k, 1);
  cands.sort((x, y) => x.d - y.d || x.fee - y.fee);
  const usedOut = new Set(), usedIn = new Set(), pairs = [];
  for (const c of cands) {
    if (usedOut.has(c.o.id) || usedIn.has(c.i.id)) continue;
    usedOut.add(c.o.id); usedIn.add(c.i.id);
    pairs.push({ out: c.o, in: c.i, from_id: c.from_id, to_id: c.to_id, amount: c.i.amount, fee: c.fee, dayGap: c.d });
  }
  pairs.sort((a, b) => a.out.date.localeCompare(b.out.date) || a.out.id.localeCompare(b.out.id));
  return { pairs, loneOut: outs.filter((l) => pointer(l) && !usedOut.has(l.id)), loneIn: ins.filter((l) => pointer(l) && !usedIn.has(l.id)) };
}

// Is a move like this already in the ledger (a transfer between the same two accounts, the same amount, within a few days; a draft counts)?
export function moveLogged(state, pair, { days = 3 } = {}) {
  const dateOf = new Map(state.transactions.map((t) => [t.id, t]));
  const byTx = new Map();
  for (const e of state.entries) if (e.account_id) (byTx.get(e.transaction_id) ?? byTx.set(e.transaction_id, []).get(e.transaction_id)).push(e);
  for (const [id, es] of byTx) {
    const t = dateOf.get(id);
    if (!t || t.reverses || es.length !== 2 || es.some((e) => e.category_id)) continue;
    const to = es.find((e) => e.amount > 0), from = es.find((e) => e.amount < 0);
    if (to && from && to.account_id === pair.to_id && from.account_id === pair.from_id && to.amount === pair.amount && gap(t.date, pair.out.date) <= days) return true;
  }
  return false;
}

// One draft transfer for a pair (the date the money left, the amount that arrived, the fee as its own draft), source "statement". Refused when it is already logged.
export function planPairedMove(state, pair, { newId, now = new Date() }) {
  if (moveLogged(state, pair)) return { ok: false, message: "That move is already in your ledger." };
  const name = (id) => state.accounts.find((a) => a.id === id)?.name ?? "";
  const r = planTransfer(state, { transaction_id: newId(), date: pair.out.date, from_account_id: pair.from_id, to_account_id: pair.to_id, amount: pair.amount, fee: pair.fee,
    payee: `${name(pair.from_id)} to ${name(pair.to_id)}`, source: "statement" }, now);
  return r.ok ? { ok: true, state: r.state } : { ok: false, message: r.violations[0].message };
}

// Money in that is a payslip arriving: the same account, the same amount as the payslip's deposit, within `days` of its pay date. A payslip matches once.
export function matchPayslips(state, { days = 4 } = {}) {
  const slips = [...(state.payslips ?? [])].sort((a, b) => a.pay_date.localeCompare(b.pay_date)), taken = new Set(), out = [];
  for (const l of allLines(state).filter((x) => x.direction === "in")) {
    const p = slips.find((s) => !taken.has(s.id) && s.account_id === l.account_id && s.deposit === l.amount && gap(s.pay_date, l.date) <= days);
    if (p) { taken.add(p.id); out.push({ line: l, payslip: p }); }
  }
  return out;
}

// ---------- phase 3: the ledger against the statement, month by month ----------
const keyOf = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
const lastOf = (month) => { const [y, m] = month.split("-").map(Number); return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };

// For an account that holds money: what the ledger says at the end of a statement month, what the bank's closing balance says, and the lines that explain the
// difference. difference = ledger - statement (positive: the ledger shows more than the bank). A statement line with no ledger entry of the same amount within 2 days
// is "missing"; a ledger movement with no statement line is "extra". explained = extra - missing; what is left is carried from before the month (an opening
// balance that differs, or lines of an earlier month). Drafts count as in the ledger (the balances count them too).
export function statementDifference(state, accountId, month) {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return { ok: false, reason: "There is no such account." };
  if (account.class !== "asset") return { ok: false, reason: "Only accounts that hold money can be compared with a statement (not cards yet)." };
  const row = proveMonths(state, accountId).find((r) => r.month === month);
  if (!row) return { ok: false, reason: "There is no statement for that month." };
  if (row.closing === null) return { ok: false, reason: "This month has no closing balance to compare with." };
  const first = month + "-01", last = lastOf(month);
  const txDate = new Map(state.transactions.map((t) => [t.id, t])), mine = countedEntries(state).filter((e) => e.account_id === accountId);
  const ledgerBalance = account.opening_balance + mine.filter((e) => (txDate.get(e.transaction_id)?.date ?? "") <= last).reduce((n, e) => n + e.amount, 0);
  const byTx = new Map();
  for (const e of mine) { const t = txDate.get(e.transaction_id); if (t && !t.reverses) byTx.set(t.id, { t, amount: (byTx.get(t.id)?.amount ?? 0) + e.amount }); }
  const moves = [...byTx.values()].filter((m) => m.t.date >= addDays(first, -2) && m.t.date <= addDays(last, 2)).map((m) => ({ id: m.t.id, date: m.t.date, payee: m.t.payee, amount: m.amount, used: false }));
  const lines = accountLines(state, accountId).filter((l) => l.date >= first && l.date <= last);
  const missing = [];
  for (const l of lines) {
    const signed = l.direction === "in" ? l.amount : -l.amount;
    const hit = moves.filter((m) => !m.used && m.amount === signed && gap(m.date, l.date) <= 2).sort((a, b) => (keyOf(b.payee) === keyOf(l.payee || l.text)) - (keyOf(a.payee) === keyOf(l.payee || l.text)) || gap(a.date, l.date) - gap(b.date, l.date))[0];
    if (hit) hit.used = true; else missing.push({ line: { ...l, account_id: accountId }, signed, action: l.direction === "out" && (l.meaning === "spending" || l.meaning === "fee") ? "expense" : l.meaning === "unsure" ? "choose" : l.meaning === "move" ? "move" : "in" });
  }
  const extra = moves.filter((m) => !m.used && m.date >= first && m.date <= last);
  const explained = extra.reduce((n, m) => n + m.amount, 0) - missing.reduce((n, m) => n + m.signed, 0), difference = ledgerBalance - row.closing;
  return { ok: true, month, asOf: last, status: row.status, statementClosing: row.closing, ledgerBalance, difference, explained, carried: difference - explained, missing, extra };
}

// One DRAFT for a statement line the ledger lacks, source "statement", never verified by itself:
//  - spending or a fee: an expense in the category the import would choose;
//  - money out that does not say what it was (unsure): an expense in Unlogged, unless the owner already named that payee (Trends, Who);
//  - money in: income in the account, in "Other income" (the first income category when there is none), to be checked in Verify.
// A move between the owner's own accounts is not made here (Phase 2 pairs those). `book` is the owner's payee names.
export function planMissingDraft(state, line, { newId, now = new Date(), book = null }) {
  const name = line.payee || line.text, id = newId();
  if (line.direction === "in" && line.meaning === "in") {
    const income = state.categories.filter((c) => c.kind === "income"), cat = income.find((c) => c.id === "cat-other-income") ?? income[0];
    if (!cat) return { ok: false, message: "There is no income category to put it in." };
    const r = planPayReceived(state, { transaction_id: id, date: line.date, amount: line.amount, account_id: line.account_id, category_id: cat.id, payee: name, source: "statement" }, now);
    return r.ok ? { ok: true, state: r.state, kind: "income" } : { ok: false, message: r.violations[0].message };
  }
  const spend = line.direction === "out" && (line.meaning === "spending" || line.meaning === "fee"), unsure = line.direction === "out" && line.meaning === "unsure";
  if (!spend && !unsure) return { ok: false, message: "Only spending, fees, money in and lines that do not say what they were can be added in one tap." };
  const category_id = spend ? categoryFor(state, { name }, book).category_id : categoryFromBook(state, book, name) ?? UNLOGGED_CATEGORY_ID;
  const r = planExpense(state, { transaction_id: id, date: line.date, payee: name, category_id, amount: line.amount, account_id: line.account_id, source: "statement" }, now);
  return r.ok ? { ok: true, state: applyDrafts(state, r.drafts), kind: "expense" } : { ok: false, message: r.violations[0].message };
}

// Start an account from its statement: the account's opening balance and date become the FIRST statement month's opening balance and the day its statement starts,
// so the ledger and the bank begin together. The first month must be proved. Entries dated before that day become history only (they stop counting in the balance,
// as for any account), and how many is returned so it can be said first.
export function startFromStatement(state, accountId) {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return { ok: false, message: "There is no such account." };
  if (account.class !== "asset") return { ok: false, message: "Only accounts that hold money can start from a statement." };
  const rows = proveMonths(state, accountId), first = rows[0];
  if (!first) return { ok: false, message: "There is no statement for this account." };
  if (first.status !== "proved" || first.opening === null) return { ok: false, message: "The first month must be proved before the account can start from it." };
  const recs = (state.statementRecords ?? []).filter((r) => r.account_id === accountId && r.period_from);
  const from = [...recs.map((r) => r.period_from), accountLines(state, accountId)[0].date].sort()[0];
  const dateOf = new Map(state.transactions.map((t) => [t.id, t.date]));
  const ignored = new Set(state.entries.filter((e) => e.account_id === accountId && (dateOf.get(e.transaction_id) ?? "9") < from).map((e) => e.transaction_id)).size;
  return { ok: true, ignored, from, opening: first.opening, state: { ...state, accounts: state.accounts.map((a) => (a.id === accountId ? { ...a, opening_balance: first.opening, opening_date: from } : a)) } };
}

// A Go Save pocket's statement names only the pocket’s number and GoTyme cannot say which of the owner's pockets that is, so the app makes ONE pocket per
// number ("GoTyme · Go Save ····3002"), ready to be renamed when the owner knows it. A pocket with these digits is never made twice.
// Returns {ok, account, state} like planAccount; opening balance 0 on the statement's first day (Phase 3 can start it from the statement).
export function planPocketFromStatement(state, { id, last4, bank = null, date }) {
  if (!/^\d{4}$/.test(String(last4 ?? ""))) return { ok: false, violations: [{ message: "The statement does not say the last four digits of the pocket." }] };
  if (state.accounts.some((a) => !a.archived && a.last4 === last4)) return { ok: false, violations: [{ message: "You already have an account ending in " + last4 + "." }] };
  const label = "Go Save \u00b7\u00b7\u00b7\u00b7" + last4;
  const made = planAccount(state, { id, kind: "asset", pocket: true, opening: 0, date, ...(bank ? { bank, sub: label } : { name: label }) });
  if (!made.ok) return made;
  const digits = setAccountLast4(made.state, id, last4);
  return digits.ok ? { ok: true, violations: [], account: digits.state.accounts.find((a) => a.id === id), state: digits.state } : digits;
}
