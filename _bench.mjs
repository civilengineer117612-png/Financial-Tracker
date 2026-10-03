import { createRequire } from "node:module"; import { execSync } from "node:child_process";
const { chromium } = createRequire(import.meta.url)(execSync("npm root -g").toString().trim() + "/playwright");
const b = await chromium.launch(); const page = await b.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 200)); }); page.on("pageerror", (e) => console.log("PAGEERR", e.message.slice(0, 300)));
await page.goto("http://localhost:8130/index.html"); await page.waitForFunction(() => window.runPaddle, null, { timeout: 20000 });
const r = await page.evaluate((u) => window.runPaddle(u), "/img/" + process.argv[2]);
console.log("ms", r.ms, "boxes", r.n); console.log(r.lines.map((l) => l.text).join("\n"));
await b.close();
