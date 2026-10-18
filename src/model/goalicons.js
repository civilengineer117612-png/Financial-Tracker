// A small set of line pictures for common goals (owner, Oct 18), offered beside "Choose a photo". Plain SVG paths on a 24 x 24 grid, drawn in the current ink
// colour (so Light and Dark both work), no brand marks. A goal keeps only the id (`symbol`); the picture is drawn from here. Pure.
export const GOAL_SYMBOLS = [
  { id: "house", label: "House", paths: ["M3 11l9-8 9 8", "M5 10v10h14V10", "M10 20v-6h4v6"] },
  { id: "plane", label: "Trip", paths: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4z"] },
  { id: "laptop", label: "Laptop", paths: ["M5 5h14v11H5z", "M2 19h20"] },
  { id: "shield", label: "Safety", paths: ["M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", "M9 12l2 2 4-4"] },
  { id: "car", label: "Car", paths: ["M5 17H3v-5l2-5h14l2 5v5h-2", "M3 12h18", "M9 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0z", "M19 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"] },
  { id: "gift", label: "Gift", paths: ["M4 11h16v10H4z", "M3 7h18v4H3z", "M12 7v14", "M12 7c-1-3.5-5-3.5-5-1 0 1.5 3 1.5 5 1z", "M12 7c1-3.5 5-3.5 5-1 0 1.5-3 1.5-5 1z"] },
  { id: "school", label: "School", paths: ["M2 9l10-5 10 5-10 5z", "M6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5", "M22 9v6"] },
  { id: "heart", label: "Family", paths: ["M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z"] },
];

// The picture as an svg string, or null for an id we do not know (the screen then shows the goal's letter).
export function goalSymbolSvg(id, size = 20) {
  const s = GOAL_SYMBOLS.find((x) => x.id === id);
  return s ? `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${s.paths.map((d) => `<path d="${d}"/>`).join("")}</svg>` : null;
}
