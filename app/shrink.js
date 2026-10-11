// Brings one stored picture down in size (see src/model/pictures.js for when and how far). Returns the smaller picture, or null when there is nothing to
// gain or the smaller copy does not check out: then the original is kept as it is.
import { targetSize, SHRINK_MAX_SIDE } from "../src/model/pictures.js";

const SMALL_ENOUGH = 300 * 1024;   // a picture already this small is left alone
const decode = (blob) => createImageBitmap(blob);   // the browser applies the camera's rotation itself

export async function shrinkBlob(blob) {
  let bmp = null, again = null;
  try {
    bmp = await decode(blob);
    const t = targetSize(bmp.width, bmp.height, SHRINK_MAX_SIDE);
    if (!t || (!t.resized && blob.size <= SMALL_ENOUGH)) return null;
    const c = document.createElement("canvas"); c.width = t.width; c.height = t.height;
    c.getContext("2d").drawImage(bmp, 0, 0, t.width, t.height);
    const out = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.8));
    if (!out || out.size >= blob.size) return null;   // not smaller: keep the original
    again = await decode(out);   // the new copy must open, at the size meant
    return again.width === t.width && again.height === t.height ? out : null;
  } catch { return null; } finally { bmp?.close?.(); again?.close?.(); }
}
