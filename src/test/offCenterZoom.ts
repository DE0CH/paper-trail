// A no-anchor zoom (the toolbar buttons and keyboard shortcuts) must keep
// the page horizontally centered when it crosses the fit-width boundary.
// setScale restores the vertical position but, in the no-anchor branch, left
// the horizontal offset to the CSS `margin: 0 auto`. While the page is
// narrower than the viewport that margin centers it; the moment a zoom step
// makes it WIDER, the margin collapses to 0, scrollLeft is still 0, and the
// page snaps hard to the left with blank space on the right. This drives the
// real controller.zoomIn() path across that boundary and requires the page's
// horizontal center to stay on the viewport's center.
// Run: node build-node/test/offCenterZoom.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

type PtWin = Window & {
  __pt: {
    controller: { fitWidth: () => void; zoomIn: () => void };
    session: { dirty: boolean };
  };
};

function measure() {
  const c = document.getElementById('viewerContainer')!;
  const el = document.querySelector('.page[data-page="1"]') as HTMLElement;
  const pr = el.getBoundingClientRect();
  const cr = c.getBoundingClientRect();
  const pageCenter = (pr.left + pr.right) / 2;
  const contCenter = (cr.left + cr.right) / 2;
  return {
    dev: Math.abs(pageCenter - contCenter),
    pageW: pr.width,
    contW: cr.width,
    scrollLeft: c.scrollLeft,
  };
}

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 20_000 });

    // Fit width leaves the page just NARROWER than the viewport: centered.
    await page.evaluate(() => (window as unknown as PtWin).__pt.controller.fitWidth());
    await page.waitForTimeout(150);
    const before = await page.evaluate(measure);
    check('fit-width starts the page narrower than the viewport',
      before.pageW < before.contW, JSON.stringify(before));
    check('fit-width leaves the page horizontally centered',
      before.dev <= 2, JSON.stringify(before));

    // One toolbar/keyboard zoom step crosses the boundary (page becomes wider
    // than the viewport). The center must not jump to the left edge.
    await page.evaluate(() => (window as unknown as PtWin).__pt.controller.zoomIn());
    await page.waitForTimeout(150);
    const after = await page.evaluate(measure);
    check('the zoom step crossed the fit-width boundary (page now wider)',
      after.pageW > after.contW, JSON.stringify(after));
    check('the page stays horizontally centered after crossing the boundary',
      after.dev <= 3, JSON.stringify(after));

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
