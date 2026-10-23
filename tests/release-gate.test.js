import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const pages = read(".github/workflows/pages.yml"), checks = read(".github/workflows/test.yml");
// Extract only job-level blocks; assertions inspect the committed workflow, not a
// separate policy implementation that could disagree with what GitHub executes.
const job = (yaml, id) => yaml.match(new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"))?.[1] ?? "";
const deploy = job(pages, "deploy"), gate = job(pages, "checks");

test("Pages cannot publish until the reusable checks job succeeds", () => {
  assert.match(deploy, /^    needs: checks$/m);
  assert.match(gate, /^    uses: \.\/\.github\/workflows\/test\.yml$/m);
  assert.doesNotMatch(deploy + gate, /^    (?:if|continue-on-error):/m, "no failure/skip bypass at the job boundary");
  assert.match(checks, /^  workflow_call:$/m);
});

test("the release gate runs unit tests and every browser suite without swallowing failure", () => {
  const unit = job(checks, "test"), browser = job(checks, "e2e");
  assert.match(unit, /^      - run: npm test$/m);
  assert.match(browser, /shell: bash\n        run: \|\n          node e2e\/pdf-scan\.mjs\n          node e2e\/spending-details\.mjs\n          node e2e\/run\.mjs 2>&1 \| tee e2e\.log/);
  assert.doesNotMatch(unit + browser, /continue-on-error:|^    if:|node e2e\/.*\|\| true/m);
});

test("push and manual releases check out the triggering commit for both checks and publishing", () => {
  assert.match(pages, /^  push:\n    branches: \[main\]\n  workflow_dispatch:/m);
  assert.match(checks, /^  push:\n  pull_request:\n  workflow_call:/m);
  for (const section of [job(checks, "test"), job(checks, "e2e"), deploy]) {
    assert.match(section, /uses: actions\/checkout@v4/);
    assert.doesNotMatch(section, /^\s+ref:|git (?:pull|switch|checkout)|workflow_run|head_sha/m, "default checkout stays on this invocation's commit");
  }
  assert.doesNotMatch(gate, /@|^    with:/m, "the local reusable workflow comes from the caller's commit");
});

const stamp = "0123456789abcdef0123456789abcdef01234567";
function stageExample() {
  const dir = mkdtempSync(join(tmpdir(), "found-release-test-"));
  // Fake vendor bytes only. No test opens any source under the real src/vendor/.
  const inputs = {
    "index.html": "forward", "sw.js": "retire worker", "app/index.html": "example app",
    "app/sw.js": 'const VERSION = "__VERSION__";\nconst CACHE = "finance-" + VERSION;\nconst READER_CACHE = "finance-reader-v1";\n',
    "app/fonts/example.woff2": "example font", "src/model/example.js": "example model",
    "src/model/version.js": 'export const APP_BUILD = "__BUILD__";\nexport const APP_BUILT_ON = "__BUILT_ON__";\n',
    "src/vendor/example/reader.js": "invented reader bytes", "tests/private.test.js": "must not ship",
    ".github/workflows/example.yml": "must not ship", "README.md": "must not ship",
  };
  try {
    for (const [path, body] of Object.entries(inputs)) {
      mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), body);
    }
    const script = deploy.match(/      - name: Stage only the site files\n        run: \|\n([\s\S]*?)(?=^      -)/m)?.[1];
    assert.ok(script, "the existing staging step remains available");
    execFileSync(process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash", ["-e", "-o", "pipefail", "-c", script.replace(/^          /gm, "")], { cwd: dir, env: { ...process.env, GITHUB_SHA: stamp } });
    const output = {};
    const walk = (path = "") => { for (const item of readdirSync(join(dir, "_site", path), { withFileTypes: true })) {
      const key = path ? path + "/" + item.name : item.name;
      if (item.isDirectory()) walk(key); else output[key] = readFileSync(join(dir, "_site", key), "utf8");
    } };
    walk(); return { inputs, output };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("staging publishes exactly the site tree, including nested fonts and the reader", () => {
  const { inputs, output } = stageExample();
  const published = Object.keys(inputs).filter(p => p === "index.html" || p === "sw.js" || /^(app\/|src\/model\/|src\/vendor\/)/.test(p));
  assert.deepEqual(Object.keys(output).sort(), published.sort());
  for (const path of published.filter(p => !["app/sw.js", "src/model/version.js"].includes(p))) assert.equal(output[path], inputs[path], path);
});

test("staging keeps the commit stamps, Manila date and offline cache names", () => {
  const { inputs, output } = stageExample();
  assert.equal(output["app/sw.js"], inputs["app/sw.js"].replace("__VERSION__", stamp.slice(0, 12)));
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  assert.equal(output["src/model/version.js"], inputs["src/model/version.js"].replace("__BUILD__", stamp.slice(0, 7)).replace("__BUILT_ON__", day));
});
