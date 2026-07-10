// Persistence: per-document state in localStorage, recent files (with
// optional FileSystemFileHandle for one-click reopen) in IndexedDB.

const LS_PREFIX = 'ptr:doc:';

export const Store = {
  saveDoc(fp, data) {
    try {
      localStorage.setItem(LS_PREFIX + fp, JSON.stringify(data));
    } catch (e) {
      console.warn('saveDoc failed', e);
    }
  },
  loadDoc(fp) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + fp);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
};

// ---------- IndexedDB (recents + file handles) ----------

const DB_NAME = 'ptr';
const DB_VERSION = 1;
const RECENTS = 'recents';

let dbPromise = null;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(RECENTS)) {
          req.result.createObjectStore(RECENTS, { keyPath: 'fp' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// entry: { fp, name, ts, handle?, progressHandle? }
export async function putRecent(entry) {
  try {
    const db = await idb();
    const existing = await getRecent(entry.fp);
    const merged = { ...existing, ...entry };
    // never clobber a stored handle with undefined
    if (!entry.handle && existing && existing.handle) merged.handle = existing.handle;
    if (!entry.progressHandle && existing && existing.progressHandle) {
      merged.progressHandle = existing.progressHandle;
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(RECENTS, 'readwrite');
      tx.objectStore(RECENTS).put(merged);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('putRecent failed', e);
  }
}

export async function getRecent(fp) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(RECENTS).objectStore(RECENTS).get(fp);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function getRecents(limit = 8) {
  try {
    const db = await idb();
    const all = await new Promise((resolve, reject) => {
      const req = db.transaction(RECENTS).objectStore(RECENTS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, limit);
  } catch {
    return [];
  }
}

// Ask for (or confirm) read permission on a stored handle. Must be called
// from a user gesture.
export async function ensureReadPermission(handle) {
  try {
    if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
    return (await handle.requestPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}
