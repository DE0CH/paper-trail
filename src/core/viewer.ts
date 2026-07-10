// PDF rendering: continuous scroll, lazy page rendering, text layer,
// link annotations, zoom, and scale-independent positions.

import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PageViewport,
} from 'pdfjs-dist';
import type { Pos } from './types';

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const RENDER_MARGIN = 900; // px beyond viewport to pre-render
const DESTROY_MARGIN = 3200; // px beyond viewport to tear pages down
const PROBE_OFFSET = 8; // px used to define "current position"
const DEST_TOP_MARGIN = 48; // px of context above a jump target (at scale 1)

export interface PageRec {
  page: PDFPageProxy;
  vp1: PageViewport;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  textLayerDiv: HTMLDivElement | null;
  annotDiv: HTMLDivElement | null;
  annots: Annot[] | null;
  rendered: boolean;
  renderedScale: number;
  rendering: Promise<void> | null;
  textReady: Promise<void> | null;
  pinned: number;
}

interface Annot {
  subtype: string;
  rect: [number, number, number, number];
  url?: string;
  dest?: string | unknown[];
}

export interface LinkInfo {
  dest: string | unknown[];
  pageNumber: number;
  linkEl: HTMLAnchorElement;
  pageRec: PageRec;
  fork?: boolean;
}

export interface ViewerCallbacks {
  onLinkClick?: (info: LinkInfo) => void;
  onLinkHover?: (info: LinkInfo, entering: boolean) => void;
  onPageChange?: (page: number) => void;
  onScroll?: () => void;
  onPageRendered?: (p: PageRec, pageNumber: number) => void;
  onScaleChange?: (scale: number) => void;
}

export class Viewer {
  container: HTMLElement;
  viewerEl: HTMLElement;
  cb: ViewerCallbacks;
  doc: PDFDocumentProxy | null = null;
  pages: PageRec[] = [];
  scale = 1;
  fitWidth = true;
  private epoch = 0;
  private suppressUntil = 0;
  private lastPage = 0;
  private scrollRaf = 0;

  constructor(container: HTMLElement, viewerEl: HTMLElement, callbacks: ViewerCallbacks = {}) {
    this.container = container;
    this.viewerEl = viewerEl;
    this.cb = callbacks;

    container.addEventListener('scroll', () => {
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0;
        this.onScrollEvent();
      });
    });
  }

  private loadingTask: ReturnType<typeof getDocument> | null = null;

  async open(src: { data?: Uint8Array; url?: string }): Promise<PDFDocumentProxy | null> {
    this.close();
    const epoch = ++this.epoch;
    const task = getDocument(src);
    const doc = await task.promise;
    if (epoch !== this.epoch) {
      void task.destroy();
      return null;
    }
    this.loadingTask = task;
    this.doc = doc;
    const n = doc.numPages;
    this.pages = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      if (epoch !== this.epoch) return null;
      this.pages.push({
        page,
        vp1: page.getViewport({ scale: 1 }),
        el: document.createElement('div'),
        canvas: null,
        textLayerDiv: null,
        annotDiv: null,
        annots: null,
        rendered: false,
        renderedScale: 0,
        rendering: null,
        textReady: null,
        pinned: 0,
      });
    }
    if (this.fitWidth) this.scale = this.computeFitScale();
    this.buildShells();
    this.updateVisible();
    return doc;
  }

  close(): void {
    this.epoch++;
    if (this.loadingTask) this.loadingTask.destroy().catch(() => {});
    this.loadingTask = null;
    this.doc = null;
    this.pages = [];
    this.viewerEl.replaceChildren();
    this.lastPage = 0;
  }

  get numPages(): number {
    return this.pages.length;
  }

  computeFitScale(): number {
    const w = this.container.clientWidth - 36;
    const base = this.pages[0] ? this.pages[0].vp1.width : 612;
    return Math.min(Math.max(w / base, 0.25), 5);
  }

  private buildShells(): void {
    this.viewerEl.replaceChildren();
    this.viewerEl.style.setProperty('--scale-factor', String(this.scale));
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i];
      p.el.className = 'page';
      p.el.dataset.page = String(i + 1);
      this.sizeShell(p);
      this.viewerEl.appendChild(p.el);
    }
  }

  private sizeShell(p: PageRec): void {
    // Size shells so the CSS box maps to an integer number of device
    // pixels (backing / dpr); flooring here while the canvas backing store
    // rounds separately would make the bitmap resample slightly (~2.001:1
    // instead of 2:1) and every glyph goes soft.
    const dpr = this.effectiveDpr(p);
    const { cssW, cssH } = this.exactPageCss(p, dpr);
    p.el.style.width = `${cssW}px`;
    p.el.style.height = `${cssH}px`;
    p.el.style.setProperty('--scale-factor', String(this.scale));
  }

  /** Device pixel ratio used for rendering, after the canvas-area cap. */
  private effectiveDpr(p: PageRec): number {
    let dpr = window.devicePixelRatio || 1;
    const w = p.vp1.width * this.scale;
    const h = p.vp1.height * this.scale;
    while (w * dpr * h * dpr > 64_000_000 && dpr > 0.5) dpr *= 0.8;
    return dpr;
  }

  /** CSS size that corresponds exactly to the rounded backing store. */
  private exactPageCss(p: PageRec, dpr: number): { cssW: number; cssH: number; backingW: number; backingH: number } {
    const backingW = Math.round(p.vp1.width * this.scale * dpr);
    const backingH = Math.round(p.vp1.height * this.scale * dpr);
    return { cssW: backingW / dpr, cssH: backingH / dpr, backingW, backingH };
  }

  setScale(
    scale: number,
    { fitWidth = false, anchor }: { fitWidth?: boolean; anchor?: { x: number; y: number } } = {},
  ): void {
    scale = Math.min(Math.max(scale, 0.25), 5);
    if (!this.pages.length) {
      this.scale = scale;
      this.fitWidth = fitWidth;
      return;
    }
    const ratio = scale / this.scale;
    const st = this.container.scrollTop;
    const sl = this.container.scrollLeft;
    const rect = this.container.getBoundingClientRect();
    const pos = anchor ? null : this.currentPosition();

    this.scale = scale;
    this.fitWidth = fitWidth;
    this.viewerEl.style.setProperty('--scale-factor', String(scale));
    for (const p of this.pages) {
      this.destroyPage(p);
      this.sizeShell(p);
    }
    if (anchor) {
      // Pinch/ctrl+wheel zoom: keep the document point under the cursor
      // (approximately) stationary.
      const cy = anchor.y - rect.top;
      const cx = anchor.x - rect.left;
      this.suppress();
      this.container.scrollTop = (st + cy) * ratio - cy;
      this.container.scrollLeft = (sl + cx) * ratio - cx;
    } else if (pos) {
      this.scrollTo(pos);
    }
    this.updateVisible();
    this.cb.onScaleChange?.(scale);
  }

  // ----- positions -----

  currentPosition(): Pos {
    if (!this.pages.length) return { page: 1, yRatio: 0 };
    const probe = this.container.scrollTop + PROBE_OFFSET;
    let best = this.pages[0];
    let bestIdx = 0;
    for (let i = 0; i < this.pages.length; i++) {
      const el = this.pages[i].el;
      if (el.offsetTop <= probe) {
        best = this.pages[i];
        bestIdx = i;
      } else break;
    }
    const h = best.el.offsetHeight || 1;
    const yRatio = Math.min(Math.max((probe - best.el.offsetTop) / h, 0), 1);
    return { page: bestIdx + 1, yRatio };
  }

  scrollTo({ page, yRatio = 0 }: Pos, { suppressTracking = true } = {}): void {
    const p = this.pages[page - 1];
    if (!p) return;
    if (suppressTracking) this.suppress();
    this.container.scrollTop = p.el.offsetTop + yRatio * p.el.offsetHeight - PROBE_OFFSET;
    this.updateVisible();
  }

  private suppress(): void {
    this.suppressUntil = Date.now() + 600;
  }

  isTrackingSuppressed(): boolean {
    return Date.now() < this.suppressUntil;
  }

  /** Resolve a PDF destination (named string or explicit array) to a position. */
  async resolveDest(dest: string | unknown[] | null | undefined): Promise<Pos | null> {
    try {
      if (!this.doc || dest == null) return null;
      let d: unknown[] | null = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
      if (!Array.isArray(d)) return null;
      let pageIndex: number;
      if (typeof d[0] === 'object' && d[0] !== null) {
        pageIndex = await this.doc.getPageIndex(d[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
      } else {
        pageIndex = d[0] as number;
      }
      const p = this.pages[pageIndex];
      if (!p) return null;
      const type = (d[1] as { name?: string } | undefined)?.name;
      let x: number | null = null;
      let y: number | null = null;
      if (type === 'XYZ') {
        x = d[2] as number | null;
        y = d[3] as number | null;
      } else if (type === 'FitH' || type === 'FitBH') {
        y = d[2] as number | null;
      }
      let yRatio = 0;
      if (typeof y === 'number') {
        const [, vy] = p.vp1.convertToViewportPoint(x ?? 0, y);
        yRatio = Math.min(Math.max((vy - DEST_TOP_MARGIN) / p.vp1.height, 0), 1);
      }
      return { page: pageIndex + 1, yRatio };
    } catch (e) {
      console.warn('resolveDest failed', e);
      return null;
    }
  }

  // ----- rendering -----

  private onScrollEvent(): void {
    this.updateVisible();
    const cur = this.currentPosition();
    if (cur.page !== this.lastPage) {
      this.lastPage = cur.page;
      this.cb.onPageChange?.(cur.page);
    }
    this.cb.onScroll?.();
  }

  private updateVisible(): void {
    if (!this.pages.length) return;
    const st = this.container.scrollTop;
    const ch = this.container.clientHeight;
    for (const p of this.pages) {
      const top = p.el.offsetTop;
      const bot = top + p.el.offsetHeight;
      if (bot >= st - RENDER_MARGIN && top <= st + ch + RENDER_MARGIN) {
        this.ensureRendered(p);
      } else if (!p.pinned && (bot < st - DESTROY_MARGIN || top > st + ch + DESTROY_MARGIN)) {
        this.destroyPage(p);
      }
    }
  }

  private ensureRendered(p: PageRec): Promise<void> | null {
    if ((p.rendered && p.renderedScale === this.scale) || p.rendering) return p.rendering;
    p.rendering = this.render(p)
      .catch((e) => console.warn('render failed', e))
      .finally(() => {
        p.rendering = null;
      });
    return p.rendering;
  }

  private async render(p: PageRec): Promise<void> {
    const epoch = this.epoch;
    const scale = this.scale;
    const vp = p.page.getViewport({ scale });
    // Render at the full device pixel ratio (browser zoom raises it beyond
    // 2 on retina displays; capping it makes text soft). Only the total
    // canvas area is capped (memory / browser limits) — desktop Chromium
    // handles very large canvases, 64M pixels stays well inside the limits.
    const dpr = this.effectiveDpr(p);
    const { cssW, cssH, backingW, backingH } = this.exactPageCss(p, dpr);

    const canvas = document.createElement('canvas');
    canvas.width = backingW;
    canvas.height = backingH;
    // Explicit CSS size = backing / dpr, so the bitmap maps 1:1 onto device
    // pixels with no resampling.
    canvas.style.display = 'block';
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    await p.page.render({
      canvas,
      canvasContext: ctx,
      viewport: vp,
      // Exact backing/viewport ratio (differs from dpr in the last decimals
      // because the backing store is rounded to integers).
      transform: [backingW / vp.width, 0, 0, backingH / vp.height, 0, 0],
    }).promise;
    if (epoch !== this.epoch || scale !== this.scale) return;

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
      const tl = new TextLayer({
        textContentSource: p.page.streamTextContent(),
        container: tld,
        viewport: vp,
      });
      await tl.render();
      const eoc = document.createElement('div');
      eoc.className = 'endOfContent';
      tld.appendChild(eoc);
    })().catch((e) => console.warn('text layer failed', e));

    await this.renderAnnotations(p, vp);
    await p.textReady;
    this.cb.onPageRendered?.(p, this.pages.indexOf(p) + 1);
  }

  private async renderAnnotations(p: PageRec, vp: PageViewport): Promise<void> {
    if (!p.annots) p.annots = (await p.page.getAnnotations({ intent: 'display' })) as Annot[];
    if (!p.annotDiv) return;
    const pageNumber = this.pages.indexOf(p) + 1;
    for (const a of p.annots) {
      if (a.subtype !== 'Link') continue;
      // (convertToViewportRectangle was removed from pdf.js; do it manually)
      const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
      const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const w = Math.abs(x1 - x2);
      const h = Math.abs(y1 - y2);
      if (w < 1 || h < 1) continue;
      const el = document.createElement('a');
      el.className = 'pdfLink';
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      if (a.url) {
        el.href = a.url;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
        el.title = a.url;
        el.classList.add('external');
      } else if (a.dest) {
        el.href = '#';
        const info: LinkInfo = { dest: a.dest, pageNumber, linkEl: el, pageRec: p };
        el.addEventListener('click', (ev) => {
          ev.preventDefault();
          this.cb.onLinkClick?.({ ...info, fork: ev.metaKey || ev.ctrlKey });
        });
        // Middle-click forks too (mirrors "open in new tab").
        el.addEventListener('auxclick', (ev) => {
          if (ev.button !== 1) return;
          ev.preventDefault();
          this.cb.onLinkClick?.({ ...info, fork: true });
        });
        el.addEventListener('mouseenter', () => this.cb.onLinkHover?.(info, true));
        el.addEventListener('mouseleave', () => this.cb.onLinkHover?.(info, false));
      } else {
        continue;
      }
      p.annotDiv.appendChild(el);
    }
  }

  private destroyPage(p: PageRec): void {
    if (!p.rendered) return;
    p.el.replaceChildren();
    p.rendered = false;
    p.renderedScale = 0;
    p.canvas = null;
    p.textLayerDiv = null;
    p.annotDiv = null;
    p.textReady = null;
  }

  /**
   * Force a page to be rendered (without scrolling) and wait for its text
   * layer. The page is pinned briefly so the windowing logic doesn't destroy
   * it while (or right after) the caller reads its DOM.
   */
  async ensurePage(pageNumber: number): Promise<PageRec | null> {
    const p = this.pages[pageNumber - 1];
    if (!p) return null;
    p.pinned++;
    try {
      let job = this.ensureRendered(p);
      if (job) await job;
      if (p.textReady) await p.textReady;
      if (!p.rendered) {
        // Was destroyed by scrolling while rendering; retry once now pinned.
        job = this.ensureRendered(p);
        if (job) await job;
        if (p.textReady) await p.textReady;
      }
      return p;
    } finally {
      setTimeout(() => {
        p.pinned = Math.max(0, p.pinned - 1);
      }, 2000);
    }
  }

  renderedPages(): Array<{ p: PageRec; pageNumber: number }> {
    return this.pages
      .map((p, i) => ({ p, pageNumber: i + 1 }))
      .filter((x) => x.p.rendered);
  }

  // ----- link labels -----

  /**
   * Extract a human-readable label for a link ("Lemma 3.16", "(7.2)", ...)
   * from the text layer underneath / around the link rectangle.
   */
  async getLinkLabel(p: PageRec, linkEl: HTMLElement): Promise<string | null> {
    try {
      if (p.textReady) await p.textReady;
      if (!p.textLayerDiv) return null;
      const lr = linkEl.getBoundingClientRect();
      let res = this.caretLabel(p, lr, linkEl);
      if (!res || !res.text) res = this.spanClipLabel(p, lr);
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
        // A ")" that leaked in without a matching "(" doesn't belong.
        if (text.endsWith(')') && !text.includes('(')) text = text.slice(0, -1);
        if (prefix && KEY.test(prefix)) {
          text = `${prefix} ${text}`.replace(/\s+/g, ' ').trim();
        }
      }
      text = text.replace(/[,;:]$/, '');
      if (text.length > 48) text = text.slice(0, 47) + '\u2026';
      return text;
    } catch (e) {
      console.warn('getLinkLabel failed', e);
      return null;
    }
  }

  /**
   * Exact text under a rectangle via caret hit-testing (needs the rect to be
   * inside the viewport, which is true for a link that was just clicked).
   */
  private caretLabel(
    p: PageRec,
    lr: DOMRect,
    linkEl: HTMLElement,
  ): { text: string; before: string } | null {
    const midY = (lr.top + lr.bottom) / 2;
    if (midY < 0 || midY > window.innerHeight || lr.width < 1) return null;
    const caretPos = (x: number, y: number): { node: Node; offset: number } | null => {
      const docAny = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      if (docAny.caretPositionFromPoint) {
        const c = docAny.caretPositionFromPoint(x, y);
        return c ? { node: c.offsetNode, offset: c.offset } : null;
      }
      if (docAny.caretRangeFromPoint) {
        const r = docAny.caretRangeFromPoint(x, y);
        return r ? { node: r.startContainer, offset: r.startOffset } : null;
      }
      return null;
    };
    // The link sits above the text layer (pointer-events: auto); disable its
    // hit-testing while sampling carets underneath it.
    const prevPE = linkEl.style.pointerEvents;
    linkEl.style.pointerEvents = 'none';
    try {
      const start = caretPos(lr.left + 1, midY);
      const end = caretPos(Math.max(lr.left + 1, lr.right - 1), midY);
      if (!start || !end) return null;
      if (!p.textLayerDiv!.contains(start.node) || !p.textLayerDiv!.contains(end.node)) return null;
      const range = document.createRange();
      try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
      } catch {
        return null;
      }
      if (range.collapsed && start.node === end.node) {
        // Very narrow link; take one character.
        if (start.node.nodeType === Node.TEXT_NODE
            && start.offset < (start.node as Text).data.length) {
          range.setEnd(start.node, start.offset + 1);
        }
      }
      // The right-edge caret often lands one character short of the end of a
      // number like "3.16"; extend through any digits that continue it.
      const ec = range.endContainer;
      if (ec.nodeType === Node.TEXT_NODE) {
        let e = range.endOffset;
        const data = (ec as Text).data;
        while (e < data.length && /[0-9]/.test(data[e])) e++;
        if (e < data.length && data[e] === '.' && /[0-9]/.test(data[e + 1] ?? '')) {
          e++;
          while (e < data.length && /[0-9]/.test(data[e])) e++;
        }
        try {
          range.setEnd(ec, e);
        } catch { /* keep old end */ }
      }
      const before = start.node.nodeType === Node.TEXT_NODE
        ? (start.node as Text).data.slice(0, start.offset)
        : '';
      return { text: range.toString(), before };
    } finally {
      linkEl.style.pointerEvents = prevPE;
    }
  }

  /**
   * Fallback: approximate the covered substring of each intersecting span
   * proportionally. Works off-screen, less precise.
   */
  private spanClipLabel(p: PageRec, lr: DOMRect): { text: string; before: string } {
    let text = '';
    let before = '';
    for (const span of p.textLayerDiv!.querySelectorAll('span')) {
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
