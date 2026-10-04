// Reads the text on a photo, on this phone. The reader (Tesseract) and its English model are files of this site
// (src/vendor/ocr), so the photo is never sent anywhere. What the text MEANS is decided in src/model/scan.js.
const BASE = new URL("../src/vendor/ocr/", import.meta.url).href;

// A phone that cannot run the faster SIMD build gets the plain one.
const hasSimd = () => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; } };

// Shrinks a photo so reading is quick and keeping it is cheap: the long side is at most `maxSide`, as a JPEG.
// A phone photo carries its rotation inside the file, so it is applied here and the stored picture is the right way up.
export async function preparePhoto(file, maxSide = 2400) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { bmp = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("this file is not a picture it can open")); img.src = URL.createObjectURL(file); }); }
  const w = bmp.width ?? bmp.naturalWidth, h = bmp.height ?? bmp.naturalHeight;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * k)); canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("the picture could not be shrunk");
  return blob;
}

let loading = null, worker = null, onProgress = () => {};
function loadScript() {
  if (window.Tesseract) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = BASE + "tesseract.min.js";
    s.onload = resolve;
    s.onerror = () => { loading = null; reject(new Error("the reader could not be loaded (it needs the internet the first time)")); };
    document.head.appendChild(s);
  });
  return loading;
}

// A copy of the photo with the shadows taken out, for reading paper that was photographed under uneven light: each spot is made black or
// white by comparing it with the average of the spots around it (an adaptive threshold), so a shadow across a page no longer hides the words.
export async function evenedCopy(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas"); canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext("2d"); ctx.drawImage(bmp, 0, 0); bmp.close?.();
  const { width: W, height: H } = canvas, img = ctx.getImageData(0, 0, W, H), d = img.data;
  const gray = new Uint8ClampedArray(W * H), sum = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { const i = y * W + x, g = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114); gray[i] = g; row += g; sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + row; } }
  const r = Math.max(8, Math.round(Math.max(W, H) / 40));   // the size of the neighbourhood
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r), n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = (sum[(y1 + 1) * (W + 1) + x1 + 1] - sum[y0 * (W + 1) + x1 + 1] - sum[(y1 + 1) * (W + 1) + x0] + sum[y0 * (W + 1) + x0]) / n;
      const v = gray[y * W + x] < mean * 0.88 ? 0 : 255, i = (y * W + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Resolves to {text, words, boxes}: the text found, every word with its box (x0, y0, x1, y1) so the reading can use where words sit on the
// page, and, when the stronger reader (app/paddle.js, about 30 MB the first time) ran, its line boxes. If that reader cannot run on this
// phone the plain one (Tesseract) answers and boxes is null. progress(fraction 0..1, what) is called while it works.
export async function readPage(blob, progress = () => {}) {
  try {
    const { readBoxes } = await import("./paddle.js");
    const boxes = await readBoxes(blob, progress);
    return { text: boxes.map((b) => b.text).join("\n"), words: [], boxes };
  } catch (e) { console.warn("stronger reader unavailable, using the plain one:", e); }
  return readPlain(blob, progress);
}

async function readPlain(blob, progress = () => {}) {
  onProgress = progress;
  await loadScript();
  worker ??= await window.Tesseract.createWorker("eng", 1, {
    workerPath: BASE + "worker.min.js",
    corePath: BASE + (hasSimd() ? "tesseract-core-simd-lstm.wasm.js" : "tesseract-core-lstm.wasm.js"),
    langPath: BASE, gzip: true, workerBlobURL: false, cacheMethod: "none",
    logger: (m) => { if (m.status === "recognizing text") onProgress(m.progress, "Reading the photo"); else onProgress(0, "Getting the reader ready"); },
  });
  const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });
  const words = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words))).map((w) => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
  return { text: data.text ?? "", words, boxes: null };
}

// Just the text.
export const readText = async (blob, progress) => (await readPage(blob, progress)).text;
