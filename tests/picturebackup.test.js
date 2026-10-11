import { test } from "node:test";
import assert from "node:assert/strict";
import { planParts, partFileName, sealPictures, openPictures } from "../src/model/index.js";

const PASS = "correct horse battery", FAST = { iterations: 100000 };
const pic = (id, n, fill) => ({ id, bytes: new Uint8Array(n).fill(fill) });
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const fromBytes = (b) => new Blob([b]);
const collect = async (blob, pass = PASS) => { const got = []; const r = await openPictures(blob, pass, async (id, bytes) => got.push([id, bytes])); return { r, got }; };

test("pictures survive a round trip, byte for byte, with the part's own details", async () => {
  const blob = await sealPictures([pic("a", 1000, 7), pic("b", 5, 9), pic("c", 0, 1)], PASS, { ...FAST, savedAt: "2026-10-10", part: 2, parts: 3 });
  const { r, got } = await collect(blob);
  assert.deepEqual(r, { count: 3, part: 2, parts: 3, saved_at: "2026-10-10" });
  assert.deepEqual(got.map(([id, b]) => [id, b.length, b[0] ?? null]), [["a", 1000, 7], ["b", 5, 9], ["c", 0, null]]);
});
test("the file is encrypted: the picture's bytes and the ids are not readable in it", async () => {
  const blob = await sealPictures([{ id: "receipt-id-12345", bytes: new TextEncoder().encode("PRIVATE-RECEIPT-TEXT") }], PASS, FAST);
  const text = new TextDecoder("latin1").decode(await bytesOf(blob));
  assert.ok(!text.includes("PRIVATE-RECEIPT-TEXT") && !text.includes("receipt-id-12345"));
});
test("a wrong passphrase, a short one, and a file that is not ours are all refused plainly", async () => {
  const blob = await sealPictures([pic("a", 50, 1)], PASS, FAST);
  await assert.rejects(() => collect(blob, "another passphrase"), /wrong passphrase or damaged/);
  await assert.rejects(() => sealPictures([], "short"), /at least 12/);
  await assert.rejects(() => collect(new Blob(["just some text that is not a pictures file at all"])), /not a pictures file|cut off/);
  await assert.rejects(() => collect(new Blob([])), /not a pictures file|cut off/);
});
test("a damaged byte, a cut-off file, dropped or swapped pieces and extra data are all noticed", async () => {
  const bytes = await bytesOf(await sealPictures([pic("a", 400, 1), pic("b", 400, 2), pic("c", 400, 3)], PASS, FAST));
  const flipped = bytes.slice(); flipped[bytes.length - 40] ^= 1;
  await assert.rejects(() => collect(fromBytes(flipped)), /wrong passphrase or damaged/);
  await assert.rejects(() => collect(fromBytes(bytes.slice(0, bytes.length - 30))), /cut off|damaged/);
  await assert.rejects(() => collect(fromBytes(bytes.slice(0, bytes.length - 1))), /cut off|damaged/);
  const extra = new Uint8Array(bytes.length + 44); extra.set(bytes); extra.set([0, 0, 0, 40], bytes.length);
  await assert.rejects(() => collect(fromBytes(extra)), /extra data/);
  // cut exactly between two pieces, at the end piece: every remaining piece is fine, only the end marker is gone
  const hl0 = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  let at0 = 4 + hl0, last = at0; while (at0 < bytes.length) { last = at0; at0 += 4 + ((bytes[at0] << 24) | (bytes[at0 + 1] << 16) | (bytes[at0 + 2] << 8) | bytes[at0 + 3]); }
  await assert.rejects(() => collect(fromBytes(bytes.slice(0, last))), /cut off/);
  // cut out the second piece entirely: its position no longer matches, so the next piece will not open
  const hl = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  const first = 4 + hl, l1 = (bytes[first] << 24) | (bytes[first + 1] << 16) | (bytes[first + 2] << 8) | bytes[first + 3], second = first + 4 + l1;
  const l2 = (bytes[second] << 24) | (bytes[second + 1] << 16) | (bytes[second + 2] << 8) | bytes[second + 3];
  const dropped = new Uint8Array([...bytes.slice(0, second), ...bytes.slice(second + 4 + l2)]);
  await assert.rejects(() => collect(fromBytes(dropped)), /damaged|missing/);
});
test("a file asking for absurd key stretching is refused before any work is done", async () => {
  const bytes = await bytesOf(await sealPictures([pic("a", 10, 1)], PASS, FAST));
  const hl = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + hl)));
  header.iterations = 900000000;
  const h = new TextEncoder().encode(JSON.stringify(header)), out = new Uint8Array(4 + h.length + bytes.length - 4 - hl);
  out.set([(h.length >>> 24) & 255, (h.length >>> 16) & 255, (h.length >>> 8) & 255, h.length & 255]); out.set(h, 4); out.set(bytes.slice(4 + hl), 4 + h.length);
  await assert.rejects(() => collect(fromBytes(out)), /unsupported file settings/);
});
test("pictures are cut into parts no bigger than the limit, in order, and a part opens on its own", async () => {
  assert.deepEqual(planParts([{ id: "a", size: 60 }, { id: "b", size: 50 }, { id: "c", size: 100 }], 120), [["a", "b"], ["c"]]);
  assert.deepEqual(planParts([{ id: "a", size: 60 }, { id: "b", size: 61 }, { id: "c", size: 10 }], 120), [["a"], ["b", "c"]], "a picture that would pass the limit starts the next part");
  const parts = planParts([{ id: "a", size: 60 }, { id: "b", size: 50 }, { id: "c", size: 100 }], 120);
  const first = await sealPictures([pic("a", 3, 1), pic("b", 3, 2)], PASS, { ...FAST, part: 1, parts: parts.length }), second = await sealPictures([pic("c", 3, 3)], PASS, { ...FAST, part: 2, parts: parts.length });
  assert.deepEqual((await collect(second)).got.map((x) => x[0]), ["c"], "the second part opens without the first");
  assert.deepEqual((await collect(first)).got.map((x) => x[0]), ["a", "b"]);
  assert.deepEqual(planParts([{ id: "x", size: 500 }], 120), [["x"]], "one picture bigger than the limit goes alone");
  assert.deepEqual(planParts([], 120), []);
  assert.equal(partFileName("2026-10-10", 1, 1), "finance-pictures-2026-10-10.fpics");
  assert.equal(partFileName("2026-10-10", 2, 3), "finance-pictures-2026-10-10-part2of3.fpics");
});
