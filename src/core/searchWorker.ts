// Search worker: the COMPUTE half of full-document search, off the main
// thread. The main thread streams each page's pdf.js text-item strings
// here as it extracts them; this worker concatenates them, folds case,
// and streams back the matches for the active query — so a query issued
// while the index is still building returns the matches from already-
// indexed pages immediately and keeps filling in as pages arrive.
//
// Offset convention (load-bearing): a match's start/end are character
// offsets into the ORIGINAL, un-folded concatenation of the page's text
// item strings — exactly the text the rendered text layer contains, and
// exactly what rangeForMatch/highlightPage on the main thread consume.
// Case folding (toLowerCase) happens only on this side's private copy
// and never leaks into the reported offsets.

import type { Match } from './search';

export type ToWorker =
  | { type: 'reset'; gen: number } // new document (or none): drop everything
  | { type: 'page'; gen: number; items: string[] } // next page's text items, in page order
  | { type: 'done'; gen: number } // no more pages coming for this document
  | { type: 'query'; gen: number; qid: number; q: string }; // set the active query ('' = none)

export type FromWorker =
  | { type: 'matches'; gen: number; qid: number; matches: Match[] } // a batch, sorted, append-only
  | { type: 'complete'; gen: number; qid: number }; // the query's result set is complete

let gen = -1; // document generation; messages from other generations are stale
let lowerPages: string[] = []; // case-folded page texts, index = page - 1
let allPagesIn = false;
let q = ''; // active query, case-folded ('' = none)
let qid = 0;
let scanned = 0; // pages already scanned for the active query

// Scan every not-yet-scanned page for the active query. Pages arrive in
// page order and each new query restarts at page 1, so batches are always
// appended in (page, offset) order — the main thread never re-sorts.
function scan(): void {
  if (!q) return;
  const found: Match[] = [];
  for (; scanned < lowerPages.length; scanned++) {
    const lt = lowerPages[scanned];
    let i = 0;
    while ((i = lt.indexOf(q, i)) !== -1) {
      found.push({ page: scanned + 1, start: i, end: i + q.length });
      i += q.length;
    }
  }
  if (found.length) {
    postMessage({ type: 'matches', gen, qid, matches: found } satisfies FromWorker);
  }
  if (allPagesIn) {
    postMessage({ type: 'complete', gen, qid } satisfies FromWorker);
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'reset') {
    gen = m.gen;
    lowerPages = [];
    allPagesIn = false;
    q = '';
    scanned = 0;
    return;
  }
  if (m.gen !== gen) return; // stale: a reset raced this message
  if (m.type === 'page') {
    let s = '';
    for (const it of m.items) s += it;
    lowerPages.push(s.toLowerCase());
    scan();
  } else if (m.type === 'done') {
    allPagesIn = true;
    scan(); // completes the active query, if any
  } else {
    qid = m.qid;
    q = m.q.toLowerCase();
    scanned = 0;
    scan();
  }
};
