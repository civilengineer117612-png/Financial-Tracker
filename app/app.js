// The screens. All money rules live in ../src/model; this file only draws and handles taps.
// Plain and firm, never harsh: facts are stated once, nothing is red, nothing blocks logging.
import * as M from "../src/model/index.js";
import { readBoth, writeBoth } from "./store.js";

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
  accountForm: { name: "", kind: "asset", opening: "", covers: "" },
  month: null, view: "category", asList: false, sel: null,   // the Money tab
};
let toastTimer = null;

// ---------- reading helpers ----------
const S = () => ledger.state;
const activeAccounts = () => S().accounts.filter((a) => !a.archived);
const accountName = (id) => S().accounts.find((a) => a.id === id)?.name ?? "?";
const categoryName = (id) => S().categories.find((c) => c.id === id)?.name ?? "?";
const expenseCategories = () => S().categories.filter((c) => c.kind === "expense" && c.id !== M.UNLOGGED_CATEGORY_ID);

// The picture the owner chose for an account, or a plain first-letter tile until they do.
function iconOf(a, size = 28) {
  if (a.icon) return `<img class="ico" src="${esc(a.icon)}" alt="" width="${size}" height="${size}">`;
  const letter = [...a.name][0]?.toUpperCase() ?? "?";
  return `<span class="ico mono" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px" aria-hidden="true">${esc(letter)}</span>`;
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
  if (es.length === 2 && cat && acct) {
    return { kind: "expense", editable: true, title: t.payee || categoryName(cat.category_id), category_id: cat.category_id, account_id: acct.account_id, amount: Math.abs(cat.amount), detail: accountName(acct.account_id) };
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
async function commit(state, settings = ledger.settings) {
  const next = M.nextLedger(ledger, state, settings);
  const r = await writeBoth(JSON.stringify(next));
  ledger = next;   // keep working in memory even if a store failed; the banner says so
  const failed = [!r.local && "localStorage", !r.idb && "IndexedDB"].filter(Boolean);
  ui.error = failed.length ? "Could not save to " + failed.join(" and ") + ". What you see is not safely stored yet. The next save tries again." : null;
  renderAll();
  return failed.length === 0;
}

// ---------- rendering ----------
function renderAll() { renderBanner(); renderScreen(); renderNav(); renderSheet(); renderMenu(); }

// Everything that is not Log or Verify lives in the menu at the upper left, so new screens (and later photo
// and audio capture beside Log and Verify) can be added without crowding the bottom bar.
const MENU = [["Money", [["money", "Money"], ["budget", "Budget"]]], ["Weekly", [["checkin", "Check-in"]]]];   // grouped like folders; Setup is pinned at the bottom

function renderTop(title) {
  const lines = `<svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true"><rect y="0" width="22" height="3" rx="1.5" fill="currentColor"/><rect y="6.5" width="22" height="3" rx="1.5" fill="currentColor"/><rect y="13" width="22" height="3" rx="1.5" fill="currentColor"/></svg>`;
  $("top").innerHTML = (device.allowEntry ? `<button class="menubtn" id="menuBtn" data-action="open-menu" aria-label="Menu" aria-expanded="${ui.menu}">${lines}</button>` : "") + `<h1>${esc(title)}</h1>`;
}

function renderMenu() {
  if (!ui.menu || !device.allowEntry) { $("menu").innerHTML = ""; return; }
  const item = (id, label) => `<button class="item" data-action="tab" data-tab="${id}"${ui.tab === id ? ' aria-current="page"' : ""}>${label}</button>`;
  const age = M.daysSinceBackup(ledger.settings, today());
  const backup = age === null ? "No backup yet" : "Last backup " + age + (age === 1 ? " day ago" : " days ago");
  $("menu").innerHTML = `<div class="scrim" data-action="close-menu"></div><aside class="drawer" role="dialog" aria-label="Menu">
    <div class="groups">${MENU.map(([group, items]) => `<h2>${group}</h2>${items.map(([id, label]) => item(id, label)).join("")}`).join("")}</div>
    <div class="foot"><p class="note">${backup}</p>${item("setup", "Setup")}
    <button class="item" data-action="close-menu">Close</button></div></aside>`;
}

function renderBanner() {
  const bars = [];
  if (ui.error) bars.push(`<div class="bar" role="alert">${esc(ui.error)}</div>`);
  const showDevice = device.status !== "OK" && !(device.status === "EMPTY" && S().accounts.length > 0);
  if (showDevice) {
    const repair = device.status === "PARTIAL_LOSS" && boot.ledger ? `<p><button data-action="repair">Copy the surviving data into the empty store</button></p>` : "";
    bars.push(`<div class="bar" role="status">${esc(device.message)}${repair}</div>`);
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
    : ui.tab === "verify" ? viewVerify() : ui.tab === "setup" ? viewSetup() : ui.tab === "money" ? viewMoney() : ui.tab === "budget" ? viewBudget() : ui.tab === "checkin" ? viewCheckin() : viewLog();
  const m = /^<h1>([^<]*)<\/h1>/.exec(html);
  renderTop(m ? m[1] : "Finance");
  $("screen").innerHTML = m ? html.slice(m[0].length) : html;
}

function viewLog() {
  if (activeAccounts().length === 0) {
    return `<h1>Log</h1><p class="sub">${esc(longDate(today()))}</p><p class="note">Add the accounts you pay from first.</p>
      <button class="primary" data-action="tab" data-tab="setup">Add accounts</button>`;
  }
  const due = dueDrafts().length;
  const todays = S().transactions.filter((t) => t.date === today() && !isGenerated(t)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const age = M.daysSinceBackup(ledger.settings, today());
  const backupNote = age === null || age >= BACKUP_NOTE_DAYS
    ? `<p class="note"><button class="link" data-action="tab" data-tab="setup">${age === null ? "No backup yet" : "Last backup " + age + " days ago"}</button></p>` : "";
  const dueNote = due ? `<p class="note"><button class="link" data-action="tab" data-tab="verify">${due} ${due === 1 ? "entry" : "entries"} from before today ${due === 1 ? "needs" : "need"} verifying</button></p>` : "";
  return `<h1>Log</h1><p class="sub">${esc(longDate(today()))}</p>${dueNote}${backupNote}
    <div class="tiles">${S().presets.map((p) => `<button class="tile" data-action="open-preset" data-id="${esc(p.id)}"><b>${esc(p.name)}</b><span>${peso(p.amount)}</span></button>`).join("")}</div>
    <p><button class="primary" data-action="open-other" style="margin-top:12px">Other amount</button></p>
    <h2 class="today">Today</h2>${todays.length ? todays.map(rowFor).join("") : `<p class="note">Nothing logged today.</p>`}`;
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
    : d.detail ? `<dt>Between</dt><dd>${esc(d.detail)}</dd>` : "";
  const reserve = partner ? `<dt>Also</dt><dd>reserve transfer ${peso(describe(partner).amount)}</dd>` : "";
  const del = ui.confirmDelete === t.id;
  return `${head}<p class="note">1 of ${list.length}</p>
    <div class="card"><div class="what">${esc(d.title)}</div><div class="big">${peso(d.amount)}</div>
      <dl><dt>Date</dt><dd>${esc(longDate(t.date))}</dd>${fields}${reserve}</dl>
      <div class="actions">
        <button class="primary wide" data-action="verify-ok" data-id="${esc(t.id)}">Correct</button>
        <button data-action="verify-edit" data-id="${esc(t.id)}">Edit</button>
        <button data-action="verify-delete" data-id="${esc(t.id)}">${del ? "Tap again to delete" : "Delete"}</button>
      </div></div>`;
}

function viewSetup() {
  const f = ui.accountForm;
  const cards = S().accounts.filter((a) => a.class === "liability" && !a.archived);
  const used = new Set(S().entries.map((e) => e.account_id));
  const reserveExists = S().accounts.some((a) => a.reserve_for);
  const hosts = activeAccounts().filter((a) => a.class === "asset" && !a.reserve_for);
  const rows = S().accounts.map((a) => `<div class="row"><div class="who"><button class="icobtn" data-action="open-icon" data-id="${esc(a.id)}" aria-label="Choose a picture for ${esc(a.name)}">${iconOf(a, 44)}</button><div>${esc(a.name)}<small>${a.class === "asset" ? "money you have" : "money you owe (card)"}${a.reserve_for ? " · covers " + esc(accountName(a.reserve_for)) : ""}${a.icon ? "" : " · tap the tile to add a picture"}</small></div></div>
      <div class="amt">${peso(M.naturalBalance(a, S().entries))}${used.has(a.id) ? "" : `<br><button class="link" data-action="remove-account" data-id="${esc(a.id)}">${ui.confirmRemove === a.id ? "Tap again to remove" : "Remove"}</button>`}</div></div>`).join("");
  // The form comes FIRST so it stays in the same place however many accounts there are: the
  // button never drifts down behind the keyboard. The list of accounts follows it.
  return `<h1>Setup</h1><p class="sub">Accounts. The ledger is on this phone only.</p>
    <h2>Add an account</h2>
    <label for="a-name">Name</label><input id="a-name" data-field="name" value="${esc(f.name)}" autocomplete="off" enterkeyhint="next">
    <label for="a-kind">Type</label><select id="a-kind" data-field="kind"><option value="asset"${f.kind === "asset" ? " selected" : ""}>Money I have (cash, bank, wallet)</option><option value="liability"${f.kind === "liability" ? " selected" : ""}>Money I owe (credit card)</option></select>
    <label for="a-open">${f.kind === "asset" ? "Balance today" : "Amount owed today"} (₱)</label><input id="a-open" data-field="opening" inputmode="decimal" value="${esc(f.opening)}" placeholder="0.00" autocomplete="off">
    ${f.kind === "asset" && cards.length ? `<label for="a-covers">This account is a reserve for a card (optional)</label><select id="a-covers" data-field="covers"><option value="">No</option>${cards.map((c) => `<option value="${esc(c.id)}"${f.covers === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>` : ""}
    ${ui.setupError ? `<p id="a-error" role="alert"><b>${esc(ui.setupError)}</b></p>` : ""}
    <p><button class="primary" data-action="add-account" style="margin-top:14px">Add account</button></p>
    <h2>Your accounts</h2>
    ${rows || `<p class="note">No accounts yet.</p>`}
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

function viewMoney() {
  const now = M.monthOf(today()), month = ui.month ?? now;
  const maps = S().categoryMaps, asOf = today();
  const cat = M.spendingByCategory(S(), { month, categoryMaps: maps, asOf });
  const prev = M.spendingByCategory(S(), { month: M.addMonths(month, -1), categoryMaps: maps, asOf });
  const label = M.monthLabel(month);

  // The headline first; then what to look at; then the chart; then the same thing as a list.
  let delta = "";
  if (prev.total > 0 && cat.total > 0) {
    const d = cat.total - prev.total, pm = M.monthLabel(M.addMonths(month, -1)).split(" ")[0];
    delta = `<p class="sub">${d === 0 ? "The same as " + pm + "." : peso(Math.abs(d)) + (d > 0 ? " more" : " less") + " than " + pm + "."}</p>`;
  }
  const pending = cat.pending > 0 ? `<p class="note"><button class="link" data-action="tab" data-tab="verify">plus ${peso(cat.pending)} not verified yet</button></p>` : "";
  const stepper = `<div class="stepper"><button data-action="month-step" data-step="-1" aria-label="Previous month">‹</button><b>${esc(label)}</b><button data-action="month-step" data-step="1" aria-label="Next month"${month >= now ? " disabled" : ""}>›</button></div>`;
  const views = `<div class="seg" role="group" aria-label="What to show">${[["category", "Where it went"], ["budget", "Budgets"], ["account", "Paid from"], ["month", "By month"]].map(([v, t]) => `<button data-action="chart-view" data-view="${v}" aria-pressed="${ui.view === v}">${t}</button>`).join("")}</div>`;
  const hero = `<h1>Money</h1>${stepper}<div class="hero">${peso(cat.total)}</div><p class="sub">spent in ${esc(label)}</p>${delta}${pending}${views}`;
  const modeLink = `<p><button class="link" data-action="chart-mode" data-mode="${ui.asList ? "chart" : "list"}">${ui.asList ? "Show as chart" : "Show as list"}</button></p>`;
  const done = (html) => hero + html + modeLink;

  if (ui.view === "month") {
    const series = M.monthlySpending(S(), { endMonth: month, months: 6, categoryMaps: maps, asOf });
    if (!series.some((x) => x.amount !== 0)) return hero + emptyMoney();
    if (ui.asList) return done(listTable(["Month", "Spent"], [...series].reverse().map((x) => [esc(M.monthLabel(x.month)), peso(x.amount)]), "Six months", series.reduce((n, x) => n + x.amount, 0)));
    const max = Math.max(...series.map((x) => x.amount), 1), sel = ui.sel;
    const cols = series.map((x) => `<button class="col${sel && sel !== x.month ? " dim" : ""}" data-action="pick-bar" data-id="${x.month}" aria-pressed="${sel === x.month}" aria-label="${esc(M.monthLabel(x.month) + ": " + peso(x.amount))}">
        <span class="cval">${x.month === month || x.month === sel ? M.formatPesosWhole(x.amount) : ""}</span><span class="cbar" style="height:${x.amount > 0 ? Math.max(4, Math.round((x.amount * 130) / max)) : 0}px"></span></button>`).join("");
    const hit = series.find((x) => x.month === sel);
    return done(`<div class="cols">${cols}</div><div class="clabs">${series.map((x) => `<span>${esc(M.monthLabel(x.month).slice(0, 3))}</span>`).join("")}</div>
      <p class="caption" aria-live="polite">${hit ? esc(M.monthLabel(hit.month) + ": " + peso(hit.amount) + " spent.") : "Tap a column to see its month."}</p>`);
  }

  if (ui.view === "budget") return viewBudgets(hero, month, maps, asOf, now, label);

  if (ui.view === "account") {
    const acc = M.spendingByAccount(S(), { month });
    if (!acc.rows.length) return hero + emptyMoney();
    const pct = (a) => (acc.total > 0 && a > 0 ? Math.round((a * 1000) / acc.total) / 10 : 0);
    const rows = acc.rows.map((r) => ({ id: r.account_id, label: withIcon(S().accounts.find((a) => a.id === r.account_id) ?? { name: r.name }, 24), amount: r.amount, percent: pct(r.amount) }));
    if (ui.asList) return done(listTable(["Account", "Spent", "Share"], rows.map((r) => [esc(accountName(r.id)), peso(r.amount), r.percent + "%"]), "Total", acc.total));
    const hit = rows.find((r) => r.id === ui.sel);
    return done(barChart(foldRows(rows.filter((r) => r.amount > 0), acc.total), ui.sel)
      + `<p class="caption" aria-live="polite">${hit ? esc(accountName(hit.id) + ": " + peso(hit.amount) + ", " + hit.percent + "% of what you spent in " + label + ".") : "Tap a bar to see its share."}</p>`);
  }

  if (!cat.rows.length) return hero + emptyMoney();
  // Where a category has a budget this month its bar takes that budget's colour; without any budgets at all, one calm blue.
  const budgetOf = (id) => M.budgetFor(S().rules, id, month);
  const graded = cat.rows.some((r) => budgetOf(r.category_id) !== null);
  const rows = cat.rows.map((r) => {
    const budget = budgetOf(r.category_id), g = M.budgetGrade(r.amount, budget);
    return { id: r.category_id, label: esc(r.name), amount: r.amount, percent: r.percent, budget, grade: graded ? (g ? g.level : "none") : null, used: g ? g.percent : null };
  });
  if (ui.asList) return done(listTable(["Category", "Spent", "Share"], rows.map((r) => [r.label, peso(r.amount), r.percent + "%"]), "Total", cat.total));
  const hit = rows.find((r) => r.id === ui.sel);
  const hitWords = hit ? esc(hit.label + ": " + peso(hit.amount) + ", " + hit.percent + "% of what you spent in " + label + ".") + (hit.budget ? " " + esc("Budget " + peso(hit.budget) + ": " + hit.used + "% used" + (hit.grade === "critical" ? ", over by " + peso(hit.amount - hit.budget) : "") + ".") : "") : "Tap a bar to see its share.";
  return done((graded ? legend() : "") + barChart(foldRows(rows.filter((r) => r.amount > 0), cat.total), ui.sel)
    + `<p class="caption" aria-live="polite">${hitWords}</p>`);
}

// Each budget as a meter: how much of it is used, with a mark for how far through the month we are.
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
    return hero + listTable(["Category", "Spent", "Budget"], budgeted.map((r) => [esc(categoryName(r.category_id)), peso(r.spent), peso(r.budget) + " · " + r.grade.percent + "% · " + LEVELS[r.grade.level]]), "Total spent", budgeted.reduce((n, r) => n + r.spent, 0))
      + `<p><button class="link" data-action="chart-mode" data-mode="chart">Show as chart</button></p>`;
  }
  const cards = budgeted.map((r) => `<div class="bcard" role="group" aria-label="${esc(categoryName(r.category_id) + ": " + peso(r.spent) + " of " + peso(r.budget) + ", " + LEVELS[r.grade.level])}">
      <div class="btop"><span class="bname">${esc(categoryName(r.category_id))}</span><span class="bval">${peso(r.spent)} of ${peso(r.budget)}</span></div>
      <div class="meter g-${r.grade.level}"><span class="fill" style="width:${r.spent > 0 ? Math.max(1, Math.min(100, Math.round((r.spent * 100) / r.budget))) : 0}%"></span>${elapsed === null ? "" : `<span class="tick" style="left:${elapsed}%"></span>`}</div>
      <div class="status">${glyph(r.grade.level)}${esc(LEVELS[r.grade.level])} · ${esc(words(r))}${r.pending > 0 ? " · " + esc("+" + peso(r.pending) + " not verified") : ""}</div></div>`).join("");
  const rest = unbudgeted.length ? `<h2>No budget set</h2>${unbudgeted.map((r) => `<div class="row"><div>${esc(categoryName(r.category_id))}</div><div class="amt">${peso(r.spent)}</div></div>`).join("")}` : "";
  return hero + legend() + `<div>${cards}</div>${elapsed === null ? "" : `<p class="note">The black line is today's place in the month.</p>`}${rest}
    <p><button class="link" data-action="chart-mode" data-mode="list">Show as list</button></p>`;
}

// ---------- Budget: the monthly amounts ----------
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
    ? `<h2 class="today">Weekly questions</h2><button class="choice" data-action="open-survey"><span>Three quick questions</span><span class="bval">${sv ? "Answered \u2713" : "Not answered"}</span></button>` : "";
  return `<h1>Check-in</h1><p class="sub">Week of ${esc(longDate(w.week_start))} to ${esc(longDate(w.week_end))}</p>
    <p class="note">Open each account, look at the real balance, and type it in. ${done} of ${accts.length} counted.</p>${rows}${questions}
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

function renderSheet() {
  const sh = ui.sheet;
  if (!sh) { $("sheet").innerHTML = ""; return; }
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
      ${d.editable || d.kind === "transfer" ? `<label for="f-amount">Amount (₱)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">` : ""}
      <label for="f-date">Date</label><input id="f-date" data-field="date" type="date" value="${esc(ui.form.date)}">
      <label for="f-payee">Name (optional)</label><input id="f-payee" data-field="payee" value="${esc(ui.form.payee ?? "")}" autocomplete="off">
      ${d.editable ? `<label>Category</label>${chips(expenseCategories(), ui.form.category_id, "pick-cat")}<label>Paid from</label>${chips(accountsFor(null), ui.form.account_id, "pick-acct")}` : ""}
      <p><button class="primary" id="f-save" data-action="save-edit" style="margin-top:14px">Save</button></p>`;
  }
  if (sh.type === "checkin") {
    const a = S().accounts.find((x) => x.id === sh.id);
    body = `<h3>Count ${esc(a.name)}</h3>
      <label for="f-amount">${a.class === "asset" ? "Balance you see now" : "Amount owed you see now"} (\u20B1)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      ${a.class === "liability" ? `<p class="note">Use the posted amount your bank shows. Charges still pending are left alone.</p>` : ""}
      <p id="f-diff" class="note" role="status"></p>
      <p><button class="primary" id="f-save" data-action="save-checkin" disabled>Save count</button></p>`;
  } else if (sh.type === "survey") {
    const w = thisWeek(), auto = M.autoFillSurvey(S(), { unlogged_category_id: M.UNLOGGED_CATEGORY_ID, week_start: w.week_start, week_end: w.week_end });
    body = `<h3>This week</h3>
      <p class="note">Missed transactions: ${auto.q1_missed_count ? auto.q1_missed_count + " (" + peso(auto.q1_missed_amount) + ")" : "none found by your counts"}.</p>
      <label>How easy was logging this week? (1 hard, 5 easy)</label>
      <div class="seg" role="group" aria-label="Ease">${[1, 2, 3, 4, 5].map((n) => `<button data-action="survey-ease" data-id="${n}" aria-pressed="${ui.form.ease === n}">${n}</button>`).join("")}</div>
      <label for="f-annoy">What annoyed you most? (optional)</label><input id="f-annoy" data-field="annoy" value="${esc(ui.form.annoy ?? "")}" autocomplete="off">
      <p><button class="primary" id="f-save" data-action="save-survey" style="margin-top:14px" disabled>Save answers</button></p>`;
  } else if (sh.type === "budget") {
    const c = S().categories.find((x) => x.id === sh.id), thisM = M.monthOf(today()), nextM = M.addMonths(thisM, 1);
    body = `<h3>Budget for ${esc(c.name)}</h3>
      <label for="f-amount">Per month (₱)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      <label>Starts</label>
      <div class="seg" role="group" aria-label="When it starts">${[[thisM, "This month"], [nextM, "Next month"]].map(([m, t]) => `<button data-action="budget-start" data-month="${m}" aria-pressed="${ui.form.start === m}">${t}</button>`).join("")}</div>
      <p class="note">${esc(M.monthLabel(ui.form.start))}. Enter 0 to remove the budget.</p>
      <p><button class="primary" id="f-save" data-action="save-budget" style="margin-top:6px" disabled>Save</button></p>`;
  } else if (sh.type === "icon") {
    const a = S().accounts.find((x) => x.id === sh.id);
    body = `<h3>Picture for ${esc(a.name)}</h3>
      <p class="note">Take a screenshot of the app's icon, choose it here, then zoom and drag until only the icon fills the square.</p>
      <input id="i-file" type="file" accept="image/*" data-field="file" aria-label="Choose a picture">
      <div id="i-stage" class="stage"><img id="i-img" alt="" hidden></div>
      <label for="i-zoom">Zoom</label><input id="i-zoom" data-field="zoom" type="range" min="1" max="4" step="0.01" value="1" disabled>
      <p id="f-msg" role="alert" class="note"></p>
      <p><button class="primary" id="f-save" data-action="save-icon" disabled>Use this picture</button></p>
      ${a.icon ? `<p><button data-action="clear-icon" style="width:100%">Remove the picture</button></p>` : ""}`;
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
  $("sheet").innerHTML = `<div id="scrim" data-action="close-sheet"></div><div class="sheet" role="dialog">${body}<p><button data-action="close-sheet" style="width:100%">Cancel</button></p></div>`;
  refreshSave();
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
    btn.disabled = !f.ease;
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
async function logExpense(input, label) {
  const plan = M.planExpense(S(), { ...input, date: today(), reserve_source_id: ledger.settings.reserve_source_id }, new Date());
  if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); return; }
  const settings = { ...ledger.settings, last_account_id: input.account_id,
    last_account_by_preset: { ...(ledger.settings.last_account_by_preset ?? {}), ...(input.preset_id ? { [input.preset_id]: input.account_id } : {}) } };
  const ok = await commit(M.applyDrafts(S(), plan.drafts), settings);
  showToast((ok ? "Saved " : "Not safely stored: ") + label + " · " + accountName(input.account_id), plan.drafts[0].transaction.id, reserveNote(plan.violations));
}

async function onClick(el) {
  const { action, id, tab } = el.dataset;
  const form = ui.form;
  switch (action) {
    case "open-menu": ui.menu = true; renderMenu(); $("menuBtn")?.setAttribute("aria-expanded", "true"); break;
    case "close-menu": ui.menu = false; renderMenu(); $("menuBtn")?.setAttribute("aria-expanded", "false"); break;
    case "tab": $("toast").innerHTML = ""; ui.menu = false; ui.tab = tab; ui.sheet = null; ui.confirmDelete = null; ui.confirmRemove = null; ui.sel = null; renderAll(); break;
    case "month-step": ui.month = M.addMonths(ui.month ?? M.monthOf(today()), Number(el.dataset.step)); ui.sel = null; renderScreen(); break;
    case "chart-view": ui.view = el.dataset.view; ui.sel = null; renderScreen(); break;
    case "chart-mode": ui.asList = el.dataset.mode === "list"; renderScreen(); break;
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
      ui.sheet = { type: "survey" }; ui.form = { ease: sv?.q2_ease ?? null, annoy: sv?.q3_annoyance ?? "" }; renderSheet(); break;
    }
    case "survey-ease": ui.form.ease = Number(id); renderSheet(); break;
    case "save-survey": {
      const w = thisWeek(), auto = M.autoFillSurvey(S(), { unlogged_category_id: M.UNLOGGED_CATEGORY_ID, week_start: w.week_start, week_end: w.week_end });
      const plan = M.planSurveyResponse(auto, { q2_ease: ui.form.ease, q3_annoyance: ui.form.annoy ?? "" });
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      ui.sheet = null; renderSheet();
      await commit({ ...S(), surveyResponses: [...S().surveyResponses.filter((r) => r.id !== plan.response.id), plan.response] });
      showToast("Answers saved");
      break;
    }
    case "open-icon": ui.sheet = { type: "icon", id }; ui.form = {}; renderSheet(); break;
    case "save-icon": await saveIcon(); break;
    case "clear-icon": {
      const r = M.setAccountIcon(S(), ui.sheet.id, null);
      ui.sheet = null; renderSheet();
      if (r.ok) await commit(r.state);
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
    case "pick-cat": form.category_id = id; renderSheet(); break;
    case "pick-acct": form.account_id = id; renderSheet(); break;
    case "close-sheet": ui.sheet = null; renderSheet(); break;
    case "save-other": {
      const amount = M.parsePesos(form.amount).centavos;
      ui.sheet = null; renderSheet();
      await logExpense({ transaction_id: newId("tx"), payee: "", category_id: form.category_id, amount, account_id: form.account_id, source: "manual" }, categoryName(form.category_id) + " " + peso(amount));
      break;
    }
    case "undo": {
      const r = M.discardDraft(S(), id);
      $("toast").innerHTML = "";
      if (r.ok) await commit(r.state);
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
        ...(d.editable || d.kind === "transfer" ? { amount: (d.amount / 100).toFixed(2) } : {}) };
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
      const r = M.discardDraft(S(), id);
      if (r.ok) await commit(r.state);
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
  const name = f.name.trim();
  if (!name) return fail("Give the account a name.");
  if (S().accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) return fail("You already have an account with that name.");
  const opening = f.opening.trim() === "" ? { ok: true, centavos: 0 } : M.parsePesos(f.opening);
  if (!opening.ok) return fail("Enter the balance like 1250 or 1250.50.");
  const account = { id: newId("acct"), name, class: f.kind, role: "", hidden_by_default: false, archived: false,
    opening_balance: opening.centavos, opening_date: today(), ...(f.kind === "asset" && f.covers ? { reserve_for: f.covers } : {}) };
  const problems = M.validateShape("Account", account);
  if (problems.length) return fail(problems[0].message);
  ui.setupError = null;
  ui.accountForm = { name: "", kind: f.kind, opening: "", covers: "" };
  document.activeElement?.blur();   // close the keyboard so the result is visible
  const ok = await commit({ ...S(), accounts: [...S().accounts, account] });
  window.scrollTo(0, 0);
  showToast((ok ? "Added " : "Not safely stored: ") + name);
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el) onClick(el);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ui.menu) { ui.menu = false; renderMenu(); } });
document.addEventListener("input", (e) => {
  const field = e.target.dataset?.field;
  if (!field) return;
  if (e.target.type === "file") return;   // handled on change
  if (field === "zoom") { zoomTo(Number(e.target.value)); return; }
  if (ui.sheet) { ui.form[field] = e.target.value; refreshSave(); }
  else ui.accountForm[field] = e.target.value;
});
document.addEventListener("change", (e) => {
  if (e.target.type === "file" && ui.sheet) {
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
  const { local, idb } = await readBoth();
  const platform = M.detectPlatform(navigator.userAgent);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const present = (v) => (v === undefined ? null : v !== null && v.length > 0);
  device = M.assessDevice({ platform, standalone, stores: { local: present(local), idb: present(idb) } });
  boot = M.chooseLedger(local ?? null, idb ?? null);
  if (boot.status === "CORRUPT") {
    device = { status: "CORRUPT", allowEntry: false, message: "The saved data on this phone could not be read, so nothing is shown and nothing will be overwritten. Restore from your encrypted backup." };
  } else {
    ledger = boot.ledger;
    if (boot.status === "NONE") ledger.state = { ...ledger.state, categories: M.defaultCategories(), presets: M.defaultPresets() };   // kept in memory until the first save
    // The two stores disagree on revision only (a save reached one and not the other): repair quietly from the newer.
    if (boot.status === "REPAIR" && local != null && idb != null && device.allowEntry) {
      await writeBoth(JSON.stringify(ledger), { local: boot.repairTo === "local", idb: boot.repairTo === "idb" });
    }
  }
  if (!device.allowEntry) ui.tab = "log";
  renderAll();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
start();
