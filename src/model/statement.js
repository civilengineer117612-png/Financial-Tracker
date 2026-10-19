// Reading a bank statement (a PDF opened on the phone) into lines. Pure functions: they get the text pieces of each page, {x, y, w, str} (position from the
// left, height from the bottom, width), and return what the statement says. Nothing is saved here. Two layouts are known, found by their column titles, not by a
// bank's name: "Credits / Debits / Running Balance" (a full date on every line, a balance after every line) and "Outgoing / Incoming" (a day and month, the payee
// above and what kind below, totals at the top). The year comes from the statement's own period.
import { readDate } from "./importer.js";
import { BANKS } from "./banks.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");
const AMOUNT = /^(?:₱|php\s*)?\d{1,3}(?:,\d{3})*\.\d{2}$|^(?:₱|php\s*)?\d+\.\d{2}$/i;
const centavos = (s) => Math.round(parseFloat(String(s).replace(/[₱,\s]|php/gi, "")) * 100);
const FULL_DATE = /^\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}$/, DAY_MONTH = /^\d{1,2}\s+[A-Za-z]{3,9}\.?$/, MONTH_ONLY = /^[A-Za-z]{3,9}\.?$/;
const monthIndex = (w) => MONTHS.indexOf(String(w).slice(0, 3).toLowerCase()) + 1;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// Text pieces to rows, top to bottom, each row left to right. Pieces within 2 points of height are one row.
export function groupRows(items) {
  const rows = [];
  for (const it of [...items].filter((i) => String(i.str ?? "").trim()).sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= 2);
    if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows.sort((a, b) => b.y - a.y);
}
const textOf = (row) => row.items.map((i) => i.str.trim()).join(" ").replace(/\s+/g, " ").trim();
const right = (i) => i.x + i.w;

// The columns of a table, from its title row: [{key, right}] for the amount columns, and the left edge of the text column.
const KEYS = [["credits", /^credits?\b/i], ["debits", /^debits?\b/i], ["balance", /^running\b/i], ["outgoing", /^outgoing\b/i], ["incoming", /^incoming\b/i]];   // a title may be one piece ("Running Balance") or two ("OUTGOING", "(PHP)")
function headerOf(row) {
  // GCash: Date and Time / Description / Reference No. / Debit / Credit / Balance. The debit comes BEFORE the credit, and the balance is a plain "Balance".
  if (/date and time/i.test(textOf(row)) && /reference/i.test(textOf(row))) {
    const at = (re) => row.items.find((i) => re.test(i.str.trim()));
    const debit = at(/^debit$/i), credit = at(/^credit$/i), balance = at(/^balance$/i), desc = at(/^description$/i), ref = at(/^reference\b/i);
    if (debit && credit && balance) return { style: "gcash", cols: [{ key: "debits", right: right(debit) }, { key: "credits", right: right(credit) }, { key: "balance", right: right(balance) }], textX: desc ? desc.x : null, refX: ref ? ref.x : null, y: row.y };
  }
  const found = [];
  for (const [i, it] of row.items.entries()) { const k = KEYS.find(([, re]) => re.test(it.str.trim())); if (k) found.push({ key: k[0], at: i }); }
  const style = found.some((f) => f.key === "credits") && found.some((f) => f.key === "debits") ? "credit-debit" : found.some((f) => f.key === "outgoing") && found.some((f) => f.key === "incoming") ? "out-in" : null;
  if (!style) return null;
  // a column's right edge is the right edge of everything in the title cell, up to where the next title starts ("OUTGOING" and "(PHP)", "Running" and "Balance")
  const cols = found.map((f, n) => { const to = found[n + 1]?.at ?? row.items.length; return { key: f.key, right: Math.max(...row.items.slice(f.at, to).map(right)) }; });
  const textCol = row.items.find((i) => /^(details|transaction)$/i.test(i.str.trim()));
  return { style, cols, textX: textCol ? textCol.x : null, y: row.y };
}
const nearest = (cols, edge) => cols.reduce((best, c) => (Math.abs(c.right - edge) < Math.abs(best.right - edge) ? c : best), cols[0]);

// ---------- the period and the summary ----------
function readPeriod(rows) {
  for (const r of rows) {
    const t = textOf(r), iso = /(\d{4}-\d{2}-\d{2})\s*(?:-|–|to)\s*(\d{4}-\d{2}-\d{2})/.exec(t);
    if (iso) return { from: iso[1], to: iso[2] };
    const m = /(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\s*(?:-|–|to)\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i.exec(t);
    if (m) { const a = readDate(m[1]), b = readDate(m[2]); if (a?.iso && b?.iso) return { from: a.iso, to: b.iso }; }
  }
  return null;
}
function readSummary(rows) {
  const out = {};
  for (const [n, r] of rows.entries()) {
    const t = textOf(r), amts = r.items.filter((i) => AMOUNT.test(i.str.trim())).map((i) => centavos(i.str));
    const one = (re, key) => { if (re.test(t) && amts.length && out[key] === undefined) out[key] = amts[amts.length - 1]; };
    one(/opening balance/i, "opening"); one(/total credit/i, "credits"); one(/total debit/i, "debits"); one(/closing balance/i, "closing");
    // titles in a row (or wrapped over two rows: "STARTING SAVINGS" above "BALANCE (PHP)"), the amounts in a row below, in the same order
    const both = n + 1 < rows.length ? t + " " + textOf(rows[n + 1]) : t;
    if (/starting\b.*\bbalance/i.test(both) && /ending\b.*\bbalance/i.test(both) && /outgoing/i.test(both) && /incoming/i.test(both) && out.outgoing === undefined) {
      const below = rows.slice(n + 1, n + 4).map((x) => x.items.filter((i) => AMOUNT.test(i.str.trim())).map((i) => centavos(i.str))).find((a) => a.length >= 4);
      if (below) { out.opening = below[0]; out.outgoing = below[1]; out.incoming = below[2]; out.closing = below[3]; }
    }
  }
  return out;
}

// ---------- one transaction's meaning ----------
// meaning: "spending" (money out for something), "fee", "move" (to or from your own other account, e.g. a savings pocket: no change to what you have),
// "in" (money in), "unsure" (money out that does not say what it was: you choose).
export function classifyLine({ text, type = "", direction }) {
  const t = String(text ?? "").trim(), ty = String(type ?? "").trim();
  if (/go\s*save/i.test(t) || /^transfer (from|to) deposit account\b/i.test(t)) return { meaning: "move", payee: t };   // a Go Save pocket and its main account ("Deposit account"): always your own money
  // GCash: "Buy Load ..." is spending; "Received GCash from <bank> ..." is money in; "Transfer from A to B" is money in or out by the column it is in, and the OTHER number is the person
  // (so the unsure lines group per person). The numbers themselves are the person's key and are not kept in any message.
  if (/^buy load\b/i.test(t)) return { meaning: "spending", payee: "Buy load" };
  const pay = /^payment to\s+(.+?)(?:,?\s*merchant transaction number:.*)?$/i.exec(t);
  if (pay) return { meaning: "spending", payee: pay[1].trim() };
  if (/^(pay bills|bills payment|merchant payment)\b/i.test(t)) return { meaning: "spending", payee: t };
  if (/^gcash transaction with parent ref/i.test(t)) return { meaning: "in", payee: "Refund" };   // a reversal of the line just above it
  // Money to or from a bank account names the bank and the LAST FOUR digits of that account (the owner's own accounts carry theirs: see parseStatement's ownLast4).
  const sent = /^sent gcash to\s+(.+?)\s+with account ending in\s+(\d{4})\b/i.exec(t);
  if (sent) return { meaning: "unsure", payee: `${sent[1].trim()} ending ${sent[2]}`, last4: sent[2] };
  const got = /^received gcash from\s+(.+?)(?:\s+with account(?:\s+ending in\s+(\d{4}))?\b.*)?$/i.exec(t);
  if (got) return { meaning: "in", payee: "Cash in from " + got[1].trim() + (got[2] ? ` ending ${got[2]}` : ""), ...(got[2] ? { last4: got[2] } : {}) };
  const tr = /^transfer from\s+(\d{6,})\s+to\s+(\d{6,})/i.exec(t);
  if (tr) return direction === "in" ? { meaning: "in", payee: tr[1] } : { meaning: "unsure", payee: tr[2] };
  // Cashback, a campaign reward and interest are small amounts the bank adds to the account: still money in (so everything that counts money in is unchanged),
  // marked `reward` so an import can offer them as income drafts. A loan paid out and a transfer are not rewards.
  if (direction === "in" && (/^(reward|interest)$/i.test(ty) || /\b(cashback|campaign reward)\b/i.test(t))) return { meaning: "in", payee: t, reward: true };
  if (direction === "in") return { meaning: "in", payee: t };
  if (/\bfees?\b/i.test(t) || /\bfees?\b/i.test(ty)) return { meaning: "fee", payee: t };
  const card = /^card payment at\s+(.+?)(?:,\s*card\b.*)?$/i.exec(t);
  if (card) return { meaning: "spending", payee: card[1].trim() };
  if (/^(card )?payment$/i.test(ty)) return { meaning: "spending", payee: t };
  return { meaning: "unsure", payee: t };
}

// ---------- your own name ----------
// A transfer to or from the statement's own holder is money moving between your own accounts, not spending and not income. The holder's name is printed
// near the top of the first page in capitals, on a line of its own (no digits, a few words). Two names are the same person when their first and last
// words match, ignoring initials, punctuation and Jr/Sr/II/III ("Sample P. Dela Cruz, Jr." is "SAMPLE PEDRO DELA CRUZ JR").
const NOT_A_NAME = /\b(statement|account|summary|bank|contact|savings|period|details|date|transaction|balance|total|page|opening|closing|credit|debit|deposit|address|philippines|city|street|avenue|barangay|call|email|incoming|outgoing|starting|ending|php)\b/i;
const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv"]);
export function nameKey(s) {
  const words = String(s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !SUFFIX.has(w));
  return words.length >= 2 ? { first: words[0], last: words[words.length - 1] } : null;
}
export function holderNames(rows) {
  return rows.slice(0, 25).map(textOf).filter((t) => /^[A-Z][A-Z.,'\- ]+$/.test(t) && t.split(/\s+/).length >= 2 && t.split(/\s+/).length <= 6 && !NOT_A_NAME.test(t)).map(nameKey).filter(Boolean);
}
// The person a description names: "Transfer to SAMPLE P. GoTyme Bank, Account No. 0000" names "SAMPLE P."; a payee line names itself.
const personIn = (text) => String(text ?? "").replace(/^transfer\s+(to|from)\s+/i, "").split(",")[0].replace(new RegExp("\\b(" + BANKS.flatMap((b) => [b.name, ...(b.aka ?? [])]).join("|") + ")\\b", "gi"), " ").replace(/\bbank\b/gi, " ");
export function isOwnName(text, holders) {
  const k = nameKey(personIn(text));
  return !!k && holders.some((h) => h.first === k.first && h.last === k.last);
}

// ---------- the whole statement ----------
// pages: [[{x, y, w, str}]]. Returns {ok, style, period, summary, lines, check, message}. Each line: {date, text, payee, type, amount (centavos, > 0), direction ("in"|"out"),
// balance (centavos, or null), meaning}.
export function parseStatement(pages, { ownLast4 = [] } = {}) {
  const allRows = pages.map(groupRows), flat = allRows.flat();
  const period = readPeriod(flat), summary = readSummary(flat);
  let header = null;
  const lines = [], gcash = { page: gcashPage };
  for (const rows of allRows) {
    const here = rows.map(headerOf).find(Boolean);
    if (here) header = here;
    if (!header) continue;
    const startAt = here ? rows.findIndex((r) => r.y === here.y) + 1 : 0;
    if (header.style === "gcash") { gcash.page(rows.slice(startAt), header, lines, gcash); continue; }
    let pendingText = null, awaitType = null;
    for (const row of rows.slice(startAt)) {
      const date = row.items.find((i) => FULL_DATE.test(i.str.trim()) || DAY_MONTH.test(i.str.trim()) || (header.style === "out-in" && MONTH_ONLY.test(i.str.trim()) && i.x < (header.textX ?? 1e9) - 5));
      const amts = row.items.filter((i) => AMOUNT.test(i.str.trim()) && (!date || i.x > date.x));
      const words = row.items.filter((i) => i !== date && !amts.includes(i));
      if (date && amts.length) {
        const by = {}; for (const a of amts) by[nearest(header.cols, right(a)).key] = centavos(a.str);
        const iso = isoOf(date.str.trim(), period);
        if (!iso) continue;
        const credit = by.credits ?? by.incoming ?? 0, debit = by.debits ?? by.outgoing ?? 0;
        if (!credit && !debit) continue;
        const text = header.style === "credit-debit" ? words.map((w) => w.str.trim()).join(" ") : (pendingText ?? "");
        const line = { date: iso, text, type: "", amount: credit || debit, direction: credit ? "in" : "out", balance: by.balance ?? null };
        lines.push(line);
        if (header.style === "out-in") awaitType = line;
        pendingText = null;
      } else if (!date && !amts.length && words.length) {
        const t = words.map((w) => w.str.trim()).join(" ");
        if (/^(all figures|page\b|document id|request date)/i.test(t) || /\bpage\s*\d+\s*of\s*\d+/i.test(t)) { pendingText = null; continue; }
        if (header.style === "out-in") { if (awaitType) { awaitType.type = t; awaitType = null; } else pendingText = t; }
        else if (lines.length && header.textX !== null && Math.abs(words[0].x - header.textX) <= 3) lines[lines.length - 1].text += " " + t;   // a long description that wraps
      }
    }
  }
  if (header?.style === "gcash") settleGcashBalances(lines, summary, gcash);
  // "Net Interest" is the month's interest added up, a total of the lines above it, not money moving: it is not a line.
  for (let i = lines.length - 1; i >= 0; i--) if (/^net interest$/i.test(lines[i].type)) lines.splice(i, 1);
  const holders = holderNames(allRows[0] ?? []);
  for (const l of lines) {
    Object.assign(l, classifyLine(l));
    if ((l.meaning === "unsure" || l.meaning === "in") && isOwnName(l.payee || l.text, holders)) { l.meaning = "move"; l.own = true; }   // to or from yourself
    if ((l.meaning === "unsure" || l.meaning === "in") && l.last4 && ownLast4.includes(l.last4)) { l.meaning = "move"; l.own = true; }   // to or from your own bank account (its last four digits)
  }
  if (!header || !lines.length) return { ok: false, message: "No transactions were found in this PDF. It may not be a bank statement the app knows." };
  const top = allRows[0].slice(0, 25).map(textOf).join(" ").toLowerCase();   // the first lines of the first page: the bank's name is usually there
  const found = BANKS.find((b) => [b.name, ...(b.aka ?? [])].some((n) => top.includes(n.toLowerCase()))) ?? null, bank = found?.name ?? null, bankId = found?.id ?? null;
  // A Go Save pocket's statement says "GoalSave No.: ********73002" where the main account says "Account Number": it is NOT the main account, so it is never filed there by itself.
  const pk = /goal\s*save\s*no\.?:?\s*[*\u2022x\s]*(\d{4,})/i.exec(top), pocket = pk ? { last4: pk[1].slice(-4) } : null;
  return { ok: true, style: header.style, bank, bankId, period, summary, lines, pocket, check: checkStatement(header.style, lines, summary) };
}

// ---------- GCash: one page of the table ----------
// A description that wraps is centred on its row: its first part sits ABOVE the date and amounts, its second part BELOW. So each text-only row belongs to the nearest
// row that has a date and amounts. The reference number column is not part of the description. "STARTING BALANCE" opens the statement; a time ("02:54 PM") after the date is not text.
const GCASH_DATE = /^\d{4}-\d{2}-\d{2}\b/, GCASH_TIME = /^\d{1,2}:\d{2}\s*[AP]M$/i;
function gcashPage(rows, header, lines, memo) {
  const refAt = header.refX === null ? 1e9 : header.refX - 2;
  const data = rows.filter((r) => r.items.some((i) => GCASH_DATE.test(i.str.trim())) && r.items.some((i) => AMOUNT.test(i.str.trim())));
  const parts = new Map(data.map((r) => [r, [{ y: r.y, text: r.items.filter((i) => !GCASH_DATE.test(i.str.trim()) && !GCASH_TIME.test(i.str.trim()) && !AMOUNT.test(i.str.trim()) && i.x < refAt).map((i) => i.str.trim()).join(" ") }]]));
  for (const r of rows) {
    if (data.includes(r)) continue;
    const t = textOf(r), amts = r.items.filter((i) => AMOUNT.test(i.str.trim()));
    if (/^starting balance/i.test(t) && amts.length) { memo.opening = centavos(amts[amts.length - 1].str); continue; }
    if (/^ending balance/i.test(t) && amts.length) { memo.closing = centavos(amts[amts.length - 1].str); continue; }
    const near = data.reduce((b, d) => (!b || Math.abs(d.y - r.y) < Math.abs(b.y - r.y) ? d : b), null);
    const words = r.items.filter((i) => i.x < refAt && !GCASH_TIME.test(i.str.trim()) && !AMOUNT.test(i.str.trim())).map((i) => i.str.trim()).join(" ");
    if (near && Math.abs(near.y - r.y) <= 14 && words && !/^(page\b|all figures|document id|request date)/i.test(words)) parts.get(near).push({ y: r.y, text: words });
  }
  for (const r of data) {
    const date = r.items.find((i) => GCASH_DATE.test(i.str.trim())).str.trim().slice(0, 10), iso = readDate(date)?.iso;
    const by = {};
    for (const a of r.items.filter((i) => AMOUNT.test(i.str.trim()))) by[nearest(header.cols, right(a)).key] = centavos(a.str);
    const credit = by.credits ?? 0, debit = by.debits ?? 0;
    if (!iso || (!credit && !debit)) continue;
    const text = parts.get(r).sort((a, b) => b.y - a.y).map((p) => p.text).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    lines.push({ date: iso, text, type: "", amount: credit || debit, direction: credit ? "in" : "out", balance: by.balance ?? null });
  }
}
// GCash prints a balance of 0.00 on a line that says money was received from a bank; the next line carries the true figure. So a balance is worked out from the one before
// (starting from STARTING BALANCE), and a printed zero on a "Received ..." line is replaced by it. Every OTHER printed balance is kept, so a misread one is still caught by the check.
function settleGcashBalances(lines, summary, memo) {
  if (memo.opening !== undefined) summary.opening = memo.opening;
  if (memo.closing !== undefined) summary.closing = memo.closing;
  let prev = summary.opening ?? 0;
  for (const l of lines) {
    const derived = prev + (l.direction === "in" ? l.amount : -l.amount);
    if (l.balance === null || (l.balance === 0 && derived !== 0 && /^received\b/i.test(l.text))) l.balance = derived;
    prev = l.balance;
  }
}

function isoOf(raw, period) {
  if (FULL_DATE.test(raw)) return readDate(raw)?.iso ?? null;
  const parts = raw.replace(/\./g, "").split(/\s+/);
  const day = parts.length === 2 ? Number(parts[0]) : null, mon = monthIndex(parts[parts.length - 1]);
  if (!mon || !period) return null;
  const fromY = period.from.slice(0, 4), toY = period.to.slice(0, 4);
  const y = Number(fromY === toY ? toY : mon >= Number(period.from.slice(5, 7)) ? fromY : toY);   // a statement across New Year: the later months are the old year
  return `${y}-${pad(mon)}-${pad(day ?? lastDay(y, mon))}`;   // "MAY" alone (net interest) is dated the last day of that month
}

// Does the statement add up? With a balance after every line, each line must follow from the one before; always, what came in and went out must match the
// totals at the top. {ok, kind, message, bad: [index]}.
export function checkStatement(style, lines, summary) {
  const bad = [];
  let kind = "total", message = "";
  if ((style === "credit-debit" || style === "gcash") && lines.every((l) => l.balance !== null) && summary.opening !== undefined) {
    kind = "lines";
    let prev = summary.opening;
    lines.forEach((l, i) => { const next = prev + (l.direction === "in" ? l.amount : -l.amount); if (next !== l.balance) bad.push(i); prev = l.balance; });
  }
  const sum = (dir) => lines.filter((l) => l.direction === dir).reduce((n, l) => n + l.amount, 0);
  const wantIn = summary.credits ?? summary.incoming, wantOut = summary.debits ?? summary.outgoing;
  const totalsOk = (wantIn === undefined || wantIn === sum("in")) && (wantOut === undefined || wantOut === sum("out"));
  const closeOk = summary.opening === undefined || summary.closing === undefined || summary.opening + sum("in") - sum("out") === summary.closing;
  const known = wantIn !== undefined || wantOut !== undefined || (summary.opening !== undefined && summary.closing !== undefined) || kind === "lines";
  const ok = bad.length === 0 && totalsOk && closeOk && known;
  if (!known) message = "This statement has no totals to check against.";
  else if (!ok) message = bad.length ? `${bad.length} ${bad.length === 1 ? "line does" : "lines do"} not follow from the balance before it.` : "The lines do not add up to the totals at the top.";
  else message = kind === "lines" ? "Every line follows from the balance before it." : "Everything in and out matches the totals at the top.";
  return { ok, kind, message, bad };
}

// The lines that failed the line-by-line check, so they can be shown: for each, the balance the bank printed and the balance the line before it leads to
// (centavos; "expected" may be negative). Usually a line is missing from the statement just before it.
export function badLineDetails(lines, summary, bad) {
  return (bad ?? []).map((i) => {
    const l = lines[i], prev = i === 0 ? summary.opening ?? 0 : lines[i - 1].balance;
    return { date: l.date, name: l.payee || l.text, amount: l.amount, direction: l.direction, printed: l.balance, expected: prev + (l.direction === "in" ? l.amount : -l.amount) };
  });
}

// The lines the importer takes: what was spent (including what is unsure, which you can turn off one by one), as importer items.
export function statementItems(lines) {
  return lines.map((l, i) => ({ l, i })).filter(({ l }) => l.direction === "out" && (l.meaning === "spending" || l.meaning === "fee" || l.meaning === "unsure"))
    .map(({ l, i }) => ({ id: "s" + i, dateRaw: l.date, name: l.payee || l.text, amount: l.amount, meaning: l.meaning, label: l.meaning === "fee" ? null : undefined }));
}
// Cashback, rewards and interest lines (money in, marked `reward`): offered as income drafts by an import. [{date, name, amount}]
export const statementRewards = (lines) => lines.filter((l) => l.direction === "in" && l.meaning === "in" && l.reward).map((l) => ({ date: l.date, name: l.payee || l.text, amount: l.amount }));
export const statementLeftOut = (lines) => ({ moves: lines.filter((l) => l.meaning === "move" && !l.own).length, own: lines.filter((l) => l.own).length, moneyIn: lines.filter((l) => l.meaning === "in" && !l.reward).length, rewards: lines.filter((l) => l.meaning === "in" && l.reward).length });

// The unsure lines, one group per person (the same name, ignoring case, spaces and punctuation), the biggest total first: one choice answers all of a person's lines.
export function unsureByPerson(items) {
  const groups = new Map();
  for (const x of items.filter((i) => i.meaning === "unsure")) {
    const key = String(x.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || "?";
    const g = groups.get(key) ?? { key, name: x.name, ids: [], lines: [], total: 0 };
    g.ids.push(x.id); g.lines.push(x); g.total += x.amount; groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}
