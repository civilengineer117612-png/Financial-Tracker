// Importing old spending from what people already keep: a notes list ("02/10/2026" then "LRT - 15" lines, read from a screenshot by the on-phone
// reader), a CSV file, or an Excel (.xlsx) file such as a Google Sheet downloaded. Pure functions; nothing is saved here. Every line becomes a DRAFT that
// waits in Verify (owner's rule: everything from a picture or a file is checked, one at a time). Nothing leaves the phone and no library is needed: an
// .xlsx file is a zip of XML files, opened with the browser's own unzip (DecompressionStream).
import { planExpense, applyDrafts } from "./drafts.js";
import { categoriesOfKind, UNLOGGED_CATEGORY_ID } from "./seed.js";
import { guessType } from "./types.js";

// ---------- dates: the order (day/month or month/day) is decided per picture or file, from the dates themselves ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");
const fullYear = (y) => (y < 100 ? 2000 + y : y);
const valid = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

// One date as written: {a, b, y} for "02/10/2026" (order not known yet), or {iso} when the writing settles it (2026-10-02, "Oct 2, 2026", "2 Oct 2026").
export function readDate(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]) ? { iso: `${m[1]}-${pad(m[2])}-${pad(m[3])}` } : null;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) return { a: +m[1], b: +m[2], y: fullYear(+m[3]) };
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s) ?? /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(s);
  if (m) { const [mon, day] = isNaN(+m[1]) ? [m[1], +m[2]] : [m[2], +m[1]], mi = MONTHS.indexOf(mon) + 1; return mi && valid(+m[3], mi, day) ? { iso: `${m[3]}-${pad(mi)}-${pad(day)}` } : null; }
  return null;
}
const isoOf = (p, order) => { if (p.iso) return p.iso; const [d, mo] = order === "dmy" ? [p.a, p.b] : [p.b, p.a]; return valid(p.y, mo, d) ? `${p.y}-${pad(mo)}-${pad(d)}` : null; };

// "dmy", "mdy", or null when the dates cannot tell (then the owner is asked once). In order: a number above 12 settles it; else the number that changes
// from one date to the next is the day; else the reading with fewer dates in the future wins.
export function dateOrder(raws, today) {
  const ps = raws.map(readDate).filter((p) => p && !p.iso);
  if (!ps.length) return "dmy";   // nothing to decide: every date was written in full
  if (ps.some((p) => p.a > 12)) return "dmy";
  if (ps.some((p) => p.b > 12)) return "mdy";
  let aMoves = 0, bMoves = 0;
  for (let i = 1; i < ps.length; i++) { if (ps[i].a !== ps[i - 1].a) aMoves++; if (ps[i].b !== ps[i - 1].b) bMoves++; }
  if (aMoves > bMoves) return "dmy";
  if (bMoves > aMoves) return "mdy";
  const future = (o) => ps.filter((p) => { const iso = isoOf(p, o); return !iso || iso > today; }).length;
  const f1 = future("dmy"), f2 = future("mdy");
  return f1 < f2 ? "dmy" : f2 < f1 ? "mdy" : ps.every((p) => p.a === p.b) ? "dmy" : null;
}

// ---------- amounts ----------
export function readAmount(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) : null;
  const s = String(raw ?? "").replace(/[₱\s]|php|p(?=\d)/gi, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const c = Math.round(parseFloat(s) * 100);
  return c > 0 ? c : null;
}

// ---------- a notes list ----------
// Lines are a date on its own, or a thing and its amount ("LRT - 15", "Lunch: 100", "Kape 65", "Starbucks ₱325"). Anything else is listed as not read.
export function parseNotes(text) {
  const items = [], notRead = [];
  let date = null;
  for (const line of String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (readDate(line)) { date = line; continue; }
    const m = /^(.*?[^\s\-–:=])\s*[-–:=]?\s*(?:₱|php|p)?\s*([\d,]+(?:\.\d{1,2})?)$/i.exec(line);
    const amount = m ? readAmount(m[2]) : null;
    if (m && amount && date) items.push({ dateRaw: date, name: m[1].trim(), amount });
    else notRead.push(line);
  }
  return { items, notRead };
}

// The reader's boxes put back into lines: boxes whose middles sit at the same height form one line, read left to right.
export function linesByRow(boxes) {
  const bs = (boxes ?? []).filter((b) => [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite) && String(b.text ?? "").trim()).map((b) => ({ ...b, cy: (b.y0 + b.y1) / 2, h: b.y1 - b.y0 })).sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const b of bs) { const r = rows[rows.length - 1]; if (r && Math.abs(b.cy - r.cy) < 0.6 * Math.max(b.h, r.h)) r.items.push(b); else rows.push({ cy: b.cy, h: b.h, items: [b] }); }
  return rows.map((r) => r.items.sort((a, b) => a.x0 - b.x0).map((b) => String(b.text).trim()).join(" ")).join("\n");
}

// ---------- a table (CSV or a spreadsheet's first sheet) ----------
const COLS = {
  name: /^(expense|expenses|item|items|description|name|particulars|details|payee|what|bili|gastos)$/,
  amount: /^(amount|price|cost|total|php|halaga|presyo)$/,
  date: /^(date|day|petsa|when|araw)$/,
  category: /^(category|categories|type|kategorya|group)$/,
};
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
// The header row is the first with a name, an amount and a date column. Excel stores dates as day numbers: those are turned into dates directly.
export function parseTable(rows) {
  const at = rows.findIndex((r) => { const h = r.map(norm); return ["name", "amount", "date"].every((k) => h.some((x) => COLS[k].test(x))); });
  if (at < 0) return { ok: false, message: "No header row with Expense (or Item), Amount and Date was found." };
  const h = rows[at].map(norm), col = Object.fromEntries(Object.keys(COLS).map((k) => [k, h.findIndex((x) => COLS[k].test(x))]));
  const items = [], notRead = [];
  for (const r of rows.slice(at + 1)) {
    if (!r.some((c) => String(c ?? "").trim() !== "")) continue;
    const name = String(r[col.name] ?? "").trim(), amount = readAmount(r[col.amount]), d = r[col.date];
    const dateRaw = typeof d === "number" && d > 20000 && d < 80000 ? new Date(Date.UTC(1899, 11, 30) + d * 86400000).toISOString().slice(0, 10) : String(d ?? "").trim();
    if (name && amount && readDate(dateRaw)) items.push({ dateRaw, name, amount, ...(col.category >= 0 && String(r[col.category] ?? "").trim() ? { label: String(r[col.category]).trim() } : {}) });
    else notRead.push(r.map((c) => String(c ?? "")).join(" | "));
  }
  return { ok: true, items, notRead };
}

// CSV, with quoted cells ("₱1,500" stays one cell).
export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  const s = String(text ?? "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ",") { row.push(cell); cell = ""; } else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// .xlsx: the first sheet's rows. Strings come from the shared list; numbers stay numbers (dates are day numbers, see parseTable).
export async function readXlsx(buffer) {
  const files = await unzip(new Uint8Array(buffer));
  const txt = (n) => (files.has(n) ? new TextDecoder().decode(files.get(n)) : "");
  const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
  const shared = [...txt("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const firstId = /<sheet [^>]*r:id="([^"]+)"/.exec(txt("xl/workbook.xml"))?.[1];
  const target = firstId ? new RegExp(`<Relationship [^>]*Id="${firstId}"[^>]*Target="([^"]+)"`).exec(txt("xl/_rels/workbook.xml.rels"))?.[1] ?? new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${firstId}"`).exec(txt("xl/_rels/workbook.xml.rels"))?.[1] : null;
  const sheetName = target ? "xl/" + target.replace(/^\/?xl\//, "") : [...files.keys()].find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  const rows = [];
  for (const rm of txt(sheetName).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+)\d+"/.exec(cm[1])?.[1] ?? "", t = /t="([^"]+)"/.exec(cm[1])?.[1], body = cm[2] ?? "";
      const ci = [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      row[ci < 0 ? row.length : ci] = t === "s" ? shared[+v] ?? "" : t === "inlineStr" ? unxml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")) : t === "str" || t === "b" ? unxml(v ?? "") : v == null ? "" : Number(v);
    }
    rows.push(Array.from(row, (c) => c ?? ""));
  }
  return rows;
}

// A small zip reader: the central directory says where each file is; stored files are copied, deflated ones are inflated by the browser.
async function unzip(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("This is not an Excel (.xlsx) file.");
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/^xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml)$/.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true), data = b.subarray(start, start + size);
    out.set(name, method === 0 ? data : new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()));
  }
  return out;
}

// ---------- making the drafts ----------
const key = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
// The category of one line: the file's own category name if you have a category so named; else a quick tile with this name; else the kind its name
// reads as (LRT is transport, Lunch is food); else Unlogged, to be chosen in Verify. {category_id, how}
export function categoryFor(state, item) {
  const cats = state.categories.filter((c) => c.kind === "expense" && c.id !== UNLOGGED_CATEGORY_ID);
  const byLabel = item.label && cats.find((c) => key(c.name) === key(item.label));
  if (byLabel) return { category_id: byLabel.id, how: "your file's category" };
  const tile = (state.presets ?? []).find((p) => key(p.name) === key(item.name) && cats.some((c) => c.id === p.category_id));
  if (tile) return { category_id: tile.category_id, how: "your quick tile" };
  const kind = guessType(item.name) ?? (item.label ? guessType(item.label) : null), byKind = kind ? categoriesOfKind(cats, kind)[0] : null;
  if (byKind) return { category_id: byKind.id, how: "the name" };
  return { category_id: UNLOGGED_CATEGORY_ID, how: "not known: choose it in Verify" };
}

// The plan for a list of read lines: dated, categorised, already-logged ones left out. order: "dmy" | "mdy". Returns {lines, duplicates, undated}.
export function previewImport(state, items, order) {
  const have = new Set(state.transactions.map((t) => { const amt = state.entries.find((e) => e.transaction_id === t.id && e.category_id)?.amount; return `${t.date}|${key(t.payee)}|${amt}`; }));
  const lines = [], duplicates = [], undated = [];
  for (const it of items) {
    const p = readDate(it.dateRaw), date = p ? isoOf(p, order) : null;
    if (!date) { undated.push(it); continue; }
    const line = { date, name: it.name, amount: it.amount, ...categoryFor(state, it) };
    if (have.has(`${date}|${key(it.name)}|${it.amount}`)) duplicates.push(line); else lines.push(line);
  }
  return { lines, duplicates, undated };
}

// Makes one draft per line (source "import"), all on one account, all at once: if any line is refused nothing is saved.
export function planImport(state, lines, { account_id, newId, now = new Date() }) {
  let next = state;
  for (const l of lines) {
    const r = planExpense(next, { transaction_id: newId(), date: l.date, payee: l.name, category_id: l.category_id, amount: l.amount, account_id, source: "import" }, now);
    if (!r.ok) return { ok: false, message: `${l.name} (${l.date}): ${r.violations[0].message}` };
    next = applyDrafts(next, r.drafts);
  }
  return { ok: true, state: next, count: lines.length };
}
