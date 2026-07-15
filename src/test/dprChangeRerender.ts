// Moving the window between displays with different devicePixelRatio
// (1x <-> 2x) must re-render the already-rendered pages at the new
// density. Without a dpr listener they stayed at the old density forever
// (rendered && renderedScale === scale, so nothing invalidated them):
// permanently soft on the sharper display, and their shells — sized with
// the old dpr — drifted sub-pixel from freshly rendered neighbors.
// The dpr change is driven through CDP display emulation. When the
// environment re-evaluates `resolution` media queries under emulation the
// viewer's listener is exercised end-to-end; headless builds that update
// window.devicePixelRatio WITHOUT re-evaluating media queries cannot
// deliver that OS-level signal, so the test says so and drives the
// viewer's public refresh hook directly instead — proving the refresh
// path (stale + reshell + re-render), not the listener wiring.
// Run: node build-node/test/dprChangeRerender.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
      deviceScaleFactor: 1,
    });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 20_000 });

    // Baseline: the page rendered 1x-exact.
    const base = await page.evaluate(() => {
      const c = document.querySelector('.page[data-page="1"] canvas') as HTMLCanvasElement;
      return { ratio: c.width / parseFloat(c.style.width), dpr: window.devicePixelRatio };
    });
    check('baseline renders at devicePixelRatio 1 (test premise)',
      base.dpr === 1 && Math.abs(base.ratio - 1) < 1e-9, JSON.stringify(base));

    // Move the window to a "2x display" via real display emulation.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1200, height: 800, deviceScaleFactor: 2, mobile: false,
    });
    const dprChanged = await page.waitForFunction(
      () => window.devicePixelRatio === 2, undefined, { timeout: 5_000 },
    ).then(() => true).catch(() => false);
    check('emulation raises devicePixelRatio to 2 (test premise)', dprChanged);

    // Does this environment re-evaluate `resolution` media queries under
    // emulation? Real display moves do; if it does not, the listener's
    // signal never arrives here and the refresh hook is driven directly.
    const mqFollows = await page.evaluate(
      () => window.matchMedia('(resolution: 2dppx)').matches);
    let path = 'media-query listener (end-to-end)';
    if (!mqFollows) {
      path = 'refreshForDprChange() driven directly — this environment does '
        + 'not re-evaluate resolution media queries under emulation, so the '
        + 'listener wiring itself is not exercised here';
      console.log(`NOTE  ${path}`);
      await page.evaluate(() => {
        (window as unknown as (Window & { __pt: { viewer: { refreshForDprChange(): void } } }))
          .__pt.viewer.refreshForDprChange();
      });
    }

    // The already-rendered page must become 2x-exact without any other
    // action (no scroll, no zoom).
    const rerendered = await page.waitForFunction(() => {
      const c = document.querySelector('.page[data-page="1"] canvas') as HTMLCanvasElement | null;
      return !!c && Math.abs(c.width / parseFloat(c.style.width)
        - window.devicePixelRatio) < 1e-9 && window.devicePixelRatio === 2;
    }, undefined, { timeout: 15_000 }).then(() => true).catch(() => false);
    check('already-rendered pages re-render at the new devicePixelRatio',
      rerendered, `via ${path}`);

    // The shell was re-sized with the new dpr too, so its CSS box agrees
    // with the canvas (a mismatch shows as a hairline sliver).
    const drift = await page.evaluate(() => {
      const shell = document.querySelector('.page[data-page="1"]') as HTMLElement;
      const c = shell.querySelector('canvas') as HTMLCanvasElement;
      return Math.abs(shell.getBoundingClientRect().width - c.getBoundingClientRect().width);
    });
    check('page shell and canvas CSS widths agree after the dpr change',
      drift < 0.1, `drift ${drift}px`);

    await page.evaluate(() => {
      (window as unknown as (Window & { __pt: { session: { dirty: boolean } } })).__pt
        .session.dirty = false;
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
