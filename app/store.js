// The only file that touches storage. The SAME text is written to localStorage and IndexedDB,
// so losing or failing one of them is noticed and repaired from the other (model/persist.js).
// A value of undefined means "that store could not be read at all".
const LS_KEY = "financialTracker.ledger";
const DB_NAME = "financialTracker", STORE = "kv", KEY = "ledger";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
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
