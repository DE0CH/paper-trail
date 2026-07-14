// The recently-opened list. Each entry is a PAIR — a PDF and the saved
// session (.ptl) it was read with — so the same PDF opened with two
// different sessions is two distinct rows.
//
// A file is identified by a FileRef: a FileSystemFileHandle (browser opens
// and desktop drag-drop — compared with the async isSameEntry) OR an on-disk
// path string (desktop opens with no handle — an OS double-click, the <input>
// fallback, the shell save dialog). It is EXACTLY ONE of the two — never both,
// never neither — so the union makes the invalid states unrepresentable. Two
// refs match when both are absent, both are the same path, or both are the
// same file handle; a handle and a path never match (different mechanisms).
// Names are stored only for display (so the list renders without an async
// getFile()).

/** A file reference: a browser handle OR an on-disk path — exactly one. */
export type FileRef = FileSystemFileHandle | string;

/** Discriminate the union: a string is a path, anything else a handle. */
export const isHandle = (r: FileRef): r is FileSystemFileHandle => typeof r !== 'string';

export interface RecentEntry {
  /** The PDF — always identified (a handle or an on-disk path). */
  pdf: FileRef;
  /** The .ptl session, or null when the PDF was opened without one. */
  session: FileRef | null;
  pdfName: string;
  /** null exactly when session is null. */
  sessionFileName: string | null;
  /** When the entry was last opened; the ordering key (newest first). */
  timestamp: number;
}

export interface RecentDisplay {
  entry: RecentEntry;
  /** The PDF name, plus the session name appended only to disambiguate a
      shared PDF name. */
  text: string;
}

// Two refs match when both are absent, both are the same path, or both are the
// same file handle (isSameEntry). A path and a handle never match.
async function sameRef(a: FileRef | null, b: FileRef | null): Promise<boolean> {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  try { return await a.isSameEntry(b); } catch { return false; }
}

export async function updateRecent(
  list: RecentEntry[],
  incoming: RecentEntry,
): Promise<RecentEntry[]> {
  // 1. exact pair match (same pdf AND same session) → refresh timestamp + names.
  for (const e of list) {
    if (await sameRef(e.pdf, incoming.pdf) && await sameRef(e.session, incoming.session)) {
      e.timestamp = incoming.timestamp;
      e.pdfName = incoming.pdfName;
      e.sessionFileName = incoming.sessionFileName;
      return list;
    }
  }
  // 2. first save: a session arriving for a pdf whose session slot is still
  //    empty upgrades that row in place (no duplicate).
  if (incoming.session != null) {
    for (const e of list) {
      if (e.session == null && await sameRef(e.pdf, incoming.pdf)) {
        e.session = incoming.session;
        e.sessionFileName = incoming.sessionFileName;
        e.pdfName = incoming.pdfName;
        e.timestamp = incoming.timestamp;
        return list;
      }
    }
  }
  // 3. otherwise a brand-new row.
  list.push(incoming);
  return list;
}

/**
 * The display rows, newest first. Text is the PDF name; when another row
 * shows the same PDF name, the session name is appended to tell them apart
 * (O(n^2) by design — the list is short and this reads plainly).
 */
export function buildDisplayList(list: RecentEntry[]): RecentDisplay[] {
  const sorted = [...list].sort((a, b) => b.timestamp - a.timestamp);
  return sorted.map((entry) => {
    const shared = sorted.some((o) => o !== entry && o.pdfName === entry.pdfName);
    const text = shared && entry.sessionFileName
      ? `${entry.pdfName} — ${entry.sessionFileName}`
      : entry.pdfName;
    return { entry, text };
  });
}
