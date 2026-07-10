// Full-document text search with DOM-range-based highlight overlays.
//
// Page text is the concatenation of pdf.js text items with no separators,
// which matches exactly what the rendered text layer contains — so char
// offsets can be mapped onto the text layer's text nodes with a TreeWalker
// and turned into precise highlight rectangles via Range.getClientRects().

export class SearchController {
  constructor(viewer) {
    this.viewer = viewer;
    this.reset();
  }

  reset() {
    this.query = '';
    this.matches = [];
    this.index = -1;
    this.pageTexts = null;
    this._buildPromise = null;
  }

  async _buildText() {
    if (this.pageTexts) return;
    if (!this._buildPromise) {
      this._buildPromise = (async () => {
        const doc = this.viewer.doc;
        const texts = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const tc = await page.getTextContent();
          let s = '';
          for (const item of tc.items) {
            if (typeof item.str === 'string') s += item.str;
          }
          texts.push(s);
        }
        this.pageTexts = texts;
      })();
    }
    await this._buildPromise;
  }

  async setQuery(q) {
    this.query = q;
    this.matches = [];
    this.index = -1;
    if (!q || !this.viewer.doc) return;
    await this._buildText();
    if (this.query !== q) return; // superseded while building
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

  step(dir) {
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

  countLabel() {
    if (!this.query) return '';
    if (!this.matches.length) return '0 / 0';
    return `${this.index + 1} / ${this.matches.length}`;
  }

  _textNodeMap(textLayerDiv) {
    const walker = document.createTreeWalker(textLayerDiv, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let off = 0;
    let node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: off, end: off + node.data.length });
      off += node.data.length;
    }
    return nodes;
  }

  _rangeForMatch(nodes, m) {
    const sN = nodes.find((n) => m.start >= n.start && m.start < n.end);
    const eN = nodes.find((n) => m.end > n.start && m.end <= n.end);
    if (!sN || !eN) return null;
    const range = document.createRange();
    range.setStart(sN.node, m.start - sN.start);
    range.setEnd(eN.node, m.end - eN.start);
    return range;
  }

  // Draw highlight overlays for all matches on a rendered page.
  async highlightPage(p, pageNumber) {
    if (!p.el) return;
    p.el.querySelectorAll('.searchHl').forEach((e) => e.remove());
    if (!this.query || !p.rendered) return;
    const ms = this.matches.filter((m) => m.page === pageNumber);
    if (!ms.length) return;
    if (p.textReady) await p.textReady;
    if (!p.textLayerDiv || !p.rendered) return;

    const nodes = this._textNodeMap(p.textLayerDiv);
    const pageRect = p.el.getBoundingClientRect();
    for (const m of ms) {
      const range = this._rangeForMatch(nodes, m);
      if (!range) continue;
      const selected = this.matches.indexOf(m) === this.index;
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const d = document.createElement('div');
        d.className = 'searchHl' + (selected ? ' selected' : '');
        d.style.left = (r.left - pageRect.left) + 'px';
        d.style.top = (r.top - pageRect.top) + 'px';
        d.style.width = r.width + 'px';
        d.style.height = r.height + 'px';
        p.el.appendChild(d);
      }
    }
  }

  // Vertical position (0..1) of a match within its page. Page must be rendered.
  async matchYRatio(m) {
    const p = await this.viewer.ensurePage(m.page);
    if (!p || !p.textLayerDiv) return 0;
    const nodes = this._textNodeMap(p.textLayerDiv);
    const range = this._rangeForMatch(nodes, m);
    if (!range) return 0;
    const rects = range.getClientRects();
    if (!rects.length) return 0;
    const pageRect = p.el.getBoundingClientRect();
    return Math.min(Math.max((rects[0].top - pageRect.top) / pageRect.height, 0), 1);
  }

  async refreshHighlights() {
    for (const { p, pageNumber } of this.viewer.renderedPages()) {
      await this.highlightPage(p, pageNumber);
    }
  }
}
