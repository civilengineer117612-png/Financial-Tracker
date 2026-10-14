import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { readPng } from "../tools/png.mjs";

// The app's icon: one SVG source (app/icon.svg) and the pictures made from it by tools/make-icons.mjs. Everything here looks at the real files.
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const bytes = (p) => readFileSync(new URL("../" + p, import.meta.url));
const GREEN = { r: 0x1e, g: 0x5b, b: 0x47 };
const near = (p, c, tol = 40) => Math.abs(p.r - c.r) <= tol && Math.abs(p.g - c.g) <= tol && Math.abs(p.b - c.b) <= tol;
const white = (p, tol = 6) => p.r >= 255 - tol && p.g >= 255 - tol && p.b >= 255 - tol;
const SIZES = { "app/icon-180.png": 180, "app/icon-192.png": 192, "app/icon-512.png": 512, "app/icon-maskable-512.png": 512, "app/favicon-32.png": 32 };

test("the SVG source is the owner's symbol: white square, deep green, round caps and joins, the four strokes, no text and no border", () => {
  const svg = read("app/icon.svg");
  assert.match(svg, /viewBox="0 0 100 100"/);
  assert.match(svg, /<rect width="100" height="100" fill="#FFFFFF"\/>/, "an opaque white square, with no stroke of its own");
  assert.match(svg, /stroke="#1E5B47"/);
  assert.match(svg, /stroke-width="7"/);
  assert.match(svg, /stroke-linecap="round"/);
  assert.match(svg, /stroke-linejoin="round"/);
  for (const d of ["M24 32 H76", "M24 50 H76", "M24 68 H48", "M56 66 L65 75 L80 57"]) assert.ok(svg.includes(`<path d="${d}"/>`), d);
  assert.equal((svg.match(/<path /g) ?? []).length, 4, "exactly the four strokes");
  assert.doesNotMatch(svg, /<text|<image|opacity|<defs|gradient|filter/i);
});

test("every icon file exists at its stated size, is opaque (no alpha channel) and white at the corners", () => {
  for (const [file, size] of Object.entries(SIZES)) {
    assert.ok(existsSync(new URL("../" + file, import.meta.url)), file);
    const png = readPng(bytes(file));
    assert.deepEqual([png.width, png.height], [size, size], file + " is " + size + "x" + size);
    assert.equal(png.hasAlpha, false, file + " has no alpha channel");
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) assert.ok(white(png.pixel(x, y), 0), file + " corner " + x + "," + y + " is pure white");
  }
});

test("the pictures draw the symbol where the SVG puts it: three lines and a check in deep green on white", () => {
  for (const file of ["app/icon-180.png", "app/icon-192.png", "app/icon-512.png", "app/favicon-32.png"]) {
    const png = readPng(bytes(file)), s = png.width, at = (gx, gy) => png.pixel(Math.round((gx / 100) * s - 0.5), Math.round((gy / 100) * s - 0.5));
    for (const [gx, gy] of [[50, 32], [50, 50], [30, 68], [70, 69]]) assert.ok(near(at(gx, gy), GREEN, 45), file + " is green at the grid point " + gx + "," + gy);
    for (const [gx, gy] of [[50, 41], [50, 59], [70, 59], [60, 41], [50, 12], [12, 50], [50, 88]]) assert.ok(white(at(gx, gy), 12), file + " is white at the grid point " + gx + "," + gy);
    if (s >= 100) assert.ok(white(at(66, 68), 12), file + ": the third line stops at x=48");   // too fine to tell at 32 px
  }
});

test("the maskable picture draws the symbol smaller (80%) and keeps all of it inside the central safe circle (40% of the size)", () => {
  const extent = (png) => { let x0 = png.width, x1 = -1, y0 = png.height, y1 = -1; for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) if (!white(png.pixel(x, y), 40)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return { w: x1 - x0 + 1, h: y1 - y0 + 1 }; };
  const outside = (png, r) => { let n = 0; const c = png.width / 2; for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) if (Math.hypot(x + 0.5 - c, y + 0.5 - c) > r && !white(png.pixel(x, y), 40)) n++; return n; };
  const mask = readPng(bytes("app/icon-maskable-512.png")), plain = readPng(bytes("app/icon-512.png")), em = extent(mask), ep = extent(plain);
  assert.equal(outside(mask, 0.4 * 512), 0, "nothing of the symbol outside the safe circle");
  assert.ok(Math.abs(em.w / ep.w - 0.8) < 0.02 && Math.abs(em.h / ep.h - 0.8) < 0.02, "the symbol is 80% of the ordinary one (" + em.w + " against " + ep.w + ")");
  assert.ok(near(mask.pixel(256, Math.round(0.5 * 512 + (32 - 50) * 0.8 * 5.12)), GREEN, 45), "and it is still the symbol: the top line is green where it should be");
});

test("the manifest lists exactly the 192 and 512 icons (any) and the 512 maskable one, each present at the stated size", () => {
  const m = JSON.parse(read("app/manifest.json"));
  assert.deepEqual(m.icons.map((i) => [i.src, i.sizes, i.type, i.purpose]), [
    ["icon-192.png", "192x192", "image/png", "any"], ["icon-512.png", "512x512", "image/png", "any"], ["icon-maskable-512.png", "512x512", "image/png", "maskable"]]);
  for (const i of m.icons) { const [w] = i.sizes.split("x").map(Number), png = readPng(bytes("app/" + i.src)); assert.deepEqual([png.width, png.height], [w, w], i.src); }
});

test("the page points at the 180 touch icon and the 32 favicon, and every icon file is in the offline list", () => {
  const html = read("app/index.html"), sw = read("app/sw.js");
  assert.match(html, /<link rel="apple-touch-icon" href="icon-180\.png">/);
  assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="favicon-32\.png">/);
  const block = sw.slice(sw.indexOf("const FILES = ["), sw.indexOf("];", sw.indexOf("const FILES = [")));
  for (const f of ["icon.svg", "icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "favicon-32.png"]) assert.ok(block.includes(`"${f}"`), f + " is in app/sw.js");
});
