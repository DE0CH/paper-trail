// Scroll-smoothness profile — measures what perf.ts (history ops) and
// perfHot.ts (raw render/search costs) do not: how the main thread
// behaves WHILE the document scrolls. Two programmatic sweeps (a reading
// scroll and a fast fling) drive the real viewer on the generated
// 600-page PDF and record per-frame rAF deltas plus Long Tasks, then the
// time until the landing viewport is device-pixel-exact. A zoom-out
// probe measures the same for newly revealed pages. Only public DOM
// state is observed, so the numbers compare across branches/builds.
//
// Prereq: npm run build && node build-node/tools/perfBigPdf.js && npm start.
// Usage: node build-node/tools/perfScroll.js [baseUrl]

import { findBrowser } from '../test/browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface SweepStats {
  frames: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  pctOver33: number;
  longTasks: number;
  longTaskMs: number;
  crispAfterMs: number; // settle -> every viewport page device-pixel-exact
}

async function sweep(page: Page, stepPx: number, frames: number): Promise<SweepStats> {
  return page.evaluate(async (cfg) => {
    const container = document.getElementById('viewerContainer')!;
    const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
    const deltas: number[] = [];
    let longTasks = 0;
    let longTaskMs = 0;
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks++;
        longTaskMs += e.duration;
      }
    });
    po.observe({ entryTypes: ['longtask'] });

    let prev = await raf();
    for (let i = 0; i < cfg.frames; i++) {
      container.scrollTop += cfg.stepPx;
      const t = await raf();
      deltas.push(t - prev);
      prev = t;
    }
    const tSettle = performance.now();
    const crispAfterMs = await new Promise<number>((resolve) => {
      const deadline = performance.now() + 30_000;
      const dpr = window.devicePixelRatio || 1;
      const chk = (): void => {
        const st = container.scrollTop;
        const ch = container.clientHeight;
        const shells = [...document.querySelectorAll<HTMLElement>('.page')].filter(
          (el) => el.offsetTop < st + ch && el.offsetTop + el.offsetHeight > st,
        );
        const ok = shells.length > 0 && shells.every((el) => {
          const c = el.querySelector('canvas');
          return !!c && Math.abs(c.width / parseFloat(c.style.width) - dpr) < 0.001;
        });
        if (ok) resolve(performance.now() - tSettle);
        else if (performance.now() > deadline) resolve(-1);
        else setTimeout(chk, 16);
      };
      chk();
    });
    po.disconnect();

    const s = [...deltas].sort((a, b) => a - b);
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    return {
      frames: deltas.length,
      avgMs: avg,
      p50Ms: s[Math.floor(s.length * 0.5)],
      p95Ms: s[Math.floor(s.length * 0.95)],
      maxMs: s[s.length - 1],
      pctOver33: (deltas.filter((d) => d > 33).length / deltas.length) * 100,
      longTasks,
      longTaskMs,
      crispAfterMs,
    };
  }, { stepPx, frames });
}

function fmt(name: string, m: SweepStats): string {
  return [
    name.padEnd(22),
    `avg ${m.avgMs.toFixed(1)}ms`.padStart(11),
    `p50 ${m.p50Ms.toFixed(1)}ms`.padStart(11),
    `p95 ${m.p95Ms.toFixed(1)}ms`.padStart(11),
    `max ${m.maxMs.toFixed(1)}ms`.padStart(12),
    `>33ms ${m.pctOver33.toFixed(1)}%`.padStart(12),
    `longtasks ${m.longTasks} (${m.longTaskMs.toFixed(0)}ms)`.padStart(22),
    `crisp-after ${m.crispAfterMs.toFixed(0)}ms`.padStart(20),
  ].join('  ');
}

async function run(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/perf-big.pdf');
    await page.waitForSelector('.page canvas', { timeout: 90_000 });
    await page.waitForTimeout(1500); // let the initial window settle

    console.log('=== PAPER TRAIL SCROLL-SMOOTHNESS PROFILE ===');
    // Reading scroll: ~60px/frame. Fling: ~800px/frame across many pages.
    const read = await sweep(page, 60, 240);
    console.log(fmt('reading scroll', read));
    const fling = await sweep(page, 800, 180);
    console.log(fmt('fast fling', fling));

    // Zoom-out probe: from the deep landing position, zoom far out and
    // measure how long newly revealed viewport pages take to (a) show any
    // canvas at all and (b) all be device-pixel-exact.
    const zoom = await page.evaluate(async () => {
      interface ViewerLike { scale: number; setScale(s: number): void }
      const v = (window as never as { __pt: { viewer: ViewerLike } }).__pt.viewer;
      const container = document.getElementById('viewerContainer')!;
      const dpr = window.devicePixelRatio || 1;
      const t0 = performance.now();
      v.setScale(v.scale / 3);
      const viewportShells = (): HTMLElement[] => {
        const st = container.scrollTop;
        const ch = container.clientHeight;
        return [...document.querySelectorAll<HTMLElement>('.page')].filter(
          (el) => el.offsetTop < st + ch && el.offsetTop + el.offsetHeight > st,
        );
      };
      const waitFor = (pred: () => boolean): Promise<number> =>
        new Promise((resolve) => {
          const deadline = performance.now() + 60_000;
          const chk = (): void => {
            if (pred()) resolve(performance.now() - t0);
            else if (performance.now() > deadline) resolve(-1);
            else setTimeout(chk, 8);
          };
          chk();
        });
      const anyCanvasMs = await waitFor(() =>
        viewportShells().every((el) => !!el.querySelector('canvas')));
      const allCrispMs = await waitFor(() => viewportShells().every((el) => {
        const c = el.querySelector('canvas');
        return !!c && Math.abs(c.width / parseFloat(c.style.width) - dpr) < 0.001;
      }));
      return { anyCanvasMs, allCrispMs, pagesInViewport: viewportShells().length };
    });
    console.log(
      `zoom-out (scale/3)      viewport fully covered after ${zoom.anyCanvasMs.toFixed(0)}ms;`
      + ` all crisp after ${zoom.allCrispMs.toFixed(0)}ms`
      + ` (${zoom.pagesInViewport} pages in viewport)`,
    );
    await page.close();
  } finally {
    await browser.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
