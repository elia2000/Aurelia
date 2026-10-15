// Persistent storage for this device's identity keys and what we have learned
// about other people's keys (trust-on-first-use pins, verification marks).
//
// CryptoKey objects live in IndexedDB (structured clone). Their private halves
// are non-extractable, so even a script that reads the database cannot export
// them.

const DB_NAME = "aurelle-e2ee";
const DB_VERSION = 1;
const STORES = ["identity", "peers"];

export class E2eeUnavailableError extends Error {
  constructor(message = "Secure storage is not available in this browser.") {
    super(message);
    this.name = "E2eeUnavailableError";
  }
}

export function createMemoryAdapter() {
  const stores = Object.fromEntries(STORES.map((name) => [name, new Map()]));
  return {
    get: async (store, key) => stores[store].get(key) ?? null,
    put: async (store, key, value) => {
      stores[store].set(key, value);
    },
    delete: async (store, key) => {
      stores[store].delete(key);
    },
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new E2eeUnavailableError());
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(new E2eeUnavailableError(String(error?.message || error)));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      STORES.forEach((name) => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new E2eeUnavailableError(String(request.error?.message || "IndexedDB failed")));
    request.onblocked = () => reject(new E2eeUnavailableError("IndexedDB is blocked"));
  });
}

export function createIndexedDbAdapter() {
  let dbPromise = null;
  const db = () => (dbPromise ||= openDb());
  const run = async (store, mode, fn) => {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(store, mode);
      const request = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(request?.result ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    get: (store, key) => run(store, "readonly", (s) => s.get(key)),
    put: (store, key, value) => run(store, "readwrite", (s) => s.put(value, key)),
    delete: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
  };
}

export function createKeyStore(adapter = createIndexedDbAdapter()) {
  return {
    getIdentity: (userId) => adapter.get("identity", String(userId)),
    putIdentity: (userId, record) => adapter.put("identity", String(userId), record),
    deleteIdentity: (userId) => adapter.delete("identity", String(userId)),
    getPeer: (userId) => adapter.get("peers", String(userId)),
    putPeer: (userId, record) => adapter.put("peers", String(userId), record),
  };
}

let sharedStore = null;
export const getSharedKeyStore = () => (sharedStore ||= createKeyStore());
export const __setSharedKeyStoreForTests = (store) => {
  sharedStore = store;
};
