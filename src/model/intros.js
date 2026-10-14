// The small popup that explains a screen the first time(s) it is opened: a drawing that moves, two short lines, and a check "Don't show this again".
// It returns each time the screen is opened until the check is ticked, but never more than MAX_INTRO_SHOWS times; the "?" next to a title brings it back
// whenever it is wanted. Settings: `intro_seen` {screen: how many times shown}, `intro_off` {screen: true}. Pure: the screen draws the popup.
import { STRIP_NAMES } from "./names.js";

export const MAX_INTRO_SHOWS = 3;

// One entry per screen that needs explaining. The title is the screen's own name (names.js); two plain lines, no jargon.
export const INTROS = {
  plan: { title: STRIP_NAMES.plan, lines: ["Split each pay into what it is for.", "Tap a bar to change it."], drawing: "bars" },
};

export const introFor = (id) => INTROS[id] ?? null;

export function shouldShowIntro(settings, id) {
  return Boolean(INTROS[id]) && !settings?.intro_off?.[id] && (settings?.intro_seen?.[id] ?? 0) < MAX_INTRO_SHOWS;
}

// The settings after the popup was seen once more (and switched off for good when `off`).
export function markIntro(settings, id, off = false) {
  return { ...settings, intro_seen: { ...(settings?.intro_seen ?? {}), [id]: (settings?.intro_seen?.[id] ?? 0) + 1 }, ...(off ? { intro_off: { ...(settings?.intro_off ?? {}), [id]: true } } : {}) };
}

// The drawing: bars that grow one after another (the screen's CSS does the moving; under Reduce Motion they simply stand at full length). Theme tokens only.
export function introDrawing(kind) {
  if (kind !== "bars") return "";
  const bar = (i, w, y) => `<rect class="in-bar" style="--i:${i}" x="20" y="${y}" width="${w}" height="12" rx="6" fill="var(--accent)"/>`;
  return `<svg class="in-draw" viewBox="0 0 240 96" width="240" height="96" role="img" aria-label="Bars showing how a pay is split">
    <rect x="20" y="8" width="200" height="6" rx="3" fill="var(--track)"/><rect class="in-bar" style="--i:0" x="20" y="8" width="200" height="6" rx="3" fill="var(--ink)"/>
    ${bar(1, 150, 30)}${bar(2, 100, 50)}${bar(3, 64, 70)}</svg>`;
}
