// Full-document text search with DOM-range-based highlight overlays.
//
// Page text is the concatenation of pdf.js text items with no separators,
// which matches exactly what the rendered text layer contains — so char
// offsets can be mapped onto the text layer's text nodes with a TreeWalker
// and turned into precise highlight rectangles via Range.getClientRects().
//
// The COMPUTE half (concatenation, case folding, match finding) runs in a
// dedicated Web Worker (searchWorker.ts). This thread streams each page's
// text-item strings to the worker as pdf.js extracts them, and the worker
// streams matches back — so a query issued while the index is still
// building shows the matches found so far and fills in as pages arrive.
// Only the DOM work stays here: highlight drawing and the current-match
// handoff. Match offsets are original text-layer offsets throughout.

import type { Viewer, PageRec } from './viewer';
import type { FromWorker, ToWorker } from './searchWorker';

export interface Match {
  page: number;
  start: number;
  end: number;
}

interface NodeSpan {
  node: Text;
  start: number;
  end: number;
}

export class SearchController {
  viewer: Viewer;
  query = '';
  matches: Match[] = [];
  index = -1;
  /** Set by the app controller: fired whenever streamed results change. */
  onUpdate: (() => void) | null = null;

  private worker: Worker | null = null;
  private gen = 0; // document generation; bumped by reset()
  private qid = 0; // query generation; bumped by setQuery()
  private settled = true; // the current query has its complete result set
  private extracting = false; // page-text streaming to the worker has started
  private waiters: Array<() => void> = []; // setQuery completion resolvers
  private refreshScheduled = false;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
  }

  reset(): void {
    this.gen++;
    this.qid++;
    this.query = '';
    this.matches = [];
    this.index = -1;
    this.settled = true;
    this.extracting = false;
    this.worker?.postMessage({ type: 'reset', gen: this.gen } satisfies ToWorker);
    this.releaseWaiters();
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorkerMessage(e.data);
      this.worker.postMessage({ type: 'reset', gen: this.gen } satisfies ToWorker);
    }
    return this.worker;
  }

  private releaseWaiters(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  private onWorkerMessage(msg: FromWorker): void {
    if (msg.gen !== this.gen || msg.qid !== this.qid) return; // stale batch
    if (msg.type === 'matches') {
      for (const m of msg.matches) this.matches.push(m);
    } else {
      this.settled = true;
      this.releaseWaiters();
    }
    this.onUpdate?.();
    this.scheduleRefresh();
  }

  /** Coalesce mid-stream highlight redraws to one per frame. */
  private scheduleRefresh(): void {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    requestAnimationFrame(() => {
      this.refreshScheduled = false;
      void this.refreshHighlights();
    });
  }

  // Stream every page's text-item strings to the worker, in page order —
  // so match batches arrive already sorted. The per-page extraction is
  // pdf.js-worker I/O; nothing here scans text on the main thread.
  private startExtraction(): void {
    if (this.extracting) return;
    this.extracting = true;
    const gen = this.gen;
    const doc = this.viewer.doc;
    const worker = this.ensureWorker();
    void (async () => {
      if (!doc) return;
      for (let i = 1; i <= doc.numPages; i++) {
        const items: string[] = [];
        try {
          const page = await doc.getPage(i);
          const tc = await page.getTextContent();
          for (const item of tc.items) {
            if ('str' in item && typeof item.str === 'string') items.push(item.str);
          }
        } catch {
          // a corrupt (or destroyed-mid-swap) page contributes no text;
          // indexing continues, and the empty page is still sent so page
          // numbering stays aligned. Nothing is memoized on failure, so a
          // reopen retries from scratch.
        }
        if (gen !== this.gen) return; // document changed mid-extraction
        worker.postMessage({ type: 'page', gen, items } satisfies ToWorker);
      }
      // always close out the index so pending queries settle
      if (gen === this.gen) worker.postMessage({ type: 'done', gen } satisfies ToWorker);
    })();
  }

  /**
   * Set the active query. Resolves once the result set is COMPLETE (or
   * the query was superseded, cleared, or reset). Partial matches stream
   * into `matches` while this is pending, firing onUpdate per batch.
   */
  async setQuery(q: string): Promise<void> {
    this.query = q;
    this.matches = [];
    this.index = -1;
    this.qid++;
    this.releaseWaiters(); // supersede any pending query
    if (!q || !this.viewer.doc) {
      this.settled = true;
      // stop the worker scanning for a query nobody wants anymore
      this.worker?.postMessage({ type: 'query', gen: this.gen, qid: this.qid, q: '' } satisfies ToWorker);
      return;
    }
    this.settled = false;
    this.ensureWorker().postMessage({ type: 'query', gen: this.gen, qid: this.qid, q } satisfies ToWorker);
    this.startExtraction();
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  step(dir: 1 | -1): Match | null {
    if (!this.matches.length) return null;
    if (this.index === -1) {
      // start from the current viewport position
      const cur = this.viewer.currentPosition();
      let idx = this.matches.findIndex((m) => m.page >= cur.page);
      if (idx === -1) idx = 0;
      this.index = dir > 0 ? idx : (idx - 1 + this.matches.length) % this.matches.length;
    } else {
      this.index = (this.index + dir + this.matches.length) % this.matches.length;
    }
    return this.matches[this.index];
  }

  countLabel(): string {
    if (!this.query) return '';
    const label = !this.matches.length ? '0 / 0' : `${this.index + 1} / ${this.matches.length}`;
    // an ellipsis marks a count that is still streaming in
    return this.settled ? label : label + '…';
  }

  private textNodeMap(textLayerDiv: HTMLElement): NodeSpan[] {
    const walker = document.createTreeWalker(textLayerDiv, NodeFilter.SHOW_TEXT);
    const nodes: NodeSpan[] = [];
    let off = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node as Text;
      nodes.push({ node: t, start: off, end: off + t.data.length });
      off += t.data.length;
    }
    return nodes;
  }

  private rangeForMatch(nodes: NodeSpan[], m: Match): Range | null {
    const sN = nodes.find((n) => m.start >= n.start && m.start < n.end);
    const eN = nodes.find((n) => m.end > n.start && m.end <= n.end);
    if (!sN || !eN) return null;
    const range = document.createRange();
    range.setStart(sN.node, m.start - sN.start);
    range.setEnd(eN.node, m.end - eN.start);
    return range;
  }

  /** Draw highlight overlays for all matches on a rendered page. */
  async highlightPage(p: PageRec, pageNumber: number): Promise<void> {
    if (!p.el) return;
    p.el.querySelectorAll('.searchHl').forEach((e) => e.remove());
    if (!this.query || !p.rendered) return;
    const ms = this.matches.filter((m) => m.page === pageNumber);
    if (!ms.length) return;
    if (p.textReady) await p.textReady;
    if (!p.textLayerDiv || !p.rendered) return;

    const nodes = this.textNodeMap(p.textLayerDiv);
    const pageRect = p.el.getBoundingClientRect();
    for (const m of ms) {
      const range = this.rangeForMatch(nodes, m);
      if (!range) continue;
      const selected = this.matches.indexOf(m) === this.index;
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const d = document.createElement('div');
        d.className = 'searchHl' + (selected ? ' selected' : '');
        d.style.left = `${r.left - pageRect.left}px`;
        d.style.top = `${r.top - pageRect.top}px`;
        d.style.width = `${r.width}px`;
        d.style.height = `${r.height}px`;
        p.el.appendChild(d);
      }
    }
  }

  /** Vertical position (0..1) of a match within its page. */
  async matchYRatio(m: Match): Promise<number> {
    const p = await this.viewer.ensurePage(m.page);
    if (!p || !p.textLayerDiv) return 0;
    const nodes = this.textNodeMap(p.textLayerDiv);
    const range = this.rangeForMatch(nodes, m);
    if (!range) return 0;
    const rects = range.getClientRects();
    if (!rects.length) return 0;
    const pageRect = p.el.getBoundingClientRect();
    return Math.min(Math.max((rects[0].top - pageRect.top) / pageRect.height, 0), 1);
  }

  async refreshHighlights(): Promise<void> {
    for (const { p, pageNumber } of this.viewer.renderedPages()) {
      await this.highlightPage(p, pageNumber);
    }
  }
}
