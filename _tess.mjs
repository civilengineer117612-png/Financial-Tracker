import { createRequire } from "node:module"; import { execSync } from "node:child_process";
const { chromium } = createRequire(import.meta.url)(execSync("npm root -g").toString().trim() + "/playwright");
const b = await chromium.launch(); const page = await b.newPage();
page.on("pageerror", (e) => console.log("PAGEERR", e.message.slice(0, 200)));
await page.goto("http://localhost:8130/tess.html");
const out = await page.evaluate((u) => window.runTess(u), "/img/" + process.argv[2]);
console.log("tesseract ms", out.ms); console.log(out.text);
await b.close();
