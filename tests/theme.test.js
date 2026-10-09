import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const html = read("app/index.html"), css = html.slice(html.indexOf("<style>"), html.indexOf("</style>")), js = read("app/app.js"), sw = read("app/sw.js");

// Ledger Paper: a visual change only. Nothing here touches stored data.

test("the tokens are the ones in the design, each declared once, and the screens use only them", () => {
  const T = { "--ground": "#F5F3EE", "--surface": "#FFFFFF", "--ink": "#1B1D1F", "--muted": "#5C6166", "--line": "#E2DDD3", "--track": "#ECE8DF", "--accent": "#1E5B47", "--dashed": "#A39B8B" };
  for (const [k, v] of Object.entries(T)) assert.equal(css.split(k + ": " + v + ";").length - 1, 1, k + " is declared once as " + v);
  assert.ok(css.includes("--critical: #D03B3B;"), "red stays, for strictly-over only");
  assert.ok(!/#[0-9a-fA-F]{6}\b/.test(js), "the screens' code writes no colour");
  const body = css.slice(css.indexOf("--sans:"));
  assert.ok(!/(^|[^-\w])#(?!fff\b)[0-9a-fA-F]{3,6}\b/.test(body.replace(/--(good|warn|serious|lightbox)[^;]*;/g, "")), "after the token block there is no colour written in the rules");
});

test("the text contrast of the token pairs is at least 4.5:1", () => {
  const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [fg, bg] of [["#1B1D1F", "#F5F3EE"], ["#1B1D1F", "#FFFFFF"], ["#5C6166", "#F5F3EE"], ["#5C6166", "#FFFFFF"], ["#5C6166", "#ECE8DF"], ["#FFFFFF", "#1E5B47"], ["#1E5B47", "#FFFFFF"]]) assert.ok(ratio(fg, bg) >= 4.5, fg + " on " + bg + " is " + ratio(fg, bg).toFixed(2));
});

test("fonts: IBM Plex Sans is bundled with its licence and listed for offline use; nothing is fetched from a font service", () => {
  const dir = new URL("../app/fonts/", import.meta.url), files = readdirSync(dir);
  for (const w of [400, 500, 600]) { assert.ok(files.includes(`ibm-plex-sans-latin-${w}-normal.woff2`) && files.includes(`ibm-plex-sans-latin-ext-${w}-normal.woff2`), "weight " + w + " (the extended file carries the peso sign)"); assert.ok(sw.includes(`"fonts/ibm-plex-sans-latin-${w}-normal.woff2"`), "listed in sw.js"); }
  assert.ok(files.includes("OFL.txt") && sw.includes('"fonts/OFL.txt"') && /SIL Open Font License, Version 1\.1/.test(readFileSync(new URL("OFL.txt", dir), "utf8")), "the OFL licence file is included and listed");
  assert.ok(!/fonts\.googleapis|fonts\.gstatic|cdn\.|https?:\/\/[^"')]*font/i.test(html + js), "no font service");
  assert.ok(/--sans: "IBM Plex Sans", system-ui, sans-serif;/.test(css), "the fallback stack is system-ui, sans-serif");
  assert.ok(/font-variant-numeric: tabular-nums/.test(css), "figures have even-width digits");
  for (const f of files.filter((x) => x.endsWith(".woff2"))) assert.ok(existsSync(new URL(f, dir)));
});

test("components: header buttons, one dashed trial line, one filled button, white cards without shadows, slim bottom bar, segmented control", () => {
  assert.match(css, /\.camicon, \.camicon\.micbtn \{ width: 44px; height: 44px; min-height: 44px; border-radius: 12px; background: var\(--surface\); color: var\(--ink\); border: 1px solid var\(--line\);/, "Mic and Scan are outlined 44 px squares");
  assert.match(css, /\.trialstrip \{[^}]*border: 1px dashed var\(--dashed\);/, "the trial strip is one dashed line");
  assert.ok(js.includes("Trial copy. Do not enter real data.") && js.includes('data-action="reset-trial">${ui.confirmTrial ? "Tap again to erase" : "Start over"}'), "its words, and Start over keeps its second tap");
  assert.match(css, /button\.primary \{ background: var\(--accent\); border-color: var\(--accent\); color: var\(--surface\);/, "the one filled button is accent with white text");
  assert.match(css, /\.card, \.bcard \{ background: var\(--surface\); border: 1px solid var\(--line\); border-radius: 14px; box-shadow: none; \}/, "cards are white, 1 px line, 14 px radius, no shadow");
  assert.ok(!/border-left:\s*[2-9]px|border-right:\s*[2-9]px/.test(css), "no stripes down the side of a card");
  assert.match(css, /#nav \{ background: var\(--surface\); border-top: 1px solid var\(--line\);/); assert.match(css, /#nav button\[aria-current="page"\] \{ background: none; color: var\(--accent\); font-weight: 600; \}/, "the bottom bar is white, the current item accent and weight 600");
  assert.match(css, /\.seg \{ background: var\(--track\); border-radius: 12px; padding: 4px;/); assert.match(css, /\.seg button\[aria-pressed="true"\][^{]*\{ background: var\(--surface\); color: var\(--ink\); font-weight: 600; \}/, "the selected item is white, weight 600");
  assert.match(js, /rect y="13" width="13"/, "the menu icon is three lines, the last shorter");
  assert.match(css, /button\.link \{ padding-top: 12px; padding-bottom: 12px; margin-top: -12px; margin-bottom: -12px; \}/, "a text link is a 44 px target");
});

test("Log reads top to bottom: header, date and backup, SPENT TODAY, the amount, Select date, tiles, the one filled button, This month", () => {
  const log = js.slice(js.indexOf("function viewLog()"), js.indexOf("// The quick tiles."));
  const order = ['<div class="logmeta">', "${dayCard()}", "${tilesHtml()}", 'data-action="open-other">Add expense', "${monthGlance()}", "entriesBlock("].map((m) => log.indexOf(m));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), "order: " + order.join(","));
  assert.match(js, /<p class="spentlabel" aria-hidden="true">\$\{picked \? "Spent that day" : "Spent today"\}<\/p>/);
  assert.match(css, /\.spentlabel \{ text-align: center; text-transform: uppercase;/, "SPENT TODAY is a small uppercase label");
});

test("Spending: month switcher, large total with what is left, four segments, one white category card with thin accent bars, See every entry", () => {
  const m = js.slice(js.indexOf("function viewMoney()"), js.indexOf("// Each budget as a meter"));
  assert.ok(!m.includes("flipChart(rows, cat.total") && !js.includes("DONUT_BLUES") && !js.includes("svg class=\"donut\""), "the donut is gone");
  assert.match(m, /<div class="card catcard">/); assert.match(m, /<span class="catbar-x"|class="catbar" role="img"/);
  assert.match(m, /Math\.max\(2, Math\.round\(\(r\.amount \* 100\) \/ top\)\)/, "each bar is scaled to the largest category");
  assert.match(m, /data-action="open-entries">See every entry/);
  assert.match(m, /\$\{ui\.view === "category" \? "" : modeBar\(\)\}/, "the card is its own list: no chart/list switch on Category");
  assert.match(css, /\.catrow \.catbar span \{ display: block; height: 100%; background: var\(--accent\);/);
  assert.ok(/` \\u00b7 \$\{peso\(budgeted - cat\.total\)\} left`/.test(m), "spent in <month> · X left");
});
