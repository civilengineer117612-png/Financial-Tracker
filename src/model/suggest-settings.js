// The ONE table the suggestion engine (suggest.js) reads its settings from. Everything is whole numbers: ratios are in basis points
// (100 = 1%, 10000 = 100%) and money is integer centavos, so nothing is ever a fraction.
//
// STARTER RATIOS are used ONLY when there is too little logged history to learn from, and nowhere else in the app.
// They are a common rule of thumb (the "50/30/20" idea with a small buffer taken from savings), NOT advice: the owner approves or edits them.
export const SUGGEST_DEFAULTS = {
  starter: { needs: 5000, wants: 3000, savings: 1500, buffer: 500 },   // must add up to 10000
  min_entries: 10,         // a month needs at least this many verified spending entries to count as logged properly
  max_unlogged_bps: 1000,  // ...and Unlogged must be below this share of the month's spending (1000 = 10%)
  savings_floor: 0,        // the least to set aside each month when no ratchet owns the amount (centavos)
  buffer_amount: null,     // the overrun buffer each month (centavos); null means the starter share of pay
};

const whole = (n) => Number.isSafeInteger(n) && n >= 0;

// Fills in defaults and checks every figure; returns {ok, settings} or {ok: false, message}.
export function resolveSettings(given = {}) {
  const s = { ...SUGGEST_DEFAULTS, ...given, starter: { ...SUGGEST_DEFAULTS.starter, ...(given.starter ?? {}) } };
  for (const k of ["needs", "wants", "savings", "buffer"]) if (!whole(s.starter[k])) return { ok: false, message: `The starter ratio for ${k} must be a whole number of basis points.` };
  if (s.starter.needs + s.starter.wants + s.starter.savings + s.starter.buffer !== 10000) return { ok: false, message: "The four starter ratios must add up to exactly 100%." };
  if (!whole(s.min_entries)) return { ok: false, message: "The minimum number of entries must be a whole number." };
  if (!whole(s.max_unlogged_bps) || s.max_unlogged_bps > 10000) return { ok: false, message: "The Unlogged limit must be a whole number of basis points, 0 to 10000." };
  if (!whole(s.savings_floor)) return { ok: false, message: "The savings floor must be whole centavos." };
  if (s.buffer_amount !== null && !whole(s.buffer_amount)) return { ok: false, message: "The buffer must be whole centavos." };
  return { ok: true, settings: s };
}
