// Device addendum 2-3: the ledger lives ONLY on the iPhone, installed to the Home Screen.
// Every install of a web app has its own separate storage, so the app must tell the owner
// which situation they are in instead of letting an empty screen look like lost data.
//
// Pure logic: the caller passes what it can see (user agent string, whether it runs as a
// Home Screen app, whether each store holds data) and gets a status and a plain message.

export function detectPlatform(userAgent) {
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipod/i.test(userAgent)) return "ios";
  return "other";   // includes iPad (reports as a Mac) and desktop browsers: not the finance phone
}

const result = (status, message, allowEntry) => ({ status, message, allowEntry });

// stores.local / stores.idb: true = holds data, false = empty, null = could not be read.
export function assessDevice({ platform, standalone, stores }) {
  if (platform === "android") {
    return result("ANDROID_NO_LEDGER",
      "This is not the finance phone. The ledger lives only on the iPhone, so an empty app here is normal, not lost data. Do not enter financial data here.",
      false);
  }
  if (platform !== "ios") {
    return result("NOT_THE_FINANCE_PHONE",
      "The ledger lives on the iPhone's Home Screen app. This device has its own separate, empty storage.", false);
  }
  if (!standalone) {
    return result("BROWSER_TAB",
      "You are in a Safari tab, which has separate storage from the Home Screen app. Open the app from its Home Screen icon.", false);
  }
  if (stores.local === null || stores.idb === null) {
    return result("STORAGE_UNAVAILABLE",
      "This device's storage cannot be read. Nothing can be saved safely until that is fixed.", false);
  }
  if (stores.local !== stores.idb) {
    const lost = stores.local ? "IndexedDB" : "localStorage";
    return result("PARTIAL_LOSS",
      "Only one of the two stores holds data (" + lost + " is empty). iOS may have cleared it. Restore from your encrypted backup.", false);
  }
  if (!stores.local) {
    return result("EMPTY",
      "No data on this device. This is expected on first run. If you have entered data here before, restore from your encrypted backup.", true);
  }
  return result("OK", "", true);
}
