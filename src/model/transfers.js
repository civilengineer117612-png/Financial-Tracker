// Money moved between the owner's own accounts, read from a payment screenshot. Pure and tested; the photo never reaches this file.
//
// RULES (owner's design):
//  - An end is "one of my accounts" ONLY when its last four digits match an account's saved last four. NEVER by a name or surname:
//    a relative can share the surname.
//  - GCash and Maya screens do not name the owner. When one end is unknown, the app asks "Is the other end one of your accounts?" ONCE per
//    recipient and remembers the answer (settings `own_recipients`: recipient key -> account id, or "" for "not mine"), like payee rules.
//  - A withdrawal (withdraw, cash out, ATM) is a transfer from the bank or wallet to Cash on hand; a cash deposit is the reverse.
//  - A fee is its own expense draft in "Bank fees", tied to the transfer by its id (fee:<id>), verified and deleted with it.
//  - When it cannot tell, it says so ("Transfer or expense? Choose"). It never defaults either way.
import { amountsIn } from "./scan.js";
import { checkTransactionSave } from "./index.js";
import { phTimestamp } from "./util.js";

export const FEE_PREFIX = "fee:";
export const BANK_FEES_ROLE = "bank_fees";
export const isFeeId = (id) => String(id).startsWith(FEE_PREFIX);
export const feeIdOf = (id) => FEE_PREFIX + id;

// What a move can be called in the scan window (kept apart from scan.js KINDS, whose order decides ties between kinds of paper).
export const MOVE_KINDS = [
  { id: "transfer", label: "Transfer between my accounts", direction: "move" },
  { id: "withdrawal", label: "Cash withdrawal", direction: "move" },
  { id: "deposit", label: "Cash deposit", direction: "move" },
];
export const CHOOSE_MESSAGE = "Transfer or expense? Choose";

const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }] });

// ---------- last four digits ----------
export const normalizeLast4 = (v) => { const s = String(v ?? "").trim(); return /^\d{4}$/.test(s) ? s : ""; };

// The one account that holds these four digits; nothing when none does or when two do (never a guess).
export function accountByLast4(accounts, last4) {
  const l4 = normalizeLast4(last4);
  if (!l4) return null;
  const hits = (accounts ?? []).filter((a) => !a.archived && a.last4 === l4);
  return hits.length === 1 ? hits[0] : null;
}

// Four digits only, and not the same four on two accounts (then a screenshot could not tell them apart).
export function setAccountLast4(state, accountId, value) {
  const a = state.accounts.find((x) => x.id === accountId);
  if (!a) return fail("UNKNOWN_ACCOUNT", "no account " + accountId);
  const raw = String(value ?? "").trim();
  if (raw !== "" && !/^\d{4}$/.test(raw)) return fail("BAD_LAST4", "Type exactly the last 4 digits of the account number, or leave it empty.");
  if (raw !== "" && state.accounts.some((x) => x.id !== accountId && !x.archived && x.last4 === raw)) return fail("DUPLICATE_LAST4", "Another account already has these 4 digits.");
  return { ok: true, violations: [], state: { ...state, accounts: state.accounts.map((x) => (x.id === accountId ? { ...x, last4: raw } : x)) } };
}

// ---------- reading the screenshot ----------
const MASKED = /(?:[*\u2022\u25CF]+|\b[xX]{2,})[\s*\u2022\u25CFxX.-]*?(\d{4})(?!\d)/;
const ENDING = /\bending\s*(?:in|with)?\s*[:#]?\s*(\d{4})(?!\d)/i;
const ACCT = /\b(?:acct|account)\.?\s*(?:no\.?|number|#)?\s*[:#]?\s*[\d*•●xX\s-]*?(\d{4})(?!\d)\s*$/i;
export function last4In(text) {
  const s = String(text ?? "");
  return s.match(MASKED)?.[1] ?? s.match(ENDING)?.[1] ?? s.match(ACCT)?.[1] ?? "";
}

// A recipient's identity for "ask once": a mobile number (09.. or +63..), else the name's letters. "" when there is none. It is used only to
// REMEMBER an answer the owner gave, never to decide on its own that something is an own account.
export function recipientKey(text) {
  const s = String(text ?? "");
  const digits = s.replace(/[\s()-]/g, "");
  const mobile = digits.match(/(?:\+?63|0)(9\d{9})(?!\d)/);
  if (mobile) return "0" + mobile[1];
  const letters = s.replace(/[^A-Za-zÀ-ɏ ]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return letters.length >= 3 ? letters : "";
}

const FROM_LABEL = /^(?:from|source|sender|debit(?:ed)?(?:\s+from)?|paid\s+from|withdraw(?:n)?\s+from|account\s+debited)\b\s*[:\-]?\s*/i;
const TO_LABEL = /^(?:to|send\s+to|sent\s+to|recipient|receiver|beneficiary|credit(?:ed)?(?:\s+to)?|destination|transfer(?:red)?\s+to|account\s+credited)\b\s*[:\-]?\s*/i;
const CURRENCIES = "USD|EUR|JPY|SGD|HKD|AUD|CAD|GBP|KRW|AED|SAR|CNY|THB|MYR|TWD|CHF|NZD";

// Time on the paper as 24-hour "HH:MM" ("" when there is none).
function timeIn(text) {
  const m = String(text ?? "").match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\b/i);
  if (!m) return "";
  let h = Number(m[1]); const mi = Number(m[2]);
  if (m[3]) { const pm = m[3].toLowerCase() === "pm"; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return h <= 23 && mi <= 59 ? String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0") : "";
}

// What a screenshot says about a move of money. Everything is a guess for the owner to check.
// Returns {words, kind, amount, fee, reference, time, from, to, foreign, notes}; kind is "transfer" | "withdrawal" | "deposit" | null.
export function readMove(text) {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lower = raw.toLowerCase();
  const withdrawal = /withdraw|cash[\s-]*out|\batm\b/.test(lower);
  const deposit = !withdrawal && /cash[\s-]*in\b|cash\s*deposit|deposited\s+(?:to|into)/.test(lower);
  const words = /transfer|send\s*money|sent\s+(?:to|via)|express\s*send|insta\s*pay|pesonet/.test(lower);
  const kind = withdrawal ? "withdrawal" : deposit ? "deposit" : words ? "transfer" : null;

  const ends = { from: null, to: null };
  for (let i = 0; i < lines.length; i++) {
    const side = FROM_LABEL.test(lines[i]) ? "from" : TO_LABEL.test(lines[i]) ? "to" : null;
    if (!side || ends[side]) continue;
    let payload = lines[i].replace(side === "from" ? FROM_LABEL : TO_LABEL, "").trim();
    if (payload.replace(/[^A-Za-z0-9]/g, "").length < 3 && lines[i + 1] && !FROM_LABEL.test(lines[i + 1]) && !TO_LABEL.test(lines[i + 1])) payload = lines[i + 1];
    if (payload.replace(/[^A-Za-z0-9*•●]/g, "").length < 2) continue;
    ends[side] = { raw: payload, last4: last4In(payload), key: recipientKey(payload) };
  }

  // amounts: "Amount" is the money moved, "Fee" is extra, "Total" is both. The moved amount is never the total when a fee is shown.
  let amount = null, fee = null, total = null;
  for (const l of lines) {
    const found = amountsIn(l);
    if (!found.length) continue;
    if (/\bfee\b|charge/i.test(l)) fee ??= found[0];
    else if (/\btotal\b/i.test(l)) total ??= found[found.length - 1];
    else if (amount === null && /\b(amount|sent|send|withdraw(?:n|al)?|cash[\s-]*(?:out|in)|deposit(?:ed)?|transfer(?:red)?)\b/i.test(l)) amount = found[0];
  }
  if (amount === null && total !== null) amount = fee !== null && total > fee ? total - fee : total;
  const notes = [];
  if (amount === null) {
    const all = lines.flatMap((l) => (/fee|charge|balance|total/i.test(l) ? [] : amountsIn(l)));
    if (all.length) { amount = Math.max(...all); notes.push("There was no line marked Amount, so I took the biggest figure. Check it."); }
  }

  const refRaw = raw.match(/\bref(?:erence)?\.?\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9]+(?:[ -][0-9]{2,})*)/i)?.[1] ?? "", ref = refRaw.replace(/[\s-]+/g, "").length >= 6 ? refRaw.replace(/[\s-]+/g, "") : "";
  const fm = raw.match(new RegExp("\\b(" + CURRENCIES + ")\\s*([\\d,]+\\.\\d{2})\\b", "i")) ?? raw.match(/\$\s*([\d,]+\.\d{2})\b/);
  const foreign = fm ? (fm.length === 3 ? { currency: fm[1].toUpperCase(), amount: Math.round(Number(fm[2].replace(/,/g, "")) * 100) } : { currency: "USD", amount: Math.round(Number(fm[1].replace(/,/g, "")) * 100) }) : null;
  if (foreign && amount === foreign.amount) { amount = null; notes.push("The paper shows " + foreign.currency + " " + (foreign.amount / 100).toFixed(2) + ". Type the peso amount your bank took."); }
  return { words: kind !== null, kind, amount, fee, reference: ref, time: timeIn(raw), from: ends.from, to: ends.to, foreign, notes };
}

// What to do with a read move. Own accounts are told by last four digits only; the rest comes from the owner's remembered answers.
//   result "transfer": both ends are known accounts            -> from_id, to_id
//   result "ask":      one end is unknown and never answered    -> ask {key, label}
//   result "expense":  the owner said before this recipient is not theirs
//   result "unsure":   it cannot tell                           -> the draft says "Transfer or expense? Choose"
// accounts: the owner's accounts; cashId: the Cash on hand account (or null); recipients: settings.own_recipients.
export function classifyMove(read, { accounts, cashId = null, recipients = {} }) {
  if (!read?.kind) return { result: "unsure", from_id: null, to_id: null, ask: null, why: CHOOSE_MESSAGE };
  const fromA = read.from ? accountByLast4(accounts, read.from.last4) : null, toA = read.to ? accountByLast4(accounts, read.to.last4) : null;
  if (read.kind === "withdrawal") return cashId ? { result: "transfer", from_id: fromA?.id ?? null, to_id: cashId, ask: null, why: "" } : { result: "unsure", from_id: fromA?.id ?? null, to_id: null, ask: null, why: CHOOSE_MESSAGE };
  if (read.kind === "deposit") return cashId ? { result: "transfer", from_id: cashId, to_id: toA?.id ?? null, ask: null, why: "" } : { result: "unsure", from_id: null, to_id: toA?.id ?? null, ask: null, why: CHOOSE_MESSAGE };
  if (fromA && toA && fromA.id !== toA.id) return { result: "transfer", from_id: fromA.id, to_id: toA.id, ask: null, why: "" };
  // One end known, the other not: ask once per recipient. Neither known and nothing to name: say so.
  const known = fromA ?? toA, other = known === fromA ? read.to : read.from;
  const key = other?.key || (other?.last4 ? "acct" + other.last4 : "");
  if (!known || !other || !key) return { result: "unsure", from_id: fromA?.id ?? null, to_id: toA?.id ?? null, ask: null, why: CHOOSE_MESSAGE };
  const said = recipients[key];
  if (said === "") return { result: "expense", from_id: null, to_id: null, ask: null, why: "" };
  if (said && accounts.some((a) => a.id === said && !a.archived)) return { result: "transfer", from_id: known === fromA ? fromA.id : said, to_id: known === fromA ? said : toA.id, ask: null, why: "" };
  return { result: "ask", from_id: fromA?.id ?? null, to_id: toA?.id ?? null, ask: { key, label: other.raw, known_side: known === fromA ? "from" : "to" }, why: "Is the other end one of your accounts?" };
}

// The settings value after the owner answers: yes (an account id) or no ("").
export const rememberRecipient = (recipients, key, accountId) => ({ ...(recipients ?? {}), [key]: accountId ?? "" });

// ---------- bank fees ----------
// The category fees go to: the one with the role "bank_fees"; made on first use. Nothing finds it by name.
export function ensureBankFees(state) {
  const have = state.categories.find((c) => c.role === BANK_FEES_ROLE && c.kind === "expense");
  if (have) return { state, category_id: have.id };
  const id = "cat-bank-fees";
  return { state: { ...state, categories: [...state.categories, { id, name: "Bank fees", kind: "expense", role: BANK_FEES_ROLE }] }, category_id: id };
}

// ---------- the drafts ----------
// input: {transaction_id, date, from_account_id, to_account_id, amount, fee?, payee?, reference_no?, shot_time?, foreign?: {currency, amount}, trip_id?}
// Returns {ok, violations, state}: the transfer draft (source "photo"), its fee draft when there is a fee, and the foreign amount when there is one.
// The caller attaches the photo to the transfer.
export function planTransfer(state, input, now = new Date()) {
  const { transaction_id: id, date, from_account_id: from, to_account_id: to, amount, fee = 0, payee = "", reference_no = "", shot_time = "", foreign = null, trip_id = null, source = "photo" } = input;
  if (source !== "photo" && source !== "manual") return fail("BAD_SOURCE", "unsupported source " + source);
  const captured = source === "photo";   // only a photo draft records whether it was fixed before verifying (survey Q4)
  if (trip_id != null && !(state.tags ?? []).some((t) => t.id === trip_id)) return fail("UNKNOWN_TAG", "no trip " + trip_id);
  if (!Number.isSafeInteger(amount) || amount <= 0) return fail("BAD_AMOUNT", "amount must be more than zero");
  if (!Number.isSafeInteger(fee) || fee < 0) return fail("BAD_FEE", "the fee cannot be negative");
  if (from === to) return fail("SAME_ACCOUNT", "choose two different accounts");
  if (!state.accounts.some((a) => a.id === from) || !state.accounts.some((a) => a.id === to)) return fail("UNKNOWN_ACCOUNT", "choose both accounts");
  const transaction = { id, date, payee, memo: "", status: "draft", source, ...(captured ? { edited_before_verify: false } : {}), created_at: phTimestamp(now),
    ...(reference_no ? { reference_no } : {}), ...(shot_time ? { shot_time } : {}), ...(trip_id != null ? { trip_add: trip_id } : {}) };
  const entries = [{ transaction_id: id, account_id: to, amount }, { transaction_id: id, account_id: from, amount: -amount }];
  const check = checkTransactionSave(state, { transaction, entries });
  if (!check.ok) return { ok: false, violations: check.violations, state };
  let next = { ...state, transactions: [...state.transactions.filter((t) => t.id !== id), transaction], entries: [...state.entries.filter((e) => e.transaction_id !== id), ...entries] };
  if (fee > 0) {
    const made = ensureBankFees(next); next = made.state;
    const fid = feeIdOf(id), ft = { id: fid, date, payee: "Fee", memo: "", status: "draft", source, ...(captured ? { edited_before_verify: false } : {}), created_at: phTimestamp(now), ...(trip_id != null ? { trip_add: trip_id } : {}) };
    const fes = [{ transaction_id: fid, category_id: made.category_id, amount: fee }, { transaction_id: fid, account_id: from, amount: -fee }];
    const fc = checkTransactionSave(next, { transaction: ft, entries: fes });
    if (!fc.ok) return { ok: false, violations: fc.violations, state };
    next = { ...next, transactions: [...next.transactions.filter((t) => t.id !== fid), ft], entries: [...next.entries.filter((e) => e.transaction_id !== fid), ...fes] };
  }
  if (foreign && foreign.amount > 0) {
    next = { ...next, foreignAmounts: [...(next.foreignAmounts ?? []).filter((f) => f.transaction_id !== id), { transaction_id: id, currency: foreign.currency, foreign_amount: foreign.amount, rate: amount / foreign.amount }] };
  }
  return { ok: true, violations: check.violations, state: next };
}

// The fee draft that belongs to a transfer, and its amount (0 when none).
export const feeOf = (state, id) => {
  const t = state.transactions.find((x) => x.id === feeIdOf(id));
  const e = t ? state.entries.find((x) => x.transaction_id === t.id && x.category_id != null) : null;
  return { transaction: t ?? null, amount: e?.amount ?? 0 };
};
// The peso rate of the newest foreign amount in this currency (pesos per unit), or null: shown as a hint when the paper has no peso figure. Never filled in for you.
export function lastRate(state, currency) {
  const dated = (state.foreignAmounts ?? []).filter((f) => f.currency === currency).map((f) => ({ f, date: state.transactions.find((t) => t.id === f.transaction_id)?.date ?? "" })).sort((a, b) => (a.date < b.date ? 1 : -1));
  return dated.length ? dated[0].f.rate : null;
}
export const foreignOf = (state, id) => (state.foreignAmounts ?? []).find((f) => f.transaction_id === id) ?? null;

// Edit a transfer draft before it is verified: both accounts, the amount, the fee, the date, the name. The peso amount of a foreign one is
// corrected here, and its rate follows. The photo stays with the transfer.
// changes: {from_account_id?, to_account_id?, amount?, fee?, date?, payee?}
export function editTransfer(state, id, changes, now = new Date()) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return fail("UNKNOWN_TRANSACTION", "no transaction " + id);
  if (t.status !== "draft") return fail("NOT_A_DRAFT", id + " is already verified");
  const es = state.entries.filter((e) => e.transaction_id === id);
  if (es.length !== 2 || es.some((e) => e.account_id == null)) return fail("NOT_A_TRANSFER", "this entry is not a transfer");
  if (t.source !== "photo" && t.source !== "manual") return fail("NOT_EDITABLE", "only a photo or typed transfer can be changed here");
  const old = { from: es.find((e) => e.amount < 0), to: es.find((e) => e.amount > 0) };
  const edited = (changes.amount !== undefined && changes.amount !== old.to.amount) || (changes.from_account_id ?? old.from.account_id) !== old.from.account_id
    || (changes.to_account_id ?? old.to.account_id) !== old.to.account_id || (changes.date ?? t.date) !== t.date || (changes.payee ?? t.payee) !== t.payee || (changes.fee !== undefined && changes.fee !== feeOf(state, id).amount);
  const amount = changes.amount ?? old.to.amount;
  const base = { ...state, transactions: state.transactions.filter((x) => x.id !== id && x.id !== feeIdOf(id)), entries: state.entries.filter((e) => e.transaction_id !== id && e.transaction_id !== feeIdOf(id)) };
  const planned = planTransfer(base, { transaction_id: id, date: changes.date ?? t.date, from_account_id: changes.from_account_id ?? old.from.account_id, to_account_id: changes.to_account_id ?? old.to.account_id,
    amount, fee: changes.fee ?? feeOf(state, id).amount, payee: changes.payee ?? t.payee, reference_no: t.reference_no ?? "", shot_time: t.shot_time ?? "", foreign: null, trip_id: t.trip_add ?? null, source: t.source === "manual" ? "manual" : "photo" }, now);
  if (!planned.ok) return { ok: false, violations: planned.violations, state };
  const kept = (state.foreignAmounts ?? []).find((f) => f.transaction_id === id);
  const tx = planned.state.transactions.find((x) => x.id === id);
  tx.created_at = t.created_at;
  if (tx.source === "photo") tx.edited_before_verify = t.edited_before_verify === true || edited;
  const ftx = planned.state.transactions.find((x) => x.id === feeIdOf(id));
  const ft0 = state.transactions.find((x) => x.id === feeIdOf(id));
  if (ftx && ft0) { ftx.created_at = ft0.created_at; if (ftx.source === "photo") ftx.edited_before_verify = ft0.edited_before_verify === true || edited; }
  const foreignAmounts = [...(state.foreignAmounts ?? []).filter((f) => f.transaction_id !== id), ...(kept ? [{ ...kept, rate: amount / kept.foreign_amount }] : [])];
  return { ok: true, violations: planned.violations, state: { ...planned.state, foreignAmounts, attachments: state.attachments ?? [] } };
}
