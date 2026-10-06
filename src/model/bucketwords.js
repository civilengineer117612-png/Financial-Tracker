// Reading a category's BUCKET from its name: the words people in the Philippines commonly use for their budget categories, in English, Filipino and
// Taglish, with common shorthand. A clear word sets the bucket by itself; a word on the ASK list, or no word at all, means the name is not clear and the
// owner is asked once (Need, Want, Savings, or Keep in Other). The owner approved these lists; add words here, nowhere else.
// Matching ignores capitals and accents and looks for whole words or phrases anywhere in the name ("Grocery (SM)" reads as grocery). A plural "s" also
// matches. When several words match, the LONGEST one wins ("food delivery" beats "food"); on a tie, ASK wins, then savings, want,
// need. The "other" words count only when nothing clearer is in the name ("Other bills" reads as bills).
export const BUCKET_WORDS = {
  ask: [   // depends on the person, so always asked (owner's choice)
    "family", "pamilya", "padala", "remittance", "allowance", "sustento", "regalo", "gift", "pet", "abuloy", "tithe", "ikapu", "donation", "charity", "ambag",
    "utang", "pautang", "loan", "credit card", "cc", "hulog", "installment", "bayad utang", "sapatos", "shoe", "gym", "fitness",
  ],
  need: [
    // home
    "rent", "renta", "upa", "apartment", "apt", "condo", "dorm", "boarding", "boarding house", "bedspace", "bed space", "amortization", "amort", "mortgage",
    "assoc", "association dues", "hoa", "condo dues", "bahay",
    // food at home
    "food", "pagkain", "grocery", "groceries", "grocs", "palengke", "market", "supermarket", "bigas", "rice", "ulam", "gulay", "karne", "isda", "baon",
    "sari sari", "sarisari", "tindahan", "water refill", "refill",
    // utilities
    "utilities", "utility", "utils", "bill", "kuryente", "electricity", "electric", "meralco", "tubig", "water", "maynilad", "manila water", "internet",
    "wifi", "wi fi", "pldt", "globe", "smart", "converge", "dito", "load", "eload", "e load", "prepaid", "postpaid", "lpg", "gasul", "cooking gas",
    // transport
    "transport", "transpo", "transportation", "commute", "pamasahe", "fare", "jeep", "jeepney", "tricycle", "trike", "bus", "mrt", "lrt", "beep", "angkas",
    "joyride", "grab", "taxi", "gas", "gasolina", "gasoline", "fuel", "diesel", "petrol", "parking", "toll", "autosweep", "easytrip", "rfid", "car", "sasakyan",
    // health
    "health", "medicine", "meds", "gamot", "doctor", "doktor", "checkup", "check up", "consult", "hospital", "ospital", "dental", "dentist", "philhealth",
    "phic", "hmo", "insurance", "vitamin", "pharmacy", "botika", "mercury drug",
    // must-pay and basics
    "essentials", "essential", "toiletries", "hygiene", "laundry", "labada", "sabon", "household", "sss", "gsis", "pag ibig", "pagibig", "hdmf", "tax",
    "buwis", "bir", "tuition", "school", "eskwela", "matrikula", "school supplies", "damit", "clothes", "clothing", "uniform",
  ],
  want: [
    // eating out
    "dining", "dining out", "eat out", "eating out", "kain sa labas", "restaurant", "resto", "kainan", "fast food", "fastfood", "jollibee", "jolli", "mcdo",
    "mcdonalds", "kfc", "chowking", "mang inasal", "inasal", "samgyup", "samgyupsal", "unli", "buffet", "delivery", "food delivery", "grabfood", "foodpanda",
    "takeout", "take out", "milk tea", "milktea", "coffee", "kape", "starbucks", "sbux", "cafe", "snack", "merienda", "dessert", "pulutan",
    // going out and fun
    "fun", "lakat", "gimik", "gala", "galaan", "lamyerda", "inuman", "inom", "tagay", "alak", "beer", "bar", "party", "movie", "sine", "cinema", "game",
    "gaming", "steam", "mobile legends", "diamond", "hobby", "hobbies", "concert", "travel", "bakasyon", "vacation", "outing", "staycation", "date",
    "hangout", "entertainment", "leisure", "libangan", "luho",
    // streaming and memberships
    "subscription", "subs", "netflix", "spotify", "disney", "youtube premium", "yt premium", "hbo", "viu", "iwantv", "prime video", "icloud", "apple music",
    "google one", "chatgpt", "membership",
    // shopping and treats
    "shopping", "shopee", "lazada", "tiktok shop", "mall", "ukay", "ukay ukay", "gadget", "budol", "haul", "online shopping", "accessories", "makeup",
    "cosmetics", "skincare", "salon", "parlor", "spa", "massage", "masahe", "nails",
  ],
  savings: [
    "ipon", "savings", "saving", "emergency fund", "invest", "investment", "stocks", "mp2", "uitf", "mutual fund", "crypto", "retirement", "pension",
    "upskill", "upskilling", "course", "training", "seminar", "certification", "review", "book", "learning", "education fund", "alkansya",
  ],
  other: ["other", "others", "misc", "miscellaneous", "iba pa", "sundry", "extra", "various"],
};

const ORDER = ["ask", "savings", "want", "need", "other"];   // tie-break, strongest first
const norm = (s) => ` ${String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
const LIST = ORDER.flatMap((kind) => BUCKET_WORDS[kind].map((w) => ({ kind, w: norm(w).trim() })));

// What the name says: {bucket: "need" | "want" | "savings" | "other" | null, word}. null means not clear (an ASK word, or no word at all).
export function readBucket(name) {
  const n = norm(name);
  let best = null;
  for (const x of LIST) {
    if (!(n.includes(` ${x.w} `) || n.includes(` ${x.w}s `))) continue;
    if (best && x.kind === "other" && best.kind !== "other") continue;   // "the rest" words count only when nothing clearer is there ("Other bills" is bills)
    if (!best || (best.kind === "other" && x.kind !== "other") || x.w.length > best.w.length) best = x;   // longest wins; on a tie the stronger kind stays
  }
  if (!best || best.kind === "ask") return { bucket: null, word: best?.w ?? null };
  return { bucket: best.kind, word: best.w };
}
