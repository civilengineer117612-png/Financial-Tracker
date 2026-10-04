// Turns the TEXT read from a photo (by the on-phone reader) into a guess: what kind of paper it is, the amount, the date and
// who it was with. Pure and tested; the photo never reaches this file. Everything it returns is only a guess: the owner
// sees it, corrects it, and verifies it like any other entry.
import { isPhDate } from "./util.js";
import { BANKS } from "./banks.js";

export const KINDS = [   // order = who wins a tie
  { id: "payslip", label: "Payslip", direction: "in" },
  { id: "rent", label: "Rent", direction: "out" },
  { id: "ride", label: "Ride", direction: "out" },
  { id: "gcash", label: "GCash payment", direction: "out" },
  { id: "bank", label: "Bank transfer", direction: "out" },
  { id: "received", label: "Money received", direction: "in" },
  { id: "bill", label: "Bill", direction: "out" },
  { id: "receipt", label: "Store receipt", direction: "out" },
  { id: "other", label: "Something else", direction: "out" },
];
export const kindById = (id) => KINDS.find((k) => k.id === id) ?? KINDS[KINDS.length - 1];

// Words that point to a kind, each with its weight.
const CLUES = {
  payslip: [[/pay\s?slip|payroll/, 3], [/net\s*(pay|salary|income)|take[- ]?home/, 3], [/gross\s*pay|basic\s*(pay|salary)/, 2], [/withholding|sss\b|philhealth|pag-?ibig|hdmf/, 2], [/deductions?|earnings/, 1]],
  rent: [[/\brent(al)?\b|landlord|landlady|lessor/, 3], [/for the month of|acknowledg/, 1]],
  ride: [[/\bgrab\b|angkas|joyride|move\s?it|lalamove|\btaxi\b|\bride\b/, 2], [/\bfare\b|pick-?up|drop-?off|\btrip\b|driver/, 1]],
  gcash: [[/g-?cash/, 2], [/express\s*send|send\s*money|sent via/, 1], [/ref(erence)?\.?\s*no/, 1]],
  bank: [[/insta\s?pay|pesonet|fund\s*transfer|transfer\s*successful|transaction\s*successful/, 2], [/\bbdo\b|\bbpi\b|metrobank|unionbank|landbank|security\s*bank|gotyme|maribank|\bmaya\b|coins\.ph/, 2], [/\bbank\b|account\s*(no|number)/, 1]],
  received: [[/you(?:'ve| have)? received|money received|received php|credited|cash[- ]?in\b/, 3]],
  bill: [[/meralco|electric|water\s*district|maynilad|manila water|pldt|converge|billing|statement of account/, 2], [/amount due|due date/, 2]],
  receipt: [[/official receipt|\bor\s*no|\bvat\b|sub-?\s?total|cashier|\bchange\b|tendered/, 1], [/\btotal\b/, 1], [/thank you|\bitem|\bqty\b|\btin\b/, 1]],
};

// What a store or a payee points to, by NAME of the category (the app finds the category with that name, if there is one).
const CATEGORY_CLUES = [
  ["Food", /jollibee|mcdo|mcdonald|kfc|chowking|starbucks|caf[eé]|coffee|restaurant|bakery|burger|pizza|lunch|dinner|breakfast|milk\s?tea|carinderia|grill|foodpanda|grabfood|7-?eleven|ministop|mang inasal/],
  ["Essentials", /grocery|groceries|supermarket|market|palengke|\bmart\b|pharmacy|botika|drugstore|mercury|watsons|hardware|puregold|savemore|landers|meralco|water|pldt|converge|electric/],
  ["Subscription", /netflix|spotify|youtube|icloud|google one|disney|chatgpt|claude/],
  ["Rent", /\brent(al)?\b/],
];

// ---------- amounts ----------
const cleanDigitsOnce = (s) => s.replace(/(?<=\d)[Oo]+(?=[\d/.,-])|(?<=[\d/.,-])[Oo]+(?=\d)/g, (r) => "0".repeat(r.length)).replace(/(?<=\d)[Il](?=[\d/.,-])|(?<=[\d/.,-])[Il](?=\d)/g, "1");
const cleanDigits = (s) => { let t = s; for (let i = 0; i < 4; i++) { const n = cleanDigitsOnce(t); if (n === t) break; t = n; } return t; };   // "7oo.00" needs more than one pass
const AMOUNT_RE = /(?:₱|php|\bp\b|#|£)?\s*(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\b/gi;

function amountsIn(line) {
  const out = [];
  // "1.750.32" (dots as thousands) is 1,750.32; "0.00 x 114.18" is a count times a rate: only the rate is a figure
  const plain = cleanDigits(line).replace(/(\d)\.(\d{3})\.(\d{2})\b/g, "$1,$2.$3").replace(/\d+(?:\.\d+)?\s*[x×]\s*(?=\d)/gi, "");
  for (const m of plain.matchAll(AMOUNT_RE)) {
    const c = Number(m[1].replace(/,/g, "")) * 100 + Number(m[2]);
    if (Number.isSafeInteger(c) && c > 0) out.push(c);
  }
  return out;
}

// ---------- amount written in words ("Nine thousand five hundred pesos") ----------
const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD = new RegExp("\\b(" + [...Object.keys(UNITS), ...Object.keys(TENS), "hundred", "thousand", "million"].join("|") + ")\\b", "i");

// Centavos for words such as "nine thousand five hundred pesos and 50/100", or null when the words are not an amount.
export function wordsToCentavos(text) {
  const t = text.toLowerCase().replace(/-/g, " ");
  let total = 0, chunk = 0, seen = false, centavos = 0;
  const frac = /(\d{1,2})\s*\/\s*100/.exec(t);
  if (frac) centavos = Number(frac[1]);
  for (const w of t.replace(/\d{1,2}\s*\/\s*100/, " ").split(/[^a-z]+/).filter(Boolean)) {
    if (w in UNITS) { chunk += UNITS[w]; seen = true; }
    else if (w in TENS) { chunk += TENS[w]; seen = true; }
    else if (w === "hundred") { chunk = (chunk || 1) * 100; seen = true; }
    else if (w === "thousand") { total += (chunk || 1) * 1000; chunk = 0; seen = true; }
    else if (w === "million") { total += (chunk || 1) * 1000000; chunk = 0; seen = true; }
    else if (["and", "peso", "pesos", "only", "php", "centavo", "centavos"].includes(w)) continue;
    else return null;   // any other word means this is not just an amount
  }
  return seen ? (total + chunk) * 100 + centavos : null;
}

// The longest stretch of the text made only of number words (at least two of them), read as an amount.
function amountInWords(lines) {
  let best = null;
  for (const line of lines) {
    const tokens = line.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      for (let j = tokens.length; j > i + 1; j--) {
        const part = tokens.slice(i, j).join(" ");
        if (!WORD.test(tokens[i]) || !WORD.test(tokens[j - 1].replace(/[^a-z]/gi, "") || "x")) continue;
        const c = wordsToCentavos(part.replace(/[.,;:]+$/, ""));
        if (c !== null && c > 0 && (!best || j - i > best.n)) best = { c, n: j - i };
      }
    }
  }
  return best ? best.c : null;
}

// ---------- dates ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addDaysIso = (s, n) => { const t = new Date(s + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// Every date written in the text, in reading order: {iso, seen, ambiguous}.
function datesIn(text) {
  const t = cleanDigits(text).replace(/\b0ct/gi, "Oct").replace(/\b5ep/gi, "Sep"), found = [];   // a zero or a five read for the letter, same length so positions hold
  const push = (index, y, m, d, seen, ambiguous = false) => { if (isPhDate(iso(y, m, d))) found.push({ index, iso: iso(y, m, d), seen, ambiguous }); };
  for (const m of t.matchAll(/\b(20\d\d)[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) push(m.index, +m[1], +m[2], +m[3], m[0]);
  const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
  for (const m of t.matchAll(new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"))) push(m.index, +m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2], m[0]);
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})\\s+${mon},?\\s+(\\d{4})\\b`, "gi"))) push(m.index, +m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1], m[0]);
  for (const m of t.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/g)) {
    const a = +m[1], b = +m[2], y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (a > 12 && b <= 12) push(m.index, y, b, a, m[0]);   // 25/10/2026 can only be day first
    else if (a <= 12) push(m.index, y, a, b, m[0], a !== b && b <= 12);   // the Philippine habit: month first
  }
  return found.sort((x, y) => x.index - y.index);
}

// ---------- which bank or wallet paid ----------
// Spellings a bank is written in beyond its listed name. Matching ignores case, spaces and punctuation and forgives ONE wrong
// letter (a photo of a screen often misreads one), but only for names of six letters or more, so BDO and BPI must be exact.
const ALIASES = { gotyme: ["go tyme"], maribank: ["mari bank"], securitybank: ["security bank"], unionbank: ["union bank"], landbank: ["land bank"], coinsph: ["coins.ph", "coins ph"] };
const squash = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
function within1(a, b) {   // is the edit distance between a and b at most one?
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
function mentions(text, bank) {
  const hay = squash(text);
  return [bank.name, ...(ALIASES[bank.id] ?? [])].map(squash).some((n) => {
    if (hay.includes(n)) return true;
    if (n.length < 6) return false;
    for (let i = 0; i + n.length - 1 <= hay.length; i++) for (const len of [n.length - 1, n.length, n.length + 1]) if (within1(hay.slice(i, i + len), n)) return true;
    return false;
  });
}
// The bank named on the "From" line (or the line after it); otherwise the only bank named anywhere. Never a guess between two.
function bankFor(lines) {
  const at = lines.findIndex((l) => /^\s*(from|paid (with|from|using)|source( account)?|debited from)\b/i.test(l));
  if (at >= 0) for (const l of [lines[at], lines[at + 1] ?? ""]) { const hit = BANKS.find((b) => mentions(l, b)); if (hit) return hit.id; }
  const all = BANKS.filter((b) => mentions(lines.join("\n"), b));
  return all.length === 1 ? all[0].id : null;
}

// The bank named in a piece of text when exactly one is named (never a guess between two), and the category its words point to.
export const bankInText = (text) => bankFor(String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
export const categoryGuessFor = (text) => CATEGORY_CLUES.find(([, re]) => re.test(String(text ?? "").toLowerCase()))?.[0] ?? null;

// ---------- payee ----------
const NOT_A_NAME = /receipt|invoice|\btin\b|vat|date|tel\b|phone|address|official|cashier|\bor\b|reg\b|permit|thank|www\.|\.com|^\W*\d/i;
function payeeFor(kind, lines) {
  const after = (re) => {
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const same = m[1].trim().replace(/^[:\-\s]+/, "");
      const name = same.length >= 3 ? same : (lines[i + 1] ?? "").trim();
      if (name.length >= 3) return name.replace(/\d{6,}/g, "").trim();   // never keep a long number: it may be an account or phone number
    }
    return null;
  };
  if (kind === "gcash" || kind === "bank") { lines = lines.map((l) => l.replace(/^(\s*To)(?=[A-Z]{3})/, "$1 ")); return after(/(?:sent to|paid to|recipient|beneficiary|to:|^\s*to\b)(.*)/i); }   // the reader sometimes glues the word To to the name after it
  if (kind === "received") return after(/(?:received from|from:|sender)(.*)/i);
  if (kind === "rent") return after(/(?:received from|paid to|paid by|landlord|landlady)(.*)/i);
  if (kind === "payslip") return after(/(?:employer|company)(.*)/i);
  for (const l of lines.slice(0, 6)) {
    const s = l.trim();
    if (s.length >= 3 && s.length <= 40 && (s.match(/[A-Za-z]/g) ?? []).length >= s.length * 0.6 && !NOT_A_NAME.test(s)) return s;
  }
  return null;
}

// ---------- the amount itself ----------
function pickAmount(kind, lines) {
  const find = (labelRe, notRe) => {
    let hit = null;
    lines.forEach((line, i) => {
      if (!labelRe.test(line.toLowerCase()) || (notRe && notRe.test(line.toLowerCase()))) return;
      const a = amountsIn(line);
      const pick = a.length ? a[a.length - 1] : amountsIn(lines[i + 1] ?? "")[0];
      if (pick) hit = pick;   // the last matching line wins: the grand total comes after the subtotal
    });
    return hit;
  };
  if (kind === "payslip") return { c: find(/net\s*(pay|salary|income|amount)|take[- ]?home/), how: "net pay" };
  const labelled = find(/total|amount due|amount paid|amount sent|^\s*amount\b|\bamount\b/, /sub\s?-?total|vat|change|tendered|\bcash\b|discount|tax|fee|balance/);
  if (labelled) return { c: labelled, how: "total" };
  const all = lines.flatMap((l) => (/change|tendered|\bcash\b|vat|sub\s?-?total|discount/i.test(l) ? [] : amountsIn(l)));
  return all.length ? { c: Math.max(...all), how: "largest" } : { c: null, how: null };
}

const peso = (c) => "₱" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// text: what the reader found. today: "YYYY-MM-DD" (Philippine time). Returns the guess and, in plain words, what to double-check.
export function readScan(text, today) {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lower = raw.toLowerCase();
  const notes = [];

  const score = Object.fromEntries(Object.keys(CLUES).map((k) => [k, CLUES[k].reduce((n, [re, w]) => n + (re.test(lower) ? w : 0), 0)]));
  const ranked = KINDS.filter((k) => k.id !== "other").map((k) => [k.id, score[k.id]]).sort((a, b) => b[1] - a[1] || 0);   // sort is stable, so a tie keeps the KINDS order
  const kind = ranked[0][1] >= 2 ? ranked[0][0] : "other";

  const picked = pickAmount(kind, lines);
  let amount = picked.c;
  if (picked.how === "largest") notes.push("There was no line marked Total, so I took the biggest amount. Check it.");
  if (kind === "payslip" && amount === null) notes.push("I could not find the net pay line. Type it from the payslip.");

  const words = amountInWords(lines);
  if (words !== null) {
    if (amount === null) { amount = words; notes.push("I took the amount from the words on the paper (" + peso(words) + "). Check it."); }
    else if (words !== amount) notes.push("The words say " + peso(words) + " but the figures say " + peso(amount) + ". Look at the photo and fix whichever is wrong.");
  }
  if (amount === null && kind !== "payslip") notes.push("I could not find an amount. Type it.");

  let date = null, seen = null;
  const dates = datesIn(raw);
  if (dates.length) {
    seen = dates[0].seen;
    const d = dates[0];
    if (d.iso > addDaysIso(today, 1) || d.iso < addDaysIso(today, -366)) notes.push("The paper shows " + d.seen + ", which is not within the last year. Check the date.");
    else { date = d.iso; if (d.ambiguous) notes.push("I read " + d.seen + " as month first. Check the date."); }
  } else notes.push("I could not find a date, so today is used.");

  const category = kind === "rent" ? "Rent" : (CATEGORY_CLUES.find(([, re]) => re.test(lower))?.[0] ?? null);
  return { kind, bankId: bankFor(lines), creditCard: /credit\s*card/.test(lower), kindLabel: kindById(kind).label, direction: kindById(kind).direction, amount, date, dateSeen: seen, payee: payeeFor(kind, lines), categoryGuess: category, notes, readAnything: lines.length > 0 };
}

// What the owner used last time for the same payee: the most used expense category among VERIFIED entries with that name
// (a tie goes to the more recent). The more the app is used, the less it has to guess from words on the paper.
export function categoryFromHistory(state, payee) {
  const name = (payee ?? "").trim().toLowerCase();
  if (!name) return null;
  const expense = new Set(state.categories.filter((c) => c.kind === "expense").map((c) => c.id));
  const byTx = new Map();
  for (const e of state.entries) if (e.category_id != null && expense.has(e.category_id)) byTx.set(e.transaction_id, e.category_id);
  const seen = new Map();
  for (const t of state.transactions) {
    if (t.status !== "verified" || (t.payee ?? "").trim().toLowerCase() !== name || !byTx.has(t.id)) continue;
    const c = byTx.get(t.id), cur = seen.get(c) ?? { n: 0, last: "" };
    seen.set(c, { n: cur.n + 1, last: t.date > cur.last ? t.date : cur.last });
  }
  const best = [...seen].sort((a, b) => b[1].n - a[1].n || (a[1].last < b[1].last ? 1 : -1))[0];
  return best ? best[0] : null;
}

// ---------- a payslip, line by line ----------
// Reads the lines of a payslip photo's text: the earnings, the deductions (tax and what goes to government: SSS, PhilHealth, Pag-IBIG),
// the printed gross and net, the employer, the pay period and the pay date. Only a guess: the owner checks every figure in the payslip
// window, where the same four checks as for a typed payslip (src/model/income.js) point out what does not add up.
// Payslips often print two columns (this pay, and the year so far): the FIRST figure on a line is taken, and nothing after a
// "year to date" heading.
const EARNING_LABELS = [["basic", /basic|monthly\s*(salary|rate)/], ["rice", /rice/], ["skills", /skill/], ["clothing", /cloth|uniform/], ["transport", /transport/],
  ["overtime", /over\s*-?time|\bot\b/], ["thirteenth", /13\s*th|thirteenth/], ["bonus", /bonus/]];
const DEDUCTION_LABELS = [["loan", /\bloans?\b|advance/], ["tax", /with\w*ding|w\/\s*tax|\bwtax\b|\b[t1]ax\b(?!able)/], ["sss", /\b(?:sss|5ss|s5s|555)\b/], ["philhealth", /phil\s*-?health|\bphic\b|\bph[a-z]{1,5}ea/],
  ["pagibig", /pag\s*-?\s*[il1]?\s*b[il1]g|pagibig|hdmf/], ["absences", /absen|1\/2\s*day|half\s*-?\s*day/], ["lates", /\blates?\b|undertime|tardi/]];
const SKIP_LINE = /total\s*(earnings|deductions|pay)|taxable|net\s*taxable|ytd|year\s*-?\s*to\s*-?\s*date|balance|leave/;

export function readPayslip(text, today) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const notes = [], earnings = [], deductions = [];
  let printed_gross = null, printed_net = null, total_salary = null;
  const end = lines.findIndex((l) => /year\s*-?\s*to\s*-?\s*date|\bytd\b/i.test(l) && !amountsIn(l).length);
  const body = end >= 0 ? lines.slice(0, end) : lines;
  const seen = new Set();
  body.forEach((line, i) => {
    const low = line.toLowerCase();
    const first = () => { const a = amountsIn(line); if (a.length) return a[0]; const next = body[i + 1]; return next && !/[a-z]{3}/i.test(next.replace(/php|peso/gi, "")) ? (amountsIn(next)[0] ?? null) : null; };
    if (/\bgross\b/.test(low) && !/taxable/.test(low)) { printed_gross ??= first(); return; }
    if (/net\s*(pay|salary|income|amount)|take[- ]?home/.test(low)) { printed_net ??= first(); return; }
    if (/total\s*salary/.test(low)) { total_salary ??= first(); return; }
    if (SKIP_LINE.test(low)) return;
    const ded = DEDUCTION_LABELS.find(([, re]) => re.test(low)), earn = EARNING_LABELS.find(([, re]) => re.test(low));
    const hit = ded ? ["deduction", ded[0]] : earn ? ["earning", earn[0]] : null;
    if (!hit || seen.has(hit.join(":"))) return;
    const amount = first();
    if (amount) { seen.add(hit.join(":")); (hit[0] === "earning" ? earnings : deductions).push({ kind: hit[1], amount }); }
  });
  printed_gross ??= total_salary;
  if (amountsIn(lines.join("\n")).length && lines.some((l) => amountsIn(l).length > 1)) notes.push("Where a line shows two figures I took the first (this pay period). Check them.");
  if (printed_gross === null) notes.push("I could not find the printed gross pay. Type it from the payslip.");
  if (printed_net === null) notes.push("I could not find the printed net pay. Type it from the payslip.");

  // dates: the pay period (two dates on a line that says period), and the pay date
  let period_from = null, period_to = null, pay_date = null;
  const ok = (iso) => iso <= addDaysIso(today, 1) && iso >= addDaysIso(today, -366);
  // "Apr 16-30, 2026": a month, two days and a year
  const range = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2}),?\s*(\d{4})\b/i.exec(cleanDigits(lines.join("\n")));
  if (range) {
    const m = MONTHS.indexOf(range[1].toLowerCase()) + 1, a = iso(+range[4], m, +range[2]), b = iso(+range[4], m, +range[3]);
    if (isPhDate(a) && isPhDate(b) && ok(a) && ok(b)) { period_from = a; period_to = b; }
  }
  const periodAt = period_from ? -1 : lines.findIndex((l) => /period|covered|cutoff|cut-off/i.test(l) && datesIn(l).length >= 2);
  if (periodAt >= 0) {
    let [a, b] = datesIn(lines[periodAt]);
    // "01/10/2026 - 15/10/2026": the second date can only be day first, so the first is too (the month-first habit applies to a date alone)
    const dayFirst = (d) => /^(\d{1,2})[/-]/.exec(d.seen)?.[1] > 12;
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(a.seen);
    if (m && dayFirst(b) && !dayFirst(a)) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3], swapped = iso(y, +m[2], +m[1]); if (isPhDate(swapped)) a = { ...a, iso: swapped }; }
    if (ok(a.iso) && ok(b.iso)) { period_from = a.iso; period_to = b.iso; }
  }
  const payAt = lines.findIndex((l) => /pay\s*date|date\s*paid|payday|credit(ed)?\s*date|pay\s*out/i.test(l) && datesIn(l).length);
  if (payAt >= 0) { const d = datesIn(lines[payAt])[0]; if (ok(d.iso)) pay_date = d.iso; }
  if (!pay_date && !period_from) { const any = datesIn(lines.join("\n")).find((d) => ok(d.iso)); if (any) pay_date = any.iso; }
  if (!pay_date && period_to) pay_date = period_to;
  if (!pay_date) notes.push("I could not find the pay date. Choose it.");

  // the employer: a line that starts "Employer:" or "Company:", else the first name-like line at the top (usually the company's own name)
  const labelled = lines.map((l) => /^\s*(?:employer|company)(?:\s+name)?\s*[:\-]\s*(.{3,})$/i.exec(l)?.[1]).find(Boolean);
  // A line that is a figure, a payslip label or a date is never the employer. The company's name is the top line that looks like one.
  const MONTH_RANGE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:\s*(?:-|–|to)\s*\d{1,2})?,?\s*\d{4}\b/gi;
  const NOT_EMPLOYER = new RegExp([...EARNING_LABELS, ...DEDUCTION_LABELS].map(([, re]) => re.source).join("|") + "|payslip|pay\\s*slip|period|earnings|deductions|net\\s*pay|amount|gross|signature|certified|accountant|employee|name:|total", "i");
  const clean = (t) => t.replace(MONTH_RANGE, " ").replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, " ").replace(/\d{6,}/g, "").replace(/^(?:[^A-Za-z0-9]|\b[A-Za-z]\b)+\s*/, "").replace(/[\s:,;|-]+$/, "").replace(/,(?=\S)/g, ", ").replace(/\s{2,}/g, " ").trim();   // the reader drops the space after a comma
  const COMPANY_WORD = /\b(inc|corp|corporation|co|company|ltd|llc|enterprises?|services|group|hospital|school|bank|consultanc[a-z]*|engineering|construction|trading|industries|resources|solutions|technolog[a-z]*|manpower|realty|development|holdings|partners|associates|international|foundation|institute|university|college)\b\.?/i;
  const top = lines.slice(0, 12).filter((l) => !amountsIn(l).length && !NOT_EMPLOYER.test(l));
  const letters = (t) => (t.match(/[A-Za-z]/g) ?? []).length;
  const company = top.map(clean).find((l) => COMPANY_WORD.test(l) && letters(l) >= 5);
  const named = top.map(clean).find((l) => letters(l) >= 5 && letters(l) >= l.length * 0.6 && l.length <= 45);
  const employer = (labelled ? clean(labelled) : null) || company || named || null;
  return { employer, period_from, period_to, pay_date, printed_gross, printed_net, earnings, deductions, notes };
}

// ---------- text from where the words sit on the page ----------
// A payslip prints its earnings on the left and its deductions on the right, and a photo of paper is tilted. Reading order from the
// reader then mixes the columns (the earnings figures end up on the deduction labels). So: take every word with its box, find the
// tilt of the page from the words themselves, put the words into rows, and cut each row after every amount, so "label ... amount" stays
// together whichever column it is in. Returns plain text, one "label amount" line per piece. words: [{text, x0, y0, x1, y1}].
const AMOUNT_WORD = /^[₱#£]?\d{1,3}(?:,\d{3})*\.\d{2}$|^[₱#£]?\d+\.\d{2}$/;
const CURRENCY_WORD = /^(?:₱|php|p|#)$/i;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export function linesFromWords(words) {
  const w = (words ?? []).map((x) => ({ t: cleanDigits(String(x.text ?? "").trim()), x0: x.x0 ?? x.bbox?.x0, y0: x.y0 ?? x.bbox?.y0, x1: x.x1 ?? x.bbox?.x1, y1: x.y1 ?? x.bbox?.y1 }))
    .filter((x) => x.t && [x.x0, x.y0, x.x1, x.y1].every(Number.isFinite));
  if (!w.length) return "";
  const h = median(w.map((x) => x.y1 - x.y0)) || 10;
  for (const x of w) { x.cx = (x.x0 + x.x1) / 2; x.cy = (x.y0 + x.y1) / 2; }
  const cluster = (slope) => {
    const rows = [];
    for (const x of [...w].sort((a, b) => (a.cy - slope * a.cx) - (b.cy - slope * b.cx))) {
      const y = x.cy - slope * x.cx, row = rows[rows.length - 1];
      if (row && y - row.y < 0.6 * h) { row.words.push(x); row.y = (row.y * (row.words.length - 1) + y) / row.words.length; } else rows.push({ y, words: [x] });
    }
    return rows;
  };
  // the tilt of the page: the slope that makes the words fall into the fewest, fullest rows (a projection profile), then refined
  const sharp = (s) => { const bins = new Map(); for (const x of w) { const k = Math.round((x.cy - s * x.cx) / (0.5 * h)); bins.set(k, (bins.get(k) ?? 0) + (x.x1 - x.x0)); } let t = 0; for (const v of bins.values()) t += v * v; return t; };
  let slope = 0, best = sharp(0);
  for (let s = -0.15; s <= 0.15; s += 0.004) { const v = sharp(s); if (v > best * 1.0001) { best = v; slope = s; } }
  for (let s = slope - 0.004; s <= slope + 0.004; s += 0.001) { const v = sharp(s); if (v > best) { best = v; slope = s; } }
  const lines = [];
  for (const row of cluster(slope).sort((a, b) => a.y - b.y)) {
    const toks = row.words.sort((a, b) => a.x0 - b.x0).map((x) => x.t);
    const segs = [];
    let label = [];
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      if (CURRENCY_WORD.test(tok) && AMOUNT_WORD.test(toks[i + 1] ?? "")) continue;   // a currency sign belongs to the amount after it
      if (AMOUNT_WORD.test(tok)) {
        if (label.length) { segs.push({ label: label.join(" "), amounts: [tok] }); label = []; }
        else if (segs.length) segs[segs.length - 1].amounts.push(tok);   // a second figure for the same label (the year so far)
        else segs.push({ label: "", amounts: [tok] });
      } else label.push(tok);
    }
    if (label.length) segs.push({ label: label.join(" "), amounts: [] });
    for (const s of segs) lines.push((s.label + " " + s.amounts.join(" ")).trim());
  }
  return lines.join("\n");
}

// The stronger reader gives one box per printed line piece (text, its box, and the tilt of its own baseline: th). A label and its amount
// are often far apart with a gap between, and on a tilted or curled page the amount sits higher or lower than its label. So: for each label,
// the amount to its right whose height matches once the LOCAL tilt (the middle of the angles of the nearest wide boxes) is allowed for;
// each amount is used once, the closest match first. Returns plain text, one "label amount" line per piece, top to bottom.
// boxes: [{text, th, x0, y0, x1, y1}].
const BOX_AMOUNT = /^[₱#£P]?\s*\d{1,3}(?:[,.]\d{3})*[.,]\d{2}$|^[₱#£P]?\s*\d+[.,]\d{2}$/;
export function linesFromBoxes(input) {
  let w = [];
  for (const x of input ?? []) {
    // "100:00" is an amount (no clock shows hour 100); "19:52" is a time and stays
    const t = String(x.text ?? "").trim().replace(/^(\d{3,}|\d{1,3}(?:,\d{3})+|[3-9]\d|2[4-9]):(\d{2})$/, "$1.$2"); if (!t || ![x.x0, x.y0, x.x1, x.y1].every(Number.isFinite)) continue;
    const m = /^(.*[A-Za-z:.].*?)\s+([₱#£P]?\s*\d{1,3}(?:[,.]\d{3})*[.,]\d{2})$/.exec(t);   // a label and its amount read as one box: split it
    if (m && !BOX_AMOUNT.test(t)) {
      const cut = x.x0 + (x.x1 - x.x0) * (m[1].length / t.length);
      w.push({ ...x, t: m[1], x1: cut, th: x.th ?? 0 }, { ...x, t: m[2], x0: cut, th: x.th ?? 0 });
    } else w.push({ ...x, t, th: x.th ?? 0 });
  }
  if (!w.length) return "";
  for (const b of w) { b.cx = (b.x0 + b.x1) / 2; b.cy = (b.y0 + b.y1) / 2; b.h = b.y1 - b.y0; b.amount = BOX_AMOUNT.test(b.t); }
  const h = median(w.map((b) => b.h)) || 10;
  const wide = w.filter((b) => (b.x1 - b.x0) > 3 * h);
  const globalTilt = median(wide.map((b) => b.th));
  const tiltAt = (b) => {   // the tilt of the page where this box is: the middle of the angles of the wide boxes nearest to it
    const near = (wide.length >= 5 ? wide : w).map((o) => ({ d: Math.hypot(o.cx - b.cx, o.cy - b.cy), th: o.th })).sort((p, q) => p.d - q.d).slice(0, 6);
    return near.length ? median(near.map((o) => o.th)) : globalTilt;
  };
  const labels = w.filter((b) => !b.amount && /[A-Za-z]{2}/.test(b.t)), amounts = w.filter((b) => b.amount);
  const cands = [];
  for (const L of labels) for (const A of amounts) {
    if (A.cx <= L.cx || A.x0 < L.x1 - 0.5 * h) continue;
    const s = (tiltAt(L) + tiltAt(A)) / 2, r = (A.cy - L.cy) - s * (A.cx - L.cx);
    if (Math.abs(r) < 0.9 * h) cands.push({ L, A, r: Math.abs(r), dx: A.x0 - L.x1 });
  }
  cands.sort((p, q) => p.r - q.r || p.dx - q.dx);
  const pairOf = new Map(), usedA = new Set();
  for (const c of cands) if (!pairOf.has(c.L) && !usedA.has(c.A)) { pairOf.set(c.L, c.A); usedA.add(c.A); }
  const out = [];
  for (const b of w) {
    if (b.amount && usedA.has(b)) continue;
    out.push({ y: b.cy - globalTilt * b.cx, x: b.x0, text: pairOf.has(b) ? b.t + " " + pairOf.get(b).t : b.t });
  }
  return out.sort((p, q) => p.y - q.y || p.x - q.x).map((o) => o.text).join("\n");
}


// An employer name read from a photo, matched to the employers already saved (so a garbled "L PHIL. JAC, INC. Apr 16-30" or "PHIL JAG INC"
// becomes "PHIL. JAC, INC."). Letters and digits only, ignoring case; matched when one contains the other, or all but about a fifth of
// the letters agree. Returns the saved name, or the name as read when nothing is close.
export function snapEmployer(read, known) {
  const norm = (t) => String(t ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const r = norm(read);
  if (r.length < 4) return read;
  const dist = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  let best = null;
  for (const k of known ?? []) {
    const n = norm(k); if (n.length < 4) continue;
    const near = r.includes(n) || n.includes(r) || dist(r, n) <= Math.floor(Math.max(r.length, n.length) / 5);
    // when the reading holds extra words around the saved name, compare the saved name with the best same-length stretch of it
    const part = r.length > n.length ? Math.min(...Array.from({ length: r.length - n.length + 1 }, (_, i) => dist(r.slice(i, i + n.length), n))) : Infinity;
    if (near || part <= Math.floor(n.length / 5)) { const score = r.includes(n) ? 0 : Math.min(dist(r, n), part); if (!best || score < best.score) best = { name: k, score }; }
  }
  return best ? best.name : read;
}
