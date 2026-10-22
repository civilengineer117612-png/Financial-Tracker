// Opens a PDF on this phone and gives back the pieces of text on each page: {x, y, w, str}. The reader (pdf.js, Apache 2.0) is copied unchanged into src/vendor/pdf
// and served from this site; the file never leaves the phone. A locked PDF asks for its password through `askPassword(wrong)`, which returns the text typed, or
// null to give up; the password is used once to open the file and is not kept.
import { pdfScanText } from "../src/model/scan.js";

let pdfjsPromise = null;
const loadReader = () => (pdfjsPromise ??= import("../src/vendor/pdf/pdf.min.mjs").then((m) => {
  m.GlobalWorkerOptions.workerSrc = new URL("../src/vendor/pdf/pdf.worker.min.mjs", import.meta.url).href;
  return m;
}));

export class PdfCancelled extends Error {}

async function openPdf(file, askPassword) {
  let pdfjs;
  try { pdfjs = await loadReader(); } catch { throw new Error("The PDF reader could not load. Connect to the internet once so it can download (about 2 MB); after that it works without."); }
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  let cancel;
  const cancelled = new Promise((_, reject) => { cancel = reject; });
  task.onPassword = async (update, reason) => {
    try {
      const typed = await askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
      if (typed == null) { cancel(new PdfCancelled("cancelled")); void task.destroy().catch(() => {}); return; }
      update(typed);
    } catch (err) { cancel(err); void task.destroy().catch(() => {}); }
  };
  try { return await Promise.race([task.promise, cancelled]); } catch (err) {
    if (err?.name === "PasswordException" || /destroyed|cancel|abort/i.test(String(err?.message))) throw new PdfCancelled("cancelled");
    throw new Error("This file could not be opened as a PDF.");
  }
}

export async function readPdfPages(file, askPassword) {
  const doc = await openPdf(file, askPassword);
  try {
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      pages.push(tc.items.filter((i) => typeof i.str === "string").map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, str: i.str })));
    }
    return pages;
  } finally { await doc.destroy(); }
}

const canvasBlob = (canvas, type = "image/jpeg") => new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The PDF preview could not be made.")), type, 0.9));

// Read embedded text without OCR. Image-only pages use the same on-device photo reader.
// All pages are kept as one picture for the existing review and picture-backup flow.
export async function readPdfScan(file, askPassword, readImage, progress = () => {}) {
  const doc = await openPdf(file, askPassword);
  const preview = document.createElement("canvas");
  try {
    if (doc.numPages > 20) throw new Error("For one receipt or payslip, choose a PDF with no more than 20 pages.");
    const sizes = [];
    for (let n = 1; n <= doc.numPages; n++) sizes.push((await doc.getPage(n)).getViewport({ scale: 1 }));
    // Bound the retained picture to 12 million pixels, including long multi-page slips.
    const ratio = sizes.reduce((sum, s) => sum + s.height / s.width, 0);
    preview.width = Math.max(1, Math.floor(Math.min(1600, Math.sqrt(12000000 / ratio), 12000 / ratio)));
    preview.height = sizes.reduce((sum, s) => sum + Math.ceil(preview.width * s.height / s.width), 0);
    const ctx = preview.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, preview.width, preview.height);
    const texts = [];
    let top = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      progress("Reading PDF page " + n + " of " + doc.numPages + "...");
      const page = await doc.getPage(n), size = sizes[n - 1];
      const viewport = page.getViewport({ scale: Math.min(2.5, 2400 / Math.max(size.width, size.height)) });
      const canvas = document.createElement("canvas");
      try {
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport, background: "white" }).promise;
        const tc = await page.getTextContent();
        const items = tc.items.filter((i) => typeof i.str === "string" && i.str.trim()).map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, h: i.height, str: i.str }));
        const embedded = pdfScanText(items);
        texts.push(embedded.trim() ? embedded : await readImage(await canvasBlob(canvas, "image/png")));
        const height = Math.ceil(preview.width * size.height / size.width);
        ctx.drawImage(canvas, 0, top, preview.width, height); top += height;
      } finally { canvas.width = canvas.height = 0; page.cleanup(); }
    }
    return { text: texts.join("\n"), blob: await canvasBlob(preview) };
  } finally { preview.width = preview.height = 0; await doc.destroy(); }
}
