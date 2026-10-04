// The screens. All money rules live in ../src/model; this file only draws and handles taps.
// Plain and firm, never harsh: facts are stated once, nothing is red, nothing blocks logging.
import * as M from "../src/model/index.js";
import { readBoth, writeBoth, putPhoto, getPhoto, deletePhoto, useTrialStorage, clearTrialStorage } from "./store.js";
import { preparePhoto, readPage, evenedCopy } from "./ocr.js";
import { speechSupported, listen } from "./voice.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => M.phTimestamp().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const longDate = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-PH", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const newId = (prefix) => prefix + "-" + crypto.randomUUID();
const peso = M.formatPesos;
const BACKUP_NOTE_DAYS = 7;   // the Log page mentions a missing or old backup once it is a week old

let ledger = M.emptyLedger();   // {rev, state, settings}
let device = { status: "OK", message: "", allowEntry: true };
let boot = { status: "NONE", repairTo: null };
const ui = {
  tab: "log", menu: false, sheet: null, form: {}, error: null, confirmDelete: null, confirmRemove: null, setupError: null,
  accountForm: { name: "", bank: null, sub: "", kind: "asset", opening: "", covers: "" },
  period: null, periodDraft: null, view: "category", shape: "bars", asList: false, sel: null,   // the Money tab
};
let toastTimer = null;

// ---------- reading helpers ----------
const S = () => ledger.state;
const activeAccounts = () => S().accounts.filter((a) => !a.archived);
const accountName = (id) => S().accounts.find((a) => a.id === id)?.name ?? "?";
const categoryName = (id) => S().categories.find((c) => c.id === id)?.name ?? "?";
const expenseCategories = () => S().categories.filter((c) => c.kind === "expense" && c.id !== M.UNLOGGED_CATEGORY_ID);

// The picture the owner chose for an account, or a plain first-letter tile until they do.
// A listed bank's logo, loaded once for every bank (see "bank logos" below) and kept in the phone's settings.
function bankLogo(bankId) {
  const l = bankId ? ledger.settings.bankLogos?.[bankId] : null;
  if (l?.icon?.startsWith("data:image/")) return { icon: l.icon };
  if (l?.icon_url?.startsWith("https://")) return { icon_url: l.icon_url };
  return null;
}
function iconOf(a, size = 28) {
  // An account's own picture wins; otherwise its bank's logo (linked, or plainly named after the bank); otherwise a letter.
  if (!a.icon && !a.icon_url) { const l = bankLogo(a.bank ?? (a.name ? M.bankForName(a.name)?.id : null)); if (l) a = { ...a, ...l }; }
  if (a.icon) return `<img class="ico" src="${esc(a.icon)}" alt="" width="${size}" height="${size}">`;
  const letter = [...a.name][0]?.toUpperCase() ?? "?";
  const mono = `<span class="ico mono" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px" aria-hidden="true">${esc(letter)}</span>`;
  // A logo shown from an icon service sits over the letter tile; if it cannot load (offline) the letter stays.
  return a.icon_url ? `<span class="icowrap" style="width:${size}px;height:${size}px">${mono}<img class="ico ov" src="${esc(a.icon_url)}" alt="" width="${size}" height="${size}" onerror="this.remove()"></span>` : mono;
}
const withIcon = (a, size) => iconOf(a, size) + `<span>${esc(a.name)}</span>`;

// Accounts for a payment, the one you used last first (for this preset, then in general).
function accountsFor(presetId) {
  const { last_account_by_preset: byPreset = {}, last_account_id: last } = ledger.settings;
  const rank = (a) => (a.id === byPreset[presetId] ? 0 : a.id === last ? 1 : 2);
  // A reserve only holds money set aside for a card; you never pay from it.
  return activeAccounts().filter((a) => !a.reserve_for).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// One line about a transaction, whatever kind it is.
function describe(t) {
  const es = S().entries.filter((e) => e.transaction_id === t.id);
  const cat = es.find((e) => e.category_id != null), acct = es.find((e) => e.account_id != null);
  if (cat && acct && es.filter((e) => e.category_id == null).every((e) => e.account_id === acct.account_id) && es.filter((e) => e.category_id != null).length === 1) {
    if (S().categories.find((c) => c.id === cat.category_id)?.kind === "income") return { kind: "income", editable: false, title: t.payee || categoryName(cat.category_id), category_id: cat.category_id, account_id: acct.account_id, amount: Math.abs(cat.amount), detail: accountName(acct.account_id) };
    return { kind: "expense", editable: es.length === 2, title: t.payee || categoryName(cat.category_id), category_id: cat.category_id, account_id: acct.account_id, amount: Math.abs(cat.amount), detail: accountName(acct.account_id) };
  }
  const parts = es.filter((e) => e.category_id != null), accts = es.filter((e) => e.category_id == null);
  if (parts.length >= 2 && accts.length === 1 && parts.every((e) => S().categories.find((c) => c.id === e.category_id)?.kind === "expense")) {
    return { kind: "split", editable: false, title: t.payee || "Split purchase", account_id: accts[0].account_id, amount: parts.reduce((n, e) => n + e.amount, 0), detail: accountName(accts[0].account_id),
      parts: parts.map((e) => ({ name: categoryName(e.category_id), amount: e.amount })) };
  }
  if (es.length === 2 && es.every((e) => e.account_id != null)) {
    const from = es.find((e) => e.amount < 0), to = es.find((e) => e.amount > 0);
    return { kind: "transfer", editable: false, title: t.payee || "Transfer", amount: to.amount, detail: accountName(from.account_id) + " to " + accountName(to.account_id) };
  }
  return { kind: "other", editable: false, title: t.payee || "Entry", amount: es.filter((e) => e.amount > 0).reduce((n, e) => n + e.amount, 0), detail: "" };
}

const isGenerated = (t) => t.id.startsWith("rsv:");
const dueDrafts = () => M.pendingDrafts(S(), addDays(today(), -1)).filter((t) => !isGenerated(t));

// ---------- saving ----------
async function commit(state, settings = ledger.settings, { quiet = false } = {}) {
  const next = M.nextLedger(ledger, state, settings);
  const r = await writeBoth(JSON.stringify(next));
  ledger = next;   // keep working in memory even if a store failed; the banner says so
  const failed = [!r.local && "localStorage", !r.idb && "IndexedDB"].filter(Boolean);
  ui.error = failed.length ? "Could not save to " + failed.join(" and ") + ". What you see is not safely stored yet. The next save tries again." : null;
  // A background save (the logos) must not rebuild an open window and lose what is being done in it.
  if (!quiet) renderAll(); else { renderBanner(); if (!document.activeElement?.matches("input, textarea, select")) renderScreen(); if (ui.sheet?.type === "banks") renderSheet(); }   // the screen behind a window may change; the window stays
  if (!ledger.settings.bankLogosTried && !logoRun && failed.length === 0) loadBankLogos();   // a new install: logos after the first save
  return failed.length === 0;
}

// ---------- rendering ----------
function renderAll() { renderBanner(); renderScreen(); renderNav(); renderSheet(); renderMenu(); }

// Everything that is not Log or Verify lives in the menu at the upper left, so new screens (and later photo
// and audio capture beside Log and Verify) can be added without crowding the bottom bar.
// Plain line icons (drawn in the text colour). Groups are separated by thin lines, like a settings list.
const ICONS = {
  money: '<path d="M3 3v16a2 2 0 0 0 2 2h16M18 17V9M13 17V5M8 17v-3"/>',
  budget: '<path d="M21 12c.55 0 1-.45.95-1a10 10 0 0 0-8.95-8.95c-.55-.05-1 .4-1 .95v8a1 1 0 0 0 1 1z"/><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/>',
  goals: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  plan: '<path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/>',
  checks: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  trips: '<path d="M20 10c0 5-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 15 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  income: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/>',
  buffer: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  checkin: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  setup: '<path d="M10 5H3M12 19H3M14 3v4M16 17v4M21 12h-9M21 19h-5M21 5h-7M8 10v4M8 12H3"/>',
};
const MENU = [["Overview", [["money", "Spending"], ["income", "Income"], ["budget", "Budget"], ["goals", "Goals"], ["plan", "Pay plan"], ["checks", "Checks"], ["trips", "Trips"], ["buffer", "Buffer"]]], ["Capture", [["scan", "Scan"]]], ["Weekly", [["checkin", "Check-in"]]]];   // Setup is pinned at the bottom

function renderTop(title) {
  const lines = `<svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true"><rect y="0" width="22" height="3" rx="1.5" fill="currentColor"/><rect y="6.5" width="22" height="3" rx="1.5" fill="currentColor"/><rect y="13" width="22" height="3" rx="1.5" fill="currentColor"/></svg>`;
  // One scanner button: it opens the two choices, camera or photos/files.
  const camera = device.allowEntry && ui.tab === "log" ? `<button class="camicon" data-action="open-scan-pick" aria-label="Scan a receipt or payment screen: take a photo or choose from photos or files"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.scan}</svg></button>` : "";
  const mic = device.allowEntry && ui.tab === "log" ? `<button class="camicon micbtn" data-action="open-voice" aria-label="Say an entry out loud"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.mic}</svg></button>` : "";
  $("top").innerHTML = (device.allowEntry ? `<button class="menubtn" id="menuBtn" data-action="open-menu" aria-label="Menu" aria-expanded="${ui.menu}">${lines}</button>` : "") + `<h1>${esc(title)}</h1>` + mic + camera;
}

function renderMenu() {
  if (!ui.menu || !device.allowEntry) { $("menu").innerHTML = ""; return; }
  const item = (id, label) => `<button class="item" data-action="tab" data-tab="${id}"${ui.tab === id ? ' aria-current="page"' : ""}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg><span>${label}</span></button>`;
  const age = M.daysSinceBackup(ledger.settings, today());
  const backup = age === null ? "No backup yet" : "Last backup " + age + (age === 1 ? " day ago" : " days ago");
  $("menu").innerHTML = `<div class="scrim" data-action="close-menu"></div><aside class="drawer" role="dialog" aria-label="Menu">
    <div class="groups">${MENU.map(([group, items]) => `<p class="glabel">${group}</p>${items.map(([id, label]) => item(id, label)).join("")}`).join('<hr>')}</div>
    <div class="foot"><p class="note">${backup}</p>${item("setup", "Setup")}</div></aside>`;
}

function renderBanner() {
  const bars = [];
  if (ui.error) bars.push(`<div class="bar" role="alert">${esc(ui.error)}</div>`);
  const showDevice = device.status === "TRIAL" || (device.status !== "OK" && !(device.status === "EMPTY" && S().accounts.length > 0));
  if (showDevice) {
    const repair = device.status === "PARTIAL_LOSS" && boot.ledger ? `<p><button data-action="repair">Copy the surviving data into the empty store</button></p>` : "";
    const trial = device.status === "TRIAL" ? `<p><button data-action="reset-trial">${ui.confirmTrial ? "Tap again to erase the trial copy" : "Start the trial over"}</button></p>` : "";
    bars.push(`<div class="bar" role="status">${esc(device.message)}${repair}${trial}</div>`);
  }
  $("banner").innerHTML = bars.join("");
}

function renderNav() {
  const n = device.allowEntry ? dueDrafts().length : 0;
  const tab = (id, label) => `<button data-action="tab" data-tab="${id}"${ui.tab === id ? ' aria-current="page"' : ""}>${label}</button>`;
  $("nav").innerHTML = tab("log", "Log") + tab("verify", n ? `Verify (${n})` : "Verify");   // photo and audio will join these two
}

function renderScreen() {
  // Each view starts with its own <h1>; it is moved up into the bar beside the menu button.
  const html = !device.allowEntry ? `<h1>Finance</h1><p class="note">Entry is switched off on this device. See the note above.</p>`
    : ui.tab === "verify" ? viewVerify() : ui.tab === "setup" ? viewSetup() : ui.tab === "money" ? viewMoney() : ui.tab === "budget" ? viewBudget() : ui.tab === "checkin" ? viewCheckin() : ui.tab === "goals" ? viewGoals() : ui.tab === "plan" ? viewPlan() : ui.tab === "checks" ? viewChecks() : ui.tab === "trips" ? viewTrips() : ui.tab === "buffer" ? viewBuffer() : ui.tab === "scan" ? viewScan() : ui.tab === "income" ? viewIncome() : viewLog();
  const m = /^<h1>([^<]*)<\/h1>/.exec(html);
  renderTop(m ? m[1] : "Finance");
  $("screen").innerHTML = m ? html.slice(m[0].length) : html;
  hydratePhotos();
}

// The big number on the Log screen is the total for the day being looked at: today, or the day picked with "Select date".
// "Back to today" returns to today. The date box is the phone's own picker, hidden under the link so nothing crowds the screen.
function dayCard() {
  const picked = ui.dayPick && ui.dayPick !== today() ? ui.dayPick : null;
  const d = M.dayTotal(S(), picked ?? today());
  const words = (picked ? longDate(picked) : "Today") + " " + peso(d.total) + (d.drafts ? ", including " + d.drafts + " not yet verified" : "");
  return `<div class="daytotal" role="status" aria-label="${esc(words)}">${peso(d.total)}</div>
    ${picked ? `<p class="center daycap">${esc(longDate(picked))}</p>` : ""}
    <p class="center"><button class="link datelink" data-action="open-cal">${picked ? "Change date" : "Select date"}</button>${picked ? ` \u00b7 <button class="link" data-action="reset-day">Back to today</button>` : ""}</p>`;
}

function viewLog() {
  if (activeAccounts().length === 0) {
    return `<h1>Log</h1><p class="sub">${esc(longDate(today()))}</p><p class="note">Add the accounts you pay from first.</p>
      <button class="primary" data-action="tab" data-tab="setup">Add accounts</button>`;
  }
  const due = dueDrafts().length;
  const shown = ui.dayPick && ui.dayPick !== today() ? ui.dayPick : today();   // the list follows the day chosen with "Select date"
  const todays = S().transactions.filter((t) => t.date === shown && !isGenerated(t)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const age = M.daysSinceBackup(ledger.settings, today());
  const backupNote = age === null || age >= BACKUP_NOTE_DAYS
    ? `<p class="note"><button class="link" data-action="tab" data-tab="setup">${age === null ? "No backup yet" : "Last backup " + age + " days ago"}</button></p>` : "";
  const dueNote = due ? `<p class="note"><button class="link" data-action="tab" data-tab="verify">${due} ${due === 1 ? "entry" : "entries"} from before today ${due === 1 ? "needs" : "need"} verifying</button></p>` : "";
  const trip = S().tags.find((t) => t.id === ledger.settings.active_tag_id);
  const tripNote = trip ? `<p class="note">Tagging new entries: ${esc(trip.name)}. <button class="link" data-action="stop-trip">Stop</button></p>` : "";
  const waitingPhotos = scanQueue().filter((q) => !q.needs).length, needLook = scanQueue().filter((q) => q.needs).length;
  const photoNote = (ui.scan?.busy ? `<p class="note" id="scan-msg" role="status">${esc(ui.scan.msg)}</p>` : ui.scan?.error ? `<p class="note" role="alert">${esc(ui.scan.error)}</p>` : "")
    + (needLook ? `<p class="note"><button class="link" data-action="open-queue">${needLook} photo${needLook === 1 ? " needs" : "s need"} a look</button></p>` : "")
    + (waitingPhotos && !ui.scan?.busy ? `<p class="note">${waitingPhotos} photo${waitingPhotos === 1 ? " is" : "s are"} kept, waiting to be read. <button class="link" data-action="read-queue">Read now</button></p>` : "");
  return `<h1>Log</h1><p class="sub">${esc(longDate(today()))}</p>${photoNote}${dueNote}${backupNote}${tripNote}
    ${dayCard()}
    <div class="tiles">${S().presets.map((p) => `<button class="tile" data-action="open-preset" data-id="${esc(p.id)}"><b>${esc(p.name)}</b><span>${peso(p.amount)}</span></button>`).join("")}</div>
    <p><button class="primary" data-action="open-other" style="margin-top:12px">Other amount</button></p>
    <h2 class="today">${shown === today() ? "Today" : esc(longDate(shown))}</h2>${todays.length ? todays.map(rowFor).join("") : `<p class="note">Nothing logged ${shown === today() ? "today" : "that day"}.</p>`}`;
}

function rowFor(t) {
  const d = describe(t);
  const acct = d.kind === "expense" ? S().accounts.find((a) => a.id === d.account_id) : null;
  return `<div class="row"><div>${esc(d.title)}<small class="who" style="gap:6px">${acct ? iconOf(acct, 16) : ""}<span>${esc(d.detail)}${t.status === "draft" ? " · draft" : " · verified"}</span></small></div><div class="amt">${peso(d.amount)}</div></div>`;
}

// Everything waiting, oldest first. Nothing has to wait for tomorrow: verify whenever you have the time.
// Only entries from BEFORE today count as "due" (the tab badge and the note on the Log page).
const allDrafts = () => M.pendingDrafts(S(), today()).filter((t) => !isGenerated(t));

function viewVerify() {
  const list = allDrafts();
  const due = dueDrafts().length, fresh = list.length - due;
  const parts = [due && `${due} from before today`, fresh && `${fresh} from today, ready whenever you are`].filter(Boolean);
  const head = `<h1>Verify</h1><p class="sub">${parts.length ? parts.join(" · ") : "One at a time, look at each entry."}</p>`;
  if (!list.length) return head + `<p class="note">Nothing to verify.</p>`;
  const t = list[0], d = describe(t);
  const partner = S().transactions.find((x) => x.id === "rsv:" + t.id);
  const fields = d.kind === "expense"
    ? `<dt>Category</dt><dd>${esc(categoryName(d.category_id))}</dd><dt>Paid from</dt><dd class="who">${withIcon(S().accounts.find((a) => a.id === d.account_id), 22)}</dd>`
    : d.kind === "split" ? `${d.parts.map((p, i) => `<dt>${i ? "&nbsp;" : "Split"}</dt><dd>${esc(p.name)} ${peso(p.amount)}</dd>`).join("")}<dt>Paid from</dt><dd class="who">${withIcon(S().accounts.find((a) => a.id === d.account_id), 22)}</dd>`
    : d.kind === "income" ? `<dt>Arrived in</dt><dd class="who">${withIcon(S().accounts.find((a) => a.id === d.account_id), 22)}</dd>`
    : d.detail ? `<dt>Between</dt><dd>${esc(d.detail)}</dd>` : "";
  const reserve = partner ? `<dt>Also</dt><dd>reserve transfer ${peso(describe(partner).amount)}</dd>` : "";
  const del = ui.confirmDelete === t.id;
  const shot = M.attachmentsFor(S(), t.id)[0];
  const fromPhoto = t.source === "photo" ? `<p class="note">Read from the photo. Compare each line with the paper before you tap Correct.</p>`
    : t.source === "voice" ? `<p class="note">Made from what you said${t.memo ? ": \u201C" + esc(t.memo) + "\u201D" : ""}. Check each line before you tap Correct.</p>` : "";
  return `${head}<p class="note">1 of ${list.length}</p>
    <div class="card">${shot ? `<button class="shotbtn" data-action="open-photo" data-id="${esc(shot.id)}" aria-label="Open the photo full size"><img class="shot" data-photo="${esc(shot.id)}" alt="The photo this entry was read from" hidden></button>` : ""}${fromPhoto}<div class="what">${esc(d.title)}</div><div class="big">${peso(d.amount)}</div>
      <dl><dt>Date</dt><dd>${esc(longDate(t.date))}</dd>${fields}${reserve}</dl>
      <div class="actions">
        <button class="primary wide" data-action="verify-ok" data-id="${esc(t.id)}">Correct</button>
        <button data-action="verify-edit" data-id="${esc(t.id)}">Edit</button>
        <button data-action="verify-delete" data-id="${esc(t.id)}">${del ? "Tap again to delete" : "Delete"}</button>
      </div></div>`;
}

// ---------- Income: where every peso of pay comes from ----------
const incomeYear = () => ui.incomeYear ?? today().slice(0, 4);
const flagLine = (f) => `<p class="note flag">▲ ${esc(f.message)}</p>`;   // a triangle plus words, never colour alone
function hbars(rows) {   // plain horizontal bars with the value at the tip; the table below each chart is its list twin
  const max = Math.max(...rows.map((r) => r.amount), 1);
  return `<div class="bars">${rows.map((r) => `<div class="brow"><span class="btop"><span class="bname">${esc(r.label)}</span><span class="bval">${peso(r.amount)}</span></span><span class="btrack"><span class="bfill" style="width:${Math.max(r.amount > 0 ? 1 : 0, Math.round((r.amount * 100) / max))}%"></span></span></div>`).join("")}</div>`;
}
function stackedPaydays(rows) {   // base and overtime stacked, one ramp of one blue, with a legend and the values written
  const max = Math.max(...rows.map((r) => r.net), 1);
  return `<p class="legend"><span class="key"></span> Base pay <span class="key ot"></span> Overtime</p><div class="bars">${rows.map((r) => `<div class="brow"><span class="btop"><span class="bname">${esc(longDate(r.date))}</span><span class="bval">${peso(r.net)}</span></span>
    <span class="btrack stack"><span class="bfill" style="width:${Math.max(1, Math.round((r.base * 100) / max))}%"></span>${r.overtime ? `<span class="bfill ot" style="width:${Math.max(1, Math.round((r.overtime * 100) / max))}%"></span>` : ""}</span></div>`).join("")}</div>`;
}
function viewIncome() {
  const year = incomeYear(), ytdLabel = year === today().slice(0, 4) ? "Year to date" : "Whole year", y = M.incomeByMonth(S(), year), rows = y.months.filter((m) => m.total !== 0);
  const slips = (S().payslips ?? []).filter((p) => p.pay_date.startsWith(year + "-")).sort((a, b) => (a.pay_date < b.pay_date ? 1 : -1));   // only the year being looked at
  const step = `<div class="stepper"><button data-action="income-year" data-step="-1" aria-label="Earlier year">‹</button><span>${esc(year)}</span><button data-action="income-year" data-step="1" aria-label="Later year"${year >= today().slice(0, 4) ? " disabled" : ""}>›</button></div>`;
  const head = `<h1>Income</h1>${step}<p><button class="primary" data-action="open-payslip-choice">Add a payslip</button></p><p><button data-action="open-income" style="width:100%">Add other income</button></p>`;
  if (!rows.length && !slips.length) return head + `<p class="note">Nothing recorded for ${esc(year)} yet. Add a payslip to see where your income comes from, your raises, and what went to government.</p>`;
  const bySrc = M.SOURCES.map(([id, label]) => ({ label, amount: y.ytd[id] })).filter((r) => r.amount !== 0);
  const monthTable = `<table class="tbl"><tr><th>Month</th><th class="n">Base</th><th class="n">Overtime</th><th class="n">Other</th><th class="n">Total</th></tr>${rows.map((m) => `<tr><td>${esc(MONTH3[Number(m.month.slice(5)) - 1])}</td><td class="n">${peso(m.base)}</td><td class="n">${peso(m.overtime)}</td><td class="n">${peso(m.interest + m.refunds + m.other)}</td><td class="n">${peso(m.total)}</td></tr>`).join("")}
    <tr class="total"><td>${ytdLabel}</td><td class="n">${peso(y.ytd.base)}</td><td class="n">${peso(y.ytd.overtime)}</td><td class="n">${peso(y.ytd.interest + y.ytd.refunds + y.ytd.other)}</td><td class="n">${peso(y.ytd.total)}</td></tr></table>`;
  const pd = M.netPerPayday(S(), year);
  const paydays = pd.length ? `<h2>Net pay per payday</h2>${stackedPaydays(pd)}<table class="tbl"><tr><th>Payday</th><th class="n">Base</th><th class="n">Overtime</th><th class="n">Net</th></tr>${pd.map((r) => `<tr><td>${esc(longDate(r.date))}<small> ${esc(r.employer)}</small></td><td class="n">${peso(r.base)}</td><td class="n">${peso(r.overtime)}</td><td class="n">${peso(r.net)}</td></tr>`).join("")}</table>` : "";
  const raises = M.raiseHistory(S(), year);
  const raiseTable = raises.length ? `<h2>Basic pay over time</h2><table class="tbl"><tr><th>Payday</th><th class="n">Basic</th><th class="n">Change</th></tr>${raises.map((r) => `<tr><td>${esc(fullDate(r.date))}</td><td class="n">${peso(r.basic)}</td><td class="n">${r.change === null ? "" : r.change === 0 ? "No change" : (r.raised ? "▲ raised " : "▼ down ") + peso(Math.abs(r.change))}</td></tr>`).join("")}</table>` : "";
  const dd = M.deductionsByMonth(S(), year);
  const dedTable = dd.months.length ? `<h2>Deductions</h2><table class="tbl"><tr><th>Month</th><th class="n">Tax</th><th class="n">SSS</th><th class="n">PhilHealth</th><th class="n">Pag-IBIG</th></tr>${dd.months.map((m) => `<tr><td>${esc(MONTH3[Number(m.month.slice(5)) - 1])}</td><td class="n">${peso(m.tax)}</td><td class="n">${peso(m.sss)}</td><td class="n">${peso(m.philhealth)}</td><td class="n">${peso(m.pagibig)}</td></tr>`).join("")}
    <tr class="total"><td>${ytdLabel}</td><td class="n">${peso(dd.ytd.tax)}</td><td class="n">${peso(dd.ytd.sss)}</td><td class="n">${peso(dd.ytd.philhealth)}</td><td class="n">${peso(dd.ytd.pagibig)}</td></tr></table>
    <p class="note">Went to government this year: ${peso(dd.ytd.government)}. Lost to absences and lates: ${peso(dd.ytd.lost)}.${dd.ytd.loan ? " Loans: " + peso(dd.ytd.loan) + "." : ""}</p>` : "";
  const emps = M.employerHistory(S(), year);
  const empTable = emps.length ? `<h2>Employers</h2><table class="tbl"><tr><th>Employer</th><th class="n">From</th><th class="n">Latest</th></tr>${emps.map((e) => `<tr><td>${esc(e.employer)}<small> ${e.payslips} ${e.payslips === 1 ? "payslip" : "payslips"}</small></td><td class="n">${esc(fullDate(e.first))}</td><td class="n">${esc(fullDate(e.last))}</td></tr>`).join("")}</table>` : "";
  const plan = year === today().slice(0, 4) ? planOf() : null;   // the plan in force speaks only of this year
  const ivar = (v) => v === 0 ? "As planned" : (v > 0 ? "+" : "−") + peso(Math.abs(v)) + (v > 0 ? " more" : " less");
  const pv = plan ? [M.planIncome(S(), plan, today())].map((v) => `<h2>Plan against what arrived</h2><table class="tbl"><tr><th>Payday</th><th class="n">Plan</th><th class="n">Received</th><th class="n">Difference</th></tr><tr><td>${esc(v.label)}<small> ${esc(longDate(v.period.start))}</small></td><td class="n">${peso(v.planned)}</td><td class="n">${peso(v.actual)}</td><td class="n">${esc(ivar(v.variance))}</td></tr></table><p class="note">The plan is never edited; the difference is only shown.</p>`)[0] : "";
  const list = slips.length ? `<h2>Payslips</h2>${slips.slice(0, 12).map((p) => {
    const lines = M.linesOf(S(), p.id), flags = M.payslipChecks(p, lines), t = M.payslipTotals(lines);
    const shot = M.attachmentsFor(S(), p.transaction_id)[0];
    const draft = S().transactions.some((x) => x.id === "ot-" + p.id), freeDone = S().transactions.some((x) => x.id === "otf-" + p.id);
    return `<div class="row"><div>${esc(p.employer)}<small>${esc(fullDate(p.pay_date))} · gross ${peso(t.gross)} · deductions ${peso(t.deductions)}</small></div><div class="amt">${peso(p.deposit)}</div></div>${shot ? `<p class="note"><button class="link" data-action="open-photo" data-id="${esc(shot.id)}">View the photo</button></p>` : ""}${flags.map(flagLine).join("")}${t.overtime > 0 && !draft ? `<p class="note"><button class="link" data-action="ot-draft" data-id="${esc(p.id)}">Make the Emergency Fund draft for the overtime</button></p>` : ""}${t.overtime > 0 && !freeDone ? `<p class="note">The free ${peso(t.overtime - Math.round((t.overtime * M.OVERTIME_SHARE.num) / M.OVERTIME_SHARE.den))} of the overtime stays in the account the pay landed in. <button class="link" data-action="open-otfree" data-id="${esc(p.id)}">Move it somewhere else</button></p>` : ""}`;
  }).join("")}` : "";
  return `${head}<h2>Where it came from, ${esc(year)}</h2>${bySrc.length ? hbars(bySrc) : ""}${monthTable}${paydays}${raiseTable}${dedTable}${empTable}${pv}${list}`;
}

const payslipDefaults = () => ({
  employer: ledger.settings.last_employer ?? "", period_from: today(), period_to: today(), pay_date: today(), account_id: ledger.settings.last_account_id ?? accountsFor(null)[0]?.id ?? null,
  ot_month: M.addMonths(M.monthOf(today()), -1), gross: "", net: "", deposit: "", words: "",
});
// A payslip photo, read line by line: opens the payslip window already filled in. The owner checks every figure (the same four checks as
// for a typed payslip point out what does not add up), chooses where it landed, and saves. The photo stays with the pay.
const knownEmployers = () => [...new Set([...(S().payslips ?? []).map((p) => p.employer), ledger.settings.last_employer].filter(Boolean))];
function openPayslipFromPhoto(blob, text, queueId) {
  const r = M.readPayslip(text, today()), d = payslipDefaults(), two = (c) => (c / 100).toFixed(2);
  const employer = r.employer ? M.snapEmployer(r.employer, knownEmployers()) : d.employer;
  // One short line: everything was read from the photo and none of it is confirmed (a right employer does not make the figures right).
  // Only what needs action is added after it.
  const f = { ...d, account_id: null, employer, text, notes: ["Read from the photo, the employer too. Check each figure against the paper.", ...r.notes.filter((n) => /could not/i.test(n)), ...(r.earnings.length || r.deductions.length ? [] : ["I could not read any lines. Type them from the photo."])] };
  if (r.period_from) { f.period_from = r.period_from; f.period_to = r.period_to; }
  if (r.pay_date) f.pay_date = r.pay_date;
  f.ot_month = M.addMonths(M.monthOf(f.pay_date), -1);
  for (const l of r.earnings) f["e_" + l.kind] = two(l.amount);
  for (const l of r.deductions) f["d_" + l.kind] = two(l.amount);
  if (r.printed_gross) f.gross = two(r.printed_gross);
  if (r.printed_net) { f.net = two(r.printed_net); f.deposit = f.net; }
  if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.url);
  pendingPhoto = { blob, url: URL.createObjectURL(blob) };
  ui.pdet = {}; ui.form = f; ui.sheet = { type: "payslip", scanBlob: blob, queueId }; renderSheet();
}

// What the sheet holds, as the model wants it. `errors` names every typed amount that is not an amount.
function payslipFromForm(f) {
  const errors = [], pick = (prefix, kinds) => kinds.flatMap(([kind]) => {
    const raw = (f[prefix + kind] ?? "").trim(); if (!raw) return [];
    const a = M.parsePesos(raw); if (!a.ok || a.centavos <= 0) { errors.push(kind); return []; }
    return [{ kind, amount: a.centavos, ...(kind === "overtime" ? { earned_month: f.ot_month } : {}) }];
  });
  const money = (raw) => { const a = M.parsePesos(raw ?? ""); return a.ok && a.centavos > 0 ? a.centavos : null; };
  return { errors, earnings: pick("e_", M.EARNINGS), deductions: pick("d_", M.DEDUCTIONS), printed_gross: money(f.gross), printed_net: money(f.net), deposit: money(f.deposit) };
}
function savePayslipReady(f) {
  const p = payslipFromForm(f);
  return { p, ready: (f.employer ?? "").trim() && f.pay_date && f.period_from && f.period_to && f.account_id && !p.errors.length && p.earnings.length && p.printed_gross && p.printed_net && p.deposit };
}
async function savePayslip() {
  const f = ui.form, { p } = savePayslipReady(f), id = newId("ps"), sh = ui.sheet;
  const r = M.planPayslip(S(), { id, transaction_id: newId("tx"), employer: f.employer, period_from: f.period_from, period_to: f.period_to, pay_date: f.pay_date, account_id: f.account_id,
    printed_gross: p.printed_gross, printed_net: p.printed_net, deposit: p.deposit, net_words: (f.words ?? "").trim() || undefined, earnings: p.earnings, deductions: p.deductions }, new Date());
  if (!r.ok) { showToast("Could not save: " + r.violations[0].message); return; }
  let next = r.state, note = "";
  const photoId = sh?.scanBlob ? (sh.queueId ?? newId("photo")) : null;   // a payslip read from a photo keeps the photo with the pay
  if (photoId) {
    if (!sh.queueId) { try { await putPhoto(photoId, sh.scanBlob); } catch { showToast("The photo could not be kept on this phone, so nothing was saved."); return; } }
    const att = M.planAttachment(next, { id: photoId, transaction_id: r.transaction.id }); if (att.ok) next = att.state;
  }
  const hasOvertime = r.lines.some((l) => l.kind === "overtime");
  if (hasOvertime) {
    const emerg = S().goals.find((x) => /emergency/i.test(x.name));
    if (!emerg) note = " Add a goal named Emergency Fund to get the overtime draft.";
    else { const d = M.overtimeDraft(next, id, { transaction_id: "ot-" + id, emergency_account_id: emerg.account_id }, new Date()); if (d?.ok && d.transaction) { next = M.applyDrafts(next, [d]); note = " The Emergency Fund draft is waiting in Verify."; } }
  }
  ui.sheet = null; renderSheet();
  if (pendingPhoto) { URL.revokeObjectURL(pendingPhoto.url); pendingPhoto = null; }
  await commit(next, { ...ledger.settings, last_employer: f.employer.trim(), last_account_id: f.account_id, ...(sh?.queueId ? { scan_queue: scanQueue().filter((q) => q.id !== sh.queueId) } : {}) });
  showToast("Payslip saved: " + peso(p.deposit) + (r.flags.length ? ". " + r.flags.length + (r.flags.length === 1 ? " thing does" : " things do") + " not match; see Income." : ".") + note);
}

// ---------- scan: a photo of a receipt, payslip or payment screenshot ----------
// The phone reads the photo itself (app/ocr.js), src/model/scan.js turns the words into a guess, and the owner corrects the
// guess in a window. The result is a DRAFT with the photo kept beside it, so Verify shows the paper next to the numbers.
let pendingPhoto = null;   // {blob, url}: the photo being checked, not yet saved
const photoUrls = new Map();   // saved photos shown on this screen: attachment id -> object address

// The two ways to give the app a photo, always both on offer: the camera, or an image you already have (photos or files).
// mode: "quick" (saved at once when sure), "1" (check every field first), "payslip" (read as a payslip).
const photoButtons = (mode, busy = false) => `<label class="filebtn" aria-disabled="${busy}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="12.5" r="3.5"/></svg>&nbsp;${busy ? "Reading..." : "Take a photo"}<input type="file" accept="image/*" capture="environment" data-scan="${mode}" hidden${busy ? " disabled" : ""}></label>
  <label class="filebtn alt" aria-disabled="${busy}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>&nbsp;Choose from photos or files<input type="file" accept="image/*" data-scan="${mode}" hidden${busy ? " disabled" : ""}></label>`;

function viewScan() {
  const s = ui.scan, busy = s?.busy === true;
  const status = busy ? `<p class="note" id="scan-msg" role="status">${esc(s.msg)}</p>` : s?.error ? `<p class="note" role="alert">${esc(s.error)}</p>` : s?.done ? `<p class="note" role="status">${esc(s.done)} <button class="link" data-action="tab" data-tab="verify">Go to Verify</button></p>` : "";
  return `<h1>Scan</h1><p class="sub">A receipt, payslip or payment screenshot</p>
    <p class="note">This phone reads the photo itself. The photo is never sent anywhere. It guesses what the paper is, the amount and the date. You check each guess, and the entry waits in Verify with the photo beside it.</p>
    ${photoButtons("1", busy)}
    ${status}
    <p class="note">The first photo downloads the reader (about 7 MB) while you are online. After that it works with no internet. For the best reading hold the phone straight above the paper, in good light, with the whole page in view. Handwriting is read poorly, so check every number on a handwritten receipt. Photos stay on this phone and are not in the backup file.</p>`;
}

const incomeCategories = () => S().categories.filter((c) => c.kind === "income");
function scanDefaults(kind, guess, payee) {
  if (M.kindById(kind).direction === "in") {
    const inc = incomeCategories();
    return { category_id: (kind === "payslip" ? inc.find((c) => c.id === "cat-salary") : null)?.id ?? inc[0]?.id ?? null };
  }
  const learned = M.categoryFromHistory(S(), payee);   // what you used last time for the same name wins over a guess from words
  return { category_id: expenseCategories().find((c) => c.id === learned)?.id ?? expenseCategories().find((c) => guess && c.name.toLowerCase() === guess.toLowerCase())?.id ?? null };
}

// The account the paper names: the bank on its From line, matched to the owner's own accounts. A credit card screen prefers a card
// account. When the paper does not say, nothing is chosen for you: a wrong silent default (the first account) was worse than a tap.
function accountForScan(r) {
  if (!r.bankId && r.cash) { const c = accountsFor(null).find((a) => /^cash\b/i.test(a.name)); if (c) return { id: c.id, note: "" }; }
  if (!r.bankId) return { id: null, note: "I could not tell which account paid. Choose one." };
  const bank = M.bankById(r.bankId).name, hits = accountsFor(null).filter((a) => a.bank === r.bankId || (!a.bank && M.bankForName(a.name)?.id === r.bankId));
  if (!hits.length) return { id: null, note: "The paper names " + bank + " but you have no account for it. Choose one." };
  const pick = hits.find((a) => a.class === (r.creditCard ? "liability" : "asset")) ?? hits[0];
  return { id: pick.id, note: hits.length > 1 ? "The paper names " + bank + "; I chose " + pick.name + ". Check it." : "" };
}

// Reads a photo. A payslip is read again from where its words sit on the page (so two columns stay apart and a tilted photo is straightened),
// once as it is and once with shadows taken out, and the better reading is kept. Returns the text the rest of the app works from.
async function readPhoto(blob, progress, forcePayslip = false) {
  const first = await readPage(blob, progress);
  if (first.boxes) return M.linesFromBoxes(first.boxes) || first.text;   // the stronger reader sees the page's layout: no second pass needed
  if (!forcePayslip && M.readScan(first.text, today()).kind !== "payslip") return first.text;
  const score = (text) => { const r = M.readPayslip(text, today()); return r.earnings.length + r.deductions.length + (r.printed_gross ? 1 : 0) + (r.printed_net ? 1 : 0); };
  let best = M.linesFromWords(first.words) || first.text;
  try {
    const second = await readPage(await evenedCopy(blob), (f, w) => progress(f, w + " (clearing shadows)")), alt = M.linesFromWords(second.words);
    if (alt && score(alt) > score(best)) best = alt;
  } catch { /* the first reading stands */ }
  return score(best) >= score(first.text) ? best : first.text;
}

async function startScan(file, asPayslip = false) {
  if (!file) return;
  const say = (msg) => { if (ui.scan) ui.scan.msg = msg; const el = $("scan-msg"); if (el) el.textContent = msg; };
  ui.scan = { busy: true, msg: "Preparing the photo..." }; renderScreen();
  let blob, text = "", failed = null;
  try { blob = await preparePhoto(file); }
  catch (e) { ui.scan = { error: "That file could not be opened as a picture (" + e.message + ")." }; renderScreen(); return; }
  try { text = await readPhoto(blob, (f, what) => say(what + (f ? " " + Math.round(f * 100) + "%" : "...")), asPayslip); }
  catch (e) { failed = e.message; }
  ui.scan = null; renderScreen();
  if (asPayslip) { openPayslipFromPhoto(blob, text, null); return; }   // chosen as a payslip: the payslip window, whatever the reader thought it was
  openScanSheet(blob, text, failed, null);
}

// The window for checking a guess: for a photo just taken, or for one kept in the queue because the app could not be sure.
function openScanSheet(blob, text, failed, queueId, spoken = null) {
  if (!spoken && !failed && blob && M.readScan(text, today()).kind === "payslip") { openPayslipFromPhoto(blob, text, queueId); return; }
  const r = spoken ?? M.readScan(text, today()), acct = accountForScan(r);
  if (pendingPhoto) { URL.revokeObjectURL(pendingPhoto.url); pendingPhoto = null; }
  if (blob) pendingPhoto = { blob, url: URL.createObjectURL(blob) };
  const notes = failed ? ["The reader could not run (" + failed + "). Fill in the fields yourself; the photo is kept."] : r.readAnything ? [...r.notes, ...(acct.note ? [acct.note] : [])] : ["I could not read any words on the photo. Fill in the fields yourself; the photo is kept."];
  ui.form = { kind: r.kind, guess: r.categoryGuess, amount: r.amount ? (r.amount / 100).toFixed(2) : "", date: r.date ?? today(), payee: r.payee ?? "", notes, text,
    account_id: acct.id, ...scanDefaults(r.kind, r.categoryGuess, r.payee) };
  ui.sheet = { type: "scan", queueId, voice: spoken !== null }; renderSheet();
}

// ---------- voice: the microphone button on the Log screen ----------
// Say or type one sentence ("lunch 95 at Sample Burger using GCash"). If the amount, the account and the category are all clear it is saved
// as a draft at once; otherwise the check window opens with what was understood. Nothing is saved on a guess.
let voiceListener = null;
const VOICE_ERRORS = { "not-allowed": "The phone did not allow the microphone here.", "service-not-allowed": "The phone did not allow the microphone here.", "no-speech": "I did not hear anything. Try again.", "audio-capture": "No microphone was found.", network: "The speech service could not be reached (it needs internet)." };
function voiceMessage(m) { const el = $("v-msg"); if (el) el.textContent = m; }
function voiceToggle() {
  if (voiceListener) { voiceListener.stop(); return; }
  const btn = $("v-mic"); if (btn) btn.textContent = "Listening... tap to stop";
  voiceMessage("");
  try {
    voiceListener = listen({
      lang: ui.form.lang ?? "en-PH", startText: ui.form.spoken ?? "",
      onText: (text) => { ui.form.spoken = text; const box = $("v-text"); if (box) box.value = text; refreshSave(); },
      onDone: () => { voiceListener = null; const b = $("v-mic"); if (b) b.textContent = "Tap and speak"; },
      onError: (code) => voiceMessage((VOICE_ERRORS[code] ?? "Speech could not start (" + code + ").") + " You can type, or use the keyboard's microphone key, in the box below."),
    });
  } catch (e) { voiceListener = null; voiceMessage("Speech could not start. You can type, or use the keyboard's microphone key, in the box below."); }
}
async function useSpoken() {
  voiceListener?.stop();
  const heard = (ui.form.spoken ?? "").trim();
  const r = M.parseSpoken(heard, { today: today(), categories: S().categories });
  const acct = accountForScan(r), cat = scanDefaults("receipt", r.categoryName, r.payee).category_id;
  if (r.direction === "out" && r.amount && acct.id && cat) {
    ui.sheet = null; renderSheet();
    await logExpense({ transaction_id: newId("tx"), date: r.date, payee: r.payee ?? "", memo: heard, category_id: cat, amount: r.amount, account_id: acct.id, source: "voice" }, (r.payee || categoryName(cat)) + " " + peso(r.amount));
    return;
  }
  openScanSheet(null, heard, null, null, { ...r, kind: r.direction === "in" ? "received" : "receipt", categoryGuess: r.categoryName, creditCard: false, readAnything: true, notes: r.notes });
}

// ---------- quick capture: the scanner button on the Log screen ----------
// One tap, one photo, and the entry is a draft waiting in Verify. The photo is kept the moment it is taken and put in a queue,
// so closing the app straight away loses nothing: the next time the app opens it reads what is waiting. If the app cannot be
// sure of the amount, the account and the category, it keeps the photo and asks (a note on Log), instead of saving a guess.
const scanQueue = () => ledger.settings.scan_queue ?? [];
const withQueue = (q) => ({ ...ledger.settings, scan_queue: q });
let queueRun = false;

async function quickCapture(file) {
  if (!file) return;
  ui.scan = { busy: true, msg: "Keeping the photo..." }; renderScreen();
  const id = newId("photo");
  try { await putPhoto(id, await preparePhoto(file)); }
  catch (e) { ui.scan = { error: "The photo could not be kept (" + e.message + ")." }; renderScreen(); return; }
  ui.scan = null;
  await commit(S(), withQueue([...scanQueue(), { id, at: M.phTimestamp() }]), { quiet: true });
  await processScanQueue({ interactive: true });
}

async function processScanQueue({ interactive = false } = {}) {
  if (queueRun || !device.allowEntry) return;
  queueRun = true;
  const say = (m) => { if (!interactive) return; const first = !ui.scan; ui.scan = { busy: true, msg: m }; const el = $("scan-msg"); if (el && !first) el.textContent = m; else renderScreen(); };
  try {
    for (const item of scanQueue().filter((q) => !q.needs)) {
      if (!scanQueue().some((q) => q.id === item.id)) continue;
      let blob = null, text = "";
      try {
        blob = await getPhoto(item.id);
        if (blob) { say("Reading the photo..."); text = await readPhoto(blob, (f, w) => say(w + (f ? " " + Math.round(f * 100) + "%" : "..."))); }
      } catch (e) {
        ui.scan = null; renderScreen();
        if (interactive) showToast("The photo is kept and will be read when the reader can load (it needs internet the first time).");
        break;
      }
      if (!blob) { await commit(S(), withQueue(scanQueue().filter((q) => q.id !== item.id)), { quiet: true }); continue; }   // the picture is gone (a restored backup has none)
      const r = M.readScan(text, today()), acct = accountForScan(r), cat = scanDefaults(r.kind, r.categoryGuess, r.payee).category_id;
      if (M.kindById(r.kind).direction === "out" && r.amount && acct.id && cat) {
        const ok = await logExpense({ transaction_id: newId("tx"), date: r.date ?? today(), payee: r.payee ?? "", category_id: cat, amount: r.amount, account_id: acct.id, source: "photo", photo_id: item.id, drop_scan: item.id },
          (r.payee || categoryName(cat)) + " " + peso(r.amount));
        if (!ok) break;
      } else {
        await commit(S(), withQueue(scanQueue().map((q) => (q.id === item.id ? { ...q, needs: true, text } : q))), { quiet: true });
        if (interactive) { ui.scan = null; await openQueuedScan(item.id); }
      }
    }
  } finally { queueRun = false; ui.scan = null; renderScreen(); }
}

async function openQueuedScan(id) {
  const item = scanQueue().find((q) => q.id === id), blob = item ? await getPhoto(id).catch(() => null) : null;
  if (!blob) { showToast("That photo is no longer on this phone."); await commit(S(), withQueue(scanQueue().filter((q) => q.id !== id)), { quiet: true }); return; }
  openScanSheet(blob, item.text ?? "", null, id);
}

async function saveScan() {
  const f = ui.form, amount = M.parsePesos(f.amount).centavos, kind = M.kindById(f.kind), id = newId("tx"), queueId = ui.sheet.queueId ?? null, photoId = queueId ?? newId("photo");
  const voice = ui.sheet.voice === true, source = voice ? "voice" : "photo";   // a spoken entry has no photo
  if (!queueId && !voice) { try { await putPhoto(photoId, pendingPhoto.blob); } catch { showToast("The photo could not be kept on this phone, so nothing was saved."); return; } }
  let ok = false;
  if (kind.direction === "in") {
    const p = M.planPayReceived(S(), { transaction_id: id, date: f.date, amount, account_id: f.account_id, category_id: f.category_id, source, payee: f.payee.trim() || kind.label, memo: voice ? f.text : "" }, new Date());
    if (p.ok) {
      const a = voice ? { ok: true, state: M.applyDrafts(S(), [p]) } : M.planAttachment(M.applyDrafts(S(), [p]), { id: photoId, transaction_id: id });
      ok = a.ok && await commit(a.state, { ...ledger.settings, last_account_id: f.account_id, ...(queueId ? { scan_queue: scanQueue().filter((q) => q.id !== queueId) } : {}) });
    } else showToast("Could not save: " + p.violations[0].message);
  } else {
    const second = f.split ? M.parsePesos(f.split_amt).centavos : 0, lines = f.split ? [{ category_id: f.category_id, amount: amount - second }, { category_id: f.split_cat, amount: second }] : undefined;
    ok = await logExpense({ transaction_id: id, date: f.date, payee: f.payee.trim(), category_id: f.category_id, amount, account_id: f.account_id, source, ...(voice ? { memo: f.text } : { photo_id: photoId, drop_scan: queueId }), ...(lines ? { lines } : {}) }, (f.payee.trim() || categoryName(f.category_id)) + " " + peso(amount));
  }
  if (!ok) { if (!queueId && !voice) deletePhoto(photoId).catch(() => {}); return; }   // the window stays open so nothing typed is lost
  if (pendingPhoto) { URL.revokeObjectURL(pendingPhoto.url); pendingPhoto = null; }
  ui.sheet = null; ui.scan = { done: "Saved " + peso(amount) + (voice ? " as a draft." : " as a draft with its photo.") };
  renderAll();
}

// Saved photos are loaded from the phone's own store after a screen is drawn, and shown where a picture is waiting.
function hydratePhotos() {
  for (const img of document.querySelectorAll("img[data-photo]")) {
    const id = img.dataset.photo;
    (async () => {
      let url = photoUrls.get(id);
      if (!url) {
        const blob = await getPhoto(id);
        if (!blob) { const p = document.createElement("p"); p.className = "note"; p.textContent = "The photo is not on this phone. Photos are not part of the backup file."; (img.closest("button") ?? img).replaceWith(p); return; }
        url = URL.createObjectURL(blob); photoUrls.set(id, url);
      }
      img.src = url; img.hidden = false;
    })().catch(() => {});
  }
}

// ---------- bank logos: loaded for every listed bank, once, when the phone has internet ----------
// The logos of ALL the listed banks are fetched together, so the icon service learns nothing about which banks you use.
// They are kept in the phone's settings (never in the repository) and shown wherever an account belongs to that bank.
// COPY: services that let the page read the picture (it is shrunk and kept). LINK: places that only allow showing it;
// then only the address is kept. A bank's own site icon is tried before icon services, which may invent placeholders.
const COPY_SOURCES = (domain) => [["Icon Horse", `https://icon.horse/icon/${domain}`], ["Favicon Kit", `https://api.faviconkit.com/${domain}/144`]];
const LINK_SOURCES = (domain) => [
  ["its website", `https://${domain}/apple-touch-icon.png`],
  ["its website", `https://www.${domain.replace(/^www\./, "")}/apple-touch-icon.png`],
  // nfrp=2 makes the service answer "not found" for a site with no icon, instead of a generic grey placeholder picture
  ["Google icons", `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&nfrp=2&url=https://${domain}&size=128`],
  ["DuckDuckGo", `https://icons.duckduckgo.com/ip3/${domain}.ico`],
];
// Some services invent a flat grey tile (a letter, or a grey circle) when a site has no icon. That is not a logo.
function looksLikeLetterTile(ctx) {
  const d = ctx.getImageData(0, 0, ICON_PX, ICON_PX).data, buckets = new Map();
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) continue;   // white paper around a logo is not the logo
    ink += 1;
    const k = (d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4);
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  if (ink < ICON_PX * ICON_PX * 0.05) return false;
  let best = 0, bestKey = 0;
  for (const [k, n] of buckets) if (n > best) { best = n; bestKey = k; }
  const r = (bestKey >> 8) * 16, g = ((bestKey >> 4) & 15) * 16, b = (bestKey & 15) * 16, mean = (r + g + b) / 3;
  return best / ink > 0.8 && Math.abs(r - g) <= 16 && Math.abs(g - b) <= 16 && mean >= 90 && mean <= 235;
}
function pictureIsLetterTile(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(false);
    img.onload = () => { const c = document.createElement("canvas"); c.width = c.height = ICON_PX; const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0, ICON_PX, ICON_PX); try { resolve(looksLikeLetterTile(ctx)); } catch { resolve(false); } };
    img.src = url;
  });
}
// Resolves to {url} (a copied picture) or {ok:true} (loads fine, for LINK) or {why}, saying exactly what went wrong.
function loadLogo(url, { copy = true, ms = 8000 } = {}) {
  return new Promise((resolve) => {
    const img = new Image(), timer = setTimeout(() => resolve({ why: "no answer in " + ms / 1000 + " seconds" }), ms);
    if (copy) img.crossOrigin = "anonymous";
    img.onerror = () => { clearTimeout(timer); resolve({ why: "could not be loaded" }); };
    img.onload = () => {
      clearTimeout(timer);
      if (img.naturalWidth < 32) { resolve({ why: "only a tiny placeholder came back (" + img.naturalWidth + " pixels)" }); return; }
      if (!copy) { resolve({ ok: true }); return; }
      try {
        const c = document.createElement("canvas"); c.width = c.height = ICON_PX;
        const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, ICON_PX, ICON_PX);
        const k = Math.min((ICON_PX - 8) / img.naturalWidth, (ICON_PX - 8) / img.naturalHeight), w = img.naturalWidth * k, h = img.naturalHeight * k;
        ctx.drawImage(img, (ICON_PX - w) / 2, (ICON_PX - h) / 2, w, h);
        if (looksLikeLetterTile(ctx)) { resolve({ why: "only a generated placeholder came back" }); return; }
        let out = c.toDataURL("image/png"); if (out.length > 38000) out = c.toDataURL("image/jpeg", 0.8);
        resolve({ url: out });
      } catch { resolve({ why: "the service does not allow the picture to be copied" }); }
    };
    img.src = url;
  });
}
// A bank's logo from its Wikipedia article (for a bank the icon services have nothing for). Wikipedia allows the page to read its pictures.
async function wikiLogo(term) {
  try {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch("https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrlimit=1&prop=pageimages&piprop=thumbnail&pithumbsize=256&format=json&formatversion=2&origin=*&gsrsearch=" + encodeURIComponent(term), { signal: ctl.signal });
    clearTimeout(timer);
    const src = (await res.json())?.query?.pages?.[0]?.thumbnail?.source;
    if (!src || !src.startsWith("https://upload.wikimedia.org/")) return { why: "no picture found" };
    return await loadLogo(src);
  } catch { return { why: "could not be reached" }; }
}
async function fetchBankLogo(b) {
  const why = [];
  for (const domain of b.noLookup ? [] : [b.domain, ...(b.alt ?? [])]) {
    for (const [label, src] of COPY_SOURCES(domain)) { const r = await loadLogo(src); if (r.url) return { icon: r.url }; why.push(domain + " " + label + ": " + r.why); }
    for (const [label, src] of LINK_SOURCES(domain)) { const r = await loadLogo(src, { copy: false }); if (r.ok) return { icon_url: src }; why.push(domain + " " + label + ": " + r.why); }
  }
  if (b.wiki) { const r = await wikiLogo(b.wiki); if (r.url) return { icon: r.url }; why.push("Wikipedia: " + r.why); }
  return { why: why.join("; ") };
}
let logoRun = null;
// Runs once at start (and from "Try again"): fetches the logos still missing. A bank that failed is retried after a week.
async function loadBankLogos({ force = false } = {}) {
  if (logoRun || !device.allowEntry || navigator.onLine === false) return;
  const have = ledger.settings.bankLogos ?? {}, tried = ledger.settings.bankLogosTried ?? {}, t = today();
  const due = (d) => !d || (Date.parse(t) - Date.parse(d)) / 86400000 >= 7;
  const blocked = ledger.settings.bankLogosBlocked ?? {};
  const todo = M.BANKS.filter((b) => !blocked[b.id] && !bankLogo(b.id) && (force || due(tried[b.id])));
  if (!todo.length) return;
  ui.logoBusy = true; if (ui.sheet?.type === "banks") renderSheet();   // only the bank list shows progress
  logoRun = (async () => {
    const got = {}, report = [];
    for (const b of todo) { const r = await fetchBankLogo(b); if (r.icon || r.icon_url) got[b.id] = r.icon ? { icon: r.icon } : { icon_url: r.icon_url }; else report.push(b.name + " (" + r.why + ")"); }
    ui.logoReport = report.length ? "No logo found online for: " + report.join(" | ") : null;
    ui.logoBusy = false;
    await commit(S(), { ...ledger.settings, bankLogos: { ...(ledger.settings.bankLogos ?? {}), ...got }, bankLogosTried: { ...(ledger.settings.bankLogosTried ?? {}), ...Object.fromEntries(todo.map((b) => [b.id, t])) } }, { quiet: true });
  })();
  try { await logoRun; } finally { logoRun = null; ui.logoBusy = false; }
}
// Pictures saved on accounts by earlier versions that are only placeholders (an address or a flat grey copy) are dropped.
async function dropOldPlaceholders() {
  // A logo saved for a bank that cannot be looked up (an earlier version kept a grey placeholder for it) is thrown away.
  const logos = ledger.settings.bankLogos ?? {}, bad = M.BANKS.filter((b) => b.noLookup && logos[b.id]?.icon_url);   // only an address; a copied picture (from Wikipedia) stays
  if (bad.length) { const rest = { ...logos }; for (const b of bad) delete rest[b.id]; await commit(S(), { ...ledger.settings, bankLogos: rest }, { quiet: true }); }
  let state = M.dropPlaceholderAddresses(S());
  for (const a of state.accounts) {
    if (a.icon && (await pictureIsLetterTile(a.icon))) { const r = M.setAccountIcon(state, a.id, null); if (r.ok) state = r.state; }
  }
  if (state !== S()) await commit(state);
}

const bankPictureOf = (bankId) => M.bankPicture(S().accounts, bankId);
const accountPreview = (f) => { const b = M.bankById(f.bank), sub = (f.sub ?? "").trim(); return sub ? b.name + " \u00b7 " + sub : b.name; };

function viewSetup() {
  const f = ui.accountForm;
  const cards = S().accounts.filter((a) => a.class === "liability" && !a.archived);
  const used = new Set(S().entries.map((e) => e.account_id));
  const reserveExists = S().accounts.some((a) => a.reserve_for);
  const hosts = activeAccounts().filter((a) => a.class === "asset" && !a.reserve_for);
  const rows = S().accounts.map((a) => `<div class="row"><div class="who"><button class="icobtn" data-action="open-icon" data-id="${esc(a.id)}" aria-label="Choose a picture for ${esc(a.name)}">${iconOf(a, 44)}</button><div>${esc(a.name)}<small>${a.class === "asset" ? "Bank, wallet or cash" : "Credit card"}${a.reserve_for ? " · covers " + esc(accountName(a.reserve_for)) : ""}${a.bank && !a.name.toLowerCase().startsWith(M.bankById(a.bank).name.toLowerCase()) ? " · linked to " + esc(M.bankById(a.bank).name) : ""}${a.icon || a.icon_url ? "" : " · tap the tile to add a picture"}</small></div></div>
      <div class="amt">${peso(M.naturalBalance(a, S().entries))}${used.has(a.id) ? "" : `<br><button class="link" data-action="remove-account" data-id="${esc(a.id)}">${ui.confirmRemove === a.id ? "Tap again to remove" : "Remove"}</button>`}</div></div>`).join("");
  // The form comes FIRST so it stays in the same place however many accounts there are: the
  // button never drifts down behind the keyboard. The list of accounts follows it.
  return `<h1>Setup</h1><p class="sub">Accounts. The ledger is on this phone only.</p>
    <h2>Add an account</h2>
    <label for="a-bank">Bank</label>
    <button id="a-bank" class="bankpick" data-action="open-banks" data-for="add">${f.bank ? `${iconOf({ name: M.bankById(f.bank).name, bank: f.bank, ...(bankPictureOf(f.bank) ?? {}) }, 28)}<span>${esc(M.bankById(f.bank).name)}</span>` : `<span class="muted">Choose a bank</span>`}<span class="chev" aria-hidden="true">\u203A</span></button>
    ${f.bank ? `<label for="a-sub">Which part of ${esc(M.bankById(f.bank).name)}? (optional)</label><input id="a-sub" data-field="sub" value="${esc(f.sub)}" placeholder="e.g. Emergency Fund, Savings" autocomplete="off" enterkeyhint="next">
      <p class="note" id="a-preview">Saved as: ${esc(accountPreview(f))}</p>`
      : `<label for="a-name">Or type a name</label><input id="a-name" data-field="name" value="${esc(f.name)}" autocomplete="off" enterkeyhint="next">`}
    <label for="a-kind">Kind of account</label><select id="a-kind" data-field="kind"><option value="asset"${f.kind === "asset" ? " selected" : ""}>Bank, wallet or cash (money I have)</option><option value="liability"${f.kind === "liability" ? " selected" : ""}>Credit card (money I owe)</option></select>
    <label for="a-open">${f.kind === "asset" ? "How much is in it today" : "How much you owe on it today"} (₱)</label><input id="a-open" data-field="opening" inputmode="decimal" value="${esc(f.opening)}" placeholder="0.00" autocomplete="off">
    ${f.kind === "asset" && cards.length ? `<label for="a-covers">This account is a reserve for a card (optional)</label><select id="a-covers" data-field="covers"><option value="">No</option>${cards.map((c) => `<option value="${esc(c.id)}"${f.covers === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>` : ""}
    ${ui.setupError ? `<p id="a-error" role="alert"><b>${esc(ui.setupError)}</b></p>` : ""}
    <p><button class="primary" data-action="add-account" style="margin-top:14px">Add account</button></p>
    <h2>Your accounts</h2>
    ${rows || `<p class="note">No accounts yet.</p>`}
    <h2>Pay plan</h2>
    <p class="note">${planOf() ? "A plan is in effect." : "No plan in effect."} <button class="link" data-action="${planOf() ? "tab" : "open-plan"}" data-tab="plan">${planOf() ? "Open it" : "Load a plan"}</button></p>
    <h2>Backup</h2>
    <p class="note">${backupAgeText()}</p>
    <p><button class="primary" data-action="open-backup">Back up now</button></p>
    <p><button data-action="open-restore" style="width:100%">Restore from a backup</button></p>
    ${reserveExists ? `<h2>Card reserve</h2><label for="r-src">Reserve transfers come out of</label><select id="r-src" data-action-change="set-reserve-source"><option value="">Choose an account</option>${hosts.map((a) => `<option value="${esc(a.id)}"${ledger.settings.reserve_source_id === a.id ? " selected" : ""}>${esc(a.name)}</option>`).join("")}</select>` : ""}`;
}

// ---------- Money: where it goes ----------
// Verified spending only, one hue for every bar (the length already says "more"), the amount at the
// tip of each bar, and a list view that says exactly the same thing in words and numbers.
const SHOWN_BARS = 7;   // bigger lists fold the small ones into one row

// Budget grading, from green to red. Always shown with a shape and words as well as colour.
const LEVELS = { good: "On track", warning: "Getting there", serious: "Nearly used up", critical: "Over budget", none: "No budget" };
const SHAPES = { good: '<circle cx="6" cy="6" r="5"/>', warning: '<path d="M6 1 L11.5 11 H0.5 Z"/>', serious: '<path d="M6 0.5 L11.5 6 L6 11.5 L0.5 6 Z"/>', critical: '<rect x="1" y="1" width="10" height="10"/>', none: '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>' };
const glyph = (level) => `<svg class="glyph g-${level}" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">${SHAPES[level]}</svg>`;
const legend = () => `<p class="legend" aria-label="What the colours mean">${["good", "warning", "serious", "critical", "none"].map((l) => `<span>${glyph(l)}${LEVELS[l]}</span>`).join("")}</p>`;

// Donut colours: one blue hue, darkest for the biggest share; the legend carries the peso amount and percent of every slice.
const DONUT_BLUES = ["#1b4f8f", "#2a78d6", "#4f93e0", "#74abe8", "#97c1ee", "#b6d3f4", "#cfe1f7"];
function barChart(rows, selected) {
  const max = Math.max(...rows.map((r) => r.amount), 1);
  return `<div class="bars">${rows.map((r) => `<button class="brow${r.grade ? " g-" + r.grade : ""}${selected && selected !== r.id ? " dim" : ""}" data-action="pick-bar" data-id="${esc(r.id)}" aria-pressed="${selected === r.id}"${r.fold ? " disabled" : ""}>
      <span class="btop"><span class="bname">${r.label}</span><span class="bval">${peso(r.amount)}${r.percent ? " · " + r.percent + "%" : ""}</span></span>
      <span class="btrack"><span class="bfill" style="width:${Math.max(1, Math.round((r.amount * 100) / max))}%"></span></span></button>`).join("")}</div>`;
}

function foldRows(rows, total) {
  if (rows.length <= SHOWN_BARS + 1) return rows;
  const rest = rows.slice(SHOWN_BARS), sum = rest.reduce((n, r) => n + r.amount, 0);
  return [...rows.slice(0, SHOWN_BARS), { id: "__rest", label: esc("Everything else (" + rest.length + " more)"), amount: sum, percent: total > 0 ? Math.round((sum * 1000) / total) / 10 : 0, fold: true }];
}

function listTable(heads, rows, totalLabel, total) {
  return `<table class="tbl"><tr>${heads.map((h, i) => `<th${i ? ' class="n"' : ""}>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`).join("")}
    <tr class="total"><td>${totalLabel}</td><td class="n">${peso(total)}</td>${heads.length > 2 ? "<td></td>" : ""}</tr></table>`;
}

// ---------- Money: the period at the top ----------
// The title at the top ("October 2026") is a button: it opens a small picker for a month, a whole year or any date range.
// Every view below follows that period. The arrows step one month or one year.
const period = () => ui.period ?? { kind: "month", month: M.monthOf(today()) };
const fullDate = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function periodBounds(p) {
  if (p.kind === "year") return [p.year + "-01-01", p.year + "-12-31"];
  if (p.kind === "range") return [p.from, p.to];
  const [y, m] = p.month.split("-").map(Number);
  return [p.month + "-01", p.month + "-" + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")];   // the real last day
}
const periodLabel = (p) => (p.kind === "year" ? String(p.year) : p.kind === "range" ? fullDate(p.from) + " \u2013 " + fullDate(p.to) : M.monthLabel(p.month));
const periodWords = (p) => (p.kind === "range" ? "from " + fullDate(p.from) + " to " + fullDate(p.to) : "in " + periodLabel(p));
const MONTH3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pendingNote = (n) => (n > 0 ? `<p class="note"><button class="link" data-action="tab" data-tab="verify">plus ${peso(n)} not verified yet</button></p>` : "");
const moneyViews = () => `<div class="seg" role="group" aria-label="What to show">${[["category", "By category"], ["budget", "Budgets"], ["account", "By account"], ["month", "By month"]].map(([v, t]) => `<button data-action="chart-view" data-view="${v}" aria-pressed="${ui.view === v}">${t}</button>`).join("")}</div>`;

// A chart you tap to flip: bars become a donut and the donut becomes bars. Nothing else happens on a tap.
function flipChart(rows, total, { graded = false } = {}) {
  const shown = foldRows(rows.filter((r) => r.amount > 0), total);
  if (!shown.length) return `<p class="note">Nothing verified in this period.</p>`;
  if (ui.shape === "donut") {
    const R = 70, C = 2 * Math.PI * R, GAP = 2, sum = shown.reduce((n, r) => n + r.amount, 0) || 1;
    let offset = 0;
    const colored = shown.map((r, i) => ({ ...r, color: r.fold ? "#999" : DONUT_BLUES[Math.min(i, DONUT_BLUES.length - 1)] }));
    const arcs = colored.map((r) => { const len = (r.amount / sum) * C, dash = Math.max(0.5, len - GAP); const c = `<circle class="slice" cx="100" cy="100" r="${R}" fill="none" stroke="${r.color}" stroke-width="30" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 100 100)"/>`; offset += len; return c; }).join("");
    const legend = colored.map((r) => `<div class="lrow"><span class="swatch" style="background:${r.color}"></span><span class="lname">${r.label}</span><span class="lval">${peso(r.amount)} \u00b7 ${r.percent}%</span></div>`).join("");
    return `<div class="flip" data-action="flip-chart" role="button" tabindex="0" aria-label="Donut of where the money went. Tap to show bars."><svg class="donut" viewBox="0 0 200 200" aria-hidden="true">${arcs}
      <text x="100" y="96" text-anchor="middle" class="dtotal">${esc(M.formatPesosWhole(total))}</text><text x="100" y="116" text-anchor="middle" class="dsub">spent</text></svg><div class="legendlist">${legend}</div></div>`;
  }
  const max = Math.max(...shown.map((r) => r.amount), 1);
  return `${graded ? legend() : ""}<div class="bars flip" data-action="flip-chart" role="button" tabindex="0" aria-label="Bars of where the money went. Tap to show a donut.">${shown.map((r) => `<div class="brow${r.grade ? " g-" + r.grade : ""}">
      <span class="btop"><span class="bname">${r.label}</span><span class="bval">${peso(r.amount)}${r.percent ? " \u00b7 " + r.percent + "%" : ""}</span></span>
      <span class="btrack"><span class="bfill" style="width:${Math.max(1, Math.round((r.amount * 100) / max))}%"></span></span></div>`).join("")}</div>`;
}

function viewMoney() {
  const p = period(), [from, to] = periodBounds(p), maps = S().categoryMaps, asOf = today(), nowM = M.monthOf(today()), nowY = Number(today().slice(0, 4));
  const cat = M.spendingByRange(S(), { from, to, categoryMaps: maps, asOf });
  const label = periodLabel(p);

  // The headline first; then what to look at; then the chart; then the same thing as a list.
  let sub = "spent " + periodWords(p), delta = "";
  if (p.kind === "range") {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    sub = "spent in " + days + (days === 1 ? " day" : " days") + (cat.total > 0 ? " \u00b7 about " + peso(Math.round(cat.total / days)) + " a day" : "");
  }
  if (p.kind === "month") {
    const prev = M.spendingByCategory(S(), { month: M.addMonths(p.month, -1), categoryMaps: maps, asOf });
    if (prev.total > 0 && cat.total > 0) {
      const d = cat.total - prev.total, pm = M.monthLabel(M.addMonths(p.month, -1)).split(" ")[0];
      delta = `<p class="sub">${d === 0 ? "The same as " + pm + "." : peso(Math.abs(d)) + (d > 0 ? " more" : " less") + " than " + pm + "."}</p>`;
    }
  }
  const atEnd = p.kind === "month" ? p.month >= nowM : p.kind === "year" ? p.year >= nowY : true;
  const title = `<button class="ptitle" data-action="open-period" aria-label="Choose the period: ${esc(label)}">${esc(label)}</button>`;
  const stepper = p.kind === "range" ? `<div class="stepper single">${title}</div>`
    : `<div class="stepper"><button data-action="period-step" data-step="-1" aria-label="Earlier">\u2039</button>${title}<button data-action="period-step" data-step="1" aria-label="Later"${atEnd ? " disabled" : ""}>\u203A</button></div>`;
  const hero = `<h1>Spending</h1>${stepper}<div class="hero">${peso(cat.total)}</div><p class="sub">${esc(sub)}</p>${delta}${pendingNote(cat.pending)}${moneyViews()}`;
  const modeLink = `<p><button class="link" data-action="chart-mode" data-mode="${ui.asList ? "chart" : "list"}">${ui.asList ? "Show as chart" : "Show as list"}</button></p>`;
  const done = (html) => hero + html + modeLink;
  const empty = () => hero + (p.kind === "month" ? emptyMoney() : `<p class="note">Nothing verified in this period.</p>`);

  if (ui.view === "month") {
    const endMonth = p.kind === "month" ? p.month : p.kind === "year" ? p.year + "-12" : M.monthOf(to);
    const span = (Number(endMonth.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(endMonth.slice(5)) - Number(from.slice(5, 7)) + 1;
    const n = p.kind === "month" ? 6 : p.kind === "year" ? 12 : Math.max(1, Math.min(24, span));
    const series = M.monthlySpending(S(), { endMonth, months: n, categoryMaps: maps, asOf });
    const trend = M.budgetTrend(S(), { endMonth, months: n, categoryMaps: maps, asOf });
    if (!series.some((x) => x.amount !== 0) && !trend.some((x) => x.budget !== null)) return empty();
    if (ui.asList) return done(listTable(["Month", "Spent"], [...series].reverse().map((x) => [esc(M.monthLabel(x.month)), peso(x.amount)]), "Total", series.reduce((nn, x) => nn + x.amount, 0)) + "<h2>Budget vs actual</h2>" + trendTable(trend));
    const max = Math.max(...series.map((x) => x.amount), 1), sel = ui.sel, many = n > 8;
    const cols = series.map((x) => `<button class="col${sel && sel !== x.month ? " dim" : ""}" data-action="pick-bar" data-id="${x.month}" aria-pressed="${sel === x.month}" aria-label="${esc(M.monthLabel(x.month) + ": " + peso(x.amount))}">
        <span class="cval">${(!many && x.month === endMonth) || x.month === sel ? M.formatPesosWhole(x.amount) : ""}</span><span class="cbar" style="height:${x.amount > 0 ? Math.max(4, Math.round((x.amount * 130) / max)) : 0}px"></span></button>`).join("");
    const hit = series.find((x) => x.month === sel);
    return done(`<div class="cols${many ? " tight" : ""}">${cols}</div><div class="clabs${many ? " tight" : ""}">${series.map((x) => `<span>${many ? MONTH3[Number(x.month.slice(5)) - 1][0] : MONTH3[Number(x.month.slice(5)) - 1]}</span>`).join("")}</div>
      <p class="caption" aria-live="polite">${hit ? esc(M.monthLabel(hit.month) + ": " + peso(hit.amount) + " spent.") : "Tap a column to see its month."}</p>
      <h2>Budget vs actual</h2>${trendChart(trend)}`);
  }

  if (ui.view === "budget") {
    if (p.kind !== "month") return hero + `<p class="note">Budgets are set per month. Choose a month at the top.</p><p><button class="link" data-action="period-this-month">Show this month</button></p>`;
    return viewBudgets(hero, p.month, maps, asOf, nowM, label);
  }

  if (ui.view === "account") {
    const acc = M.spendingByAccount(S(), { from, to });
    if (!acc.rows.length) return empty();
    const pct = (a) => (acc.total > 0 && a > 0 ? Math.round((a * 1000) / acc.total) / 10 : 0);
    const rows = acc.rows.map((r) => ({ id: r.account_id, label: withIcon(S().accounts.find((a) => a.id === r.account_id) ?? { name: r.name }, 24), amount: r.amount, percent: pct(r.amount) }));
    if (ui.asList) return done(listTable(["Account", "Spent", "Share"], rows.map((r) => [esc(accountName(r.id)), peso(r.amount), r.percent + "%"]), "Total", acc.total));
    return done(flipChart(rows, acc.total));
  }

  if (!cat.rows.length) return empty();
  // In a month, a category with a budget takes that budget's colour; without any budgets (or for a year or range) one calm blue.
  const budgetOf = (id) => (p.kind === "month" ? M.budgetFor(S().rules, id, p.month) : null);
  const graded = cat.rows.some((r) => budgetOf(r.category_id) !== null);
  const rows = cat.rows.map((r) => {
    const budget = budgetOf(r.category_id), g = M.budgetGrade(r.amount, budget);
    return { id: r.category_id, label: esc(r.name), amount: r.amount, percent: r.percent, grade: graded && ui.shape !== "donut" ? (g ? g.level : "none") : null };
  });
  if (ui.asList) return done(listTable(["Category", "Spent", "Share"], rows.map((r) => [r.label, peso(r.amount), r.percent + "%"]), "Total", cat.total));
  return done(flipChart(rows, cat.total, { graded: graded && ui.shape !== "donut" }));
}

// Each budget as a meter: how much of it is used, with a mark for how far through the month we are.
// Budget | Actual | Variance for one month. Variance is budget minus actual: plus means under budget (blue),
// minus means over (red). The sign and the words "under" / "over" carry the meaning; colour only backs them up.
const vtext = (v) => v === 0 ? "On budget" : (v > 0 ? "+" : "\u2212") + peso(Math.abs(v)) + (v > 0 ? " under" : " over");
const vcls = (v) => v > 0 ? "vu" : v < 0 ? "vo" : "";
const vcell = (v) => `<td class="n ${vcls(v)}">${esc(vtext(v))}</td>`;
function varianceTable(budgeted) {
  const cell = vcell;
  const sum = (k) => budgeted.reduce((n, r) => n + r[k], 0);
  return `<table class="tbl"><tr><th>Category</th><th class="n">Budget</th><th class="n">Actual</th><th class="n">Variance</th></tr>
    ${budgeted.map((r) => `<tr><td>${esc(categoryName(r.category_id))}</td><td class="n">${peso(r.budget)}</td><td class="n">${peso(r.spent)}</td>${cell(r.budget - r.spent)}</tr>`).join("")}
    <tr class="total"><td>Total</td><td class="n">${peso(sum("budget"))}</td><td class="n">${peso(sum("spent"))}</td>${cell(sum("budget") - sum("spent"))}</tr></table>`;
}

// Budget line against actual line, one point per month. A month with nothing to show is a gap: the line breaks.
// Each month is also a button that opens that month's budget view.
function trendChart(trend) {
  const W = 320, H = 150, L = 8, R = 8, T = 14, B = 8, n = trend.length;
  const max = Math.max(1, ...trend.flatMap((x) => [x.budget ?? 0, x.actual ?? 0]));
  const X = (i) => L + (i * (W - L - R)) / Math.max(1, n - 1), Y = (v) => T + (1 - v / max) * (H - T - B);
  const line = (key, cls) => {
    let d = "", pen = false;
    trend.forEach((x, i) => { if (x[key] == null) { pen = false; return; } d += (pen ? "L" : "M") + X(i).toFixed(1) + " " + Y(x[key]).toFixed(1) + " "; pen = true; });
    const dots = trend.map((x, i) => x[key] == null ? "" : `<circle class="${cls}" cx="${X(i).toFixed(1)}" cy="${Y(x[key]).toFixed(1)}" r="4.5"/>`).join("");
    return `<path class="tl ${cls}" d="${d}"/>${dots}`;
  };
  const labels = trend.map((x) => `<button class="tmonth" data-action="open-month" data-id="${x.month}" aria-label="Open ${esc(M.monthLabel(x.month))}">${esc(M.monthLabel(x.month).slice(0, 3))}</button>`).join("");
  return `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Budget and actual spending for the last ${n} months. The table below has the same numbers.">${line("budget", "tb")}${line("actual", "ta")}</svg>
    <div class="tlabs">${labels}</div>
    <p class="legend"><span><svg width="22" height="10" aria-hidden="true"><line x1="0" y1="5" x2="22" y2="5" class="tb" stroke-width="2" stroke-dasharray="4 3"/></svg>Budget</span><span><svg width="22" height="10" aria-hidden="true"><line x1="0" y1="5" x2="22" y2="5" class="ta" stroke-width="2"/></svg>Actual</span></p>
    <p class="note">A missing point means nothing was budgeted or logged that month. Tap a month to open it.</p>`;
}
function trendTable(trend) {
  const cell = (v) => v == null ? "No data" : peso(v);
  return `<table class="tbl"><tr><th>Month</th><th class="n">Budget</th><th class="n">Actual</th></tr>${[...trend].reverse().map((x) => `<tr><td>${esc(M.monthLabel(x.month))}</td><td class="n">${cell(x.budget)}</td><td class="n">${cell(x.actual)}</td></tr>`).join("")}</table>`;
}

function viewBudgets(hero, month, maps, asOf, now, label) {
  const rows = M.budgetStatus(S(), { rules: S().rules, categoryMaps: maps, month, asOf });
  const budgeted = rows.filter((r) => r.budget !== null).map((r) => ({ ...r, grade: M.budgetGrade(r.spent, r.budget) }))
    .sort((a, b) => b.spent * a.budget - a.spent * b.budget || (a.category_id < b.category_id ? -1 : 1));   // most used first
  const unbudgeted = rows.filter((r) => r.budget === null && r.spent > 0).sort((a, b) => b.spent - a.spent);
  if (!budgeted.length) {
    return hero + `<p class="note">No budgets for ${esc(label)} yet.</p><p><button class="link" data-action="tab" data-tab="budget">Set a budget</button></p>`;
  }
  const elapsed = month === now ? M.monthElapsedPercent(month, today()) : null;
  const words = (r) => r.grade.level === "critical" ? "Over by " + peso(r.spent - r.budget) : peso(r.budget - r.spent) + " left";
  if (ui.asList) {
    return hero + varianceTable(budgeted)
      + `<p><button class="link" data-action="chart-mode" data-mode="chart">Show as chart</button></p>`;
  }
  const cards = budgeted.map((r) => `<div class="bcard" role="group" aria-label="${esc(categoryName(r.category_id) + ": " + peso(r.spent) + " of " + peso(r.budget) + ", " + LEVELS[r.grade.level])}">
      <div class="btop"><span class="bname">${esc(categoryName(r.category_id))}</span><span class="bval">${peso(r.spent)} of ${peso(r.budget)}</span></div>
      <div class="meter g-${r.grade.level}"><span class="fill" style="width:${r.spent > 0 ? Math.max(1, Math.min(100, Math.round((r.spent * 100) / r.budget))) : 0}%"></span>${elapsed === null ? "" : `<span class="tick" style="left:${elapsed}%"></span>`}</div>
      <div class="status">${glyph(r.grade.level)}${esc(LEVELS[r.grade.level])} · ${esc(words(r))}${r.pending > 0 ? " · " + esc("+" + peso(r.pending) + " not verified") : ""}</div></div>`).join("");
  const rest = unbudgeted.length ? `<h2>No budget set</h2>${unbudgeted.map((r) => `<div class="row"><div>${esc(categoryName(r.category_id))}</div><div class="amt">${peso(r.spent)}</div></div>`).join("")}` : "";
  return hero + legend() + `<div>${cards}</div>${elapsed === null ? "" : `<p class="note">The black line is today's place in the month.</p>`}
    <h2>Budget vs actual</h2>${varianceTable(budgeted)}${rest}
    <p><button class="link" data-action="chart-mode" data-mode="list">Show as list</button></p>`;
}

// ---------- Budget: the monthly amounts ----------
// ---------- overrun buffer ----------
// The account the owner picks (a wallet, say) holds two envelopes the ledger tracks apart: an everyday allowance and the overrun buffer.
const gcashOf = () => (ledger.settings.gcash && S().accounts.some((a) => a.id === ledger.settings.gcash.account_id) ? ledger.settings.gcash : null);
function viewBuffer() {
  const g = gcashOf();
  if (!g) return `<h1>Buffer</h1><p class="note">The overrun buffer is money you set aside inside one of your accounts (you choose which), apart from your everyday allowance in that same account. It is only used when a category overruns, and every draw is recorded against that category.</p>
    <p><button class="primary" data-action="open-bufsetup">Set up the buffer</button></p>`;
  const month = M.monthOf(today());
  const sum = M.bufferSummary(S(), { allowance_envelope_id: g.allowance_id, buffer_envelope_id: g.buffer_id, month });
  const line = planOf()?.lines.find((l) => l.kind === "buffer");
  const monthly = line ? line.first + line.second : null;
  const acct = S().accounts.find((a) => a.id === g.account_id);
  const empty = sum.allowance <= 0;
  const draws = sum.draws.length ? `<table class="tbl"><tr><th>Category</th><th class="n">Drawn</th></tr>${sum.draws.map((d) => `<tr><td>${esc(d.name)}</td><td class="n">${d.amount === 0 && d.pending ? peso(d.pending) + "<small> not verified</small>" : peso(d.amount) + (d.pending ? `<small> + ${peso(d.pending)} not verified</small>` : "")}</td></tr>`).join("")}
      <tr class="total"><td>Total drawn</td><td class="n">${peso(sum.drawn)}</td></tr></table>` : `<p class="note">Nothing has been drawn from the buffer this month.</p>`;
  const flagged = M.underBudgetedCategories(S(), g.buffer_id, 2).map((c) => categoryName(c.category_id));
  return `<h1>Buffer</h1><p class="sub">Inside ${esc(acct.name)}</p>
    <div class="card"><dl><dt>Buffer left</dt><dd class="big">${peso(sum.buffer)}</dd>${monthly != null ? `<dt>Plan per month</dt><dd>${peso(monthly)}</dd>` : ""}<dt>Allowance left</dt><dd>${peso(sum.allowance)}</dd></dl></div>
    ${empty ? `<p class="note"><b>The everyday allowance in ${esc(acct.name)} is empty.</b> More ${esc(acct.name)} spending will draw the buffer.</p>` : ""}
    <h2>Drawn in ${esc(M.monthLabel(month))}</h2>${draws}
    ${flagged.length ? `<p class="note">${esc(flagged.join(", "))} drew the buffer in more than one month. That line may be under-budgeted: set a new budget from next month.</p>` : ""}
    <p><button class="primary" data-action="open-bufund" style="margin-top:8px">Add to the buffer</button></p>
    <p><button data-action="sweep-buffer" style="width:100%">Sweep what is left (month end)</button></p>
    <p class="note">The sweep moves the leftover to Mole Removal until it reaches its target, then to the Emergency Fund. It is saved as a draft for you to verify.</p>`;
}

// ---------- trips ----------
// A trip is a tag with an optional budget. Switch one on and new entries are tagged with it, with no extra taps.
function viewTrips() {
  const tags = S().tags, active = ledger.settings.active_tag_id;
  const cards = tags.map((t) => {
    const sum = M.tagSummary(S(), t.id, { categoryMaps: S().categoryMaps, asOf: today() });
    const g = sum.grade, on = active === t.id;
    const meter = g ? `<div class="meter g-${g.level}"><span class="fill" style="width:${sum.spent > 0 ? Math.max(1, Math.min(100, g.percent)) : 0}%"></span></div>
      <div class="status">${glyph(g.level)}${esc(LEVELS[g.level])} \u00b7 ${esc(g.over ? "Over by " + peso(sum.spent - sum.budget) : peso(sum.budget - sum.spent) + " left")}</div>` : "";
    const rows = sum.rows.length ? `<table class="tbl"><tr><th>Category</th><th class="n">Spent</th></tr>${sum.rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="n">${peso(r.amount)}</td></tr>`).join("")}</table>` : `<p class="note">Nothing verified on this trip yet.</p>`;
    return `<div class="bcard"><div class="btop"><span class="bname">${esc(t.name)}</span><span class="bval">${peso(sum.spent)}${sum.budget != null ? " of " + peso(sum.budget) : ""}</span></div>${meter}
      ${sum.pending > 0 ? `<p class="note">plus ${peso(sum.pending)} not verified yet</p>` : ""}${rows}
      <p><button data-action="use-trip" data-id="${esc(t.id)}" aria-pressed="${on}">${on ? "Tagging new entries \u2713 (tap to stop)" : "Tag new entries with this trip"}</button></p></div>`;
  }).join("");
  return `<h1>Trips</h1><p class="sub">Spending for a trip, kept apart from everyday spending.</p>${cards || `<p class="note">No trips yet.</p>`}
    <p><button class="primary" data-action="open-trip" style="margin-top:8px">Add a trip</button></p>`;
}

// ---------- checks: card reserve and the weekly Unlogged habit ----------
function viewChecks() {
  const rs = M.reserveShortfalls(S().accounts, S().entries);
  const reserve = rs.length ? rs.map((r) => {
    const card = S().accounts.find((a) => a.id === r.card_id), res = S().accounts.find((a) => a.id === r.reserve_id), o = M.cardOutstanding(card, S().entries);
    const ok = r.shortfall === 0;
    return `<div class="bcard"><div class="btop"><span class="bname who">${iconOf(card, 24)}<span>${esc(card.name)}</span></span></div>
      <dl><dt>${esc(res.name)} holds</dt><dd>${peso(r.reserve)}</dd><dt>${esc(card.name)} owes</dt><dd>${peso(r.outstanding)}<small> (${peso(o.pending)} pending + ${peso(o.posted)} posted)</small></dd></dl>
      <div class="status">${glyph(ok ? "good" : "serious")}${ok ? "Covered" : "Short by " + peso(r.shortfall)}</div></div>`;
  }).join("") : `<p class="note">No card reserve is set up. You can add one in Setup.</p>`;

  const weeks = M.unloggedByWeek(S(), M.UNLOGGED_CATEGORY_ID, today(), 8);
  const counted = weeks.filter((w) => w.amount !== null);
  const wlabel = (w) => "Week to " + longDate(w.week_end);
  let habit;
  if (!counted.length) habit = `<p class="note">No weekly count yet. <button class="link" data-action="tab" data-tab="checkin">Do the check-in</button></p>`;
  else if (ui.asList) habit = `<table class="tbl"><tr><th>Week</th><th class="n">Not accounted for</th></tr>${weeks.map((w) => `<tr><td>${esc(wlabel(w))}</td><td class="n">${w.amount === null ? "Not counted" : w.amount < 0 ? peso(-w.amount) + " found" : peso(w.amount)}</td></tr>`).join("")}</table>`;
  else {
    const rows = counted.map((w) => ({ id: w.week_end, label: esc(wlabel(w)), amount: Math.max(0, w.amount) }));
    const hit = counted.find((w) => w.week_end === ui.sel);
    habit = barChart(rows, ui.sel) + `<p class="caption" aria-live="polite">${hit ? esc(wlabel(hit) + ": " + (hit.amount < 0 ? peso(-hit.amount) + " more than your records said." : hit.amount === 0 ? "everything was accounted for." : peso(hit.amount) + " could not be accounted for.")) : "Tap a bar. Weeks you did not count are left out, not shown as zero."}</p>`;
  }
  const sv = M.surveyReview(S(), S().surveyResponses, M.UNLOGGED_CATEGORY_ID);
  const ago = (w) => w.unlogged_net < 0 ? peso(-w.unlogged_net) + " found" : peso(w.unlogged_net);
  const survey = !sv.weeks.length ? `<p class="note">The weekly questions appear after your first count.</p>`
    : !sv.ready ? `<p class="note">${sv.weeks.length} of 4 weeks answered. The review appears after about 4 weeks.</p>`
    : `<table class="tbl"><tr><th>Week to</th><th class="n">Not accounted for</th><th class="n">Missed</th><th class="n">Easier (1-5)</th><th class="n">Fixes</th></tr>${sv.weeks.map((w) => `<tr><td>${esc(longDate(w.week_end))}</td><td class="n">${esc(ago(w))}</td><td class="n">${w.q1_missed_count}${w.q1_missed_amount ? " · " + peso(w.q1_missed_amount) : ""}</td><td class="n">${w.q2_ease}</td><td class="n">${w.q4_corrections_count}</td></tr>`).join("")}</table>
      ${sv.trend ? `<p class="note">${sv.trend.change < 0 ? "\u25BC" : sv.trend.change > 0 ? "\u25B2" : "\u25AC"} Not accounted for went from ${esc(ago({ unlogged_net: sv.trend.first }))} in the first week to ${esc(ago({ unlogged_net: sv.trend.last }))} in the latest. ${sv.trend.change < 0 ? "Smaller is better logging." : sv.trend.change > 0 ? "It is growing." : "No change."}</p>` : ""}
      ${sv.weeks.some((w) => w.q3_annoyance) ? `<h2>What annoyed you</h2>${sv.weeks.filter((w) => w.q3_annoyance).map((w) => `<p class="note"><b>${esc(longDate(w.week_end))}:</b> ${esc(w.q3_annoyance)}</p>`).join("")}` : ""}`;
  return `<h1>Checks</h1><p class="sub">Two things that keep the numbers honest.</p>
    <h2>Card reserve</h2>${reserve}
    <h2>Unlogged by week</h2><p class="note">Money your counts could not explain. A smaller number means better logging.</p>${habit}
    ${counted.length ? `<p><button class="link" data-action="chart-mode" data-mode="${ui.asList ? "chart" : "list"}">${ui.asList ? "Show as chart" : "Show as list"}</button></p>` : ""}
    <h2>Weekly questions</h2>${survey}`;
}

// ---------- pay plan ----------
const plansOf = () => ledger.settings.plans ?? [];
const planOf = () => M.planInEffect(plansOf(), today());
const paydayText = (d) => (d === "last" ? "the last day of the month" : "the " + d + ord(d));
function viewPlan() {
  const plan = planOf(), all = plansOf();
  if (!plan) return `<h1>Pay plan</h1><p class="note">${all.length ? "Your plan starts " + esc(longDate([...all].sort((x, y) => (x.effective_from < y.effective_from ? -1 : 1))[0].effective_from)) + "." : "No plan loaded yet. A plan says what to set aside from each of your two paydays."}</p>
    <p><button class="primary" data-action="open-plan">Load a plan</button></p>`;
  const t = M.planTotals(plan), [p1, p2] = plan.paydays;
  const lines = plan.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="n">${peso(l.first)}</td><td class="n">${peso(l.second)}</td><td class="n">${peso(l.first + l.second)}</td></tr>`).join("");
  const prog = M.planProgress(S(), plan, today(), { categoryMaps: S().categoryMaps });
  const mine = prog.rows.filter((r) => r.kind === "expense" && r.matched);
  const unmatched = prog.rows.filter((r) => r.kind === "expense" && !r.matched);
  const which = plan.paydays[prog.period.index - 1];
  const rem = mine.map((r) => `<tr><td>${esc(r.name)}</td><td class="n">${peso(r.planned)}</td><td class="n">${peso(r.spent)}</td>${vcell(r.remaining)}</tr>`).join("");
  const history = all.length > 1 ? `<p class="note">Earlier plans stay saved: ${esc([...all].sort((x, y) => (x.effective_from < y.effective_from ? -1 : 1)).map((x) => longDate(x.effective_from)).join(", "))}.</p>` : "";
  const day = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
  const ivar = (v) => v === 0 ? "As planned" : (v > 0 ? "+" : "\u2212") + peso(Math.abs(v)) + (v > 0 ? " more" : " less");
  const incomeRows = [M.planIncome(S(), plan, day(prog.period.start, -1)), M.planIncome(S(), plan, today())].map((v) =>
    `<tr><td>${esc(v.label)}<small> ${esc(longDate(v.period.start))}</small></td><td class="n">${peso(v.planned)}</td><td class="n">${peso(v.actual)}</td><td class="n">${esc(ivar(v.variance))}</td></tr>`).join("");
  return `<h1>Pay plan</h1><p class="sub">Paydays on ${esc(paydayText(p1.day))} and ${esc(paydayText(p2.day))}. In effect since ${esc(longDate(plan.effective_from))}.</p>
    <table class="tbl"><tr><th>Line</th><th class="n">${esc(p1.label)}</th><th class="n">${esc(p2.label)}</th><th class="n">Monthly</th></tr>${lines}
      <tr class="total"><td>Total (= income)</td><td class="n">${peso(t.first)}</td><td class="n">${peso(t.second)}</td><td class="n">${peso(t.month)}</td></tr></table>
    <h2>Income</h2><table class="tbl"><tr><th>Payday</th><th class="n">Plan</th><th class="n">Received</th><th class="n">Difference</th></tr>${incomeRows}</table>
    <p class="note">The plan holds planning income. Real pay, from your payslip, is recorded below and the gap is only shown here, never changed in the plan.</p>
    <p><button data-action="open-income" style="width:100%">Record pay received</button></p>
    <h2>This cutoff</h2><p class="note">${esc(which.label)} to the day before the next: ${esc(longDate(prog.period.start))} to ${esc(longDate(prog.period.end))}. Only verified spending counts.</p>
    ${mine.length ? `<table class="tbl"><tr><th>Line</th><th class="n">Plan</th><th class="n">Spent</th><th class="n">Left</th></tr>${rem}</table>` : `<p class="note">No plan line matches one of your categories yet.</p>`}
    ${unmatched.length ? `<p class="note">Not matched to a category, so not tracked: ${esc(unmatched.map((r) => r.name).join(", "))}.</p>` : ""}
    ${history}<p class="note">A change is a new plan with a later start date. Saved plans are never edited.</p>
    <p><button data-action="open-plan" style="width:100%">Load a newer plan</button></p>`;
}
const ord = (n) => (n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");

// ---------- goals ----------
// A goal points at an account where the money really sits. Balances are hidden until you choose to show them (spec 9).
function viewGoals() {
  const goals = S().goals;
  const toggle = goals.some((g) => g.hidden_by_default) ? `<p><button class="link" data-action="toggle-reveal">${ui.reveal ? "Hide balances" : "Show balances"}</button></p>` : "";
  const cards = goals.map((g) => {
    let p = M.goalProgress(S(), g);
    if (!p) return "";
    // The Emergency Fund's target is worked out from the plan in force, never kept as a typed number.
    const isEf = /emergency/i.test(g.name), ef = isEf && planOf() ? M.emergencyFundStatus(S(), planOf(), g) : null;
    if (isEf) p = { ...p, target: null, remaining: null, percent: null, reached: false };
    const hidden = g.hidden_by_default && !ui.reveal;
    const line = planOf()?.lines.find((l) => l.kind === "goal" && l.name.toLowerCase() === g.name.toLowerCase());
    const monthly = line ? line.first + line.second : 0;
    const eta = monthly > 0 && p.remaining ? Math.ceil(p.remaining / monthly) : null;
    const need = g.deadline && p.remaining ? M.requiredPerMonth(p, g.deadline, today().slice(0, 7)) : null;
    const efBody = !ef ? "" : `<table class="tbl"><tr><td>Target</td><td class="n">${peso(ef.target)}</td></tr><tr><td>Balance now</td><td class="n">${peso(ef.balance)}</td></tr>
        <tr><td>Monthly contribution</td><td class="n">${ef.monthly ? peso(ef.monthly) : "none in your plan"}</td></tr>
        <tr><td>Months to target</td><td class="n">${ef.reached ? "Reached" : ef.monthsToTarget === null ? "Not known yet" : "About " + ef.monthsToTarget}</td></tr></table>
        <div class="meter goal" role="img" aria-label="${ef.percent}% of the target"><span class="fill" style="width:${ef.percent}%"></span></div>
        <div class="status">${ef.reached ? "Target reached" : ef.percent + "% \u00b7 " + peso(ef.remaining) + " to go"}</div>
        <p class="note">Target = ${ef.months} months of ${esc(ef.basis.join(", "))} from your plan (${peso(ef.monthlyBasis)} a month). It changes when your plan does.${ef.missing.length ? " Your plan has no line named " + esc(ef.missing.join(", ")) + "." : ""}</p>`;
    const body = hidden ? `<p class="note">Hidden. Tap Show balances above.</p>`
      : ef ? efBody
      : isEf ? `<div class="btop"><span class="bval">${peso(p.balance)}</span></div><p class="note">Load a pay plan (Menu, Pay plan) and the target is worked out from it: 3 months of Rent, Food and Essentials.</p>`
      : `<div class="btop"><span class="bval">${peso(p.balance)}${p.target != null ? " of " + peso(p.target) : ""}</span></div>
         ${p.target != null ? `<div class="meter goal" role="img" aria-label="${p.percent}% of the goal"><span class="fill" style="width:${p.percent}%"></span></div>
         <div class="status">${p.reached ? "Goal reached" : p.percent + "% \u00b7 " + peso(p.remaining) + " to go"}${eta ? " \u00b7 about " + eta + (eta === 1 ? " month" : " months") + " at your plan's " + peso(monthly) + " a month" : ""}${need ? " \u00b7 " + peso(need.perMonth) + " a month for " + need.monthsLeft + " " + (need.monthsLeft === 1 ? "month" : "months") : ""}</div>` : `<div class="status">No target, just a place to build up.</div>`}`;
    return `<div class="bcard"><div class="btop"><span class="bname who">${iconOf(S().accounts.find((a) => a.id === g.account_id) ?? { name: g.name }, 24)}<span>${esc(g.name)}</span></span></div>${body}
      <p><button data-action="open-deposit" data-id="${esc(g.id)}">Put money in</button></p></div>`;
  }).join("");
  return `<h1>Goals</h1><p class="sub">Savings you are building. Hidden by default so they do not tempt you.</p>${toggle}${cards || `<p class="note">No goals yet.</p>`}
    <p><button class="primary" data-action="open-goal" style="margin-top:8px">Add a goal</button></p>`;
}

// ---------- weekly check-in ----------
// The week is the 7 days ending today. Each account is counted against what the bank or wallet really shows.
const thisWeek = () => M.weekEndingOn(today());
const countedThisWeek = (accountId) => {
  const w = thisWeek();
  return S().checkIns.filter((c) => c.account_id === accountId && c.date >= w.week_start && c.date <= w.week_end).sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
};
const surveyThisWeek = () => S().surveyResponses.find((r) => r.id === "survey:" + thisWeek().week_start) ?? null;
const differenceText = (d) => d === 0 ? "Matches the ledger" : d < 0 ? peso(-d) + " missing" : peso(d) + " more than logged";

function viewCheckin() {
  const accts = activeAccounts();
  if (!accts.length) return `<h1>Check-in</h1><p class="note">Add accounts first.</p><button class="primary" data-action="tab" data-tab="setup">Add accounts</button>`;
  const w = thisWeek();
  const rows = accts.map((a) => {
    const c = countedThisWeek(a.id);
    const state = c ? `<span class="bval">${c.difference === 0 ? "\u2713 " : "\u25B2 "}${esc(differenceText(c.difference))}</span>` : `<span class="bval">Not counted</span>`;
    return `<button class="choice" data-action="open-checkin" data-id="${esc(a.id)}"><span class="who">${withIcon(a, 28)}</span>${state}</button>`;
  }).join("");
  const done = accts.filter((a) => countedThisWeek(a.id)).length;
  const sv = surveyThisWeek();
  const questions = done
    ? `<h2 class="today">Weekly questions</h2><button class="choice" data-action="open-survey"><span>Four quick questions</span><span class="bval">${sv ? "Answered \u2713" : "Not answered"}</span></button>` : "";
  const age = M.daysSinceBackup(ledger.settings, today());
  const backupLine = age === null || age >= 6 ? `<p class="note"><b>One reminder:</b> back up after this check-in. ${esc(backupAgeText())} <button class="link" data-action="tab" data-tab="setup">Back up now</button></p>` : "";
  return `<h1>Check-in</h1><p class="sub">Week of ${esc(longDate(w.week_start))} to ${esc(longDate(w.week_end))}</p>
    <p class="note">Open each account, look at the real balance, and type it in. ${done} of ${accts.length} counted.</p>${backupLine}${rows}${questions}
    <p class="note">Money the ledger cannot explain is recorded as Unlogged. It never blocks anything.</p>`;
}

function viewBudget() {
  const month = M.monthOf(today()), next = M.addMonths(month, 1);
  const rows = expenseCategories().map((c) => {
    const now = M.budgetFor(S().rules, c.id, month), later = M.budgetFor(S().rules, c.id, next);
    const change = later !== now ? `<small>${later === null ? "ends" : peso(later) + " a month"} from ${esc(M.monthLabel(next))}</small>` : "";
    return `<button class="choice" data-action="open-budget" data-id="${esc(c.id)}"><span>${esc(c.name)}${change}</span><span class="bval">${now === null ? "No budget" : peso(now) + " a month"}</span></button>`;
  }).join("");
  return `<h1>Budget</h1><p class="sub">How much to spend on each kind of thing each month. Tap one to set it.</p>${rows}
    <p class="note">A new budget never rewrites the past. A first budget counts from this month; a change starts next month unless you choose otherwise.</p>`;
}

const emptyMoney = () => `<p class="note">Nothing verified for this month yet. Verified entries appear here.</p><p><button class="link" data-action="tab" data-tab="verify">Go to Verify</button></p>`;

function backupAgeText() {
  const age = M.daysSinceBackup(ledger.settings, today());
  if (age === null) return "No backup yet. Right now your data exists only on this phone.";
  return age === 0 ? "Last backup: today." : "Last backup: " + age + (age === 1 ? " day" : " days") + " ago.";
}

// ---------- sheets ----------
function chips(items, selectedId, action) {
  return `<div class="chips">${items.map((i) => `<button class="chip" data-action="${action}" data-id="${esc(i.id)}" aria-pressed="${i.id === selectedId}">${i.class ? withIcon(i, 24) : esc(i.name)}</button>`).join("")}</div>`;
}

const calSelected = (target) => (target === "from" ? ui.periodDraft?.from : target === "to" ? ui.periodDraft?.to : ui.dayPick && ui.dayPick !== today() ? ui.dayPick : today());
// While a window is open the page behind it is held still (so a drag moves only the window, never the page behind it, which looked like
// sliding sideways), and the window keeps its scroll position when it is redrawn after a tap (so choosing the bank at the bottom does not
// throw you back to the top).
let lockY = null, lastSheetKey = null;
function lockPage(on) {
  if (on && lockY === null) { lockY = window.scrollY; document.body.style.top = -lockY + "px"; document.body.classList.add("locked"); }
  else if (!on && lockY !== null) { const y = lockY; lockY = null; document.body.classList.remove("locked"); document.body.style.top = ""; window.scrollTo(0, y); }
}
function renderSheet() {
  const sh = ui.sheet;
  if (!sh) { $("sheet").innerHTML = ""; lastSheetKey = null; lockPage(false); return; }
  const key = [sh.type, sh.id ?? "", sh.queueId ?? ""].join(":"), keepAt = lastSheetKey === key ? document.querySelector("#sheet .sheet")?.scrollTop ?? 0 : 0;
  lastSheetKey = key; lockPage(true);
  let body = "";
  if (sh.type === "pay") {
    const p = S().presets.find((x) => x.id === sh.id);
    body = `<h3>${esc(p.name)} ${peso(p.amount)}</h3><p class="note">Paid from</p>${chips(accountsFor(p.id), null, "pay")}`;
  } else if (sh.type === "other") {
    body = `<h3>Other amount</h3>
      <label for="f-amount">Amount (₱)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      <label>Category</label>${chips(expenseCategories(), ui.form.category_id, "pick-cat")}
      <label>Paid from</label>${chips(accountsFor(null), ui.form.account_id, "pick-acct")}
      <p><button class="primary" id="f-save" data-action="save-other" style="margin-top:14px" disabled>Save</button></p>`;
  } else if (sh.type === "edit") {
    const t = S().transactions.find((x) => x.id === sh.id), d = describe(t);
    body = `<h3>Edit entry</h3>
      ${d.editable || d.kind === "transfer" || d.kind === "income" ? `<label for="f-amount">Amount (₱)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">` : ""}
      <label for="f-date">Date</label><input id="f-date" data-field="date" type="date" value="${esc(ui.form.date)}">
      <label for="f-payee">Name (optional)</label><input id="f-payee" data-field="payee" value="${esc(ui.form.payee ?? "")}" autocomplete="off">
      ${d.editable ? `<label>Category</label>${chips(expenseCategories(), ui.form.category_id, "pick-cat")}<label>Paid from</label>${chips(accountsFor(null), ui.form.account_id, "pick-acct")}` : ""}
      <p><button class="primary" id="f-save" data-action="save-edit" style="margin-top:14px">Save</button></p>`;
  }
  if (sh.type === "banks") {
    const forAdd = sh.for === "add", acct = forAdd ? null : S().accounts.find((x) => x.id === sh.for);
    const current = forAdd ? ui.accountForm.bank : acct?.bank;
    const rows = [...M.BANKS, M.CASH].map((b) => `<button class="bankrow" data-action="pick-bankrow" data-id="${esc(b.id)}" aria-pressed="${current === b.id}">${iconOf({ name: b.name, bank: b.id, ...(bankPictureOf(b.id) ?? {}) }, 32)}<span>${esc(b.name)}</span>${current === b.id ? '<span class="tick" aria-hidden="true">\u2713</span>' : ""}</button>`).join("");
    const missing = M.BANKS.filter((b) => !bankLogo(b.id) && !bankPictureOf(b.id)).map((b) => b.name);
    const shotOnly = M.BANKS.filter((b) => b.noLookup && missing.includes(b.name)).map((b) => b.name);
    body = `<h3>${forAdd ? "Choose a bank" : "Which bank is it?"}</h3><div class="banklist" role="list">${rows}
      <button class="bankrow" data-action="pick-bankrow" data-id=""><span class="ico mono" style="width:32px;height:32px;font-size:16px" aria-hidden="true">+</span><span>${forAdd ? "Not in the list (type a name)" : "No bank"}</span></button></div>
      ${shotOnly.length ? `<p class="note">${esc(shotOnly.join(", "))}: its logo could not be found online. Add it once from a screenshot (tap the account's picture in Setup).</p>` : ""}
      ${missing.filter((n) => !shotOnly.includes(n)).length ? `<p class="note">${ui.logoBusy ? "Loading logos\u2026" : "No logo found online yet for " + esc(missing.filter((n) => !shotOnly.includes(n)).join(", ")) + ". You can add one from a screenshot: tap that account's picture in Setup."} ${ui.logoBusy ? "" : `<button class="link" data-action="retry-logos">Try again</button>`}</p>` : ""}
      ${ui.logoReport && !ui.logoBusy ? `<p class="note small" id="logo-report">${esc(ui.logoReport)}</p>` : ""}`;
  } else if (sh.type === "period") {
    const d = ui.periodDraft, nowY = Number(today().slice(0, 4)), nowM = M.monthOf(today());
    const firstYear = Math.min(nowY - 4, ...S().transactions.map((t) => Number(t.date.slice(0, 4))));
    const tabs = `<div class="seg" role="group" aria-label="Kind of period">${[["month", "Month"], ["year", "Year"], ["range", "Date range"]].map(([k, t]) => `<button data-action="period-kind" data-kind="${k}" aria-pressed="${d.kind === k}">${t}</button>`).join("")}</div>`;
    let inner;
    if (d.kind === "month") {
      inner = `<div class="stepper"><button data-action="period-draft-year" data-step="-1" aria-label="Earlier year">\u2039</button><b>${d.year}</b><button data-action="period-draft-year" data-step="1" aria-label="Later year"${d.year >= nowY ? " disabled" : ""}>\u203A</button></div>
        <div class="mgrid">${MONTH3.map((m, i) => { const id = d.year + "-" + String(i + 1).padStart(2, "0"); return `<button data-action="period-month" data-id="${id}"${id > nowM ? " disabled" : ""}${ui.period?.month === id || (!ui.period && id === nowM) ? ' aria-pressed="true"' : ""}>${m}</button>`; }).join("")}</div>`;
    } else if (d.kind === "year") {
      const years = []; for (let y = nowY; y >= firstYear; y--) years.push(y);
      inner = `<div class="mgrid">${years.map((y) => `<button data-action="period-year" data-id="${y}"${ui.period?.kind === "year" && ui.period.year === y ? ' aria-pressed="true"' : ""}>${y}</button>`).join("")}</div>`;
    } else {
      inner = `<div class="rangepick"><button data-action="open-cal" data-target="from"><small>From</small><b>${esc(fullDate(d.from))}</b></button><button data-action="open-cal" data-target="to"><small>To</small><b>${esc(fullDate(d.to))}</b></button></div>
        <div class="chips">${[["month", "This month"], ["30", "Last 30 days"], ["year", "This year"]].map(([id, t]) => `<button class="chip" data-action="range-preset" data-id="${id}">${t}</button>`).join("")}</div>
        <p><button class="primary" data-action="period-range" style="margin-top:12px">Show this range</button></p>`;
    }
    body = `<h3>Show money for</h3>${tabs}${inner}`;
  } else if (sh.type === "cal") {
    // One small calendar for three jobs: the Log day, and the start or end of a date range.
    const [y, m] = ui.calMonth.split("-").map(Number), first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const withEntries = new Set(S().transactions.filter((t) => t.date.startsWith(ui.calMonth) && !isGenerated(t)).map((t) => t.date));
    const target = sh.target ?? "day", picked = calSelected(target);
    const days = Array.from({ length: count }, (_, i) => {
      const date = ui.calMonth + "-" + String(i + 1).padStart(2, "0");
      return `<button data-action="cal-day" data-id="${date}" aria-pressed="${date === picked}" aria-label="${esc(longDate(date))}"${date > today() ? " disabled" : ""}${withEntries.has(date) ? ' class="has"' : ""}>${i + 1}</button>`;
    });
    // Always six weeks of cells, so the calendar keeps one size from month to month.
    const cells = Array.from({ length: first }, () => '<span class="blank"></span>').concat(days, Array.from({ length: 42 - first - count }, () => '<span class="blank"></span>')).join("");
    const atNow = ui.calMonth >= M.monthOf(today());
    body = `<h3>${target === "from" ? "Start date" : target === "to" ? "End date" : "Select date"}</h3>
      <div class="stepper yr"><button data-action="cal-step" data-step="-12" aria-label="Earlier year">\u00AB</button><button data-action="cal-step" data-step="-1" aria-label="Earlier month">\u2039</button><b>${esc(M.monthLabel(ui.calMonth))}</b><button data-action="cal-step" data-step="1" aria-label="Later month"${atNow ? " disabled" : ""}>\u203A</button><button data-action="cal-step" data-step="12" aria-label="Later year"${atNow ? " disabled" : ""}>\u00BB</button></div>
      <div class="cal" role="group" aria-label="Days">${["S", "M", "T", "W", "T", "F", "S"].map((d) => `<b class="dow">${d}</b>`).join("")}${cells}</div>
      <p class="note">Days in bold have entries.</p>`;
  } else if (sh.type === "bufsetup") {
    body = `<h3>Set up the buffer</h3>
      <label>Which account holds the buffer?</label>${chips(accountsFor(null), ui.form.account_id, "pick-acct")}
      <p class="note" id="b-held"></p>
      <label for="b-buf">Overrun buffer (\u20B1)</label><input id="b-buf" data-field="buf" inputmode="decimal" value="${esc(ui.form.buf ?? "")}" autocomplete="off">
      <label for="b-allow">Everyday allowance (\u20B1)</label><input id="b-allow" data-field="allow" inputmode="decimal" value="${esc(ui.form.allow ?? "")}" autocomplete="off">
      <p class="note">Together they cannot be more than the wallet holds. The wallet's total does not change; it is only split into two parts.</p>
      <p id="f-msg" role="alert" class="note"></p>
      <p><button class="primary" id="f-save" data-action="save-bufsetup" style="margin-top:6px" disabled>Split the wallet</button></p>`;
  } else if (sh.type === "bufund") {
    body = `<h3>Add to the buffer</h3>
      <label for="f-amount">Amount (\u20B1)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      <label>Take it from</label>${chips(accountsFor(null).filter((a) => a.id !== gcashOf().account_id), ui.form.account_id, "pick-acct")}
      <p class="note">Saved as verified, because you are choosing to set this money aside.</p>
      <p><button class="primary" id="f-save" data-action="save-bufund" style="margin-top:6px" disabled>Save</button></p>`;
  } else if (sh.type === "trip") {
    body = `<h3>New trip</h3>
      <label for="t-name">Name</label><input id="t-name" data-field="name" value="${esc(ui.form.name ?? "")}" autocomplete="off">
      <label for="f-amount">Trip budget (\u20B1, optional)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      <p><button class="primary" id="f-save" data-action="save-trip" style="margin-top:14px" disabled>Save trip</button></p>`;
  } else if (sh.type === "income") {
    body = `<h3>Money received</h3>
      <label for="f-amount">Amount received (\u20B1)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off" placeholder="e.g. 9776.98">
      <label for="f-date">Date it arrived</label><input id="f-date" data-field="date" type="date" value="${esc(ui.form.date)}" max="${esc(today())}">
      <label>What it is</label>${chips(incomeCategories(), ui.form.category_id, "pick-cat")}
      <label>Arrived in</label>${chips(accountsFor(null), ui.form.account_id, "pick-acct")}
      <p class="note">Pay, interest or a refund. For a full payslip with its lines, use Add a payslip on the Income screen. Saved as verified, because you are copying it from paper or a statement.</p>
      <p><button class="primary" id="f-save" data-action="save-income" style="margin-top:6px" disabled>Save</button></p>`;
  } else if (sh.type === "plan") {
    body = `<h3>Load a pay plan</h3>
      <p class="note">Choose the plan file, or paste its text. It stays on this phone and in your encrypted backups.</p>
      <label for="p-file">Plan file</label><input id="p-file" type="file" data-field="file" accept=".json,application/json,text/plain">
      <label for="p-text">Or paste it here</label><textarea id="p-text" data-field="text" rows="5" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(ui.form.text ?? "")}</textarea>
      <div id="p-prev" role="status"></div>
      <p><button class="primary" id="f-save" data-action="save-plan" style="margin-top:10px" disabled>Use this plan</button></p>`;
  } else if (sh.type === "goal") {
    body = `<h3>New goal</h3>
      <label for="g-name">Name</label><input id="g-name" data-field="name" value="${esc(ui.form.name ?? "")}" autocomplete="off">
      <label for="f-amount">Target (\u20B1, optional)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      <label for="g-date">Finish by (optional)</label><input id="g-date" type="date" data-field="deadline" value="${esc(ui.form.deadline ?? "")}">
      <label>Where the money sits</label>${chips(accountsFor(null), ui.form.account_id, "pick-acct")}
      <p><button class="primary" id="f-save" data-action="save-goal" style="margin-top:14px" disabled>Save goal</button></p>`;
  } else if (sh.type === "deposit") {
    const g = S().goals.find((x) => x.id === sh.id);
    body = `<h3>Put money in ${esc(g.name)}</h3>
      <label for="f-amount">Amount (\u20B1)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      <label>Take it from</label>${chips(accountsFor(null).filter((a) => a.id !== g.account_id), ui.form.account_id, "pick-acct")}
      <p class="note">This is saved as a draft transfer. Verify it like any other entry.</p>
      <p><button class="primary" id="f-save" data-action="save-deposit" style="margin-top:6px" disabled>Save</button></p>`;
  } else if (sh.type === "checkin") {
    const a = S().accounts.find((x) => x.id === sh.id);
    body = `<h3>Count ${esc(a.name)}</h3>
      <label for="f-amount">${a.class === "asset" ? "Balance you see now" : "Amount owed you see now"} (\u20B1)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      ${a.class === "liability" ? `<p class="note">Use the posted amount your bank shows. Charges still pending are left alone.</p>` : ""}
      <p id="f-diff" class="note" role="status"></p>
      <p><button class="primary" id="f-save" data-action="save-checkin" disabled>Save count</button></p>`;
  } else if (sh.type === "survey") {
    const w = thisWeek(), auto = M.autoFillSurvey(S(), { unlogged_category_id: M.UNLOGGED_CATEGORY_ID, week_start: w.week_start, week_end: w.week_end });
    body = `<h3>This week</h3>
      <p class="note">1. Transactions you missed. Filled in from this week's counts; change it if it is wrong.</p>
      <label for="q-count">How many</label><input id="q-count" data-field="q1c" inputmode="numeric" value="${esc(ui.form.q1c ?? "")}" autocomplete="off">
      <label for="q-amount">Worth about (\u20B1)</label><input id="q-amount" data-field="q1a" inputmode="decimal" value="${esc(ui.form.q1a ?? "")}" autocomplete="off">
      <label>2. Compared with the spreadsheet, was logging easier or harder this week? (1 much harder, 5 much easier)</label>
      <div class="seg" role="group" aria-label="Easier or harder than the spreadsheet">${[1, 2, 3, 4, 5].map((n) => `<button data-action="survey-ease" data-id="${n}" aria-pressed="${ui.form.ease === n}">${n}</button>`).join("")}</div>
      <label for="f-annoy">3. One thing that annoyed you this week (optional)</label><input id="f-annoy" data-field="annoy" value="${esc(ui.form.annoy ?? "")}" autocomplete="off">
      <p class="note">4. Photo or voice entries that needed fixing: ${auto.q4_corrections_count}. Filled in by the app: a scanned entry whose fields you changed before verifying it.</p>
      <p><button class="primary" id="f-save" data-action="save-survey" style="margin-top:14px" disabled>Save answers</button></p>`;
  } else if (sh.type === "budget") {
    const c = S().categories.find((x) => x.id === sh.id), thisM = M.monthOf(today()), nextM = M.addMonths(thisM, 1);
    body = `<h3>Budget for ${esc(c.name)}</h3>
      <label for="f-amount">Per month (₱)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      <label>Starts</label>
      <div class="seg" role="group" aria-label="When it starts">${[[thisM, "This month"], [nextM, "Next month"]].map(([m, t]) => `<button data-action="budget-start" data-month="${m}" aria-pressed="${ui.form.start === m}">${t}</button>`).join("")}</div>
      <p class="note">${esc(M.monthLabel(ui.form.start))}. Enter 0 to remove the budget.</p>
      <p><button class="primary" id="f-save" data-action="save-budget" style="margin-top:6px" disabled>Save</button></p>`;
  } else if (sh.type === "otfree") {
    const p = S().payslips.find((x) => x.id === sh.id);
    body = `<h3>Where should the free part go?</h3>
      <p class="note">It stays in ${esc(accountName(p.account_id))} unless you choose another account. Choosing one makes a draft in Verify.</p>
      ${chips(accountsFor(null).filter((a) => a.id !== p.account_id), ui.form.account_id, "pick-acct")}
      <p><button class="primary" id="f-save" data-action="save-otfree" style="margin-top:14px" disabled>Make the draft</button></p>`;
  } else if (sh.type === "payslip") {
    const f = ui.form, field = (prefix, [kind, label]) => `<label for="${prefix}${kind}">${esc(label)}</label><input id="${prefix}${kind}" data-field="${prefix}${kind}" inputmode="decimal" value="${esc(f[prefix + kind] ?? "")}" autocomplete="off" placeholder="0.00">`;
    const months = Array.from({ length: 7 }, (_, i) => M.addMonths(M.monthOf(today()), -i));
    const open = (k) => (ui.pdet?.[k] ? " open" : "");
    body = `<h3>Add a payslip</h3>
      ${sh.scanBlob ? `<img class="shot" src="${esc(pendingPhoto?.url ?? "")}" alt="Your payslip photo" style="max-height:22vh;object-fit:contain">${(f.notes ?? []).map((n) => `<p class="note">${esc(n)}</p>`).join("")}` : ""}
      <details data-keep="e"${open("e")}><summary><span>Total earnings</span><b id="p-tot-e" style="margin-left:auto"></b></summary>
        ${M.EARNINGS.map((k) => field("e_", k)).join("")}
        <label for="p-otm">Overtime was earned in</label><select id="p-otm" data-field="ot_month">${months.map((m) => `<option value="${m}"${f.ot_month === m ? " selected" : ""}>${esc(M.monthLabel(m))}</option>`).join("")}</select>
      </details>
      <details data-keep="d"${open("d")}><summary><span>Total deductions</span><b id="p-tot-d" style="margin-left:auto"></b></summary>
        ${M.DEDUCTIONS.map((k) => field("d_", k)).join("")}
      </details>
      <label>Landed in</label>${chips(accountsFor(null), f.account_id, "pick-acct")}
      <label for="p-from">Pay period from</label><input id="p-from" data-field="period_from" type="date" value="${esc(f.period_from)}">
      <label for="p-to">Pay period to</label><input id="p-to" data-field="period_to" type="date" value="${esc(f.period_to)}">
      <label for="p-date">Pay date</label><input id="p-date" data-field="pay_date" type="date" value="${esc(f.pay_date)}">
      <label for="p-emp">Employer</label><input id="p-emp" data-field="employer" value="${esc(f.employer ?? "")}" autocomplete="off">
      <details data-keep="t"${open("t")}><summary>As printed on the payslip</summary>
        <label for="p-gross">Gross pay (\u20B1)</label><input id="p-gross" data-field="gross" inputmode="decimal" value="${esc(f.gross ?? "")}" autocomplete="off">
        <label for="p-net">Net pay (\u20B1)</label><input id="p-net" data-field="net" inputmode="decimal" value="${esc(f.net ?? "")}" autocomplete="off">
        <label for="p-dep">What really arrived in the account (\u20B1)</label><input id="p-dep" data-field="deposit" inputmode="decimal" value="${esc(f.deposit ?? "")}" autocomplete="off">
        <label for="p-words">Net pay in words, if written (optional)</label><input id="p-words" data-field="words" value="${esc(f.words ?? "")}" autocomplete="off" autocapitalize="off">
      </details>
      <div id="p-flags" role="status"></div>
      <p class="note">Do not type any employee, tax or account number.</p>
      <p><button class="primary" id="f-save" data-action="save-payslip" style="margin-top:14px" disabled>Save payslip</button></p>
      ${sh.queueId ? `<p><button data-action="discard-scan" data-id="${esc(sh.queueId)}" style="width:100%">Throw this photo away</button></p>` : ""}`;
  } else if (sh.type === "scanpick") {
    body = `<h3>Scan</h3><p class="note">A receipt, a payment screen or a payslip. Take a photo now, or choose one you already have. If the app is sure of everything it saves a draft by itself; otherwise it asks.</p>${photoButtons("quick")}`;
  } else if (sh.type === "payslipchoice") {
    body = `<h3>Add a payslip</h3>
      <p><button class="primary" data-action="open-payslip" style="margin-top:6px">Type it in</button></p>
      <p class="note">Or read it from a photo (you check every figure before it is saved):</p>${photoButtons("payslip")}`;
  } else if (sh.type === "voice") {
    body = `<h3>Say it</h3>
      <p class="note">One sentence, for example: lunch 95 at Sample Burger using GCash. You can say the day (yesterday, last Friday) too.</p>
      <div class="seg" role="group" aria-label="Language">${[["en-PH", "English"], ["fil-PH", "Filipino"]].map(([v, t]) => `<button data-action="voice-lang" data-id="${v}" aria-pressed="${(ui.form.lang ?? "en-PH") === v}">${t}</button>`).join("")}</div>
      ${speechSupported() ? `<p><button class="primary" id="v-mic" data-action="voice-toggle" style="margin-top:12px">Tap and speak</button></p>` : `<p class="note">Speech is not available in this browser. Type below, or tap the box and use your keyboard's microphone key.</p>`}
      <label for="v-text">What I heard (fix it, type it, or use the keyboard's microphone key)</label>
      <textarea id="v-text" data-field="spoken" rows="3" autocomplete="off" autocapitalize="sentences">${esc(ui.form.spoken ?? "")}</textarea>
      <p id="v-msg" class="note" role="status"></p>
      <p class="note">Speech is turned into words by Apple's or Google's service, so the audio leaves your phone while you speak. Your ledger and photos never do.</p>
      <p><button class="primary" id="f-save" data-action="use-spoken" style="margin-top:6px" disabled>Use this</button></p>`;
  } else if (sh.type === "scan") {
    const f = ui.form, kind = M.kindById(f.kind), into = kind.direction === "in";
    body = `<h3>${sh.voice ? "Check what I heard" : "Check what I read"}</h3>
      ${sh.voice ? `<p class="note">You said: \u201C${esc(f.text)}\u201D</p>` : `<img class="shot" src="${esc(pendingPhoto?.url ?? "")}" alt="Your photo">`}
      <label>It looks like</label>${chips(M.KINDS.map((k) => ({ id: k.id, name: k.label })), f.kind, "pick-kind")}
      ${f.notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}
      <label for="f-amount">Amount (₱)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(f.amount ?? "")}" autocomplete="off">
      <label for="f-date">Date</label><input id="f-date" data-field="date" type="date" value="${esc(f.date)}">
      <label for="f-payee">${into ? "From" : "Paid to"} (optional)</label><input id="f-payee" data-field="payee" value="${esc(f.payee ?? "")}" autocomplete="off">
      <label>Category</label>${chips(into ? incomeCategories() : expenseCategories(), f.category_id, "pick-cat")}
      ${into ? "" : `<p><button class="link" data-action="toggle-split" aria-pressed="${f.split === true}">${f.split ? "Do not split this receipt" : "Split between two categories"}</button></p>
      ${f.split ? `<label>Second category</label>${chips(expenseCategories().filter((c) => c.id !== f.category_id), f.split_cat, "pick-split")}
        <label for="f-split">Amount that belongs to the second category (\u20B1)</label><input id="f-split" data-field="split_amt" inputmode="decimal" value="${esc(f.split_amt ?? "")}" autocomplete="off">
        <p class="note" id="split-note" role="status"></p>` : ""}`}
      <label>${into ? "Arrived in" : "Paid from"}</label>${chips(accountsFor(null), f.account_id, "pick-acct")}
      <details${sh.voice ? " hidden" : ""}><summary>What the reader saw</summary><pre class="rawtext">${esc(f.text || "(nothing)")}</pre></details>
      <p><button class="primary" id="f-save" data-action="save-scan" style="margin-top:14px" disabled>Save to Verify</button></p>
      <p class="note">It stays a draft and counts toward nothing until you verify it.</p>
      ${sh.queueId ? `<p><button data-action="discard-scan" data-id="${esc(sh.queueId)}" style="width:100%">Throw this photo away</button></p>` : ""}`;
  } else if (sh.type === "photo") {
    body = `<h3>Photo</h3><img class="shotfull" data-photo="${esc(sh.id)}" alt="The photo this entry was read from" hidden>`;
  } else if (sh.type === "icon") {
    const a = S().accounts.find((x) => x.id === sh.id);
    body = `<h3>Picture for ${esc(a.name)}</h3>
      <label for="i-bank">Which bank is it?</label>
      <button id="i-bank" class="bankpick" data-action="open-banks" data-for="${esc(a.id)}">${a.bank ? `${iconOf({ name: M.bankById(a.bank).name, bank: a.bank }, 28)}<span>${esc(M.bankById(a.bank).name)}</span>` : `<span class="muted">Not linked to a bank</span>`}<span class="chev" aria-hidden="true">\u203A</span></button>
      <p class="note">Accounts of one bank share the picture. Take a screenshot of the app's icon, choose it here, then zoom and drag until only the icon fills the square.</p>
      <input id="i-file" type="file" accept="image/*" data-field="file" aria-label="Choose a picture">
      <div id="i-stage" class="stage"><img id="i-img" alt="" hidden></div>
      <label for="i-zoom">Zoom</label><input id="i-zoom" data-field="zoom" type="range" min="1" max="4" step="0.01" value="1" disabled>
      <p id="f-msg" role="alert" class="note"></p>
      <p><button class="primary" id="f-save" data-action="save-icon" disabled>Use this picture</button></p>
      ${a.icon || a.icon_url || bankLogo(a.bank ?? M.bankForName(a.name)?.id) ? `<p><button data-action="clear-icon" style="width:100%">Remove the picture</button></p>` : ""}`;
  } else if (sh.type === "backup") {
    body = `<h3>Back up now</h3>
      <p class="note">Choose a passphrase of at least ${M.MIN_PASSPHRASE} characters. Write it down in two places, away from this phone. Without it nobody can open the backup, not even me.</p>
      <label for="b-pass">Passphrase</label><input id="b-pass" data-field="pass" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(ui.form.pass ?? "")}">
      <label for="b-pass2">Passphrase again</label><input id="b-pass2" data-field="pass2" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(ui.form.pass2 ?? "")}">
      <p id="f-msg" role="alert" class="note"></p>
      <p><button class="primary" id="f-save" data-action="make-backup" disabled>Create backup file</button></p>
      <p class="note">Next you choose where to keep the file, for example Save to Files. It is encrypted, so it is safe in iCloud Drive or on a flash drive.</p>`;
  } else if (sh.type === "restore" && !ui.form.restored) {
    body = `<h3>Restore from a backup</h3>
      <p class="note">This replaces everything on this phone with the backup.</p>
      <label for="r-file">Backup file</label><input id="r-file" data-field="file" type="file" accept=".json,application/json">
      <label for="r-pass">Passphrase</label><input id="r-pass" data-field="pass" type="password" autocomplete="off" autocapitalize="off" spellcheck="false">
      <p id="f-msg" role="alert" class="note"></p>
      <p><button class="primary" id="f-save" data-action="open-backup-file" disabled>Open backup</button></p>`;
  } else if (sh.type === "restore") {
    const b = M.summarizeLedger(ui.form.restored), now = M.summarizeLedger(ledger);
    const count = (n, one, many) => n + " " + (n === 1 ? one : many);
    const line = (x) => `${count(x.accounts, "account", "accounts")}, ${x.transactions ? count(x.transactions, "entry", "entries") : "no entries"}${x.latest_date ? ", latest " + longDate(x.latest_date) : ""}`;
    body = `<h3>Replace this phone's data?</h3>
      <div class="card" style="border:0;padding:0"><dl><dt>The backup</dt><dd>${esc(line(b))}${b.saved_at ? "<br>saved " + esc(longDate(b.saved_at.slice(0, 10))) : ""}</dd><dt>This phone</dt><dd>${esc(line(now))}</dd></dl></div>
      <p class="note">Anything entered on this phone since the backup was made will be gone.</p>
      <p><button class="primary" id="f-save" data-action="restore-now">${ui.form.confirmRestore ? "Tap again to replace" : "Replace this phone's data"}</button></p>`;
  }
  $("sheet").innerHTML = `<div id="scrim" data-action="close-sheet"></div><div class="sheet" role="dialog">${body}<p><button data-action="close-sheet" style="width:100%">${sh.type === "photo" ? "Close" : "Cancel"}</button></p></div>`;
  const box = document.querySelector("#sheet .sheet"); if (box && keepAt) box.scrollTop = keepAt;
  if (voiceListener && sh.type === "voice") { const b = $("v-mic"); if (b) b.textContent = "Listening... tap to stop"; }
  refreshSave();
  hydratePhotos();
}

function refreshSave() {
  const btn = $("f-save");
  if (!btn) return;
  const type = ui.sheet?.type, f = ui.form;
  if (type === "other") {
    const a = M.parsePesos(f.amount);
    btn.disabled = !(a.ok && a.centavos > 0 && f.category_id && f.account_id);
  } else if (type === "budget") {
    const a = M.parsePesos(f.amount);
    btn.disabled = !a.ok;
  } else if (type === "checkin") {
    const a = M.parsePesos(f.amount), acct = S().accounts.find((x) => x.id === ui.sheet.id);
    btn.disabled = !a.ok || a.centavos < 0;
    const out = $("f-diff");
    if (out) out.textContent = a.ok && acct ? "The ledger says " + peso(M.ledgerBalanceFor(acct, S().entries)) + ". " + differenceText(a.centavos - M.ledgerBalanceFor(acct, S().entries)) + "." : "";
  } else if (type === "survey") {
    const c = (f.q1c ?? "").trim(), a = M.parsePesos(f.q1a ?? "");
    btn.disabled = !(f.ease && /^\d{1,4}$/.test(c) && a.ok);
  } else if (type === "bufsetup") {
    const buf = f.buf ? M.parsePesos(f.buf) : { ok: true, centavos: 0 }, allow = f.allow ? M.parsePesos(f.allow) : { ok: true, centavos: 0 };
    const acct = S().accounts.find((a) => a.id === f.account_id), held = acct ? M.naturalBalance(acct, S().entries) : 0;
    const msg = $("f-msg"), note = $("b-held");
    if (note) note.textContent = acct ? acct.name + " holds " + peso(held) + "." : "";
    const over = buf.ok && allow.ok && buf.centavos + allow.centavos > held;
    if (msg) msg.textContent = over ? "That is " + peso(buf.centavos + allow.centavos - held) + " more than the wallet holds." : "";
    btn.disabled = !(acct && buf.ok && allow.ok && !over && buf.centavos + allow.centavos > 0);
  } else if (type === "bufund") {
    const a = M.parsePesos(f.amount);
    btn.disabled = !(a.ok && a.centavos > 0 && f.account_id);
  } else if (type === "trip") {
    const a = f.amount ? M.parsePesos(f.amount) : { ok: true };
    btn.disabled = !((f.name ?? "").trim() && a.ok);
  } else if (type === "otfree") {
    btn.disabled = !f.account_id;
  } else if (type === "payslip") {
    const { p, ready } = savePayslipReady(f);
    btn.disabled = !ready;
    const out = $("p-flags");
    if (out) {
      const lines = [...p.earnings.map((l) => ({ ...l, side: "earning" })), ...p.deductions.map((l) => ({ ...l, side: "deduction" }))];
      const t = M.payslipTotals(lines);
      const te = $("p-tot-e"), td = $("p-tot-d"); if (te) te.textContent = peso(t.gross); if (td) td.textContent = peso(t.deductions);
      const flags = p.printed_gross && p.printed_net && p.deposit ? M.payslipChecks({ printed_gross: p.printed_gross, printed_net: p.printed_net, deposit: p.deposit, net_words: (f.words ?? "").trim() || undefined }, lines) : [];
      out.innerHTML = (lines.length ? `<p class="note">The lines add to gross ${peso(t.gross)}; minus deductions, net ${peso(t.net)}.</p>` : "") + (p.errors.length ? `<p class="note flag">\u25B2 Check the amount typed for: ${esc(p.errors.join(", "))}.</p>` : "") + flags.map(flagLine).join("");
    }
  } else if (type === "voice") {
    btn.disabled = !(f.spoken ?? "").trim();
  } else if (type === "scan") {
    const a = M.parsePesos(f.amount), second = M.parsePesos(f.split_amt ?? "");
    const splitOk = !f.split || (f.split_cat && f.split_cat !== f.category_id && second.ok && second.centavos > 0 && a.ok && second.centavos < a.centavos);
    const note = $("split-note");
    if (note) note.textContent = splitOk && f.split ? categoryName(f.category_id) + " gets " + peso(a.centavos - second.centavos) + ", " + categoryName(f.split_cat) + " gets " + peso(second.centavos) + "." : "Choose the second category and its amount, which must be less than the total.";
    btn.disabled = !(a.ok && a.centavos > 0 && M.isPhDate(f.date) && f.category_id && f.account_id && splitOk);
  } else if (type === "income") {
    const a = M.parsePesos(f.amount);
    btn.disabled = !(a.ok && a.centavos > 0 && f.account_id && f.date);
  } else if (type === "plan") {
    const r = (f.text ?? "").trim() ? M.parsePlan(f.text) : null, out = $("p-prev");
    btn.disabled = !r?.ok;
    if (out) out.innerHTML = !r ? "" : r.ok
      ? `<p class="note"><b>Looks good:</b> starts ${esc(longDate(r.plan.effective_from))}, paydays on ${esc(paydayText(r.plan.paydays[0].day))} and ${esc(paydayText(r.plan.paydays[1].day))}, ${r.plan.lines.length} lines, ${peso(M.planTotals(r.plan).month)} a month.</p>`
      : `<p role="alert" class="note"><b>${esc(r.error)}</b></p>`;
  } else if (type === "goal") {
    const a = f.amount ? M.parsePesos(f.amount) : { ok: true };
    btn.disabled = !((f.name ?? "").trim() && f.account_id && a.ok);
  } else if (type === "deposit") {
    const a = M.parsePesos(f.amount);
    btn.disabled = !(a.ok && a.centavos > 0 && f.account_id);
  } else if (type === "backup") {
    const long = (f.pass ?? "").length >= M.MIN_PASSPHRASE, same = f.pass === f.pass2;
    btn.disabled = !(long && same) || f.busy;
    $("f-msg").textContent = !(f.pass ?? "").length ? "" : !long ? "At least " + M.MIN_PASSPHRASE + " characters." : !same && (f.pass2 ?? "").length ? "The two do not match." : "";
  } else if (type === "restore" && !f.restored) {
    btn.disabled = !(f.file && (f.pass ?? "").length) || f.busy;
  }
}

// ---------- toast ----------
function showToast(text, undoId, extra) {
  clearTimeout(toastTimer);
  $("toast").innerHTML = `${extra ? `<div class="extra">${esc(extra)}</div>` : ""}<div class="bar"><span>${esc(text)}</span>${undoId ? `<button data-action="undo" data-id="${esc(undoId)}">Undo</button>` : ""}</div>`;
  toastTimer = setTimeout(() => { $("toast").innerHTML = ""; }, 8000);
}

const reserveNote = (violations) => {
  const v = violations.find((x) => x.code === "RESERVE_BELOW_OUTSTANDING");
  return v ? "The card reserve is " + peso(v.shortfall) + " short of what you owe on the card." : "";
};

// ---------- actions ----------
const bufferNote = (violations) => {
  const w = (c) => violations.find((x) => x.code === c);
  if (w("BUFFER_EXHAUSTED")) return "This was more than the allowance and the buffer together.";
  if (w("BUFFER_DRAWN")) return peso(w("BUFFER_DRAWN").drawn) + " came out of the overrun buffer.";
  if (w("ALLOWANCE_EMPTY")) return "The everyday allowance in this account is empty. More spending from it draws the buffer.";
  return "";
};

async function logExpense(input, label) {
  const tag_id = S().tags.some((t) => t.id === ledger.settings.active_tag_id) ? ledger.settings.active_tag_id : undefined;
  const g = gcashOf();
  let drafts, note;
  const swapLines = (d) => (input.lines ? { transaction: d.transaction, entries: M.splitCategoryEntry(d.entries, d.transaction.id, input.lines) } : d);   // a split keeps every other rule of the purchase
  if (g && input.account_id === g.account_id) {
    // Spending from the buffer's account takes from the allowance first, then the buffer (spec 6.4).
    const p = M.planGcashSpend(S(), { transaction_id: input.transaction_id, date: input.date ?? today(), payee: input.payee ?? "", category_id: input.category_id, amount: input.amount,
      gcash_account_id: g.account_id, allowance_envelope_id: g.allowance_id, buffer_envelope_id: g.buffer_id }, new Date());
    if (!p.ok) { showToast("Could not save: " + p.violations[0].message); return false; }
    drafts = [swapLines({ transaction: { ...p.transaction, source: input.source ?? "manual", ...(input.source === "photo" ? { edited_before_verify: false } : {}), ...(input.payee ? { payee: input.payee } : {}), ...(tag_id ? { tag_id } : {}) }, entries: p.entries })];
    note = bufferNote(p.violations);
  } else {
    const args = { ...input, tag_id, date: input.date ?? today(), reserve_source_id: ledger.settings.reserve_source_id };
    const plan = input.lines ? M.planSplitExpense(S(), args, new Date()) : M.planExpense(S(), args, new Date());
    if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); return false; }
    drafts = plan.drafts;
    note = reserveNote(plan.violations);
  }
  const settings = { ...ledger.settings, last_account_id: input.account_id, ...(input.drop_scan ? { scan_queue: scanQueue().filter((q) => q.id !== input.drop_scan) } : {}),
    last_account_by_preset: { ...(ledger.settings.last_account_by_preset ?? {}), ...(input.preset_id ? { [input.preset_id]: input.account_id } : {}) } };
  let next = M.applyDrafts(S(), drafts);
  if (input.photo_id) { const a = M.planAttachment(next, { id: input.photo_id, transaction_id: drafts[0].transaction.id }); if (a.ok) next = a.state; }
  const ok = await commit(next, settings);
  showToast((ok ? "Saved " : "Not safely stored: ") + label + " · " + accountName(input.account_id), drafts[0].transaction.id, note);
  return ok;
}

async function onClick(el) {
  const { action, id, tab } = el.dataset;
  const form = ui.form;
  switch (action) {
    case "reset-trial": {
      if (!ui.confirmTrial) { ui.confirmTrial = true; renderBanner(); break; }
      await clearTrialStorage(); location.reload(); break;
    }
    case "open-menu": ui.menu = true; renderMenu(); $("menuBtn")?.setAttribute("aria-expanded", "true"); break;
    case "close-menu": ui.menu = false; renderMenu(); $("menuBtn")?.setAttribute("aria-expanded", "false"); break;
    case "tab": $("toast").innerHTML = ""; ui.menu = false; ui.tab = tab; ui.sheet = null; ui.confirmDelete = null; ui.confirmRemove = null; ui.sel = null; renderAll(); break;
    case "period-step": {
      const p = period(), step = Number(el.dataset.step);
      ui.period = p.kind === "year" ? { kind: "year", year: p.year + step } : { kind: "month", month: M.addMonths(p.month, step) };
      ui.sel = null; renderScreen(); break;
    }
    case "period-this-month": ui.period = null; renderScreen(); break;
    case "flip-chart": ui.shape = ui.shape === "donut" ? "bars" : "donut"; renderScreen(); break;
    case "open-period": {
      const p = period(), t = today(), [f, to] = periodBounds(p);
      ui.periodDraft = { kind: p.kind, year: p.kind === "year" ? p.year : Number((p.month ?? to).slice(0, 4)), from: p.kind === "range" ? p.from : f, to: p.kind === "range" ? p.to : (to > t ? t : to) };
      ui.sheet = { type: "period" }; renderSheet(); break;
    }
    case "period-kind": ui.periodDraft.kind = el.dataset.kind; renderSheet(); break;
    case "period-draft-year": ui.periodDraft.year = Math.min(Number(today().slice(0, 4)), ui.periodDraft.year + Number(el.dataset.step)); renderSheet(); break;
    case "period-month": ui.period = { kind: "month", month: id }; ui.sheet = null; ui.sel = null; renderAll(); break;
    case "period-year": ui.period = { kind: "year", year: Number(id) }; ui.sheet = null; ui.sel = null; renderAll(); break;
    case "period-range": {
      const d = ui.periodDraft;
      ui.period = { kind: "range", from: d.from, to: d.to }; ui.sheet = null; ui.sel = null; renderAll(); break;
    }
    case "range-preset": {
      const t = today(), d = (n) => new Date(Date.parse(t) - n * 86400000).toISOString().slice(0, 10);
      const r = id === "month" ? { from: t.slice(0, 8) + "01", to: t } : id === "30" ? { from: d(29), to: t } : { from: t.slice(0, 4) + "-01-01", to: t };
      ui.period = { kind: "range", ...r }; ui.sheet = null; ui.sel = null; renderAll(); break;
    }
    case "chart-view": ui.view = el.dataset.view; ui.sel = null; renderScreen(); break;
    case "chart-mode": ui.asList = el.dataset.mode === "list"; renderScreen(); break;
    case "open-month": ui.period = { kind: "month", month: id }; ui.view = "budget"; ui.sel = null; ui.asList = false; renderScreen(); break;
    case "pick-bar": ui.sel = ui.sel === id ? null : id; renderScreen(); break;
    case "open-budget": {
      const cur = M.budgetFor(S().rules, id, M.monthOf(today()));
      ui.sheet = { type: "budget", id };
      ui.form = { amount: cur === null ? "" : (cur / 100).toFixed(2), start: M.suggestedBudgetStart(S().rules, id, today()) };
      renderSheet(); break;
    }
    case "budget-start": ui.form.start = el.dataset.month; renderSheet(); break;
    case "save-budget": {
      const amount = M.parsePesos(ui.form.amount);
      if (!amount.ok) { showToast("Enter an amount like 4000, or 0 to remove the budget"); break; }
      const plan = M.planBudgetChange(S(), { id: newId("rule"), category_id: ui.sheet.id, amount: amount.centavos, from_month: ui.form.start }, new Date());
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      const name = categoryName(ui.sheet.id);
      ui.sheet = null; renderSheet();
      await commit(plan.state);
      showToast(amount.centavos === 0 ? "Budget removed for " + name : "Budget saved for " + name);
      break;
    }
    case "open-checkin": ui.sheet = { type: "checkin", id }; ui.form = { amount: "" }; renderSheet(); break;
    case "save-checkin": {
      const amount = M.parsePesos(ui.form.amount), acct = S().accounts.find((x) => x.id === ui.sheet.id);
      if (!amount.ok) { showToast("Enter the balance like 1250.50"); break; }
      const plan = M.planCheckIn(S(), { id: newId("chk"), transaction_id: newId("tx"), date: today(), account_id: acct.id, counted_balance: amount.centavos, unlogged_category_id: M.UNLOGGED_CATEGORY_ID }, new Date());
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      const next = { ...S(), checkIns: [...S().checkIns, plan.checkIn] };
      if (plan.transaction) { next.transactions = [...S().transactions, plan.transaction]; next.entries = [...S().entries, ...plan.entries]; }
      ui.sheet = null; renderSheet();
      await commit(next);
      showToast(acct.name + ": " + differenceText(plan.checkIn.difference));
      break;
    }
    case "open-survey": {
      const sv = surveyThisWeek();
      const w = thisWeek(), auto = M.autoFillSurvey(S(), { unlogged_category_id: M.UNLOGGED_CATEGORY_ID, week_start: w.week_start, week_end: w.week_end });
      ui.sheet = { type: "survey" };
      ui.form = { ease: sv?.q2_ease ?? null, annoy: sv?.q3_annoyance ?? "", q1c: String(sv?.q1_missed_count ?? auto.q1_missed_count), q1a: ((sv?.q1_missed_amount ?? auto.q1_missed_amount) / 100).toFixed(2) };
      renderSheet(); break;
    }
    case "survey-ease": ui.form.ease = Number(id); renderSheet(); break;
    case "save-survey": {
      const w = thisWeek(), auto = M.autoFillSurvey(S(), { unlogged_category_id: M.UNLOGGED_CATEGORY_ID, week_start: w.week_start, week_end: w.week_end });
      const plan = M.planSurveyResponse(auto, { q2_ease: ui.form.ease, q3_annoyance: ui.form.annoy ?? "", q1_missed_count: Number(ui.form.q1c), q1_missed_amount: M.parsePesos(ui.form.q1a).centavos });
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      ui.sheet = null; renderSheet();
      await commit({ ...S(), surveyResponses: [...S().surveyResponses.filter((r) => r.id !== plan.response.id), plan.response] });
      showToast("Answers saved");
      break;
    }
    case "toggle-reveal": ui.reveal = !ui.reveal; renderScreen(); break;
    case "open-goal": ui.sheet = { type: "goal" }; ui.form = { name: "", amount: "", deadline: "", account_id: null }; renderSheet(); break;
    case "save-goal": {
      const f = ui.form, target = f.amount ? M.parsePesos(f.amount) : null;
      if (target && !target.ok) { showToast("Enter the target like 20000"); break; }
      const plan = M.planGoal(S(), { id: newId("goal"), account_id: f.account_id, name: f.name, target: target ? target.centavos : null, deadline: f.deadline || undefined });
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      ui.sheet = null; renderSheet();
      await commit(plan.state);
      showToast("Goal added: " + plan.goal.name);
      break;
    }
    case "open-deposit": ui.sheet = { type: "deposit", id }; ui.form = { amount: "", account_id: accountsFor(null).find((a) => a.id !== S().goals.find((g) => g.id === id)?.account_id)?.id ?? null }; renderSheet(); break;
    case "save-deposit": {
      const amount = M.parsePesos(ui.form.amount);
      if (!amount.ok) { showToast("Enter an amount like 500"); break; }
      const g = S().goals.find((x) => x.id === ui.sheet.id);
      const plan = M.planGoalDeposit(S(), { transaction_id: newId("tx"), date: today(), goal_id: g.id, from_account_id: ui.form.account_id, amount: amount.centavos }, new Date());
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      ui.sheet = null; renderSheet();
      await commit(plan.state);
      showToast(peso(amount.centavos) + " set for " + g.name + ". Verify it to count it.");
      break;
    }
    case "open-bufsetup": {
      const line = planOf()?.lines.find((l) => l.kind === "buffer");
      ui.sheet = { type: "bufsetup" }; ui.form = { account_id: null, buf: line ? ((line.first + line.second) / 100).toFixed(2) : "", allow: "" }; renderSheet(); break;
    }
    case "save-bufsetup": {
      const buf = ui.form.buf ? M.parsePesos(ui.form.buf) : { ok: true, centavos: 0 }, allow = ui.form.allow ? M.parsePesos(ui.form.allow) : { ok: true, centavos: 0 };
      if (!buf.ok || !allow.ok) { showToast("Enter amounts like 2000"); break; }
      const ids = { allow: newId("env"), buf: newId("env") };
      const plan = M.planEnvelopeSetup(S(), { gcash_account_id: ui.form.account_id, allowance_envelope_id: ids.allow, buffer_envelope_id: ids.buf, allowance_amount: allow.centavos, buffer_amount: buf.centavos, date: today(), transaction_ids: [newId("tx"), newId("tx")] }, new Date());
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      ui.sheet = null; renderSheet();
      await commit(plan.state, { ...ledger.settings, gcash: { account_id: ui.form.account_id, allowance_id: ids.allow, buffer_id: ids.buf } });
      showToast("Wallet split into two parts");
      break;
    }
    case "open-bufund": ui.sheet = { type: "bufund" }; ui.form = { amount: "", account_id: accountsFor(null).find((a) => a.id !== gcashOf().account_id)?.id ?? null }; renderSheet(); break;
    case "save-bufund": {
      const amount = M.parsePesos(ui.form.amount), g = gcashOf();
      if (!amount.ok) { showToast("Enter an amount like 1000"); break; }
      const plan = M.planBufferFunding(S(), { transaction_id: newId("tx"), date: today(), amount: amount.centavos, from_account_id: ui.form.account_id, gcash_account_id: g.account_id, buffer_envelope_id: g.buffer_id }, new Date());
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      ui.sheet = null; renderSheet();
      await commit(plan.state);
      showToast(peso(amount.centavos) + " added to the buffer");
      break;
    }
    case "sweep-buffer": {
      const g = gcashOf(), mole = S().goals.find((x) => /mole/i.test(x.name)), emerg = S().goals.find((x) => /emergency/i.test(x.name));
      if (!mole || !emerg) { showToast("Add goals named Mole Removal and Emergency Fund first (Menu, Goals)."); break; }
      const plan = M.planMonthEndSweep(S(), { transaction_id: newId("tx"), date: today(), gcash_account_id: g.account_id, buffer_envelope_id: g.buffer_id, mole_account_id: mole.account_id, emergency_account_id: emerg.account_id, mole_target: mole.target ?? 0 }, new Date());
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      if (!plan.transaction) { showToast("Nothing left in the buffer to sweep."); break; }
      await commit(M.applyDrafts(S(), [{ transaction: plan.transaction, entries: plan.entries }]));
      showToast("Sweep saved as a draft. Verify it in Verify.");
      break;
    }
    case "open-trip": ui.sheet = { type: "trip" }; ui.form = { name: "", amount: "" }; renderSheet(); break;
    case "save-trip": {
      const budget = ui.form.amount ? M.parsePesos(ui.form.amount) : null;
      if (budget && !budget.ok) { showToast("Enter the budget like 13000"); break; }
      const plan = M.planTag(S(), { id: newId("tag"), name: ui.form.name, budget: budget ? budget.centavos : undefined });
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      ui.sheet = null; renderSheet();
      await commit(plan.state);
      showToast("Trip added: " + plan.tag.name);
      break;
    }
    case "use-trip": {
      const { active_tag_id, ...rest } = ledger.settings;
      await commit(S(), active_tag_id === id ? rest : { ...rest, active_tag_id: id });
      break;
    }
    case "stop-trip": { const { active_tag_id, ...rest } = ledger.settings; await commit(S(), rest); break; }
    case "open-income": ui.sheet = { type: "income" }; ui.form = { amount: "", date: today(), account_id: accountsFor(null)[0]?.id ?? null, category_id: "cat-salary" }; renderSheet(); break;
    case "save-income": {
      const amount = M.parsePesos(ui.form.amount);
      if (!amount.ok) { showToast("Enter the pay like 9776.98"); break; }
      const plan = M.planPayReceived(S(), { transaction_id: newId("tx"), date: ui.form.date, amount: amount.centavos, account_id: ui.form.account_id, category_id: ui.form.category_id }, new Date());
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      ui.sheet = null; renderSheet();
      await commit(plan.state);
      showToast("Recorded: " + peso(amount.centavos));
      break;
    }
    case "open-plan": ui.sheet = { type: "plan" }; ui.form = { text: "" }; renderSheet(); break;
    case "save-plan": {
      const r = M.parsePlan(ui.form.text ?? "");
      if (!r.ok) { showToast(r.error); break; }
      const added = M.addPlan(plansOf(), r.plan);
      if (!added.ok) { showToast(added.error); break; }
      ui.sheet = null; renderSheet();
      if (!added.unchanged) await commit(S(), { ...ledger.settings, plans: added.plans });
      showToast(added.unchanged ? "That plan is already saved" : "Plan loaded");
      break;
    }
    case "open-cal": { const target = el.dataset.target ?? "day"; ui.calMonth = M.monthOf(calSelected(target) ?? today()); ui.sheet = { type: "cal", target }; renderSheet(); break; }
    case "cal-step": { let next = M.addMonths(ui.calMonth, Number(el.dataset.step)); if (next > M.monthOf(today())) next = M.monthOf(today()); ui.calMonth = next; renderSheet(); break; }
    case "cal-day": {
      const target = ui.sheet.target ?? "day";
      const d = ui.periodDraft;
      if (target === "from") { d.from = id; if (d.to < id) d.to = id; ui.sheet = { type: "period" }; renderSheet(); break; }
      if (target === "to") { d.to = id; if (d.from > id) d.from = id; ui.sheet = { type: "period" }; renderSheet(); break; }
      ui.dayPick = id === today() ? null : id;
      ui.sheet = null; renderAll(); break;
    }
    case "reset-day": ui.dayPick = null; renderScreen(); break;
    case "open-banks": ui.sheetBack = ui.sheet; ui.sheet = { type: "banks", for: el.dataset.for }; renderSheet(); break;
    case "retry-logos": await loadBankLogos({ force: true }); renderSheet(); break;
    case "pick-bankrow": {
      const target = ui.sheet.for;
      if (target === "add") { ui.accountForm.bank = id || null; ui.accountForm.sub = ""; ui.setupError = null; ui.sheet = null; renderAll(); break; }
      const a = S().accounts.find((x) => x.id === target), named = M.bankForName(a.name), want = id || null;
      // An account whose name plainly means one bank is not linked to a different one by a single stray tap.
      if (want && a.bank !== want && named && named.id !== want && ui.confirmLink !== want) {
        ui.confirmLink = want;
        showToast("This account is named " + a.name + ". Tap " + M.bankById(want).name + " again to link it anyway.");
        break;
      }
      ui.confirmLink = null;
      const r = M.linkAccountBank(S(), a.id, want);
      ui.sheet = { type: "icon", id: a.id }; ui.form = {};
      if (r.ok) await commit(r.state); else renderSheet();
      break;
    }
    case "open-icon": ui.sheet = { type: "icon", id }; ui.form = {}; renderSheet(); break;
    case "save-icon": await saveIcon(); break;
    case "clear-icon": {
      const a = S().accounts.find((x) => x.id === ui.sheet.id);
      const r = M.setAccountIcon(S(), a.id, null);
      ui.sheet = null; renderSheet();
      // A logo that came from the bank is removed for the bank, and not fetched again, so a wrong one can be replaced by a screenshot.
      const key = a.bank ?? M.bankForName(a.name)?.id;
      let settings = ledger.settings;
      if (key && bankLogo(key)) { const rest = { ...(settings.bankLogos ?? {}) }; delete rest[key]; settings = { ...settings, bankLogos: rest, bankLogosBlocked: { ...(settings.bankLogosBlocked ?? {}), [key]: true } }; }
      if (r.ok) await commit(r.state, settings);
      break;
    }
    case "open-preset": ui.sheet = { type: "pay", id }; renderSheet(); break;
    case "pay": {
      const p = S().presets.find((x) => x.id === ui.sheet.id);
      ui.sheet = null; renderSheet();
      await logExpense({ transaction_id: newId("tx"), payee: p.name, category_id: p.category_id, amount: p.amount, account_id: id, source: "preset", preset_id: p.id }, p.name + " " + peso(p.amount));
      break;
    }
    case "open-other": ui.sheet = { type: "other" }; ui.form = { amount: "", category_id: null, account_id: accountsFor(null)[0]?.id }; renderSheet(); break;
    case "pick-cat": form.category_id = id; if (form.split_cat === id) form.split_cat = null; renderSheet(); break;
    case "toggle-split": form.split = !form.split; renderSheet(); break;
    case "pick-split": form.split_cat = id; renderSheet(); break;
    case "open-voice": ui.sheet = { type: "voice" }; ui.form = { spoken: "", lang: "en-PH" }; renderSheet(); break;
    case "voice-lang": ui.form.lang = id; document.querySelectorAll('[data-action="voice-lang"]').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === id))); break;
    case "voice-toggle": voiceToggle(); break;
    case "use-spoken": await useSpoken(); break;
    case "open-queue": { const next = scanQueue().find((q) => q.needs); if (next) await openQueuedScan(next.id); break; }
    case "read-queue": await processScanQueue({ interactive: true }); break;
    case "discard-scan": {
      ui.sheet = null; renderSheet();
      if (await commit(S(), withQueue(scanQueue().filter((q) => q.id !== id)))) deletePhoto(id).catch(() => {});
      showToast("Photo thrown away."); break;
    }
    case "open-scan-pick": ui.sheet = { type: "scanpick" }; renderSheet(); break;
    case "open-payslip-choice": ui.sheet = { type: "payslipchoice" }; renderSheet(); break;
    case "open-payslip": ui.pdet = {}; ui.sheet = { type: "payslip" }; ui.form = payslipDefaults(); renderSheet(); break;
    case "save-payslip": await savePayslip(); break;
    case "open-otfree": ui.sheet = { type: "otfree", id }; ui.form = { account_id: null }; renderSheet(); break;
    case "save-otfree": {
      const d = M.overtimeFreeDraft(S(), ui.sheet.id, { transaction_id: "otf-" + ui.sheet.id, to_account_id: form.account_id }, new Date());
      if (!d?.ok || !d.transaction) { showToast("Could not make the draft: " + (d?.violations?.[0]?.message ?? "no overtime")); break; }
      ui.sheet = null; renderSheet();
      await commit(M.applyDrafts(S(), [d])); showToast("The draft is waiting in Verify."); break;
    }
    case "income-year": ui.incomeYear = String(Number(incomeYear()) + Number(el.dataset.step)); renderScreen(); break;
    case "ot-draft": {
      const emerg = S().goals.find((x) => /emergency/i.test(x.name));
      if (!emerg) { showToast("Add a goal named Emergency Fund first (Menu, Goals)."); break; }
      const d = M.overtimeDraft(S(), id, { transaction_id: "ot-" + id, emergency_account_id: emerg.account_id }, new Date());
      if (!d?.ok || !d.transaction) { showToast("Could not make the draft."); break; }
      await commit(M.applyDrafts(S(), [d])); showToast("The Emergency Fund draft is waiting in Verify."); break;
    }
    case "pick-kind": if (id === "payslip" && pendingPhoto && !ui.sheet.voice) { openPayslipFromPhoto(pendingPhoto.blob, form.text ?? "", ui.sheet.queueId ?? null); break; } form.kind = id; Object.assign(form, scanDefaults(id, form.guess, form.payee)); renderSheet(); break;
    case "save-scan": await saveScan(); break;
    case "open-photo": ui.sheet = { type: "photo", id }; renderSheet(); break;
    case "pick-acct": form.account_id = id; renderSheet(); break;
    case "close-sheet": voiceListener?.stop(); ui.sheet = null; renderSheet(); break;
    case "save-other": {
      const amount = M.parsePesos(form.amount).centavos;
      ui.sheet = null; renderSheet();
      await logExpense({ transaction_id: newId("tx"), payee: "", category_id: form.category_id, amount, account_id: form.account_id, source: "manual" }, categoryName(form.category_id) + " " + peso(amount));
      break;
    }
    case "undo": {
      const photos = M.attachmentsFor(S(), id);
      const r = M.discardDraft(S(), id);
      $("toast").innerHTML = "";
      if (r.ok && await commit(r.state)) for (const a of photos) deletePhoto(a.id).catch(() => {});
      break;
    }
    case "verify-ok": {
      const r = M.verifyDraft(S(), id);
      ui.confirmDelete = null;
      if (r.ok) await commit(r.state); else showToast("Could not verify: " + r.violations[0].message);
      break;
    }
    case "verify-edit": {
      const t = S().transactions.find((x) => x.id === id), d = describe(t);
      ui.form = { date: t.date, payee: t.payee, category_id: d.category_id, account_id: d.account_id,
        ...(d.editable || d.kind === "transfer" || d.kind === "income" ? { amount: (d.amount / 100).toFixed(2) } : {}) };
      ui.sheet = { type: "edit", id }; renderSheet(); break;
    }
    case "save-edit": {
      const changes = { date: form.date, payee: form.payee };
      if (form.amount !== undefined) {
        const a = M.parsePesos(form.amount);
        if (!a.ok || a.centavos <= 0) { showToast("Enter an amount like 95 or 95.50"); return; }
        changes.amount = a.centavos;
      }
      if (form.category_id) changes.category_id = form.category_id;
      if (form.account_id) changes.account_id = form.account_id;
      const r = M.editDraftFields(S(), ui.sheet.id, changes, { reserve_source_id: ledger.settings.reserve_source_id });
      if (!r.ok) { showToast("Could not save: " + r.violations[0].message); return; }
      ui.sheet = null;
      await commit(r.state);
      break;
    }
    case "verify-delete": {
      if (ui.confirmDelete !== id) { ui.confirmDelete = id; renderScreen(); break; }
      ui.confirmDelete = null;
      const photos = M.attachmentsFor(S(), id);
      const r = M.discardDraft(S(), id);
      if (r.ok && await commit(r.state)) for (const a of photos) deletePhoto(a.id).catch(() => {});
      break;
    }
    case "open-backup": ui.sheet = { type: "backup" }; ui.form = {}; renderSheet(); break;
    case "open-restore": ui.sheet = { type: "restore" }; ui.form = {}; renderSheet(); break;
    case "make-backup": await makeBackup(); break;
    case "open-backup-file": await openBackupFile(); break;
    case "restore-now": await restoreNow(); break;
    case "add-account": await addAccount(); break;
    case "remove-account": {
      if (S().entries.some((e) => e.account_id === id)) break;
      if (ui.confirmRemove !== id) { ui.confirmRemove = id; renderScreen(); break; }
      ui.confirmRemove = null;
      // A reserve that covered the removed card stays as an ordinary account, with its link cleared.
      const rest = S().accounts.filter((a) => a.id !== id).map(({ reserve_for, ...a }) => (reserve_for === id ? a : { ...a, ...(reserve_for ? { reserve_for } : {}) }));
      const settings = { ...ledger.settings }; if (settings.reserve_source_id === id) delete settings.reserve_source_id;
      await commit({ ...S(), accounts: rest }, settings);
      break;
    }
    case "repair": {
      const r = await writeBoth(JSON.stringify(boot.ledger), { local: boot.repairTo === "local", idb: boot.repairTo === "idb" });
      if (r.local && r.idb) location.reload(); else { ui.error = "Repair failed. Nothing was changed."; renderAll(); }
      break;
    }
  }
}

// ---------- choosing a picture for an account ----------
// The picture is cropped to a square on the phone and shrunk to 96 pixels; it never leaves the phone
// (except inside your encrypted backup).
const CROP = 240, ICON_PX = 96;

function cropGeometry() {
  const c = ui.form.crop, scale = c.base * c.zoom;
  c.dw = c.img.naturalWidth * scale; c.dh = c.img.naturalHeight * scale;
  c.x = Math.min(0, Math.max(CROP - c.dw, c.x)); c.y = Math.min(0, Math.max(CROP - c.dh, c.y));   // the picture must always cover the square
}
function paintCrop() {
  const c = ui.form.crop, el = $("i-img");
  cropGeometry();
  Object.assign(el.style, { width: c.dw + "px", height: c.dh + "px", left: c.x + "px", top: c.y + "px" });
  el.src = c.url; el.hidden = false;
}

async function loadIcon(file) {
  if (!file) return;
  const url = URL.createObjectURL(file), img = new Image();
  try { await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; }); }
  catch { $("f-msg").textContent = "That file could not be read as a picture."; return; }
  const base = CROP / Math.min(img.naturalWidth, img.naturalHeight);   // just big enough to cover the square
  ui.form.crop = { img, url, base, zoom: 1, x: (CROP - img.naturalWidth * base) / 2, y: (CROP - img.naturalHeight * base) / 2 };
  paintCrop();
  $("i-zoom").value = 1; $("i-zoom").disabled = false; $("f-save").disabled = false; $("f-msg").textContent = "";
}

function zoomTo(zoom) {
  const c = ui.form.crop; if (!c) return;
  const old = c.base * c.zoom, cx = (CROP / 2 - c.x) / old, cy = (CROP / 2 - c.y) / old;   // keep the middle of the square where it is
  c.zoom = zoom; c.x = CROP / 2 - cx * c.base * zoom; c.y = CROP / 2 - cy * c.base * zoom;
  paintCrop();
}

let drag = null;
document.addEventListener("pointerdown", (e) => {
  const stage = e.target.closest?.("#i-stage");
  if (!stage || !ui.form.crop) return;
  drag = { px: e.clientX, py: e.clientY, x: ui.form.crop.x, y: ui.form.crop.y };
  stage.setPointerCapture?.(e.pointerId);
});
document.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const c = ui.form.crop; c.x = drag.x + e.clientX - drag.px; c.y = drag.y + e.clientY - drag.py;
  paintCrop();
});
document.addEventListener("pointerup", () => { drag = null; });
document.addEventListener("pointercancel", () => { drag = null; });

async function saveIcon() {
  const c = ui.form.crop; if (!c) return;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = ICON_PX;
  const ctx = canvas.getContext("2d"), scale = c.base * c.zoom;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, ICON_PX, ICON_PX);
  ctx.drawImage(c.img, -c.x / scale, -c.y / scale, CROP / scale, CROP / scale, 0, 0, ICON_PX, ICON_PX);
  let url = canvas.toDataURL("image/png");
  if (url.length > 38000) url = canvas.toDataURL("image/jpeg", 0.8);   // a very detailed picture: keep it small
  const r = M.setAccountIcon(S(), ui.sheet.id, url);
  if (!r.ok) { $("f-msg").textContent = r.violations[0].message; return; }
  URL.revokeObjectURL(c.url);
  ui.sheet = null; renderSheet();
  await commit(r.state);
  showToast("Picture saved");
}

// While the passphrase is being stretched (about a second) the sheet is not redrawn, so what you typed
// stays; the button and message are changed in place.
function working(on, message) {
  ui.form.busy = on;
  const btn = $("f-save"); if (btn) btn.disabled = on;
  if ($("f-msg")) $("f-msg").textContent = message ?? "";
}

async function makeBackup() {
  working(true, "Working...");
  try {
    const encrypted = await M.encryptLedgerBackup(ledger, ui.form.pass);
    const name = M.backupFileName(today());
    const file = new File([JSON.stringify(encrypted)], name, { type: "application/json" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "Finance backup" });   // the share sheet: choose Save to Files
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
  } catch (e) {
    working(false, e.name === "AbortError" ? "Not saved. Tap Create backup file to try again." : "Could not create the backup: " + e.message);
    return;
  }
  ui.sheet = null;
  await commit(S(), { ...ledger.settings, last_backup_at: M.phTimestamp() });
  showToast("Backup file created. Check that it is in Files or on your drive.");
}

async function openBackupFile() {
  working(true, "Opening...");
  try {
    const restored = await M.decryptLedgerBackup(JSON.parse(await ui.form.file.text()), ui.form.pass);
    ui.form = { restored, confirmRestore: false };
    renderSheet();
  } catch (e) {
    working(false, e instanceof SyntaxError ? "That file is not a backup." : e.message.startsWith("could not decrypt") ? "Wrong passphrase, or the file is damaged." : e.message);
  }
}

async function restoreNow() {
  if (!ui.form.confirmRestore) { ui.form.confirmRestore = true; renderSheet(); return; }
  const next = M.restoreLedger(ledger, ui.form.restored);
  const r = await writeBoth(JSON.stringify(next));
  if (r.local && r.idb) { location.reload(); return; }
  ui.sheet = null; ui.error = "The restore could not be saved to " + [!r.local && "localStorage", !r.idb && "IndexedDB"].filter(Boolean).join(" and ") + ". Nothing else was changed.";
  renderAll();
}

async function addAccount() {
  const f = ui.accountForm;
  const fail = (m) => { ui.setupError = m; renderScreen(); $("a-error")?.scrollIntoView({ block: "center" }); };
  const opening = f.opening.trim() === "" ? { ok: true, centavos: 0 } : M.parsePesos(f.opening);
  if (!opening.ok) return fail("Enter the balance like 1250 or 1250.50.");
  const plan = M.planAccount(S(), { id: newId("acct"), bank: f.bank || undefined, sub: f.sub, name: f.name, kind: f.kind, opening: opening.centavos, date: today(), covers: f.covers });
  if (!plan.ok) return fail(plan.violations[0].message);
  ui.setupError = null;
  ui.accountForm = { name: "", bank: null, sub: "", kind: f.kind, opening: "", covers: "" };
  document.activeElement?.blur();   // close the keyboard so the result is visible
  const ok = await commit(plan.state);
  window.scrollTo(0, 0);
  showToast((ok ? "Added " : "Not safely stored: ") + plan.account.name);
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el) onClick(el);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ui.menu) { ui.menu = false; renderMenu(); } });
// which fold-out parts of the payslip window are open, so choosing an account (which redraws the window) does not fold them shut
document.addEventListener("toggle", (e) => { const k = e.target?.dataset?.keep; if (k) ui.pdet = { ...ui.pdet, [k]: e.target.open }; }, true);
document.addEventListener("input", (e) => {
  const field = e.target.dataset?.field;
  if (!field) return;
  if (e.target.type === "file") return;   // handled on change
  if (field === "sub" && !ui.sheet) { ui.accountForm.sub = e.target.value; const p = $("a-preview"); if (p) p.textContent = "Saved as: " + accountPreview(ui.accountForm); return; }
  if (field === "zoom") { zoomTo(Number(e.target.value)); return; }
  if (ui.sheet) { ui.form[field] = e.target.value; refreshSave(); }
  else ui.accountForm[field] = e.target.value;
});
document.addEventListener("change", (e) => {
  if (e.target.dataset?.scan) {
    const file = e.target.files[0], mode = e.target.dataset.scan; e.target.value = "";
    if (ui.sheet && (ui.sheet.type === "scanpick" || ui.sheet.type === "payslipchoice")) { ui.sheet = null; renderSheet(); }   // the choice is made: close it
    if (mode === "quick") quickCapture(file); else startScan(file, mode === "payslip");
    return;
  }
  if (e.target.type === "file" && ui.sheet) {
    if (ui.sheet.type === "plan") {
      const file = e.target.files[0];
      if (file) file.text().then((t) => { ui.form.text = t; $("p-text").value = t; refreshSave(); });
      return;
    }
    if (ui.sheet.type === "icon") loadIcon(e.target.files[0]);
    else { ui.form.file = e.target.files[0] ?? null; refreshSave(); }
    return;
  }
  const field = e.target.dataset?.field;
  if (field && !ui.sheet) { ui.accountForm[field] = e.target.value; if (field === "kind") { ui.accountForm.covers = ""; renderScreen(); } }
  if (e.target.dataset?.actionChange === "set-reserve-source") commit(S(), { ...ledger.settings, reserve_source_id: e.target.value || undefined });
});

// ---------- anything unexpected is shown, never silent ----------
function showFault(message) {
  ui.error = "Something went wrong: " + message + ". Nothing was lost; tell me exactly what you tapped.";
  renderBanner();
}
window.addEventListener("error", (e) => showFault(e.message));
window.addEventListener("unhandledrejection", (e) => showFault(String(e.reason?.message ?? e.reason)));

// ---------- start ----------
async function start() {
  const platform = M.detectPlatform(navigator.userAgent);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const trial = new URLSearchParams(location.search).has("trial") && M.trialAllowed({ platform, standalone });   // never on the iPhone Home Screen app
  if (trial) useTrialStorage();
  const { local, idb } = await readBoth();
  const present = (v) => (v === undefined ? null : v !== null && v.length > 0);
  device = M.assessDevice({ platform, standalone, stores: { local: present(local), idb: present(idb) }, trial });
  boot = M.chooseLedger(local ?? null, idb ?? null);
  if (boot.status === "CORRUPT") {
    device = { status: "CORRUPT", allowEntry: false, message: "The saved data on this phone could not be read, so nothing is shown and nothing will be overwritten. Restore from your encrypted backup." };
  } else {
    ledger = boot.ledger;
    ledger.state = M.ensureIncomeCategories(ledger.state);   // older ledgers gain Interest, Refund and Other income (saved with the next save)
    if (boot.status === "NONE") ledger.state = { ...ledger.state, categories: M.defaultCategories(), presets: M.defaultPresets() };   // kept in memory until the first save
    // The two stores disagree on revision only (a save reached one and not the other): repair quietly from the newer.
    if (boot.status === "REPAIR" && local != null && idb != null && device.allowEntry) {
      await writeBoth(JSON.stringify(ledger), { local: boot.repairTo === "local", idb: boot.repairTo === "idb" });
    }
  }
  if (!device.allowEntry) ui.tab = "log";
  renderAll();
  if (device.allowEntry && boot.status === "OK") {
    // Grey placeholder pictures saved by earlier versions are dropped at once, so a letter tile shows instead of a wrong one;
    // then the listed banks' logos are loaded in the background, so they are there from the start. (On a brand-new phone
    // this happens right after the first save instead; see commit.)
    await dropOldPlaceholders();
    loadBankLogos();
    processScanQueue();   // photos taken just before the app was closed are read now
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && device.allowEntry) processScanQueue(); });
start();
