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

let ledger = M.emptyLedger();   // {rev, state, settings}
let device = { status: "OK", message: "", allowEntry: true };
let boot = { status: "NONE", repairTo: null };
const ui = {
  tab: "log", sheet: null, form: {}, error: null, confirmDelete: null, confirmRemove: null, setupError: null,
  accountForm: { name: "", kind: "asset", opening: "", covers: "" },
};
let toastTimer = null;

// ---------- reading helpers ----------
const S = () => ledger.state;
const activeAccounts = () => S().accounts.filter((a) => !a.archived);
const accountName = (id) => S().accounts.find((a) => a.id === id)?.name ?? "?";
const categoryName = (id) => S().categories.find((c) => c.id === id)?.name ?? "?";
const expenseCategories = () => S().categories.filter((c) => c.kind === "expense" && c.id !== M.UNLOGGED_CATEGORY_ID);

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
function renderAll() { renderBanner(); renderScreen(); renderNav(); renderSheet(); }

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
  $("nav").innerHTML = tab("log", "Log") + tab("verify", n ? `Verify (${n})` : "Verify") + tab("setup", "Setup");
}

function renderScreen() {
  if (!device.allowEntry) {
    $("screen").innerHTML = `<h1>Finance</h1><p class="note">Entry is switched off on this device. See the note above.</p>`;
    return;
  }
  $("screen").innerHTML = ui.tab === "verify" ? viewVerify() : ui.tab === "setup" ? viewSetup() : viewLog();
}

function viewLog() {
  if (activeAccounts().length === 0) {
    return `<h1>Log</h1><p class="sub">${esc(longDate(today()))}</p><p class="note">Add the accounts you pay from first.</p>
      <button class="primary" data-action="tab" data-tab="setup">Add accounts</button>`;
  }
  const due = dueDrafts().length;
  const todays = S().transactions.filter((t) => t.date === today() && !isGenerated(t)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const dueNote = due ? `<p class="note"><button class="link" data-action="tab" data-tab="verify">${due} ${due === 1 ? "entry" : "entries"} from before today ${due === 1 ? "needs" : "need"} verifying</button></p>` : "";
  return `<h1>Log</h1><p class="sub">${esc(longDate(today()))}</p>${dueNote}
    <div class="tiles">${S().presets.map((p) => `<button class="tile" data-action="open-preset" data-id="${esc(p.id)}"><b>${esc(p.name)}</b><span>${peso(p.amount)}</span></button>`).join("")}</div>
    <p><button class="primary" data-action="open-other" style="margin-top:12px">Other amount</button></p>
    <h2>Today</h2>${todays.length ? todays.map(rowFor).join("") : `<p class="note">Nothing logged today.</p>`}`;
}

function rowFor(t) {
  const d = describe(t);
  return `<div class="row"><div>${esc(d.title)}<small>${esc(d.detail)}${t.status === "draft" ? " · draft" : " · verified"}</small></div><div class="amt">${peso(d.amount)}</div></div>`;
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
    ? `<dt>Category</dt><dd>${esc(categoryName(d.category_id))}</dd><dt>Paid from</dt><dd>${esc(d.detail)}</dd>`
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
  const rows = S().accounts.map((a) => `<div class="row"><div>${esc(a.name)}<small>${a.class === "asset" ? "money you have" : "money you owe (card)"}${a.reserve_for ? " · covers " + esc(accountName(a.reserve_for)) : ""}</small></div>
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
    ${reserveExists ? `<h2>Card reserve</h2><label for="r-src">Reserve transfers come out of</label><select id="r-src" data-action-change="set-reserve-source"><option value="">Choose an account</option>${hosts.map((a) => `<option value="${esc(a.id)}"${ledger.settings.reserve_source_id === a.id ? " selected" : ""}>${esc(a.name)}</option>`).join("")}</select>` : ""}`;
}

// ---------- sheets ----------
function chips(items, selectedId, action) {
  return `<div class="chips">${items.map((i) => `<button class="chip" data-action="${action}" data-id="${esc(i.id)}" aria-pressed="${i.id === selectedId}">${esc(i.name)}</button>`).join("")}</div>`;
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
  $("sheet").innerHTML = `<div id="scrim" data-action="close-sheet"></div><div class="sheet" role="dialog">${body}<p><button data-action="close-sheet" style="width:100%">Cancel</button></p></div>`;
  refreshSave();
}

function refreshSave() {
  const btn = $("f-save");
  if (!btn || ui.sheet?.type !== "other") return;
  const a = M.parsePesos(ui.form.amount);
  btn.disabled = !(a.ok && a.centavos > 0 && ui.form.category_id && ui.form.account_id);
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
    case "tab": ui.tab = tab; ui.sheet = null; ui.confirmDelete = null; ui.confirmRemove = null; renderAll(); break;
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
document.addEventListener("input", (e) => {
  const field = e.target.dataset?.field;
  if (!field) return;
  if (ui.sheet) { ui.form[field] = e.target.value; refreshSave(); }
  else ui.accountForm[field] = e.target.value;
});
document.addEventListener("change", (e) => {
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
