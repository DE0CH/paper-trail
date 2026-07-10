// Hover preview: after a short delay over an internal link, show a popup
// with a rendered snapshot of the destination region (sioyek-style), so
// short references don't require a jump at all.

const PREVIEW_W = 480;
const PREVIEW_H = 300;
const HOVER_DELAY_MS = 350;
const CACHE_PAGES = 6;

export class Preview {
  constructor(viewer, el) {
    this.viewer = viewer;
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.pageLabel = el.querySelector('.previewPage');
    this.cache = new Map(); // pageNumber -> offscreen canvas
    this.timer = 0;
    this.token = 0;
  }

  scheduleShow(dest, linkEl) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this._show(dest, linkEl).catch((e) => console.warn('preview failed', e));
    }, HOVER_DELAY_MS);
  }

  cancel() {
    clearTimeout(this.timer);
    this.hide();
  }

  hide() {
    this.token++;
    this.el.classList.add('hidden');
  }

  clear() {
    this.cache.clear();
    this.cancel();
  }

  async _show(dest, linkEl) {
    const token = ++this.token;
    const info = await this.viewer.resolveDest(dest);
    if (!info || token !== this.token) return;
    const src = await this._pageCanvas(info.page);
    if (!src || token !== this.token || !linkEl.isConnected) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = PREVIEW_W * dpr;
    this.canvas.height = PREVIEW_H * dpr;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Fit the page width into the preview, crop vertically around the target.
    const fit = this.canvas.width / src.width;
    const cropH = this.canvas.height / fit;
    let srcY = info.yRatio * src.height - 24 / fit;
    srcY = Math.max(0, Math.min(Math.max(0, src.height - cropH), srcY));
    ctx.drawImage(src, 0, srcY, src.width, cropH, 0, 0, this.canvas.width, this.canvas.height);
    this.pageLabel.textContent = 'p. ' + info.page;

    // Position near the link, staying inside the viewport.
    const lr = linkEl.getBoundingClientRect();
    let x = Math.max(8, Math.min(lr.left, window.innerWidth - PREVIEW_W - 12));
    let y = lr.bottom + 10;
    if (y + PREVIEW_H > window.innerHeight - 8) y = lr.top - PREVIEW_H - 10;
    if (y < 8) y = 8;
    this.el.style.left = x + 'px';
    this.el.style.top = y + 'px';
    this.el.classList.remove('hidden');
  }

  async _pageCanvas(pageNumber) {
    const cached = this.cache.get(pageNumber);
    if (cached) return cached;
    const rec = this.viewer.pages[pageNumber - 1];
    if (!rec) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = rec.page.getViewport({ scale: 1.3 * dpr });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await rec.page.render({
      canvasContext: c.getContext('2d', { alpha: false }),
      viewport: vp,
    }).promise;
    this.cache.set(pageNumber, c);
    if (this.cache.size > CACHE_PAGES) {
      this.cache.delete(this.cache.keys().next().value);
    }
    return c;
  }
}
