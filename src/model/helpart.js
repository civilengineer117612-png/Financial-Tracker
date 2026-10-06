// The Help drawings: pure functions that return inline SVG (nothing to download, so they work offline and can be tested in Node).
// Rules (owner's): vertical stacks with down arrows, 288 units wide (1:1 on a 320 px phone), text 12 px, one accent, NO red, only theme
// variables (through the CSS classes in app/index.html: hb box, ha accent box, hd dashed outline, hl line, hm mid text, ht text, htw text on accent).
// Every drawing has a title, a description and a one-sentence caption (the text twin). Every word that names a screen comes from names.js.
import { SCREEN_NAMES, TERMS } from "./names.js";

export const DRAWING_IDS = ["daily", "data", "cashflow", "reserve", "scan"];
const W = 288, BX = 24, BW = 240, BH = 30, GAP = 20;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n) => String(Math.round(n * 100) / 100);

// A tiny builder: items stack top to bottom, `y` is where the next one goes.
function stack() {
  const parts = []; let y = 6;
  const box = (text, cls = "hb") => { parts.push(`<rect class="${cls}" x="${BX}" y="${y}" width="${BW}" height="${BH}" rx="8"/><text class="${cls === "ha" ? "htw" : "ht"}" x="${W / 2}" y="${y + 20}" text-anchor="middle">${esc(text)}</text>`); y += BH; };
  const arrow = (label) => { const m = W / 2; parts.push(`<line class="hl" x1="${m}" y1="${y + 2}" x2="${m}" y2="${y + GAP - 7}"/><path class="hf" d="M${m - 5} ${y + GAP - 8}L${m + 5} ${y + GAP - 8}L${m} ${y + GAP - 1}Z"/>`); if (label) parts.push(`<text class="hm" x="${m + 12}" y="${y + 14}">${esc(label)}</text>`); y += GAP; };
  const note = (text) => { parts.push(`<text class="hm" x="${W / 2}" y="${y + 14}" text-anchor="middle">${esc(text)}</text>`); y += 20; };
  const tag = () => parts.push(`<text class="hm" x="${W - 6}" y="${y + 12}" text-anchor="end">Example</text>`);
  return { parts, box, arrow, note, tag, get y() { return y; }, set y(v) { y = v; }, push: (p) => parts.push(p) };
}

function wrap(id, title, description, caption, s, height) {
  const svg = `<svg class="hd" data-drawing="${id}" viewBox="0 0 ${W} ${height}" width="100%" role="img" aria-label="${esc(title)}. ${esc(description)}" xmlns="http://www.w3.org/2000/svg"><title>${esc(title)}</title><desc>${esc(description)}</desc>${s.parts.join("")}</svg>`;
  return { id, title, description, caption, svg };
}

function daily(n, t) {
  const s = stack();
  s.box(n.log, "ha"); s.arrow("you spend, you log"); s.box(`${t.draft}: waits for you`); s.arrow(); s.box(`${n.verify}: check each one`, "ha"); s.arrow(); s.box(`${t.ledger}: counted`); s.arrow(); s.box(`${n.money}, ${t.reports}`);
  return wrap("daily", "The daily loop", `Five steps, top to bottom: ${n.log}, ${t.draft}, ${n.verify}, ${t.ledger}, then ${n.money}.`,
    `Log it when you spend, check it in ${n.verify}, and only then does it count in your numbers.`, s, s.y + 8);
}

function data(n, t) {
  const s = stack();
  s.box("This phone: ledger and photos", "ha"); s.arrow(`${n.setup}, Backup`); s.box(`${t.backupFile} (needs passphrase)`); s.note("Photos are not in the backup.");
  s.note("Nothing is kept anywhere else.");
  return wrap("data", "Where your data lives", `Your ledger and photos live on this phone only. A ${t.backupFile.toLowerCase()} made in ${n.setup} holds the entries but not the photos.`,
    `Your data lives only on this phone; a backup made in ${n.setup} holds the entries, not the photos.`, s, s.y + 6);
}

function cashflow(n, t) {
  const s = stack(); s.tag(); s.y += 18;
  s.box(`${t.in}: 100`, "ha"); s.arrow("minus"); s.box(`${t.spent}: 60`); s.arrow("minus"); s.box(`${t.saved}: 15`); s.arrow("leaves"); s.box(`${t.left}: 25`, "ha");
  s.y += 10; s.note(`${t.left} = ${t.in} - ${t.spent} - ${t.saved}`); s.note("Moving money between your own accounts"); s.note("is not spending and not income.");
  return wrap("cashflow", "Where a month's money goes", `Example: ${t.in} 100, minus ${t.spent} 60, minus ${t.saved} 15, leaves ${t.left} 25. Moves between your own accounts are not counted.`,
    `${t.left} is what came in, less what you spent, less what you saved; moving money between your own accounts changes none of them.`, s, s.y + 6);
}

// owed / reserve: pesos (any unit); the bars are drawn to scale. The dashed outline is the missing part, never red.
function reserve(n, t, { owed = 60, reserve: res = 45 } = {}) {
  const s = stack(); s.tag(); s.y += 16;
  const max = Math.max(owed, res, 1), full = 200, short = Math.max(0, owed - res), x0 = 44;
  const bar = (label, v, cls) => { s.push(`<text class="ht" x="${BX}" y="${s.y + 12}">${esc(label)} ${num(v)}</text>`); s.y += 18; s.push(`<rect class="${cls}" x="${x0}" y="${s.y}" width="${Math.max(2, (full * v) / max)}" height="22" rx="4"/>`); const at = s.y; s.y += 28; return at; };
  bar(t.owed, owed, "hb"); const at = bar(t.reserve, res, "ha");
  if (short > 0) s.push(`<rect class="hd" x="${x0 + (full * res) / max}" y="${at}" width="${(full * short) / max}" height="22" rx="4"/>`);
  s.note(short > 0 ? `Short by ${num(short)}` : "Covered");
  s.note(`Checked in ${n.checks}`);
  return wrap("reserve", "The card reserve", `Example: two bars. ${t.owed} ${num(owed)} on the card, ${t.reserve} ${num(res)} set aside. ${short > 0 ? "The reserve is short by " + num(short) + ", shown as a dashed outline." : "The reserve covers it."}`,
    short > 0 ? `The ${t.reserve.toLowerCase()} should be at least what you ${t.owed.toLowerCase()}; when it is short, ${n.checks} says by how much.` : `The ${t.reserve.toLowerCase()} covers what you ${t.owed.toLowerCase()}.`, s, s.y + 4);
}

function scan(n, t) {
  const s = stack();
  s.box(`${t.photo}: receipt or payslip`, "ha"); s.arrow(); s.box("The phone reads it. Nothing is sent."); s.arrow(); s.box("You check the guess"); s.arrow(); s.box(`${t.draft} in ${n.verify}, photo beside it`);
  s.y += 6; s.note("Handwriting is not read well: type it.");
  return wrap("scan", "From photo to entry", `Four steps, top to bottom: a ${t.photo.toLowerCase()}, the phone reads it, you check the guess, then it waits as a ${t.draft.toLowerCase()} in ${n.verify}. Handwriting is not read well.`,
    `${n.scan} reads a photo on the phone itself, you check the guess, and the entry waits in ${n.verify}.`, s, s.y + 4);
}

const MAKERS = { daily, data, cashflow, reserve, scan };

// One drawing by id. `names` and `terms` default to the real ones; a test passes renamed ones to see the drawing follow.
export function drawing(id, { names = SCREEN_NAMES, terms = TERMS, ...opts } = {}) {
  const make = MAKERS[id];
  return make ? make(names, terms, opts) : null;
}

// Small line icons for the five quick notes (24 x 24, stroke only, drawn in the text colour like the menu icons).
export const NOTE_ICONS = [
  '<path d="M14.7 6.3a4 4 0 0 0 5 5L10 21l-3-3 9.7-9.7"/><path d="M14.7 6.3 18 3l3 3-3.3 3.3"/>',
  '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  '<path d="m3 11 9-8 9 8M5 10v10h14V10"/>',
  '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
];
