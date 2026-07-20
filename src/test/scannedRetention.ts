// Evicting a page must release pdf.js's decoded-image cache. A scanned
// page retains ~35MB of decoded RGBA in PDFPageProxy.objs; before
// destroyPage called page.cleanup(), a cover-to-cover read of the 52-page
// scanned fixture held ~1.7GB across every visited page (measured in
// scannedBlank.ts's evidence line). This pins the release: after the full
// read, total retained decoded-image data must be bounded by the render
// window, not the document — and a revisit must still re-decode fine.
// Run: node build-node/test/scannedRetention.js   (server on 8377 first)

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
  el: HTMLElement;
  stale: boolean;
  page: { objs: Iterable<[string, { dataLen?: number } | null]> };
}
type PtWin = Window & { __pt: { viewer: { pages: PageRecLike[] } } };

async function run(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
      deviceScaleFactor: 2,
    });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/scanned.pdf');
    await page.waitForSelector('.page canvas', { timeout: 30_000 });

    // Read the document cover to cover, letting each stop settle enough
    // for the crisp pass (same pacing as scannedBlank's sweep).
    const total = await page.evaluate(() => (window as unknown as PtWin).__pt.viewer.pages.length);
    for (let i = 0; i < total; i += 1) {
      await page.evaluate((idx) => {
        const pt = (window as unknown as PtWin).__pt;
        pt.viewer.pages[idx].el.scrollIntoView();
      }, i);
      await page.waitForTimeout(350);
    }
    await page.waitForTimeout(2000); // final settle + eviction

    const retention = await page.evaluate(() => {
      const pt = (window as unknown as PtWin).__pt;
      const perPage = pt.viewer.pages.map((p) => {
        let bytes = 0;
        for (const [, data] of p.page.objs) bytes += data?.dataLen ?? 0;
        return bytes;
      });
      return {
        totalMB: Math.round(perPage.reduce((s, b) => s + b, 0) / 1048576),
        retainedPages: perPage.filter((b) => b > 1048576).length,
        pages: perPage.length,
      };
    });
    // Window-bounded: visible + margin pages a few tens of MB each. The
    // bug held ~35MB x every visited page (~1.7GB for 52). 400MB gives
    // slack for the render window plus pdf.js's own transients while
    // failing the unbounded case by a factor of four.
    check('decoded-image retention is window-bounded after a full read',
      retention.totalMB < 400,
      `${retention.totalMB}MB across ${retention.retainedPages}/${retention.pages} pages`);

    // Cleanup must not poison revisits: page 1 was evicted and cleaned
    // long ago; going back re-decodes and re-renders it crisp.
    await page.evaluate(() => {
      const pt = (window as unknown as PtWin).__pt;
      pt.viewer.pages[0].el.scrollIntoView();
    });
    const backCrisp = await page.waitForFunction(() => {
      const rec = (window as unknown as PtWin).__pt.viewer.pages[0];
      const c = rec.el.querySelector('canvas') as HTMLCanvasElement | null;
      return !!c && c.dataset.res === 'full' && !rec.stale;
    }, undefined, { timeout: 30_000 }).then(() => true).catch(() => false);
    check('an evicted-and-cleaned page re-renders crisp on revisit', backCrisp);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `${failed.length} FAILED` : 'ALL PASS');
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
