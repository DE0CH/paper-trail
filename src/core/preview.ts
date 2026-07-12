// Hover preview: after a short delay over an internal link, show a popup
// with the destination rendered at full page width, horizontally aligned
// with the PDF itself. Moving the cursor into the popup keeps it open and
// lets you scroll through the ENTIRE document (pages render lazily and are
// dropped again when scrolled far away); the bottom edge is draggable to
// resize the popup height.

import { loadUI, saveUI } from './store';
import type { Viewer } from './viewer';

const HOVER_DELAY_MS = 350;
const HIDE_DELAY_MS = 250;
const MIN_H = 160;
const DEFAULT_H_RATIO = 0.45;

export class Preview {
  private viewer: Viewer;
  private el: HTMLElement;
  private scroller: HTMLElement;
  private content: HTMLElement;
  private pageLabel: HTMLElement;
  private showTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private hideTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private token = 0;
  private height: number;
  private built = ''; // fingerprint of the holder set currently in the DOM
  private observer: IntersectionObserver | null = null;

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

    // Keep the page label current while scrolling through the document.
    this.scroller.addEventListener('scroll', () => this.updateLabel());

    // Both horizontal edges drag to resize: the bottom edge moves the
    // bottom, the top edge moves the top (the opposite edge stays put).
    const wireResize = (sel: string, top: boolean) => {
      const handle = el.querySelector<HTMLElement>(sel)!;
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const startY = e.clientY;
        const rect = this.el.getBoundingClientRect();
        const move = (ev: PointerEvent) => {
          const dy = ev.clientY - startY;
          if (top) {
            const newTop = Math.min(Math.max(rect.top + dy, 8), rect.bottom - MIN_H);
            this.height = rect.bottom - newTop;
            this.el.style.top = `${newTop}px`;
          } else {
            this.height = Math.min(
              Math.max(rect.height + dy, MIN_H),
              window.innerHeight - 40,
            );
          }
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
    };
    wireResize('.previewResize', false);
    wireResize('.previewResizeTop', true);
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
    this.observer?.disconnect();
    this.observer = null;
    this.built = '';
    this.content.replaceChildren();
    this.hide();
  }

  // ---- geometry (mirrors the viewer's device-pixel-exact math: the CSS box
  // must equal backing / dpr, or the bitmap resamples and goes soft) ----

  private pageDpr(vp1w: number, vp1h: number): number {
    let dpr = window.devicePixelRatio || 1;
    const w = vp1w * this.viewer.scale;
    const h = vp1h * this.viewer.scale;
    while (w * dpr * h * dpr > 64_000_000 && dpr > 0.5) dpr *= 0.8;
    return dpr;
  }

  private exactCss(vp1w: number, vp1h: number) {
    const dpr = this.pageDpr(vp1w, vp1h);
    const backingW = Math.round(vp1w * this.viewer.scale * dpr);
    const backingH = Math.round(vp1h * this.viewer.scale * dpr);
    return { dpr, backingW, backingH, cssW: backingW / dpr, cssH: backingH / dpr };
  }

  /** (Re)create one holder per page of the document, rendered lazily. */
  private ensureBuilt(): void {
    const key = `${this.viewer.pages.length}@${this.viewer.scale.toFixed(4)}`;
    if (this.built === key) return;
    this.built = key;
    this.observer?.disconnect();

    const holders = this.viewer.pages.map((rec, i) => {
      const holder = document.createElement('div');
      holder.className = 'previewPageHolder';
      holder.dataset.previewPage = String(i + 1);
      const { cssW, cssH } = this.exactCss(rec.vp1.width, rec.vp1.height);
      holder.style.width = `${cssW}px`;
      holder.style.height = `${cssH}px`;
      return holder;
    });
    this.content.replaceChildren(...holders);

    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const holder = en.target as HTMLElement;
        if (en.isIntersecting && !holder.dataset.rendered) {
          holder.dataset.rendered = '1';
          void this.renderInto(holder, Number(holder.dataset.previewPage));
        } else if (!en.isIntersecting && holder.dataset.rendered) {
          // Windowing: drop far-away canvases so a long browse through the
          // preview doesn't retain every page bitmap.
          delete holder.dataset.rendered;
          holder.replaceChildren();
        }
      }
    }, { root: this.scroller, rootMargin: '600px' });
    holders.forEach((h) => this.observer!.observe(h));
  }

  private async renderInto(holder: HTMLElement, pageNumber: number): Promise<void> {
    const rec = this.viewer.pages[pageNumber - 1];
    if (!rec) return;
    const { dpr, backingW, backingH, cssW, cssH } = this.exactCss(rec.vp1.width, rec.vp1.height);
    const vp = rec.page.getViewport({ scale: this.viewer.scale * dpr });
    const c = document.createElement('canvas');
    c.width = backingW;
    c.height = backingH;
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
    c.style.display = 'block';
    try {
      await rec.page.render({
        canvas: c,
        canvasContext: c.getContext('2d', { alpha: false })!,
        viewport: vp,
      }).promise;
    } catch {
      delete holder.dataset.rendered; // retry when it scrolls back in
      return;
    }
    if (holder.dataset.rendered) holder.replaceChildren(c);
  }

  private updateLabel(): void {
    const holders = this.content.children;
    if (!holders.length) return;
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 3;
    for (const h of holders) {
      const el = h as HTMLElement;
      if (el.offsetTop + el.offsetHeight >= mid) {
        this.pageLabel.textContent = `p. ${el.dataset.previewPage}`;
        return;
      }
    }
  }

  private async show(dest: string | unknown[], linkEl: HTMLElement): Promise<void> {
    const token = ++this.token;
    const info = await this.viewer.resolveDest(dest);
    if (!info || token !== this.token || !linkEl.isConnected) return;

    this.ensureBuilt();

    // Horizontal alignment: match the PDF page column of the main viewer.
    const anchorPage = this.viewer.pages[this.viewer.currentPosition().page - 1]
      ?? this.viewer.pages[0];
    const pageRect = anchorPage.el.getBoundingClientRect();

    // Vertical placement: below the link if there is room, else above.
    // The popup must NEVER cover the link itself (it would swallow the
    // hover and block the click), so when the remembered height fits on
    // neither side — e.g. after the window shrank — it is capped to the
    // larger free side instead of overlaying.
    const lr = linkEl.getBoundingClientRect();
    const spaceBelow = window.innerHeight - 8 - (lr.bottom + 10);
    const spaceAbove = lr.top - 10 - 8;
    let h = Math.min(this.height, window.innerHeight - 40);
    let top;
    if (h <= spaceBelow) {
      top = lr.bottom + 10;
    } else if (h <= spaceAbove) {
      top = lr.top - h - 10;
    } else if (spaceBelow >= spaceAbove) {
      h = Math.max(spaceBelow, 80);
      top = lr.bottom + 10;
    } else {
      h = Math.max(spaceAbove, 80);
      top = lr.top - h - 10;
    }

    this.el.style.left = `${pageRect.left}px`;
    this.el.style.width = `${pageRect.width}px`;
    this.el.style.top = `${top}px`;
    this.el.style.height = `${h}px`;
    this.el.classList.remove('hidden');

    // Scroll the destination point near the top of the popup.
    const holder = this.content.children[info.page - 1] as HTMLElement | undefined;
    if (holder) {
      this.scroller.scrollTop = Math.max(0, holder.offsetTop + info.yRatio * holder.offsetHeight - 16);
    }
    this.pageLabel.textContent = `p. ${info.page}`;
  }
}
