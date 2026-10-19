import { test } from "node:test";
import assert from "node:assert/strict";
import { groupRows, parseStatement, classifyLine, checkStatement, badLineDetails, statementItems, statementLeftOut, statementRewards } from "../src/model/index.js";

// Invented statements only (names, amounts, dates). A piece of text is {x (from the left), y (from the bottom), w (width), str}.
const t = (x, y, str, w = str.length * 5) => ({ x, y, w, str });
const money = (c) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
const rightAt = (edge, y, str) => t(edge - str.length * 5, y, str);

// "Credits / Debits / Running Balance": a full date, the description, then the three amounts, right-aligned.
function creditDebitPage({ opening, rows, period = "01 Jan 2025 - 31 Jan 2025", totals }) {
  const items = [t(40, 760, "Statement of Account"), t(40, 730, "Period: " + period), t(300, 700, "Summary"),
    t(300, 686, "Opening balance"), rightAt(560, 686, "PHP " + money(opening)), t(300, 672, "Total Credit"), rightAt(560, 672, "PHP " + money(totals.credits)),
    t(300, 658, "Total Debit"), rightAt(560, 658, "PHP " + money(totals.debits)), t(300, 644, "Closing balance"), rightAt(560, 644, "PHP " + money(totals.closing))];
  items.push(t(40, 600, "Date"), t(140, 600, "Details"), t(400, 600, "Credits"), t(470, 600, "Debits"), t(520, 600, "Running"), t(560, 600, "Balance"));
  let y = 580, balance = opening;
  for (const [date, text, credit, debit] of rows) {
    balance += credit - debit;
    items.push(t(40, y, date), t(140, y, text), rightAt(430, y, money(credit)), rightAt(495, y, money(debit)), rightAt(600, y, money(balance)));
    y -= 18;
  }
  items.push(t(40, y - 6, "All figures are in PHP."));
  return items;
}
test("a Go Save pocket statement is recognised by its GoalSave number, a main account is not", () => {
  const rows = [["27 Jan 2025", "Transfer from Deposit account", 90000, 0]], totals = { credits: 90000, debits: 0, closing: 90000 };
  const pocket = parseStatement([[...creditDebitPage({ opening: 0, rows, totals, period: "15 Jan 2025 - 31 Jan 2025" }), t(40, 745, "GoalSave No.: ********73002")]]);
  assert.equal(pocket.ok, true);
  assert.deepEqual(pocket.pocket, { last4: "3002" }, "the pocket's last four digits are kept");
  const main = parseStatement([[...creditDebitPage({ opening: 0, rows, totals, period: "15 Jan 2025 - 31 Jan 2025" }), t(40, 745, "Account Number: 011708686588")]]);
  assert.equal(main.pocket, null, "a main account statement is not a pocket");
});
const CD_ROWS = [["02 Jan 2025", "Transfer from SAMPLE PERSON, Account No. 1234", 50000, 0], ["02 Jan 2025", "Transfer to Go Save account", 0, 500], ["04 Jan 2025", "Card payment at SAMPLE STORE, Card 0000", 0, 56800],
  ["16 Jan 2025", "Interbank transfer fee", 0, 800], ["20 Jan 2025", "Outbound interbank transfer", 0, 10000]];
const CD_TOTALS = { credits: 50000, debits: 500 + 56800 + 800 + 10000, closing: 50000 - 500 - 56800 - 800 - 10000 + 0 };
const cdOk = () => parseStatement([creditDebitPage({ opening: 100000, rows: CD_ROWS, totals: { ...CD_TOTALS, closing: 100000 + CD_TOTALS.closing } })]);

test("rows: pieces within a couple of points of height are one row, read left to right, top to bottom", () => {
  const rows = groupRows([t(200, 100, "b"), t(10, 101, "a"), t(10, 50, "c"), t(30, 100, " ")]);
  assert.deepEqual(rows.map((r) => r.items.map((i) => i.str).join("")), ["ab", "c"]);
});

test("a Credits / Debits / Running Balance statement: dates, descriptions, amounts, direction, balances and the period", () => {
  const r = cdOk();
  assert.ok(r.ok);
  assert.equal(r.style, "credit-debit");
  assert.deepEqual(r.period, { from: "2025-01-01", to: "2025-01-31" });
  assert.deepEqual(r.lines.map((l) => [l.date, l.direction, l.amount]), [["2025-01-02", "in", 50000], ["2025-01-02", "out", 500], ["2025-01-04", "out", 56800], ["2025-01-16", "out", 800], ["2025-01-20", "out", 10000]]);
  assert.equal(r.lines[0].balance, 150000);
  assert.equal(r.lines[2].payee, "SAMPLE STORE", "the card number after the store is dropped");
});

test("what each line means: spending, a fee, a move to your own pocket (always), money in, and money out that does not say", () => {
  const m = cdOk().lines.map((l) => l.meaning);
  assert.deepEqual(m, ["in", "move", "spending", "fee", "unsure"]);
  assert.equal(classifyLine({ text: "Transfer from Go Save account", direction: "in" }).meaning, "move", "a Go Save line is a move, in either direction");
  assert.equal(classifyLine({ text: "Transfer to Go Save account", direction: "out" }).meaning, "move");
  assert.equal(classifyLine({ text: "Sample Cafe", type: "Card Payment", direction: "out" }).meaning, "spending");
  assert.equal(classifyLine({ text: "Sample Shop", type: "Payment", direction: "out" }).payee, "Sample Shop");
  assert.equal(classifyLine({ text: "Sample Person", type: "Transfer", direction: "out" }).meaning, "unsure");
  assert.equal(classifyLine({ text: "Sample Person", type: "Transfer", direction: "in" }).meaning, "in");
  assert.equal(classifyLine({ text: "Account upkeep", type: "Service fee", direction: "out" }).meaning, "fee");
});

test("the check: every line must follow from the balance before it, and in and out must match the totals", () => {
  const good = cdOk();
  assert.ok(good.check.ok && good.check.kind === "lines", good.check.message);
  const items = creditDebitPage({ opening: 100000, rows: CD_ROWS, totals: { ...CD_TOTALS, closing: 100000 + CD_TOTALS.closing } });
  const wrong = items.map((i) => (i.str === money(150000) ? { ...i, str: money(150100) } : i));   // one balance misread by 1.00
  const r = parseStatement([wrong]);
  assert.equal(r.check.ok, false);
  assert.ok(r.check.bad.length >= 1 && /do not follow|does not follow/.test(r.check.message));
  const details = badLineDetails(r.lines, r.summary, r.check.bad);
  assert.equal(details.length, r.check.bad.length, "one detail per failing line");
  for (const d of details) assert.ok(d.printed !== d.expected && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.amount > 0, "each shows what the bank printed and what the line before leads to");
  const i0 = r.check.bad[0], prevBal = i0 === 0 ? r.summary.opening : r.lines[i0 - 1].balance;
  assert.equal(details[0].expected, prevBal + (r.lines[i0].direction === "in" ? 1 : -1) * r.lines[i0].amount, "expected = the balance before, moved by this line");
  assert.equal(details[0].printed, r.lines[i0].balance);
  const noTotals = checkStatement("credit-debit", good.lines.map((l) => ({ ...l, balance: null })), {});
  assert.equal(noTotals.ok, false); assert.match(noTotals.message, /no totals/);
  const off = parseStatement([creditDebitPage({ opening: 100000, rows: CD_ROWS, totals: { ...CD_TOTALS, debits: CD_TOTALS.debits + 100, closing: 100000 + CD_TOTALS.closing } })]);
  assert.equal(off.check.ok, false, "totals that do not match the lines are caught");
});

// "Outgoing / Incoming": the payee above, the date and one amount, the kind below; a month alone for net interest; a day and month only.
function outInPage({ rows, period = "01 MAY 2026 to 31 MAY 2026", summary, wrapped = false }) {
  const titles = wrapped   // the titles break over two lines, with "(PHP)" and a word for the account kind
    ? [t(49, 608, "ACCOUNT"), t(146, 608, "STARTING SAVINGS"), t(160, 594, "BALANCE (PHP)"), t(265, 608, "TOTAL OUTGOING (PHP)"), t(376, 608, "TOTAL INCOMING (PHP)"), t(477, 608, "ENDING SAVINGS"), t(490, 594, "BALANCE (PHP)")]
    : [t(49, 608, "ACCOUNT"), t(146, 608, "STARTING BALANCE"), t(265, 608, "TOTAL OUTGOING"), t(376, 608, "TOTAL INCOMING"), t(477, 608, "ENDING BALANCE")];
  const items = [t(230, 640, period), ...titles,
    t(49, 567, "SAVINGS"), t(200, 567, money(summary.opening)), t(300, 567, money(summary.outgoing)), t(410, 567, money(summary.incoming)), t(520, 567, money(summary.closing)),
    t(49, 457, "DATE"), t(169, 457, "TRANSACTION"), t(364, 457, "OUTGOING"), t(406, 457, "(PHP)"), t(485, 457, "INCOMING"), t(526, 457, "(PHP)")];
  let y = 430;
  for (const [date, payee, type, out, inn] of rows) {
    items.push(t(169, y, payee), t(49, y - 7, date), t(169, y - 14, type));
    if (out) items.push(rightAt(425, y - 7, money(out))); else items.push(rightAt(545, y - 7, money(inn)));
    y -= 46;
  }
  items.push(t(500, 42, "page"), t(529, 42, "1"));
  return items;
}
const OI_ROWS = [["MAY", "Interest", "Net Interest", 0, 81], ["03 MAY", "Sample Person", "Transfer", 0, 100000], ["04 MAY", "Sample Cafe", "Card Payment", 39000, 0], ["05 MAY", "Sample Shop", "Payment", 20000, 0],
  ["06 MAY", "Sample Person", "Transfer", 280000, 0], ["07 MAY", "Interest", "Interest", 0, 40], ["07 MAY", "Interest", "Interest", 0, 41]];
const oiOk = () => parseStatement([outInPage({ rows: OI_ROWS, summary: { opening: 500000, outgoing: 39000 + 20000 + 280000, incoming: 100000 + 40 + 41, closing: 500000 + 100081 - 339000 } })]);

test("an Outgoing / Incoming statement: the payee above, the kind below, a day and month only, the year from the period", () => {
  const r = oiOk();
  assert.ok(r.ok); assert.equal(r.style, "out-in");
  assert.deepEqual(r.lines.map((l) => [l.date, l.payee, l.type, l.direction, l.amount]).slice(0, 4),
    [["2026-05-03", "Sample Person", "Transfer", "in", 100000], ["2026-05-04", "Sample Cafe", "Card Payment", "out", 39000], ["2026-05-05", "Sample Shop", "Payment", "out", 20000], ["2026-05-06", "Sample Person", "Transfer", "out", 280000]]);
  assert.deepEqual(r.lines.map((l) => l.meaning), ["in", "spending", "spending", "unsure", "in", "in"]);
});

test("'Net Interest' is the month's interest added up, so it is not a line (it would count the interest twice)", () => {
  const r = oiOk();
  assert.equal(r.lines.length, 6, "seven rows, the Net Interest one left out");
  assert.ok(!r.lines.some((l) => /net interest/i.test(l.type)));
  assert.ok(r.check.ok, r.check.message);
  assert.equal(r.check.kind, "total", "no balance after each line here: the totals are the check");
});

test("a statement across New Year gives each month its own year, and a month alone is dated the last day", () => {
  const r = parseStatement([outInPage({ period: "01 DEC 2025 to 31 JAN 2026", rows: [["15 DEC", "Sample Cafe", "Card Payment", 100, 0], ["05 JAN", "Sample Cafe", "Card Payment", 200, 0], ["JAN", "Interest", "Interest", 0, 5]], summary: { opening: 0, outgoing: 300, incoming: 5, closing: -295 } })]);
  assert.deepEqual(r.lines.map((l) => l.date), ["2025-12-15", "2026-01-05", "2026-01-31"]);
});

test("what the importer takes: spending, fees and the unsure (turned off one by one); moves and money in are counted and left out", () => {
  const r = cdOk();
  const items = statementItems(r.lines);
  assert.deepEqual(items.map((i) => [i.name, i.amount, i.meaning]), [["SAMPLE STORE", 56800, "spending"], ["Interbank transfer fee", 800, "fee"], ["Outbound interbank transfer", 10000, "unsure"]]);
  assert.ok(items.every((i) => /^s\d+$/.test(i.id) && /^\d{4}-\d{2}-\d{2}$/.test(i.dateRaw)));
  assert.deepEqual(statementLeftOut(r.lines), { moves: 1, own: 0, moneyIn: 1, rewards: 0 });
});

test("a PDF with no table of transactions says so plainly", () => {
  const r = parseStatement([[t(40, 700, "Hello"), t(40, 680, "Nothing here")]]);
  assert.equal(r.ok, false); assert.match(r.message, /No transactions/);
});

test("a long description that wraps onto the next row is one line, not a stray one", () => {
  const items = creditDebitPage({ opening: 100000, rows: CD_ROWS, totals: { ...CD_TOTALS, closing: 100000 + CD_TOTALS.closing } });
  items.push(t(140, 580 - 9, "WRAPPED PART"));   // under the first row, in the description column
  const r = parseStatement([items]);
  assert.match(r.lines[0].text, /Transfer from SAMPLE PERSON, Account No. 1234 WRAPPED PART$/);
  assert.equal(r.lines.length, 5, "the wrapped part did not become a sixth line");
  assert.ok(r.check.ok);
});

import { readFileSync, existsSync } from "node:fs";
const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8"), pdftext = readFileSync(new URL("../app/pdftext.js", import.meta.url), "utf8");

test("the PDF import: the reader is our own copy, a locked file asks for its password once, nothing is kept, and the lines go to the same preview and Verify as other imports", () => {
  assert.ok(existsSync(new URL("../src/vendor/pdf/pdf.min.mjs", import.meta.url)) && existsSync(new URL("../src/vendor/pdf/LICENSE", import.meta.url)), "pdf.js and its licence are in the repo");
  assert.match(pdftext, /import\("\.\.\/src\/vendor\/pdf\/pdf\.min\.mjs"\)/, "loaded from this site");
  assert.ok(!/https?:\/\//.test(pdftext.replace(/\/\/.*$/gm, "")), "no address outside this site in the PDF reader's loader");
  assert.match(pdftext, /task\.onPassword = async \(update, reason\) => \{[\s\S]*?askPassword\(reason === pdfjs\.PasswordResponses\.INCORRECT_PASSWORD\)/, "asks again when the password was wrong");
  assert.match(app, /const pages = await readPdfPages\(file, askPdfPassword\);/);
  assert.match(app, /accept="image\/\*,\.pdf,application\/pdf,/, "the one Import button takes a PDF too: no new button");
  assert.match(app, /case "pdf-open": \{ const typed = \$\("pdf-pw"\)\?\.value \?\? ""; const go = pdfPasswordResolve; pdfPasswordResolve = null;/, "the password is handed over once and the box is gone");
  assert.ok(!/pdf_password|pdfPassword\s*=|settings[^\n]*pdf-pw/.test(app), "the password is never stored");
  assert.match(app, /const importKept = \(f\) => f\.items\.filter\(\(x\) => x\.meaning !== "unsure" \|\| f\.choice\?\.\[x\.id\] === "spending"\);/, "an unsure line counts only once you choose Spending");
  assert.match(app, /const kept = importKept\(f\)/, "the preview counts what will be added");
  assert.match(app, /M\.previewImport\(base, importKept\(form\), form\.order, ledger\.settings\.payee_book, \{ includeRepeats: form\.repeatsIn === true \}\), r = M\.planImport/, "and only that is saved");
});

test("statement follow-ups: unsure lines wait for your choice, a failed check holds Add until you say you looked, the account is chosen by the statement's bank, and many cards show a count", () => {
  assert.match(app, /data-action="stm-choose" data-id="\$\{esc\(g\.key\)\}" data-pick="spending" aria-pressed="\$\{all\("spending"\)\}"/, "neither choice is pressed at first: one row per person");
  assert.match(app, /lines need"\} your choice<\/b>: left out until you choose/);
  assert.match(app, /held = !!f\.statement && !f\.statement\.check\.ok && !f\.looked;/);
  assert.match(app, /\(p\.lines\.length \|\| \(f\.statement && f\.keep !== false\)\) && acct && !held \? "" : " disabled"/, "Add stays off while held (and with nothing to add and nothing to keep)");
  assert.match(app, /if \(form\.statement && !form\.statement\.check\.ok && !form\.looked\) break;/, "and saving is refused too, not just greyed");
  assert.match(app, /data-action="stm-looked" aria-pressed="\$\{!!f\.looked\}">I looked at the amounts</);
  assert.match(app, /activeAccounts\(\)\.filter\(\(a\) => a\.class === \(statement\.style === "card" \? "liability" : "asset"\) && !M\.isPocket\(a\) && a\.bank === statement\.bankId\)/, "the ordinary accounts linked to the statement's bank (pockets of that bank do not count); a card statement looks among the bank's cards");
  assert.match(app, /activeAccounts\(\)\.filter\(\(a\) => M\.isPocket\(a\) && a\.last4 === statement\.pocket\.last4\)/, "a pocket statement goes to the pocket whose last four digits it names");
  assert.match(app, /auto = newPocket \? NEW_POCKET : linked\.length === 1 \? linked\[0\]\.id : null/, "chosen for you only when exactly one account fits");
  assert.match(app, /account_id: auto \?\? \(statement \? null : cashFirst\(activeAccounts\(\)\)\[0\]\?\.id \?\? null\)/, "a statement is never filed under Cash by default: the owner chooses");
  assert.match(app, /chosen for you/);
  assert.match(app, /seq\.length > 6 \? `<span class="dotcount" data-of="\$\{seq\.length\}">1 of \$\{seq\.length\}<\/span>`/);
});

test("a listed bank's name near the top of the first page is shown and used to choose the account; an unknown name is not", () => {
  const items = creditDebitPage({ opening: 100000, rows: CD_ROWS, totals: { ...CD_TOTALS, closing: 100000 + CD_TOTALS.closing } });
  const named = parseStatement([[t(40, 790, "GoTyme Bank"), ...items]]);
  assert.deepEqual([named.bank, named.bankId], ["GoTyme", "gotyme"]);
  const plain = parseStatement([items]);
  assert.deepEqual([plain.bank, plain.bankId], [null, null]);
});

import { nameKey, holderNames, isOwnName, unsureByPerson } from "../src/model/index.js";

test("your own name: initials, punctuation and Jr do not matter; the first and last words do", () => {
  assert.deepEqual(nameKey("Sample P. Dela Cruz, Jr."), { first: "sample", last: "cruz" });
  const holders = holderNames(groupRows([t(40, 760, "BANK STATEMENT"), t(40, 723, "SAMPLE PEDRO DELA CRUZ JR"), t(40, 708, "ACCOUNT NUMBER 0000"), t(40, 690, "12 Sample Street, Sample City")]));
  assert.deepEqual(holders, [{ first: "sample", last: "cruz" }], "only the name line counts: not the title, the account line or the address");
  assert.ok(isOwnName("Sample P. Dela Cruz, Jr.", holders));
  assert.ok(isOwnName("Transfer to SAMPLE D. CRUZ GoTyme Bank, Account No. 0000", holders), "a transfer description naming you, with the bank's name in it");
  assert.ok(!isOwnName("Sample Friend", holders), "another person with the same first name is not you");
  assert.ok(!isOwnName("Other Cruz", holders), "nor someone with the same last name");
  assert.ok(!isOwnName("Atome", holders), "nor a one-word payee");
});

test("a transfer to or from your own name is a move between your accounts: never spending, never income, and never asked", () => {
  const page = outInPage({ rows: [["03 MAY", "Sample P. Dela Cruz, Jr.", "Transfer", 0, 100000], ["04 MAY", "Sample P. Dela Cruz, Jr.", "Transfer", 50000, 0], ["05 MAY", "Sample Friend", "Transfer", 20000, 0], ["06 MAY", "Sample Cafe", "Payment", 10000, 0]],
    summary: { opening: 500000, outgoing: 80000, incoming: 100000, closing: 520000 } });
  const r = parseStatement([[t(40, 723, "SAMPLE PEDRO DELA CRUZ JR"), ...page]]);
  assert.deepEqual(r.lines.map((l) => l.meaning), ["move", "move", "unsure", "spending"]);
  assert.ok(r.lines[0].own && r.lines[1].own);
  assert.deepEqual(statementLeftOut(r.lines), { moves: 0, own: 2, moneyIn: 0, rewards: 0 }, "said as transfers to your own name");
  assert.equal(statementItems(r.lines).filter((i) => i.meaning === "unsure").length, 1, "only the friend is asked about");
  const noName = parseStatement([page]);
  assert.deepEqual(noName.lines.map((l) => l.meaning), ["in", "unsure", "unsure", "spending"], "with no name at the top, nothing is guessed");
});

test("one choice per person: a person's unsure lines are one group with a count and a total, the biggest first; one tap answers them all", () => {
  const items = [{ id: "s1", name: "Sample Friend", amount: 1000, meaning: "unsure", dateRaw: "2025-01-02" }, { id: "s2", name: "SAMPLE  FRIEND.", amount: 2500, meaning: "unsure", dateRaw: "2025-01-09" },
    { id: "s3", name: "Sample Lender", amount: 4000, meaning: "unsure", dateRaw: "2025-01-05" }, { id: "s4", name: "Sample Cafe", amount: 300, meaning: "spending", dateRaw: "2025-01-06" }];
  const g = unsureByPerson(items);
  assert.deepEqual(g.map((x) => [x.name, x.ids, x.total]), [["Sample Lender", ["s3"], 4000], ["Sample Friend", ["s1", "s2"], 3500]], "spending lines are not asked; case and dots do not split a person");
  assert.match(app, /case "stm-choose": \{ const g = M\.unsureByPerson\(ui\.form\.items\)\.find\(\(x\) => x\.key === id\); if \(g\) ui\.form\.choice = \{ \.\.\.\(ui\.form\.choice \?\? \{\}\), \.\.\.Object\.fromEntries\(g\.ids\.map/, "the choice is written for every line of that person");
  assert.match(app, /Show the \$\{n\} lines/);
  assert.match(app, /transfers"\} to your own name/);
});

test("totals titles that wrap over two lines are still read, so the check can run", () => {
  const summary = { opening: 500000, outgoing: 39000 + 20000 + 280000, incoming: 100000 + 40 + 41, closing: 500000 + 100081 - 339000 };
  const r = parseStatement([outInPage({ rows: OI_ROWS, summary, wrapped: true })]);
  assert.deepEqual(r.summary, { opening: summary.opening, outgoing: summary.outgoing, incoming: summary.incoming, closing: summary.closing });
  assert.equal(r.check.ok, true);
  const off = parseStatement([outInPage({ rows: OI_ROWS, summary: { ...summary, outgoing: summary.outgoing + 100 }, wrapped: true })]);
  assert.equal(off.check.ok, false);
});

// ----- GCash: Date and Time / Description / Reference No. / Debit / Credit / Balance (debit BEFORE credit), invented numbers -----
// A description that wraps is centred on its row (its first part above the date and amounts, its second below). A bank cash-in prints a balance of 0.00.
function gcashPage(rows, { split = false, startAt = 0 } = {}) {
  const items = [t(300, 900, "GCash Transaction History"), t(300, 870, "2023-01-01 to 2023-03-31"),
    t(8, 800, "Date and Time"), t(190, 800, "Description"), t(700, 800, "Reference No."), rightAt(940, 800, "Debit"), rightAt(1060, 800, "Credit"), rightAt(1190, 800, "Balance"),
    t(190, 774, "STARTING BALANCE"), rightAt(1190, 774, money(startAt))];
  let y = 740;
  for (const [date, time, text, ref, debit, credit, shown] of rows) {
    const wrap = text.length > 60 ? [text.slice(0, text.indexOf(" with ")), text.slice(text.indexOf(" with ") + 1)] : [text];
    if (split) items.push(t(8, y, date), t(80, y, time)); else items.push(t(8, y, date + " " + time));
    if (wrap.length === 2) { items.push(t(190, y + 8, wrap[0]), t(190, y - 8, wrap[1])); } else items.push(t(190, y, wrap[0]));
    items.push(t(700, y, ref));
    if (debit) items.push(rightAt(940, y, money(debit))); if (credit) items.push(rightAt(1060, y, money(credit))); items.push(rightAt(1190, y, money(shown)));
    y -= 34;
  }
  return items;
}
const OWN = "09170000001", FRIEND = "09170000002", SHOP = "09170000003";
const GC_ROWS = [
  ["2023-01-05", "02:54 PM", "Received GCash from Sample Bank and Trust Co. with account ending in 0000 and invno:111", "6000000000001", 0, 30000, 0],   // printed balance 0.00: the quirk
  ["2023-01-05", "02:56 PM", `Transfer from ${OWN} to ${FRIEND}`, "6000000000002", 5000, 0, 25000],
  ["2023-01-06", "10:08 AM", `Transfer from ${FRIEND} to ${OWN}`, "6000000000003", 0, 10000, 35000],
  ["2023-01-07", "08:51 PM", `Buy Load Transaction for ${OWN}`, "0000000000004", 1100, 0, 33900],
  ["2023-01-09", "09:51 AM", `Received GCash from Sample Bank and Trust Co. with account ending in 0000 and invno:222`, "6000000000005", 0, 70000, 0],   // quirk again
  ["2023-01-09", "10:25 AM", `Buy Load Transaction for ${SHOP}`, "0000000000006", 9900, 0, 94000],
];
const gcOk = (o) => parseStatement([gcashPage(GC_ROWS, o)]);

test("a GCash statement: ISO dates with a time, the debit column before the credit, the reference number kept out of the text, a wrapped description joined, the period from its header", () => {
  const r = gcOk();
  assert.equal(r.ok, true, r.message); assert.equal(r.style, "gcash"); assert.equal(r.bank, "GCash"); assert.deepEqual(r.period, { from: "2023-01-01", to: "2023-03-31" });
  assert.equal(r.lines.length, 6);
  assert.deepEqual(r.lines.map((l) => [l.date, l.direction, l.amount]), [["2023-01-05", "in", 30000], ["2023-01-05", "out", 5000], ["2023-01-06", "in", 10000], ["2023-01-07", "out", 1100], ["2023-01-09", "in", 70000], ["2023-01-09", "out", 9900]]);
  assert.match(r.lines[0].text, /^Received GCash from Sample Bank and Trust Co\. with account ending in 0000 and invno:111$/, "both halves of the wrapped text, in order");
  assert.ok(r.lines.every((l) => !/6000000000|0000000000004/.test(l.text)), "no reference number in the description");
  assert.equal(r.summary.opening, 0);
});

test("GCash's printed 0.00 after money received from a bank is replaced by the working-out, and the line after it is checked against it", () => {
  const r = gcOk();
  assert.deepEqual(r.lines.map((l) => l.balance), [30000, 25000, 35000, 33900, 103900, 94000], "300, 250, 350, 339, then 339 + 700 = 1039, then 940");
  assert.equal(r.check.ok, true); assert.equal(r.check.kind, "lines");
  const wrong = GC_ROWS.map((x, i) => (i === 5 ? [...x.slice(0, 6), 94100] : x));
  const bad = parseStatement([gcashPage(wrong)]);
  assert.equal(bad.check.ok, false); assert.deepEqual(bad.check.bad, [5], "a misread balance after the quirk line is still caught");
});

test("GCash lines mean: load is spending, a cash-in from a bank is money in, a transfer goes by its column and names the OTHER number as the person", () => {
  const r = gcOk();
  assert.deepEqual(r.lines.map((l) => l.meaning), ["in", "unsure", "in", "spending", "in", "spending"]);
  assert.equal(r.lines[0].payee, "Cash in from Sample Bank and Trust Co. ending 0000"); assert.equal(r.lines[0].last4, "0000");
  assert.equal(r.lines[1].payee, FRIEND, "out: the person is the number it went TO");
  assert.equal(r.lines[2].payee, FRIEND, "in: the person is the number it came FROM");
  assert.equal(r.lines[3].payee, "Buy load");
});

test("GCash with the time as its own piece after the date reads the same", () => {
  assert.deepEqual(gcOk({ split: true }).lines.map((l) => [l.date, l.amount, l.balance]), gcOk().lines.map((l) => [l.date, l.amount, l.balance]));
});

// The other GCash lines: payments to a merchant, a refund, money sent to a bank account, cash-in at a kiosk with a printed balance.
const GC2 = [
  ["2023-02-01", "09:00 AM", "Received GCash from Sample Kiosk", "6000000000011", 0, 50000, 50000],   // a kiosk prints its real balance
  ["2023-02-02", "09:30 AM", "Payment to Sample Telecom One Click", "0000000000012", 9900, 0, 40100],
  ["2023-02-03", "10:00 AM", "Payment to Sample Music AB, Merchant Transaction Number: ABC123XYZ", "0000000000013", 8500, 0, 31600],
  ["2023-02-04", "11:00 AM", "Buy Load Transaction for " + SHOP, "0000000000014", 1600, 0, 30000],
  ["2023-02-04", "11:00 AM", "GCash Transaction with Parent Ref.No. 123456789", "0000000000015", 0, 1600, 31600],
  ["2023-02-05", "12:00 PM", "Sent GCash to Sample Bank with account ending in 6588", "6000000000016", 15000, 0, 16600],
  ["2023-02-06", "01:00 PM", "Sent GCash to Other Bank with account ending in 7777", "6000000000017", 600, 0, 16000],
];
const gc2 = (o) => parseStatement([gcashPage(GC2, { startAt: 0 })], o);

test("GCash payments to a merchant are spending and name the merchant (the transaction number is dropped); a refund line is money in", () => {
  const r = gc2();
  assert.deepEqual(r.lines.map((l) => l.meaning).slice(0, 5), ["in", "spending", "spending", "spending", "in"]);
  assert.deepEqual(r.lines.slice(1, 3).map((l) => l.payee), ["Sample Telecom One Click", "Sample Music AB"]);
  assert.equal(r.lines[4].payee, "Refund");
  assert.equal(r.check.ok, true, r.check.message);
});

test("money sent to a bank account names the bank and its last four digits; one of YOUR accounts' last four makes it a move between your own accounts", () => {
  const plain = gc2();
  assert.deepEqual([plain.lines[5].meaning, plain.lines[5].payee, plain.lines[5].last4], ["unsure", "Sample Bank ending 6588", "6588"]);
  const mine = gc2({ ownLast4: ["6588"] });
  assert.deepEqual([mine.lines[5].meaning, mine.lines[5].own], ["move", true]);
  assert.equal(mine.lines[6].meaning, "unsure", "another bank account that is not yours stays unsure");
  assert.equal(mine.lines[0].meaning, "in", "a kiosk cash-in has no account digits and stays money in");
  assert.equal(mine.lines[0].balance, 50000, "a balance GCash really printed is kept");
});

test("a statement headed with the bank's OLD name (SeaBank, now MariBank) is still recognised as that bank", () => {
  const items = creditDebitPage({ opening: 100000, rows: CD_ROWS, totals: { ...CD_TOTALS, closing: 100000 + CD_TOTALS.closing } });
  const r = parseStatement([[t(40, 790, "SeaBank A Rural Bank"), ...items]]);
  assert.deepEqual([r.bank, r.bankId], ["MariBank", "maribank"]);
  assert.equal(parseStatement([[t(40, 790, "Sea Bank"), ...items]]).bankId, "maribank");
});

test("cashback, a campaign reward and interest are marked as rewards; a loan or a transfer in is not", () => {
  const c = (text, type, direction = "in") => classifyLine({ text, type, direction });
  assert.deepEqual(c("Debit Card Cashback", "Reward"), { meaning: "in", payee: "Debit Card Cashback", reward: true });
  assert.equal(c("Campaign Reward", "Reward").reward, true);
  assert.equal(c("Cashback Credit", "Cashback").reward, true, "a card's cashback credit reads the same way");
  assert.equal(c("Interest", "Interest").reward, true);
  assert.equal(c("Loan Disbursement", "Loan").reward, undefined, "a loan paid out is money in, not a reward");
  assert.equal(c("Sample Person", "Transfer").reward, undefined, "a transfer in is not a reward");
  assert.equal(c("Debit Card Cashback", "Reward", "out").reward, undefined, "money out is never a reward");
  const lines = [{ date: "2026-08-08", text: "Debit Card Cashback", payee: "Debit Card Cashback", amount: 138, direction: "in", meaning: "in", reward: true }, { date: "2026-08-09", text: "Loan Disbursement", payee: "Loan Disbursement", amount: 499055, direction: "in", meaning: "in" }];
  assert.deepEqual(statementRewards(lines), [{ date: "2026-08-08", name: "Debit Card Cashback", amount: 138 }]);
  assert.deepEqual(statementLeftOut(lines), { moves: 0, own: 0, moneyIn: 1, rewards: 1 }, "rewards are counted apart from other money in");
});

test("a card statement (posted date, transaction date, merchant above, kind below, signed amounts) reads, adds up and keeps its dates", () => {
  const page = [
    t(40, 700, "Statement Period"), t(200, 700, ": 30 SEP 2026 to 15 OCT 2026"),
    t(40, 650, "PREVIOUS"), t(300, 650, "CURRENT"), t(40, 640, "BALANCE (PHP)"), t(300, 640, "BALANCE (PHP)"),
    t(40, 620, "0.00"), t(90, 620, "0.00"), t(140, 620, "0.00"), t(190, 620, "650.00"), t(240, 620, "0.00"), t(290, 620, "5.00"), t(340, 620, "0.00"), t(390, 620, "645.00"),
    t(40, 560, "POSTED DATE"), t(140, 560, "TRANSACTION DATE"), t(300, 560, "DESCRIPTION"), rightAt(700, 560, "AMOUNT (PHP)"),
    t(300, 540, "SAMPLE CAFE"), t(40, 530, "04 OCT"), t(140, 530, "02 OCT"), rightAt(700, 530, "-150.00"), t(300, 520, "Credit Card Transaction"),
    t(300, 490, "SAMPLE MART"), t(40, 480, "03 OCT"), t(140, 480, "01 OCT"), rightAt(700, 480, "-500.00"), t(300, 470, "Credit Card Transaction"),
    t(300, 440, "Cashback Applied"),
    t(300, 420, "Cashback Credit"), t(40, 410, "15 OCT"), t(140, 410, "15 OCT"), rightAt(700, 410, "+5.00"), t(300, 400, "Cashback"),
  ];
  const r = parseStatement([page]);
  assert.equal(r.ok, true); assert.equal(r.style, "card");
  assert.deepEqual(r.lines.map((l) => [l.date, l.payee, l.amount, l.direction, l.meaning]), [
    ["2026-10-02", "SAMPLE CAFE", 15000, "out", "spending"], ["2026-10-01", "SAMPLE MART", 50000, "out", "spending"], ["2026-10-15", "Cashback Credit", 500, "in", "in"]], "dated by the transaction date, not the day the bank posted it");
  assert.equal(r.lines[2].reward, true, "a cashback credit is a reward line");
  assert.equal(r.check.ok, true, r.check.message);
  assert.deepEqual([r.summary.opening, r.summary.closing, r.summary.incoming, r.summary.outgoing], [0, 64500, 500, 65000]);
  assert.deepEqual(statementItems(r.lines).map((i) => i.amount), [15000, 50000], "the purchases are offered; the cashback credit is not an expense");
  const wrong = parseStatement([page.map((p) => (p.str === "645.00" ? { ...p, str: "700.00" } : p))]);
  assert.equal(wrong.check.ok, false, "a current balance that does not follow from the lines is caught");
});
