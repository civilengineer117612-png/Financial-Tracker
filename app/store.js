// The only file that touches storage. The SAME text is written to localStorage and IndexedDB,
// so losing or failing one of them is noticed and repaired from the other (model/persist.js).
// A value of undefined means "that store could not be read at all".
let LS_KEY = "financialTracker.ledger", DB_NAME = "financialTracker";
const STORE = "kv", KEY = "ledger", PHOTOS = "photos";

// A trial copy keeps everything under other names, so it can never touch (or be mistaken for) a real ledger.
export function useTrialStorage() { LS_KEY = "financialTracker.trial.ledger"; DB_NAME = "financialTracker-trial"; }
export async function clearTrialStorage() {
  if (!DB_NAME.endsWith("-trial")) return;   // only ever the trial copy
  try { localStorage.removeItem(LS_KEY); } catch { /* nothing to remove */ }
  await new Promise((resolve) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);   // version 2 adds the store for photos of receipts; the ledger store is untouched
    req.onupgradeneeded = () => { for (const name of [STORE, PHOTOS]) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => reject(r.error);
    });
  } finally { db.close(); }
}
async function idbPut(text) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(text, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function readBoth() {
  let local, idb;
  try { local = localStorage.getItem(LS_KEY); } catch { local = undefined; }
  try { idb = await idbGet(); } catch { idb = undefined; }
  return { local, idb };
}

// Saves are queued one after another so two quick taps can never write out of order.
let queue = Promise.resolve();
export function writeBoth(text, { local = true, idb = true } = {}) {
  const job = queue.then(async () => {
    const result = { local: !local, idb: !idb };
    if (local) { try { localStorage.setItem(LS_KEY, text); result.local = true; } catch { /* reported below */ } }
    if (idb) { try { await idbPut(text); result.idb = true; } catch { /* reported below */ } }
    return result;
  });
  queue = job.catch(() => {});
  return job;
}

// Photos of receipts and payslips: the picture files themselves, kept only on this phone, under the id the ledger's
// attachment row names. They are not part of the ledger text and not part of the backup file.
async function photoTx(mode, run) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTOS, mode);
      const r = run(tx.objectStore(PHOTOS));
      tx.oncomplete = () => resolve(r?.result ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export const putPhoto = (id, blob) => photoTx("readwrite", (st) => st.put(blob, id));
export const getPhoto = (id) => photoTx("readonly", (st) => st.get(id));
export const deletePhoto = (id) => photoTx("readwrite", (st) => st.delete(id));
