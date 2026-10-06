// The how-to clips: short looping animations drawn from the owner's OWN screen (their quick tiles, their account and its picture, today's date and
// total), so what they watch is what they will see. Pure functions that return markup; the motion itself is CSS in app/index.html (classes hw-*), and
// with Reduce Motion on the finished frame is shown. Nothing is logged or changed by a clip: it is only a picture. With no tiles or accounts yet, plainly
// marked examples stand in. Each clip has ONE caption (owner's choice). Never a real receipt: the scan clip draws an invented one.
import { formatPesos } from "./money.js";

export const HOWTOS = [
  { id: "log", label: "Log an expense", caption: "Tap a tile, check it, Save: logged in two taps." },
  { id: "verify", label: "Verify an entry", caption: "Open Verify, look at one entry, tap Correct." },
  { id: "scan", label: "Scan a receipt", caption: "Tap the camera, take the receipt, and it waits in Verify." },
];
export const HOWTO_HINT = "Hold Log, Verify or the camera for a moment to watch how it works.";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const EXAMPLE_TILES = [{ name: "Coffee", amount: 15000, category: "Food" }, { name: "Jeep", amount: 1300, category: "Transport" }, { name: "Lunch", amount: 9500, category: "Food" }];

// data: {date: "Tue, 7 Oct", tiles: [{name, amount (centavos), category}], account: {name, picture?: html for its picture}, total: centavos logged today}
export function clipData({ date, tiles = [], account = null, total = 0 }) {
  const own = tiles.slice(0, 3);
  return { date, total, example: own.length === 0 || !account, tiles: own.length ? own : EXAMPLE_TILES, account: account ?? { name: "Wallet" } };
}

const phone = (id, inner, label) => `<div class="hw hw-${id}" role="img" aria-label="${esc(label)}">${inner}<div class="hw-finger" aria-hidden="true"></div></div>`;
const sheet = (rows, button) => `<div class="hw-sheet">${rows}<div class="hw-btn">${esc(button)}</div></div>`;
const tick = `<svg class="hw-done" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28"/><path d="M20 33 l8 8 l16 -18"/></svg>`;
const acct = (a) => `<span class="hw-acct">${a.picture ?? ""}<span>${esc(a.name)}</span></span>`;

export function howtoClip(id, raw) {
  const d = clipData(raw), pick = d.tiles[Math.min(1, d.tiles.length - 1)], ex = d.example ? `<div class="hw-ex">Example</div>` : "";
  if (id === "log") {
    const tiles = d.tiles.map((t) => `<div class="hw-tile${t === pick ? " hw-pick" : ""}"><b>${esc(t.name)}</b><span>${esc(formatPesos(t.amount))}</span><i>${esc(t.category)}</i></div>`).join("");
    return phone("log", `<div class="hw-screen">${ex}<div class="hw-h">Log</div><div class="hw-date">${esc(d.date)}</div>
      <div class="hw-total"><span class="hw-t0">${esc(formatPesos(d.total))}</span><span class="hw-t1">${esc(formatPesos(d.total + pick.amount))}</span></div>
      <div class="hw-tiles">${tiles}</div></div><div class="hw-nav"><div>Log</div><div>Verify</div></div>
      ${sheet(`<div class="hw-amt">${esc(formatPesos(pick.amount))}</div><div class="hw-row"><span>${esc(pick.name)}</span><span>${esc(pick.category)}</span></div><div class="hw-row"><span>Paid from</span>${acct(d.account)}</div>`, "Save")}${tick}`,
      `A finger taps the ${pick.name} tile, the window shows ${formatPesos(pick.amount)} paid from ${d.account.name}, the finger taps Save, a tick appears and today's total goes up.`);
  }
  if (id === "verify") {
    return phone("verify", `<div class="hw-screen">${ex}<div class="hw-h">Verify</div><div class="hw-date">One at a time</div>
      <div class="hw-card"><div class="hw-amt">${esc(formatPesos(pick.amount))}</div><div class="hw-row"><span>${esc(pick.name)}</span><span>${esc(pick.category)}</span></div>
      <div class="hw-row"><span>Paid from</span>${acct(d.account)}</div><div class="hw-row"><span>Date</span><span>${esc(d.date)}</span></div><div class="hw-btn hw-ok">Correct</div></div>
      <div class="hw-empty">All checked</div></div><div class="hw-nav"><div>Log</div><div class="hw-on">Verify</div></div>${tick}`,
      `A finger opens Verify, the entry ${pick.name} ${formatPesos(pick.amount)} from ${d.account.name} is shown, the finger taps Correct and a tick appears.`);
  }
  if (id === "scan") {
    const receipt = `<div class="hw-receipt"><b>SAMPLE STORE</b><span>Bread<em>85.00</em></span><span>Eggs<em>110.00</em></span><span>Milk<em>50.00</em></span><span class="hw-rt">TOTAL<em>245.00</em></span><div class="hw-scanline"></div></div>`;
    return phone("scan", `<div class="hw-screen"><div class="hw-top"><div class="hw-h">Log</div><div class="hw-cam" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></div></div>
      <div class="hw-date">${esc(d.date)}</div>${receipt}</div><div class="hw-nav"><div>Log</div><div>Verify</div></div>
      ${sheet(`<div class="hw-amt">${esc(formatPesos(24500))}</div><div class="hw-row"><span>Sample Store</span><span>${esc(d.date)}</span></div><div class="hw-row"><span>Paid from</span>${acct(d.account)}</div>`, "Save as a draft")}${tick}`,
      `A finger taps the camera, an invented receipt is read, the window shows 245 pesos from Sample Store paid from ${d.account.name}, and it is saved as a draft for Verify.`);
  }
  return "";
}
