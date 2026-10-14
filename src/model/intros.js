// The small popup that explains a screen the first time(s) it is opened: a drawing that moves, two short lines, and a check "Don't show this again".
// It returns each time the screen is opened until the check is ticked, but never more than MAX_INTRO_SHOWS times; the "?" next to a title brings it back
// whenever it is wanted. Settings: `intro_seen` {screen: how many times shown}, `intro_off` {screen: true}. Pure: the screen draws the popup.
// The words are the owner's own (Oct 14). The title is the screen's name from names.js, never typed again here.
import { SCREEN_NAMES, STRIP_NAMES } from "./names.js";

export const MAX_INTRO_SHOWS = 3;

const L = (drawing, a, b) => ({ drawing, lines: [a, b] });
// One entry per screen that needs explaining, keyed by the screen's id. Two plain lines each.
const WORDS = {
  plan: L("bars", "Plan before you spend a peso.", "Tap a bar and start planning."),
  money: L("trail", "Your money, leaving footprints.", "Tap a bar to see where."),
  income: L("columns", "Every payday, on the record.", "Tap a month to open it."),
  cards: L("cards", "What is yours, and what is borrowed.", "Swipe through your accounts."),
  budget: L("fence", "Give each habit a limit.", "Tap to set it."),
  goals: L("ring", "Dreams with a price tag.", "Tap to set yours."),
  scheduled: L("calendar", "Bills that repeat, tracked for you.", "They wait in Verify on the day."),
  checkin: L("gap", "Numbers don't lie. Face them weekly.", "A gap is shown, never hidden."),
  scan: L("paper", "Let your phone read the paper.", "All of it stays on your phone."),
  trips: L("route", "Spend on the road, count it once.", "Add dates and it fills itself."),
  buffer: L("cushion", "A cushion for rainy months.", "Tap to add to it."),
  setup: L("rows", "Make the app yours.", "Tap anything to change it."),
};
export const INTROS = Object.fromEntries(Object.entries(WORDS).map(([id, w]) => [id, { title: STRIP_NAMES[id] ?? SCREEN_NAMES[id], ...w }]));

export const introFor = (id) => INTROS[id] ?? null;

export function shouldShowIntro(settings, id) {
  return Boolean(INTROS[id]) && !settings?.intro_off?.[id] && (settings?.intro_seen?.[id] ?? 0) < MAX_INTRO_SHOWS;
}

// The settings after the popup was seen once more (and switched off for good when `off`).
// `count` false is for the popup the "?" brought back on purpose: it is not one of the automatic showings, so it is not counted (only the check can switch it off).
export function markIntro(settings, id, off = false, count = true) {
  return { ...settings, ...(count ? { intro_seen: { ...(settings?.intro_seen ?? {}), [id]: (settings?.intro_seen?.[id] ?? 0) + 1 } } : {}), ...(off ? { intro_off: { ...(settings?.intro_off ?? {}), [id]: true } } : {}) };
}

// The drawings: flat shapes in the theme's own colours, one idea each. The screen's CSS moves them (bars grow, columns rise, cards slide, a ring fills...);
// under Reduce Motion they simply stand finished. `--i` numbers the parts so they move one after another. No red, no colour of their own.
const A = "var(--accent)", T = "var(--track)", M = "var(--muted)", LN = "var(--line)", S = "var(--surface)";
const svg = (label, body) => `<svg class="in-draw" viewBox="0 0 240 96" width="240" height="96" role="img" aria-label="${label}">${body}</svg>`;
const bar = (i, x, y, w, h = 12, fill = A) => `<rect class="in-bar" style="--i:${i}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`;
const col = (i, x, h, fill = A) => `<rect class="in-col" style="--i:${i}" x="${x}" y="${88 - h}" width="22" height="${h}" rx="6" fill="${fill}"/>`;
const pop = (i, body) => `<g class="in-pop" style="--i:${i}">${body}</g>`;

const DRAWINGS = {
  bars: () => svg("Bars showing how a pay is split", `<rect x="20" y="8" width="200" height="6" rx="3" fill="${T}"/>${bar(0, 20, 8, 200, 6)}${bar(1, 20, 30, 150)}${bar(2, 20, 50, 100)}${bar(3, 20, 70, 64)}`),
  trail: () => svg("Bars with a figure at the tip", `${bar(0, 20, 12, 170)}${pop(1, `<circle cx="202" cy="18" r="3" fill="${M}"/><circle cx="214" cy="18" r="2" fill="${M}"/>`)}${bar(1, 20, 32, 120)}${pop(2, `<circle cx="152" cy="38" r="3" fill="${M}"/><circle cx="164" cy="38" r="2" fill="${M}"/>`)}${bar(2, 20, 52, 90)}${pop(3, `<circle cx="122" cy="58" r="3" fill="${M}"/><circle cx="134" cy="58" r="2" fill="${M}"/>`)}${bar(3, 20, 72, 46)}`),
  columns: () => svg("Columns, one for each payday", `<rect x="20" y="88" width="200" height="2" fill="${LN}"/>${col(0, 34, 40)}${col(1, 72, 58)}${col(2, 110, 48)}${col(3, 148, 66)}${col(4, 186, 52)}<rect class="in-col" style="--i:4" x="186" y="36" width="22" height="14" rx="4" fill="${A}" opacity=".45"/>`),
  cards: () => svg("Account cards you swipe through", `<g class="in-slide" style="--i:0"><rect x="22" y="10" width="124" height="66" rx="12" fill="${S}" stroke="${LN}"/><circle cx="42" cy="30" r="8" fill="${T}"/>${bar(0, 56, 24, 60, 6, M)}${bar(0, 36, 50, 90, 8)}</g><g class="in-slide" style="--i:1"><rect x="96" y="22" width="124" height="66" rx="12" fill="${S}" stroke="${LN}"/><circle cx="116" cy="42" r="8" fill="${T}"/>${bar(0, 130, 36, 60, 6, M)}${bar(0, 110, 62, 70, 8)}</g>`),
  fence: () => svg("Bars stopping at a limit", `${bar(0, 20, 14, 100)}${bar(1, 20, 36, 140)}${bar(2, 20, 58, 70)}<rect x="162" y="6" width="3" height="76" rx="1.5" fill="${M}"/><rect x="156" y="4" width="15" height="4" rx="2" fill="${M}"/><rect x="156" y="80" width="15" height="4" rx="2" fill="${M}"/>`),
  ring: () => svg("A ring filling toward a goal", `<circle cx="120" cy="48" r="30" fill="none" stroke="${T}" stroke-width="10"/><circle class="in-arc" style="--i:0" cx="120" cy="48" r="30" fill="none" stroke="${A}" stroke-width="10" stroke-linecap="round" stroke-dasharray="188.5" stroke-dashoffset="62" transform="rotate(-90 120 48)"/>${pop(1, `<path d="M117 44 V28 H128 L125 33 L128 38 H120 V52" fill="none" stroke="${M}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`)}`),
  calendar: () => svg("A calendar with one day lighting up", `${Array.from({ length: 21 }, (_, n) => `<circle cx="${36 + (n % 7) * 28}" cy="${22 + Math.floor(n / 7) * 24}" r="5" fill="${T}"/>`).join("")}${pop(0, `<circle cx="${36 + 3 * 28}" cy="${22 + 24}" r="9" fill="none" stroke="${A}" stroke-width="2"/><circle cx="${36 + 3 * 28}" cy="${22 + 24}" r="5" fill="${A}"/>`)}`),
  gap: () => svg("Two bars with the gap between them shown", `<rect x="20" y="16" width="200" height="6" rx="3" fill="${T}"/>${bar(0, 20, 16, 150, 6, M)}${bar(1, 20, 44, 190)}${pop(2, `<rect x="170" y="12" width="40" height="14" rx="4" fill="none" stroke="${A}" stroke-width="2"/>`)}`),
  paper: () => svg("A paper being read", `<rect x="40" y="6" width="84" height="84" rx="8" fill="${S}" stroke="${LN}"/>${bar(0, 52, 22, 56, 6, T)}${bar(0, 52, 38, 40, 6, T)}${bar(0, 52, 54, 56, 6, T)}<rect class="in-sweep" style="--i:0" x="44" y="14" width="76" height="4" rx="2" fill="${A}"/>${bar(1, 146, 22, 70)}${bar(2, 146, 44, 46)}${bar(3, 146, 66, 58)}`),
  route: () => svg("A route with a start and an end", `<path class="in-draw-line" style="--i:0" d="M24 70 C70 10 110 90 150 40 S206 28 216 24" fill="none" stroke="${A}" stroke-width="4" stroke-linecap="round" stroke-dasharray="260"/><circle cx="24" cy="70" r="6" fill="${A}"/>${pop(1, `<circle cx="216" cy="24" r="6" fill="${A}"/>`)}`),
  cushion: () => svg("A cushion filling up", `<rect x="60" y="14" width="120" height="68" rx="22" fill="${T}"/><rect class="in-col" style="--i:0" x="60" y="14" width="120" height="68" rx="22" fill="${A}" opacity=".85" clip-path="inset(34px 0 0 0 round 0 0 22px 22px)"/>`),
  rows: () => svg("Rows you can change", `<rect x="28" y="8" width="184" height="24" rx="8" fill="${S}" stroke="${LN}"/>${bar(0, 40, 17, 70, 6, M)}<rect x="28" y="36" width="184" height="24" rx="8" fill="${S}" stroke="${LN}"/><rect class="in-bar" style="--i:0" x="40" y="45" width="40" height="6" rx="3" fill="${A}"/>${pop(1, `<path d="M190 48 L196 54 L206 42" fill="none" stroke="${A}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`)}<rect x="28" y="64" width="184" height="24" rx="8" fill="${S}" stroke="${LN}"/>${bar(0, 40, 73, 90, 6, M)}`),
};
export function introDrawing(kind) { return DRAWINGS[kind]?.() ?? ""; }
