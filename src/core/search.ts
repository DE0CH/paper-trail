// Full-document text search with DOM-range-based highlight overlays.
//
// Page text is the concatenation of pdf.js text items with no separators,
// which matches exactly what the rendered text layer contains — so char
// offsets can be mapped onto the text layer's text nodes with a TreeWalker
// and turned into precise highlight rectangles via Range.getClientRects().

import type { Viewer, PageRec } from './viewer';

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
  private pageTexts: string[] | null = null;
  private buildPromise: Promise<void> | null = null;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
  }

  reset(): void {
    this.query = '';
    this.matches = [];
    this.index = -1;
    this.pageTexts = null;
    this.buildPromise = null;
  }

  private async buildText(): Promise<void> {
    if (this.pageTexts) return;
    if (!this.buildPromise) {
      this.buildPromise = (async () => {
        const doc = this.viewer.doc;
        if (!doc) return;
        const texts: string[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const tc = await page.getTextContent();
          let s = '';
          for (const item of tc.items) {
            if ('str' in item && typeof item.str === 'string') s += item.str;
          }
          texts.push(s);
        }
        this.pageTexts = texts;
      })();
    }
    await this.buildPromise;
  }

  async setQuery(q: string): Promise<void> {
    this.query = q;
    this.matches = [];
    this.index = -1;
    if (!q || !this.viewer.doc) return;
    await this.buildText();
    if (this.query !== q || !this.pageTexts) return; // superseded while building
    const nq = q.toLowerCase();
    this.pageTexts.forEach((t, pi) => {
      const lt = t.toLowerCase();
      let i = 0;
      while ((i = lt.indexOf(nq, i)) !== -1) {
        this.matches.push({ page: pi + 1, start: i, end: i + nq.length });
        i += nq.length;
      }
    });
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
    if (!this.matches.length) return '0 / 0';
    return `${this.index + 1} / ${this.matches.length}`;
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
