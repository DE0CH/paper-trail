// A page whose render FAILS must not be retried from scroll traffic:
// updateVisible runs on every scroll animation frame, and an unconditional
// re-attempt turned one persistently failing page into a ~60-attempts/sec
// storm, each attempt allocating a full backing canvas. A failed page is
// left alone until a scale change (or document change) clears the failure
// — an explicit ensurePage() may still retry deliberately.
// Run: node build-node/test/renderRetryStorm.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

type PageRecLike = {
  rendered: boolean; stale: boolean; renderedScale: number;
  page: { render: (...args: unknown[]) => unknown };
};
type PtWin = Window & {
  __pt: {
    viewer: {
      setScale(s: number): void;
      scrollTo(p: { page: number; yRatio?: number }): void;
      pages: PageRecLike[];
    };
    session: { dirty: boolean };
  };
};

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 20_000 });
    await page.evaluate(() => {
      (window as unknown as PtWin).__pt.viewer.scrollTo({ page: 2, yRatio: 0 });
    });
    await page.waitForSelector('.page[data-page="2"] canvas', { timeout: 20_000 });

    const res = await page.evaluate(async () => {
      const pt = (window as unknown as PtWin).__pt;
      const v = pt.viewer;
      const rec = v.pages[1]; // page 2
      let attempts = 0;
      const orig = rec.page.render;
      rec.page.render = () => {
        attempts++;
        throw new Error('synthetic render failure');
      };
      const tick = () => new Promise((r) => setTimeout(r, 10));

      // Invalidate every page; page 2's render now fails persistently.
      v.setScale(1.05);
      await tick(); await tick();
      const afterScale = attempts;

      // 40 scroll updates over the failing page — each drives updateVisible.
      for (let i = 0; i < 40; i++) {
        v.scrollTo({ page: 2, yRatio: 0.001 * i });
        await tick();
      }
      const afterStorm = attempts;

      // A scale change is a deliberate fresh chance for a failed page.
      v.setScale(1.1);
      await tick(); await tick();
      const afterRetry = attempts;

      // Once rendering works again, the page must actually recover.
      rec.page.render = orig;
      v.setScale(1.15);
      let recovered = false;
      for (let i = 0; i < 400 && !recovered; i++) {
        await tick();
        recovered = rec.rendered && !rec.stale && rec.renderedScale === 1.15;
      }
      pt.session.dirty = false;
      return {
        afterScale,
        stormAttempts: afterStorm - afterScale,
        retriedOnScaleChange: afterRetry > afterStorm,
        recovered,
      };
    });

    check('a failing page is attempted at least once', res.afterScale >= 1,
      `${res.afterScale} attempts after the first scale change`);
    check('scroll traffic does not retry-storm a failed page',
      res.stormAttempts <= 3, `${res.stormAttempts} attempts across 40 scroll updates`);
    check('a scale change re-attempts the failed page', res.retriedOnScaleChange);
    check('the page recovers once rendering works again', res.recovered);
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
