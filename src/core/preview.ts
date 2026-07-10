// Hover preview: after a short delay over an internal link, show a popup
// with the destination rendered at full page width, horizontally aligned
// with the PDF itself. Moving the cursor into the popup keeps it open and
// lets you scroll (the destination page and the following one are
// rendered); the bottom edge is draggable to resize the popup height.

import { loadUI, saveUI } from './store';
import type { Viewer } from './viewer';

const HOVER_DELAY_MS = 350;
const HIDE_DELAY_MS = 250;
const CACHE_PAGES = 4;
const MIN_H = 160;
const DEFAULT_H_RATIO = 0.45;

export class Preview {
  private viewer: Viewer;
  private el: HTMLElement;
  private scroller: HTMLElement;
  private content: HTMLElement;
  private pageLabel: HTMLElement;
  private cache = new Map<string, HTMLCanvasElement>();
  private showTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private hideTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private token = 0;
  private height: number;

  constructor(viewer: Viewer, el: HTMLElement) {
    this.viewer = viewer;
    this.el = el;
    this.scroller = el.querySelector('.previewScroll')!;
    this.content = el.querySelector('.previewContent')!;
    this.pageLabel = el.querySelector('.previewPage')!;
    this.height = loadUI().previewH ?? Math.round(window.innerHeight * DEFAULT_H_RATIO);

    // Moving into the popup keeps it open.
    el.addEventListener('mouseenter', () => clearTimeout(this.hideTimer));
    el.addEventListener('mouseleave', () => this.scheduleHide());

    // Bottom edge drag-to-resize.
    const handle = el.querySelector<HTMLElement>('.previewResize')!;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = this.el.getBoundingClientRect().height;
      const move = (ev: PointerEvent) => {
        this.height = Math.min(
          Math.max(startH + ev.clientY - startY, MIN_H),
          window.innerHeight - 40,
        );
        this.el.style.height = `${this.height}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        saveUI({ previewH: Math.round(this.height) });
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  scheduleShow(dest: string | unknown[], linkEl: HTMLElement): void {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    this.showTimer = setTimeout(() => {
      this.show(dest, linkEl).catch((e) => console.warn('preview failed', e));
    }, HOVER_DELAY_MS);
  }

  /** Called when the pointer leaves the link; entering the popup cancels it. */
  scheduleHide(): void {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), HIDE_DELAY_MS);
  }

  hide(): void {
    this.token++;
    clearTimeout(this.showTimer);
    this.el.classList.add('hidden');
  }

  clear(): void {
    this.cache.clear();
    this.hide();
  }

  private async show(dest: string | unknown[], linkEl: HTMLElement): Promise<void> {
    const token = ++this.token;
    const info = await this.viewer.resolveDest(dest);
    if (!info || token !== this.token) return;

    // Render the destination page and the next one at the viewer's scale,
    // so the preview matches the PDF exactly.
    const canvases: HTMLCanvasElement[] = [];
    const first = await this.pageCanvas(info.page);
    if (!first) return;
    canvases.push(first);
    const second = await this.pageCanvas(info.page + 1);
    if (second) canvases.push(second);
    if (token !== this.token || !linkEl.isConnected) return;

    this.content.replaceChildren(...canvases.map((c) => {
      // Cached canvases may be shown repeatedly; clone the node cheaply via
      // a wrapper so scroll layouts don't fight (canvas bitmaps are shared).
      const holder = document.createElement('div');
      holder.className = 'previewPageHolder';
      holder.appendChild(c);
      return holder;
    }));
    this.pageLabel.textContent = `p. ${info.page}`;

    // Horizontal alignment: match the PDF page column of the main viewer.
    const anchorPage = this.viewer.pages[this.viewer.currentPosition().page - 1]
      ?? this.viewer.pages[0];
    const pageRect = anchorPage.el.getBoundingClientRect();
    const width = pageRect.width;
    const left = pageRect.left;

    // Vertical placement: below the link if there is room, else above.
    const lr = linkEl.getBoundingClientRect();
    const h = Math.min(this.height, window.innerHeight - 40);
    let top = lr.bottom + 10;
    if (top + h > window.innerHeight - 8) top = lr.top - h - 10;
    if (top < 8) top = 8;

    this.el.style.left = `${left}px`;
    this.el.style.width = `${width}px`;
    this.el.style.top = `${top}px`;
    this.el.style.height = `${h}px`;
    this.el.classList.remove('hidden');

    // Scroll the destination point near the top of the popup.
    const pageH = first.getBoundingClientRect().height || first.clientHeight || 1;
    this.scroller.scrollTop = Math.max(0, info.yRatio * pageH - 16);
  }

  private async pageCanvas(pageNumber: number): Promise<HTMLCanvasElement | null> {
    const rec = this.viewer.pages[pageNumber - 1];
    if (!rec) return null;
    const scale = this.viewer.scale;
    const key = `${pageNumber}@${scale.toFixed(3)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = rec.page.getViewport({ scale: scale * dpr });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    c.style.width = '100%';
    c.style.display = 'block';
    await rec.page.render({
      canvas: c,
      canvasContext: c.getContext('2d', { alpha: false })!,
      viewport: vp,
    }).promise;
    this.cache.set(key, c);
    if (this.cache.size > CACHE_PAGES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return c;
  }
}
