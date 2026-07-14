// The recently-opened list. Each entry is a PAIR — a PDF and the saved
// session (.ptl) it was read with — so the same PDF opened with two
// different sessions is two distinct rows. Identity is the pair of file
// HANDLES (compared with the async FileSystemFileHandle.isSameEntry), not
// a name or a fingerprint; names are stored only for display and refreshed
// from the live handle whenever an entry is touched.

export interface RecentEntry {
  pdfHandle: FileSystemFileHandle;
  /** null when the PDF was opened without ever saving a session. */
  sessionFileHandle: FileSystemFileHandle | null;
  pdfName: string;
  sessionFileName: string;
  /** When the entry was last opened; the ordering key (newest first). */
  timestamp: number;
}

export interface RecentDisplay {
  entry: RecentEntry;
  /** The PDF name, plus the session name appended only to disambiguate a
      shared PDF name. */
  text: string;
}

/**
 * Upsert `incoming` into `list` (mutates and returns it):
 *   1. exact pair match (both handles isSameEntry, null↔null) → refresh
 *      timestamp + names on that row;
 *   2. else, if `incoming` carries a session handle → find a row for the
 *      SAME pdf whose session slot is still null and upgrade it in place
 *      (the first-save case — no duplicate row);
 *   3. else → push a new row.
 */
// Two handle slots match when both are null, or both point at the same
// file (isSameEntry). One null and one not never match.
async function sameSlot(
  a: FileSystemFileHandle | null,
  b: FileSystemFileHandle | null,
): Promise<boolean> {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.isSameEntry(b);
}

export async function updateRecent(
  list: RecentEntry[],
  incoming: RecentEntry,
): Promise<RecentEntry[]> {
  // 1. exact pair match → refresh timestamp + names.
  for (const e of list) {
    if (await sameSlot(e.pdfHandle, incoming.pdfHandle)
      && await sameSlot(e.sessionFileHandle, incoming.sessionFileHandle)) {
      e.timestamp = incoming.timestamp;
      e.pdfName = incoming.pdfName;
      e.sessionFileName = incoming.sessionFileName;
      return list;
    }
  }
  // 2. first save: a session arriving for a pdf whose row still has a null
  //    session slot upgrades that row in place (no duplicate).
  if (incoming.sessionFileHandle !== null) {
    for (const e of list) {
      if (e.sessionFileHandle === null
        && await sameSlot(e.pdfHandle, incoming.pdfHandle)) {
        e.sessionFileHandle = incoming.sessionFileHandle;
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
