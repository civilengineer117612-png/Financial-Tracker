// Plain words about what is kept on the phone and what a backup leaves out. Pure: the screens pass in the numbers.

// "48 MB", "1.2 GB", "less than 1 MB". Whole megabytes below a gigabyte, one decimal above.
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1048576) return "less than 1 MB";
  if (bytes < 1073741824) return Math.round(bytes / 1048576) + " MB";
  return (bytes / 1073741824).toFixed(1) + " GB";
}

// Pictures live only on the phone: a backup holds the entries, never the pictures. Empty when there are none.
export function picturesNote(count) {
  if (!Number.isInteger(count) || count <= 0) return "";
  return count === 1 ? "1 picture is kept on this phone only. It is not in the backup." : count + " pictures are kept on this phone only. They are not in the backup.";
}

// The photo reader's files are saved once (about 30 MB). stored = how many of its files are on the phone, total = how many it needs.
export function readerStatus(stored, total) {
  if (!Number.isInteger(total) || total <= 0) return { ready: false, text: "" };
  if (stored >= total) return { ready: true, text: "The photo reader is on this phone." };
  return { ready: false, text: "The photo reader (about 30 MB) is not on this phone yet. It downloads at your first scan, or now." };
}

// "This app uses about 48 MB of the phone's space (the reader, pictures and ledger)." Empty when the phone does not say.
export const usageLine = (bytes) => (formatSize(bytes) ? "This app uses " + (bytes < 1048576 ? "" : "about ") + formatSize(bytes) + " of the phone's space (the reader, pictures and ledger)." : "");
