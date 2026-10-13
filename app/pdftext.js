// Opens a PDF on this phone and gives back the pieces of text on each page: {x, y, w, str}. The reader (pdf.js, Apache 2.0) is copied unchanged into src/vendor/pdf
// and served from this site; the file never leaves the phone. A locked PDF asks for its password through `askPassword(wrong)`, which returns the text typed, or
// null to give up; the password is used once to open the file and is not kept.
let pdfjsPromise = null;
const loadReader = () => (pdfjsPromise ??= import("../src/vendor/pdf/pdf.min.mjs").then((m) => {
  m.GlobalWorkerOptions.workerSrc = new URL("../src/vendor/pdf/pdf.worker.min.mjs", import.meta.url).href;
  return m;
}));

export class PdfCancelled extends Error {}

export async function readPdfPages(file, askPassword) {
  let pdfjs;
  try { pdfjs = await loadReader(); } catch { throw new Error("The PDF reader could not load. Connect to the internet once so it can download (about 2 MB); after that it works without."); }
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  task.onPassword = async (update, reason) => {
    const typed = await askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    if (typed == null) { task.destroy(); return; }
    update(typed);
  };
  let doc;
  try { doc = await task.promise; } catch (err) {
    if (err?.name === "PasswordException" || /destroyed|cancel|abort/i.test(String(err?.message))) throw new PdfCancelled("cancelled");
    throw new Error("This file could not be opened as a PDF.");
  }
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push(tc.items.filter((i) => typeof i.str === "string").map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, str: i.str })));
  }
  await doc.destroy();
  return pages;
}
