// Old pictures are shrunk to save the phone's space; the entries and every figure are untouched. A picture stays as taken for 3 months, then is
// shrunk once. `photos_shrunk_through` (a setting) is the timestamp of the last picture done: everything saved up to it has been looked at, and
// new pictures are always newer, so one marker is enough. Pure: the screens pass in the records.
export const KEEP_MONTHS = 3;       // a picture stays as taken this long
export const SHRINK_MAX_SIDE = 1600;   // then its longest side is brought down to this many pixels
export const SHRINK_BATCH = 3;      // pictures shrunk per round, so the phone is never busy for long

// The calendar day this many months before `today` ("2026-10-03" and 3 -> "2026-07-03"; the 31st of a longer month becomes the last day of a shorter one).
export function monthsBefore(today, months) {
  const [y, m, d] = today.split("-").map(Number);
  const total = y * 12 + (m - 1) - months, ny = Math.floor(total / 12), nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

// The pictures to shrink now: older than the keep time, newer than the marker, oldest first, at most `limit`.
export function shrinkDue(attachments, today, marker = "", { months = KEEP_MONTHS, limit = SHRINK_BATCH } = {}) {
  const cutoff = monthsBefore(today, months);
  return (attachments ?? [])
    .filter((a) => a.file_timestamp && a.file_timestamp.slice(0, 10) <= cutoff && (!marker || a.file_timestamp > marker))
    .sort((a, b) => (a.file_timestamp < b.file_timestamp ? -1 : a.file_timestamp > b.file_timestamp ? 1 : 0))
    .slice(0, limit);
}

// How many are done and how many wait, for the line in Setup.
export function shrinkProgress(attachments, today, marker = "", months = KEEP_MONTHS) {
  const cutoff = monthsBefore(today, months);
  const old = (attachments ?? []).filter((a) => a.file_timestamp && a.file_timestamp.slice(0, 10) <= cutoff);
  const waiting = old.filter((a) => !marker || a.file_timestamp > marker).length;
  return { old: old.length, done: old.length - waiting, waiting };
}

// The size a picture is brought down to: the longest side becomes `max`; a picture already that small keeps its size (it is only saved again if that helps).
export function targetSize(width, height, max = SHRINK_MAX_SIDE) {
  const side = Math.max(width, height);
  if (!(side > 0)) return null;
  const k = Math.min(1, max / side);
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), resized: k < 1 };
}
