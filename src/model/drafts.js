// Everything the Log and Verify screens do to drafts, as pure functions: each takes a state and
// returns a NEW state, so a screen only swaps in the result when `ok` is true.
import { checkTransactionSave } from "./index.js";
import { planReserveTransfer } from "./templates.js";
import { verifyTransaction } from "./inbox.js";
import { phTimestamp } from "./util.js";
import { validateShape } from "./schema.js";

const fail = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }], drafts: [] });
const EXPENSE_SOURCES = ["manual", "preset", "template", "photo", "voice", "import"];
const partnerId = (id) => "rsv:" + id;   // the generated card reserve transfer (templates.js)
const partnerIds = (id) => [partnerId(id), "fee:" + id];   // and the fee draft that belongs to a scanned transfer (transfers.js)

export function applyDrafts(state, drafts) {
  const ids = new Set(drafts.map((d) => d.transaction.id));
  return {
    ...state,
    transactions: [...state.transactions.filter((t) => !ids.has(t.id)), ...drafts.map((d) => d.transaction)],
    entries: [...state.entries.filter((e) => !ids.has(e.transaction_id)), ...drafts.flatMap((d) => d.entries)],
  };
}

// An expense paid from one account becomes a DRAFT (spec 8.1). Paid by a card with a reserve
// set up, a draft reserve transfer is generated alongside it. Warnings never block saving.
// input: {transaction_id, date, payee?, category_id, amount, account_id, source?, memo?, reserve_source_id?, tag_id?}
export function planExpense(state, input, now = new Date()) {
  const { transaction_id: id, date, payee = "", category_id, amount, account_id, source = "manual", memo = "", reserve_source_id, tag_id, reference_no = "", shot_time = "" } = input;
  if (!Number.isSafeInteger(amount) || amount <= 0) return fail("BAD_AMOUNT", "amount must be more than zero");
  const account = state.accounts.find((a) => a.id === account_id);
  if (!account) return fail("UNKNOWN_ACCOUNT", "no account " + account_id);
  const category = state.categories.find((c) => c.id === category_id);
  if (!category || category.kind !== "expense") return fail("UNKNOWN_CATEGORY", "no expense category " + category_id);
  if (!EXPENSE_SOURCES.includes(source)) return fail("BAD_SOURCE", "unsupported source " + source);

  if (tag_id != null && !(state.tags ?? []).some((t) => t.id === tag_id)) return fail("UNKNOWN_TAG", "no tag " + tag_id);

  const transaction = { id, date, payee, memo, status: "draft", source, created_at: phTimestamp(now), ...(source === "photo" || source === "voice" ? { edited_before_verify: false } : {}), ...(tag_id != null ? { trip_add: tag_id } : {}), ...(reference_no ? { reference_no } : {}), ...(shot_time ? { shot_time } : {}) };
  const entries = [
    { transaction_id: id, category_id, amount },
    { transaction_id: id, account_id, amount: -amount, ...(account.class === "liability" ? { card_state: "pending" } : {}) },
  ];
  const drafts = [{ transaction, entries }];
  let probe = state;
  if (account.class === "liability" && reserve_source_id) {
    for (const r of planReserveTransfer(state, { transaction, entries }, reserve_source_id, now)) {
      if (!r.ok) return { ok: false, violations: r.violations, drafts: [] };
      drafts.push({ transaction: r.transaction, entries: r.entries });
    }
    probe = applyDrafts(state, drafts.slice(1));   // judge the purchase WITH its reserve transfer in place
  }
  const result = checkTransactionSave(probe, { transaction, entries });
  return { ok: result.ok, violations: result.violations, drafts };
}

// Removes a draft and its generated reserve transfer. Verified transactions are never removed.
export function discardDraft(state, id) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return { ok: false, violations: fail("UNKNOWN_TRANSACTION", "no transaction " + id).violations, state };
  if (t.status !== "draft") return { ok: false, violations: fail("NOT_A_DRAFT", id + " is already verified").violations, state };
  const gone = new Set([id, ...state.transactions.filter((x) => partnerIds(id).includes(x.id) && x.status === "draft").map((x) => x.id)]);
  return {
    ok: true, violations: [],
    // The photo goes with its draft (the caller deletes the picture file itself, see attachmentsFor).
    state: { ...state, transactions: state.transactions.filter((x) => !gone.has(x.id)), entries: state.entries.filter((e) => !gone.has(e.transaction_id)), ...(state.foreignAmounts ? { foreignAmounts: state.foreignAmounts.filter((f) => !gone.has(f.transaction_id)) } : {}), attachments: (state.attachments ?? []).filter((a) => !gone.has(a.transaction_id)) },
  };
}

// Verifying a purchase also verifies its generated reserve transfer: that one is mechanical,
// so you look at it once, as part of the purchase.
export function verifyDraft(state, id, now = new Date()) {
  const main = verifyTransaction(state, id, now);
  if (!main.ok) return { ok: false, violations: main.violations, state };
  const swap = new Map([[id, main.transaction]]);
  for (const partner of state.transactions.filter((x) => partnerIds(id).includes(x.id) && x.status === "draft")) {
    const p = verifyTransaction(state, partner.id, now);
    if (p.ok) swap.set(partner.id, p.transaction);
  }
  return { ok: true, violations: [], state: { ...state, transactions: state.transactions.map((t) => swap.get(t.id) ?? t) } };
}

// Edit a draft before verifying it. Expense drafts (one category entry, one account entry) can
// change amount, category, account, date and payee. Other drafts (transfers, sweeps,
// reconciliations) can change date and payee, and amount only when they have exactly two entries.
// changes: {amount?, category_id?, account_id?, date?, payee?}
export function editDraftFields(state, id, changes, { reserve_source_id } = {}, now = new Date()) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return { ok: false, violations: fail("UNKNOWN_TRANSACTION", "no transaction " + id).violations, state };
  if (t.status !== "draft") return { ok: false, violations: fail("NOT_A_DRAFT", id + " is already verified").violations, state };
  const entries = state.entries.filter((e) => e.transaction_id === id);
  const cat = entries.find((e) => e.category_id != null), acct = entries.find((e) => e.account_id != null);
  const isExpense = entries.length === 2 && cat && acct && EXPENSE_SOURCES.includes(t.source) && !id.startsWith("rsv:") && !id.startsWith("fee:") && state.categories.find((c) => c.id === cat.category_id)?.kind === "expense";

  // A scheduled payment with an interest part has three lines (the plan's category, interest and fees, the account): a new amount changes the plan's
  // part and keeps the interest part.
  const catLines = entries.filter((e) => e.category_id != null);
  if (t.schedule_id && changes.amount !== undefined && catLines.length === 2 && acct && entries.length === 3) {
    const interest = catLines.find((e) => state.categories.find((c) => c.id === e.category_id)?.role === "interest_fees"), main = catLines.find((e) => e !== interest);
    if (!interest || !main || !Number.isSafeInteger(changes.amount) || changes.amount <= interest.amount) return { ok: false, violations: fail("BAD_AMOUNT", "the amount must be more than the interest part").violations, state };
    const next = entries.map((e) => (e === main ? { ...e, amount: changes.amount - interest.amount } : e === acct ? { ...e, amount: -changes.amount } : e));
    const updated = { ...t, date: changes.date ?? t.date, payee: changes.payee ?? t.payee, memo: changes.memo ?? t.memo };
    const probe = discardDraft(state, id).state, result = checkTransactionSave(probe, { transaction: updated, entries: next });
    if (!result.ok) return { ok: false, violations: result.violations, state };
    return { ok: true, violations: result.violations, state: applyDrafts(state, [{ transaction: updated, entries: next }]) };
  }
  if (isExpense) {
    const keptForeign = (state.foreignAmounts ?? []).find((f) => f.transaction_id === id);
    const base = discardDraft(state, id).state;
    const plan = planExpense(base, {
      transaction_id: id, date: changes.date ?? t.date, payee: changes.payee ?? t.payee, memo: changes.memo ?? t.memo,
      category_id: changes.category_id ?? cat.category_id, amount: changes.amount ?? cat.amount,
      account_id: changes.account_id ?? acct.account_id, source: t.source, reserve_source_id,
      reference_no: t.reference_no ?? "", shot_time: t.shot_time ?? "",   // an edit keeps what a screenshot showed
    }, now);
    if (!plan.ok) return { ok: false, violations: plan.violations, state };
    plan.drafts[0].transaction.created_at = t.created_at;   // an edit does not change when it was captured
    if (t.source === "photo" || t.source === "voice") {   // survey Q4: did the owner have to fix what the photo reader (or the speech) guessed?
      const moved = plan.drafts[0].transaction.date !== t.date || plan.drafts[0].transaction.payee !== t.payee || (changes.amount !== undefined && changes.amount !== cat.amount) || (changes.category_id ?? cat.category_id) !== cat.category_id || (changes.account_id ?? acct.account_id) !== acct.account_id;
      plan.drafts[0].transaction.edited_before_verify = t.edited_before_verify === true || moved;
    }
    const applied = applyDrafts(base, plan.drafts);
    const newAmount = changes.amount ?? cat.amount;
    return { ok: true, violations: plan.violations, state: { ...applied, attachments: state.attachments ?? [],
      ...(keptForeign ? { foreignAmounts: [...(applied.foreignAmounts ?? []), { ...keptForeign, rate: newAmount / keptForeign.foreign_amount }] } : {}),   // a foreign amount stays, and its rate follows the corrected pesos
      transactions: applied.transactions.map((x) => (x.id === id ? { ...x, ...(t.schedule_id ? { schedule_id: t.schedule_id, schedule_key: t.schedule_key } : {}), ...(changes.memo !== undefined ? { memo: changes.memo } : {}) } : x)) } };   // the photo stays with its draft
  }

  let next = entries;
  if (changes.amount !== undefined) {
    if (entries.length !== 2 || !Number.isSafeInteger(changes.amount) || changes.amount <= 0) {
      return { ok: false, violations: fail("NOT_EDITABLE", "the amount of this draft cannot be edited").violations, state };
    }
    const [a, b] = entries;
    next = entries.map((e) => ({ ...e, amount: Math.sign(e.amount) * changes.amount }));
    if (Math.sign(a.amount) === Math.sign(b.amount)) return { ok: false, violations: fail("NOT_EDITABLE", "unexpected entry signs").violations, state };
  }
  const updated = { ...t, date: changes.date ?? t.date, payee: changes.payee ?? t.payee };
  if (t.source === "photo" || t.source === "voice") updated.edited_before_verify = t.edited_before_verify === true || updated.date !== t.date || updated.payee !== t.payee || (changes.amount !== undefined && changes.amount !== Math.abs(entries[0]?.amount));
  const probe = discardDraft(state, id).state;
  const result = checkTransactionSave(probe, { transaction: updated, entries: next });
  if (!result.ok) return { ok: false, violations: result.violations, state };
  return { ok: true, violations: result.violations, state: applyDrafts(state, [{ transaction: updated, entries: next }]) };
}

// The picture shown for an account. It is checked like any other field, so a bad or oversized
// picture is refused instead of bloating the saved data and the backup.
export function setAccountIcon(state, accountId, dataUrl) {
  const a = state.accounts.find((x) => x.id === accountId);
  if (!a) return { ok: false, violations: fail("UNKNOWN_ACCOUNT", "no account " + accountId).violations, state };
  // Every account of the same bank shares the picture, so a sub-account such as a pocket inside the bank looks the same.
  const same = (x) => x.id === accountId || (a.bank != null && x.bank === a.bank);
  const accounts = state.accounts.map((x) => { if (!same(x)) return x; const { icon, icon_url, ...rest } = x; return dataUrl == null ? rest : { ...rest, icon: dataUrl }; });
  const problems = accounts.filter(same).flatMap((x) => validateShape("Account", x));
  if (problems.length) return { ok: false, violations: [{ code: "BAD_ICON", severity: "error", message: "that picture cannot be used" }], state };
  return { ok: true, violations: [], state: { ...state, accounts } };
}

// A photo kept with a transaction. The picture file itself lives in its own store on the phone (not in the ledger text,
// not in the backup file); the ledger only records that it exists. `file` is the name the picture is stored under.
export function planAttachment(state, { id, transaction_id }, now = new Date()) {
  const bad = (code, message) => ({ ok: false, violations: [{ code, severity: "error", message }], state });
  if (!state.transactions.some((t) => t.id === transaction_id)) return bad("UNKNOWN_TRANSACTION", "no transaction " + transaction_id);
  const row = { id, transaction_id, type: "photo", file: id, file_timestamp: phTimestamp(now) };
  const problems = validateShape("Attachment", row);
  if (problems.length) return bad("BAD_ATTACHMENT", problems[0].message ?? "bad attachment");
  return { ok: true, violations: [], state: { ...state, attachments: [...(state.attachments ?? []), row] }, attachment: row };
}
export const attachmentsFor = (state, transactionId) => (state.attachments ?? []).filter((a) => a.transaction_id === transactionId);

// One purchase that belongs to more than one category (Food and Essentials on one receipt). Same rules as planExpense, for the
// whole amount; only the category side is split. input: planExpense's fields, but with `lines: [{category_id, amount}]` (at least two
// different expense categories) instead of category_id and amount. The account is charged the total once.
export function splitCategoryEntry(entries, transactionId, lines) {
  return [...lines.map((l) => ({ transaction_id: transactionId, category_id: l.category_id, amount: l.amount })), ...entries.filter((e) => e.category_id == null)];
}
export function planSplitExpense(state, input, now = new Date()) {
  const { lines, ...rest } = input;
  if (!Array.isArray(lines) || lines.length < 2) return fail("BAD_SPLIT", "a split needs at least two parts");
  if (new Set(lines.map((l) => l.category_id)).size !== lines.length) return fail("BAD_SPLIT", "each part needs a different category");
  if (!lines.every((l) => Number.isSafeInteger(l.amount) && l.amount > 0)) return fail("BAD_SPLIT", "each part must be more than zero");
  if (!lines.every((l) => state.categories.find((c) => c.id === l.category_id)?.kind === "expense")) return fail("UNKNOWN_CATEGORY", "every part needs an expense category");
  const total = lines.reduce((n, l) => n + l.amount, 0);
  const base = planExpense(state, { ...rest, category_id: lines[0].category_id, amount: total }, now);
  if (!base.ok) return base;
  const [main, ...others] = base.drafts;
  const entries = splitCategoryEntry(main.entries, main.transaction.id, lines);
  const result = checkTransactionSave(applyDrafts(state, others), { transaction: main.transaction, entries });
  return { ok: result.ok, violations: result.violations, drafts: [{ transaction: main.transaction, entries }, ...others] };
}
