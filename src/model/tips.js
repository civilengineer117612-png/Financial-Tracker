import { bucketOf } from "./buckets.js";
import { kindOf } from "./types.js";

// Budgeting tips shown as one note at the bottom of the budget suggestion and the Budget screen. Each is a common rule of thumb, NOT advice, and names
// where it comes from (checked against the source; owner's request). Add a tip here only with its source.
export const BUDGET_TIPS = [
  { rule: "50/30/20", text: "About 50% of take-home pay for needs, 30% for wants and 20% for savings.", source: "Warren and Tyagi, All Your Worth (2005)" },
  { rule: "Rent", text: "Keep rent near 30% of income or less; above 30% is counted as a heavy housing cost, and above 50% as severe.", source: "US housing agency (HUD) measure, dating from the 1980s" },
  { rule: "Emergency fund", text: "Build up 3 to 6 months of essential expenses, starting with a small first goal, in an account you can reach quickly.", source: "US consumer finance bureau (CFPB)" },
  { rule: "All debt", text: "Keep all loan and card payments together at about 36% of gross monthly income or less.", source: "Common lender guideline (CFPB)" },
  { rule: "Emergency fund in the Philippines", text: "Size it to your situation: about 3 months single with a steady salary, 6 for a couple, up to 9 if others depend on you, 6 to 12 if your income varies.", source: "Philippine bank and insurer guides (BPI-AIA, CIMB)" },
  { rule: "Where to keep it", text: "In an account you can withdraw from at once and that PDIC insures (up to \u20B11,000,000 per depositor per bank since March 2025), not in MP2 or a time deposit.", source: "PDIC; Philippine savings guides" },
  { rule: "Home loan", text: "Pag-IBIG caps a housing loan's monthly payment at 35% of gross monthly income.", source: "Pag-IBIG Fund guidelines" },
  { rule: "Pay yourself first", text: "Move the amount for savings on payday, before spending, so it is not what is left over.", source: "Common budgeting practice" },
];
export const TIPS_NOTE = "Rules of thumb, not advice: your own numbers come first.";

// Your own figures beside the tips, from this month's budgets and the base income: {rule: text}. Only what the app can work out is shown.
// budgets: {category_id: centavos}; ef: {balance, monthlyBasis} of the emergency fund, or null.
export function tipsYours({ income, categories, overrides = {}, budgets = {}, ef = null }) {
  if (!(income > 0)) return {};
  const pct = (a) => (Math.floor((a * 2000 + income) / (2 * income)) / 10).toFixed(1) + "%";
  let need = 0, want = 0, rent = 0, debt = 0;
  for (const c of categories) {
    if (c.kind !== "expense") continue;
    const a = budgets[c.id] ?? 0, b = bucketOf(c, overrides), k = kindOf(c);
    if (b === "need") need += a; if (b === "want") want += a;
    if (k === "rent") rent += a; if (k === "debt") debt += a;
  }
  const out = {};
  if (need || want) out["50/30/20"] = `needs ${pct(need)}, wants ${pct(want)}`;
  if (rent) out.Rent = pct(rent);
  if (debt) out["All debt"] = pct(debt);
  if (ef && ef.monthlyBasis > 0) { const m = Math.floor((ef.balance * 10) / ef.monthlyBasis) / 10; out["Emergency fund"] = `${m.toFixed(1)} months saved`; }
  return out;
}
