// A large scale jump (Fit / zoom) must not leave a "ghost page": an old
// canvas floating in a shell that the windowing logic meant to tear down.
// setScale marks every page stale (keeping its canvas stretched as a
// smooth-zoom placeholder) and then calls updateVisible(), which destroys
// pages the new, taller layout pushed beyond DESTROY_MARGIN. When staleness
// was tracked by clobbering `rendered`, destroyPage's `if (!rendered) return`
// bailed on exactly those pages and their canvas stayed in the DOM — a stale
// bitmap stranded far off-screen. This drives that path deterministically:
// render a band of pages, then zoom in hard so the band lands beyond the
// destroy margin, and require that no destroyed page keeps a canvas while a
// visible page keeps its stretched placeholder (no white flash).
// Run: node build-node/test/ghostPageAfterFit.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

type PtViewer = {
  pages: Array<{ el: HTMLElement }>;
  setScale: (s: number, o?: unknown) => void;
  scrollTo: (p: { page: number; yRatio?: number }) => void;
};
type PtWin = Window & { __pt: { viewer: PtViewer; session: { dirty: boolean } } };

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 20_000 });

    // Zoom out and park in the middle of the document so a band of pages
    // both above and below the viewport renders (canvas mounted).
    await page.evaluate(() => {
      const v = (window as unknown as PtWin).__pt.viewer;
      v.setScale(0.5);
      v.scrollTo({ page: 20, yRatio: 0 });
    });
    // Wait until pages on BOTH sides of page 20 have a canvas.
    await page.waitForFunction(() =>
      !!document.querySelector('.page[data-page="18"] canvas') &&
      !!document.querySelector('.page[data-page="22"] canvas'),
      undefined, { timeout: 20_000 });

    const before: number[] = await page.evaluate(() => {
      const v = (window as unknown as PtWin).__pt.viewer;
      const out: number[] = [];
      v.pages.forEach((p, i) => { if (p.el.querySelector('canvas')) out.push(i + 1); });
      return out;
    });

    // A hard zoom-in: the rendered band is now many page-heights tall, so
    // the pages that flanked page 20 land far beyond DESTROY_MARGIN and must
    // be destroyed. No anchor -> the toolbar/keyboard zoom path.
    const after = await page.evaluate(() => {
      const v = (window as unknown as PtWin).__pt.viewer;
      v.setScale(5);
      const c = document.getElementById('viewerContainer')!;
      const DM = 3200; // DESTROY_MARGIN in viewer.ts
      const RM = 900;  // RENDER_MARGIN in viewer.ts
      const st = c.scrollTop;
      const ch = c.clientHeight;
      return v.pages.map((p, i) => {
        const el = p.el;
        const top = el.offsetTop;
        const bot = top + el.offsetHeight;
        return {
          page: i + 1,
          far: bot < st - DM || top > st + ch + DM,
          near: bot >= st - RM && top <= st + ch + RM,
          hasCanvas: !!el.querySelector('canvas'),
        };
      });
    });

    const farRendered = before.filter((pn) => after[pn - 1].far);
    const ghosts = farRendered.filter((pn) => after[pn - 1].hasCanvas);
    const placeholderVisible = after.some((x) => x.near && x.hasCanvas);

    check('the zoom pushed a rendered page beyond the destroy margin',
      farRendered.length >= 1, `farRendered=${JSON.stringify(farRendered)}`);
    check('no destroyed page keeps an orphaned canvas (no ghost page)',
      ghosts.length === 0, `ghosts=${JSON.stringify(ghosts)}`);
    check('a visible page keeps its stretched canvas (smooth zoom, no white flash)',
      placeholderVisible, JSON.stringify(after.filter((x) => x.near)));

    await page.evaluate(() => {
      (window as unknown as PtWin).__pt.session.dirty = false;
    });
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
