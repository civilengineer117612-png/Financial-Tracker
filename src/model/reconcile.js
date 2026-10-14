// Statement proof, phase 2: what the statements say about money moving between the owner's OWN accounts, and about pay arriving.
//  - A transfer OUT of one account and the matching money IN to another is ONE move, not spending and not income. `pairMoves` finds them by the bank account
//    a line names (its last four digits), the amount, and the day. A small difference is a fee and is shown, not hidden.
//  - Money in that equals a payslip's deposit near its pay date is the payslip arriving, not new income: `matchPayslips`.
//  - Nothing is added by itself. `planPairedMove` makes ONE draft transfer (source "statement") when the owner taps; a move already in the ledger is not made twice.
// Pure logic; amounts are centavos, dates are "YYYY-MM-DD".
import { accountLines } from "./proof.js";
import { accountByLast4, planTransfer } from "./transfers.js";

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
  const cands = [];
  for (const o of outs) {
    const po = pointer(o);
    for (const i of ins) {
      if (i.account_id === o.account_id) continue;
      const pi = pointer(i);
      // at least one end names the other account, and neither names a different one
      if ((!po && !pi) || (po && po.id !== i.account_id) || (pi && pi.id !== o.account_id)) continue;
      const fee = o.amount - i.amount, d = gap(o.date, i.date);
      if (fee < 0 || fee > maxFee || d > days) continue;
      cands.push({ o, i, fee, d, from_id: o.account_id, to_id: i.account_id });
    }
  }
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
