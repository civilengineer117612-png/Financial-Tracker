// The how-to clips: short looping animations drawn from the owner's OWN screen (their quick tiles, their account and its picture, today's date and
// total), so what they watch is what they will see. Pure functions that return markup; the motion itself is CSS in app/index.html (classes hw-*), and
// with Reduce Motion on the finished frame is shown. Nothing is logged or changed by a clip: it is only a picture. With no tiles or accounts yet, plainly
// marked examples stand in. Each clip has ONE caption (owner's choice). Never a real receipt: the scan clip draws an invented one.
import { formatPesos } from "./money.js";

export const HOWTOS = [
  { id: "log", label: "Log an expense", caption: "Tap a tile, check it, Save: logged in two taps." },
  { id: "verify", label: "Verify an entry", caption: "Open Verify, fix anything that is wrong, then tap Correct." },
  { id: "scan", label: "Scan a receipt", caption: "Tap the camera, take the receipt, and it waits in Verify." },
  { id: "budget", label: "Set a budget", caption: "Tap a category, type its monthly limit, Save: the bucket bars follow." },
  { id: "trips", label: "Keep a trip apart", caption: "Tag new entries on a trip, or give it dates: its spending stays apart." },
  { id: "cards", label: "See what you owe", caption: "Cards shows each account and what you owe. Tap the arrow for an earlier month." },
  { id: "checkin", label: "Count your accounts", caption: "Tap an account, type its real balance, Save: the difference is recorded." },
  { id: "checks", label: "Check your card reserve", caption: "Card spending goes up; Checks says if the reserve still covers it." },
  { id: "buffer", label: "Cover an overrun", caption: "When a category runs over, the buffer pays the gap and records it." },
  { id: "goals", label: "Save toward a goal", caption: "Tap Put money in on a goal, type the amount, Save: its bar grows." },
  { id: "import", label: "Import old spending", caption: "Tap the camera, Import old spending, pick a file: every line waits in Verify." },
  { id: "backup", label: "Back up your data", caption: "Back up now, set a password, save the file off this phone." },
];
export const HOWTO_HINT = "Hold a button or a menu row for a moment to watch how it works. Help lists every clip.";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const EXAMPLE_TILES = [{ name: "Coffee", amount: 15000, category: "Food" }, { name: "Jeep", amount: 1300, category: "Transport" }, { name: "Lunch", amount: 9500, category: "Food" }];

// The Budget clip's data: {income: centavos a month, rows: [{name, amount (this month's budget), bucket: "need" | "want" | "savings" | "other"}],
// buckets: [{bucket, label, amount}] or null when the new Budget is off}. The first row is the one changed; the change shown is +P500 (or P3,000 for a
// category with no budget yet), only in the picture.
const EXAMPLE_BUDGET = { income: 3000000, rows: [{ name: "Food", amount: 600000, bucket: "need" }, { name: "Transport", amount: 250000, bucket: "need" }, { name: "Fun", amount: 300000, bucket: "want" }],
  buckets: [{ bucket: "need", label: "Needs", amount: 1400000 }, { bucket: "want", label: "Wants", amount: 700000 }, { bucket: "savings", label: "Savings", amount: 400000 }] };
const tenthsOf = (a, income) => (income > 0 ? Math.min(1000, Math.floor((a * 2000 + income) / (2 * income))) : 0);
const pctText = (t) => (t / 10).toFixed(1) + "%";

// data: {date: "Tue, 7 Oct", tiles: [{name, amount (centavos), category}], account: {name, picture?: html for its picture}, total: centavos logged today}
const EXAMPLE_TRIPS = [{ name: "Beach weekend", days: "3 Oct 2026 to 5 Oct 2026", spent: 450000 }, { name: "Family visit", days: null, spent: 0 }];

// The Goals clip's data: {name, balance, target (centavos), account?: {name, picture?}}: one goal that has a target and is not hidden by default.
// goal.ef: true for the emergency fund, whose target comes from your budgets (goal.months of your rent, food and essentials).
const EXAMPLE_GOAL = { name: "New phone", balance: 800000, target: 2000000, account: { name: "Savings" } };

// The Cards and Weekly review clips' accounts: [{name, picture?, amount (centavos), owe?: true for a credit card, spent: [this month, last month]}]; months: [this, last].
const EXAMPLE_ACCOUNTS = [{ name: "Test Card", amount: 304800, owe: true, spent: [54900, 120000] }, { name: "Wallet", amount: 292600, spent: [39900, 85000] }, { name: "Savings", amount: 4500000, spent: [0, 0] }];

export function clipData({ date, tiles = [], account = null, total = 0, budget = null, trips = [], goal = null, accounts = [], months = ["This month", "Last month"] }) {
  const own = tiles.slice(0, 3), b = budget?.income > 0 && budget.rows?.length ? budget : null;
  return { date, total, example: own.length === 0 || !account, tiles: own.length ? own : EXAMPLE_TILES, account: account ?? { name: "Wallet" },
    budget: b ? { ...b, rows: b.rows.slice(0, 3) } : EXAMPLE_BUDGET, budgetExample: !b, goal: goal?.target > 0 ? goal : EXAMPLE_GOAL, goalExample: !(goal?.target > 0), months, accounts: accounts.length ? accounts.slice(0, 3) : EXAMPLE_ACCOUNTS, accountsExample: accounts.length === 0,
    trips: trips.length ? trips.slice(0, 2) : EXAMPLE_TRIPS, tripsExample: trips.length === 0 };
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
  if (id === "verify") {   // the logged amount is wrong by P10; the finger fixes it, then taps Correct (a clip logs nothing)
    const wrong = pick.amount + 1000;
    return phone("verify", `<div class="hw-screen">${ex}<div class="hw-h">Verify</div><div class="hw-date">One at a time</div>
      <div class="hw-card"><div class="hw-amt hw-type"><span class="hw-t0">${esc(formatPesos(wrong))}</span><span class="hw-t1">${esc(formatPesos(pick.amount))}</span></div><div class="hw-row"><span>${esc(pick.name)}</span><span class="hw-cat"><span class="hw-t0">Other</span><span class="hw-t1">${esc(pick.category)}</span></span></div>
      <div class="hw-row"><span>Paid from</span>${acct(d.account)}</div><div class="hw-row"><span>Date</span><span>${esc(d.date)}</span></div><div class="hw-note">Tap any field to fix it</div><div class="hw-btn hw-ok">Correct</div></div>
      <div class="hw-empty">All checked</div></div><div class="hw-nav"><div>Log</div><div class="hw-on">Verify</div></div>${tick}`,
      `A finger opens Verify, the entry ${pick.name} shows ${formatPesos(wrong)} from ${d.account.name}, the finger edits the amount to ${formatPesos(pick.amount)} and the category from Other to ${pick.category}, taps Correct and a tick appears.`);
  }
  if (id === "scan") {
    const receipt = `<div class="hw-receipt"><b>SAMPLE STORE</b><span>Bread<em>85.00</em></span><span>Eggs<em>110.00</em></span><span>Milk<em>50.00</em></span><span class="hw-rt">TOTAL<em>245.00</em></span><div class="hw-scanline"></div></div>`;
    return phone("scan", `<div class="hw-screen"><div class="hw-top"><div class="hw-h">Log</div><div class="hw-cam" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></div></div>
      <div class="hw-date">${esc(d.date)}</div>${receipt}</div><div class="hw-nav"><div>Log</div><div>Verify</div></div>
      ${sheet(`<div class="hw-amt">${esc(formatPesos(24500))}</div><div class="hw-row"><span>Sample Store</span><span>${esc(d.date)}</span></div><div class="hw-row"><span>Paid from</span>${acct(d.account)}</div>`, "Save as a draft")}${tick}`,
      `A finger taps the camera, an invented receipt is read, the window shows 245 pesos from Sample Store paid from ${d.account.name}, and it is saved as a draft for Verify.`);
  }
  if (id === "budget") {
    const b = d.budget, pick = b.rows[0], next = pick.amount > 0 ? pick.amount + 50000 : 300000, delta = next - pick.amount;
    const money = (a) => `${esc(formatPesos(a))}<small>${pctText(tenthsOf(a, b.income))}</small>`;   // the amount and its share of income change together
    const rows = b.rows.map((r, i) => `<div class="hw-brow${i === 0 ? " hw-bpick" : ""}"><span>${esc(r.name)}</span><span class="hw-bval">${i === 0
      ? `<span class="hw-t0">${money(r.amount)}</span><span class="hw-t1">${money(next)}</span>` : `<span>${money(r.amount)}</span>`}</span></div>`).join("");
    const bars = (b.buckets ?? []).map((k) => { const t0 = tenthsOf(k.amount, b.income), t1 = tenthsOf(k.amount + (k.bucket === pick.bucket ? delta : 0), b.income), grow = k.bucket === pick.bucket;
      return `<div class="hw-bk"><span>${esc(k.label)}</span><div class="hw-meter"><span class="hw-fill${grow ? " hw-grow" : ""}" style="--w0:${t0 / 10}%;--w1:${t1 / 10}%"></span></div><span class="hw-tip">${grow
        ? `<span class="hw-t0">${pctText(t0)}</span><span class="hw-t1">${pctText(t1)}</span>` : `<span>${pctText(t0)}</span>`}</span></div>`; }).join("");
    return phone("budget", `<div class="hw-screen">${d.budgetExample ? `<div class="hw-ex">Example</div>` : ""}<div class="hw-h">Budget</div><div class="hw-date">Income ${esc(formatPesos(b.income))} a month</div>
      <div class="hw-blist">${rows}</div>${bars ? `<div class="hw-bars">${bars}</div>` : ""}</div>
      ${sheet(`<div class="hw-row"><span>${esc(pick.name)}</span><span>a month</span></div><div class="hw-amt hw-type"><span class="hw-t0">${esc(formatPesos(pick.amount))}</span><span class="hw-t1">${esc(formatPesos(next))}</span></div>`, "Save")}${tick}`,
      `A finger taps ${pick.name}, types ${formatPesos(next)} a month and taps Save; ${pick.name} shows the new limit${bars ? " and its bucket bar grows" : ""}.`);
  }
  if (id === "goals") {   // "Put money in" on the first goal: its balance and bar grow by an example P1,000 (or what is left), in the picture only
    const g = d.goal, left = Math.max(0, g.target - g.balance), add = left > 0 ? Math.min(100000, left) : 100000, after = g.balance + add;
    const t0 = tenthsOf(g.balance, g.target), t1 = tenthsOf(after, g.target);
    const val = (bal, t) => `<span class="hw-gv">${esc(formatPesos(bal))} of ${esc(formatPesos(g.target))}</span><small>${pctText(t)}</small>`;
    const into = g.account ?? { name: "Savings" };
    return phone("goals", `<div class="hw-screen">${d.goalExample ? `<div class="hw-ex">Example</div>` : ""}<div class="hw-h">Goals</div><div class="hw-date">Savings you are building</div>
      <div class="hw-card"><div class="hw-row"><span class="hw-acct">${into.picture ?? ""}<b>${esc(g.name)}</b></span></div>
      <div class="hw-gval"><span class="hw-t0">${val(g.balance, t0)}</span><span class="hw-t1">${val(after, t1)}</span></div>
      <div class="hw-meter"><span class="hw-fill hw-grow" style="--w0:${t0 / 10}%;--w1:${t1 / 10}%"></span></div>
      <div class="hw-btn hw-go">Put money in</div></div>
      <div class="hw-note">${g.ef ? `The target is worked out from your budgets: ${esc(g.months ?? 3)} months of your rent, food and essentials.` : "A goal with no account yet holds nothing: choose an account for it first."}</div></div><div class="hw-nav"><div>Log</div><div>Verify</div></div>
      ${sheet(`<div class="hw-amt">${esc(formatPesos(add))}</div><div class="hw-row"><span>Into</span>${acct(into)}</div>`, "Save")}${tick}`,
      `A finger taps Put money in on ${g.name}, the window shows ${formatPesos(add)} going into ${into.name}, the finger taps Save, and the bar grows from ${pctText(t0)} to ${pctText(t1)}.`);
  }
  if (id === "cards") {   // the arrow goes back a month: the arrow-up figure (spent) changes, the balances do not; the screen's own signs, no words
    const up = `<svg class="hw-up" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
    const bal = (a) => `${a.owe ? "\u2212" : ""}${esc(formatPesos(a.amount))}`;
    const rows = d.accounts.map((a) => `<div class="hw-brow"><span class="hw-acct">${a.picture ?? ""}<span>${esc(a.name)}</span></span><span class="hw-bval"><span class="hw-t0">${bal(a)}<small>${up}${esc(formatPesos(a.spent[0]))}</small></span><span class="hw-t1">${bal(a)}<small>${up}${esc(formatPesos(a.spent[1]))}</small></span></span></div>`).join("");
    return phone("cards", `<div class="hw-screen">${d.accountsExample ? `<div class="hw-ex">Example</div>` : ""}<div class="hw-h">Cards</div>
      <div class="hw-month"><span class="hw-arrow">\u2039</span><span class="hw-bval hw-ml"><span class="hw-t0">${esc(d.months[0])}</span><span class="hw-t1">${esc(d.months[1])}</span></span><span class="hw-arrow hw-dim">\u203a</span></div>
      <div class="hw-blist">${rows}</div></div><div class="hw-nav"><div>Log</div><div>Verify</div></div>`,
      `A finger taps the back arrow, the month changes from ${d.months[0]} to ${d.months[1]} and what each account spent changes with it; the balances stay.`);
  }
  if (id === "checkin") {   // tap an account, type its real balance, Save: the row says Counted and the count goes up
    const a = d.accounts[0], n = d.accounts.length;
    const rows = d.accounts.map((x, i) => `<div class="hw-brow${i === 0 ? " hw-bpick" : ""}"><span class="hw-acct">${x.picture ?? ""}<span>${esc(x.name)}</span></span><span class="hw-bval">${i === 0
      ? `<span class="hw-t0">Not counted</span><span class="hw-t1">${esc(formatPesos(x.amount))}</span>` : `<span>Not counted</span>`}</span></div>`).join("");
    return phone("checkin", `<div class="hw-screen">${d.accountsExample ? `<div class="hw-ex">Example</div>` : ""}<div class="hw-h">Weekly review</div>
      <div class="hw-date hw-bval hw-cnt"><span class="hw-t0">0 of ${n} counted</span><span class="hw-t1">1 of ${n} counted</span></div><div class="hw-blist">${rows}</div></div>
      ${sheet(`<div class="hw-row"><span>${esc(a.name)}</span><span>real balance</span></div><div class="hw-amt hw-type"><span class="hw-t0">\u20B10.00</span><span class="hw-t1">${esc(formatPesos(a.amount))}</span></div>`, "Save")}${tick}`,
      `A finger taps ${a.name}, types its real balance ${formatPesos(a.amount)} and taps Save; the row shows the balance and the count goes up by one.`);
  }
  if (id === "checks") {   // an invented example: card spending rises and the reserve no longer covers it
    return phone("checks", `<div class="hw-screen"><div class="hw-ex">Example</div><div class="hw-h">Checks</div><div class="hw-date">Card reserve</div>
      <div class="hw-card"><div class="hw-row"><span>Test Card owes</span><span class="hw-bval"><span class="hw-t0">\u20B13,048.00</span><span class="hw-t1">\u20B15,548.00</span></span></div>
      <div class="hw-row"><span>Reserve holds</span><span>\u20B15,000.00</span></div>
      <div class="hw-stat hw-bval"><span class="hw-t0">Covered</span><span class="hw-t1">Short by \u20B1548.00</span></div></div>
      <div class="hw-chip">Card purchase \u20B12,500.00</div></div><div class="hw-nav"><div>Log</div><div>Verify</div></div>`,
      "A card purchase of 2,500 pesos is logged; the amount owed goes from 3,048 to 5,548 pesos and Checks changes from Covered to Short by 548 pesos.");
  }
  if (id === "buffer") {   // an invented example: Food goes over its limit and the buffer covers the gap
    return phone("buffer", `<div class="hw-screen"><div class="hw-ex">Example</div><div class="hw-h">Buffer</div><div class="hw-date">Kept aside for overruns</div>
      <div class="hw-card"><div class="hw-row"><span>Food</span><span class="hw-bval"><span class="hw-t0">Over by \u20B1500.00</span><span class="hw-t1">Covered</span></span></div>
      <div class="hw-row"><span>Buffer</span><span class="hw-bval"><span class="hw-t0">\u20B12,000.00</span><span class="hw-t1">\u20B11,500.00</span></span></div></div>
      <div class="hw-chip">Paid from the buffer \u00b7 recorded against Food</div></div><div class="hw-nav"><div>Log</div><div>Verify</div></div>`,
      "Food goes 500 pesos over its limit; the buffer pays the gap, goes from 2,000 to 1,500 pesos, and the draw is recorded against Food.");
  }
  if (id === "import") {   // invented numbers, always marked as an example; reachable from Help (a held button cannot be pressed under an open window)
    return phone("import", `<div class="hw-screen"><div class="hw-ex">Example</div><div class="hw-top"><div class="hw-h">Log</div><div class="hw-cam" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></div></div>
      <div class="hw-date">${esc(d.date)}</div><div class="hw-note">A photo of your notes, a CSV or an Excel file</div></div><div class="hw-nav"><div>Log</div><div>Verify</div></div>
      ${sheet(`<div class="hw-row"><span>Paid from</span>${acct(d.account)}</div><div class="hw-row"><span><b>12 lines</b> to add as drafts</span><span>2 already logged, left out</span></div>`, "Add 10 drafts to Verify")}${tick}`,
      `A finger taps the camera and Import old spending, a file is read, the window shows 12 lines with 2 already logged left out, and the finger taps Add 10 drafts to Verify.`);
  }
  if (id === "backup") {   // Setup's Backup block: tap Back up now, set a password, save the file off the phone; "Last backup" turns to today
    const last = (c) => `<span class="${c}">${c === "hw-t0" ? "No backup yet" : "Last backup today"}</span>`;
    return phone("backup", `<div class="hw-screen"><div class="hw-h">Setup</div><div class="hw-date">Backup</div>
      <div class="hw-bval hw-last">${last("hw-t0")}${last("hw-t1")}</div><div class="hw-btn hw-go">Back up now</div>
      <div class="hw-note">Your data lives only on this phone. A file kept elsewhere is the only way back if it is lost.</div></div><div class="hw-nav"><div>Log</div><div>Verify</div></div>
      ${sheet(`<div class="hw-row"><span>Password</span><span>\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022</span></div><div class="hw-row"><span>Save to</span><span>Files \u00b7 iCloud Drive</span></div>`, "Save the file")}${tick}`,
      "A finger taps Back up now, a password is set, the encrypted file is saved to Files or iCloud Drive off the phone, a tick appears and the line changes to Last backup today.");
  }
  if (id === "trips") {   // the first trip's tag button is tapped: the button turns to "Tagging", and its total grows by an example P950 in the picture only
    const t0 = d.trips[0], add = 95000;
    const cards = d.trips.map((t, i) => `<div class="hw-brow hw-trip${i === 0 ? " hw-bpick" : ""}"><span><b>${esc(t.name)}</b><small>${esc(t.days ?? "No dates yet")}</small></span><span class="hw-bval">${i === 0
      ? `<span class="hw-t0">${esc(formatPesos(t.spent))}</span><span class="hw-t1">${esc(formatPesos(t.spent + add))}</span>` : `<span>${esc(formatPesos(t.spent))}</span>`}</span></div>`).join("");
    return phone("trips", `<div class="hw-screen">${d.tripsExample ? `<div class="hw-ex">Example</div>` : ""}<div class="hw-h">Trips</div><div class="hw-date">Kept apart from everyday spending</div>
      <div class="hw-blist">${cards}</div><div class="hw-note">Or give the trip dates: entries on those days join by themselves.</div><div class="hw-btn hw-tag"><span class="hw-t0">Tag new entries with this trip</span><span class="hw-t1">Tagging new entries \u2713</span></div></div>
      <div class="hw-nav"><div>Log</div><div>Verify</div></div>${tick}`,
      `A finger taps Tag new entries on ${t0.name}; the button turns to Tagging and the trip's total grows when a new entry is logged, apart from everyday spending.`);
  }
  return "";
}
