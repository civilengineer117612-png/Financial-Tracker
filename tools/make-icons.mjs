// Makes the app's icon pictures from the ONE source, app/icon.svg. Run it again whenever the SVG changes:  node tools/make-icons.mjs
// (needs the Playwright browser that the e2e run uses). The files are opaque RGB, white background, no transparency.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readPng, writeRgbPng } from "./png.mjs";

const { chromium } = createRequire(import.meta.url)(execSync("npm root -g").toString().trim() + "/playwright");
const svg = readFileSync(new URL("../app/icon.svg", import.meta.url), "utf8");
// The maskable picture: the same symbol drawn smaller (80%) around the middle, so a round or rounded mask never cuts it.
const maskable = svg.replace('<g id="symbol"', '<g id="symbol" transform="translate(50 50) scale(0.8) translate(-50 -50)"');
if (maskable === svg) throw new Error("the symbol group was not found in app/icon.svg");

const JOBS = [["icon-180.png", 180, svg], ["icon-192.png", 192, svg], ["icon-512.png", 512, svg], ["icon-maskable-512.png", 512, maskable], ["favicon-32.png", 32, svg]];
const browser = await chromium.launch();
for (const [file, size, source] of JOBS) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><body style="margin:0;background:#fff"><img width="${size}" height="${size}" style="display:block" src="data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}"></body>`);
  await page.waitForFunction(() => document.images[0].complete);
  const shot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(new URL("../app/" + file, import.meta.url), writeRgbPng(readPng(shot)));
  await page.close();
  console.log("wrote app/" + file, size + "x" + size);
}
await browser.close();
