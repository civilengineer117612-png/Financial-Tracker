// The screens. All money rules live in ../src/model; this file only draws and handles taps.
// Plain and firm, never harsh: facts are stated once, nothing is red, nothing blocks logging.
import * as M from "../src/model/index.js";
import { readBoth, writeBoth, putPhoto, getPhoto, deletePhoto, useTrialStorage, clearTrialStorage, readCopies, writeCopies } from "./store.js";
import { preparePhoto, readPage, evenedCopy } from "./ocr.js";
import { speechSupported, listen, firstLanguage, other } from "./voice.js";

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
// "Name \u00b7 Bucket" for a category: the bucket is read from the name (or chosen by hand), so there is nothing else to set.
// A how-to clip drawn from this phone's own screen: its first three tiles, the account used most recently, today's date and total.
function clipFor(id) {
  const tiles = S().presets.slice(0, 3).map((p) => ({ name: p.name, amount: p.amount, category: categoryName(p.category_id) }));
  const a = cashFirst(activeAccounts())[0] ?? null;
  let budget = null;
  if (id === "budget") {   // this month's budgets, the base income and (with the new Budget on) the bucket totals, as the Budget screen shows them
    const month = M.monthOf(today()), set = ledger.settings, income = M.baseIncome(S(), { plan: planOf(), pin: set.income_base_pin ?? null }).amount ?? 0;
    const cats = expenseCategories().map((c) => ({ c, amount: M.budgetFor(S().rules, c.id, month) ?? 0 }));
    const rows = [...cats.filter((x) => x.amount > 0), ...cats.filter((x) => x.amount === 0)].map((x) => ({ name: x.c.name, amount: x.amount, bucket: M.bucketOf(x.c, set.bucket_overrides ?? {}) }));
    const bk = set.try_new_budget ? M.bucketRows({ categories: S().categories, overrides: set.bucket_overrides ?? {}, targets: set.bucket_targets, income, budgets: Object.fromEntries(cats.map((x) => [x.c.id, x.amount])), skipId: M.UNLOGGED_CATEGORY_ID }).rows.filter((r) => r.bucket !== "other") : null;
    budget = { income, rows, buckets: bk };
  }
  const trips = id === "trips" ? S().tags.map((t) => ({ name: t.name, days: M.tripDays(t), spent: M.tagSummary(S(), t.id, { categoryMaps: S().categoryMaps, asOf: today() }).spent })) : [];
  let goal = null;
  if (id === "goals") {   // the first goal with a target that is not hidden by default (hidden goals are never drawn)
    const shown = (x) => !x.hidden_by_default || ui.reveal;   // a hidden goal is drawn only while "Show balances" is on
    const g = S().goals.find((x) => x.target > 0 && shown(x) && x.role !== "emergency"), p = g ? M.goalProgress(S(), g) : null, ga = g?.account_id ? S().accounts.find((a) => a.id === g.account_id) : null;
    if (g && p) goal = { name: g.name, balance: p.balance, target: g.target, account: ga ? { name: ga.name, picture: iconOf(ga, 20) } : null };
    else {   // no ordinary goal: the emergency fund, whose target is worked out from the plan or the budgets
      const e = S().goals.find((x) => x.role === "emergency" && shown(x)), st = e ? (planOf() ? M.emergencyFundStatus(S(), planOf(), e) : M.emergencyFundFromBudgets(S(), e, { month: M.monthOf(today()) })) : null, ea = e?.account_id ? S().accounts.find((a) => a.id === e.account_id) : null;
      if (e && st?.target > 0) goal = { name: e.name, balance: st.balance, target: st.target, ef: true, months: st.months, account: ea ? { name: ea.name, picture: iconOf(ea, 20) } : null };
    }
  }
  return M.howtoClip(id, { date: longDate(today()), tiles, account: a ? { name: a.name, picture: iconOf(a, 20) } : null, total: M.dayTotal(S(), today()).total, budget, trips, goal });
}
// The reason under a suggested figure. The starter share's long note was the same on every row, so it is said once, in the tips at the bottom; a row
// keeps only what is its own (learned from history, pinned, or lowered to fit the income).
const rowWhy = (x) => (x.source === "starter" && !x.pinned ? (/Lowered by .*$/.exec(x.reason)?.[0] ?? "") : x.reason);
// Your own figures for the tips: this month's budgets against the base income, and the emergency fund in months of its basis.
function tipsYoursNow() {
  const set = ledger.settings, month = M.monthOf(today()), income = M.baseIncome(S(), { plan: planOf(), pin: set.income_base_pin ?? null }).amount ?? 0;
  const budgets = Object.fromEntries(expenseCategories().map((c) => [c.id, M.budgetFor(S().rules, c.id, month) ?? 0]));
  const g = M.goalByRole(S(), "emergency"), e = g ? (planOf() ? M.emergencyFundStatus(S(), planOf(), g) : M.emergencyFundFromBudgets(S(), g, { month })) : null;
  return M.tipsYours({ income, categories: S().categories, overrides: set.bucket_overrides ?? {}, budgets, ef: e ? { balance: e.balance, monthlyBasis: e.monthlyBasis } : null });
}
// Budgeting tips: one block at the bottom, with where each comes from. With little history, the starter shares in use come first.
function tipsBlock(starter) {
  const t = M.starterFromTargets(ledger.settings.bucket_targets, M.SUGGEST_DEFAULTS.starter.buffer), pc = (bps) => bps / 100 + "%";   // the shares the suggestion really uses
  const first = starter ? `<li><b>Starter shares (used until about 2 months are logged):</b> <i>needs ${pc(t.needs)}, wants ${pc(t.wants)}, savings ${pc(t.savings)} and an overrun buffer of ${pc(t.buffer)} of pay; the rent and fixed payments come out of the needs, which are shared by typical weights for each kind.</i></li>` : "";
  const yours = tipsYoursNow();
  return `<div class="tips" id="sug-tips"><h4>Budgeting tips</h4><ul>${first}${M.BUDGET_TIPS.map((x) => `<li><b>${esc(x.rule)}:</b> <i>${esc(x.text)}</i>${yours[x.rule] ? ` <span class="yours">Yours: <b>${esc(yours[x.rule])}</b></span>` : ""} <small>${esc(x.source)}</small></li>`).join("")}</ul><p class="note"><i>${esc(M.TIPS_NOTE)}</i></p></div>`;
}
const catLine = (c) => `${esc(c.name)} \u00b7 ${esc(M.BUCKET_LABELS[M.bucketOf(c, ledger.settings.bucket_overrides ?? {})])}`;
// The four buttons for choosing a bucket by hand; the one in force is pressed.
// What the name says, in the add window: the bucket it reads as, or that it is not clear and will be asked.
const readLine = (name) => { if (!(name ?? "").trim()) return "The bucket is read from the name."; const r = M.readBucket(name).bucket;
  return r ? `Reads as ${M.BUCKET_LABELS[r]}. You can change it later in Setup.` : "Not clear from the name. Choose one now, or it waits in Other and is asked on Budget."; };
const bucketChips = (id, current, action = "pick-bucket") => M.CHOICES.map((b) => `<button class="chip" data-action="${action}" data-id="${esc(id ?? "")}" data-bucket="${b}" aria-pressed="${current === b}">${b === "other" ? "Keep in Other" : b === "need" ? "Need" : b === "want" ? "Want" : "Savings"}</button>`).join(" ");
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
const isCash = (a) => a.bank === "cash" || /^cash\b/i.test(a.name);
const cashFirst = (list) => [...list.filter(isCash), ...list.filter((a) => !isCash(a))];   // Cash sits at the top of every account list
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
  if (ui.upgrade?.failed) return false;   // the update of the saved data failed: nothing is written until the owner restores the copy or updates the app, so old data is never overwritten
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
// A progress ring with the percent in the middle. The figures beside it say the same in words (its list twin).
const ring = (pct, label) => `<svg class="ring" viewBox="0 0 44 44" role="img" aria-label="${esc(label)}"><circle class="rt" cx="22" cy="22" r="18"/><circle class="rf" cx="22" cy="22" r="18" stroke-dasharray="${(Math.max(0, Math.min(100, pct)) / 100 * 113.1).toFixed(1)} 113.1" transform="rotate(-90 22 22)"/><text x="22" y="26.5" text-anchor="middle">${Math.round(pct)}%</text></svg>`;
// A long explanation stays out of sight until asked for. The words are the same; they are just folded under "Why?".
const why = (html, label = "Why?") => `<details class="why"><summary>${label}</summary><p class="note">${html}</p></details>`;
const ICONS = {
  cards: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  money: '<path d="M3 3v16a2 2 0 0 0 2 2h16M18 17V9M13 17V5M8 17v-3"/>',
  budget: '<path d="M21 12c.55 0 1-.45.95-1a10 10 0 0 0-8.95-8.95c-.55-.05-1 .4-1 .95v8a1 1 0 0 0 1 1z"/><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/>',
  goals: '<path d="M5 21V4M5 4h12l-2.5 4 2.5 4H5"/>',
  plan: '<path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/>',
  checks: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  trips: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  income: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/>',
  buffer: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  checkin: '<path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
  setup: '<path d="M10 5H3M12 19H3M14 3v4M16 17v4M21 12h-9M21 19h-5M21 5h-7M8 10v4M8 12H3"/>',
};
const MENU = M.MENU_GROUPS.map(([group, ids]) => [group, ids.map((id) => [id, M.SCREEN_NAMES[id]])]);   // names come from src/model/names.js; Setup and Help are pinned at the bottom

// On the Cash flow screens the title itself is the switch: tap "Spending" to go to Income and back.
const SWAP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"/></svg>';
function titleOf(title) {
  if (ui.tab !== "money" && ui.tab !== "income") return `<h1>${esc(title)}</h1>`;
  const other = ui.tab === "money" ? ["income", "Income"] : ["money", "Spending"];
  return `<button class="titleswitch" data-action="tab" data-tab="${other[0]}" aria-label="${esc(title)}. Tap to switch to ${other[1]}"><span class="tt">${esc(title)}</span>${SWAP}</button>`;
}

function renderTop(title) {
  const hub = M.hubOf(ui.tab) && device.allowEntry && M.HUBS[M.hubOf(ui.tab)].filter((id) => !M.menuHidden(ledger.settings).has(id)).length > 1;
  const lines = `<svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true"><rect y="0" width="24" height="2.5" rx="1.25" fill="currentColor"/><rect y="6.75" width="17" height="2.5" rx="1.25" fill="currentColor"/><rect y="13.5" width="10" height="2.5" rx="1.25" fill="currentColor"/></svg>`;   // lines of falling length, no box
  // One scanner button: it opens the two choices, camera or photos/files.
  const camera = device.allowEntry && ui.tab === "log" ? `<button class="camicon" data-action="open-scan-pick" data-howto="scan" aria-label="Scan a receipt or payment screen: take a photo or choose from photos or files"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.scan}</svg></button>` : "";
  const mic = device.allowEntry && ui.tab === "log" ? `<button class="camicon micbtn" data-action="open-voice" aria-label="Say an entry out loud"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.mic}</svg></button>` : "";
  $("top").innerHTML = (device.allowEntry ? `<button class="menubtn" id="menuBtn" data-action="open-menu" aria-label="Menu" aria-expanded="${ui.menu}">${lines}</button>` : "") + (hub ? `<h1 class="sr">${esc(title)}</h1>` : titleOf(title)) + mic + camera;
}

let menuTimer = null;
function renderMenu() {
  const el = $("menu"), reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!ui.menu || !device.allowEntry) {
    // closing slides the panel away first, then removes it; a reopen during that slide cancels it
    if (el.firstChild && !el.classList.contains("leaving") && !reduced) {
      el.classList.add("leaving"); clearTimeout(menuTimer);
      menuTimer = setTimeout(() => { if (!ui.menu) el.innerHTML = ""; el.classList.remove("leaving"); }, 200);
    } else if (!el.classList.contains("leaving")) el.innerHTML = "";
    return;
  }
  const opening = !el.firstChild || el.classList.contains("leaving");
  clearTimeout(menuTimer); el.classList.remove("leaving");
  const current = (id) => ui.tab === id || M.hubOf(ui.tab) === id || (id === "money" && ui.tab === "income");   // a hub row stays marked on every screen it holds; Cash flow holds Spending and Income
  const item = (id, label) => `<button class="item" data-action="tab" data-tab="${id}" data-howto="${id}"${current(id) ? ' aria-current="page"' : ""}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg><span>${label}</span></button>`;
  const hidden = M.menuHidden(ledger.settings);   // the new Budget holds the pay plan, so its menu entry is not shown
  el.innerHTML = `<div class="scrim${opening ? " enter" : ""}" data-action="close-menu"></div><aside class="drawer${opening ? " enter" : ""}" role="dialog" aria-label="Menu">
    <div class="groups">${MENU.map(([group, items]) => `<p class="glabel">${group}</p>${items.filter(([id]) => !hidden.has(id) && M.menuRows([id]).length).map(([id, label]) => item(id, label)).join("")}`).join("")}</div>
    <div class="foot">${item("help", M.SCREEN_NAMES.help)}${item("setup", M.SCREEN_NAMES.setup)}</div></aside>`;
}

function renderBanner() {
  const bars = [];
  if (ui.error) bars.push(`<div class="bar" role="alert">${esc(ui.error)}</div>`);
  if (ui.upgrade?.failed) bars.push(`<div class="bar" role="alert">${esc(ui.upgrade.failed)}</div>`);
  const showDevice = device.status === "TRIAL" || (device.status !== "OK" && device.status !== "EMPTY");   // an empty phone is explained on Log, next to its Restore button
  if (showDevice) {
    const repair = device.status === "PARTIAL_LOSS" && boot.ledger ? `<p><button data-action="repair">Copy the surviving data into the empty store</button></p>` : "";
    const trial = device.status === "TRIAL" ? `<p><button data-action="reset-trial">${ui.confirmTrial ? "Tap again to erase the trial copy" : "Start the trial over"}</button></p>` : "";
    bars.push(`<div class="bar" role="status">${esc(device.message)}${repair}${trial}</div>`);
  }
  $("banner").innerHTML = bars.join("");
}

function renderNav() {
  const n = device.allowEntry ? dueDrafts().length : 0;
  const pic = { log: '<path d="M7 17 17 7M8 7h9v9"/>', verify: '<path d="M20 6 9 17l-5-5"/>' };   // out and a tick
  const tab = (id, label) => `<button data-action="tab" data-tab="${id}" data-howto="${id}"${ui.tab === id ? ' aria-current="page"' : ""}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pic[id]}</svg>${label}</button>`;   // hold for its how-to
  $("nav").innerHTML = tab("log", M.SCREEN_NAMES.log) + tab("verify", n ? `${M.SCREEN_NAMES.verify} (${n})` : M.SCREEN_NAMES.verify);   // photo and audio will join these two
}

// The picture strip at the top of a hub's screens: one tap moves between screens that belong together (see HUBS in names.js).
function hubStrip() {
  const h = M.hubOf(ui.tab); if (!h || !device.allowEntry) return "";
  const hidden = M.menuHidden(ledger.settings), ids = M.HUBS[h].filter((id) => !hidden.has(id));
  if (ids.length < 2) return "";
  const on = (id) => ui.tab === id;
  return `<nav class="hub" aria-label="Screens here">${ids.map((id) => `<button data-action="tab" data-tab="${id}" data-howto="${id}"${on(id) ? ' aria-current="page"' : ""}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg><span>${esc(M.STRIP_NAMES[id])}</span></button>`).join("")}</nav>`;
}

let lastTabSig = null, lastViewSig = null, swapTimer = null;
function renderScreen() {
  if (ui.tab !== "log") ui.arrange = false;
  // Each view starts with its own <h1>; it is moved up into the bar beside the menu button.
  const html = !device.allowEntry ? `<h1>Finance</h1><p class="note">Entry is switched off on this device. See the note above.</p>`
    : ui.tab === "verify" ? viewVerify() : ui.tab === "setup" ? viewSetup() : ui.tab === "help" ? viewHelp() : ui.tab === "money" ? viewMoney() : ui.tab === "cards" ? viewCards() : ui.tab === "budget" ? viewBudget() : ui.tab === "checkin" ? viewCheckin() : ui.tab === "goals" ? viewGoals() : ui.tab === "plan" ? viewPlan() : ui.tab === "checks" ? viewChecks() : ui.tab === "trips" ? viewTrips() : ui.tab === "buffer" ? viewBuffer() : ui.tab === "scan" ? viewScan() : ui.tab === "income" ? viewIncome() : viewLog();
  const m = /^<h1>([^<]*)<\/h1>/.exec(html);
  renderTop(m ? m[1] : "Finance");
  const scr0 = $("screen"), sameTab = ui.tab === lastTabSig, oldBar = scr0.querySelector(".modebar, .viewmark"), barWas = oldBar?.getBoundingClientRect().top, bodyWas = scr0.querySelector(".viewbody")?.offsetHeight ?? 0;
  $("screen").innerHTML = hubStrip() + (m ? html.slice(m[0].length) : html);
  // Changing screen fades the whole screen in; changing the view (category, budget...) or chart/list fades in ONLY what is under the view
  // buttons, so the top (month, total, buttons) stays perfectly still. Fade only, nothing slides.
  const tabSig = ui.tab, viewSig = [ui.view, ui.asList, ui.period?.kind, ui.incomeView, ui.budgetView].join(), scr = $("screen");
  const bar = scr.querySelector(".modebar, .viewmark");
  let body = null;
  if (bar) { body = document.createElement("div"); body.className = "viewbody"; while (bar.nextSibling) body.appendChild(bar.nextSibling); scr.appendChild(body); }
  // Switching view or period on the same screen keeps the view buttons exactly where they were on the glass: the part below keeps at least its old
  // height (so the page cannot shrink and jump), and any difference above the buttons is scrolled away.
  if (sameTab && body && barWas !== undefined) {
    body.style.minHeight = bodyWas + "px";
    const dy = scr.querySelector(".modebar, .viewmark").getBoundingClientRect().top - barWas;
    if (Math.abs(dy) > 0.5) window.scrollBy(0, dy);
  }
  if (tabSig !== lastTabSig) { scr.classList.remove("swap"); void scr.offsetWidth; scr.classList.add("swap"); clearTimeout(swapTimer); swapTimer = setTimeout(() => scr.classList.remove("swap"), 220); }
  else if (body && viewSig !== lastViewSig) { body.classList.add("fade"); }
  lastTabSig = tabSig; lastViewSig = viewSig;
  hydratePhotos();
}

// The big number on the Log screen is the total for the day being looked at: today, or the day picked with "Select date".
// "Today" returns to today. The date box is the phone's own picker, hidden under the link so nothing crowds the screen.
function dayCard() {
  const picked = ui.dayPick && ui.dayPick !== today() ? ui.dayPick : null;
  const d = M.dayTotal(S(), picked ?? today());
  const words = (picked ? longDate(picked) : "Today") + " " + peso(d.total) + (d.drafts ? ", including " + d.drafts + " not yet verified" : "");
  // One quiet link at a time: "Select date" on today; on another day the date itself (tap it to pick another) and a single "Today".
  return `<div class="daytotal" role="status" aria-label="${esc(words)}">${peso(d.total)}</div><p class="center daylabel" aria-hidden="true">${picked ? "spent that day" : "spent today"}</p>
    ${picked ? `<p class="center daycap"><button class="daycapbtn datelink" data-action="open-cal" aria-label="${esc(longDate(picked))}, tap to choose another day">${esc(longDate(picked))}</button></p>
    <p class="note center small">New entries go on this day.</p>
    <p class="center"><button class="link" data-action="reset-day">Today</button></p>`
    : `<p class="center"><button class="link datelink" data-action="open-cal">Select date</button></p>`}`;
}

// This month at a glance on Log: verified spending against the month's budgets, one bar, the figure at its tip. Tap it for Budget.
function monthGlance() {
  const month = M.monthOf(today()), spent = Math.max(0, M.spendingByCategory(S(), { month }).total);
  const budget = expenseCategories().filter((c) => c.id !== M.UNLOGGED_CATEGORY_ID).reduce((n, c) => n + (M.budgetFor(S().rules, c.id, month) ?? 0), 0);
  const t = budget > 0 ? M.tenths(spent, budget) : null, w = t === null ? 0 : Math.min(100, t / 10);
  const words = budget > 0 ? (spent > budget ? `Over the month's budget by ${peso(spent - budget)}` : `${peso(budget - spent)} left of ${peso(budget)}`) : "No budget set yet";
  return `<button class="glance" id="glance" data-action="tab" data-tab="budget" aria-label="This month: ${esc(peso(spent))} spent. ${esc(words)}. Tap for Budget.">
    <span class="gl-top"><span>This month</span><b>${peso(spent)}</b></span>
    ${budget > 0 ? `<span class="meter goal"><span class="fill" style="width:${w}%"></span></span>` : ""}
    <span class="gl-sub">${esc(words)}</span></button>`;
}

// The day's entries stay out of sight until you tap the heading (less on the screen, nothing to scroll past). The choice is kept until the app is closed.
const logOpen = () => { try { return sessionStorage.getItem("logOpen") === "1"; } catch { return false; } };
function entriesBlock(list, label) {
  const anim = ui.entriesAnim; ui.entriesAnim = false;   // only the tap itself animates, not every redraw
  const open = logOpen();
  return `<button class="entrieshead" id="entries-toggle" data-action="toggle-entries" aria-expanded="${open}" aria-controls="entries-list"><span>${list.length} ${list.length === 1 ? "entry" : "entries"}</span><span class="eh-r"><svg class="chev${open ? " up" : ""}${anim ? " flip" : ""}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span></button>
    <div id="entries-list"${open ? "" : " hidden"}${anim && open ? ' class="drop"' : ""}>${list.map(rowFor).join("")}</div>`;
}

function viewLog() {
  if (activeAccounts().length === 0) {
    const empty = device.status === "EMPTY" ? `<div class="card" id="first-run"><p>${esc(device.message)}</p><p><button data-action="open-restore" style="width:100%">Restore from a backup</button></p></div>` : "";
    return `<h1>Log</h1><p class="sub">${esc(longDate(today()))}</p>${empty}<p class="note">Add the accounts you pay from first.</p>
      <button class="primary" data-action="tab" data-tab="setup">Add accounts</button>
      <p class="note">New here? <button class="link" data-action="tab" data-tab="help">Read the quick notes first</button>.</p>`;
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
  return `<h1>Log</h1>${ui.dayPick && ui.dayPick !== today() ? "" : `<p class="sub">${esc(longDate(today()))}</p>`}${photoNote}${dueNote}${backupNote}${tripNote}
    ${dayCard()}
    ${tilesHtml()}
    <p><button class="primary compact" data-action="open-other">Add expense</button></p>
    ${monthGlance()}
    ${todays.length ? entriesBlock(todays, shown === today() ? "Today" : longDate(shown)) : `<h2 class="today">${shown === today() ? "Today" : esc(longDate(shown))}</h2><p class="note">Nothing logged ${shown === today() ? "today" : "that day"}.</p>`}`;
}

// The quick tiles. Tap one to log it. Hold one to arrange: drag to move, tap to change, "+" to add, Done to finish.
const TRASH = '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>';
function tilesHtml() {
  const tile = (p, arranging) => `<${arranging ? "div" : "button"} class="tile" data-action="${arranging ? "edit-tile" : "open-preset"}" data-id="${esc(p.id)}"${arranging ? ' role="button" tabindex="0"' : ""}><b>${esc(p.name)}</b><span>${peso(p.amount)}</span><i class="tcat">${esc(categoryName(p.category_id))}</i>${arranging ? `<button class="tminus" data-action="remove-tile-now" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">\u2212</button>` : ""}</${arranging ? "div" : "button"}>`;
  if (!ui.arrange && !S().presets.length) return `<p class="note center">No quick tiles. <button class="link" data-action="arrange-start">Add one</button></p>`;
  if (!ui.arrange) {
    const hint = ledger.settings.tile_hint_done ? "" : `<p class="note small center">Hold a tile to move, change or remove it.</p>`;
    return `<div class="tiles">${S().presets.map((p) => tile(p, false)).join("")}</div>${hint}`;
  }
  const add = S().presets.length < M.MAX_PRESETS ? `<div class="tile addtile" data-action="add-tile" data-howto="log" role="button" tabindex="0" aria-label="Add a tile"><b>+</b></div>` : "";
  return `<div class="tiles arranging">${S().presets.map((p) => tile(p, true)).join("")}${add}</div><p class="center"><button class="link" data-action="arrange-done">Done</button></p>`;
}

// Money going out is shown with a minus, money coming in with a plus; a move between your own accounts has neither.
const signed = (d) => (d.kind === "income" ? "+" : d.kind === "expense" || d.kind === "split" ? "\u2212" : "") + peso(d.amount);
function rowFor(t) {
  const d = describe(t);
  const acct = d.kind === "expense" ? S().accounts.find((a) => a.id === d.account_id) : null;
  return `<button class="row rowbtn" data-action="open-tx" data-id="${esc(t.id)}" aria-label="Details of ${esc(d.title)}, ${d.kind === "income" ? "money in " : d.kind === "expense" || d.kind === "split" ? "money out " : ""}${peso(d.amount)}"><div>${esc(d.title)}<small class="who" style="gap:6px">${acct ? iconOf(acct, 16) : ""}<span>${esc(d.detail)}${t.status === "draft" ? " · draft" : " · verified"}</span></small></div><div class="amt${d.kind === "income" ? " in" : ""}">${signed(d)}</div></button>`;
}

// Everything waiting, oldest first. Nothing has to wait for tomorrow: verify whenever you have the time.
// Only entries from BEFORE today count as "due" (the tab badge and the note on the Log page).
const allDrafts = () => M.pendingDrafts(S(), today()).filter((t) => !isGenerated(t));

function viewVerify() {
  const list = allDrafts();
  const due = dueDrafts().length, fresh = list.length - due;
  const parts = list.length ? [`${list.length} to check`, due ? `${due} from before today` : "ready whenever you are"] : [];
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
  return `${head}
    <div class="card">${shot ? `<button class="shotbtn" data-action="open-photo" data-id="${esc(shot.id)}" aria-label="Open the photo full size"><img class="shot" data-photo="${esc(shot.id)}" alt="The photo this entry was read from" hidden></button>` : ""}${fromPhoto}<div class="what">${esc(d.title)}</div><div class="big">${peso(d.amount)}</div>
      <dl><dt>Date</dt><dd>${esc(longDate(t.date))}</dd>${fields}${reserve}</dl>
      <div class="actions">
        <button class="primary wide" data-action="verify-ok" data-id="${esc(t.id)}">Correct</button>
        <button data-action="verify-edit" data-id="${esc(t.id)}">Edit</button>
        <button data-action="verify-delete" data-id="${esc(t.id)}">${del ? "Tap again to delete" : "Delete"}</button>
      </div></div>`;
}

// ---------- Income: where every peso of pay comes from ----------
// Payslips whose pay PERIOD falls in the range (a payslip for June 16-30 received on July 2 is June's), newest period first.
const slipsIn = (range) => (S().payslips ?? []).filter((p) => M.slipDate(p) >= range.from && M.slipDate(p) <= range.to)
  .sort((a, b) => (M.slipDate(a) < M.slipDate(b) ? 1 : M.slipDate(a) > M.slipDate(b) ? -1 : a.pay_date < b.pay_date ? 1 : -1));
const flagLine = (f) => `<p class="note flag">▲ ${esc(f.message)}</p>`;   // a triangle plus words, never colour alone
function stackedPaydays(rows) {   // base and overtime stacked, one ramp of one blue, with a legend and the values written
  const max = Math.max(...rows.map((r) => r.net), 1);
  return `<p class="legend"><span class="key"></span> Regular pay <span class="key ot"></span> Overtime</p><div class="bars">${rows.map((r) => `<div class="brow"><span class="btop"><span class="bname">${esc(longDate(r.date))}</span><span class="bval">${peso(r.net)}</span></span>
    <span class="btrack stack"><span class="bfill" style="width:${Math.max(1, Math.round((r.base * 100) / max))}%"></span>${r.overtime ? `<span class="bfill ot" style="width:${Math.max(1, Math.round((r.overtime * 100) / max))}%"></span>` : ""}</span></div>`).join("")}</div>`;
}
// The payslips of a year, each with its photo link, the four checks and the overtime options. They open in their own window from the
// Income screen, so the screen itself stays short.
// "Jun 16-30, 2026" for a payslip's period.
const periodText = (p) => {
  const f = new Date(p.period_from + "T00:00:00Z"), t = new Date(p.period_to + "T00:00:00Z"), m = (d) => d.toLocaleDateString("en-PH", { month: "short", timeZone: "UTC" });
  return f.getUTCMonth() === t.getUTCMonth() && f.getUTCFullYear() === t.getUTCFullYear() ? `${m(f)} ${f.getUTCDate()}\u2013${t.getUTCDate()}, ${t.getUTCFullYear()}` : `${fullDate(p.period_from)} \u2013 ${fullDate(p.period_to)}`;
};
// "Earlier figures": what the payslip held before each change, newest first, with the day it was changed.
function earlierFigures(p) {
  const revs = M.revisionChanges(S(), p.id);
  if (!revs.length) return "";
  return `<details class="earlier"><summary>Earlier figures</summary>${revs.map(({ revision: r, changes }) => { const t = M.payslipTotals(r.lines);
    return `<p class="note small">Changed ${esc(fullDate(r.changed_on))}. It was: ${esc(r.employer)} · ${esc(periodText(r))} · paid ${esc(fullDate(r.pay_date))} · gross ${peso(t.gross)} · deductions ${peso(t.deductions)} · net ${peso(r.deposit)}</p>${changes.map((c) => `<p class="note small">– ${esc(c)}</p>`).join("")}`; }).join("")}</details>`;
}
// "Apr 16\u201330" for a pay period that has no payslip (the year only when it is not this year).
const gapText = (g) => periodText({ period_from: g.from, period_to: g.to }).replace(new RegExp(", " + today().slice(0, 4) + "$"), "");
function payslipRows(range) {
  const slips = slipsIn(range);
  if (!slips.length) return `<p class="note">No payslips in this period.</p>`;
  const gaps = M.missingPayPeriods(S(), range, today()).map((g) => `<p class="note small">${esc(gapText(g))}: no payslip.</p>`).join("");
  return `${gaps}${slips.map((p) => {
    const lines = M.linesOf(S(), p.id), flags = M.payslipChecks(p, lines), t = M.payslipTotals(lines);
    const shot = M.attachmentsFor(S(), p.transaction_id)[0];
    const draft = S().transactions.some((x) => x.id === "ot-" + p.id), freeDone = S().transactions.some((x) => x.id === "otf-" + p.id);
    return `<div class="row"><div>${esc(p.employer)}<small>${esc(periodText(p))} · paid ${esc(fullDate(p.pay_date))} · gross ${peso(t.gross)} · deductions ${peso(t.deductions)}</small></div><div class="amt">${peso(p.deposit)}</div></div>${shot ? `<p class="note"><button class="link" data-action="open-photo" data-id="${esc(shot.id)}">View the photo</button></p>` : ""}${flags.map(flagLine).join("")}${M.payslipNotes(S(), p).map((n) => `<p class="note small">${esc(n)}${!(p.version >= M.PAYSLIP_VERSION) && n.startsWith("Saved before") ? ` <button class="link" data-action="check-slip" data-id="${esc(p.id)}">Mark as checked</button>` : ""}</p>`).join("")}${earlierFigures(p)}${t.overtime > 0 && !draft ? `<p class="note"><button class="link" data-action="ot-draft" data-id="${esc(p.id)}">Make the Emergency Fund draft for the overtime</button></p>` : ""}${t.overtime > 0 && !freeDone ? `<p class="note">The free ${peso(t.overtime - Math.round((t.overtime * M.OVERTIME_SHARE.num) / M.OVERTIME_SHARE.den))} of the overtime stays in the account the pay landed in. <button class="link" data-action="open-otfree" data-id="${esc(p.id)}">Move it somewhere else</button></p>` : ""}${ui.confirmDelSlip === p.id ? `<p class="note">Remove this payslip and the pay it recorded? <button class="link" data-action="del-slip-yes" data-id="${esc(p.id)}">Yes, remove it</button></p>` : `<p class="note"><button class="link" data-action="edit-slip" data-id="${esc(p.id)}">Change this payslip</button> · <button class="link" data-action="del-slip" data-id="${esc(p.id)}">Remove this payslip</button></p>`}`;
  }).join("")}`;
}

function viewIncome() {
  const per = period(), [from, to] = periodBounds(per), range = { from, to }, label = periodLabel(per);   // the same period as Spending: a month, a year or a range
  const ytdLabel = per.kind === "month" ? "This month" : per.kind === "year" ? (per.year === Number(today().slice(0, 4)) ? "Year to date" : "Whole year") : "Total";
  const y = M.incomeMonths(S(), range), rows = y.months.filter((m) => m.total !== 0);
  const slips = slipsIn(range), loose = M.incomeWithoutPayslip(S(), range);
  const step = periodStepper(per);
  const IVIEWS = [["overview", "Overview"], ["earnings", "Earnings"], ["deductions", "Deductions"]], view = IVIEWS.some(([v]) => v === ui.incomeView) ? ui.incomeView : "overview";
  const earned = per.kind === "range" ? "earned from " + fullDate(per.from) + " to " + fullDate(per.to) : "earned in " + label;
  const head = `<h1>Income</h1>${step}<div class="hero">${peso(y.ytd.total)}</div><p class="sub">${esc(earned)}</p>
    <p><button class="primary compact" data-action="open-payslip-choice">Add income</button></p>
    <button class="choice" data-action="open-payslips"><span>Payslips</span><span class="bval">${slips.length}${loose.length ? " + " + loose.length + " without one" : ""} \u203A</span></button>
    <div class="seg" role="group" aria-label="What to show">${IVIEWS.map(([v, t]) => `<button data-action="income-view" data-view="${v}" aria-pressed="${view === v}">${t}</button>`).join("")}</div><div class="viewmark"></div>`;
  if (!rows.length && !slips.length && !loose.length) return head + `<p class="note">Nothing recorded for ${esc(label)} yet. Add a payslip to see where your income comes from, your raises, and what went to government.</p>`;
  const bd = y.ytd.breakdown;
  // One block per month, open at once: what arrived at the top, then each kind of earning (basic salary, rice subsidy, each allowance, overtime),
  // other income, anything the payslip lines do not explain, the gross, and the deductions, so the lines always add up to the month.
  const minus = (c) => "\u2212" + peso(c);
  const mline = (label, value) => `<div class="mrow mline"><span class="mn">${esc(label)}</span><span class="mv">${value}</span></div>`;   // a plain line: the name at the left, the amount at the right
  const parts = (m) => {
    const b = m.breakdown;
    return [...b.lines.map((l) => [l.label, peso(l.amount)]), ...(b.other ? [["Other income", peso(b.other)]] : []),
      ...(b.unmatched ? [["Not from the payslip lines", (b.unmatched < 0 ? "\u2212" : "") + peso(Math.abs(b.unmatched))]] : []),
      ...(b.deductions ? [["Gross", peso(b.earned), "sub"], ["Deductions", minus(b.deductions)]] : [])];
  };
  // The sum for the whole range is added only when there is more than one month (one month is already its own sum).
  const monthTable = `<div class="mlist">${rows.map((m) => `<details class="mrow" open><summary><span class="mn">${esc(MONTH3[Number(m.month.slice(5)) - 1])}</span><b class="mv">${peso(m.total)}</b><span class="tchev" aria-hidden="true">\u203A</span></summary>${parts(m).map(([t, v, c]) => `<div class="mpart${c ? " " + c : ""}"><span>${esc(t)}</span><span>${v}</span></div>`).join("")}</details>`).join("")}
    ${rows.length > 1 ? `<div class="mrow mtotal"><span class="mn">Net, ${esc(ytdLabel.toLowerCase())}</span><b class="mv">${peso(y.ytd.total)}</b></div>` : ""}</div>`;
  const pd = M.netPerPayday(S(), range);
  const paydays = pd.length ? `<h2>Net pay per payday</h2>${stackedPaydays(pd)}<table class="tbl"><tr><th>Payday</th><th class="n">Regular</th><th class="n">Overtime</th><th class="n">Net</th></tr>${pd.map((r) => `<tr><td>${esc(longDate(r.date))}<small> ${esc(r.employer)}</small></td><td class="n">${peso(r.base)}</td><td class="n">${peso(r.overtime)}</td><td class="n">${peso(r.net)}</td></tr>`).join("")}</table>` : "";
  const dd = M.deductionsByMonth(S(), range);
  // One line per month with ALL its deductions added up; tap a month for each kind (only the kinds that have an amount).
  const DEDNAME = Object.fromEntries(M.DEDUCTIONS.map(([k, t]) => [k, t]));
  const dedParts = (m) => Object.keys(DEDNAME).map((k) => [DEDNAME[k], m[k]]).filter(([, v]) => v);
  const dedTable = dd.months.length ? `<h2>Deductions</h2><div class="mlist">${dd.months.map((m) => `<details class="mrow" open><summary><span class="mn">${esc(MONTH3[Number(m.month.slice(5)) - 1])}</span><b class="mv">${peso(m.total)}</b><span class="tchev" aria-hidden="true">\u203A</span></summary>${dedParts(m).map(([t, v]) => `<div class="mpart"><span>${esc(t)}</span><span>${peso(v)}</span></div>`).join("")}</details>`).join("")}
    ${dd.months.length > 1 ? `<div class="mrow mtotal"><span class="mn">Total deductions</span><b class="mv">${peso(dd.ytd.total)}</b></div>` : ""}</div>
    <p class="note">Went to government in this period: ${peso(dd.ytd.government)}. Lost to absences and lates: ${peso(dd.ytd.lost)}.${dd.ytd.loan ? " Loans: " + peso(dd.ytd.loan) + "." : ""}</p>` : "";
  const plan = from <= today() && today() <= to ? planOf() : null;   // the plan in force speaks only of the present
  const ivar = (v) => v === 0 ? "As planned" : (v > 0 ? "+" : "−") + peso(Math.abs(v)) + (v > 0 ? " more" : " less");
  const pv = plan ? [M.planIncome(S(), plan, today())].map((v) => `<h2>Plan against what arrived</h2><table class="tbl"><tr><th>Payday</th><th class="n">Plan</th><th class="n">Received</th><th class="n">Difference</th></tr><tr><td>${esc(v.label)}<small> ${esc(longDate(v.period.start))}</small></td><td class="n">${peso(v.planned)}</td><td class="n">${peso(v.actual)}</td><td class="n">${esc(ivar(v.variance))}</td></tr></table><p class="note">The plan is never edited; the difference is only shown.</p>`)[0] : "";
  const bodies = {
    overview: `<h2>Gross, deductions and net, ${esc(label)}</h2><div class="mlist">${mline("Gross", peso(bd.earned))}${mline("Deductions", (bd.deductions ? "\u2212" : "") + peso(bd.deductions))}<div class="mrow mtotal"><span class="mn">Net</span><b class="mv">${peso(y.ytd.total)}</b></div></div>${loose.length ? `<p class="note">${peso(loose.reduce((n, r) => n + r.amount, 0))} of this was added without a payslip (${loose.length} ${loose.length === 1 ? "entry" : "entries"}). <button class="link" data-action="open-payslips">See them</button></p>` : ""}${pv}`,
    earnings: `<h2>Earnings by month</h2>${monthTable}${paydays}`,
    deductions: dedTable || `<p class="note">No deductions in this period.</p>`,
  };
  return `${head}${bodies[view]}`;
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
  const f = { ...d, account_id: null, employer, text, notes: ["Read from the photo, the employer too. Check each figure against the paper.", ...r.notes.filter((n) => /could not|total deductions/i.test(n)), ...(r.earnings.length || r.deductions.length ? [] : ["I could not read any lines. Type them from the photo."])] };
  // A date the reader could not find is left EMPTY, not filled with today: a payslip must never land in the wrong month by default.
  f.period_from = r.period_from ?? ""; f.period_to = r.period_to ?? ""; f.pay_date = r.pay_date ?? "";
  if (!r.period_from && r.pay_date) f.notes = [...f.notes, "I could not find the pay period. Choose the dates."];
  f.ot_month = f.pay_date ? M.addMonths(M.monthOf(f.pay_date), -1) : d.ot_month;
  for (const l of r.earnings) f["e_" + l.kind] = two(l.amount);
  for (const l of r.deductions) f["d_" + l.kind] = two(l.amount);
  if (r.printed_gross) f.gross = two(r.printed_gross);
  if (r.printed_net) { f.net = two(r.printed_net); f.deposit = f.net; }
  if (r.printed_deductions) f.ded = two(r.printed_deductions);
  ui.linesOpen = true;   // a photo's figures are unconfirmed: they stay in view to be checked against the paper
  if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.url);
  pendingPhoto = { blob, url: URL.createObjectURL(blob) };
  ui.pdet = {}; ui.form = f; ui.sheet = { type: "payslip", scanBlob: blob, queueId }; renderSheet();
}

// The photo full screen over the window, so it can be compared with the figures. Zoom: pinch with two fingers (or double-tap, or the mouse
// wheel); drag to move when zoomed in. Tap the dark background around the photo to close: the window underneath is exactly as it was
// (nothing typed is lost). Escape also closes it.
function viewShot(url) {
  const box = document.createElement("div");
  box.className = "lightbox"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Photo. Tap outside the photo to close.");
  box.innerHTML = `<button class="sronly lbclose" aria-label="Close the photo">Close</button>
    <div class="lbstage"><img alt="The photo, full size" src="${esc(url)}" draggable="false"></div><p class="note small lbhint">Pinch or double-tap to zoom. Tap outside the photo to close.</p>`;
  const stage = box.querySelector(".lbstage"), img = stage.querySelector("img");
  let k = 1, tx = 0, ty = 0;
  const MAX = 8;
  const apply = () => {   // keep the picture from being dragged off the screen
    k = Math.min(MAX, Math.max(1, k));
    const r = stage.getBoundingClientRect(), mx = ((k - 1) * r.width) / 2, my = ((k - 1) * r.height) / 2;
    tx = Math.min(mx, Math.max(-mx, tx)); ty = Math.min(my, Math.max(-my, ty));
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`; img.dataset.scale = k.toFixed(2);
  };
  const zoomAt = (nk, px, py) => {   // px, py: the point to keep still, from the middle of the stage
    nk = Math.min(MAX, Math.max(1, nk)); const f = nk / k;
    tx = px - (px - tx) * f; ty = py - (py - ty) * f; k = nk; apply();
  };
  const mid = (cx, cy) => { const r = stage.getBoundingClientRect(); return [cx - r.left - r.width / 2, cy - r.top - r.height / 2]; };
  // Is this point on the picture itself (as drawn, zoom and move included) or on the dark around it?
  const onPicture = (cx, cy) => {
    const r = stage.getBoundingClientRect(), nw = img.naturalWidth || r.width, nh = img.naturalHeight || r.height;
    const fit = Math.min(r.width / nw, r.height / nh), w = nw * fit * k, h = nh * fit * k;
    const [px, py] = mid(cx, cy);
    return Math.abs(px - tx) <= w / 2 && Math.abs(py - ty) <= h / 2;
  };
  const pts = new Map(); let pinch = null, lastTap = { t: 0, x: 0, y: 0 }, down = null, multi = false;
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); }, onKey = (e) => { if (e.key === "Escape") close(); };
  stage.addEventListener("pointerdown", (e) => {
    stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { multi = true; const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k }; }
    if (pts.size === 1) {
      multi = false; down = { x: e.clientX, y: e.clientY, t: Date.now() };
      const now = Date.now();
      if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) { const [px, py] = mid(e.clientX, e.clientY); zoomAt(k > 1.05 ? 1 : 3, px, py); lastTap.t = 0; down = null; }
      else lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  });
  stage.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId); if (!p) return;
    if (pts.size === 2 && pinch) {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pts.values()], [px, py] = mid((a.x + b.x) / 2, (a.y + b.y) / 2);
      zoomAt(pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), px, py);
    } else if (pts.size === 1 && k > 1) { tx += e.clientX - p.x; ty += e.clientY - p.y; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); apply(); }
  });
  const up = (e) => {
    // a short tap with no movement on the dark background closes the viewer
    if (e.type === "pointerup" && down && !multi && pts.size === 1 && Date.now() - down.t < 350 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 10 && !onPicture(e.clientX, e.clientY)) { close(); return; }
    pts.delete(e.pointerId); pinch = null;
  };
  stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
  stage.addEventListener("wheel", (e) => { e.preventDefault(); const [px, py] = mid(e.clientX, e.clientY); zoomAt(k * Math.exp(-e.deltaY * 0.002), px, py); }, { passive: false });
  box.querySelector(".lbclose").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(box);
  apply(); box.querySelector(".lbclose").focus();
}

// What the sheet holds, as the model wants it. `errors` names every typed amount that is not an amount.
function payslipFromForm(f) {
  const errors = [], pick = (prefix, kinds) => kinds.flatMap(([kind]) => {
    const raw = (f[prefix + kind] ?? "").trim(); if (!raw) return [];
    const a = M.parsePesos(raw); if (!a.ok || a.centavos <= 0) { errors.push(kind); return []; }
    return [{ kind, amount: a.centavos, ...(kind === "overtime" ? { earned_month: f.ot_month } : {}) }];
  });
  const money = (raw) => { const a = M.parsePesos(raw ?? ""); return a.ok && a.centavos > 0 ? a.centavos : null; };
  return { errors, earnings: pick("e_", M.EARNINGS), deductions: pick("d_", M.DEDUCTIONS), printed_gross: money(f.gross), printed_net: money(f.net), deposit: money(f.deposit), printed_deductions: money(f.ded) };
}
function savePayslipReady(f) {
  const p = payslipFromForm(f);
  return { p, ready: (f.employer ?? "").trim() && f.pay_date && f.period_from && f.period_to && f.account_id && !p.errors.length && p.earnings.length && p.printed_gross && p.printed_net && p.deposit };
}
async function savePayslip() {
  const f = ui.form, { p } = savePayslipReady(f), sh = ui.sheet, editId = sh?.editId ?? null, id = editId ?? newId("ps");
  const plan = editId ? (input, now) => M.updatePayslip(S(), editId, input, now) : (input, now) => M.planPayslip(S(), input, now);
  const r = plan({ id, transaction_id: newId("tx"), employer: f.employer, period_from: f.period_from, period_to: f.period_to, pay_date: f.pay_date, account_id: f.account_id,
    printed_gross: p.printed_gross, printed_net: p.printed_net, deposit: p.deposit, printed_deductions: p.printed_deductions ?? undefined, net_words: (f.words ?? "").trim() || undefined, earnings: p.earnings, deductions: p.deductions }, new Date());
  if (!r.ok) { showToast("Could not save: " + r.violations[0].message); return; }
  let next = r.state, note = editId && r.draftsRemoved ? " The overtime draft was removed; make it again if you still want it." : "";
  const photoId = sh?.scanBlob ? (sh.queueId ?? newId("photo")) : null;   // a payslip read from a photo keeps the photo with the pay
  if (photoId) {
    if (!sh.queueId) { try { await putPhoto(photoId, sh.scanBlob); } catch { showToast("The photo could not be kept on this phone, so nothing was saved."); return; } }
    const att = M.planAttachment(next, { id: photoId, transaction_id: r.transaction.id }); if (att.ok) next = att.state;
  }
  const hasOvertime = r.lines.some((l) => l.kind === "overtime");
  if (hasOvertime) {
    const emerg = M.goalByRole(S(), "emergency");
    if (!emerg) note = " Choose which goal is your emergency fund (Menu, Budget, Goals) to get the overtime draft.";
    else if (!emerg.account_id) note = " Choose an account for your emergency fund (Menu, Budget, Goals) to get the overtime draft.";
    else if (!next.transactions.some((t) => t.id === "ot-" + id)) { const d = M.overtimeDraft(next, id, { transaction_id: "ot-" + id, emergency_account_id: emerg.account_id }, new Date()); if (d?.ok && d.transaction) { next = M.applyDrafts(next, [d]); note = " The Emergency Fund draft is waiting in Verify."; } }
  }
  ui.sheet = null; renderSheet();
  if (pendingPhoto) { URL.revokeObjectURL(pendingPhoto.url); pendingPhoto = null; }
  const saved = await commit(next, { ...ledger.settings, last_employer: f.employer.trim(), last_account_id: f.account_id, ...(sh?.queueId ? { scan_queue: scanQueue().filter((q) => q.id !== sh.queueId) } : {}) });
  if (saved && editId) for (const ph of r.photoIds ?? []) deletePhoto(ph).catch(() => {});
  showToast((editId ? "Payslip changed: " : "Payslip saved: ") + peso(p.deposit) + (r.flags.length ? ". " + r.flags.length + (r.flags.length === 1 ? " thing does" : " things do") + " not match; see Income." : ".") + note);
}

// ---------- scan: a photo of a receipt, payslip or payment screenshot ----------
// The phone reads the photo itself (app/ocr.js), src/model/scan.js turns the words into a guess, and the owner corrects the
// guess in a window. The result is a DRAFT with the photo kept beside it, so Verify shows the paper next to the numbers.
let pendingPhoto = null;   // {blob, url}: the photo being checked, not yet saved
const photoUrls = new Map();   // saved photos shown on this screen: attachment id -> object address

// The two ways to give the app a photo, always both on offer: the camera, or an image you already have (photos or files).
// mode: "quick" (saved at once when sure), "1" (check every field first), "payslip" (read as a payslip).
// Reads old spending from a notes screenshot (the on-phone reader), a CSV file or an Excel file, then shows what will be added. Nothing leaves the phone.
async function importFile(file) {
  const today0 = today(), say = (m) => { ui.form = { busy: m }; renderSheet(); };
  ui.sheet = { type: "import" }; say("Reading " + file.name + "...");
  try {
    let items, notRead;
    if (/\.xlsx$/i.test(file.name) || /spreadsheetml/.test(file.type)) ({ items, notRead } = tableOrThrow(await M.readXlsx(await file.arrayBuffer())));
    else if (/\.csv$/i.test(file.name) || /csv/.test(file.type)) ({ items, notRead } = tableOrThrow(M.parseCsv(await file.text())));
    else {
      const page = await readPage(file, (fr, what) => { const el = $("imp-msg"); if (el) el.textContent = `${what ?? "Reading"} ${Math.round((fr ?? 0) * 100)}%`; });
      ({ items, notRead } = M.parseNotes(page.boxes ? M.linesByRow(page.boxes) : page.text));
    }
    if (!items.length) throw new Error("No dated spending was found. A notes list needs a date line (02/10/2026) above lines like \"Lunch - 100\".");
    ui.form = { items, notRead, order: M.dateOrder(items.map((x) => x.dateRaw), today0), account_id: cashFirst(activeAccounts())[0]?.id ?? null };
  } catch (err) { ui.form = { error: String(err?.message ?? err) }; }
  if (ui.sheet?.type === "import") renderSheet();
}
const tableOrThrow = (rows) => { const t = M.parseTable(rows); if (!t.ok) throw new Error(t.message); return t; };
const photoButtons = (mode, busy = false) => `<label class="filebtn" aria-disabled="${busy}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="12.5" r="3.5"/></svg>&nbsp;${busy ? "Reading..." : "Take a photo"}<input type="file" accept="image/*" capture="environment" data-scan="${mode}" hidden${busy ? " disabled" : ""}></label>
  <label class="filebtn alt" aria-disabled="${busy}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>&nbsp;Choose from photos or files<input type="file" accept="image/*" data-scan="${mode}" hidden${busy ? " disabled" : ""}></label>`;

function viewScan() {
  const s = ui.scan, busy = s?.busy === true;
  const status = busy ? `<p class="note" id="scan-msg" role="status">${esc(s.msg)}</p>` : s?.error ? `<p class="note" role="alert">${esc(s.error)}</p>` : s?.done ? `<p class="note" role="status">${esc(s.done)} <button class="link" data-action="tab" data-tab="verify">Go to Verify</button></p>` : "";
  return `<h1>Scan</h1><p class="sub">A receipt, payslip or payment screenshot</p>
    <p class="note">This phone reads the photo. Nothing is sent anywhere. You check each guess in Verify, with the photo beside it.</p>
    ${photoButtons("1", busy)}
    ${status}
    <p class="note">The first photo downloads the reader (about 30 MB), then it works offline. Handwriting is read poorly: check the numbers. Photos stay on this phone.</p>`;
}

const incomeCategories = () => S().categories.filter((c) => c.kind === "income");
function scanDefaults(kind, guess, payee, named = null) {   // guess: a category ROLE; named: a category the owner spoke by name
  if (M.kindById(kind).direction === "in") {
    const inc = incomeCategories();
    return { category_id: (kind === "payslip" ? inc.find((c) => c.id === "cat-salary") : null)?.id ?? inc[0]?.id ?? null };
  }
  const learned = M.categoryFromHistory(S(), payee);   // what you used last time for the same name wins over a guess from words
  return { category_id: expenseCategories().find((c) => c.id === learned)?.id ?? expenseCategories().find((c) => named && c.name.toLowerCase() === String(named).toLowerCase())?.id ?? M.categoryByRole(expenseCategories(), guess)?.id ?? null };
}

// The account the paper names: the bank on its From line, matched to the owner's own accounts. A credit card screen prefers a card
// account. When the paper does not say, nothing is chosen for you: a wrong silent default (the first account) was worse than a tap.
function accountForScan(r) {
  if (!r.bankId && r.cash) { const c = accountsFor(null).find((a) => /^cash\b/i.test(a.name)); if (c) return { id: c.id, note: "" }; }
  if (!r.bankId) return { id: null, note: "I could not tell which account paid. Choose one." };
  const bank = M.bankById(r.bankId).name, hits = accountsFor(null).filter((a) => a.bank === r.bankId || (!a.bank && M.bankForName(a.name)?.id === r.bankId));
  if (!hits.length) return { id: null, note: "The paper names " + bank + " but you have no account for it. Choose one." };
  // A credit card payment goes to that bank's credit card; anything else to its money account (savings, debit). With only the other kind
  // on hand, nothing is chosen for you: paying a card bill from savings, or the reverse, would be wrong.
  const want = r.creditCard ? "liability" : "asset", pick = hits.find((a) => a.class === want);
  if (!pick) return { id: null, note: r.creditCard ? "This is a credit card payment at " + bank + ", but you have no credit card account for it. Add one in Setup, or choose an account." : "The paper names " + bank + " but only as a credit card. Choose the account that paid." };
  return { id: pick.id, note: hits.filter((a) => a.class === want).length > 1 ? "The paper names " + bank + "; I chose " + pick.name + ". Check it." : "" };
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
  const forReading = await preparePhoto(file, 2400, "image/png").catch(() => blob);   // lossless, so words keep their spaces; only the JPEG is kept
  try { text = await readPhoto(forReading, (f, what) => say(what + (f ? " " + Math.round(f * 100) + "%" : "...")), asPayslip); }
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
    account_id: acct.id, ...scanDefaults(r.kind, r.categoryGuess, r.payee, r.categoryName) };
  ui.sheet = { type: "scan", queueId, voice: spoken !== null }; renderSheet();
}

// ---------- voice: the microphone button on the Log screen ----------
// Say or type one sentence ("lunch 95 at Sample Burger using GCash"). If the amount, the account and the category are all clear it is saved
// as a draft at once; otherwise the check window opens with what was understood. Nothing is saved on a guess.
let voiceListener = null;
const VOICE_ERRORS = { "not-allowed": "The phone did not allow the microphone here.", "service-not-allowed": "The phone did not allow the microphone here.", "no-speech": "I did not hear anything. Try again.", "audio-capture": "No microphone was found.", network: "The speech service could not be reached (it needs internet)." };
function voiceMessage(m) { const el = $("v-msg"); if (el) el.textContent = m; }
const setWave = (on) => $("v-wave")?.classList.toggle("on", on);
const LANG_NAME = { "en-PH": "English", "fil-PH": "Filipino" };
const micLabel = (text) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.mic}</svg><span>${esc(text)}</span>`;
function voiceToggle() {
  if (voiceListener) { voiceListener.stop(); return; }
  const lang = ui.form.lang ?? firstLanguage(), btn = $("v-mic");
  if (btn) btn.innerHTML = micLabel("Listening in " + LANG_NAME[lang] + "... tap to stop");
  setWave(true);
  voiceMessage("");
  try {
    voiceListener = listen({
      lang, startText: ui.form.spoken ?? "",
      onText: (text) => { ui.form.spoken = text; const box = $("v-text"); if (box) box.value = text; refreshSave(); },
      onDone: ({ heard, confidence }) => {
        voiceListener = null; setWave(false); const b = $("v-mic"); if (b) b.innerHTML = micLabel("Tap and speak");
        // Nothing caught, or a doubtful catch: the next tap listens for the other language, so the person never has to choose one.
        if (!heard || (confidence !== null && confidence < 0.55)) {
          ui.form.lang = other(lang);
          voiceMessage(heard ? "I am not sure I heard that right. Check the words, or tap and say it again (this time I listen for " + LANG_NAME[ui.form.lang] + ")." : "I did not catch anything in " + LANG_NAME[lang] + ". Tap and speak again (this time I listen for " + LANG_NAME[ui.form.lang] + ").");
        } else ui.form.lang = lang;
      },
      onError: (code) => { voiceListener = null; setWave(false); const b = $("v-mic"); if (b) b.innerHTML = micLabel("Tap and speak"); voiceMessage((VOICE_ERRORS[code] ?? "Speech could not start (" + code + ").") + " You can type, or use the keyboard's microphone key, in the box below."); },
    });
  } catch (e) { voiceListener = null; setWave(false); if (btn) btn.innerHTML = micLabel("Tap and speak"); voiceMessage("Speech could not start. You can type, or use the keyboard's microphone key, in the box below."); }
}
async function useSpoken() {
  voiceListener?.stop();
  const heard = (ui.form.spoken ?? "").trim();
  const r = M.parseSpoken(heard, { today: today(), categories: S().categories });
  const acct = accountForScan(r), cat = scanDefaults("receipt", r.categoryRole, r.payee, r.categoryName).category_id;
  if (r.direction === "out" && r.amount && acct.id && cat) {
    ui.sheet = null; renderSheet();
    await logExpense({ transaction_id: newId("tx"), date: r.date, payee: r.payee ?? "", memo: heard, category_id: cat, amount: r.amount, account_id: acct.id, source: "voice" }, (r.payee || categoryName(cat)) + " " + peso(r.amount));
    return;
  }
  openScanSheet(null, heard, null, null, { ...r, kind: r.direction === "in" ? "received" : "receipt", categoryGuess: r.categoryRole, categoryName: r.categoryName, creditCard: false, readAnything: true, notes: r.notes });
}

// ---------- quick capture: the scanner button on the Log screen ----------
// One tap, one photo, and the entry is a draft waiting in Verify. The photo is kept the moment it is taken and put in a queue,
// so closing the app straight away loses nothing: the next time the app opens it reads what is waiting. If the app cannot be
// sure of the amount, the account and the category, it keeps the photo and asks (a note on Log), instead of saving a guess.
const scanQueue = () => ledger.settings.scan_queue ?? [];
const withQueue = (q) => ({ ...ledger.settings, scan_queue: q });
let queueRun = false, queueTalk = false;   // queueTalk: the owner tapped Read now while a run (started by the app itself) was already going
const STALL_MS = () => window.__stallMs ?? 240000;
// The reader gets this long without any sign of progress before it is given up on, so a stuck reader can never leave the queue blocked for good.
function readWithin(blob, progress) {
  return new Promise((resolve, reject) => {
    let t; const kick = () => { clearTimeout(t); t = setTimeout(() => reject(new Error("the reader stopped responding")), STALL_MS()); };
    kick();
    readPhoto(blob, (f, w) => { kick(); progress(f, w); }).then((x) => { clearTimeout(t); resolve(x); }, (e) => { clearTimeout(t); reject(e); });
  });
}

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
  if (!device.allowEntry) return;
  if (queueRun) {   // the app already started reading by itself: say so instead of ignoring the tap
    if (interactive && !queueTalk) { queueTalk = true; ui.scan = { busy: true, msg: "Reading the photos... (the first time it downloads the reader, about 30 MB)" }; renderScreen(); }
    return;
  }
  queueRun = true;
  let failure = null;
  const say = (m) => { if (!interactive && !queueTalk) return; const first = !ui.scan; ui.scan = { busy: true, msg: m }; const el = $("scan-msg"); if (el && !first) el.textContent = m; else renderScreen(); };
  try {
    for (const item of scanQueue().filter((q) => !q.needs)) {
      if (!scanQueue().some((q) => q.id === item.id)) continue;
      let blob = null, text = "";
      try {
        blob = await getPhoto(item.id);
        if (blob) { say("Reading the photo..."); text = await readWithin(blob, (f, w) => say(w + (f ? " " + Math.round(f * 100) + "%" : "..."))); }
      } catch (e) {
        if (interactive || queueTalk) failure = "The photo is kept, but the reader could not run: " + (e?.message ?? e) + ". It needs the internet the first time. Tap Read now to try again.";
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
  } finally { queueRun = false; queueTalk = false; ui.scan = failure ? { error: failure } : null; renderScreen(); }
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
        if (!blob) { const p = document.createElement("p"); p.className = "note"; p.textContent = "Picture not on this phone. Pictures are not part of the backup file."; (img.closest("button") ?? img).replaceWith(p); return; }
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
  for (const term of [b.wiki ?? []].flat()) { const r = await wikiLogo(term); if (r.url) return { icon: r.url }; why.push("Wikipedia (" + term + "): " + r.why); }
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
const accountPreview = (f) => { const b = M.bankById(f.bank), sub = (f.sub ?? "").trim(); return sub ? b.name + " \u00b7 " + sub : f.kind === "liability" ? b.name + " \u00b7 Credit card" : b.name; };

// ---------- Help: how the app works, in a minute ----------
// The words live in src/model/help.js (kept true by a test that wants a topic for every screen in the menu). The notes come first, word for word;
// then three getting-started steps that tick themselves from your own data; then one line-or-two topic per screen, each with a button that goes there.
const noteIcon = (i) => `<svg class="noteicon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${M.NOTE_ICONS[i] ?? ""}</svg>`;
// A topic's drawing (if it names one) goes at the top of its collapsible, with its caption under it: collapsing the topic hides both.
const figure = (id) => { const d = id && M.drawing(id); return d ? `<figure class="hfig">${d.svg}<figcaption>${esc(d.caption)}</figcaption></figure>` : ""; };
function viewHelp() {
  const steps = M.checklist(S(), ledger.settings);
  return `<h1>Help</h1><p class="sub">How this app works, in a minute.</p>
    <div class="card"><h2>Quick notes</h2><ol class="notes icons">${M.QUICK_NOTES.map((n, i) => `<li>${noteIcon(i)}<span>${esc(n)}</span></li>`).join("")}</ol></div>
    <p><button class="link" data-action="open-notice">Read the first-run notice again</button></p>
    <h2>Getting started</h2>
    <div class="mlist">${steps.map((st) => `<div class="mrow mline"><span class="mn">${st.done ? "\u2713" : "\u25CB"} ${esc(st.text)}</span><span class="mv">${st.done ? "Done" : `<button class="link" data-action="tab" data-tab="${st.tab}">${esc(st.button)}</button>`}</span></div>`).join("")}</div>
    <h2>How-tos</h2><p class="note">${esc(M.HOWTO_HINT)}</p>
    <div class="mlist">${M.HOWTOS.map((h) => `<div class="mrow mline"><span class="mn">${esc(h.label)}</span><span class="mv"><button class="link" data-action="open-howto" data-id="${h.id}">Watch</button></span></div>`).join("")}</div>
    <h2>What's new</h2>
    <div class="mlist">${M.CHANGES.map((c) => `<div class="mrow mline"><span class="mn wn"><small>${esc(longDate(c.date))}</small>${esc(c.text)}</span></div>`).join("")}</div>
    <h2>Each screen</h2>
    <div class="mlist">${M.HELP_TOPICS.map((t) => `<details class="mrow"><summary><span class="mn">${esc(t.label)}</span><span class="tchev" aria-hidden="true">\u203A</span></summary>${figure(t.drawing)}${t.lines.map((l) => `<div class="mpart"><span>${esc(l)}</span></div>`).join("")}<div class="mpart"><button class="link" data-action="tab" data-tab="${t.tab}">Open ${esc(t.label)}</button></div></details>`).join("")}</div>
    <p class="note">This guide is kept up to date as the app changes.</p>`;
}

function viewSetup() {
  const f = ui.accountForm;
  const cards = S().accounts.filter((a) => a.class === "liability" && !a.archived);
  const used = new Set(S().entries.map((e) => e.account_id));
  const reserveExists = S().accounts.some((a) => a.reserve_for);
  const hosts = activeAccounts().filter((a) => a.class === "asset" && !a.reserve_for);
  const rows = cashFirst(S().accounts).map((a) => `<div class="row"><div class="who"><button class="icobtn" data-action="open-icon" data-id="${esc(a.id)}" aria-label="Choose a picture for ${esc(a.name)}">${iconOf(a, 44)}</button><div>${esc(a.name)}<small>${a.class === "asset" ? "Bank, wallet or cash" : "Credit card"}${a.reserve_for ? " · covers " + esc(accountName(a.reserve_for)) : ""}${a.bank && !a.name.toLowerCase().startsWith(M.bankById(a.bank).name.toLowerCase()) ? " · linked to " + esc(M.bankById(a.bank).name) : ""}${a.icon || a.icon_url ? "" : " · tap the tile to add a picture"}</small></div></div>
      <div class="amt">${peso(M.naturalBalance(a, M.countedEntries(S())))}${used.has(a.id) ? "" : `<br><button class="link" data-action="remove-account" data-id="${esc(a.id)}">${ui.confirmRemove === a.id ? "Tap again to remove" : "Remove"}</button>`}</div></div>`).join("");
  // The form comes FIRST so it stays in the same place however many accounts there are: the
  // button never drifts down behind the keyboard. The list of accounts follows it.
  const formOpen = ui.setupAdd || S().accounts.length === 0;   // a new phone opens on the form; after that it sits behind one button
  const addForm = `<h2>Add an account</h2>
    <label for="a-bank">Bank</label>
    <button id="a-bank" class="bankpick" data-action="open-banks" data-for="add">${f.bank ? `${iconOf({ name: M.bankById(f.bank).name, bank: f.bank, ...(bankPictureOf(f.bank) ?? {}) }, 28)}<span>${esc(M.bankById(f.bank).name)}</span>` : `<span class="muted">Choose a bank</span>`}<span class="chev" aria-hidden="true">\u203A</span></button>
    ${f.bank ? `<label for="a-sub">Which part of ${esc(M.bankById(f.bank).name)}? (optional)</label><input id="a-sub" data-field="sub" value="${esc(f.sub)}" placeholder="e.g. Emergency Fund, Savings" autocomplete="off" enterkeyhint="next">
      <p class="note" id="a-preview">Saved as: ${esc(accountPreview(f))}</p>`
      : `<label for="a-name">Or type a name</label><input id="a-name" data-field="name" value="${esc(f.name)}" autocomplete="off" enterkeyhint="next">`}
    <label for="a-kind">Kind of account</label><select id="a-kind" data-field="kind"><option value="asset"${f.kind === "asset" ? " selected" : ""}>Bank, wallet or cash (money I have)</option><option value="liability"${f.kind === "liability" ? " selected" : ""}>Credit card (money I owe)</option></select>
    <label for="a-open">${f.kind === "asset" ? "How much is in it today" : "How much you owe on it today"} (₱)</label><input id="a-open" data-field="opening" inputmode="decimal" value="${esc(f.opening)}" placeholder="0.00" autocomplete="off">
    <p class="note" id="a-open-note">Spending logged with an earlier date does not change this amount. From today on, it does.</p>
    ${f.kind === "asset" && cards.length ? `<label for="a-covers">This account is a reserve for a card (optional)</label><select id="a-covers" data-field="covers"><option value="">No</option>${cards.map((c) => `<option value="${esc(c.id)}"${f.covers === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>` : ""}
    ${ui.setupError ? `<p id="a-error" role="alert"><b>${esc(ui.setupError)}</b></p>` : ""}
    <p><button class="primary" data-action="add-account" style="margin-top:14px">Add account</button></p>${S().accounts.length ? `<p class="center"><button class="link" data-action="toggle-add-account">Cancel</button></p>` : ""}`;
  return `<h1>Setup</h1><p class="sub">Accounts. The ledger is on this phone only.</p>
    ${formOpen ? addForm : ""}
    <h2>Your accounts</h2>
    ${rows || `<p class="note">No accounts yet.</p>`}
    ${formOpen ? "" : `<p><button id="add-account-open" data-action="toggle-add-account" style="width:100%">Add an account</button></p>`}
    <h2>Categories</h2>
    ${expenseCategories().map((c) => `<div class="row"><div>${catLine(c)}</div><div class="amt"><button class="link" data-action="cat-bucket" data-id="${esc(c.id)}">Bucket</button> <button class="link" data-action="rename-cat" data-id="${esc(c.id)}">Rename</button></div></div>`).join("")}
    <p><button data-action="add-cat" style="width:100%">Add a category</button></p>
    ${planOf() ? `<h2>Pay plan</h2>
    <p class="note">A plan is in effect. <button class="link" data-action="tab" data-tab="${ledger.settings.try_new_budget ? "budget" : "plan"}">${ledger.settings.try_new_budget ? "Open it in Budget" : "Open it"}</button></p>` : ""}
    <h2>Try the new Budget</h2>
    <p class="note">Shows your income, each limit as a share of it, and what you save. Off by default.</p>
    <p><button data-action="toggle-new-budget" aria-pressed="${Boolean(ledger.settings.try_new_budget)}" style="width:100%">${ledger.settings.try_new_budget ? "On (tap to turn off)" : "Off (tap to turn on)"}</button></p>
    <h2>Backup</h2>
    <p class="note">${backupAgeText()}</p>
    <p><button class="primary" data-action="open-backup" data-howto="backup">Back up now</button></p>
    <p><button data-action="open-restore" style="width:100%">Restore from a backup</button></p>
    <p><button data-action="open-check-backup" style="width:100%">Check a backup file</button></p>
    ${why("The file is encrypted. Keep a second copy off this phone, like iCloud Drive or a computer.", "Where to keep it")}
    <h2>This app</h2>
    <p class="note">${M.isDevBuild() ? "Version: a development copy." : "Version " + esc(M.APP_BUILD) + ", updated " + esc(fullDate(M.APP_BUILT_ON)) + "."} Your data format: ${ledger.v}.</p>
    ${(ui.copies ?? []).map((c, i) => `<p><button data-action="restore-copy" data-id="${i}" style="width:100%">${ui.confirmCopy === i ? "Tap again to restore. Entries made since then will be lost." : i === 0 ? "Restore the copy from before the last update" : "Restore the copy from before the update before that"}</button></p><p class="note small">Saved ${esc(fullDate(c.at.slice(0, 10)))}, before your data was updated from format ${c.from_version}.</p>`).join("")}
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
const legend = (pace = false) => `<p class="legend" aria-label="What the colours mean">${["good", "warning", "serious", "critical", "none"].map((l) => `<span>${glyph(l)}${LEVELS[l]}</span>`).join("")}${pace ? `<span class="pacekey"><i class="tickkey" aria-hidden="true"></i>Today's place in the month, shown when spending is ahead of it</span>` : ""}</p>`;
const aheadOfMonth = M.paceAhead;   // the pace line is drawn on a budget only when its spending is ahead of the calendar

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
// The month / year / range bar at the top of Spending and Income: arrows to step, the title to open the picker.
function periodStepper(p) {
  const nowM = M.monthOf(today()), nowY = Number(today().slice(0, 4)), label = periodLabel(p);
  const atEnd = p.kind === "month" ? p.month >= nowM : p.kind === "year" ? p.year >= nowY : true;
  const title = `<button class="ptitle" data-action="open-period" aria-label="Choose the period: ${esc(label)}">${esc(label)}</button>`;
  return p.kind === "range" ? `<div class="stepper single">${title}</div>`
    : `<div class="stepper"><button data-action="period-step" data-step="-1" aria-label="Earlier">\u2039</button>${title}<button data-action="period-step" data-step="1" aria-label="Later"${atEnd ? " disabled" : ""}>\u203A</button></div>`;
}
const periodWords = (p) => (p.kind === "range" ? "from " + fullDate(p.from) + " to " + fullDate(p.to) : "in " + periodLabel(p));
const MONTH3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pendingNote = (n) => (n > 0 ? `<p class="note"><button class="link" data-action="tab" data-tab="verify">plus ${peso(n)} not verified yet</button></p>` : "");
// One small switch at the top, the same on every view: chart or list.
const modeBar = () => `<div class="modebar"><button data-action="chart-mode" data-mode="${ui.asList ? "chart" : "list"}" aria-label="${ui.asList ? "Show as a chart" : "Show as a list"}">${ui.asList ? "Chart" : "List"}</button></div>`;
const moneyViews = () => `<div class="seg" role="group" aria-label="What to show">${[["category", "Category"], ["budget", "Budget"], ["account", "Accounts"], ["month", "Trends"]].map(([v, t]) => `<button data-action="chart-view" data-view="${v}" aria-pressed="${ui.view === v}">${t}</button>`).join("")}</div>`;

// A chart you tap to flip: bars become a donut and the donut becomes bars. Nothing else happens on a tap.
function flipChart(rows, total, { shape = "donut" } = {}) {
  const shown = foldRows(rows.filter((r) => r.amount > 0), total);
  if (!shown.length) return `<p class="note">Nothing verified in this period.</p>`;
  if (shape === "donut") {
    const R = 70, C = 2 * Math.PI * R, GAP = 2, sum = shown.reduce((n, r) => n + r.amount, 0) || 1;
    let offset = 0;
    const colored = shown.map((r, i) => ({ ...r, color: r.fold ? "#999" : DONUT_BLUES[Math.min(i, DONUT_BLUES.length - 1)] }));
    const arcs = colored.map((r) => { const len = (r.amount / sum) * C, dash = Math.max(0.5, len - GAP); const c = `<circle class="slice" cx="100" cy="100" r="${R}" fill="none" stroke="${r.color}" stroke-width="30" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 100 100)"/>`; offset += len; return c; }).join("");
    const legend = colored.map((r) => `<div class="lrow"><span class="swatch" style="background:${r.color}"></span><span class="lname">${r.label}</span><span class="lval">${peso(r.amount)} \u00b7 ${r.percent}%</span></div>`).join("");
    return `<div class="flip" data-action="chart-mode" data-mode="list" role="button" tabindex="0" aria-label="Donut of where the money went. Tap to show the list."><svg class="donut" viewBox="0 0 200 200" aria-hidden="true">${arcs}</svg><div class="legendlist">${legend}</div></div>`;
  }
  const max = Math.max(...shown.map((r) => r.amount), 1);
  return `<div class="bars flip" data-action="chart-mode" data-mode="list" role="button" tabindex="0" aria-label="Bars of where the money went. Tap to show the list.">${shown.map((r) => `<div class="brow${r.grade ? " g-" + r.grade : ""}">
      <span class="btop"><span class="bname">${r.label}</span><span class="bval">${peso(r.amount)}${r.percent ? " \u00b7 " + r.percent + "%" : ""}</span></span>
      <span class="btrack"><span class="bfill" style="width:${Math.max(1, Math.round((r.amount * 100) / max))}%"></span></span></div>`).join("")}</div>`;
}

// The Cards screen (menu): every account in one place. Credit cards show what you owe and what was spent on and paid toward each in the
// period; debit cards, savings, wallets and cash show their balance and what was spent from them. A card is just one of the accounts.
function viewCards() {
  const p = period(), [from, to] = periodBounds(p), o = M.accountsOverview(S(), { from, to });
  const acct = (id) => S().accounts.find((a) => a.id === id);
  const row = (a, main, small) => `<div class="row"><div class="who">${iconOf(a, 28)}<div>${esc(a.name)}<small>${small}</small></div></div><div class="amt">${main}</div></div>`;
  const cards = o.cards.length ? o.cards.map((c) => row(acct(c.account_id), `${peso(c.owe)}<small>you owe</small>`, `spent ${peso(c.spent)} \u00b7 paid ${peso(c.paid)}`)).join("") : `<p class="note">No credit cards yet. In Setup, add an account and choose "Credit card".</p>`;
  const money = o.money.length ? [...o.money].sort((x, y) => Number(isCash(acct(y.account_id))) - Number(isCash(acct(x.account_id)))).map((m) => row(acct(m.account_id), `${peso(m.balance)}<small>in it</small>`, `spent ${peso(m.spent)}`)).join("") : `<p class="note">No accounts yet.</p>`;
  return `<h1>Cards</h1>${periodStepper(p)}
    <div class="tiles two"><div class="tile"><b>${peso(o.held)}</b><span>in your accounts</span></div><div class="tile"><b>${peso(o.owe)}</b><span>owed on cards</span></div></div>
    <h2>Credit cards</h2>${cards}
    <h2>Debit, savings and cash</h2>${money}
    ${why(`Paying a card bill is not spending: the purchases were counted when you made them. The amounts spent and paid are for ${esc(periodLabel(p))}.`)}
    <p><button class="link" data-action="tab" data-tab="setup">Add or change accounts</button></p>`;
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
  const stepper = periodStepper(p);
  const hero = `<h1>Spending</h1>${stepper}<div class="hero">${peso(cat.total)}</div><p class="sub">${esc(sub)}</p>${delta}${pendingNote(cat.pending)}${moneyViews()}${modeBar()}`;
  // A list is tapped to go back to the chart, the same way a chart is tapped to go to its list.
  const done = (html) => hero + (ui.asList ? `<div class="flip" data-action="chart-mode" data-mode="chart" role="button" tabindex="0" aria-label="The list. Tap to show the chart.">${html}</div>` : html);
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
    return done(flipChart(rows, acc.total, { shape: "bars" }));
  }

  if (!cat.rows.length) return empty();
  // The bars here show each category's share of the spending, so they are one calm blue; budget colours belong to the Budgets view.
  const rows = cat.rows.map((r) => {
    return { id: r.category_id, label: esc(r.name), amount: r.amount, percent: r.percent, grade: null };
  });
  if (ui.asList) return done(listTable(["Category", "Spent", "Share"], rows.map((r) => [r.label, peso(r.amount), r.percent + "%"]), "Total", cat.total));
  return done(flipChart(rows, cat.total, { shape: "donut" }));
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
    <p class="note">A gap means nothing was budgeted or logged. Tap a month to open it.</p>`;
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
    return hero + varianceTable(budgeted);
  }
  const cards = budgeted.map((r) => `<div class="bcard" role="group" aria-label="${esc(categoryName(r.category_id) + ": " + peso(r.spent) + " of " + peso(r.budget) + ", " + LEVELS[r.grade.level])}">
      <div class="btop"><span class="bname">${esc(categoryName(r.category_id))}</span><span class="bval">${peso(r.spent)} of ${peso(r.budget)}</span></div>
      <div class="meter g-${r.grade.level}"><span class="fill" style="width:${r.spent > 0 ? Math.max(1, Math.min(100, Math.round((r.spent * 100) / r.budget))) : 0}%"></span>${aheadOfMonth(r.spent, r.budget, elapsed) ? `<span class="tick" style="left:${elapsed}%"></span>` : ""}</div>
      <div class="status">${glyph(r.grade.level)}${esc(LEVELS[r.grade.level])} · ${esc(words(r))}${r.pending > 0 ? " · " + esc("+" + peso(r.pending) + " not verified") : ""}</div></div>`).join("");
  const rest = unbudgeted.length ? `<h2>No budget set</h2>${unbudgeted.map((r) => `<div class="row"><div>${esc(categoryName(r.category_id))}</div><div class="amt">${peso(r.spent)}</div></div>`).join("")}` : "";
  return hero + legend(budgeted.some((r) => aheadOfMonth(r.spent, r.budget, elapsed))) + `<div>${cards}</div>
    <h2>Budget vs actual</h2>${varianceTable(budgeted)}${rest}`;
}

// ---------- Budget: the monthly amounts ----------
// ---------- overrun buffer ----------
// The account the owner picks (a wallet, say) holds two envelopes the ledger tracks apart: an everyday allowance and the overrun buffer.
const gcashOf = () => (ledger.settings.gcash && S().accounts.some((a) => a.id === ledger.settings.gcash.account_id) ? ledger.settings.gcash : null);
function viewBuffer() {
  const g = gcashOf();
  if (!g) return `<h1>Buffer</h1><p class="note">Money kept aside for when a category goes over budget. Every draw is recorded against that category.</p>
    <p><button class="primary" data-action="open-bufsetup">Set up the buffer</button></p>`;
  const month = M.monthOf(today());
  const sum = M.bufferSummary(S(), { allowance_envelope_id: g.allowance_id, buffer_envelope_id: g.buffer_id, month });
  const line = planOf()?.lines.find((l) => l.kind === "buffer");
  const monthly = line ? line.first + line.second : null;
  const acct = S().accounts.find((a) => a.id === g.account_id);
  const empty = sum.allowance <= 0;
  const draws = sum.draws.length ? `<table class="tbl"><tr><th>Category</th><th class="n">Drawn</th></tr>${sum.draws.map((d) => `<tr><td>${esc(d.name)}</td><td class="n">${d.amount === 0 && d.pending ? peso(d.pending) + "<small> not verified</small>" : peso(d.amount) + (d.pending ? `<small> + ${peso(d.pending)} not verified</small>` : "")}</td></tr>`).join("")}
      <tr class="total"><td>Total drawn</td><td class="n">${peso(sum.drawn)}</td></tr></table>` : `<p class="note">Nothing has been drawn from the buffer this month.</p>`;
  const sweepNames = (ledger.settings.sweep_order ?? []).map((o) => S().goals.find((x) => x.id === o.goal_id)?.name).filter(Boolean);
  const flagged = M.underBudgetedCategories(S(), g.buffer_id, 2).map((c) => categoryName(c.category_id));
  return `<h1>Buffer</h1><p class="sub">Inside ${esc(acct.name)}</p>
    <div class="card"><dl><dt>Buffer left</dt><dd class="big">${peso(sum.buffer)}</dd>${monthly != null ? `<dt>Plan per month</dt><dd>${peso(monthly)}</dd>` : ""}<dt>Allowance left</dt><dd>${peso(sum.allowance)}</dd></dl></div>
    ${empty ? `<p class="note"><b>The everyday allowance in ${esc(acct.name)} is empty.</b> More ${esc(acct.name)} spending will draw the buffer.</p>` : ""}
    <h2>Drawn in ${esc(M.monthLabel(month))}</h2>${draws}
    ${flagged.length ? `<p class="note">${esc(flagged.join(", "))} drew the buffer in more than one month. That line may be under-budgeted: set a new budget from next month.</p>` : ""}
    <p><button class="primary" data-action="open-bufund" style="margin-top:8px">Add to the buffer</button></p>
    <p><button data-action="sweep-buffer" style="width:100%">Sweep what is left (month end)</button></p>
    <p class="note">${sweepNames.length ? "The sweep fills " + esc(sweepNames.join(", then ")) + ": each one up to its target, and the last one takes the rest." : "Choose which goals the leftover goes to, in order."} It is saved as a draft for you to verify.</p>
    <p><button class="link" data-action="open-sweep">Choose where the leftover goes</button></p>`;
}

// ---------- trips ----------
// A trip is a tag with an optional budget. Switch one on and new entries are tagged with it, with no extra taps.
function viewTrips() {
  if (ui.tripId && S().tags.some((t) => t.id === ui.tripId)) return viewTripDetail(ui.tripId);
  const tags = S().tags, active = ledger.settings.active_tag_id;
  const cards = tags.map((t) => {
    const sum = M.tagSummary(S(), t.id, { categoryMaps: S().categoryMaps, asOf: today() });
    const g = sum.grade, on = active === t.id;
    const meter = g ? `<div class="meter g-${g.level}"><span class="fill" style="width:${sum.spent > 0 ? Math.max(1, Math.min(100, g.percent)) : 0}%"></span></div>
      <div class="status">${glyph(g.level)}${esc(LEVELS[g.level])} \u00b7 ${esc(g.over ? "Over by " + peso(sum.spent - sum.budget) : peso(sum.budget - sum.spent) + " left")}</div>` : "";
    const rows = sum.rows.length ? `<table class="tbl"><tr><th>Category</th><th class="n">Spent</th></tr>${sum.rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="n">${peso(r.amount)}</td></tr>`).join("")}</table>` : `<p class="note">Nothing verified on this trip yet.</p>`;
    const days = M.tripDays(t);
    return `<div class="bcard"><div class="btop"><span class="bname">${esc(t.name)}</span><span class="bval">${peso(sum.spent)}${sum.budget != null ? " of " + peso(sum.budget) : ""}</span></div>
      <p class="note">${days ? esc(days) + ` \u00b7 <button class="link" data-action="open-trip-dates" data-id="${esc(t.id)}">Change dates</button>` : `<button class="link" data-action="open-trip-dates" data-id="${esc(t.id)}">Add dates</button>`}</p>${meter}
      ${sum.pending > 0 ? `<p class="note">plus ${peso(sum.pending)} not verified yet</p>` : ""}${rows}
      <p><button data-action="open-trip-detail" data-id="${esc(t.id)}">See the entries</button></p>
      <p><button data-action="use-trip" data-id="${esc(t.id)}" aria-pressed="${on}">${on ? "Tagging new entries \u2713 (tap to stop)" : "Tag new entries with this trip"}</button></p></div>`;
  }).join("");
  return `<h1>Trips</h1><p class="sub">Spending for a trip, kept apart from daily spending. Give a trip dates and entries on those days join it.</p>${cards || `<p class="note">No trips yet.</p>`}
    <p><button class="primary" data-action="open-trip" style="margin-top:8px">Add a trip</button></p>`;
}

// One trip's entries. Membership is worked out from the dates each time (nothing is written into the entries); the buttons only record a hand override.
function viewTripDetail(id) {
  const d = M.tripEntries(S(), id), sum = M.tagSummary(S(), id, { categoryMaps: S().categoryMaps, asOf: today() }), days = M.tripDays(d.tag);
  const row = (r) => { const t = r.transaction;
    return `<div class="row"><div>${esc(t.payee || (S().entries.filter((e) => e.transaction_id === t.id && e.category_id).map((e) => categoryName(e.category_id))[0] ?? "Entry"))}<small>${esc(longDate(t.date))}${r.counted ? "" : " \u00b7 not counted as spending"}${t.status === "verified" ? "" : " \u00b7 not verified yet"}${r.how === "hand" ? " \u00b7 added by hand" : ""}</small></div>
      <div class="amt">${peso(r.amount)}<br><button class="link" data-action="trip-remove" data-id="${esc(t.id)}">Take off this trip</button></div></div>`; };
  return `<h1>${esc(d.tag.name)}</h1><p class="sub">${days ? esc(days) + " (both days included)" : "No dates yet."} Total ${peso(sum.spent)}${sum.pending > 0 ? ", plus " + peso(sum.pending) + " not verified yet" : ""}.</p>
    <p><button class="link" data-action="trip-back">\u2039 All trips</button> \u00b7 <button class="link" data-action="open-trip-dates" data-id="${esc(id)}">${days ? "Change dates" : "Add dates"}</button></p>
    ${d.rows.length ? d.rows.map(row).join("") : `<p class="note">${days ? "No entries on these days yet." : "Nothing on this trip yet."}</p>`}
    ${d.before.length ? `<h2>Before the trip</h2><p class="note">Added by hand, dated before the first day. They count in the total.</p>${d.before.map(row).join("")}` : ""}
    <p><button data-action="open-trip-pick" style="margin-top:10px">Add an entry by hand</button></p>`;
}

// ---------- checks: card reserve and the weekly Unlogged habit ----------
function viewChecks() {
  const rs = M.reserveShortfalls(S().accounts, M.countedEntries(S()));
  const reserve = rs.length ? rs.map((r) => {
    const card = S().accounts.find((a) => a.id === r.card_id), res = S().accounts.find((a) => a.id === r.reserve_id), o = M.cardOutstanding(card, M.countedEntries(S()));
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
const paydaysLine = (plan) => (plan.paydays.length === 1
  ? `Payday on ${paydayText(plan.paydays[0].day)}. In effect since ${longDate(plan.effective_from)}.`
  : `Paydays on ${paydayText(plan.paydays[0].day)} and ${paydayText(plan.paydays[1].day)}. In effect since ${longDate(plan.effective_from)}.`);
function viewPlan() {
  const plan = planOf(), all = plansOf();
  if (!plan) return `<h1>Pay plan</h1><p class="note">${all.length ? "Your plan starts " + esc(longDate([...all].sort((x, y) => (x.effective_from < y.effective_from ? -1 : 1))[0].effective_from)) + "." : "Your plan for each payday: how much goes to rent, daily spending and savings. You can skip it. Budget works without it."}</p>`;
  return `<h1>Pay plan</h1><p class="sub">This divides each payday. Budget sets your limit per category for the month.</p><p class="sub">${esc(paydaysLine(plan))}</p>
    ${planBody(plan, all)}`;
}
// The plan's tables: lines by payday, income against what arrived, this cutoff. Shared by the Pay plan screen and the Budget's "By payday" section.
function planBody(plan, all) {
  const t = M.planTotals(plan), two = plan.paydays.length === 2, [p1, p2] = plan.paydays;
  const lines = plan.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="n">${peso(l.first)}</td>${two ? `<td class="n">${peso(l.second)}</td>` : ""}<td class="n">${peso(l.first + l.second)}</td></tr>`).join("");
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
  return `<table class="tbl"><tr><th>Line</th><th class="n">${esc(p1.label)}</th>${two ? `<th class="n">${esc(p2.label)}</th>` : ""}<th class="n">Monthly</th></tr>${lines}
      <tr class="total"><td>Total (= income)</td><td class="n">${peso(t.first)}</td>${two ? `<td class="n">${peso(t.second)}</td>` : ""}<td class="n">${peso(t.month)}</td></tr></table>
    <h2>Income</h2><table class="tbl"><tr><th>Payday</th><th class="n">Plan</th><th class="n">Received</th><th class="n">Difference</th></tr>${incomeRows}</table>
    <p class="note">The plan holds planned income. Your real pay is recorded below. The gap is shown, never changed.</p>
    <p><button data-action="open-income" style="width:100%">Record pay received</button></p>
    <h2>This cutoff</h2><p class="note">${esc(which.label)} to the day before the next: ${esc(longDate(prog.period.start))} to ${esc(longDate(prog.period.end))}. Only verified spending counts.</p>
    ${mine.length ? `<table class="tbl"><tr><th>Line</th><th class="n">Plan</th><th class="n">Spent</th><th class="n">Left</th></tr>${rem}</table>` : `<p class="note">No plan line matches one of your categories yet.</p>`}
    ${unmatched.length ? `<p class="note">Not matched to a category, so not tracked: ${esc(unmatched.map((r) => r.name).join(", "))}.</p>` : ""}
    ${history}`;
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
    const isEf = g.role === "emergency", ef = !isEf ? null : planOf() ? M.emergencyFundStatus(S(), planOf(), g) : M.emergencyFundFromBudgets(S(), g, { month: M.monthOf(today()) });
    if (isEf) p = { ...p, target: null, remaining: null, percent: null, reached: false };
    const hidden = g.hidden_by_default && !ui.reveal;
    const line = planOf()?.lines.find((l) => l.kind === "goal" && l.name.toLowerCase() === g.name.toLowerCase());
    const monthly = line ? line.first + line.second : 0;
    const eta = monthly > 0 && p.remaining ? Math.ceil(p.remaining / monthly) : null;
    const need = g.deadline && p.remaining ? M.requiredPerMonth(p, g.deadline, today().slice(0, 7)) : null;
    const efBody = !ef ? "" : `<table class="tbl"><tr><td>Target</td><td class="n">${peso(ef.target)}</td></tr><tr><td>Balance now</td><td class="n">${peso(ef.balance)}</td></tr>
        <tr><td>Monthly contribution</td><td class="n">${ef.monthly ? peso(ef.monthly) : ef.source === "budgets" ? "not set" : "none in your plan"}</td></tr>
        <tr><td>Months to target</td><td class="n">${ef.reached ? "Reached" : ef.monthsToTarget === null ? "Not known yet" : "About " + ef.monthsToTarget}</td></tr></table>
        <div class="goalrow">${ring(ef.percent, ef.percent + "% of the target")}<div class="status">${ef.reached ? "Target reached" : peso(ef.remaining) + " to go"}</div></div>
        <p class="note">Target = ${ef.months} months of ${esc(ef.basis.join(", "))} from ${ef.source === "budgets" ? "your budgets" : "your plan"} (${peso(ef.monthlyBasis)} a month). It changes when ${ef.source === "budgets" ? "your budgets do" : "your plan does"}.${ef.missing.length ? " Your plan has no line named " + esc(ef.missing.join(", ")) + "." : ""}</p>`;
    const body = hidden ? `<p class="note">Hidden. Tap Show balances above.</p>`
      : ef ? efBody
      : isEf ? `<div class="btop"><span class="bval">${peso(p.balance)}</span></div><p class="note">The target is 3 months of your rent, food and essentials, from your budgets. Set those budgets (Menu, Budget) and it appears here.</p>`
      : `<div class="btop"><span class="bval">${peso(p.balance)}${p.target != null ? " of " + peso(p.target) : ""}</span></div>
         ${p.target != null ? `<div class="goalrow">${ring(p.percent, p.percent + "% of the goal")}<div class="status">${p.reached ? "Goal reached" : peso(p.remaining) + " to go"}${eta ? " \u00b7 about " + eta + (eta === 1 ? " month" : " months") + " at your plan's " + peso(monthly) + " a month" : ""}${need ? " \u00b7 " + peso(need.perMonth) + " a month for " + need.monthsLeft + " " + (need.monthsLeft === 1 ? "month" : "months") : ""}</div></div>` : `<div class="status">No target, just a place to build up.</div>`}`;
    return `<div class="bcard"><div class="btop"><span class="bname who">${iconOf(S().accounts.find((a) => a.id === g.account_id) ?? { name: g.name }, 24)}<span>${esc(g.name)}</span></span></div>${body}
      <p>${g.account_id ? `<button data-action="open-deposit" data-id="${esc(g.id)}">Put money in</button>` : `<span class="note">No account yet. </span><button data-action="open-goal-account" data-id="${esc(g.id)}">Choose an account</button>`}</p>
      <p class="note"><button class="link" data-action="goal-role" data-id="${esc(g.id)}">${g.role === "emergency" ? "This is your emergency fund (tap to undo)" : "Make this my emergency fund"}</button></p></div>`;
  }).join("");
  return `<h1>Goals</h1><p class="sub">Your savings goals. Balances stay hidden until you show them.</p>${toggle}${cards || `<p class="note">No goals yet.</p>`}
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
  if (!accts.length) return `<h1>Weekly review</h1><p class="note">Add accounts first.</p><button class="primary" data-action="tab" data-tab="setup">Add accounts</button>`;
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
  return `<h1>Weekly review</h1><p class="sub">Week of ${esc(longDate(w.week_start))} to ${esc(longDate(w.week_end))}</p>
    <p class="note">Open each account, look at the real balance, and type it in. ${done} of ${accts.length} counted.</p>${backupLine}${rows}${questions}
    ${why("Money the ledger cannot explain is recorded as Unlogged. It never blocks anything.")}`;
}

// The switch is a settings key, off by default; off, this is exactly the screen it always was.
function viewBudget() { return ledger.settings.try_new_budget ? viewBudgetNew() : viewBudgetOld(); }

// ---- the new Budget (Setup, "Try the new Budget") ----
// Income at the top, every amount as a share of it, then two blocks: "Spending" (the budgets) and "Saved and set aside". Nothing here is saved by
// looking at it; "Suggest a budget" proposes, and only Confirm writes ordinary budget rules.
function viewBudgetNew() {
  const month = M.monthOf(today()), next = M.addMonths(month, 1), set = ledger.settings, plan = planOf();
  const inc = M.baseIncome(S(), { plan, pin: set.income_base_pin ?? null }), income = inc.amount;
  const share = (amount) => (income ? `<small>${M.showTenths(M.tenths(amount, income))} of income</small>` : "");   // under the amount, on its own line, so the columns line up
  const status = new Map(M.budgetStatus(S(), { rules: S().rules, categoryMaps: S().categoryMaps, month, asOf: today() }).map((r) => [r.category_id, r]));
  const rows = expenseCategories().map((c) => ({ c, now: M.budgetFor(S().rules, c.id, month), later: M.budgetFor(S().rules, c.id, next), st: status.get(c.id) }));
  const spendTotal = rows.reduce((n, r) => n + (r.now ?? 0), 0);
  const sug = income && !plan ? runSuggest() : null;   // the same call as the Suggest sheet, so the rent you typed is used here too
  const savedAll = M.savedRows({ plan, suggestion: sug?.ok ? sug : null });
  const saved = savedAll.filter((r) => r.kind !== "buffer"), bufferRows = savedAll.filter((r) => r.kind === "buffer");   // Saved counts Goals only: the overrun buffer is its own line
  const savedTotal = saved.reduce((n, r) => n + r.amount, 0), bufferTotal = bufferRows.reduce((n, r) => n + r.amount, 0);
  const shareable = M.shareableGoals(S().goals, new Map(S().goals.map((g) => [g.id, M.goalProgress(S(), g)])));
  const head = `<div class="card" id="bud-income"><dl><dt>Income (base)</dt><dd class="big">${income ? peso(income) + " a month" : "Not known yet"}</dd></dl>
    ${income ? `<p class="note">${esc(inc.text)}.${inc.source === "plan" ? " A plan is loaded, so its figure is used." : ""}</p>` : `<p class="note"><b>${esc(M.NO_INCOME_PROMPT)}</b></p>`}
    <p class="note"><button class="link" data-action="open-income-base">${set.income_base_pin ? "Change my figure" : "Type a different figure"}</button>${set.income_base_pin ? ` \u00b7 <button class="link" data-action="clear-income-pin">Use my payslips again</button>` : ""}</p>
    ${M.incomeChanged(set.budget_income_seen ?? null, income) ? `<p class="note" id="bud-changed">Income changed: review.</p>` : ""}</div>
    <p><button class="primary" data-action="open-suggest">Suggest a budget</button></p>`;
  const spendRows = rows.map((r) => {
    const over = r.st?.over && r.now !== null;
    const change = r.later !== r.now ? `<small>${r.later === null ? "ends" : peso(r.later) + " a month"} from ${esc(M.monthLabel(next))}</small>` : "";
    const bar = r.now > 0 ? (() => { const sp = Math.max(0, r.st?.spent ?? 0), t = Math.min(1000, M.tenths(sp, r.now)); return `<span class="meter goal" aria-hidden="true"><span class="fill" style="width:${t / 10}%"></span></span><small>${peso(sp)} spent \u00b7 ${M.showTenths(t)}</small>`; })() : "";
    return `<button class="choice" data-action="open-budget" data-id="${esc(r.c.id)}"><span>${esc(r.c.name)}${bar}${change}${over ? `<small class="overnote">${glyph("critical")} Over budget by ${peso(r.st.spent - r.now)}</small>` : ""}</span><span class="bval">${r.now === null ? "No budget" : peso(r.now) + " a month" + share(r.now)}</span></button>`;
  }).join("");
  const savedHtml = saved.length ? saved.map((r) => `<div class="row"><div>${esc(r.name)}<small>${esc(r.pinned ? "The amount you typed" : r.label)}</small></div><div class="amt">${peso(r.amount)} a month${share(r.amount)}${r.goal_id && !plan ? `<button class="link" data-action="open-goal-monthly" data-id="${esc(r.goal_id)}">Change</button>` : ""}</div></div>`).join("")
    : `<p class="note">${plan ? "Your plan has no savings, goal or buffer lines." : income ? (sug?.code === "NEEDS_RENT" ? "Suggest a budget asks for your rent first, then shows what to set aside." : "Nothing suggested yet. Suggest a budget to see it.") : "Add income first."}</p>`;
  const bk = M.bucketRows({ categories: S().categories, overrides: set.bucket_overrides ?? {}, targets: set.bucket_targets, income: income ?? 0,
    budgets: Object.fromEntries(rows.map((r) => [r.c.id, r.now ?? 0])), goals: savedTotal, buffer: bufferTotal, skipId: M.UNLOGGED_CATEGORY_ID });
  const bucketLine = (r) => `<div class="row" data-bucket="${r.bucket}"><div>${esc(r.label)}${r.target != null ? `<small>Target ${M.showTenths(r.target)}</small>` : ""}</div><div class="amt">${peso(r.amount)} a month${r.tenths != null ? `<small>${M.showTenths(r.tenths)} of income</small>` : ""}</div></div>
    ${r.tenths != null ? `<div class="meter goal" role="img" aria-label="${esc(r.label)}: ${M.showTenths(r.tenths)} of income${r.target != null ? ", target " + M.showTenths(r.target) : ""}"><span class="fill" style="width:${Math.min(100, r.tenths / 10)}%"></span></div>` : ""}`;
  const unsure = M.unclear(S().categories, set.bucket_overrides ?? {}, M.UNLOGGED_CATEGORY_ID);
  const confirmHtml = unsure.length ? `<h3 id="bud-confirm">Which bucket?</h3><p class="note">These names are unclear, so they wait in Other. Tap one answer for each. You can change it in Setup.</p>${unsure.map((c) =>
    `<div class="row"><div>${esc(c.name)}</div></div><div class="chips">${bucketChips(c.id, null)}</div>`).join("")}` : "";
  // The list twin of the bucket bars: the same rows and numbers as a table (tap either one to switch; the choice stays while the app is open).
  const pctOf = (a) => (income ? M.showTenths(M.tenths(a, income)) : "");
  const bucketTable = `<table class="tbl" id="bud-bucket-table"><tr><th>Bucket</th><th class="n">A month</th><th class="n">Of income</th><th class="n">Target</th></tr>${[
    ...bk.rows.map((r) => [esc(r.label), peso(r.amount), pctOf(r.amount), r.target != null ? M.showTenths(r.target) : ""]),
    ...(bk.invested.amount > 0 ? [[esc(bk.invested.label) + "<small>in Savings</small>", peso(bk.invested.amount), pctOf(bk.invested.amount), ""]] : []),
    ...(bk.buffer.amount > 0 ? [[esc(bk.buffer.label) + "<small>not savings</small>", peso(bk.buffer.amount), pctOf(bk.buffer.amount), ""]] : []),
  ].map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</table>`;
  const bucketBars = `${bk.rows.map(bucketLine).join("")}
    ${bk.invested.amount > 0 ? `<div class="row" id="bud-invested"><div>${esc(bk.invested.label)}<small>Counted in Savings. Spent, not held, so never part of the emergency fund.</small></div><div class="amt">${peso(bk.invested.amount)} a month</div></div>` : ""}
    ${bk.buffer.amount > 0 ? `<div class="row" id="bud-buffer"><div>${esc(bk.buffer.label)}<small>Its own line. Not savings.</small></div><div class="amt">${peso(bk.buffer.amount)} a month${bk.buffer.tenths != null ? `<small>${M.showTenths(bk.buffer.tenths)} of income</small>` : ""}</div></div>` : ""}`;
  const bucketsHtml = income ? `<h2>Buckets</h2><p class="sub">${esc(M.TARGET_SOURCE)} Each bucket is shown against its target, as a reference and never as a limit.</p>
    <div class="modebar"><button data-action="bucket-mode" aria-label="${ui.bucketsAsList ? "Show the buckets as bars" : "Show the buckets as a table"}">${ui.bucketsAsList ? "Chart" : "List"}</button></div>
    <div class="flip" id="bud-buckets" data-action="bucket-mode" role="button" tabindex="0" aria-label="${ui.bucketsAsList ? "The table of the buckets. Tap to show the bars." : "Bars of the buckets. Tap to show the table."}">${ui.bucketsAsList ? bucketTable : bucketBars}</div>
    ${bk.unconfirmed.count ? `<p class="note" id="bud-unconfirmed">Includes ${peso(bk.unconfirmed.amount)} from ${bk.unconfirmed.count} unconfirmed ${bk.unconfirmed.count === 1 ? "category" : "categories"} - <button class="link" data-action="goto-confirm">confirm them</button></p>` : ""}
    <p class="note"><button class="link" data-action="open-targets">Change the targets</button>${set.bucket_targets ? ` \u00b7 <button class="link" data-action="clear-targets">Use 50/30/20 again</button>` : ""}</p>${confirmHtml}` : "";
  let sum = "";
  const sh = income ? M.shares(income, spendTotal, savedTotal, bufferTotal) : null;   // the totals lines and the overall line use the SAME three numbers, so they always agree
  if (income) {
    const spentNow = M.spendingByCategory(S(), { month }).total;
    const used = Math.max(0, Math.min(1000, M.tenths(spendTotal + savedTotal + bufferTotal, income)));
    sum = `<div class="meter goal" role="img" aria-label="Spending and saved together are ${M.showTenths(used)} of income"><span class="fill" style="width:${used / 10}%"></span></div>
      <p class="note" id="bud-shares">Spending ${M.showTenths(sh.spending)}, Saved ${M.showTenths(sh.saved)}, ${bufferTotal ? "Buffer " + M.showTenths(sh.buffer) + ", " : ""}${sh.unallocated < 0 ? "Over income by " + peso(-sh.unallocated) : "Unallocated " + peso(sh.unallocated)}</p>
      <p class="note" id="bud-spent">Spent so far: ${M.showTenths(M.tenths(Math.max(0, spentNow), income))} of income</p>`;
  }
  // Like Cash flow: the overview stays on top, and a switch shows one part at a time (Spending, Saved, Buckets). The choice stays while the app is open.
  const bview = ui.budgetView ?? "spending";
  const views = `<div class="seg" role="group" aria-label="What to show">${[["spending", "Spending"], ["saved", "Saved"], ["buckets", "Buckets"]].map(([v, t]) => `<button data-action="budget-view" data-view="${v}" aria-pressed="${bview === v}">${t}</button>`).join("")}</div><div class="viewmark"></div>`;
  const part = bview === "saved" ? `
    <h2>Saved and set aside</h2>${savedHtml}${plan ? "" : `<details class="explain" id="bud-how"><summary>How saving is worked out</summary>${M.savingsExplained(M.resolveSettings(set.suggest_settings ?? {}).settings ?? M.SUGGEST_DEFAULTS).map((x) => `<p class="note">${esc(x)}</p>`).join("")}</details>`}<p class="note" id="bud-saved-total">Total: ${peso(savedTotal)}${sh ? " \u00b7 " + M.showTenths(sh.saved) + " of income" : ""}</p>
    ${bufferRows.map((r) => `<div class="row" id="bud-buffer-line"><div>${esc(r.name)}<small>Its own line. Not savings, so it is not in the total above.</small></div><div class="amt">${peso(r.amount)} a month${share(r.amount)}</div></div>`).join("")}
    <p><button data-action="open-savings" style="width:100%">Add a savings category</button></p>${!plan && shareable.length >= 2 ? `<p class="note"><button class="link" data-action="open-shares">Change the percentages</button> that share what is left between ${shareable.length} goals${set.goal_shares ? ` \u00b7 <button class="link" data-action="clear-shares">Share equally again</button>` : ""}</p>` : ""}` : bview === "buckets" ? (bucketsHtml || `<p class="note">Add your income first: the buckets are shares of it.</p>`) : `
    <h2>Spending</h2>${spendRows}<p class="note" id="bud-spend-total">Total budgeted: ${peso(spendTotal)}${sh ? " \u00b7 " + M.showTenths(sh.spending) + " of income" : ""}</p>`;
  return `<h1>Budget</h1><p class="sub">How much to spend on each kind of thing each month. Tap one to set it.</p>${head}${sum}
    ${views}<div class="viewbody">${part}</div>
    ${byPaydaySection()}
    ${why("A budget never changes the past. A change starts next month unless you choose otherwise.")}`;
}
const runSuggest = () => { const set = ledger.settings; return M.suggestBudgets({ state: S(), plan: planOf(), pin: set.income_base_pin ?? null, today: today(), month: M.monthOf(today()), settings: set.suggest_settings, pins: set.budget_pins ?? {}, rent: set.starter_rent ?? undefined, goalPins: set.goal_monthly ?? {}, goalShares: set.goal_shares ?? {}, overrides: set.bucket_overrides ?? {}, targets: set.bucket_targets }); };
// What the "Yours" box shows: what was typed or taken from the suggestion, else the pinned figure, else the budget in force.
const yoursOf = (x, f) => (f["y_" + x.category_id] !== undefined ? f["y_" + x.category_id] : ledger.settings.budget_pins?.[x.category_id] !== undefined ? (ledger.settings.budget_pins[x.category_id] / 100).toFixed(2) : x.current != null ? (x.current / 100).toFixed(2) : "");
// The figures the owner has in the suggestion sheet, as {category_id: centavos}, plus which were TYPED (those become pins).
function draftOfSuggest() {
  const f = ui.form, draft = {}, typed = {};
  for (const x of f.sug.rows) {
    const raw = yoursOf(x, f);
    if (raw === "" && f["y_" + x.category_id] === undefined) continue;
    const a = raw === "" ? { ok: true, centavos: 0 } : M.parsePesos(raw);
    if (!a.ok) return { error: "Enter amounts like 4000 for " + x.name };
    draft[x.category_id] = a.centavos;
    if (f["y_" + x.category_id] !== undefined && !f.used?.[x.category_id]) typed[x.category_id] = a.centavos;
  }
  return { draft, typed };
}
async function savePinsFromForm() {
  const f = ui.form; if (!f?.sug?.ok) return;
  const d = draftOfSuggest(); if (d.error) return;
  const pins = { ...(ledger.settings.budget_pins ?? {}), ...d.typed };
  for (const id of Object.keys(f.used ?? {})) delete pins[id];
  if (JSON.stringify(pins) !== JSON.stringify(ledger.settings.budget_pins ?? {})) await commit(S(), { ...ledger.settings, budget_pins: pins }, { quiet: true });
}

// "By payday": the pay plan, inside Budget. The plan and the budgets it implies are written by ONE save (M.planWithBudgets), and this says whether they agree.
function byPaydaySection() {
  const plan = planOf(), all = plansOf(), month = M.monthOf(today()), next = M.addMonths(month, 1);
  if (!plan) return "";   // nobody can load a plan file yet, so with no plan there is nothing to show here
  const now = M.planBudgetMismatches(S(), ledger.settings, month), then = M.planBudgetMismatches(S(), ledger.settings, next);
  const miss = now.unmatched.length ? ` No budget for ${esc(now.unmatched.join(", "))}: no spending category has that name.` : "";
  const agree = !now.plan ? "" : then.mismatches.length === 0 ? (now.mismatches.length === 0 ? `<p class="note" id="plan-agree">Your plan and your budgets agree for ${esc(M.monthLabel(month))}.${miss}</p>`
      : `<p class="note" id="plan-agree">Your budgets will match your plan from ${esc(M.monthLabel(next))}.${miss}</p>`)
    : `<p class="note" id="plan-differ"><b>Your budgets differ from your plan:</b> ${esc(then.mismatches.map((m) => `${m.name} budget ${m.budget === null ? "none" : peso(m.budget)}, plan ${peso(m.planned)}`).join("; "))}.${miss}</p>
      <p><button data-action="sync-plan-budgets" style="width:100%">Make the budgets match the plan, from ${esc(M.monthLabel(next))}</button></p>`;
  return `<h2 id="by-payday">By payday</h2><p class="sub">This divides each payday. Budget sets your limit per category for the month.</p><p class="sub">${esc(paydaysLine(plan))}</p>${agree}
    ${planBody(plan, all)}`;
}

// With the new Budget on, saving a plan also sets the budgets it implies (one save). This says which, before anything is saved.
function planBudgetPreview(plan) {
  const { rows, unmatched } = M.planBudgetRows(S(), plan), from = M.budgetMonthFor(plan.effective_from);
  return `<p class="note">Saving also sets these budgets from ${esc(M.monthLabel(from))}: ${rows.length ? esc(rows.map((r) => `${r.name} ${peso(r.amount)}`).join(", ")) : "none"}.${unmatched.length ? ` No budget for ${esc(unmatched.join(", "))}: no spending category has that name.` : ""}</p>`;
}

function viewBudgetOld() {
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
  if (action === "pick-acct") items = cashFirst(items);
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
  const key = [sh.type, sh.id ?? "", sh.queueId ?? ""].join(":"), opening = lastSheetKey !== key, keepAt = lastSheetKey === key ? document.querySelector("#sheet .sheet")?.scrollTop ?? 0 : 0;
  lastSheetKey = key; lockPage(true);
  let body = "";
  if (sh.type === "pay") {
    const p = S().presets.find((x) => x.id === sh.id);
    // The pencil opens the tile editor; tapping an account logs the tile as it is.
    body = `<h3 class="paytitle"><span>${esc(p.name)} ${peso(p.amount)}</span><button class="editbtn" data-action="pay-edit" aria-label="Change this tile"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.edit}</svg></button></h3><p class="note">Paid from</p>${chips(accountsFor(p.id), null, "pay")}`;
  } else if (sh.type === "tile") {
    // Change a tile (name, amount, category), or add one. Saving logs nothing.
    const f = ui.form ?? {}, isNew = !sh.id;
    body = `<h3 class="paytitle"><span>${isNew ? "Add a tile" : "Change this tile"}</span>${isNew ? "" : `<button class="editbtn" data-action="remove-tile" aria-label="Remove this tile"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TRASH}</svg></button>`}</h3>
      ${ui.confirmRemoveTile ? `<p class="note">Remove this tile? <button class="link" data-action="remove-tile-yes">Yes, remove it</button></p>` : `<p class="note small">This changes the tile on the Log screen. Nothing is logged.</p>`}
      <label for="pay-name">Name</label><input id="pay-name" data-field="name" value="${esc(f.name ?? "")}" autocomplete="off">
      <label for="f-amount">Amount (\u20B1)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(f.amount ?? "")}" autocomplete="off">
      <label>Category</label>${chips(expenseCategories(), f.category_id, "pick-cat")}
      <p><button class="primary" id="f-save" data-action="save-tile" style="margin-top:14px" disabled>Save</button></p>`;
  } else if (sh.type === "other") {
    body = `<h3>Add expense</h3>
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
    const rows = M.pickerBanks().map((b) => `<button class="bankrow" data-action="pick-bankrow" data-id="${esc(b.id)}" aria-pressed="${current === b.id}">${iconOf({ name: b.name, bank: b.id, ...(bankPictureOf(b.id) ?? {}) }, 32)}<span>${esc(b.name)}</span>${current === b.id ? '<span class="tick" aria-hidden="true">\u2713</span>' : ""}</button>`).join("");
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
      <p class="note">Together they cannot be more than the wallet holds. Its total stays the same.</p>
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
      <label for="t-start">First day (optional)</label><input id="t-start" data-field="start" type="date" value="${esc(ui.form.start ?? "")}">
      <label for="t-end">Last day (optional, included)</label><input id="t-end" data-field="end" type="date" value="${esc(ui.form.end ?? "")}">
      <p class="note">With dates, entries on those days join by themselves. Without, you start and stop it by hand.</p>
      ${ui.form.error ? `<p id="f-msg" role="alert"><b>${esc(ui.form.error)}</b></p>` : ""}
      <p><button class="primary" id="f-save" data-action="save-trip" style="margin-top:14px" disabled>Save trip</button></p>`;
  } else if (sh.type === "trip-dates") {
    const t = S().tags.find((x) => x.id === sh.id);
    body = `<h3>${esc(t?.name ?? "Trip")}: dates</h3>
      <label for="t-start">First day</label><input id="t-start" data-field="start" type="date" value="${esc(ui.form.start ?? "")}">
      <label for="t-end">Last day (included)</label><input id="t-end" data-field="end" type="date" value="${esc(ui.form.end ?? "")}">
      <p class="note">Entries on these days join the trip, except moves between your accounts, card bill payments and templates. You can add or remove entries by hand.</p>
      ${ui.form.error ? `<p id="f-msg" role="alert"><b>${esc(ui.form.error)}</b></p>` : ""}
      <p><button class="primary" id="f-save" data-action="save-trip-dates" style="margin-top:14px" disabled>Save dates</button></p>
      ${t?.start ? `<p><button class="link" data-action="clear-trip-dates">Take the dates off (start and stop by hand)</button></p>` : ""}`;
  } else if (sh.type === "trip-pick") {
    const member = M.tripMembership(S()), tripName = (tid) => S().tags.find((x) => x.id === tid)?.name;
    const cands = S().transactions.filter((t) => member.get(t.id)?.tag_id !== sh.id).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)).slice(0, 40);
    const rowOf = (t) => { const es = S().entries.filter((e) => e.transaction_id === t.id), spend = es.filter((e) => e.category_id && S().categories.find((c) => c.id === e.category_id)?.kind === "expense"), amt = spend.length ? spend.reduce((n, e) => n + e.amount, 0) : es.filter((e) => e.amount > 0).reduce((n, e) => n + e.amount, 0);
      const other = tripName(member.get(t.id)?.tag_id);
      return `<div class="row"><div>${esc(t.payee || (spend[0] ? categoryName(spend[0].category_id) : "Entry"))}<small>${esc(longDate(t.date))}${spend.length ? "" : " \u00b7 a move or bill payment"}${other ? " \u00b7 now on " + esc(other) : ""}</small></div><div class="amt">${peso(amt)}<br><button class="link" data-action="trip-add" data-id="${esc(t.id)}">Add</button></div></div>`; };
    body = `<h3>Add an entry to this trip</h3><p class="note">The latest 40 entries that are not on it. Adding one works on any date.</p>${cands.map(rowOf).join("") || `<p class="note">Every entry is already on this trip.</p>`}<p><button data-action="close-sheet">Done</button></p>`;
  } else if (sh.type === "income") {
    body = `<h3>Money received</h3>
      <label for="f-amount">Amount received (\u20B1)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off" placeholder="e.g. 9776.98">
      <label for="f-date">Date it arrived</label><input id="f-date" data-field="date" type="date" value="${esc(ui.form.date)}" max="${esc(today())}">
      <label>What it is</label>${chips(incomeCategories(), ui.form.category_id, "pick-cat")}
      <label>Arrived in</label>${chips(accountsFor(null), ui.form.account_id, "pick-acct")}
      <p class="note">Pay, interest or a refund. For a full payslip, use Add a payslip in Income. Saved as verified, since you copy it from paper.</p>
      <p><button class="primary" id="f-save" data-action="save-income" style="margin-top:6px" disabled>Save</button></p>`;
  } else if (sh.type === "plan") {
    body = `<h3>Load a pay plan</h3>
      <p class="note">Choose the plan file or paste its text. It stays on this phone and in your backups.</p>
      <label for="p-file">Plan file</label><input id="p-file" type="file" data-field="file" accept=".json,application/json,text/plain">
      <label for="p-text">Or paste it here</label><textarea id="p-text" data-field="text" rows="5" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(ui.form.text ?? "")}</textarea>
      <div id="p-prev" role="status"></div>
      <p><button class="primary" id="f-save" data-action="save-plan" style="margin-top:10px" disabled>Use this plan</button></p>`;
  } else if (sh.type === "goal") {
    body = `<h3>${sh.savings ? "New savings category" : "New goal"}</h3>${sh.savings ? `<p class="note">Each savings category is a goal. It shares what you set aside each month. You can type its own amount.</p>` : ""}
      <label for="g-name">Name</label><input id="g-name" data-field="name" value="${esc(ui.form.name ?? "")}" autocomplete="off">
      <label for="f-amount">Target (\u20B1, optional)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      <label for="g-date">Finish by (optional)</label><input id="g-date" type="date" data-field="deadline" value="${esc(ui.form.deadline ?? "")}">
      <label>Where the money sits (optional: you can choose it later)</label>${chips(accountsFor(null), ui.form.account_id, "pick-acct")}
      <label>What it is for (optional)</label><div class="chips"><button class="chip" data-action="pick-goal-role" aria-pressed="${ui.form.role === "emergency"}">My emergency fund</button></div>
      <p><button class="primary" id="f-save" data-action="save-goal" style="margin-top:14px" disabled>Save goal</button></p>`;
  } else if (sh.type === "goal-account") {
    const g = S().goals.find((x) => x.id === sh.id);
    body = `<h3>Where does ${esc(g.name)} sit?</h3><p class="note">Choose the account that holds this goal's money. Its balance is the goal's balance.</p>${chips(accountsFor(null), ui.form.account_id, "pick-acct")}
      <p><button class="primary" id="f-save" data-action="save-goal-account" style="margin-top:14px" disabled>Use this account</button></p>`;
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
      <p class="note">1. Entries you missed. Filled in from this week's counts; change it if wrong.</p>
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
  } else if (sh.type === "budget-income") {
    body = `<h3>Income (base)</h3><p class="note">The monthly figure every share is measured against. It stays until you tap "Use my payslips again".</p>
      <label for="f-amount">Per month (\u20B1)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      <p><button class="primary" id="f-save" data-action="save-income-base" style="margin-top:6px" disabled>Use this figure</button></p>`;
  } else if (sh.type === "goal-monthly") {
    const g = S().goals.find((x) => x.id === sh.id), typed = ledger.settings.goal_monthly?.[sh.id] !== undefined;
    body = `<h3>${esc(g.name)}: a month</h3><p class="note">Type how much to set aside for this goal each month. Other goals share what is left.</p>
      <label for="f-amount">Per month (\u20B1)</label><input id="f-amount" data-field="amount" inputmode="decimal" value="${esc(ui.form.amount ?? "")}" autocomplete="off">
      <p><button class="primary" id="f-save" data-action="save-goal-monthly" style="margin-top:6px" disabled>Use this amount</button></p>
      ${typed ? `<p><button data-action="clear-goal-monthly" style="width:100%">Use the suggestion again</button></p>` : ""}`;
  } else if (sh.type === "shares") {
    const goals = sh.ids.map((id) => S().goals.find((g) => g.id === id)).filter(Boolean);
    body = `<h3>Share what is left</h3><p class="note">What is left after typed amounts, finish dates and the emergency fund is shared by these goals. Whole percents adding to 100.</p>
      ${goals.map((g) => `<label for="s-${esc(g.id)}">${esc(g.name)} (%)</label><input id="s-${esc(g.id)}" data-field="s_${esc(g.id)}" inputmode="numeric" value="${esc(ui.form["s_" + g.id] ?? "")}" autocomplete="off">`).join("")}
      <p class="note" id="s-msg" role="status"></p>
      <p><button class="primary" id="f-save" data-action="save-shares" style="margin-top:6px" disabled>Save</button></p>`;
  } else if (sh.type === "targets") {
    const f = ui.form;
    body = `<h3>Bucket targets</h3><p class="note">${esc(M.TARGET_SOURCE)} Whole percents that add up to 100.</p>
      ${[["need", "Needs"], ["want", "Wants"], ["savings", "Savings"]].map(([k, t]) => `<label for="t-${k}">${t} (%)</label><input id="t-${k}" data-field="${k}" inputmode="numeric" value="${esc(f[k] ?? "")}" autocomplete="off">`).join("")}
      <p class="note" id="t-msg" role="status"></p>
      <p><button class="primary" id="f-save" data-action="save-targets" style="margin-top:6px" disabled>Save</button></p>`;
  } else if (sh.type === "budget-suggest") {
    const f = ui.form, r = f.sug, month = M.monthOf(today());
    if (r?.code === "NEEDS_RENT") body = `<h3>Suggest a budget</h3><p class="note">Not enough history yet, so I start from common shares of your pay. I cannot guess your rent.</p>
      <label for="s-rent">What is your monthly rent? (\u20B1, 0 if you pay none)</label><input id="s-rent" data-field="rent" inputmode="decimal" value="${esc(f.rent ?? "")}" autocomplete="off">
      <p><button class="primary" data-action="save-rent" style="margin-top:10px">Continue</button></p>`;
    else if (!r?.ok) body = `<h3>Suggest a budget</h3><p class="note"><b>${esc(r?.message ?? M.NO_INCOME_PROMPT)}</b></p>`;
    else if (f.stage === "review") {
      body = `<h3>Save these budgets?</h3>${f.changes.length ? f.changes.map((c) => `<div class="row"><div>${esc(c.name)}</div><div class="amt">${c.from === null ? "No budget" : peso(c.from)} \u2192 ${c.to === 0 ? "removed" : peso(c.to)}</div></div>`).join("") : `<p class="note">Nothing would change.</p>`}
        <label>From</label><div class="seg" role="group" aria-label="When it starts">${[[month, "This month"], [M.addMonths(month, 1), "Next month"]].map(([m, t]) => `<button data-action="set-start-sug" data-month="${m}" aria-pressed="${f.start === m}">${t}</button>`).join("")}</div>
        <p class="note">${esc(M.monthLabel(f.start))}. Old budgets stay in the history.</p>
        <p><button class="primary" data-action="save-sug"${f.changes.length ? "" : " disabled"}>Save budgets</button></p><p><button data-action="back-sug" style="width:100%">Back</button></p>`;
    } else {
      body = `<h3>Suggest a budget</h3><p class="note">Based on <b>${peso(r.income.amount)} a month</b> (${esc(r.income.text.toLowerCase())}). Nothing is saved until you confirm. Suggestions are rounded to the nearest \u20B150. Typing a figure pins it as yours.${r.history.used === "starter" && ledger.settings.starter_rent != null ? ` Rent: ${peso(ledger.settings.starter_rent)} <button class="link" data-action="change-rent">Change</button>` : ""}</p>
        <p class="note" id="sug-left">${r.short > 0 ? `Your own figures, the rent and the saved lines add up to <b>${peso(r.short)}</b> more than your income.` : `Left unallocated if you use all of them: <b>${peso(r.unallocated)}</b>.`}${r.trimmed.length ? ` Rounding would have gone over your income, so ${esc(r.trimmed.map((t) => `${t.name} was lowered by ${peso(t.by)}`).join(", "))}.` : ""}</p>
        <p><button data-action="use-all-sug" style="width:100%">Use all suggestions</button></p>
        ${r.rows.map((x) => { const why = rowWhy(x); return `<div class="bcard"><div class="btop"><span class="bname">${esc(x.name)}</span><span class="bval">Suggested <b>${x.suggested === null ? "none" : peso(x.suggested)}</b></span></div>
          ${why ? `<p class="note"><i>${esc(why)}</i></p>` : ""}
          <label for="y_${esc(x.category_id)}">Yours (\u20B1 a month)</label><input id="y_${esc(x.category_id)}" data-field="y_${esc(x.category_id)}" inputmode="decimal" value="${esc(yoursOf(x, f))}" autocomplete="off">
          ${x.suggested === null ? "" : `<p><button class="link" data-action="use-sug" data-id="${esc(x.category_id)}">Use this</button></p>`}</div>`; }).join("")}
        ${r.others.length ? `<p class="note">Also in the suggestion, but not a category budget: ${esc(r.others.map((o) => o.name + " " + peso(o.amount)).join(", "))}.</p>` : ""}
        <p><button data-action="use-all-sug" style="width:100%">Use all suggestions</button></p>
        <p><button class="primary" data-action="review-sug">Confirm</button></p>
        ${tipsBlock(r.history.used === "starter")}`;
    }
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
    body = `<h3>${sh.editId ? "Change this payslip" : "Add a payslip"}</h3>
      ${sh.scanBlob ? `<button class="shotbtn enlarge" data-action="view-shot" aria-label="Open the photo full size to compare it with the figures"><img class="shot" src="${esc(pendingPhoto?.url ?? "")}" alt="Your payslip photo" style="max-height:18vh;object-fit:contain"></button>${(f.notes ?? []).map((n) => `<p class="note small">${esc(n)}</p>`).join("")}` : ""}
      <p id="p-match" hidden><button class="link" data-action="open-lines">Matches paper. Tap to open.</button></p>
      <div id="p-lines">
      <details class="tot" data-keep="e"${open("e")}><summary><span class="tl">Total earnings<small>Tap to see the lines</small></span><b id="p-tot-e" class="tv"></b><span class="tchev" aria-hidden="true">\u203A</span></summary>
        ${M.EARNINGS.map((k) => field("e_", k)).join("")}
        <label for="p-otm">Overtime was earned in</label><select id="p-otm" data-field="ot_month">${months.map((m) => `<option value="${m}"${f.ot_month === m ? " selected" : ""}>${esc(M.monthLabel(m))}</option>`).join("")}</select>
      </details>
      <details class="tot" data-keep="d"${open("d")}><summary><span class="tl">Total deductions<small>Tap to see the lines</small></span><b id="p-tot-d" class="tv"></b><span class="tchev" aria-hidden="true">\u203A</span></summary>
        ${M.DEDUCTIONS.map((k) => field("d_", k)).join("")}
      </details>
      </div>
      <label>Landed in</label>${chips(accountsFor(null), f.account_id, "pick-acct")}
      <label for="p-emp">Employer</label><input id="p-emp" data-field="employer" value="${esc(f.employer ?? "")}" autocomplete="off">
      <label for="p-from">Pay period from</label><input id="p-from" data-field="period_from" type="date" value="${esc(f.period_from)}">
      <label for="p-to">Pay period to</label><input id="p-to" data-field="period_to" type="date" value="${esc(f.period_to)}">
      <label for="p-date">Pay date</label><input id="p-date" data-field="pay_date" type="date" value="${esc(f.pay_date)}">
      <details data-keep="t"${open("t")}><summary>As printed on the payslip</summary>
        <label for="p-gross">Gross pay (\u20B1)</label><input id="p-gross" data-field="gross" inputmode="decimal" value="${esc(f.gross ?? "")}" autocomplete="off">
        <label for="p-net">Net pay (\u20B1)</label><input id="p-net" data-field="net" inputmode="decimal" value="${esc(f.net ?? "")}" autocomplete="off">
        <label for="p-ded">Total deductions (\u20B1), if printed (optional)</label><input id="p-ded" data-field="ded" inputmode="decimal" value="${esc(f.ded ?? "")}" autocomplete="off">
        <label for="p-dep">What really arrived in the account (\u20B1)</label><input id="p-dep" data-field="deposit" inputmode="decimal" value="${esc(f.deposit ?? "")}" autocomplete="off">
        <label for="p-words">Net pay in words, if written (optional)</label><input id="p-words" data-field="words" value="${esc(f.words ?? "")}" autocomplete="off" autocapitalize="off">
      </details>
      <div id="p-flags" role="status"></div>
      <p id="p-fold" hidden><button class="link" data-action="fold-lines">Checked against the photo? Fold the fields.</button></p>
      <p class="note">Do not type any employee, tax or account number.</p>
      <p><button class="primary" id="f-save" data-action="save-payslip" style="margin-top:14px" disabled>${sh.editId ? "Save changes" : "Save payslip"}</button></p>
      ${sh.queueId ? `<p><button data-action="discard-scan" data-id="${esc(sh.queueId)}" style="width:100%">Throw this photo away</button></p>` : ""}`;
  } else if (sh.type === "scanpick") {
    body = `<h3>Scan</h3><p class="note">A receipt, payment screen or payslip. Take a photo or choose one. If the app is sure, it saves a draft; otherwise it asks.</p>${photoButtons("quick")}
      <p class="note">Old spending from somewhere else: a screenshot of your notes, or a CSV or Excel (.xlsx) file. Every line waits in Verify.</p>
      <label class="filebtn alt" id="imp-pick">Import old spending<input type="file" accept="image/*,.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-import="1" hidden></label>`;
  } else if (sh.type === "import") {
    const f = ui.form;
    if (f.busy) body = `<h3>Import old spending</h3><p class="note" id="imp-msg" role="status">${esc(f.busy)}</p>`;
    else if (f.error) body = `<h3>Import old spending</h3><p class="note" role="alert"><b>${esc(f.error)}</b></p>`;
    else {
      const p = f.order ? M.previewImport(S(), f.items, f.order) : null, acct = S().accounts.find((a) => a.id === f.account_id);
      const sample = f.items.find((x) => M.readDate(x.dateRaw) && !M.readDate(x.dateRaw).iso)?.dateRaw;
      const orderLine = sample ? `<p class="note" id="imp-order">${f.order ? `Dates read as <b>${f.order === "dmy" ? "day/month" : "month/day"}</b>: ${esc(sample)} is <b>${esc(longDate(M.previewImport(S(), [{ dateRaw: sample, name: "x", amount: 1 }], f.order).lines[0]?.date ?? today()))}</b>.` : `<b>Which comes first in ${esc(sample)}?</b>`}</p>
        <div class="seg" role="group" aria-label="Date order">${[["dmy", "Day / month"], ["mdy", "Month / day"]].map(([o, t]) => `<button data-action="import-order" data-id="${o}" aria-pressed="${f.order === o}">${t}</button>`).join("")}</div>` : "";
      body = `<h3>Import old spending</h3>${orderLine}
        <label>Paid from</label>${chips(accountsFor(null), f.account_id, "pick-acct")}
        ${p ? `<p class="note" id="imp-count"><b>${p.lines.length} ${p.lines.length === 1 ? "line" : "lines"}</b> to add as drafts${p.duplicates.length ? `; ${p.duplicates.length} already logged, left out` : ""}${p.undated.length + f.notRead.length ? `; ${p.undated.length + f.notRead.length} not read` : ""}.</p>
          <div class="mlist" id="imp-lines">${p.lines.slice(0, 12).map((l) => `<div class="mrow mline"><span class="mn">${esc(longDate(l.date))} \u00b7 ${esc(l.name)}<small>${esc(categoryName(l.category_id))} (${esc(l.how)})</small></span><span class="mv">${peso(l.amount)}</span></div>`).join("")}${p.lines.length > 12 ? `<div class="mrow mline"><span class="mn">and ${p.lines.length - 12} more</span></div>` : ""}</div>
          ${f.notRead.length ? `<details><summary>Not read (${f.notRead.length})</summary>${f.notRead.slice(0, 20).map((l) => `<p class="note">${esc(l)}</p>`).join("")}</details>` : ""}
          ${acct ? `<p class="note">Lines dated before you added ${esc(acct.name)} are history only: they do not change its balance.</p>` : ""}
          <p><button class="primary" id="f-save" data-action="save-import"${p.lines.length && acct ? "" : " disabled"}>Add ${p.lines.length} ${p.lines.length === 1 ? "draft" : "drafts"} to Verify</button></p>` : ""}`;
    }
  } else if (sh.type === "payslipchoice") {
    body = `<h3>Add income</h3>
      <p class="note">A payslip:</p>
      <p><button class="primary" data-action="open-payslip">Type a payslip</button></p>
      <p class="note">Or read it from a photo (you check every figure before it is saved):</p>${photoButtons("payslip")}
      <p class="note">Something else:</p>
      <p><button data-action="open-income" style="width:100%">Other income</button></p>`;
  } else if (sh.type === "voice") {
    body = `<h3>Say it</h3>
      <p class="note">One sentence, like: lunch 95 at Sample Burger using GCash. You can say the day too, like yesterday.</p>
      ${speechSupported() ? `<p><button class="primary micmain" id="v-mic" data-action="voice-toggle" style="margin-top:12px">${micLabel("Tap and speak")}</button><div class="wave" id="v-wave" aria-hidden="true">${"<i></i>".repeat(13)}</div></p>` : `<p class="note">Speech is not available here. Type below, or use your keyboard's microphone key.</p>`}
      <label for="v-text">What I heard (fix it, type it, or use the keyboard's microphone key)</label>
      <textarea id="v-text" data-field="spoken" rows="3" autocomplete="off" autocapitalize="sentences">${esc(ui.form.spoken ?? "")}</textarea>
      <p id="v-msg" class="note" role="status"></p>
      <p class="note">Apple's or Google's service turns speech into words, so the audio leaves your phone while you speak. Your ledger and photos never do.</p>
      <p><button class="primary" id="f-save" data-action="use-spoken" style="margin-top:6px" disabled>Use this</button></p>`;
  } else if (sh.type === "scan") {
    const f = ui.form, kind = M.kindById(f.kind), into = kind.direction === "in";
    body = `<h3>${sh.voice ? "Check what I heard" : "Check what I read"}</h3>
      ${sh.voice ? `<p class="note">You said: \u201C${esc(f.text)}\u201D</p>` : `<button class="shotbtn" data-action="view-shot" aria-label="Open the photo full size to compare it with what was read"><img class="shot" src="${esc(pendingPhoto?.url ?? "")}" alt="Your photo"></button>`}
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
      <p class="note" id="scan-why" role="status"></p>
      <p><button class="primary" id="f-save" data-action="save-scan" style="margin-top:14px" disabled>Save to Verify</button></p>
      <p class="note">It stays a draft and counts toward nothing until you verify it.</p>
      ${sh.queueId ? `<p><button data-action="discard-scan" data-id="${esc(sh.queueId)}" style="width:100%">Throw this photo away</button></p>` : ""}`;
  } else if (sh.type === "txdetail") {
    const t = S().transactions.find((x) => x.id === sh.id), d = t ? describe(t) : null;
    if (!t) { body = `<h3>Entry</h3><p class="note">This entry is no longer here.</p>`; }
    else {
      const acct = S().accounts.find((x) => x.id === d.account_id), shot = M.attachmentsFor(S(), t.id)[0];
      const source = t.source === "photo" ? "Read from a photo" : t.source === "voice" ? "Made from what you said" : "Typed in";
      const rows = [["Date", fullDate(t.date)], ["Status", t.status === "draft" ? "Draft, waiting in Verify" : "Verified"], ["How it was entered", source],
        ...(d.kind === "split" ? d.parts.map((x) => [x.name, peso(x.amount)]) : d.category_id ? [["Category", categoryName(d.category_id)]] : []),
        ...(d.kind === "transfer" ? [["Between", d.detail]] : []), ...(t.memo ? [["What was said or noted", "\u201C" + t.memo + "\u201D"]] : [])];
      body = `<h3>${esc(d.title)}</h3><p class="bigamt">${peso(d.amount)}</p>
        <dl class="txdl">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}${acct ? `<dt>${d.kind === "income" ? "Arrived in" : "Paid from"}</dt><dd class="who">${withIcon(acct, 22)}</dd>` : ""}</dl>
        ${shot ? `<p><button class="primary" data-action="open-photo" data-id="${esc(shot.id)}">See the photo</button></p>` : ""}`;
    }
  } else if (sh.type === "payslips") {
    const [pf, pt] = periodBounds(period());
    const loose = M.incomeWithoutPayslip(S(), { from: pf, to: pt });
    body = `<h3>Payslips, ${esc(periodLabel(period()))}</h3>${payslipRows({ from: pf, to: pt })}${loose.length ? `<h3>Added without a payslip</h3><p class="note">These count as income but have no payslip, for example a payslip photo saved as plain pay. Remove one if it is a double.</p>${loose.map((r) => `<div class="row"><div>${esc(r.payee || "Pay received")}<small>${esc(fullDate(r.date))}${r.account_id ? " · into " + esc(accountName(r.account_id)) : ""}</small></div><div class="amt">${peso(r.amount)}</div></div>${ui.confirmDelInc === r.transaction_id ? `<p class="note">Remove this entry? ${peso(r.amount)} also comes out of ${esc(r.account_id ? accountName(r.account_id) : "the account")}. <button class="link" data-action="del-inc-yes" data-id="${esc(r.transaction_id)}">Yes, remove it</button></p>` : `<p class="note"><button class="link" data-action="del-inc" data-id="${esc(r.transaction_id)}">Remove this entry</button></p>`}`).join("")}` : ""}`;
  } else if (sh.type === "photo") {
    body = `<h3>Photo</h3><img class="shotfull" data-photo="${esc(sh.id)}" alt="The photo this entry was read from" hidden>`;
  } else if (sh.type === "icon") {
    const a = S().accounts.find((x) => x.id === sh.id);
    body = `<h3>Picture for ${esc(a.name)}</h3>
      <label for="i-bank">Which bank is it?</label>
      <button id="i-bank" class="bankpick" data-action="open-banks" data-for="${esc(a.id)}">${a.bank ? `${iconOf({ name: M.bankById(a.bank).name, bank: a.bank }, 28)}<span>${esc(M.bankById(a.bank).name)}</span>` : `<span class="muted">Not linked to a bank</span>`}<span class="chev" aria-hidden="true">\u203A</span></button>
      <p class="note">Accounts of one bank share the picture. Screenshot the app's icon, choose it here, then zoom and drag until it fills the square.</p>
      <input id="i-file" type="file" accept="image/*" data-field="file" aria-label="Choose a picture">
      <div id="i-stage" class="stage"><img id="i-img" alt="" hidden></div>
      <label for="i-zoom">Zoom</label><input id="i-zoom" data-field="zoom" type="range" min="1" max="4" step="0.01" value="1" disabled>
      <p id="f-msg" role="alert" class="note"></p>
      <p><button class="primary" id="f-save" data-action="save-icon" disabled>Use this picture</button></p>
      ${a.icon || a.icon_url || bankLogo(a.bank ?? M.bankForName(a.name)?.id) ? `<p><button data-action="clear-icon" style="width:100%">Remove the picture</button></p>` : ""}`;
  } else if (sh.type === "backup") {
    body = `<h3>Back up now</h3>
      <p class="note">Choose a passphrase of at least ${M.MIN_PASSPHRASE} characters. Without it nobody can open the backup, not even me. Your phone may offer to make a strong one and keep it in Passwords: accept that. Or tap "Make one for me" and save it yourself. This app never keeps your passphrase.</p>
      <input class="sr" type="text" name="username" autocomplete="username" value="Finance backup" readonly tabindex="-1" aria-hidden="true">
      <label for="b-pass">Passphrase</label><input id="b-pass" data-field="pass" name="password" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" value="${esc(ui.form.pass ?? "")}">
      <label for="b-pass2">Passphrase again</label><input id="b-pass2" data-field="pass2" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" value="${esc(ui.form.pass2 ?? "")}">
      <p><button data-action="make-passphrase" style="width:100%">Make one for me</button></p>
      ${ui.form.made ? `<p class="note">Your passphrase. Save it in Passwords (name it Finance backup), or write it on paper:</p><p class="passbox" id="b-made">${esc(ui.form.made)}</p><p><button data-action="copy-passphrase" style="width:100%">Copy it</button></p>` : ""}
      <p id="f-msg" role="alert" class="note"></p>
      <p><button class="primary" id="f-save" data-action="make-backup" disabled>Create backup file</button></p>
      <p class="note">Next, choose where to keep the file, like Save to Files. It is encrypted, so iCloud Drive or a flash drive is safe.</p>`;
  } else if (sh.type === "howto") {
    const h = M.HOWTOS.find((x) => x.id === sh.id);
    body = `<h3>${esc(h.label)}</h3>${clipFor(h.id)}<p class="hwcap">${esc(h.caption)}</p>`;
  } else if (sh.type === "whatsnew") {
    const moved = sh.changes?.length ? `<p class="note" id="wn-balances"><b>Balances that changed:</b> ${sh.changes.map((x) => `${esc(x.name)} ${x.by > 0 ? "+" : "\u2212"}${peso(Math.abs(x.by))}`).join(", ")}. Spending dated before the day you added these accounts was being taken off twice; it now stays as history only.</p>` : "";
    body = `<h3>What's new</h3><ul class="notes">${M.whatsNew({}, 3).map((c) => `<li><b>${esc(longDate(c.date))}</b> ${esc(c.text)}</li>`).join("")}</ul>${moved}
      <p class="note">${esc(M.HOWTO_HINT)} Help keeps the full list.</p>
      <p><button class="primary" data-action="close-sheet">Got it</button></p>`;
  } else if (sh.type === "bucket-pick") {
    const c = S().categories.find((x) => x.id === sh.id), mine = ledger.settings.bucket_overrides?.[sh.id], read = M.readBucket(c.name).bucket;
    body = `<h3>${esc(c.name)}</h3><p class="note">${read ? `The name reads as ${M.BUCKET_LABELS[read]}.` : "The name does not say clearly."} ${mine ? `You set it to ${M.BUCKET_LABELS[mine]}.` : ""}</p>
      <div class="chips">${M.CHOICES.map((b) => `<button class="chip" data-action="set-bucket" data-bucket="${b}" aria-pressed="${M.bucketOf(c, ledger.settings.bucket_overrides ?? {}) === b}">${b === "other" ? "Keep in Other" : M.BUCKET_LABELS[b]}</button>`).join(" ")}</div>
      ${mine && read ? `<p><button data-action="set-bucket" data-bucket="" style="width:100%">Read it from the name again (${M.BUCKET_LABELS[read]})</button></p>` : ""}`;
  } else if (sh.type === "bucket-clash") {
    const c = S().categories.find((x) => x.id === sh.id);
    body = `<h3>${esc(c.name)}</h3><p class="note">You set this to ${M.BUCKET_LABELS[sh.mine]}. The new name reads as ${M.BUCKET_LABELS[sh.read]}.</p>
      <p><button class="primary" data-action="set-bucket" data-bucket="${sh.mine}">Keep ${M.BUCKET_LABELS[sh.mine]}</button></p>
      <p><button data-action="set-bucket" data-bucket="" style="width:100%">Use ${M.BUCKET_LABELS[sh.read]}</button></p>`;
  } else if (sh.type === "cat") {
    body = `<h3>${sh.id ? "Rename this category" : "Add a category"}</h3>
      <label for="c-name">Name</label><input id="c-name" data-field="name" value="${esc(ui.form.name ?? "")}" autocomplete="off" enterkeyhint="done">
      <p class="note">${sh.id ? "Its entries, budget and everything else stay with it." : "For spending. You can rename it later."}</p>
      ${sh.id ? "" : `<p class="note" id="c-read">${esc(readLine(ui.form.name))}</p><div class="chips" id="c-bucket"${M.readBucket(ui.form.name).bucket === null && (ui.form.name ?? "").trim() ? "" : ' style="display:none"'}>${bucketChips(null, ui.form.bucket, "pick-new-bucket")}</div>`}
      <p><button class="primary" id="f-save" data-action="save-cat" style="margin-top:14px" disabled>Save</button></p>`;
  } else if (sh.type === "sweeporder") {
    const f = ui.form, goals = S().goals, picked = f.order ?? [];
    body = `<h3>Where the leftover goes</h3>
      <p class="note">At month end, what is left in the buffer fills your goals in the order you tap. Each is filled to its target; the last takes the rest.</p>
      ${goals.length ? `<div class="chips">${goals.map((g) => `<button class="chip" data-action="pick-sweep" data-id="${esc(g.id)}" aria-pressed="${picked.includes(g.id)}">${picked.includes(g.id) ? picked.indexOf(g.id) + 1 + " \u00b7 " : ""}${esc(g.name)}</button>`).join("")}</div>`
        : `<p class="note">Add goals first (Menu, Budget, Goals).</p>`}
      ${picked.slice(0, -1).map((id) => { const g = goals.find((x) => x.id === id); return `<label for="t_${esc(id)}">Fill ${esc(g.name)} up to (\u20B1). Empty: its own target${g.target != null ? ", " + peso(g.target) : ", none"}</label><input id="t_${esc(id)}" data-field="t_${esc(id)}" inputmode="decimal" value="${esc(f["t_" + id] ?? "")}" autocomplete="off">`; }).join("")}
      <p class="note" id="sweep-msg" role="status"></p>
      <p><button class="primary" id="f-save" data-action="save-sweep" style="margin-top:14px" disabled>Save</button></p>`;
  } else if (sh.type === "notice") {
    body = `<h3>${esc(M.FIRST_RUN_NOTICE.title)}</h3>${figure("data")}<ol class="notes">${M.FIRST_RUN_NOTICE.lines.map((n) => `<li>${esc(n)}</li>`).join("")}</ol>
      <p><button class="primary" data-action="close-sheet">I understand</button></p>`;
  } else if (sh.type === "restore" && !ui.form.restored) {
    body = `<h3>${sh.check ? "Check a backup file" : "Restore from a backup"}</h3>
      ${sh.check ? `<p class="note">This opens the file to prove the passphrase works. Nothing on this phone changes.</p>` : `<p class="note">This replaces everything on this phone with the backup.</p>
      <p class="note">Receipt and payslip pictures are not in a backup. Entries come back without them.</p>`}
      <label for="r-file">Backup file</label><input id="r-file" data-field="file" type="file" accept=".json,application/json">
      <input class="sr" type="text" name="username" autocomplete="username" value="Finance backup" readonly tabindex="-1" aria-hidden="true">
      <label for="r-pass">Passphrase</label><input id="r-pass" data-field="pass" name="password" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false">
      <p id="f-msg" role="alert" class="note"></p>
      <p><button class="primary" id="f-save" data-action="open-backup-file" disabled>${sh.check ? "Check backup" : "Open backup"}</button></p>`;
  } else if (sh.type === "restore") {
    const b = M.summarizeLedger(ui.form.restored), now = M.summarizeLedger(ledger);
    const count = (n, one, many) => n + " " + (n === 1 ? one : many);
    const line = (x) => `${count(x.accounts, "account", "accounts")}, ${x.transactions ? count(x.transactions, "entry", "entries") : "no entries"}${x.latest_date ? ", latest " + longDate(x.latest_date) : ""}`;
    if (sh.check) body = `<h3>This backup opens</h3>
      <div class="card" style="border:0;padding:0"><dl><dt>The backup</dt><dd>${esc(line(b))}${b.saved_at ? "<br>saved " + esc(longDate(b.saved_at.slice(0, 10))) : ""}</dd></dl></div>
      <p class="note">The passphrase works. Nothing on this phone was changed.</p>`;
    else body = `<h3>Replace this phone's data?</h3>
      <div class="card" style="border:0;padding:0"><dl><dt>The backup</dt><dd>${esc(line(b))}${b.saved_at ? "<br>saved " + esc(longDate(b.saved_at.slice(0, 10))) : ""}</dd><dt>This phone</dt><dd>${esc(line(now))}</dd></dl></div>
      <p class="note">Anything entered since this backup was made will be gone. Pictures are not in a backup, so those entries will say "picture not on this phone".</p>
      <p><button class="primary" id="f-save" data-action="restore-now">${ui.form.confirmRestore ? "Tap again to replace" : "Replace this phone's data"}</button></p>`;
  }
  const closer = sh.type === "notice" ? "" : `<p><button data-action="close-sheet" style="width:100%">${sh.type === "photo" || sh.type === "txdetail" || sh.type === "payslips" || sh.type === "howto" || sh.type === "whatsnew" ? "Close" : "Cancel"}</button></p>`;   // the first-run notice has one answer, I understand
  $("sheet").innerHTML = `<div id="scrim"${opening ? ' class="enter"' : ""} data-action="close-sheet"></div><div class="sheet${opening ? " enter" : ""}" role="dialog">${body}${closer}</div>`;
  const box = document.querySelector("#sheet .sheet"); if (box && keepAt) box.scrollTop = keepAt;
  if (voiceListener && sh.type === "voice") { const b = $("v-mic"); if (b) b.innerHTML = micLabel("Listening in " + LANG_NAME[ui.form.lang ?? firstLanguage()] + "... tap to stop"); setWave(true); }
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
  } else if (type === "tile") {
    const a = M.parsePesos(f.amount ?? "");
    btn.disabled = !(a.ok && a.centavos > 0 && (f.name ?? "").trim() && f.category_id);
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
    const acct = S().accounts.find((a) => a.id === f.account_id), held = acct ? M.naturalBalance(acct, M.countedEntries(S())) : 0;
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
    btn.disabled = !((f.name ?? "").trim() && a.ok && Boolean(f.start) === Boolean(f.end));
  } else if (type === "trip-dates") {
    btn.disabled = !(f.start && f.end);
  } else if (type === "goal-monthly") {
    const a = M.parsePesos(f.amount ?? "");
    btn.disabled = !(a.ok && a.centavos >= 0);
  } else if (type === "shares") {
    const r = M.parseShares(ui.sheet.ids, Object.fromEntries(ui.sheet.ids.map((id) => [id, f["s_" + id] ?? ""]))), msg = $("s-msg");
    if (msg) msg.textContent = r.ok || ui.sheet.ids.some((id) => !(f["s_" + id] ?? "")) ? "" : r.message;
    btn.disabled = !r.ok;
  } else if (type === "targets") {
    const r = M.parseTargets({ need: f.need ?? "", want: f.want ?? "", savings: f.savings ?? "" }), msg = $("t-msg");
    if (msg) msg.textContent = r.ok ? "" : (f.need && f.want && f.savings ? r.message : "");
    btn.disabled = !r.ok;
  } else if (type === "budget-income") {
    const a = M.parsePesos(f.amount ?? "");
    btn.disabled = !(a.ok && a.centavos > 0);
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
      const matches = lines.length && p.printed_gross && p.printed_net && p.deposit && !flags.length && (!p.printed_deductions || p.printed_deductions === t.deductions) && !p.errors.length;
      const box = $("p-lines"), tap = $("p-match");
      if (box && tap) { const collapse = matches && !ui.linesOpen && !box.contains(document.activeElement); box.hidden = collapse; tap.hidden = !collapse; }
      const fold = $("p-fold"); if (fold) fold.hidden = !(matches && ui.linesOpen && ui.sheet.scanBlob);   // a photo's figures fold only when the owner says they were checked
      const same = M.samePeriodPayslips(S(), { employer: f.employer, period_from: f.period_from, period_to: f.period_to }, ui.sheet.editId ?? null);
      const sameNet = same.find((x) => x.deposit === p.deposit);
      const repeat = !same.length ? "" : sameNet ? `<p class="note flag">▲ You already saved this payslip (same employer, same period, same net pay ${peso(sameNet.deposit)}). It cannot be saved twice. If it is a different payslip, change the dates or the net pay.</p>`
        : `<p class="note">You already saved ${same.length === 1 ? "a payslip" : same.length + " payslips"} from ${esc(f.employer.trim())} for this period (net ${peso(same[0].deposit)}). Saving adds another one.</p>`;
      out.innerHTML = repeat + (lines.length ? `<p class="note">The lines add to gross ${peso(t.gross)}; minus deductions, net ${peso(t.net)}.</p>` : "") + (p.errors.length ? `<p class="note flag">\u25B2 Check the amount typed for: ${esc(p.errors.join(", "))}.</p>` : "") + flags.map(flagLine).join("");
    }
  } else if (type === "voice") {
    btn.disabled = !(f.spoken ?? "").trim();
  } else if (type === "scan") {
    const a = M.parsePesos(f.amount), second = M.parsePesos(f.split_amt ?? "");
    const splitOk = !f.split || (f.split_cat && f.split_cat !== f.category_id && second.ok && second.centavos > 0 && a.ok && second.centavos < a.centavos);
    const note = $("split-note");
    if (note) note.textContent = splitOk && f.split ? categoryName(f.category_id) + " gets " + peso(a.centavos - second.centavos) + ", " + categoryName(f.split_cat) + " gets " + peso(second.centavos) + "." : "Choose the second category and its amount, which must be less than the total.";
    btn.disabled = !(a.ok && a.centavos > 0 && M.isPhDate(f.date) && f.category_id && f.account_id && splitOk);
    const why = $("scan-why");   // a greyed button must say what it is waiting for
    if (why) why.textContent = !(a.ok && a.centavos > 0) ? "Enter the amount to save." : !M.isPhDate(f.date) ? "Choose the date to save." : !f.category_id ? "Choose a category to save." : !f.account_id ? "Choose the account it " + (M.kindById(f.kind).direction === "in" ? "arrived in" : "was paid from") + " to save." : !splitOk ? "Finish the split to save." : "";
  } else if (type === "cat") {
    btn.disabled = !(f.name ?? "").trim();
    const rl = $("c-read"), chips = $("c-bucket");   // the reading follows the name as it is typed (the typing box is not redrawn)
    if (rl) rl.textContent = readLine(f.name);
    if (chips) chips.style.display = !(f.name ?? "").trim() || M.readBucket(f.name).bucket !== null ? "none" : "";
  } else if (type === "sweeporder") {
    const bad = (f.order ?? []).slice(0, -1).some((id) => { const raw = (f["t_" + id] ?? "").trim(); if (!raw) return false; const a = M.parsePesos(raw); return !a.ok || a.centavos < 0; });
    const msg = $("sweep-msg"); if (msg) msg.textContent = bad ? "Enter a target like 20000, or leave it empty." : "";
    btn.disabled = !(f.order ?? []).length || bad;
  } else if (type === "income") {
    const a = M.parsePesos(f.amount);
    btn.disabled = !(a.ok && a.centavos > 0 && f.account_id && f.date);
  } else if (type === "plan") {
    const r = (f.text ?? "").trim() ? M.parsePlan(f.text) : null, out = $("p-prev");
    btn.disabled = !r?.ok;
    if (out) out.innerHTML = !r ? "" : r.ok
      ? `<p class="note"><b>Looks good:</b> starts ${esc(longDate(r.plan.effective_from))}, ${r.plan.paydays.length === 1 ? "payday on " + esc(paydayText(r.plan.paydays[0].day)) : "paydays on " + esc(paydayText(r.plan.paydays[0].day)) + " and " + esc(paydayText(r.plan.paydays[1].day))}, ${r.plan.lines.length} lines, ${peso(M.planTotals(r.plan).month)} a month.</p>${ledger.settings.try_new_budget ? planBudgetPreview(r.plan) : ""}`
      : `<p role="alert" class="note"><b>${esc(r.error)}</b></p>`;
  } else if (type === "goal") {
    const a = f.amount ? M.parsePesos(f.amount) : { ok: true };
    btn.disabled = !((f.name ?? "").trim() && a.ok);
  } else if (type === "goal-account") {
    btn.disabled = !f.account_id;
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

// New entries go on today, or on the earlier day picked at the top of the Log screen (to log what was not logged then).
const logDay = () => (ui.dayPick && ui.dayPick < today() ? ui.dayPick : today());
async function logExpense(input, label) {
  const tag_id = S().tags.some((t) => t.id === ledger.settings.active_tag_id) ? ledger.settings.active_tag_id : undefined;
  const g = gcashOf();
  let drafts, note;
  const swapLines = (d) => (input.lines ? { transaction: d.transaction, entries: M.splitCategoryEntry(d.entries, d.transaction.id, input.lines) } : d);   // a split keeps every other rule of the purchase
  if (g && input.account_id === g.account_id) {
    // Spending from the buffer's account takes from the allowance first, then the buffer (spec 6.4).
    const p = M.planGcashSpend(S(), { transaction_id: input.transaction_id, date: input.date ?? logDay(), payee: input.payee ?? "", category_id: input.category_id, amount: input.amount,
      gcash_account_id: g.account_id, allowance_envelope_id: g.allowance_id, buffer_envelope_id: g.buffer_id }, new Date());
    if (!p.ok) { showToast("Could not save: " + p.violations[0].message); return false; }
    drafts = [swapLines({ transaction: { ...p.transaction, source: input.source ?? "manual", ...(input.source === "photo" ? { edited_before_verify: false } : {}), ...(input.payee ? { payee: input.payee } : {}), ...(tag_id ? { trip_add: tag_id } : {}) }, entries: p.entries })];
    note = bufferNote(p.violations);
  } else {
    const args = { ...input, tag_id, date: input.date ?? logDay(), reserve_source_id: ledger.settings.reserve_source_id };
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
    case "tab": $("toast").innerHTML = ""; ui.menu = false; ui.tripId = null; ui.tab = tab; ui.sheet = null; ui.confirmDelete = null; ui.confirmRemove = null; ui.sel = null; renderAll(); break;
    case "period-step": {
      const p = period(), step = Number(el.dataset.step);
      ui.period = p.kind === "year" ? { kind: "year", year: p.year + step } : { kind: "month", month: M.addMonths(p.month, step) };
      ui.sel = null; renderScreen(); break;
    }
    case "period-this-month": ui.period = null; renderScreen(); break;
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
    case "toggle-entries": ui.entriesAnim = true; try { sessionStorage.setItem("logOpen", logOpen() ? "0" : "1"); } catch { /* private mode: it just stays closed */ } renderScreen(); break;
    case "budget-view": ui.budgetView = el.dataset.view; renderScreen(); break;
    case "bucket-mode": ui.bucketsAsList = !ui.bucketsAsList; renderScreen(); break;
    case "chart-mode": ui.asList = el.dataset.mode === "list"; renderScreen(); break;
    case "open-month": ui.period = { kind: "month", month: id }; ui.view = "budget"; ui.sel = null; ui.asList = false; renderScreen(); break;
    case "pick-bar": ui.sel = ui.sel === id ? null : id; renderScreen(); break;
    case "sync-plan-budgets": {
      const month = M.addMonths(M.monthOf(today()), 1), plan = M.planInEffect(plansOf(), month + "-01");
      if (!plan) break;
      const w = M.planWithBudgets(S(), ledger.settings, { plan, newId: () => newId("rule"), start: month, addPlanRow: false });
      if (!w.ok) { showToast("Could not save: " + w.message); break; }
      await commit(w.state, w.settings);
      showToast((w.changes.length === 1 ? "1 budget" : w.changes.length + " budgets") + " set from " + M.monthLabel(month) + ".");
      break;
    }
    case "toggle-new-budget": await commit(S(), { ...ledger.settings, try_new_budget: !ledger.settings.try_new_budget }); break;
    case "pick-bucket": await commit(S(), M.withBucket(ledger.settings, id, el.dataset.bucket), { quiet: false }); break;
    case "open-savings": ui.sheet = { type: "goal", savings: true }; ui.form = { name: "", amount: "", deadline: "", account_id: null }; renderSheet(); break;
    case "open-goal-monthly": { const cur = ledger.settings.goal_monthly?.[id], row = M.savedRows({ plan: planOf(), suggestion: runSuggest() }).find((r) => r.goal_id === id); ui.sheet = { type: "goal-monthly", id }; ui.form = { amount: cur !== undefined ? (cur / 100).toFixed(2) : row ? (row.amount / 100).toFixed(2) : "" }; renderSheet(); break; }
    case "save-goal-monthly": { const a = M.parsePesos(ui.form.amount ?? ""); if (!a.ok || a.centavos < 0) break; const gid = ui.sheet.id; ui.sheet = null; renderSheet(); await commit(S(), { ...ledger.settings, goal_monthly: { ...(ledger.settings.goal_monthly ?? {}), [gid]: a.centavos } }); break; }
    case "clear-goal-monthly": { const { [ui.sheet.id]: _gone, ...rest } = ledger.settings.goal_monthly ?? {}; ui.sheet = null; renderSheet(); await commit(S(), { ...ledger.settings, goal_monthly: rest }); break; }
    case "open-shares": { const ids = M.shareableGoals(S().goals, new Map(S().goals.map((g) => [g.id, M.goalProgress(S(), g)]))).map((g) => g.id), cur = ledger.settings.goal_shares ?? {}, equal = Math.floor(100 / ids.length);
      ui.sheet = { type: "shares", ids }; ui.form = Object.fromEntries(ids.map((gid, i) => ["s_" + gid, String(cur[gid] !== undefined ? cur[gid] / 100 : i === 0 ? 100 - equal * (ids.length - 1) : equal)])); renderSheet(); break; }
    case "save-shares": { const r = M.parseShares(ui.sheet.ids, Object.fromEntries(ui.sheet.ids.map((gid) => [gid, ui.form["s_" + gid]]))); if (!r.ok) break; ui.sheet = null; renderSheet(); await commit(S(), { ...ledger.settings, goal_shares: r.shares }); break; }
    case "clear-shares": { const { goal_shares, ...rest } = ledger.settings; await commit(S(), rest); break; }
    case "open-targets": { const t = M.resolveTargets(ledger.settings.bucket_targets); ui.sheet = { type: "targets" }; ui.form = { need: String(t.need / 100), want: String(t.want / 100), savings: String(t.savings / 100) }; renderSheet(); break; }
    case "save-targets": {
      const r = M.parseTargets({ need: ui.form.need, want: ui.form.want, savings: ui.form.savings }); if (!r.ok) break;
      ui.sheet = null; renderSheet(); await commit(S(), { ...ledger.settings, bucket_targets: r.targets }); break;
    }
    case "clear-targets": { const { bucket_targets, ...rest } = ledger.settings; await commit(S(), rest); break; }
    case "open-income-base": { const cur = ledger.settings.income_base_pin; ui.sheet = { type: "budget-income" }; ui.form = { amount: cur ? (cur / 100).toFixed(2) : "" }; renderSheet(); break; }
    case "save-income-base": { const a = M.parsePesos(ui.form.amount); if (!a.ok || a.centavos <= 0) break; ui.sheet = null; renderSheet(); await commit(S(), { ...ledger.settings, income_base_pin: a.centavos }); showToast("Income figure set"); break; }
    case "clear-income-pin": { const { income_base_pin, ...rest } = ledger.settings; await commit(S(), rest); break; }
    case "open-suggest": ui.sheet = { type: "budget-suggest" }; ui.form = { sug: runSuggest(), stage: "pick", start: M.addMonths(M.monthOf(today()), 1), used: {}, changes: [] }; renderSheet(); break;
    case "save-rent": {   // the starter budget asks for the rent first; it is kept in the settings and asked again only if you choose to change it
      const a = M.parsePesos(ui.form.rent ?? "");
      if (!a.ok) { showToast("Enter the rent like 8000, or 0 if you pay none"); break; }
      await commit(S(), { ...ledger.settings, starter_rent: a.centavos });
      ui.form = { sug: runSuggest(), stage: "pick", start: M.addMonths(M.monthOf(today()), 1), used: {}, changes: [] }; renderSheet(); break;
    }
    case "change-rent": ui.form = { sug: { ok: false, code: "NEEDS_RENT", message: "Type your monthly rent first (0 if you pay none)." }, stage: "pick", rent: ledger.settings.starter_rent != null ? (ledger.settings.starter_rent / 100).toFixed(2) : "", used: {}, changes: [] }; renderSheet(); break;
    case "use-sug": { const x = ui.form.sug.rows.find((r) => r.category_id === id); if (x && x.suggested !== null) { ui.form["y_" + id] = (x.suggested / 100).toFixed(2); ui.form.used[id] = true; } renderSheet(); break; }
    case "use-all-sug": { for (const x of ui.form.sug.rows) if (x.suggested !== null) { ui.form["y_" + x.category_id] = (x.suggested / 100).toFixed(2); ui.form.used[x.category_id] = true; } renderSheet(); break; }
    case "review-sug": {
      const d = draftOfSuggest(); if (d.error) { showToast(d.error); break; }
      const r = M.budgetChangesFromDraft(S(), d.draft, { start: ui.form.start, newId: () => newId("rule") });
      if (!r.ok) { showToast("Could not save: " + r.message); break; }
      ui.form.stage = "review"; ui.form.changes = r.changes; renderSheet(); break;
    }
    case "back-sug": ui.form.stage = "pick"; renderSheet(); break;
    case "set-start-sug": { ui.form.start = el.dataset.month; const r = M.budgetChangesFromDraft(S(), draftOfSuggest().draft, { start: ui.form.start, newId: () => newId("rule") }); if (r.ok) ui.form.changes = r.changes; renderSheet(); break; }
    case "save-sug": {
      const d = draftOfSuggest(); if (d.error) { showToast(d.error); break; }
      const r = M.budgetChangesFromDraft(S(), d.draft, { start: ui.form.start, newId: () => newId("rule") });
      if (!r.ok) { showToast("Could not save: " + r.message); break; }
      const pins = { ...(ledger.settings.budget_pins ?? {}), ...d.typed }; for (const k of Object.keys(ui.form.used ?? {})) delete pins[k];
      const income = M.baseIncome(S(), { plan: planOf(), pin: ledger.settings.income_base_pin ?? null }).amount;
      ui.sheet = null; renderSheet();
      await commit(r.state, { ...ledger.settings, budget_pins: pins, budget_income_seen: income });
      showToast(r.changes.length === 1 ? "1 budget saved" : r.changes.length + " budgets saved");
      break;
    }
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
      const plan = M.planGoal(S(), { id: newId("goal"), account_id: f.account_id, name: f.name, target: target ? target.centavos : null, deadline: f.deadline || undefined, role: f.role });
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      ui.sheet = null; renderSheet();
      await commit(plan.state);
      showToast("Goal added: " + plan.goal.name);
      break;
    }
    case "pick-goal-role": form.role = form.role === "emergency" ? undefined : "emergency"; renderSheet(); break;
    case "goal-role": {
      const g = S().goals.find((x) => x.id === id); if (!g) break;
      const r = M.setGoalRole(S(), id, g.role === "emergency" ? null : "emergency");
      if (r.ok && await commit(r.state)) showToast(g.role === "emergency" ? "No goal is marked as your emergency fund now." : g.name + " is your emergency fund.");
      break;
    }
    case "open-deposit": ui.sheet = { type: "deposit", id }; ui.form = { amount: "", account_id: accountsFor(null).find((a) => a.id !== S().goals.find((g) => g.id === id)?.account_id)?.id ?? null }; renderSheet(); break;
    case "open-goal-account": ui.sheet = { type: "goal-account", id }; ui.form = { account_id: null }; renderSheet(); break;
    case "save-goal-account": {
      const r = M.setGoalAccount(S(), ui.sheet.id, ui.form.account_id);
      if (!r.ok) { showToast("Could not save: " + r.violations[0].message); break; }
      ui.sheet = null; renderSheet(); await commit(r.state); showToast("Account chosen"); break;
    }
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
    case "add-cat": ui.sheet = { type: "cat", id: null }; ui.form = { name: "" }; renderSheet(); break;
    case "rename-cat": ui.sheet = { type: "cat", id }; ui.form = { name: S().categories.find((c) => c.id === id)?.name ?? "" }; renderSheet(); break;
    case "pick-new-bucket": ui.form.bucket = el.dataset.bucket; for (const b of document.querySelectorAll("#c-bucket button")) b.setAttribute("aria-pressed", String(b.dataset.bucket === ui.form.bucket)); break;
    case "cat-bucket": ui.sheet = { type: "bucket-pick", id }; renderSheet(); break;
    case "set-bucket": { const cid = ui.sheet.id; ui.sheet = null; renderSheet(); await commit(S(), M.withBucket(ledger.settings, cid, el.dataset.bucket || null)); break; }
    case "open-howto": ui.sheet = { type: "howto", id }; renderSheet(); break;
    case "open-whatsnew": ui.sheet = { type: "whatsnew" }; renderSheet(); break;
    case "goto-confirm": $("bud-confirm")?.scrollIntoView({ block: "start" }); break;
    case "save-cat": {
      const cat = ui.sheet.id ? S().categories.find((c) => c.id === ui.sheet.id) : null;
      const r = ui.sheet.id ? M.renameCategory(S(), ui.sheet.id, ui.form.name) : M.addCategory(S(), { id: newId("cat"), name: ui.form.name });
      if (!r.ok) { showToast(r.violations[0].message); break; }
      const clash = cat ? M.renameConflict(cat, ui.form.name, ledger.settings.bucket_overrides ?? {}) : null;
      const answer = !ui.sheet.id && M.readBucket(ui.form.name).bucket === null && M.CHOICES.includes(ui.form.bucket) ? ui.form.bucket : null;
      ui.sheet = null; renderSheet();
      await commit(r.state, answer ? M.withBucket(ledger.settings, r.category.id, answer) : ledger.settings);
      if (clash) { ui.sheet = { type: "bucket-clash", id: cat.id, ...clash }; renderSheet(); }   // asked only after the rename is saved, so the answer is never overwritten
      break;
    }
    case "open-notice": ui.sheet = { type: "notice" }; renderSheet(); break;
    case "open-sweep": {
      const known = (ledger.settings.sweep_order ?? []).filter((o) => S().goals.some((g) => g.id === o.goal_id));
      ui.sheet = { type: "sweeporder" };
      ui.form = { order: known.map((o) => o.goal_id), ...Object.fromEntries(known.filter((o) => o.target != null).map((o) => ["t_" + o.goal_id, (o.target / 100).toFixed(2)])) };
      renderSheet(); break;
    }
    case "pick-sweep": form.order = form.order.includes(id) ? form.order.filter((x) => x !== id) : [...form.order, id]; renderSheet(); break;
    case "save-sweep": {
      const f = ui.form, order = [];
      for (const [i, gid] of f.order.entries()) {
        const raw = i < f.order.length - 1 ? (f["t_" + gid] ?? "").trim() : "", a = raw ? M.parsePesos(raw) : null;
        if (a && (!a.ok || a.centavos < 0)) { showToast("Enter the target like 20000"); return; }
        order.push({ goal_id: gid, ...(a ? { target: a.centavos } : {}) });
      }
      ui.sheet = null; renderSheet();
      await commit(S(), { ...ledger.settings, sweep_order: order });
      showToast("Saved: " + order.map((o) => S().goals.find((g) => g.id === o.goal_id).name).join(", then "));
      break;
    }
    case "sweep-buffer": {
      const g = gcashOf(), order = M.sweepOrderAccounts(S(), ledger.settings.sweep_order);
      if (!order) { showToast("Choose where the leftover goes first (Buffer, Choose where the leftover goes)."); break; }
      const plan = M.planSweep(S(), { transaction_id: newId("tx"), date: today(), gcash_account_id: g.account_id, buffer_envelope_id: g.buffer_id, order }, new Date());
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      if (!plan.transaction) { showToast("Nothing left in the buffer to sweep."); break; }
      await commit(M.applyDrafts(S(), [{ transaction: plan.transaction, entries: plan.entries }]));
      showToast("Sweep saved as a draft. Verify it in Verify.");
      break;
    }
    case "open-trip": ui.sheet = { type: "trip" }; ui.form = { name: "", amount: "", start: "", end: "" }; renderSheet(); break;
    case "open-trip-dates": { const t = S().tags.find((x) => x.id === id); ui.sheet = { type: "trip-dates", id }; ui.form = { start: t?.start ?? "", end: t?.end ?? "" }; renderSheet(); break; }
    case "save-trip-dates": case "clear-trip-dates": {
      const dates = action === "clear-trip-dates" ? {} : { start: ui.form.start, end: ui.form.end };
      const plan = M.planTripDates(S(), ui.sheet.id, dates);
      if (!plan.ok) { ui.form = { ...ui.form, error: plan.violations[0].message }; renderSheet(); break; }   // a plain message in the sheet; nothing is saved
      ui.sheet = null; renderSheet();
      await commit(plan.state);
      showToast(action === "clear-trip-dates" ? "Dates taken off" : "Dates saved");
      break;
    }
    case "open-trip-detail": ui.tripId = id; renderScreen(); break;
    case "trip-back": ui.tripId = null; renderScreen(); break;
    case "open-trip-pick": ui.sheet = { type: "trip-pick", id: ui.tripId }; ui.form = {}; renderSheet(); break;
    case "trip-add": case "trip-remove": {
      const plan = M.planTripOverride(S(), id, ui.sheet?.type === "trip-pick" ? ui.sheet.id : ui.tripId, action === "trip-add" ? "add" : "remove");
      if (!plan.ok) { showToast("Could not save: " + plan.violations[0].message); break; }
      await commit(plan.state);
      if (ui.sheet?.type === "trip-pick") renderSheet();
      break;
    }
    case "save-trip": {
      const budget = ui.form.amount ? M.parsePesos(ui.form.amount) : null;
      if (budget && !budget.ok) { showToast("Enter the budget like 13000"); break; }
      const plan = M.planTag(S(), { id: newId("tag"), name: ui.form.name, budget: budget ? budget.centavos : undefined, start: ui.form.start, end: ui.form.end });
      if (!plan.ok) { ui.form = { ...ui.form, error: plan.violations[0].message }; renderSheet(); break; }   // a plain message in the sheet; nothing is saved
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
      if (ledger.settings.try_new_budget) {   // the new Budget: the plan row and its budgets are written together, or not at all
        const w = M.planWithBudgets(S(), ledger.settings, { plan: r.plan, newId: () => newId("rule") });
        if (!w.ok) { showToast(w.message); break; }
        ui.sheet = null; renderSheet();
        await commit(w.state, w.settings);
        showToast(w.changes.length ? "Plan loaded. " + (w.changes.length === 1 ? "1 budget" : w.changes.length + " budgets") + " set from " + M.monthLabel(w.month) + "." : "Plan loaded. The budgets already match.");
        break;
      }
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
    case "pay-edit": { const p = S().presets.find((x) => x.id === ui.sheet.id); ui.confirmRemoveTile = false; ui.sheet = { type: "tile", id: p.id }; ui.form = { name: p.name, amount: (p.amount / 100).toFixed(2), category_id: p.category_id }; renderSheet(); break; }
    case "edit-tile": { const p = S().presets.find((x) => x.id === id); if (!p) break; ui.confirmRemoveTile = false; ui.sheet = { type: "tile", id }; ui.form = { name: p.name, amount: (p.amount / 100).toFixed(2), category_id: p.category_id }; renderSheet(); break; }
    case "add-tile": ui.confirmRemoveTile = false; ui.sheet = { type: "tile", id: null }; ui.form = { name: "", amount: "", category_id: expenseCategories()[0]?.id }; renderSheet(); break;
    case "arrange-done": ui.arrange = false; renderScreen(); break;
    case "arrange-start": enterArrange(); break;
    case "remove-tile-now": {   // like taking an app off a phone's home screen: it shrinks away, the others slide over
      const r = M.removePreset(S(), id);
      if (!r.ok) { showToast(r.error); break; }
      const tiles = [...document.querySelectorAll(".tiles.arranging .tile")], gone = tiles.find((t) => t.dataset.id === id);
      const before = new Map(tiles.map((t) => [t.dataset.id, t.getBoundingClientRect()]));
      gone?.classList.add("vanish");
      await new Promise((res) => setTimeout(res, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200));
      await commit(r.state);
      for (const t of document.querySelectorAll(".tiles.arranging .tile[data-id]")) {   // the rest slide into the gap
        const a = before.get(t.dataset.id), b = t.getBoundingClientRect();
        if (!a || (a.left === b.left && a.top === b.top)) continue;
        t.style.transition = "none"; t.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`; void t.offsetWidth;
        t.style.transition = ""; t.style.transform = "";
      }
      break;
    }
    case "remove-tile": ui.confirmRemoveTile = true; renderSheet(); break;
    case "remove-tile-yes": {
      const r = M.removePreset(S(), ui.sheet.id);
      if (!r.ok) { showToast(r.error); break; }
      ui.sheet = null; ui.confirmRemoveTile = false; renderSheet();
      await commit(r.state); showToast("Tile removed.");
      break;
    }
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
    case "open-voice": ui.sheet = { type: "voice" }; ui.form = { spoken: "", lang: firstLanguage() }; renderSheet(); break;
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
    case "open-lines": ui.linesOpen = true; refreshSave(); break;
    case "fold-lines": document.activeElement?.blur?.(); ui.linesOpen = false; refreshSave(); break;
    case "check-slip": { const r = M.markPayslipChecked(S(), id); if (r.ok && await commit(r.state)) showToast("Marked as checked."); break; }
    case "open-payslip": ui.pdet = {}; ui.linesOpen = false; ui.sheet = { type: "payslip" }; ui.form = payslipDefaults(); renderSheet(); break;
    case "edit-slip": {
      const p = S().payslips.find((x) => x.id === id); if (!p) break;
      const two = (c) => (c / 100).toFixed(2), f = { employer: p.employer, period_from: p.period_from, period_to: p.period_to, pay_date: p.pay_date, account_id: p.account_id,
        gross: two(p.printed_gross), net: two(p.printed_net), deposit: two(p.deposit), ded: p.printed_deductions ? two(p.printed_deductions) : "", words: p.net_words ?? "", ot_month: payslipDefaults().ot_month };
      for (const l of M.linesOf(S(), id)) { f[(l.side === "earning" ? "e_" : "d_") + l.kind] = two(l.amount); if (l.earned_month) f.ot_month = l.earned_month; }
      ui.pdet = { e: true, d: true }; ui.linesOpen = false; ui.form = f; ui.sheet = { type: "payslip", editId: id }; renderSheet(); break;
    }
    case "save-payslip": await savePayslip(); break;
    case "open-otfree": ui.sheet = { type: "otfree", id }; ui.form = { account_id: null }; renderSheet(); break;
    case "save-otfree": {
      const d = M.overtimeFreeDraft(S(), ui.sheet.id, { transaction_id: "otf-" + ui.sheet.id, to_account_id: form.account_id }, new Date());
      if (!d?.ok || !d.transaction) { showToast("Could not make the draft: " + (d?.violations?.[0]?.message ?? "no overtime")); break; }
      ui.sheet = null; renderSheet();
      await commit(M.applyDrafts(S(), [d])); showToast("The draft is waiting in Verify."); break;
    }
    case "income-view": ui.incomeView = el.dataset.view; renderScreen(); break;
    case "del-slip": ui.confirmDelSlip = id; renderSheet(); break;
    case "del-inc": ui.confirmDelInc = id; renderSheet(); break;
    case "del-inc-yes": {
      const r = M.removeIncomeEntry(S(), id);
      if (!r.ok) { showToast(r.error); break; }
      ui.confirmDelInc = null;
      if (await commit(r.state)) for (const ph of r.photoIds) deletePhoto(ph).catch(() => {});
      showToast("Entry removed.");
      break;
    }
    case "del-slip-yes": {
      const r = M.deletePayslip(S(), id);
      if (!r.ok) { showToast(r.error); break; }
      ui.confirmDelSlip = null;
      if (await commit(r.state)) for (const ph of r.photoIds) deletePhoto(ph).catch(() => {});
      showToast("Payslip removed." + (r.keptTransfers ? " An overtime transfer that was already verified stays." : ""));
      break;
    }
    case "ot-draft": {
      const emerg = M.goalByRole(S(), "emergency");
      if (!emerg) { showToast("Choose which goal is your emergency fund first (Menu, Budget, Goals)."); break; }
      if (!emerg.account_id) { showToast("Choose an account for your emergency fund first (Menu, Budget, Goals)."); break; }
      const d = M.overtimeDraft(S(), id, { transaction_id: "ot-" + id, emergency_account_id: emerg.account_id }, new Date());
      if (!d?.ok || !d.transaction) { showToast("Could not make the draft."); break; }
      await commit(M.applyDrafts(S(), [d])); showToast("The Emergency Fund draft is waiting in Verify."); break;
    }
    case "pick-kind": if (id === "payslip" && pendingPhoto && !ui.sheet.voice) { openPayslipFromPhoto(pendingPhoto.blob, form.text ?? "", ui.sheet.queueId ?? null); break; } form.kind = id; Object.assign(form, scanDefaults(id, form.guess, form.payee)); renderSheet(); break;
    case "save-scan": await saveScan(); break;
    case "view-shot": if (pendingPhoto) viewShot(pendingPhoto.url); break;
    case "open-payslips": ui.confirmDelSlip = null; ui.confirmDelInc = null; ui.sheet = { type: "payslips" }; renderSheet(); break;
    case "open-tx": ui.sheet = { type: "txdetail", id }; renderSheet(); break;
    case "open-photo": { const u = photoUrls.get(id) ?? (await getPhoto(id).then((b) => b && URL.createObjectURL(b))); if (u) { photoUrls.set(id, u); viewShot(u); } else showToast("Picture not on this phone. Pictures are not part of the backup file."); break; }
    case "pick-acct": form.account_id = id; renderSheet(); break;
    case "import-order": form.order = id; renderSheet(); break;
    case "save-import": {
      const p = M.previewImport(S(), form.items, form.order), r = M.planImport(S(), p.lines, { account_id: form.account_id, newId: () => newId("tx") });
      if (!r.ok) { showToast(r.message); break; }
      ui.sheet = null; renderSheet();
      if (await commit(r.state)) showToast(`${r.count} ${r.count === 1 ? "draft is" : "drafts are"} waiting in Verify.`);
      break;
    }
    case "close-sheet": voiceListener?.stop(); if (ui.sheet?.type === "budget-suggest") await savePinsFromForm(); ui.sheet = null; renderSheet(); break;
    case "save-other": {
      const amount = M.parsePesos(form.amount).centavos;
      ui.sheet = null; renderSheet();
      await logExpense({ transaction_id: newId("tx"), payee: "", category_id: form.category_id, amount, account_id: form.account_id, source: "manual" }, categoryName(form.category_id) + " " + peso(amount));
      break;
    }
    case "save-tile": {
      const f = ui.form, amt = M.parsePesos(f.amount ?? ""), tile = { name: f.name, amount: amt.ok ? amt.centavos : 0, category_id: f.category_id };
      const r = ui.sheet.id ? M.updatePreset(S(), ui.sheet.id, tile) : M.addPreset(S(), tile, newId("pre"));
      if (!r.ok) { showToast(r.error); break; }
      const adding = !ui.sheet.id;
      ui.sheet = null; renderSheet();
      await commit(r.state);
      showToast(adding ? "Tile added." : "Tile saved.");
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
    case "restore-copy": {
      const i = Number(id), c = (ui.copies ?? [])[i]; if (!c) break;
      if (ui.confirmCopy !== i) { ui.confirmCopy = i; renderScreen(); break; }
      ui.confirmCopy = null;
      await writeBoth(JSON.stringify(M.restorableCopy(c, ledger.rev)));
      location.reload(); break;   // the app starts again, upgrades the copy (keeping a copy of it first) and carries on
    }
    case "open-backup": if (ui.menu) { ui.menu = false; renderMenu(); } ui.sheet = { type: "backup" }; ui.form = {}; renderSheet(); break;   // from the menu: it steps aside
    case "open-restore": ui.sheet = { type: "restore" }; ui.form = {}; renderSheet(); break;
    case "open-check-backup": ui.sheet = { type: "restore", check: true }; ui.form = {}; renderSheet(); break;
    case "make-backup": await makeBackup(); break;
    case "make-passphrase": { const made = M.makePassphrase(); ui.form = { ...ui.form, pass: made, pass2: made, made }; renderSheet(); break; }   // shown on screen, kept nowhere
    case "copy-passphrase": {
      try { await navigator.clipboard.writeText(ui.form.made); showToast("Copied. Paste it into Passwords or a note you trust."); }
      catch { showToast("Could not copy. Select the passphrase and copy it by hand."); }
      break;
    }
    case "open-backup-file": await openBackupFile(); break;
    case "restore-now": await restoreNow(); break;
    case "toggle-add-account": ui.setupAdd = !ui.setupAdd; renderScreen(); break;
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
  showToast("Backup file created. Check that it is in Files or on your drive, and keep a second copy off this phone.");
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
  ui.setupError = null; ui.setupAdd = false;
  ui.accountForm = { name: "", bank: null, sub: "", kind: f.kind, opening: "", covers: "" };
  document.activeElement?.blur();   // close the keyboard so the result is visible
  const ok = await commit(plan.state);
  window.scrollTo(0, 0);
  showToast((ok ? "Added " : "Not safely stored: ") + plan.account.name);
}

// ---- the quick tiles: hold to arrange, drag to move ----
// Holding a tile (about half a second) switches the tiles to arrange mode. There: drag a tile onto another place and the others slide aside;
// tap a tile to change it; "+" adds one; Done finishes. A hold or a drag must not also count as a tap.
let holdTimer = null, holdAt = null, suppressClick = false, tdrag = null;
const enterArrange = () => {
  ui.arrange = true; renderScreen(); navigator.vibrate?.(12);
  if (!ledger.settings.tile_hint_done) commit(S(), { ...ledger.settings, tile_hint_done: true }, { quiet: true });
};
document.addEventListener("click", (e) => { if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
// A new touch is a new gesture: a click held back from the last one can no longer come (its button may have gone, as when holding a menu item closes the
// menu, so the lift is never reported), so it must not swallow this tap.
document.addEventListener("pointerdown", () => { suppressClick = false; }, true);
// Verify: swipe the entry to the right to mark it Correct (the Correct button stays; this is the quick way). Left does nothing, so Delete is never by accident.
let swipe = null;
document.addEventListener("pointerdown", (e) => { const c = ui.tab === "verify" && !ui.sheet ? e.target.closest("#screen .card") : null; swipe = c && !e.target.closest("button, a, input, select") ? { x: e.clientX, y: e.clientY, c } : null; });
document.addEventListener("pointerup", (e) => {
  const s0 = swipe; swipe = null;
  if (!s0 || ui.tab !== "verify" || ui.sheet) return;
  const dx = e.clientX - s0.x, dy = e.clientY - s0.y;
  if (dx > 90 && Math.abs(dy) < 40 && dx > Math.abs(dy) * 2.5) { s0.c.querySelector('button[data-action="verify-ok"]')?.click(); }
});
document.addEventListener("pointerdown", (e) => {
  const t = e.target.closest(".tile[data-id]");
  if (!t || e.target.closest(".tminus") || ui.tab !== "log" || ui.sheet) return;
  if (!ui.arrange) {
    holdAt = { x: e.clientX, y: e.clientY };
    holdTimer = setTimeout(() => { holdTimer = null; suppressClick = true; enterArrange(); }, 450);
    return;
  }
  const tiles = [...document.querySelectorAll(".tiles.arranging .tile[data-id]")];
  tdrag = { id: t.dataset.id, el: t, x0: e.clientX, y0: e.clientY, moved: false, tiles, rects: tiles.map((x) => x.getBoundingClientRect()), order: tiles.map((x) => x.dataset.id) };
  tdrag.index = tdrag.order.indexOf(tdrag.id);
  try { t.setPointerCapture(e.pointerId); } catch { /* the tdrag still works without capture */ }
});
// Holding a button that has a how-to (Log, Verify, the camera, the + tile) plays it; a normal tap does what it always did. Tiles keep their own hold (arrange).
let hwTimer = null, hwAt = null;
document.addEventListener("pointerdown", (e) => {
  const b = e.target.closest("[data-howto]");
  if (!b || ui.sheet || !M.HOWTOS.some((h) => h.id === b.dataset.howto)) return;
  hwAt = { x: e.clientX, y: e.clientY };
  hwTimer = setTimeout(() => { hwTimer = null; suppressClick = true; navigator.vibrate?.(12); if (ui.menu) { ui.menu = false; renderMenu(); } ui.sheet = { type: "howto", id: b.dataset.howto }; renderSheet(); }, 550);   // from the menu: the menu closes so the clip is in front
});
const hwCancel = () => { clearTimeout(hwTimer); hwTimer = null; };
document.addEventListener("pointerup", hwCancel); document.addEventListener("pointercancel", hwCancel);
document.addEventListener("contextmenu", (e) => { if (e.target.closest("[data-howto]")) e.preventDefault(); });
document.addEventListener("pointermove", (e) => {
  if (hwTimer && hwAt && Math.hypot(e.clientX - hwAt.x, e.clientY - hwAt.y) > 10) hwCancel();
  if (holdTimer && holdAt && Math.hypot(e.clientX - holdAt.x, e.clientY - holdAt.y) > 10) { clearTimeout(holdTimer); holdTimer = null; }
  if (!tdrag) return;
  const dx = e.clientX - tdrag.x0, dy = e.clientY - tdrag.y0;
  if (!tdrag.moved && Math.hypot(dx, dy) < 8) return;
  if (!tdrag.moved) { tdrag.moved = true; tdrag.el.classList.add("dragging"); }
  tdrag.el.style.transform = `translate(${dx}px, ${dy}px) scale(1.04)`;
  const home = tdrag.rects[tdrag.tiles.indexOf(tdrag.el)], cx = home.left + home.width / 2 + dx, cy = home.top + home.height / 2 + dy;
  let best = tdrag.index, bestD = Infinity;
  tdrag.rects.forEach((r, k) => { const d = Math.hypot(cx - (r.left + r.width / 2), cy - (r.top + r.height / 2)); if (d < bestD) { bestD = d; best = k; } });
  if (best !== tdrag.index) {   // the others slide into their new places
    tdrag.order.splice(tdrag.index, 1); tdrag.order.splice(best, 0, tdrag.id); tdrag.index = best;
    tdrag.order.forEach((id, k) => {
      if (id === tdrag.id) return;
      const el = tdrag.tiles.find((x) => x.dataset.id === id), from = tdrag.rects[tdrag.tiles.indexOf(el)], to = tdrag.rects[k];
      el.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px)`;
    });
  }
});
const endPointer = async (e) => {
  clearTimeout(holdTimer); holdTimer = null;
  if (e.type === "pointerup" || e.type === "pointercancel") setTimeout(() => { suppressClick = false; }, 60);
  if (!tdrag) return;
  const d = tdrag; tdrag = null;
  if (!d.moved) return;   // a tap: the click opens the tile
  suppressClick = true;
  const slot = d.rects[d.index], home = d.rects[d.tiles.indexOf(d.el)];
  d.el.classList.remove("dragging"); d.el.style.transform = `translate(${slot.left - home.left}px, ${slot.top - home.top}px)`;   // it settles into its place
  const changed = d.order.join() !== d.tiles.map((x) => x.dataset.id).join();
  await new Promise((r) => setTimeout(r, 190));
  if (changed) { const r = M.reorderPresets(S(), d.order); if (r.ok) { await commit(r.state); return; } }
  renderScreen();
};
document.addEventListener("pointerup", endPointer);
document.addEventListener("pointercancel", endPointer);
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el) onClick(el);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ui.menu) { ui.menu = false; renderMenu(); } });
// which fold-out parts of the payslip window are open, so choosing an account (which redraws the window) does not fold them shut
document.addEventListener("focusout", () => { if (ui.sheet?.type === "payslip") setTimeout(refreshSave, 0); });   // the lines fold away once you leave them and everything matches
document.addEventListener("toggle", (e) => { const k = e.target?.dataset?.keep; if (k) ui.pdet = { ...ui.pdet, [k]: e.target.open }; }, true);
document.addEventListener("input", (e) => {
  const field = e.target.dataset?.field;
  if (!field) return;
  if (e.target.type === "file") return;   // handled on change
  if (field === "sub" && !ui.sheet) { ui.accountForm.sub = e.target.value; const p = $("a-preview"); if (p) p.textContent = "Saved as: " + accountPreview(ui.accountForm); return; }
  if (field === "zoom") { zoomTo(Number(e.target.value)); return; }
  if (ui.sheet) { ui.form[field] = e.target.value; if (field.startsWith("y_") && ui.form.used) delete ui.form.used[field.slice(2)]; refreshSave(); }
  else ui.accountForm[field] = e.target.value;
});
document.addEventListener("change", (e) => {
  if (e.target.dataset?.import) { const file = e.target.files[0]; e.target.value = ""; if (file) importFile(file); return; }
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
// Data saved by an older version of the app (model/migrate.js): keep a copy first; convert; check; save; read it back and check again. If anything is
// wrong the copy goes back and the old data carries on. Returns {ledger, ok} or {ledger, failed: "a plain message"}.
async function upgradeSaved(original) {
  const text = JSON.stringify(original);
  const copies = M.rotateCopies(await readCopies(), text, { at: M.phTimestamp(), from_version: original.v, build: M.APP_BUILD });
  const kept = await writeCopies(copies);
  ui.copies = copies;
  if (!kept.local && !kept.idb) return { ledger: original, failed: "Your data was not updated, because a safety copy could not be saved first. Your data is exactly as it was." };
  const r = M.upgradeLedger(original);
  if (!r.ok) return { ledger: original, failed: "Your data was not updated: " + r.error + " Nothing was changed; your data is exactly as it was. Please send me a screenshot of this." };
  await writeBoth(JSON.stringify(r.ledger));
  const back = await readBoth(), again = M.chooseLedger(back.local ?? null, back.idb ?? null);
  const sound = again.status === "OK" && again.ledger.v === M.LEDGER_VERSION && M.selfCheck(again.ledger).length === 0 && M.fingerprint(again.ledger) === M.fingerprint(original);
  if (sound) return { ledger: r.ledger, ok: true };
  const restored = M.restorableCopy(copies[0], r.ledger.rev);
  await writeBoth(JSON.stringify(restored));
  return { ledger: restored, failed: "The update of your data did not check out, so it was undone and the copy from before was put back. Your data is exactly as it was. Please send me a screenshot of this." };
}

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
    if (ledger.v < M.LEDGER_VERSION && device.allowEntry) {
      const u = await upgradeSaved(ledger);
      ledger = u.ledger; ui.upgrade = u.ok ? { done: true } : { failed: u.failed }; boot = { ...boot, status: "OK" };   // both stores were just written
    }
    ledger.state = M.dropUnusedCardCategory(M.ensureIncomeCategories(ledger.state));   // older ledgers gain Interest, Refund and Other income (saved with the next save)
    if (boot.status === "NONE") { ledger.state = { ...ledger.state, categories: M.defaultCategories(), presets: M.defaultPresets() }; ledger.settings = { ...ledger.settings, roles_notice_seen: M.phTimestamp(), whatsnew_seen: M.CHANGES[0].id, start_rule_seen: M.phTimestamp() }; }   // kept in memory until the first save
    // The two stores disagree on revision only (a save reached one and not the other): repair quietly from the newer.
    if (boot.status === "REPAIR" && local != null && idb != null && device.allowEntry) {
      await writeBoth(JSON.stringify(ledger), { local: boot.repairTo === "local", idb: boot.repairTo === "idb" });
    }
  }
  if (!device.allowEntry) ui.tab = "log";
  if (!ui.copies) ui.copies = await readCopies();
  renderAll();
  if (ui.upgrade?.done) showToast("Your data was updated to the newest format. A copy of the old data is kept in Setup.");
  // A brand-new install shows the notice once: the moment is remembered in the settings, which are saved with the first save. Help shows it again on request.
  if (device.allowEntry && boot.status === "NONE" && !ledger.settings.notice_seen_at) { ledger.settings = { ...ledger.settings, notice_seen_at: M.phTimestamp() }; ui.sheet = { type: "notice" }; renderSheet(); }
  // After an update: the latest changes, once. "Got it" (or closing the window) remembers it, saved at once so it is not shown again.
  // The start-date rule (balances skip spending dated before an account was added) is told once, with the accounts whose balance it changed.
  const early = !ledger.settings.start_rule_seen && boot.status === "OK" ? M.earlyEntryChanges(S()) : [];
  if (device.allowEntry && boot.status === "OK" && !ui.sheet && !ui.upgrade?.failed && ledger.v === M.LEDGER_VERSION && (M.whatsNew(ledger.settings).length || early.length)) {
    ui.sheet = { type: "whatsnew", changes: early }; renderSheet();
    await commit(S(), { ...ledger.settings, whatsnew_seen: M.CHANGES[0].id, start_rule_seen: M.phTimestamp() }, { quiet: true });
  } else if (device.allowEntry && boot.status === "OK" && !ui.upgrade?.failed && !ledger.settings.start_rule_seen) ledger.settings = { ...ledger.settings, start_rule_seen: M.phTimestamp() };   // nothing changed: kept with the next save
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
