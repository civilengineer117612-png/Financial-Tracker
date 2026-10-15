import { test } from "node:test";
import assert from "node:assert/strict";
import { reserveCover, netPosition, emptyState } from "../src/model/index.js";
import { readFileSync } from "node:fs";
import { account } from "./fixtures.js";
const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8"), css = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");

// Invented numbers only (centavos).
const accounts = [account({ id: "deb", name: "Test Debit", class: "asset", opening_balance: 1000000, reserve_for: "card" }), account({ id: "card", name: "Test Card", class: "liability" }), account({ id: "w", name: "Test Wallet", class: "asset", opening_balance: 250000 })];
const spend = (amount) => [{ transaction_id: "t", category_id: "c", amount }, { transaction_id: "t", account_id: "card", amount: -amount }];

test("a reserve shows how much of it the card is owed, how much is free, and the owed share for a bar", () => {
  const [r] = reserveCover(accounts, spend(300000));
  assert.deepEqual([r.reserve_id, r.card_id, r.balance, r.owed, r.kept, r.free, r.share], ["deb", "card", 1000000, 300000, 300000, 700000, 0.3]);
  assert.equal(reserveCover(accounts, []).length, 1);
  assert.equal(reserveCover(accounts, [])[0].share, 0, "nothing owed: an empty bar");
  assert.equal(reserveCover(accounts.filter((a) => !a.reserve_for), spend(100)).length, 0, "an account that covers no card has no bar");
});

test("a reserve that cannot cover the card is a full bar with nothing free, and an empty reserve that is owed is full too", () => {
  const short = reserveCover(accounts, spend(1500000))[0];
  assert.deepEqual([short.kept, short.free, short.share], [1000000, 0, 1]);
  const empty = reserveCover([{ ...accounts[0], opening_balance: 0 }, accounts[1]], spend(500))[0];
  assert.deepEqual([empty.kept, empty.free, empty.share], [0, 0, 1]);
});

test("the net: what you have minus what the cards are owed, and the owed share of what you have", () => {
  assert.deepEqual(netPosition(1250000, 300000), { have: 1250000, owed: 300000, free: 950000, share: 0.24 });
  assert.equal(netPosition(100, 300).free, -200, "owing more than you have shows as negative");
  assert.equal(netPosition(100, 300).share, 1);
  assert.equal(netPosition(0, 0).share, 0);
  assert.equal(netPosition(0, 50).share, 1);
});

test("Cards: the net on top, swipe cards with a debit account right before the card it backs, and a list twin one tap away", () => {
  assert.match(app, /const net = M\.netPosition\(o\.held, o\.owe\), covers = reserveCovers\(\);/);
  assert.match(app, /for \(const c of o\.cards\) \{ for \(const m of sorted\) if \(acct\(m\.account_id\)\?\.reserve_for === c\.account_id\) \{ seq\.push\(\{ m \}\); used\.add\(m\.account_id\); \} seq\.push\(\{ c \}\); \}/, "the account that backs a card sits right before it");
  assert.match(app, /\$\{ui\.cardsList \? listView : cardView\}/);
  assert.match(app, /data-action="cards-list">\$\{ui\.cardsList \? "Show as cards" : "Show as a list"\}/);
  assert.match(app, /case "cards-list": ui\.cardsList = !ui\.cardsList; renderScreen\(\); break;/);
  assert.ok(app.includes("Move money between accounts") && app.includes('data-page="accounts">Add or change accounts'), "the two actions stay at the bottom");
});

test("the bar: ink on the track colour, never red, with words only for a screen reader, in Setup, under Paid from and on Cards", () => {
  assert.match(css, /\.cover \{ display: flex; height: 6px; border-radius: 3px; background: var\(--track\); overflow: hidden; flex: 1; \} \.cover span \{ display: block; background: var\(--ink\); \}/);
  assert.match(app, /const coverBar = \(share, label\) => `<span class="cover" role="img" aria-label="\$\{esc\(label\)\}">/);
  assert.match(app, /kept for \$\{accountName\(c\.card_id\)\}, \$\{peso\(c\.free\)\} free to spend/);
  assert.match(app, /const paidChips = \(selected, pockets = false\) => \{[^\n]*accountPicker\(cur \? \[\.\.\.list, cur\] : list, selected\) \+ reserveStrip\(\); \};/);
  assert.ok((app.match(/paidChips\(/g) ?? []).length >= 8, "every Paid from, Arrived in and Take it from row carries the strip");
  assert.match(app, /return a && !a\.archived \? `<div class="coverrow">\$\{iconOf\(a, 20\)\}\$\{coverBar\(c\.share, a\.name \+ ": " \+ coverLabel\(c\)\)\}<\/div>` : "";/, "a picture and a bar for each reserve account, not for an archived one");
  assert.match(app, /<div class="coverwrap">\$\{coverBar\(cv\.share, coverLabel\(cv\)\)\}<\/div>/, "Setup's account row");
});

test("a savings pocket is switched on in the add form and in Setup, kept out of Paid from, folded on Cards, and found by its digits on a statement", () => {
  assert.match(app, /data-action="toggle-pocket-form"/); assert.match(app, /data-action="toggle-pocket" data-id=/); assert.match(app, /data-action="toggle-pockets" data-id=/);
  assert.match(app, /pocket: f\.kind === "asset" && f\.pocket && !f\.covers/, "a card's reserve is never a pocket");
  assert.match(app, /accountPicker\(accountsFor\(null, true\), [^,]+, "pick-from"/, "Move money still offers pockets");
  assert.match(app, /return activeAccounts\(\)\.filter\(\(a\) => pockets \|\| !M\.isPocket\(a\)\)/, "Paid from leaves them out");
  assert.match(app, /if \(open\[m\.account_id\]\) rows\.push\(\.\.\.mine\)/, "a bank's pockets show only when its main account is opened");
});
