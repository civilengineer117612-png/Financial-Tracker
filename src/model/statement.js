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
    const t = textOf(r), m = /(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\s*(?:-|–|to)\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i.exec(t);
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
    if (/starting balance/i.test(t) && /ending balance/i.test(t) && /outgoing/i.test(t) && /incoming/i.test(t)) {   // titles in a row, the amounts in a row below, in the same order
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
  if (/go\s*save/i.test(t)) return { meaning: "move", payee: t };
  if (direction === "in") return { meaning: "in", payee: t };
  if (/\bfees?\b/i.test(t) || /\bfees?\b/i.test(ty)) return { meaning: "fee", payee: t };
  const card = /^card payment at\s+(.+?)(?:,\s*card\b.*)?$/i.exec(t);
  if (card) return { meaning: "spending", payee: card[1].trim() };
  if (/^(card )?payment$/i.test(ty)) return { meaning: "spending", payee: t };
  return { meaning: "unsure", payee: t };
}

// ---------- the whole statement ----------
// pages: [[{x, y, w, str}]]. Returns {ok, style, period, summary, lines, check, message}. Each line: {date, text, payee, type, amount (centavos, > 0), direction ("in"|"out"),
// balance (centavos, or null), meaning}.
export function parseStatement(pages) {
  const allRows = pages.map(groupRows), flat = allRows.flat();
  const period = readPeriod(flat), summary = readSummary(flat);
  let header = null;
  const lines = [];
  for (const rows of allRows) {
    const here = rows.map(headerOf).find(Boolean);
    if (here) header = here;
    if (!header) continue;
    const startAt = here ? rows.findIndex((r) => r.y === here.y) + 1 : 0;
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
  // "Net Interest" is the month's interest added up, a total of the lines above it, not money moving: it is not a line.
  for (let i = lines.length - 1; i >= 0; i--) if (/^net interest$/i.test(lines[i].type)) lines.splice(i, 1);
  for (const l of lines) Object.assign(l, classifyLine(l));
  if (!header || !lines.length) return { ok: false, message: "No transactions were found in this PDF. It may not be a bank statement the app knows." };
  const top = allRows[0].slice(0, 25).map(textOf).join(" ").toLowerCase();   // the first lines of the first page: the bank's name is usually there
  const bank = BANKS.find((b) => top.includes(b.name.toLowerCase()))?.name ?? null;
  return { ok: true, style: header.style, bank, period, summary, lines, check: checkStatement(header.style, lines, summary) };
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
  if (style === "credit-debit" && lines.every((l) => l.balance !== null) && summary.opening !== undefined) {
    kind = "lines";
    let prev = summary.opening;
    lines.forEach((l, i) => { const next = prev + (l.direction === "in" ? l.amount : -l.amount); if (next !== l.balance) bad.push(i); prev = l.balance; });
  }
  const sum = (dir) => lines.filter((l) => l.direction === dir).reduce((n, l) => n + l.amount, 0);
  const wantIn = summary.credits ?? summary.incoming, wantOut = summary.debits ?? summary.outgoing;
  const totalsOk = (wantIn === undefined || wantIn === sum("in")) && (wantOut === undefined || wantOut === sum("out"));
  const closeOk = summary.opening === undefined || summary.closing === undefined || summary.opening + sum("in") - sum("out") === summary.closing;
  const known = wantIn !== undefined || wantOut !== undefined || (summary.opening !== undefined && summary.closing !== undefined);
  const ok = bad.length === 0 && totalsOk && closeOk && known;
  if (!known) message = "This statement has no totals to check against.";
  else if (!ok) message = bad.length ? `${bad.length} ${bad.length === 1 ? "line does" : "lines do"} not follow from the balance before it.` : "The lines do not add up to the totals at the top.";
  else message = kind === "lines" ? "Every line follows from the balance before it." : "Everything in and out matches the totals at the top.";
  return { ok, kind, message, bad };
}

// The lines the importer takes: what was spent (including what is unsure, which you can turn off one by one), as importer items.
export function statementItems(lines) {
  return lines.map((l, i) => ({ l, i })).filter(({ l }) => l.direction === "out" && (l.meaning === "spending" || l.meaning === "fee" || l.meaning === "unsure"))
    .map(({ l, i }) => ({ id: "s" + i, dateRaw: l.date, name: l.payee || l.text, amount: l.amount, meaning: l.meaning, label: l.meaning === "fee" ? null : undefined }));
}
export const statementLeftOut = (lines) => ({ moves: lines.filter((l) => l.meaning === "move").length, moneyIn: lines.filter((l) => l.meaning === "in").length });
