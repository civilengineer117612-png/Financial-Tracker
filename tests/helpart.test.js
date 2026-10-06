import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { drawing, DRAWING_IDS, NOTE_ICONS } from "../src/model/helpart.js";
import { SCREEN_NAMES, TERMS } from "../src/model/names.js";
import { TOPICS, QUICK_NOTES } from "../src/model/help.js";

const app = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");
const all = DRAWING_IDS.map((id) => drawing(id));

test("every topic that names a drawing finds it, and the five drawings are each used", () => {
  for (const t of TOPICS.filter((x) => x.drawing)) assert.ok(drawing(t.drawing), t.tab + " finds " + t.drawing);
  for (const id of DRAWING_IDS) assert.ok(TOPICS.some((t) => t.drawing === id) || id === "data", id + " is used");
  assert.equal(drawing("nope"), null);
});

test("every drawing is valid SVG with a title, a description and a one-sentence caption", () => {
  for (const d of all) {
    assert.match(d.svg, /^<svg [^>]*viewBox="0 0 288 \d+"/); assert.ok(d.svg.endsWith("</svg>"));
    assert.match(d.svg, /<title>[^<]+<\/title><desc>[^<]+<\/desc>/);
    assert.ok(d.title && d.description && d.caption.endsWith(".") && d.caption.split(". ").length === 1, d.id + " caption is one sentence");
    // well-formed: tags balance
    const open = (d.svg.match(/<(svg|text|title|desc)\b/g) ?? []).length, close = (d.svg.match(/<\/(svg|text|title|desc)>/g) ?? []).length;
    assert.equal(open, close, d.id + " tags balance");
    assert.ok(!/<(script|image|foreignObject)|href=|xlink|http/.test(d.svg.replace('xmlns="http://www.w3.org/2000/svg"', "")), d.id + " has nothing to fetch");
  }
});

test("no red and no colour values: drawings use theme classes only", () => {
  for (const d of all) { assert.ok(!/#[0-9a-f]{3,8}\b|rgb|hsl|red|critical|fill="|stroke="|style=/i.test(d.svg), d.id + " has no colour of its own"); }
  const css = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const rules = css.split("\n").filter((l) => /svg\.hd/.test(l)).join(" ");
  assert.ok(rules.length > 200 && !/critical|#[0-9a-f]{3,6}|rgb/i.test(rules), "the drawing CSS uses variables only, never the red");
});

test("text is short enough for 320 px at 12 px, and the numbered drawings say Example", () => {
  for (const d of all) {
    const texts = [...d.svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    assert.ok(texts.length >= 3);
    for (const x of texts) assert.ok(x.length <= 38, d.id + ": '" + x + "' fits");
    if (/\d/.test(texts.join(" "))) assert.ok(texts.includes("Example"), d.id + " says Example");
  }
  assert.match(readFileSync(new URL("../app/index.html", import.meta.url), "utf8"), /svg\.hd text \{[^}]*font-size: 12px/);
});

test("labels come from the shared names: rename a screen and the drawing changes", () => {
  const renamed = { ...SCREEN_NAMES, verify: "Review", log: "Add", scan: "Capture", setup: "Settings", checks: "Health", money: "Overview" };
  for (const id of ["daily", "data", "reserve", "scan"]) {
    const a = drawing(id), b = drawing(id, { names: renamed });
    assert.notEqual(a.svg, b.svg, id + " follows a rename");
  }
  assert.ok(drawing("daily", { names: renamed }).svg.includes("Review") && !drawing("daily", { names: renamed }).svg.includes("Verify"));
  const dr = drawing("daily", { names: renamed }).svg; assert.ok(dr.includes(">Add<") && !dr.includes(">Log<"), "the first box follows the rename");
  assert.ok(drawing("data").svg.includes(">Setup, Backup<") && drawing("data", { names: renamed }).svg.includes("Settings, Backup"));
  const t = drawing("cashflow", { terms: { ...TERMS, left: "FREE" } }); assert.ok(t.svg.includes("FREE: 25") && !t.svg.includes("LEFT"));
  assert.match(app, /M\.MENU_GROUPS/); assert.match(app, /M\.SCREEN_NAMES\.log/);
});

test("the cash flow drawing is the 100, 60, 15, 25 example and its rule adds up", () => {
  const d = drawing("cashflow");
  for (const x of ["IN: 100", "SPENT: 60", "SAVED: 15", "LEFT: 25", "LEFT = IN - SPENT - SAVED"]) assert.ok(d.svg.includes(x), x);
  assert.equal(100 - 60 - 15, 25); assert.match(d.svg, /own accounts/);
});

test("the card reserve drawing shows Short by X with a dashed outline when short, and Covered when not", () => {
  const short = drawing("reserve", { owed: 60, reserve: 45 }), ok = drawing("reserve", { owed: 40, reserve: 40 });
  assert.ok(short.svg.includes("Short by 15") && /<rect class="hd"/.test(short.svg) && !short.svg.includes("Covered"));
  assert.ok(ok.svg.includes("Covered") && !/<rect class="hd"/.test(ok.svg) && !ok.svg.includes("Short by"));
  const w = (svg, n) => Number(new RegExp('class="ha" x="44" y="[\\d.]+" width="([\\d.]+)"').exec(svg)[1]);
  assert.ok(w(short.svg) < 200, "the reserve bar is drawn to scale");
});

test("the scan drawing carries the handwriting note and says nothing is sent", () => {
  const d = drawing("scan"); assert.match(d.svg, /<text[^>]*>Handwriting is not read well: type it\.<\/text>/); assert.match(d.svg, /<text[^>]*>The phone reads it\. Nothing is sent\.<\/text>/);
});

test("each quick note has its own small line icon, and the words are untouched", () => {
  assert.equal(NOTE_ICONS.length, QUICK_NOTES.length);
  for (const i of NOTE_ICONS) assert.ok(i.length > 20 && !/fill=|stroke=|#/.test(i));
  assert.equal(new Set(NOTE_ICONS).size, 5);
  assert.match(app, /noteIcon\(i\)/);
});

test("the drawing sits at the top of its topic, inside the collapsible, and in the first-run notice", () => {
  assert.match(app, /<\/summary>\$\{figure\(t\.drawing\)\}\$\{t\.lines/);
  assert.match(app, /\$\{figure\("data"\)\}<ol class="notes">/);
  assert.ok(!/with picture|words only/i.test(app), "the topic list shows only name and arrow");
});
