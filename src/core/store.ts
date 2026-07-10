// Persistence: per-document state in localStorage, recent files (with
// optional FileSystemFileHandle for one-click reopen) in IndexedDB.

import type { RecentEntry, SerializedState } from './types';

const LS_PREFIX = 'psr:doc:';
const UI_KEY = 'psr:ui';

export const Store = {
  saveDoc(fp: string, data: SerializedState): void {
    try {
      localStorage.setItem(LS_PREFIX + fp, JSON.stringify(data));
    } catch (e) {
      console.warn('saveDoc failed', e);
    }
  },
  loadDoc(fp: string): SerializedState | null {
    try {
      const raw = localStorage.getItem(LS_PREFIX + fp);
      return raw ? (JSON.parse(raw) as SerializedState) : null;
    } catch {
      return null;
    }
  },
};

export interface UiPrefs {
  stacksW?: number;
  sidebarW?: number;
  previewH?: number;
}

export function loadUI(): UiPrefs {
  try {
    return (JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as UiPrefs) || {};
  } catch {
    return {};
  }
}

export function saveUI(patch: UiPrefs): void {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ ...loadUI(), ...patch }));
  } catch { /* ignore */ }
}

// ---------- IndexedDB (recents + file handles) ----------

const DB_NAME = 'psr';
const DB_VERSION = 1;
const RECENTS = 'recents';

let dbPromise: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
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

export async function putRecent(entry: Partial<RecentEntry> & { fp: string }): Promise<void> {
  try {
    const db = await idb();
    const existing = await getRecent(entry.fp);
    const merged: RecentEntry = { ...(existing ?? { name: '', ts: 0 }), ...entry } as RecentEntry;
    // never clobber a stored handle with undefined
    if (!entry.handle && existing?.handle) merged.handle = existing.handle;
    if (!entry.progressHandle && existing?.progressHandle) {
      merged.progressHandle = existing.progressHandle;
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(RECENTS, 'readwrite');
      tx.objectStore(RECENTS).put(merged);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('putRecent failed', e);
  }
}

export async function getRecent(fp: string): Promise<RecentEntry | null> {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(RECENTS).objectStore(RECENTS).get(fp);
      req.onsuccess = () => resolve((req.result as RecentEntry) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function getRecents(limit = 8): Promise<RecentEntry[]> {
  try {
    const db = await idb();
    const all = await new Promise<RecentEntry[]>((resolve, reject) => {
      const req = db.transaction(RECENTS).objectStore(RECENTS).getAll();
      req.onsuccess = () => resolve((req.result as RecentEntry[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Ask for (or confirm) read permission on a stored handle. Must be called
 * from a user gesture.
 */
export async function ensureReadPermission(handle: FileSystemFileHandle): Promise<boolean> {
  try {
    if ((await handle.queryPermission?.({ mode: 'read' })) === 'granted') return true;
    return (await handle.requestPermission?.({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}
