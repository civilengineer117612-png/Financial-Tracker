// A set of sixteen line pictures for common goals (owner, Oct 18; eight more were asked for the same day), offered beside "Choose a photo". Plain SVG paths on a 24 x 24 grid, drawn in the current ink
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
  { id: "phone", label: "Phone", paths: ["M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z", "M11 18h2"] },
  { id: "bike", label: "Bike", paths: ["M2.0 17a3.5 3.5 0 1 0 7.0 0a3.5 3.5 0 1 0 -7.0 0z", "M15.0 17a3.5 3.5 0 1 0 7.0 0a3.5 3.5 0 1 0 -7.0 0z", "M5.5 17l3.5-8h7l2 8", "M9 9L7.5 6.5H6", "M16 9l-1.5-3.5H13"] },
  { id: "paw", label: "Pet", paths: ["M4.4 11a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0z", "M7.9 6.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0z", "M12.9 6.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0z", "M16.4 11a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0z", "M12 12c-3 0-5.5 3-5.5 5.2 0 1.8 1.5 2.3 3 2.3 1 0 1.6-.4 2.5-.4s1.5.4 2.5.4c1.5 0 3-.5 3-2.3C17.5 15 15 12 12 12z"] },
  { id: "wrench", label: "Repairs", paths: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"] },
  { id: "medical", label: "Health", paths: ["M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"] },
  { id: "wallet", label: "Wallet", paths: ["M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M3 7V6a2 2 0 0 1 2-2h12", "M16 14h2"] },
  { id: "star", label: "Dream", paths: ["M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"] },
  { id: "camera", label: "Camera", paths: ["M3 8h4l2-3h6l2 3h4v12H3z", "M8.5 13a3.5 3.5 0 1 0 7.0 0a3.5 3.5 0 1 0 -7.0 0z"] },
];

// The picture as an svg string, or null for an id we do not know (the screen then shows the goal's letter).
export function goalSymbolSvg(id, size = 20) {
  const s = GOAL_SYMBOLS.find((x) => x.id === id);
  return s ? `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${s.paths.map((d) => `<path d="${d}"/>`).join("")}</svg>` : null;
}
