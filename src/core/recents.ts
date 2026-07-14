// The recently-opened list. Each entry is a PAIR — a PDF and the saved
// session (.ptl) it was read with — so the same PDF opened with two
// different sessions is two distinct rows.
//
// Identity is a file REFERENCE per side: a FileSystemFileHandle (browser /
// desktop drag-drop, compared with the async isSameEntry) OR an on-disk path
// (desktop opens with no handle — an OS double-click, the <input> fallback,
// the shell save dialog). A side matches another when both are absent, both
// paths are equal, or both handles are the same file; a handle-only side and
// a path-only side never match (different identity mechanisms). Names are
// stored only for display.

export interface RecentEntry {
  pdfHandle: FileSystemFileHandle | null;
  /** Desktop on-disk path when the PDF was opened without a handle. */
  pdfPath: string | null;
  /** null when the PDF was opened without ever saving a session. */
  sessionFileHandle: FileSystemFileHandle | null;
  /** Desktop on-disk path of the .ptl when it was bound without a handle. */
  sessionPath: string | null;
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

/** A side (pdf or session) has a reference when it carries a handle or path. */
export function hasRef(handle: FileSystemFileHandle | null | undefined,
  path: string | null | undefined): boolean {
  return !!(handle || path);
}

// Two references match when both are absent, both carry the same path, or
// both carry the same file handle (isSameEntry). A path-only reference and a
// handle-only reference never match.
async function sameRef(
  ah: FileSystemFileHandle | null | undefined, ap: string | null | undefined,
  bh: FileSystemFileHandle | null | undefined, bp: string | null | undefined,
): Promise<boolean> {
  const a = hasRef(ah, ap), b = hasRef(bh, bp);
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (ap && bp) return ap === bp;
  if (ah && bh) {
    try { return await ah.isSameEntry(bh); } catch { return false; }
  }
  return false;
}

export async function updateRecent(
  list: RecentEntry[],
  incoming: RecentEntry,
): Promise<RecentEntry[]> {
  // 1. exact pair match → refresh timestamp + names, and back-fill any
  //    reference the incoming now knows (e.g. a handle that gained a path).
  for (const e of list) {
    if (await sameRef(e.pdfHandle, e.pdfPath, incoming.pdfHandle, incoming.pdfPath)
      && await sameRef(e.sessionFileHandle, e.sessionPath,
        incoming.sessionFileHandle, incoming.sessionPath)) {
      e.timestamp = incoming.timestamp;
      e.pdfName = incoming.pdfName;
      e.sessionFileName = incoming.sessionFileName;
      e.pdfHandle ??= incoming.pdfHandle;
      e.pdfPath ??= incoming.pdfPath;
      e.sessionFileHandle ??= incoming.sessionFileHandle;
      e.sessionPath ??= incoming.sessionPath;
      return list;
    }
  }
  // 2. first save: a session arriving for a pdf whose session slot is still
  //    empty upgrades that row in place (no duplicate) — handle OR path.
  if (hasRef(incoming.sessionFileHandle, incoming.sessionPath)) {
    for (const e of list) {
      if (!hasRef(e.sessionFileHandle, e.sessionPath)
        && await sameRef(e.pdfHandle, e.pdfPath, incoming.pdfHandle, incoming.pdfPath)) {
        e.sessionFileHandle = incoming.sessionFileHandle;
        e.sessionPath = incoming.sessionPath;
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
