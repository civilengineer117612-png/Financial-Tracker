// Turns what the owner SAID (already written out as text by the phone's speech-to-text, or typed or dictated into a box) into a
// guess for a draft: amount, date, name, category, and which account. Pure and tested. Everything is only a guess: when it is not
// sure the app asks, and nothing is saved on a guess. Understands English and everyday Filipino words.
import { wordsToCentavos, bankInText, categoryGuessFor } from "./scan.js";

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const NUMBER_WORD = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\b/i;

// Amounts said as figures ("95", "1,250.50", "1.5k") or as words ("nine hundred fifty pesos"), in centavos. More than one different amount
// means it is not clear which one is the price, so none is returned.
function amountsIn(text) {
  const found = new Set();
  for (const m of text.matchAll(/(?:₱|php|p)?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(k\b|thousand\b)?/gi)) {
    let v = Number(m[1].replace(/,/g, "") + (m[2] ?? "")) * (m[3] ? 1000 : 1);
    if (!(v > 0)) continue;
    found.add(Math.round(v * 100));
  }
  if (!found.size) {
    const tokens = text.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      if (!NUMBER_WORD.test(tokens[i])) continue;
      let best = null;
      for (let j = tokens.length; j > i; j--) {
        const c = wordsToCentavos(tokens.slice(i, j).join(" ").replace(/[.,;:]+$/, ""));
        if (c !== null && c > 0) { best = { c, j }; break; }
      }
      if (best) { found.add(best.c); i = best.j - 1; }
    }
  }
  return [...found];
}

// The day spoken: today by default; yesterday (kahapon), "2 days ago", "last Friday" and the like.
function dateIn(text, today) {
  const t = text.toLowerCase(), base = Date.parse(today + "T00:00:00Z");
  if (/\b(yesterday|kahapon|last night|kagabi)\b/.test(t)) return iso(base - DAY);
  const ago = /\b(\d+)\s+days?\s+ago\b/.exec(t);
  if (ago) return iso(base - Number(ago[1]) * DAY);
  const wd = WEEKDAYS.findIndex((d) => new RegExp("\\b" + d + "\\b").test(t));
  if (wd >= 0) { const back = ((new Date(base).getUTCDay() - wd + 7) % 7) || 7; return iso(base - back * DAY); }
  return today;
}

// The name of the place, from words such as "at Jollibee" or "sa Mercury Drug", up to a word that starts something else.
function payeeIn(text) {
  const m = /\b(?:at|sa|from|kay|to)\s+([A-Za-z0-9&'.\- ]{2,40}?)(?=\s+(?:using|via|with|gamit|thru|through|paid|yesterday|kahapon|today|ngayon|last|for|worth)\b|[,.]|$)/i.exec(text);
  const name = m?.[1]?.trim().replace(/\s+(gcash|maya|gotyme|maribank|bdo|bpi|cash)$/i, "");
  return name && name.length >= 2 ? name : null;
}

// text: what was said. state: the ledger (for category names). today: "YYYY-MM-DD".
// Returns {amount, date, payee, categoryName (a category the owner NAMED, or null), categoryRole (a guess by role: food, essentials, subscription, rent, or null), bankId, cash, direction, notes, heard}.
export function parseSpoken(text, { today, categories = [] }) {
  const heard = String(text ?? "").trim(), lower = heard.toLowerCase(), notes = [];
  const amounts = amountsIn(heard);
  const amount = amounts.length === 1 ? amounts[0] : null;
  if (amounts.length > 1) notes.push("I heard more than one amount. Say or type just the one price.");
  if (!amounts.length && heard) notes.push("I did not hear an amount.");
  const direction = /\b(received|got paid|sweldo|sahod|salary|nakuha ko|refund)\b/.test(lower) ? "in" : "out";
  if (direction === "in") notes.push("This sounds like money coming in. Choose where it goes.");
  const named = categories.filter((c) => c.kind === "expense").find((c) => new RegExp("\\b" + c.name.toLowerCase().replace(/[^a-z0-9]+/g, "\\s*") + "\\b").test(lower));
  const guess = categoryGuessFor(heard);
  return { amount, date: dateIn(heard, today), payee: payeeIn(heard), categoryName: named?.name ?? null, categoryRole: guess, bankId: bankInText(heard), cash: /\b(cash|pera|bulsa)\b/.test(lower), direction, notes, heard };
}
