// PDF rendering: continuous scroll, lazy page rendering, text layer,
// link annotations, zoom, and scale-independent positions.

import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../vendor/pdf.worker.min.mjs', import.meta.url).toString();

const RENDER_MARGIN = 900;   // px beyond viewport to pre-render
const DESTROY_MARGIN = 3200; // px beyond viewport to tear pages down
const PROBE_OFFSET = 8;      // px used to define "current position"
const DEST_TOP_MARGIN = 48;  // px of context above a jump target (at scale 1)

export class Viewer {
  constructor(container, viewerEl, callbacks = {}) {
    this.container = container; // scrolling element
    this.viewerEl = viewerEl;
    this.cb = callbacks;
    this.doc = null;
    this.pages = [];
    this.scale = 1;
    this.fitWidth = true;
    this._epoch = 0;
    this._suppressUntil = 0;
    this._lastPage = 0;
    this._scrollRaf = 0;

    container.addEventListener('scroll', () => {
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => {
        this._scrollRaf = 0;
        this._onScroll();
      });
    });
  }

  async open(src) {
    this.close();
    const epoch = ++this._epoch;
    const doc = await pdfjsLib.getDocument(src).promise;
    if (epoch !== this._epoch) { doc.destroy(); return null; }
    this.doc = doc;
    const n = doc.numPages;
    this.pages = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      if (epoch !== this._epoch) return null;
      this.pages.push({
        page,
        vp1: page.getViewport({ scale: 1 }),
        el: null,
        canvas: null,
        textLayerDiv: null,
        annotDiv: null,
        annots: null,
        rendered: false,
        renderedScale: 0,
        rendering: null,
        textReady: null,
      });
    }
    if (this.fitWidth) this.scale = this.computeFitScale();
    this._buildShells();
    this._updateVisible();
    return doc;
  }

  close() {
    this._epoch++;
    if (this.doc) { this.doc.destroy().catch(() => {}); }
    this.doc = null;
    this.pages = [];
    this.viewerEl.replaceChildren();
    this._lastPage = 0;
  }

  get numPages() { return this.pages.length; }

  computeFitScale() {
    const w = this.container.clientWidth - 36;
    const base = this.pages[0] ? this.pages[0].vp1.width : 612;
    return Math.min(Math.max(w / base, 0.25), 5);
  }

  _buildShells() {
    this.viewerEl.replaceChildren();
    this.viewerEl.style.setProperty('--scale-factor', String(this.scale));
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i];
      const div = document.createElement('div');
      div.className = 'page';
      div.dataset.page = String(i + 1);
      this._sizeShell(p, div);
      p.el = div;
      this.viewerEl.appendChild(div);
    }
  }

  _sizeShell(p, el = p.el) {
    el.style.width = Math.floor(p.vp1.width * this.scale) + 'px';
    el.style.height = Math.floor(p.vp1.height * this.scale) + 'px';
    el.style.setProperty('--scale-factor', String(this.scale));
  }

  setScale(scale, { fitWidth = false } = {}) {
    scale = Math.min(Math.max(scale, 0.25), 5);
    if (!this.pages.length) { this.scale = scale; this.fitWidth = fitWidth; return; }
    const pos = this.currentPosition();
    this.scale = scale;
    this.fitWidth = fitWidth;
    this.viewerEl.style.setProperty('--scale-factor', String(scale));
    for (const p of this.pages) {
      this._destroyPage(p);
      this._sizeShell(p);
    }
    this.scrollTo(pos);
    this._updateVisible();
    if (this.cb.onScaleChange) this.cb.onScaleChange(scale);
  }

  // ----- positions -----

  currentPosition() {
    if (!this.pages.length) return { page: 1, yRatio: 0 };
    const probe = this.container.scrollTop + PROBE_OFFSET;
    let best = this.pages[0];
    let bestIdx = 0;
    for (let i = 0; i < this.pages.length; i++) {
      const el = this.pages[i].el;
      if (el.offsetTop <= probe) { best = this.pages[i]; bestIdx = i; }
      else break;
    }
    const h = best.el.offsetHeight || 1;
    const yRatio = Math.min(Math.max((probe - best.el.offsetTop) / h, 0), 1);
    return { page: bestIdx + 1, yRatio };
  }

  scrollTo({ page, yRatio = 0 }, { suppressTracking = true } = {}) {
    const p = this.pages[page - 1];
    if (!p) return;
    if (suppressTracking) this._suppress();
    this.container.scrollTop = p.el.offsetTop + yRatio * p.el.offsetHeight - PROBE_OFFSET;
    this._updateVisible();
  }

  _suppress() { this._suppressUntil = Date.now() + 600; }
  isTrackingSuppressed() { return Date.now() < this._suppressUntil; }

  // Resolve a PDF destination (named string or explicit array) to a position.
  async resolveDest(dest) {
    try {
      let d = dest;
      if (typeof d === 'string') d = await this.doc.getDestination(d);
      if (!Array.isArray(d)) return null;
      let pageIndex;
      if (typeof d[0] === 'object' && d[0] !== null) {
        pageIndex = await this.doc.getPageIndex(d[0]);
      } else {
        pageIndex = d[0];
      }
      const p = this.pages[pageIndex];
      if (!p) return null;
      const type = d[1] && d[1].name;
      let x = null; let y = null;
      if (type === 'XYZ') { x = d[2]; y = d[3]; }
      else if (type === 'FitH' || type === 'FitBH') { y = d[2]; }
      let yRatio = 0;
      if (typeof y === 'number') {
        const [, vy] = p.vp1.convertToViewportPoint(x || 0, y);
        yRatio = Math.min(Math.max((vy - DEST_TOP_MARGIN) / p.vp1.height, 0), 1);
      }
      return { page: pageIndex + 1, yRatio };
    } catch (e) {
      console.warn('resolveDest failed', e);
      return null;
    }
  }

  // ----- rendering -----

  _onScroll() {
    this._updateVisible();
    const cur = this.currentPosition();
    if (cur.page !== this._lastPage) {
      this._lastPage = cur.page;
      if (this.cb.onPageChange) this.cb.onPageChange(cur.page);
    }
    if (this.cb.onScroll) this.cb.onScroll();
  }

  _updateVisible() {
    if (!this.pages.length) return;
    const st = this.container.scrollTop;
    const ch = this.container.clientHeight;
    for (const p of this.pages) {
      const top = p.el.offsetTop;
      const bot = top + p.el.offsetHeight;
      if (bot >= st - RENDER_MARGIN && top <= st + ch + RENDER_MARGIN) {
        this._ensureRendered(p);
      } else if (bot < st - DESTROY_MARGIN || top > st + ch + DESTROY_MARGIN) {
        this._destroyPage(p);
      }
    }
  }

  _ensureRendered(p) {
    if ((p.rendered && p.renderedScale === this.scale) || p.rendering) return p.rendering;
    p.rendering = this._render(p)
      .catch((e) => console.warn('render failed', e))
      .finally(() => { p.rendering = null; });
    return p.rendering;
  }

  async _render(p) {
    const epoch = this._epoch;
    const scale = this.scale;
    const vp = p.page.getViewport({ scale });
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Cap canvas size (Safari/Chrome limits, memory).
    while (vp.width * dpr * vp.height * dpr > 16_000_000 && dpr > 0.5) dpr *= 0.8;

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    const ctx = canvas.getContext('2d', { alpha: false });
    await p.page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
    if (epoch !== this._epoch || scale !== this.scale) return;

    const tld = document.createElement('div');
    tld.className = 'textLayer';
    const ald = document.createElement('div');
    ald.className = 'annotLayer';
    p.el.replaceChildren(canvas, tld, ald);
    p.canvas = canvas;
    p.textLayerDiv = tld;
    p.annotDiv = ald;
    p.rendered = true;
    p.renderedScale = scale;

    p.textReady = (async () => {
      const tl = new pdfjsLib.TextLayer({
        textContentSource: p.page.streamTextContent(),
        container: tld,
        viewport: vp,
      });
      await tl.render();
      const eoc = document.createElement('div');
      eoc.className = 'endOfContent';
      tld.appendChild(eoc);
    })().catch((e) => console.warn('text layer failed', e));

    await this._renderAnnotations(p, vp);
    await p.textReady;
    if (this.cb.onPageRendered) {
      this.cb.onPageRendered(p, this.pages.indexOf(p) + 1);
    }
  }

  async _renderAnnotations(p, vp) {
    if (!p.annots) p.annots = await p.page.getAnnotations({ intent: 'display' });
    if (!p.annotDiv) return;
    const pageNumber = this.pages.indexOf(p) + 1;
    for (const a of p.annots) {
      if (a.subtype !== 'Link') continue;
      const r = vp.convertToViewportRectangle(a.rect);
      const left = Math.min(r[0], r[2]);
      const top = Math.min(r[1], r[3]);
      const w = Math.abs(r[0] - r[2]);
      const h = Math.abs(r[1] - r[3]);
      if (w < 1 || h < 1) continue;
      const el = document.createElement('a');
      el.className = 'pdfLink';
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      if (a.url) {
        el.href = a.url;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
        el.title = a.url;
        el.classList.add('external');
      } else if (a.dest) {
        el.href = '#';
        const info = { dest: a.dest, pageNumber, linkEl: el, pageRec: p };
        el.addEventListener('click', (ev) => {
          ev.preventDefault();
          if (this.cb.onLinkClick) this.cb.onLinkClick(info);
        });
        el.addEventListener('mouseenter', () => {
          if (this.cb.onLinkHover) this.cb.onLinkHover(info, true);
        });
        el.addEventListener('mouseleave', () => {
          if (this.cb.onLinkHover) this.cb.onLinkHover(info, false);
        });
      } else {
        continue;
      }
      p.annotDiv.appendChild(el);
    }
  }

  _destroyPage(p) {
    if (!p.rendered) return;
    p.el.replaceChildren();
    p.rendered = false;
    p.renderedScale = 0;
    p.canvas = null;
    p.textLayerDiv = null;
    p.annotDiv = null;
    p.textReady = null;
  }

  // Force a page to be rendered (without scrolling) and wait for text layer.
  async ensurePage(pageNumber) {
    const p = this.pages[pageNumber - 1];
    if (!p) return null;
    const job = this._ensureRendered(p);
    if (job) await job;
    if (p.textReady) await p.textReady;
    return p;
  }

  renderedPages() {
    return this.pages
      .map((p, i) => ({ p, pageNumber: i + 1 }))
      .filter((x) => x.p.rendered);
  }

  // Extract a human-readable label for a link ("Lemma 3.16", "(7.2)", ...)
  // from the text layer underneath / around the link rectangle.
  async getLinkLabel(p, linkEl) {
    try {
      if (p.textReady) await p.textReady;
      if (!p.textLayerDiv) return null;
      const lr = linkEl.getBoundingClientRect();
      let res = this._caretLabel(p, lr);
      if (!res || !res.text) res = this._spanClipLabel(p, lr);
      let { text, before } = res;
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) return null;
      // Repair a leading fragment like ".2" (caret slipped past "4" in "4.2")
      // using the characters immediately preceding the link.
      if (text.startsWith('.')) {
        const r = before.match(/([0-9A-Za-z]+)$/);
        if (r) {
          text = r[1] + text;
          before = before.slice(0, before.length - r[1].length);
        }
      }
      const m = before.match(/(\(|[A-Za-z\u00a7.]+)[\s~]*$/);
      const prefix = m ? m[1] : '';
      const KEY = /^(Lemma|Theorem|Proposition|Corollary|Definition|Remark|Section|Subsection|Example|Notation|Question|Conjecture|Construction|Appendix|Chapter|Figure|Table|Prop|Thm|Defn?|Cor|Lem|Rem|Sec|Eq|Equation|page|Page)\.?$/i;
      if (prefix === '(' && !text.startsWith('(')) {
        text = '(' + text + (text.endsWith(')') ? '' : ')');
      } else {
        // A ")" that leaked in without a matching "(" doesn't belong to the label.
        if (text.endsWith(')') && !text.includes('(')) text = text.slice(0, -1);
        if (prefix && KEY.test(prefix)) {
          text = (prefix + ' ' + text).replace(/\s+/g, ' ').trim();
        }
      }
      // Trim punctuation that leaked in at the edges.
      text = text.replace(/[,;:]$/, '');
      if (text.length > 48) text = text.slice(0, 47) + '\u2026';
      return text;
    } catch (e) {
      console.warn('getLinkLabel failed', e);
      return null;
    }
  }

  // Exact text under a rectangle via caret hit-testing (needs the rect to be
  // inside the viewport, which is true for a link that was just clicked).
  _caretLabel(p, lr) {
    const midY = (lr.top + lr.bottom) / 2;
    if (midY < 0 || midY > window.innerHeight || lr.width < 1) return null;
    const caretPos = (x, y) => {
      if (document.caretPositionFromPoint) {
        const c = document.caretPositionFromPoint(x, y);
        return c ? { node: c.offsetNode, offset: c.offset } : null;
      }
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        return r ? { node: r.startContainer, offset: r.startOffset } : null;
      }
      return null;
    };
    // The annotation layer sits above the text layer; disable its hit-testing
    // while sampling carets.
    const prevPE = p.annotDiv ? p.annotDiv.style.pointerEvents : null;
    if (p.annotDiv) p.annotDiv.style.pointerEvents = 'none';
    try {
      const start = caretPos(lr.left + 1, midY);
      const end = caretPos(Math.max(lr.left + 1, lr.right - 1), midY);
      if (!start || !end) return null;
      if (!p.textLayerDiv.contains(start.node) || !p.textLayerDiv.contains(end.node)) return null;
      const range = document.createRange();
      try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
      } catch {
        return null;
      }
      if (range.collapsed && start.node === end.node) {
        // Very narrow link; take one character.
        if (start.node.nodeType === Node.TEXT_NODE && start.offset < start.node.data.length) {
          range.setEnd(start.node, start.offset + 1);
        }
      }
      // The right-edge caret often lands one character short of the end of a
      // number like "3.16"; extend through any digits that continue it.
      const ec = range.endContainer;
      if (ec.nodeType === Node.TEXT_NODE) {
        let e = range.endOffset;
        const data = ec.data;
        while (e < data.length && /[0-9]/.test(data[e])) e++;
        if (e < data.length && data[e] === '.' && /[0-9]/.test(data[e + 1] || '')) {
          e++;
          while (e < data.length && /[0-9]/.test(data[e])) e++;
        }
        try { range.setEnd(ec, e); } catch { /* keep old end */ }
      }
      const before = start.node.nodeType === Node.TEXT_NODE
        ? start.node.data.slice(0, start.offset)
        : '';
      return { text: range.toString(), before };
    } finally {
      if (p.annotDiv) p.annotDiv.style.pointerEvents = prevPE;
    }
  }

  // Fallback: approximate the covered substring of each intersecting span
  // proportionally. Works off-screen, less precise.
  _spanClipLabel(p, lr) {
    let text = '';
    let before = '';
    for (const span of p.textLayerDiv.querySelectorAll('span')) {
      const s = span.textContent;
      if (!s) continue;
      const sr = span.getBoundingClientRect();
      if (!sr.width || !sr.height) continue;
      const vOverlap = Math.min(sr.bottom, lr.bottom) - Math.max(sr.top, lr.top);
      if (vOverlap < Math.min(sr.height, lr.height) * 0.5) continue;
      const hOverlap = Math.min(sr.right, lr.right) - Math.max(sr.left, lr.left);
      if (hOverlap <= 0) continue;
      const startFrac = Math.max(0, (lr.left - sr.left) / sr.width);
      const endFrac = Math.min(1, (lr.right - sr.left) / sr.width);
      const i0 = Math.floor(startFrac * s.length);
      const i1 = Math.ceil(endFrac * s.length);
      text += s.slice(i0, i1);
      if (i0 > 0) before = s.slice(0, i0);
    }
    return { text, before };
  }
}
