// Export the entries as a spreadsheet file (owner, Oct 18). Plain CSV: one row per entry, amounts as plain numbers (money out is negative) so a sum works,
// Excel and Numbers open it. It is NOT encrypted: the screen says so. Nothing is stored and nothing changes.
import { correctionTag } from "./corrections.js";

export const CSV_COLUMNS = ["Date", "Item or payee", "Note", "Type", "Category", "Account", "Amount", "Status"];

// A cell that starts with = + - @ would run as a formula in a spreadsheet (a scanned shop name or a typed note can start with one): a quote in front keeps it text.
const text = (v) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const pesos = (c) => (c < 0 ? "-" : "") + Math.floor(Math.abs(c) / 100) + "." + String(Math.abs(c) % 100).padStart(2, "0");

// state; options: {from, to} dates (inclusive, either may be left out), drafts: true to include drafts too (default: verified only; cancelled and correcting entries are included, marked).
// Returns {csv, rows}: csv starts with a byte order mark so Excel reads the text right; rows is how many entries it holds.
export function entriesCsv(state, { from = "", to = "9999-12-31", drafts = false } = {}) {
  const cat = new Map(state.categories.map((c) => [c.id, c.name])), acct = new Map(state.accounts.map((a) => [a.id, a.name]));
  const legs = new Map();
  for (const e of state.entries) { if (!legs.has(e.transaction_id)) legs.set(e.transaction_id, []); legs.get(e.transaction_id).push(e); }
  const list = state.transactions.filter((t) => t.date >= from && t.date <= to && (t.status === "verified" || (drafts && t.status === "draft")))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
  const rows = list.map((t) => {
    const l = legs.get(t.id) ?? [], cats = l.filter((e) => e.category_id), accts = l.filter((e) => e.account_id);
    const catSum = cats.reduce((s, e) => s + e.amount, 0), names = (xs, m, key) => [...new Set(xs.map((e) => m.get(e[key]) ?? ""))].filter(Boolean).join(" + ");
    let type, amount, account = names(accts, acct, "account_id");
    if (cats.length && catSum !== 0) { type = catSum > 0 ? "Expense" : "Income"; amount = -catSum; }
    else if (!cats.length) {   // a move between accounts: the amount that left one and arrived in another
      type = "Move"; amount = Math.max(0, ...accts.map((e) => e.amount));
      const out = accts.filter((e) => e.amount < 0), into = accts.filter((e) => e.amount > 0);
      if (out.length && into.length) account = names(out, acct, "account_id") + " > " + names(into, acct, "account_id");
    } else { type = "Other"; amount = 0; }
    const status = correctionTag(state, t)?.toLowerCase() ?? t.status;
    return [text(t.date), text(t.payee), text(t.memo), type, text(names(cats, cat, "category_id")), text(account), pesos(amount), status].join(",");   // the amount is a number: its minus sign must stay
  });
  return { csv: "﻿" + [CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n", rows: rows.length };
}
