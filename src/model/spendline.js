// The spending line on Trends (owner, Oct 16): verified spending day by day, grouped into days, weeks or months by how far the chart is zoomed, and the
// quick ranges 1M, 3M, 6M, 1Y and All. Counts exactly what the other reports count (verified expense entries, refunds reduce it). Pure; amounts are centavos,
// dates are "YYYY-MM-DD" strings (string order is date order).
const DAY = 86400000;
const toMs = (d) => Date.parse(d + "T00:00:00Z");
const toDate = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date, n) => toDate(toMs(date) + n * DAY);
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);   // b - a
const mondayOf = (date) => addDays(date, -((new Date(toMs(date)).getUTCDay() + 6) % 7));

export const RANGES = ["1M", "3M", "6M", "1Y", "All"];

// What was spent on each date in [from, to]: Map(date -> centavos). Dates with nothing are left out.
export function dailySpending(state, { from, to }) {
  const expense = new Set(state.categories.filter((c) => c.kind === "expense").map((c) => c.id));
  const tx = new Map(state.transactions.map((t) => [t.id, t]));
  const out = new Map();
  for (const e of state.entries) {
    if (e.category_id == null || !expense.has(e.category_id)) continue;
    const t = tx.get(e.transaction_id);
    if (!t || t.status !== "verified" || t.date < from || t.date > to) continue;
    out.set(t.date, (out.get(t.date) ?? 0) + e.amount);
  }
  return out;
}

// The first date with verified spending, or null.
export function firstSpendingDate(state) {
  let first = null;
  for (const d of dailySpending(state, { from: "0000-01-01", to: "9999-12-31" }).keys()) if (first === null || d < first) first = d;
  return first;
}

// The window a quick range shows, ending today: {from, to}. "All" starts at the first spending date (or a month back when there is none).
export function rangeFor(key, today, first = null) {
  const back = { "1M": 30, "3M": 91, "6M": 182, "1Y": 364 }[key];
  if (back) return { from: addDays(today, -back), to: today };
  return { from: first && first < today ? first : addDays(today, -30), to: today };
}

// How finely a window is cut: days up to about two months, weeks up to about a year, months beyond.
export const stepFor = (from, to) => { const n = daysBetween(from, to) + 1; return n <= 62 ? "day" : n <= 400 ? "week" : "month"; };

// The window cut into steps: [{start, end, amount}] with every step present (a quiet one has 0), oldest first. A week runs Monday to Sunday and a month is a
// calendar month; the first and last are cut at the window's own edges, so the figures add up to exactly what the window holds.
export function seriesFor(state, { from, to, step = stepFor(from, to) }) {
  const days = dailySpending(state, { from, to });
  const startOf = (d) => (step === "day" ? d : step === "week" ? mondayOf(d) : d.slice(0, 7) + "-01");
  const nextOf = (s) => (step === "day" ? addDays(s, 1) : step === "week" ? addDays(s, 7) : (() => { const [y, m] = s.split("-").map(Number); return (m === 12 ? y + 1 : y) + "-" + String(m === 12 ? 1 : m + 1).padStart(2, "0") + "-01"; })());
  const out = [];
  for (let s = startOf(from); s <= to; s = nextOf(s)) out.push({ start: s < from ? from : s, end: (() => { const e = addDays(nextOf(s), -1); return e > to ? to : e; })(), amount: 0 });
  for (const [d, a] of days) { const i = out.findIndex((x) => d >= x.start && d <= x.end); if (i >= 0) out[i].amount += a; }
  return out.map((x) => ({ ...x, step }));
}

// What a dragged span holds: the steps from index i to j (either order), as {from, to, days, total, perDay}.
export function measureSpan(series, i, j) {
  if (!series.length) return null;
  const a = Math.max(0, Math.min(series.length - 1, Math.min(i, j))), b = Math.max(0, Math.min(series.length - 1, Math.max(i, j)));
  const from = series[a].start, to = series[b].end, total = series.slice(a, b + 1).reduce((n, x) => n + x.amount, 0), days = daysBetween(from, to) + 1;
  return { from, to, days, total, perDay: Math.round(total / days) };
}

// Zoom a window around a point: `factor` below 1 zooms in, above 1 zooms out; `at` (0 to 1) is where along the window the fingers are, which stays put.
// The window never goes below 7 days, never past today, and never earlier than `first` (when given).
export function zoomWindow({ from, to }, factor, at, { today, first = null }) {
  const span = daysBetween(from, to) + 1, want = Math.max(7, Math.round(span * factor));
  const anchor = Math.round(daysBetween(from, to) * at);
  let lo = addDays(from, anchor - Math.round(want * at));
  let hi = addDays(lo, want - 1);
  if (hi > today) { hi = today; lo = addDays(hi, -(want - 1)); }
  if (first && lo < first) { lo = first; hi = addDays(lo, want - 1); if (hi > today) hi = today; }
  return { from: lo, to: hi };
}
