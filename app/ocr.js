// Reads the text on a photo, on this phone. The reader (Tesseract) and its English model are files of this site
// (src/vendor/ocr), so the photo is never sent anywhere. What the text MEANS is decided in src/model/scan.js.
const BASE = new URL("../src/vendor/ocr/", import.meta.url).href;

// A phone that cannot run the faster SIMD build gets the plain one.
const hasSimd = () => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; } };

// Shrinks a photo so reading is quick and keeping it is cheap: the long side is at most `maxSide`, as a JPEG.
// A phone photo carries its rotation inside the file, so it is applied here and the stored picture is the right way up.
export async function preparePhoto(file, maxSide = 1600) {
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

// Resolves to the text found. progress(fraction 0..1, words) is called while it works.
export async function readText(blob, progress = () => {}) {
  onProgress = progress;
  await loadScript();
  worker ??= await window.Tesseract.createWorker("eng", 1, {
    workerPath: BASE + "worker.min.js",
    corePath: BASE + (hasSimd() ? "tesseract-core-simd-lstm.wasm.js" : "tesseract-core-lstm.wasm.js"),
    langPath: BASE, gzip: true, workerBlobURL: false, cacheMethod: "none",
    logger: (m) => { if (m.status === "recognizing text") onProgress(m.progress, "Reading the photo"); else onProgress(0, "Getting the reader ready"); },
  });
  const { data } = await worker.recognize(blob);
  return data.text ?? "";
}
