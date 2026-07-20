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
import { backingGeometry } from './renderGeometry';

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// pdf.js side data, bundled with the app (see vite.config.ts) so that
// CID-encoded (CJK) text, the 14 standard fonts AND the wasm image
// codecs work without any network access — the desktop app must run
// entirely offline. `wasmUrl` is where pdf.js v6 loads its CCITT
// fax/JBIG2/JPEG 2000/ICC decoders from; without it every
// CCITTFaxDecode image (i.e. every page of a typical scanned PDF)
// fails to decode and its page paints permanently blank — render()
// still resolves, so no error surfaces and nothing retries.
const PDF_ASSETS = {
  cMapUrl: new URL('pdfjs/cmaps/', document.baseURI).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href,
  wasmUrl: new URL('pdfjs/wasm/', document.baseURI).href,
};

const RENDER_MARGIN = 900; // px beyond viewport to pre-render
const DESTROY_MARGIN = 3200; // px beyond viewport to tear pages down
const PROBE_OFFSET = 8; // px used to define "current position"
const DEST_TOP_MARGIN = 48; // px of context above a jump target (at scale 1)
// Smooth progressive rendering: a page entering the window with no canvas
// at all paints a quick pass at 1/LOW_RES_FACTOR of the device resolution
// (1/9 of the pixels), CSS-stretched over the full page box, before the
// crisp render replaces it atomically. Scrolling counts as active until
// SCROLL_SETTLE_MS after the last scroll event; while it is, pages outside
// the viewport keep their cheap low-res canvases and the heavy
// device-pixel-exact renders wait for the settle.
const LOW_RES_FACTOR = 3;
const SCROLL_SETTLE_MS = 200;
// Above this scroll speed (px per ms — ~a viewport height every 35ms) no
// render can land while its page is still relevant: every started pass is
// obsolete before it paints and only steals frame time (measured on the
// fling profile). Such fling frames start no renders; rendering resumes
// as soon as the speed drops (momentum tail) or scrolling settles.
const FLING_PX_PER_MS = 25;

export interface PageRec {
  page: PDFPageProxy;
  vp1: PageViewport;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  textLayerDiv: HTMLDivElement | null;
  annotDiv: HTMLDivElement | null;
  annots: Annot[] | null;
  rendered: boolean;
  // A rendered page whose canvas is currently a stretched smooth-zoom
  // placeholder (wrong scale, awaiting a fresh render). `rendered` still
  // means "a canvas is mounted in this shell" so destroyPage can reliably
  // tear it down; `stale` says that canvas is not yet crisp.
  stale: boolean;
  renderedScale: number;
  rendering: Promise<void> | null;
  // In-flight quick low-resolution pass (separate from `rendering` so the
  // crisp render's guards keep working; only one of the two mounts).
  lowResRendering: Promise<void> | null;
  renderFailed?: boolean;
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
  private lastScrollTs = -Infinity;
  private lastScrollTop = 0;
  private scrollVelocity = 0; // px per ms between the last two scroll frames
  private settleTimer = 0;
  /**
   * Rolling log of canvas mounts: 'low' for the quick low-resolution pass,
   * 'full' for the crisp device-pixel-exact render. Observability for
   * tests and tooling (window.__pt.viewer.renderLog); newest last.
   */
  renderLog: { page: number; res: 'low' | 'full' }[] = [];

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

    // Re-render when the window moves to a display with a different
    // devicePixelRatio (1x <-> 2x): already-rendered pages would otherwise
    // stay at the old density forever (nothing else invalidates them), and
    // shells sized with the old dpr would drift sub-pixel from canvases
    // rendered at the new one. A `resolution` media query fires exactly on
    // that change; it must be re-armed for each new ratio.
    const watchDpr = (): void => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      const onChange = (): void => {
        mq.removeEventListener('change', onChange);
        this.refreshForDprChange();
        watchDpr();
      };
      mq.addEventListener('change', onChange);
    };
    watchDpr();
  }

  /**
   * Invalidate every page for a new devicePixelRatio: re-size the shells
   * (their CSS box depends on the dpr) and mark the mounted canvases stale
   * — kept stretched as placeholders, exactly like a zoom — then re-render
   * the visible ones crisply at the new density.
   */
  refreshForDprChange(): void {
    if (!this.pages.length) return;
    for (const p of this.pages) {
      p.renderFailed = false; // the failure may have been density-related
      this.markStale(p);
      this.sizeShell(p);
    }
    this.updateVisible();
  }

  private loadingTask: ReturnType<typeof getDocument> | null = null;

  async open(src: { data?: Uint8Array; url?: string }): Promise<PDFDocumentProxy | null> {
    this.close();
    const epoch = ++this.epoch;
    const task = getDocument({ ...src, ...PDF_ASSETS });
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
        stale: false,
        renderedScale: 0,
        rendering: null,
        lowResRendering: null,
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
    // A close can land mid-pinch: never let the gesture's CSS transform
    // (beginVisualZoom/applyVisualZoom) leak onto the next document.
    this.viewerEl.style.transform = '';
    this.viewerEl.style.willChange = '';
    this.lastPage = 0;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = 0;
    }
    this.renderLog = [];
  }

  get numPages(): number {
    return this.pages.length;
  }

  /**
   * Monotonic document generation: bumps whenever a document opens or
   * closes. Lets per-document caches (thumbnails, timers armed against a
   * document) detect a swap even when the name and page count both match
   * (e.g. Replace PDF with a revised same-named file).
   */
  get docEpoch(): number {
    return this.epoch;
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
    const { cssW, cssH } = this.pageGeometry(p);
    p.el.style.width = `${cssW}px`;
    p.el.style.height = `${cssH}px`;
    p.el.style.setProperty('--scale-factor', String(this.scale));
  }

  /**
   * Backing-store size and the exactly-corresponding CSS box for a page at
   * the current scale (shared math — see renderGeometry.ts).
   */
  private pageGeometry(p: PageRec): ReturnType<typeof backingGeometry> {
    return backingGeometry(
      p.vp1.width * this.scale,
      p.vp1.height * this.scale,
      window.devicePixelRatio || 1,
    );
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
    const st = this.container.scrollTop;
    const sl = this.container.scrollLeft;
    const pos = anchor ? null : this.currentPosition();
    // No-anchor zoom (toolbar/keyboard): the horizontal offset is otherwise
    // left to CSS `margin: 0 auto`, which centers the page only while it is
    // narrower than the viewport. Crossing the fit-width boundary would then
    // snap it hard to the left. Capture the viewport-center point as a
    // fraction of the scrollable width so it can be restored across the
    // boundary (centered when narrower, same center-point when wider).
    const cw = this.container.clientWidth;
    const swBefore = this.container.scrollWidth;
    const centerFrac = swBefore > 0 ? (sl + cw / 2) / swBefore : 0.5;

    // Anchored zoom (pinch commit): capture the exact page-relative point
    // under the cursor BEFORE relayout, so it can be restored exactly after
    // — assuming uniform content scaling is not precise enough (rounding,
    // clamped scroll) and caused visible jumps at gesture release.
    let anchorRef: { idx: number; fy: number; fx: number; ax: number; ay: number } | null = null;
    if (anchor && this.pages.length) {
      const rect = this.container.getBoundingClientRect();
      const ay = anchor.y - rect.top;
      const ax = anchor.x - rect.left;
      const cy = st + ay;
      const cx = sl + ax;
      let idx = 0;
      for (let i = 0; i < this.pages.length; i++) {
        if (this.pages[i].el.offsetTop <= cy) idx = i;
        else break;
      }
      const el = this.pages[idx].el;
      anchorRef = {
        idx,
        fy: (cy - el.offsetTop) / (el.offsetHeight || 1),
        fx: (cx - el.offsetLeft) / (el.offsetWidth || 1),
        ax,
        ay,
      };
    }

    this.scale = scale;
    this.fitWidth = fitWidth;
    this.viewerEl.style.setProperty('--scale-factor', String(scale));
    for (const p of this.pages) {
      p.renderFailed = false; // a new scale is a fresh chance for a failed page
      this.markStale(p); // keep the old canvas stretched until the new render
      this.sizeShell(p);
    }
    if (anchorRef) {
      const el = this.pages[anchorRef.idx].el;
      this.suppress();
      this.container.scrollTop =
        el.offsetTop + anchorRef.fy * el.offsetHeight - anchorRef.ay;
      this.container.scrollLeft =
        el.offsetLeft + anchorRef.fx * el.offsetWidth - anchorRef.ax;
    } else if (pos) {
      this.scrollTo(pos);
      // Restore the horizontal center-point after relayout (scrollTo only
      // touches scrollTop). Clamps to 0 when the page is narrower than the
      // viewport, so `margin: auto` keeps it centered.
      const swAfter = this.container.scrollWidth;
      const maxSl = Math.max(0, swAfter - cw);
      this.container.scrollLeft = Math.min(Math.max(centerFrac * swAfter - cw / 2, 0), maxSl);
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
    let p = this.pages[page - 1];
    if (!p) {
      // Position doesn't exist in this document (e.g. a session saved with
      // a different PDF): navigate to the top instead of breaking.
      if (!this.pages.length) return;
      p = this.pages[0];
      yRatio = 0;
    }
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
    // Scrolling itself moves already-rendered pages by compositing only —
    // nothing below writes styles or touches a crisp canvas. This handler
    // just marks scrolling active and re-windows the render work; the
    // settle timer runs updateVisible once more after the last scroll
    // event, which is when deferred full-resolution upgrades happen.
    const now = performance.now();
    const st = this.container.scrollTop;
    const dt = now - this.lastScrollTs;
    // A first event after an idle gap is a fresh gesture, not a fling.
    this.scrollVelocity = dt > 0 && dt < 500 ? Math.abs(st - this.lastScrollTop) / dt : 0;
    this.lastScrollTop = st;
    this.lastScrollTs = now;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = 0;
      this.updateVisible();
    }, SCROLL_SETTLE_MS + 40);
    this.updateVisible();
    const cur = this.currentPosition();
    if (cur.page !== this.lastPage) {
      this.lastPage = cur.page;
      this.cb.onPageChange?.(cur.page);
    }
    this.cb.onScroll?.();
  }

  private isScrolling(): boolean {
    return performance.now() - this.lastScrollTs < SCROLL_SETTLE_MS;
  }

  private updateVisible(): void {
    if (!this.pages.length) return;
    const st = this.container.scrollTop;
    const ch = this.container.clientHeight;
    const scrolling = this.isScrolling();
    const flinging = scrolling && this.scrollVelocity > FLING_PX_PER_MS;
    for (const p of this.pages) {
      const top = p.el.offsetTop;
      const bot = top + p.el.offsetHeight;
      if (bot >= st - RENDER_MARGIN && top <= st + ch + RENDER_MARGIN) {
        // A page whose render FAILED is not retried from here: updateVisible
        // runs on every scroll animation frame, so an unconditional retry
        // becomes a storm of full-canvas allocations against a page that
        // keeps failing. The flag clears on a scale change (setScale) and a
        // document change; an explicit ensurePage() may still retry.
        if (p.renderFailed) continue;
        if (flinging) continue; // start nothing mid-fling (see FLING_PX_PER_MS)
        if (!p.rendered) {
          // A blank shell entering the window (scroll or zoom-out) paints
          // the quick low-res pass first; its completion re-runs this and
          // the branches below take over the crisp upgrade.
          this.ensureLowRes(p);
        } else if (bot >= st && top <= st + ch) {
          // Intersects the viewport: always upgrade to crisp promptly.
          this.ensureRendered(p);
        } else if (!scrolling) {
          // Margin prefetch goes crisp only once scrolling settles (the
          // settle timer re-runs this); mid-scroll the cheap stretched
          // canvas is enough, and full renders would eat the frames.
          this.ensureRendered(p);
        }
      } else if (!p.pinned && (bot < st - DESTROY_MARGIN || top > st + ch + DESTROY_MARGIN)) {
        this.destroyPage(p);
      } else if (!scrolling && !p.rendered && !p.renderFailed) {
        // Between the render and destroy margins: while idle, pre-paint the
        // cheap low-res pass so the next scroll reveals content instead of
        // blank shells. Only while idle — doing this mid-scroll renders
        // every page a fast fling passes over (measured: it more than
        // doubled the janky-frame share on the fling profile), while the
        // pages the fling lands on are covered by the render-window pass.
        this.ensureLowRes(p);
      }
    }
  }

  private ensureRendered(p: PageRec): Promise<void> | null {
    if ((p.rendered && !p.stale && p.renderedScale === this.scale) || p.rendering) return p.rendering;
    p.renderFailed = false;
    p.rendering = this.render(p)
      .catch((e) => {
        p.renderFailed = true;
        console.warn('render failed', e);
      })
      .finally(() => {
        p.rendering = null;
        // A scale/document change can invalidate a render mid-flight (the
        // result is discarded by the guard). Nothing else re-triggers
        // rendering in that case, so check again — including a page left
        // stale (canvas still a placeholder) or rendered at the wrong scale.
        if (!p.renderFailed && (!p.rendered || p.stale || p.renderedScale !== this.scale)) {
          queueMicrotask(() => this.updateVisible());
        }
      });
    return p.rendering;
  }

  private logRender(p: PageRec, res: 'low' | 'full'): void {
    this.renderLog.push({ page: this.pages.indexOf(p) + 1, res });
    if (this.renderLog.length > 400) this.renderLog.splice(0, this.renderLog.length - 400);
  }

  private ensureLowRes(p: PageRec): void {
    if (p.rendered || p.rendering || p.lowResRendering || p.renderFailed) return;
    p.lowResRendering = this.renderLowRes(p)
      .catch((e) => {
        p.renderFailed = true; // same retry-storm protection as the full pass
        console.warn('low-res render failed', e);
      })
      .finally(() => {
        p.lowResRendering = null;
        // The mounted canvas is only a placeholder — let the windowing
        // logic decide the upgrade (viewport pages go crisp at once,
        // margin pages once scrolling settles).
        if (!p.renderFailed) queueMicrotask(() => this.updateVisible());
      });
  }

  /**
   * The quick pass of the two-pass scroll/zoom-out rendering: a small
   * canvas (deliberately NOT device-pixel exact — 1/LOW_RES_FACTOR of the
   * device resolution, inside the same backing caps) CSS-stretched over
   * the full page box. Marked stale exactly like a smooth-zoom
   * placeholder, so every existing path (destroy, re-shell, crisp
   * upgrade) treats it as "mounted but awaiting the real render".
   */
  private async renderLowRes(p: PageRec): Promise<void> {
    const epoch = this.epoch;
    const scale = this.scale;
    const vp = p.page.getViewport({ scale });
    const { cssW, cssH } = this.pageGeometry(p);
    const low = backingGeometry(cssW, cssH, (window.devicePixelRatio || 1) / LOW_RES_FACTOR);
    const canvas = document.createElement('canvas');
    canvas.width = low.backingW;
    canvas.height = low.backingH;
    canvas.style.display = 'block';
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.dataset.res = 'low';
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas context unavailable');
    await p.page.render({
      canvas,
      canvasContext: ctx,
      viewport: vp,
      transform: [low.backingW / vp.width, 0, 0, low.backingH / vp.height, 0, 0],
    }).promise;
    if (epoch !== this.epoch || scale !== this.scale) return;
    if (p.rendered || p.rendering) return; // a crisp render won the race
    // The page can leave the keep-alive window mid-render (fast fling);
    // mounting it would only be torn down again on the next pass.
    const st = this.container.scrollTop;
    const ch = this.container.clientHeight;
    const top = p.el.offsetTop;
    const bot = top + p.el.offsetHeight;
    if (bot < st - DESTROY_MARGIN || top > st + ch + DESTROY_MARGIN) return;
    p.el.replaceChildren(canvas); // atomic mount: never a canvasless flash
    p.canvas = canvas;
    p.rendered = true;
    p.stale = true; // a placeholder awaiting the crisp render (see markStale)
    p.renderedScale = 0;
    this.logRender(p, 'low');
  }

  private async render(p: PageRec): Promise<void> {
    const epoch = this.epoch;
    const scale = this.scale;
    const vp = p.page.getViewport({ scale });
    // Render at the full device pixel ratio (browser zoom raises it beyond
    // 2 on retina displays; capping it makes text soft) — reduced only as
    // far as the canvas caps demand (see renderGeometry.ts).
    const { cssW, cssH, backingW, backingH } = this.pageGeometry(p);

    const canvas = document.createElement('canvas');
    canvas.width = backingW;
    canvas.height = backingH;
    // Explicit CSS size = backing / dpr, so the bitmap maps 1:1 onto device
    // pixels with no resampling.
    canvas.style.display = 'block';
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.dataset.res = 'full';
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas context unavailable');
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
    p.stale = false;
    p.renderedScale = scale;
    this.logRender(p, 'full');

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
        // expose the destination page (used by tooling/tests)
        void this.resolveDest(a.dest).then((pos) => {
          if (pos && el.isConnected) el.dataset.destPage = String(pos.page);
        });
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
    p.stale = false;
    p.renderedScale = 0;
    p.canvas = null;
    p.textLayerDiv = null;
    p.annotDiv = null;
    p.textReady = null;
    // Release pdf.js's decoded-image cache for the evicted page. For text
    // pages this is negligible, but a scanned page retains ~35MB of decoded
    // RGBA — a cover-to-cover read of a 50-page scan held 1.7GB. Skipped
    // while a render is in flight (cleanup would throw mid-render; the
    // page will be destroyed again by windowing once it settles), and
    // guarded because cleanup can reject on a closing document.
    if (!p.rendering && !p.lowResRendering) {
      try { p.page.cleanup(); } catch { /* mid-teardown: nothing to free */ }
    }
  }

  /**
   * Part of the smooth-zoom feature: invalidate a page for re-rendering but
   * keep its old canvas stretched to the new size as a placeholder
   * (temporarily blurry instead of blank), so a zoom stays smooth instead of
   * flashing white. The fresh render replaces it atomically.
   */
  private markStale(p: PageRec): void {
    if (!p.canvas) return;
    // Keep `rendered` true (a canvas is still mounted) so destroyPage can
    // tear this shell down if the reflow pushes it out of range; `stale`
    // marks the canvas as a placeholder awaiting a fresh, crisp render.
    p.stale = true;
    p.renderedScale = 0;
    p.textLayerDiv?.remove(); // absolute px positions don't rescale
    p.annotDiv?.remove();
    p.textLayerDiv = null;
    p.annotDiv = null;
    p.textReady = null;
    p.el.querySelectorAll('.searchHl').forEach((e) => e.remove());
    if (p.canvas) {
      const { cssW, cssH } = this.pageGeometry(p);
      p.canvas.style.width = `${cssW}px`;
      p.canvas.style.height = `${cssH}px`;
    }
  }

  // ----- smooth (visual) zoom: cheap CSS transform during the gesture,
  // crisp re-render on commit -----

  beginVisualZoom(): void {
    this.viewerEl.style.transformOrigin = '0 0';
    this.viewerEl.style.willChange = 'transform';
  }

  /** Scale the already-rendered content by k, keeping `anchor` stationary. */
  applyVisualZoom(k: number, anchor: { x: number; y: number }): void {
    const rect = this.container.getBoundingClientRect();
    const cx = this.container.scrollLeft + (anchor.x - rect.left);
    const cy = this.container.scrollTop + (anchor.y - rect.top);
    this.viewerEl.style.transform =
      `translate(${cx * (1 - k)}px, ${cy * (1 - k)}px) scale(${k})`;
  }

  commitVisualZoom(targetScale: number, anchor: { x: number; y: number }): void {
    this.viewerEl.style.transform = '';
    this.viewerEl.style.willChange = '';
    this.setScale(targetScale, { anchor });
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
