// Guessing a category's TYPE from its name, so the owner can confirm it with one tap. A guess is only ever a hint: it is shown as "(guess)", it is never
// stored, and nothing is assigned until the owner taps. Keywords include common Filipino words. No guess (null) means "Other" is not assumed either: the
// category is shown as not yet typed and counted under "Other" until a Type is chosen.
const WORDS = [
  ["debt", /\b(debt|utang|loan|loans|credit ?card|cc payment|hulog|installment|amortization|mortgage|sss loan|pag-?ibig loan)\b/],
  ["subscription", /\b(subscription|subscriptions|netflix|spotify|youtube|icloud|disney|hbo|prime|chatgpt|membership|apple music|google one)\b/],
  ["utilities", /\b(utilities|utility|electric|electricity|kuryente|water|tubig|meralco|internet|wifi|wi-fi|load|prepaid|postpaid|mobile plan|phone bill|bills?)\b/],
  ["dining", /\b(dining|restaurant|resto|eat ?out|eating out|kainan|jollibee|mcdo|starbucks|coffee|kape|cafe|café|milk ?tea|boba|fast ?food|delivery|grabfood|foodpanda|takeout|take-out|snacks?|merienda)\b/],
  ["essentials", /\b(essentials?|toiletries|hygiene|household|laundry|labada|sabon)\b/],
  ["rent", /\b(rent|renta|upa|apartment|apartelle|condo|dorm|boarding ?house|lease|bedspace|bed space)\b/],
  ["transport", /\b(transport|transpo|commute|fare|pamasahe|jeep|jeepney|tricycle|trike|bus|mrt|lrt|angkas|grab|taxi|gas|gasoline|fuel|petrol|parking|toll|motorcycle|moto|habal)\b/],
  ["food", /\b(food|groceries|grocery|palengke|market|pagkain|kain|ulam|bigas|rice|supermarket|meals?|lunch|baon|sari-?sari|ingredients)\b/],
  ["shopping", /\b(shopping|shopee|lazada|tiktok ?shop|clothes|clothing|damit|sapatos|shoes|mall|gadgets?|bili)\b/],
  ["fun", /\b(fun|entertainment|movies?|sine|cinema|games?|gaming|hobby|hobbies|gimik|inuman|drinks|party|concert|travel|vacation|trip|date|lakat|gala|laro|hangout)\b/],
  ["family", /\b(family|pamilya|parents|magulang|nanay|tatay|mama|papa|mom|dad|padala|remittance|sustento|kapatid|siblings|support)\b/],
  ["invest", /\b(invest|investment|upskill|upskilling|course|courses|training|seminar|certification|books?|learning|review)\b/],
];

export function guessType(name) {
  const n = String(name ?? "").toLowerCase();
  for (const [type, re] of WORDS) if (re.test(n)) return type;
  return null;
}

// What a category's Type is, and whether the owner has confirmed it: a stored Type (the category's `role`) is confirmed, carried over from before or chosen
// by a tap. With none stored, the name's guess is offered (or nothing).
// The kind of a category where one matters out of sight (rent, food and essentials for the Emergency Fund, the typed rent): the stored one, else its name's.
export const kindOf = (category) => category.role ?? guessType(category.name);

export function typeOf(category) {
  if (category.role) return { type: category.role, confirmed: true, guess: false };
  const g = guessType(category.name);
  return { type: g, confirmed: false, guess: g !== null };
}
