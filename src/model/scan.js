// Turns the TEXT read from a photo (by the on-phone reader) into a guess: what kind of paper it is, the amount, the date and
// who it was with. Pure and tested; the photo never reaches this file. Everything it returns is only a guess: the owner
// sees it, corrects it, and verifies it like any other entry.
import { isPhDate } from "./util.js";

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
  ["Essentials", /grocery|supermarket|market|\bmart\b|pharmacy|drugstore|mercury|watsons|hardware|puregold|savemore|landers|meralco|water|pldt|converge|electric/],
  ["Subscription", /netflix|spotify|youtube|icloud|google one|disney|chatgpt|claude/],
  ["Rent", /\brent(al)?\b/],
];

// ---------- amounts ----------
const cleanDigits = (s) => s.replace(/(?<=\d)[Oo](?=[\d.,])|(?<=[.,\d])[Oo](?=\d)/g, "0").replace(/(?<=\d)[Il](?=[\d.,])/g, "1");
const AMOUNT_RE = /(?:₱|php|\bp\b|#|£)?\s*(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\b/gi;

function amountsIn(line) {
  const out = [];
  for (const m of cleanDigits(line).matchAll(AMOUNT_RE)) {
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
  const t = cleanDigits(text), found = [];
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
  if (kind === "gcash" || kind === "bank") return after(/(?:sent to|paid to|recipient|beneficiary|to:)(.*)/i);
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
  const labelled = find(/total|amount due|amount paid|amount sent|^\s*amount\b|\bamount\b/, /sub\s?-?total|vat|change|tendered|cash\b|discount|tax|fee|balance/);
  if (labelled) return { c: labelled, how: "total" };
  const all = lines.flatMap((l) => (/change|tendered|cash\b|vat|sub\s?-?total|discount/i.test(l) ? [] : amountsIn(l)));
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
  return { kind, kindLabel: kindById(kind).label, direction: kindById(kind).direction, amount, date, dateSeen: seen, payee: payeeFor(kind, lines), categoryGuess: category, notes, readAnything: lines.length > 0 };
}
