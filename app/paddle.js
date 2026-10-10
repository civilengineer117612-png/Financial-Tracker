// The stronger photo reader: PaddleOCR (a neural text finder and reader) run on this phone with ONNX Runtime Web. Its files are in
// src/vendor/paddle, served from this site, so a photo never leaves the phone. Two steps: the finder marks where each line of text is
// (even tilted or on curved paper), then the reader reads each line. Returns every line with its box; what the lines MEAN is decided in
// src/model/scan.js. Written for the browser, no libraries beyond the runtime.
const BASE = new URL("../src/vendor/paddle/", import.meta.url).href;
const DET_MAX = 2048;   // the longest side the finder looks at; bigger reads small print better (a tall phone screenshot at 1536 was read as gibberish) and is slower

// Every file the stronger reader needs, and the cache the worker keeps them in (app/sw.js). "Download it now" in Setup fetches them all once, so the first scan does not wait.
export const READER_FILES = ["ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "ch_PP-OCRv4_det_infer.onnx", "ch_PP-OCRv4_rec_infer.onnx", "ppocr_keys_v1.txt"];
const READER_CACHE = "finance-reader-v1";
export async function readerStored() {
  try { const keys = (await (await caches.open(READER_CACHE)).keys()).map((r) => new URL(r.url).pathname); return READER_FILES.filter((f) => keys.some((k) => k.endsWith("/" + f))).length; } catch { return 0; }
}
export async function warmReader(progress = () => {}) {
  let n = 0;
  for (const f of READER_FILES) {
    progress(n, READER_FILES.length);
    const r = await fetch(BASE + f);
    if (!r.ok) throw new Error("download failed: " + f);
    await r.arrayBuffer();   // read to the end so the worker keeps the whole file
    n++;
  }
  progress(n, READER_FILES.length);
}

let ort = null, det = null, rec = null, dict = null;
async function load(progress) {
  if (det && rec && dict) return;
  progress(0, "Getting the stronger reader ready (the first time it downloads about 30 MB)");
  ort ??= await import(BASE + "ort.wasm.min.mjs");
  ort.env.wasm.wasmPaths = BASE;
  ort.env.wasm.numThreads = 1;   // the page is not cross-origin isolated, so one thread
  const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  det ??= await ort.InferenceSession.create(BASE + "ch_PP-OCRv4_det_infer.onnx", opts);
  rec ??= await ort.InferenceSession.create(BASE + "ch_PP-OCRv4_rec_infer.onnx", opts);
  dict ??= ["", ...(await (await fetch(BASE + "ppocr_keys_v1.txt")).text()).split("\n").filter((x) => x.length), " "];
}

async function toCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0); bmp.close?.();
  return c;
}

// The picture shrunk for the finder (sides a multiple of 32), as the numbers it expects.
function forFinder(canvas) {
  const k = Math.min(1, DET_MAX / Math.max(canvas.width, canvas.height));
  const w = Math.max(32, Math.round((canvas.width * k) / 32) * 32), h = Math.max(32, Math.round((canvas.height * k) / 32) * 32);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d"); ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, t = new Float32Array(3 * w * h), mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < w * h; i++) for (let ch = 0; ch < 3; ch++) t[ch * w * h + i] = (d[i * 4 + ch] / 255 - mean[ch]) / std[ch];
  return { tensor: new ort.Tensor("float32", t, [1, 3, h, w]), w, h, scale: canvas.width / w };
}

// Groups the finder's "this pixel is text" map into pieces of text (connected blobs), each as a tilted rectangle grown a little all round.
function pieces(prob, w, h, thr = 0.3, minMean = 0.5) {
  const seen = new Uint8Array(w * h), out = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || prob[s] < thr) continue;
    const stack = [s], pts = []; let sum = 0; seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(); pts.push(p); sum += prob[p];
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx; if (!seen[q] && prob[q] >= thr) { seen[q] = 1; stack.push(q); }
      }
    }
    if (pts.length < 20 || sum / pts.length < minMean) continue;   // specks and unsure patches are not text
    let mx = 0, my = 0; for (const p of pts) { mx += p % w; my += (p / w) | 0; } mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0; for (const p of pts) { const x = (p % w) - mx, y = ((p / w) | 0) - my; sxx += x * x; syy += y * y; sxy += x * y; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(th), sn = Math.sin(th);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const p of pts) { const x = (p % w) - mx, y = ((p / w) | 0) - my, u = x * c + y * sn, v = -x * sn + y * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const grow = ((u1 - u0) * (v1 - v0) * 1.6) / (2 * ((u1 - u0) + (v1 - v0)));
    out.push({ cx: mx, cy: my, th, u0: u0 - grow, u1: u1 + grow, v0: v0 - grow, v1: v1 + grow });
  }
  return out;
}

// Reads one piece: straighten its tilted rectangle into a strip 48 high, then decode the reader's answer (CTC: collapse repeats, drop blanks).
async function readPiece(canvas, b, scale) {
  const Lu = (b.u1 - b.u0) * scale, Hv = (b.v1 - b.v0) * scale; if (Lu < 6 || Hv < 6) return null;
  const tw = Math.min(960, Math.max(32, Math.ceil((48 * Lu) / Hv))), strip = document.createElement("canvas"); strip.width = tw; strip.height = 48;
  const ctx = strip.getContext("2d"); ctx.imageSmoothingQuality = "high"; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, tw, 48);
  const cs = Math.cos(b.th), sn = Math.sin(b.th), um = (b.u0 + b.u1) / 2, vm = (b.v0 + b.v1) / 2;
  const Cx = (b.cx + um * cs - vm * sn) * scale, Cy = (b.cy + um * sn + vm * cs) * scale, k = tw / Lu, k2 = 48 / Hv;
  ctx.setTransform(k * cs, -k2 * sn, k * sn, k2 * cs, tw / 2 - k * (cs * Cx + sn * Cy), 24 - k2 * (-sn * Cx + cs * Cy));
  ctx.drawImage(canvas, 0, 0);
  const d = ctx.getImageData(0, 0, tw, 48).data, t = new Float32Array(3 * 48 * tw);
  for (let i = 0; i < 48 * tw; i++) for (let ch = 0; ch < 3; ch++) t[ch * 48 * tw + i] = (d[i * 4 + ch] / 255 - 0.5) / 0.5;
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", t, [1, 3, 48, tw]) });
  const o = out[rec.outputNames[0]], T = o.dims[1], K = o.dims[2], data = o.data;
  let text = "", last = -1;
  for (let i = 0; i < T; i++) { let bi = 0, bv = -1e9; for (let j = 0; j < K; j++) { const v = data[i * K + j]; if (v > bv) { bv = v; bi = j; } } if (bi !== 0 && bi !== last) text += dict[bi] ?? ""; last = bi; }
  return text.trim() ? { text: text.trim(), th: b.th, ...boxOf(b, scale) } : null;
}
function boxOf(b, scale) {
  const cs = Math.cos(b.th), sn = Math.sin(b.th), xs = [], ys = [];
  for (const [u, v] of [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]]) { xs.push((b.cx + u * cs - v * sn) * scale); ys.push((b.cy + u * sn + v * cs) * scale); }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// Resolves to [{text, th, x0, y0, x1, y1}] for a picture (a Blob), one per line of text found. progress(fraction, words) as it works.
export async function readBoxes(blob, progress = () => {}) {
  await load(progress);
  const canvas = await toCanvas(blob);
  progress(0.05, "Finding the text");
  const { tensor, w, h, scale } = forFinder(canvas);
  const prob = (await det.run({ [det.inputNames[0]]: tensor }))[det.outputNames[0]].data;
  const found = pieces(prob, w, h).sort((a, b) => a.cy - b.cy), lines = [];
  for (let i = 0; i < found.length; i++) {
    progress(0.1 + 0.9 * (i / found.length), "Reading the photo");
    const line = await readPiece(canvas, found[i], scale); if (line) lines.push(line);
  }
  return lines;
}
