// Smooth progressive rendering for scroll and zoom-out: a page entering
// the render window starts as a blank shell, paints a fast low-resolution
// pass (a small canvas CSS-stretched over the page box, data-res="low"),
// and is upgraded ATOMICALLY to the device-pixel-exact render
// (data-res="full") — while already-crisp pages move by compositing only:
// scrolling never re-renders or re-creates their canvases. The viewer's
// renderLog (window.__pt.viewer.renderLog) records every canvas mount, so
// the low-before-full ordering is observable deterministically.
// Run: node build-node/test/smoothScroll.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface PageRecLike {
  rendered: boolean;
  stale: boolean;
  renderedScale: number;
  el: HTMLElement;
  canvas: HTMLCanvasElement | null;
}
type PtWin = Window & {
  __pt: {
    viewer: {
      pages: PageRecLike[];
      scale: number;
      setScale(s: number): void;
      currentPosition(): { page: number; yRatio: number };
      renderLog: { page: number; res: 'low' | 'full' }[];
    };
    session: { dirty: boolean };
  };
};

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => check('no page errors', false, String(e)));
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');

    // The visible page must settle to a crisp, marked, full-res canvas.
    await page.waitForSelector('.page[data-page="1"] canvas[data-res="full"]',
      { timeout: 20_000 });
    await page.waitForSelector('.page[data-page="1"] .textLayer span', { timeout: 20_000 });
    check('the visible page settles to a full-resolution canvas (data-res marker)', true);

    // Let the initial low-res prefetch of nearby pages finish, then tag
    // page 1's canvas so node identity survives round trips to the page.
    await page.waitForTimeout(1200);
    const before = await page.evaluate(() => {
      const pt = (window as unknown as PtWin).__pt;
      const c = document.querySelector('.page[data-page="1"] canvas') as HTMLCanvasElement;
      (c as unknown as { __probeTag?: string }).__probeTag = 'page1';
      pt.viewer.renderLog.length = 0;
      return { renderedScale: pt.viewer.pages[0].renderedScale, scale: pt.viewer.scale };
    });

    // --- (c) scrolling must not touch an already-crisp page: same canvas
    // node, same renderedScale, no new render logged for it ---
    await page.evaluate(async () => {
      const container = document.getElementById('viewerContainer')!;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < 10; i++) {
        container.scrollTop += 50; // page 1 stays well inside the window
        await raf();
      }
    });
    await page.waitForTimeout(900); // past the scroll settle
    const still = await page.evaluate(() => {
      const pt = (window as unknown as PtWin).__pt;
      const c = document.querySelector('.page[data-page="1"] canvas') as HTMLCanvasElement;
      return {
        sameNode: (c as unknown as { __probeTag?: string }).__probeTag === 'page1',
        res: c.dataset.res,
        renderedScale: pt.viewer.pages[0].renderedScale,
        page1Renders: pt.viewer.renderLog.filter((e) => e.page === 1).length,
      };
    });
    check('scrolling keeps a crisp page\'s canvas: same node, same scale, no re-render',
      still.sameNode && still.res === 'full'
        && still.renderedScale === before.renderedScale && still.page1Renders === 0,
      JSON.stringify(still));

    // --- (a)+(b)+(d) far scroll: a fresh page paints low-res first, then
    // upgrades to a device-pixel-exact full render with no canvasless gap ---
    const target = await page.evaluate(() => {
      const pt = (window as unknown as PtWin).__pt;
      const t = pt.viewer.currentPosition().page + 12;
      const rec = pt.viewer.pages[t - 1];
      const w = window as unknown as PtWin & {
        __ssObs?: { flash: boolean; low: { backing: number; css: number; dpr: number } | null };
      };
      // Watch the target shell: after it first gains a canvas it must
      // never be seen without one (the swap is replaceChildren-atomic).
      // Also capture the transient low-res canvas's geometry as it mounts.
      w.__ssObs = { flash: false, low: null };
      let had = false;
      const mo = new MutationObserver(() => {
        const c = rec.el.querySelector('canvas') as HTMLCanvasElement | null;
        if (c && c.dataset.res === 'low' && !w.__ssObs!.low) {
          w.__ssObs!.low = {
            backing: c.width,
            css: parseFloat(c.style.width),
            dpr: window.devicePixelRatio,
          };
        }
        if (had && !c) w.__ssObs!.flash = true;
        if (c) had = true;
      });
      mo.observe(rec.el, { childList: true, subtree: true });
      pt.viewer.renderLog.length = 0;
      return { page: t, wasBlank: !rec.rendered && !rec.canvas };
    });
    check('the far target page starts as a blank shell (test premise)',
      target.wasBlank, `page ${target.page}`);

    await page.evaluate(async (t) => {
      const pt = (window as unknown as PtWin).__pt;
      const container = document.getElementById('viewerContainer')!;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      const from = container.scrollTop;
      const to = pt.viewer.pages[t - 1].el.offsetTop - 8;
      const STEPS = 45; // ~16ms apart: continuously "scrolling" (< settle)
      for (let i = 1; i <= STEPS; i++) {
        container.scrollTop = from + ((to - from) * i) / STEPS;
        await raf();
      }
    }, target.page);

    const crisp = await page.waitForFunction((t) => {
      const pt = (window as unknown as PtWin).__pt;
      const rec = pt.viewer.pages[t - 1];
      const c = rec.el.querySelector('canvas') as HTMLCanvasElement | null;
      return !!c && c.dataset.res === 'full' && !rec.stale
        && Math.abs(c.width / parseFloat(c.style.width) - window.devicePixelRatio) < 0.001;
    }, target.page, { timeout: 20_000 }).then(() => true).catch(() => false);
    check('after settling, the entered page is device-pixel-exact full-res', crisp);

    const farRes = await page.evaluate((t) => {
      const pt = (window as unknown as PtWin).__pt;
      const w = window as unknown as PtWin & {
        __ssObs?: { flash: boolean; low: { backing: number; css: number; dpr: number } | null };
      };
      const log = pt.viewer.renderLog;
      const lowIdx = log.findIndex((e) => e.page === t && e.res === 'low');
      const fullIdx = log.findIndex((e) => e.page === t && e.res === 'full');
      return { lowIdx, fullIdx, obs: w.__ssObs };
    }, target.page);
    check('a page entering the window paints a low-res pass before the full render',
      farRes.lowIdx >= 0 && farRes.fullIdx > farRes.lowIdx,
      JSON.stringify({ lowIdx: farRes.lowIdx, fullIdx: farRes.fullIdx }));
    check('the transient low-res canvas is a cheap CSS-stretched bitmap',
      !!farRes.obs?.low
        && farRes.obs.low.backing < farRes.obs.low.css * farRes.obs.low.dpr * 0.75,
      JSON.stringify(farRes.obs?.low));
    check('the low-to-full swap is atomic: the page never flashes canvasless',
      farRes.obs?.flash === false);

    // --- zoom-out: newly revealed pages (blank before the zoom) also go
    // low-res first, then crisp; nothing flashes canvasless ---
    const zoomPrep = await page.evaluate(() => {
      const pt = (window as unknown as PtWin).__pt;
      const w = window as unknown as PtWin & { __zoFlash?: boolean };
      const blankBefore = pt.viewer.pages
        .map((p, i) => ({ p, n: i + 1 }))
        .filter((x) => !x.p.rendered && !x.p.canvas)
        .map((x) => x.n);
      // One observer over all shells: once a shell has a canvas it must
      // never be observed without one again during the zoom.
      w.__zoFlash = false;
      const had = new Set<number>();
      const shells = pt.viewer.pages.map((p) => p.el);
      const mo = new MutationObserver(() => {
        shells.forEach((el, i) => {
          const has = !!el.querySelector('canvas');
          if (had.has(i) && !has) w.__zoFlash = true;
          if (has) had.add(i);
        });
      });
      mo.observe(document.getElementById('viewer') ?? shells[0].parentElement!,
        { childList: true, subtree: true });
      pt.viewer.renderLog.length = 0;
      pt.viewer.setScale(pt.viewer.scale / 3); // deep zoom-out reveals new pages
      return { blankBefore, scale: pt.viewer.scale };
    });

    const zoomSettled = await page.waitForFunction((blank) => {
      const pt = (window as unknown as PtWin).__pt;
      const container = document.getElementById('viewerContainer')!;
      const st = container.scrollTop;
      const ch = container.clientHeight;
      const viewportCrisp = pt.viewer.pages
        .filter((p) => p.el.offsetTop < st + ch && p.el.offsetTop + p.el.offsetHeight > st)
        .every((p) => {
          const c = p.el.querySelector('canvas') as HTMLCanvasElement | null;
          return !!c && c.dataset.res === 'full'
            && Math.abs(c.width / parseFloat(c.style.width) - window.devicePixelRatio) < 0.001;
        });
      const revealed = pt.viewer.renderLog.some((e) => blank.includes(e.page) && e.res === 'full');
      return viewportCrisp && revealed;
    }, zoomPrep.blankBefore, { timeout: 30_000 }).then(() => true).catch(() => false);
    check('zoom-out settles: every viewport page crisp, formerly-blank pages rendered',
      zoomSettled, JSON.stringify({ scale: zoomPrep.scale }));

    const zoomRes = await page.evaluate((blank) => {
      const pt = (window as unknown as PtWin).__pt;
      const w = window as unknown as PtWin & { __zoFlash?: boolean };
      const log = pt.viewer.renderLog;
      const revealedFull = blank.filter((n) =>
        log.some((e) => e.page === n && e.res === 'full'));
      const lowFirst = revealedFull.filter((n) =>
        log.findIndex((e) => e.page === n && e.res === 'low') >= 0
        && log.findIndex((e) => e.page === n && e.res === 'low')
          < log.findIndex((e) => e.page === n && e.res === 'full'));
      pt.session.dirty = false;
      return { revealedFull, lowFirst, flash: w.__zoFlash };
    }, zoomPrep.blankBefore);
    check('zoom-out reveals blank pages through the low-res pass first',
      zoomRes.revealedFull.length >= 1
        && zoomRes.lowFirst.length === zoomRes.revealedFull.length,
      JSON.stringify(zoomRes));
    check('no page flashes canvasless during the zoom-out', zoomRes.flash === false);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
