import { test } from "node:test";
import assert from "node:assert/strict";
import { entriesCsv, CSV_COLUMNS } from "../src/model/index.js";
import { makeState, account, tx, entry, commit } from "./fixtures.js";

// Invented entries only.
function ledger() {
  const s = makeState();
  s.accounts.push(account({ id: "wal", name: "Test Wallet", class: "asset", opening_balance: 500000 }), account({ id: "bank", name: "Test Bank", class: "asset", opening_balance: 900000 }));
  s.categories.push({ id: "rent", name: "Rent", kind: "expense" }, { id: "pay", name: "Salary", kind: "income" });
  const spend = (id, date, payee, cat, amount, acct = "wal", status = "verified", memo = "") => commit(s, { transaction: tx({ id, date, payee, memo, status }), entries: [entry({ transaction_id: id, category_id: cat, amount }), entry({ transaction_id: id, account_id: acct, amount: -amount })] });
  spend("a", "2026-10-03", "Sample Cafe", "food", 24500);
  spend("b", "2026-10-05", "Landlord, Inc.", "rent", 800000, "bank", "verified", 'said "ok"');
  spend("d", "2026-10-09", "Sample Grocer", "food", 150000, "wal", "draft");
  commit(s, { transaction: tx({ id: "p", date: "2026-10-01", payee: "Sample Employer", status: "verified" }), entries: [entry({ transaction_id: "p", category_id: "pay", amount: -3500000 }), entry({ transaction_id: "p", account_id: "bank", amount: 3500000 })] });
  commit(s, { transaction: tx({ id: "m", date: "2026-10-06", payee: "Top up", status: "verified" }), entries: [entry({ transaction_id: "m", account_id: "bank", amount: -100000 }), entry({ transaction_id: "m", account_id: "wal", amount: 100000 })] });
  return s;
}
const lines = (r) => r.csv.replace("﻿", "").trim().split("\r\n");

test("a header, then one row per verified entry, oldest first, amounts as plain numbers with money out negative", () => {
  const r = entriesCsv(ledger());
  const l = lines(r);
  assert.equal(l[0], CSV_COLUMNS.join(","));
  assert.equal(r.rows, 4, "the draft is left out unless asked for");
  assert.deepEqual(l.slice(1).map((x) => x.split(",")[0]), ["2026-10-01", "2026-10-03", "2026-10-05", "2026-10-06"]);
  assert.ok(l[1].includes("Income") && l[1].includes("35000.00") && !l[1].includes("-35000.00"), "income is positive");
  assert.ok(l[2].endsWith(",-245.00,verified"), "an expense is negative: " + l[2]);
});
test("a move between accounts shows both accounts and the amount that moved", () => {
  const l = lines(entriesCsv(ledger()));
  const move = l.find((x) => x.includes("Top up"));
  assert.ok(move.includes(",Move,,Test Bank > Test Wallet,1000.00,"), move);
});
test("commas and quotes in a name or note are quoted so the columns stay put", () => {
  const l = lines(entriesCsv(ledger()));
  const row = l.find((x) => x.includes("Landlord"));
  assert.ok(row.includes('"Landlord, Inc."') && row.includes('"said ""ok"""'), row);
});
test("a text that would run as a spreadsheet formula is kept as text", () => {
  const s = ledger();
  commit(s, { transaction: tx({ id: "x", date: "2026-10-10", payee: "=HYPERLINK(\"http://example.invalid\")", status: "verified" }), entries: [entry({ transaction_id: "x", category_id: "food", amount: 100 }), entry({ transaction_id: "x", account_id: "wal", amount: -100 })] });
  const row = lines(entriesCsv(s)).find((x) => x.startsWith("2026-10-10"));
  assert.ok(row.startsWith('2026-10-10,"\'=HYPERLINK'), row);
});
test("a date range, and drafts only when asked", () => {
  const s = ledger();
  assert.equal(entriesCsv(s, { from: "2026-10-04", to: "2026-10-06" }).rows, 2);
  const r = entriesCsv(s, { drafts: true });
  assert.equal(r.rows, 5);
  assert.ok(lines(r).some((x) => x.includes("Sample Grocer") && x.endsWith(",draft")));
});
test("it starts with a byte order mark and ends each row with a line break, and changes nothing", () => {
  const s = ledger(), before = JSON.stringify(s), r = entriesCsv(s);
  assert.ok(r.csv.startsWith("﻿") && r.csv.endsWith("\r\n"));
  assert.equal(JSON.stringify(s), before);
});
