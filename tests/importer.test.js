import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { linesByRow, readDate, dateOrder, readAmount, parseNotes, parseTable, parseCsv, readXlsx, categoryFor, previewImport, planImport, validateState, pendingDrafts } from "../src/model/index.js";
import { makeState, account } from "./fixtures.js";

// Invented names and numbers only.
const TODAY = "2026-10-07";

test("dates: written in full are settled; day/month or month/day is decided per list from the dates themselves", () => {
  assert.deepEqual(readDate("2026-10-02"), { iso: "2026-10-02" }); assert.deepEqual(readDate("Oct 2, 2026"), { iso: "2026-10-02" }); assert.deepEqual(readDate("2 October 2026"), { iso: "2026-10-02" });
  assert.equal(readDate("Lunch - 100"), null); assert.equal(readDate("2026-02-30"), null);
  assert.equal(dateOrder(["09/19/2026", "09/20/2026", "10/01/2026"], TODAY), "mdy", "a second number above 12: month/day");
  assert.equal(dateOrder(["19/09/2026", "20/09/2026"], TODAY), "dmy", "a first number above 12: day/month");
  assert.equal(dateOrder(["13/05/2026", "13/06/2026"], TODAY), "dmy", "13 cannot be a month, even though the second number is the one that changes");
  assert.equal(dateOrder(["02/10/2026", "03/10/2026", "04/10/2026"], TODAY), "dmy", "the first number changes, the second stays: it is the day");
  assert.equal(dateOrder(["10/02/2026", "10/03/2026", "10/04/2026"], TODAY), "mdy", "the second number changes: it is the day");
  assert.equal(dateOrder(["03/11/2026"], TODAY), "mdy", "3 Nov would be in the future, Mar 11 is not: the past reading wins");
  assert.equal(dateOrder(["11/03/2026"], TODAY), "dmy", "and the other way round");
  assert.equal(dateOrder(["05/06/2026"], TODAY), null, "both readings are in the past and nothing changes: ask");
  assert.equal(dateOrder(["05/05/2026"], TODAY), "dmy", "the same either way");
});

test("amounts: pesos with or without the sign, commas and centavos; nothing else", () => {
  assert.equal(readAmount("₱1,500"), 150000); assert.equal(readAmount("15"), 1500); assert.equal(readAmount("2160.50"), 216050); assert.equal(readAmount("PHP 99"), 9900);
  assert.equal(readAmount(325), 32500); assert.equal(readAmount("abc"), null); assert.equal(readAmount("0"), null); assert.equal(readAmount("1.234"), null);
});

test("a notes list: a date line, then a thing and its amount per line; what cannot be read is listed, never guessed", () => {
  const r = parseNotes("Expenses\n02/10/2026\nLRT - 15\nLUNCH - 100\nMerienda - 30\n\n03/10/2026\nLunch: 100\nStarbucks ₱325\nUniqlo - 2160\n04/10/2026\nKape 65\nthanks");
  assert.deepEqual(r.items.map((x) => [x.dateRaw, x.name, x.amount]), [["02/10/2026", "LRT", 1500], ["02/10/2026", "LUNCH", 10000], ["02/10/2026", "Merienda", 3000], ["03/10/2026", "Lunch", 10000],
    ["03/10/2026", "Starbucks", 32500], ["03/10/2026", "Uniqlo", 216000], ["04/10/2026", "Kape", 6500]]);
  assert.deepEqual(r.notRead, ["Expenses", "thanks"]);
  assert.deepEqual(parseNotes("Lunch - 100").items, [], "no date above it: not read");
});

test("a table: the header row is found by its names; Excel day numbers become dates; the category column is kept", () => {
  const rows = [["Daily Expenses"], ["your log"], [], ["Expense", "Amount", "Date", "Category"], ["Jeep", "₱26", "09/20/2026", "Lakat/Date"], ["Lunch", 130, 46285, "Food"], ["", "", "", ""], ["Bad", "x", "09/21/2026", ""]];
  const t = parseTable(rows);
  assert.equal(t.ok, true);
  assert.deepEqual(t.items, [{ dateRaw: "09/20/2026", name: "Jeep", amount: 2600, label: "Lakat/Date" }, { dateRaw: "2026-09-20", name: "Lunch", amount: 13000, label: "Food" }]);
  assert.equal(t.notRead.length, 1);
  assert.equal(parseTable([["a", "b"], ["1", "2"]]).ok, false);
});

test("CSV keeps quoted cells with commas whole", () => {
  assert.deepEqual(parseCsv('﻿Expense,Amount,Date\r\n"Dinner, with ""Ate""","₱1,500",10/01/2026\n'), [["Expense", "Amount", "Date"], ['Dinner, with "Ate"', "₱1,500", "10/01/2026"]]);
});

// A tiny .xlsx built here (one file stored, the others deflated), the way a spreadsheet app writes one.
function zip(files) {
  const parts = [], central = []; let off = 0;
  for (const [name, text, deflate] of files) {
    const raw = Buffer.from(text), data = deflate ? deflateRawSync(raw) : raw, n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    parts.push(local, n, data); central.push(c, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
export const sampleXlsx = () => zip([
  ["xl/workbook.xml", '<workbook><sheets><sheet name="Log" sheetId="1" r:id="rId1"/></sheets></workbook>', false],
  ["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>', true],
  ["xl/sharedStrings.xml", "<sst><si><t>Expense</t></si><si><t>Amount</t></si><si><t>Date</t></si><si><t>Category</t></si><si><r><t>Coffee </t></r><r><t>&amp; cake</t></r></si><si><t>Food</t></si></sst>", true],
  ["xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row><row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2"><v>185</v></c><c r="C2"><v>46295</v></c><c r="D2" t="s"><v>5</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Jeep</t></is></c><c r="C3" t="str"><v>10/01/2026</v></c><c r="B3"><v>26</v></c></row></sheetData></worksheet>', true],
]);

test(".xlsx: the first sheet is read with no library, strings, numbers and Excel dates included", async () => {
  const rows = await readXlsx(sampleXlsx());
  assert.deepEqual(rows, [["Expense", "Amount", "Date", "Category"], ["Coffee & cake", 185, 46295, "Food"], ["Jeep", 26, "10/01/2026"]]);
  const t = parseTable(rows);
  assert.deepEqual(t.items.map((x) => [x.dateRaw, x.name, x.amount]), [["2026-09-30", "Coffee & cake", 18500], ["10/01/2026", "Jeep", 2600]]);
  await assert.rejects(() => readXlsx(Buffer.from("not a zip at all, just text")), /not an Excel/);
});

function ledger() {
  const s = makeState();
  s.accounts = [account({ id: "w", name: "Test Wallet", class: "asset", opening_balance: 500000, opening_date: "2026-10-05" })];
  s.categories = [{ id: "food", name: "Food", kind: "expense", role: "food" }, { id: "tr", name: "Transpo", kind: "expense", role: "transport" }, { id: "fun", name: "Lakat/Date", kind: "expense" },
    { id: "cat-unlogged", name: "Unlogged", kind: "expense" }, { id: "dine", name: "Treats", kind: "expense" }];
  s.presets = [{ id: "p", name: "Starbucks", amount: 32500, category_id: "dine" }];
  return s;
}

test("each line's category: your file's own category name, then a quick tile with that name, then what the name reads as, else Unlogged", () => {
  const s = ledger();
  assert.deepEqual(categoryFor(s, { name: "Jeep", label: "lakat/date" }), { category_id: "fun", how: "your file's category" });
  assert.deepEqual(categoryFor(s, { name: "starbucks" }), { category_id: "dine", how: "your quick tile" });
  assert.deepEqual(categoryFor(s, { name: "LRT" }), { category_id: "tr", how: "the name" });
  assert.deepEqual(categoryFor(s, { name: "Zzyzx", label: "Nope" }), { category_id: "cat-unlogged", how: "not known: choose it in Verify" });
});

test("the preview dates each line by the decided order and leaves out what is already logged", () => {
  const s = ledger();
  s.transactions.push({ id: "t0", date: "2026-10-02", payee: "LRT", memo: "", status: "verified", source: "manual", created_at: "2026-10-02T09:00:00.000+08:00", verified_at: "2026-10-02T09:00:00.000+08:00" });
  s.entries.push({ transaction_id: "t0", category_id: "tr", amount: 1500 }, { transaction_id: "t0", account_id: "w", amount: -1500 });
  const items = parseNotes("02/10/2026\nLRT - 15\nLunch - 100\n31/02/2026\nOdd - 5").items;
  const p = previewImport(s, items, "dmy");
  assert.deepEqual(p.lines.map((l) => [l.date, l.name, l.amount, l.category_id]), [["2026-10-02", "Lunch", 10000, "food"]]);
  assert.equal(p.duplicates.length, 1, "LRT 15 on Oct 2 is already logged");
  assert.equal(p.undated.length, 1, "Feb 31 is not a date");
});

test("importing makes one draft per line on the chosen account, waiting in Verify; all or nothing", () => {
  const s = ledger(); let n = 0;
  const lines = previewImport(s, parseNotes("02/10/2026\nLunch - 100\nStarbucks - 325").items, "dmy").lines;
  const r = planImport(s, lines, { account_id: "w", newId: () => "imp" + ++n, now: new Date("2026-10-07T00:00:00Z") });
  assert.equal(r.ok, true); assert.equal(r.count, 2);
  assert.deepEqual(validateState(r.state), []);
  const drafts = r.state.transactions.filter((t) => t.source === "import");
  assert.ok(drafts.every((t) => t.status === "draft" && t.date === "2026-10-02"));
  assert.equal(pendingDrafts(r.state, "2026-10-07").length, 2, "both wait in Verify");
  const bad = planImport(s, [...lines, { date: "2026-10-02", name: "X", amount: 100, category_id: "nope" }], { account_id: "w", newId: () => "imp" + ++n });
  assert.equal(bad.ok, false); assert.match(bad.message, /^X \(2026-10-02\)/);
});

test("the reader's boxes become lines again: the same height is one line, read left to right", () => {
  const b = (text, x0, y0) => ({ text, x0, y0, x1: x0 + 40, y1: y0 + 20 });
  const text = linesByRow([b("15", 120, 62), b("02/10/2026", 10, 20), b("LRT -", 10, 60), b("100", 120, 101), b("Lunch -", 10, 100)]);
  assert.equal(text, "02/10/2026\nLRT - 15\nLunch - 100");
  assert.deepEqual(parseNotes(text).items.map((x) => [x.name, x.amount]), [["LRT", 1500], ["Lunch", 10000]]);
  assert.equal(linesByRow([]), "");
});
