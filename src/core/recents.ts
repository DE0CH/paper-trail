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
export async function updateRecent(
  list: RecentEntry[],
  incoming: RecentEntry,
): Promise<RecentEntry[]> {
  void list; void incoming;
  throw new Error('updateRecent not implemented');
}

/**
 * The display rows, newest first. Text is the PDF name; when another row
 * shows the same PDF name, the session name is appended to tell them apart
 * (O(n^2) by design — the list is short and this reads plainly).
 */
export function buildDisplayList(list: RecentEntry[]): RecentDisplay[] {
  void list;
  throw new Error('buildDisplayList not implemented');
}
