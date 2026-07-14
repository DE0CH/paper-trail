// Persistence: UI prefs in localStorage; the recently-opened list — pairs
// of (PDF handle, saved-session handle) — in IndexedDB (handles are
// structured-cloneable, strings-only localStorage can't hold them).
// Reading state lives ONLY in explicit session files: opening a plain PDF
// always starts fresh.

import type { RecentEntry } from './recents';

const UI_KEY = 'pt:ui';

export interface UiPrefs {
  stacksW?: number;
  sideW?: number;
  previewH?: number;
  navW?: number;
  navOpen?: boolean;
  navTab?: 'outline' | 'pages';
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

// ---------- IndexedDB (the recents pair-list) ----------

const DB_NAME = 'paper-trail';
const DB_VERSION = 2;
const RECENTS = 'recents';
// The whole list is one record under this key (identity is the handle
// pair, which isn't a usable key — callers dedupe with isSameEntry).
const LIST_KEY = 'list';

let dbPromise: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        // Pre-1.0: recents moved from fingerprint-keyed rows to a single
        // stored pair-list, so drop any old store and recreate.
        const db = req.result;
        if (db.objectStoreNames.contains(RECENTS)) db.deleteObjectStore(RECENTS);
        db.createObjectStore(RECENTS); // out-of-line keys: one record, the list
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** The whole recents list as stored (callers sort by timestamp). Entries
 *  persisted before the FileRef union (separate pdfHandle/pdfPath/… fields)
 *  are normalized here; one with no PDF reference is dropped — recents is a
 *  convenience cache, not durable user data. */
export async function getRecents(): Promise<RecentEntry[]> {
  try {
    const db = await idb();
    const raw = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction(RECENTS).objectStore(RECENTS).get(LIST_KEY);
      req.onsuccess = () => resolve((req.result as unknown[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    return raw.map(normalizeRecent).filter((e): e is RecentEntry => e !== null);
  } catch {
    return [];
  }
}

// Bring any pre-union entry (pdfHandle/pdfPath/sessionFileHandle/sessionPath)
// to the { pdf, session } shape. A path and a handle are never both set for a
// side, so `handle ?? path` is lossless. New entries pass through unchanged.
function normalizeRecent(raw: unknown): RecentEntry | null {
  const e = raw as Partial<RecentEntry> & {
    pdfHandle?: FileSystemFileHandle | null; pdfPath?: string | null;
    sessionFileHandle?: FileSystemFileHandle | null; sessionPath?: string | null;
  };
  const pdf = e.pdf ?? e.pdfHandle ?? e.pdfPath ?? null;
  if (pdf == null) return null;
  const session = e.session ?? e.sessionFileHandle ?? e.sessionPath ?? null;
  return {
    pdf,
    session,
    pdfName: e.pdfName ?? '',
    sessionFileName: session ? (e.sessionFileName ?? null) : null,
    timestamp: e.timestamp ?? 0,
  };
}

/** Persist the recents list verbatim (the caller trims/sorts). */
export async function saveRecents(list: RecentEntry[]): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(RECENTS, 'readwrite');
      tx.objectStore(RECENTS).put(list, LIST_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('saveRecents failed', e);
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
