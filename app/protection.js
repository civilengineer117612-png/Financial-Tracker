// The browser decides whether storage is persistent. Never infer it from an
// installation, a saved preference, or a previous request's answer.
import { claimPersistenceRequest } from "./store.js";

export async function storageProtected(storage = globalThis.navigator?.storage) {
  try { return typeof storage?.persisted === "function" && await storage.persisted() === true; }
  catch { return false; }
}

export async function requestStorageProtection({ storage = globalThis.navigator?.storage, claim = claimPersistenceRequest } = {}) {
  try {
    if (typeof storage?.persist !== "function") return false;
    // The durable claim is committed before asking. Separate tabs and later
    // sessions use the same claim, and restoring a ledger does not erase it.
    if (!await claim()) return storageProtected(storage);
    return await storage.persist() === true;
  } catch { return false; } // storage permission must never interrupt logging
}
