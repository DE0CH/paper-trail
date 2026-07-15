// Mid-gesture pinch state must not survive a document swap. Two leaks:
//  - Viewer.close() left the smooth-zoom CSS transform on #viewer, so the
//    NEW document rendered inside a leftover mid-gesture transform; and the
//    controller's 180ms pinch-commit timer kept running, committing the OLD
//    gesture's scale onto the NEW document (dropping its fit-width).
//  - The hover preview's 350ms show timer wasn't tied to the document
//    epoch, so a hover armed on the old document could open the popup over
//    the new one.
// Run: node build-node/test/pinchDocSwap.js   (server on 8377 first)

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
    controller: { openData(data: Uint8Array, name: string): Promise<void> };
    viewer: { scale: number; fitWidth: boolean };
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

    // --- leak 1: the CSS transform and the 180ms pinch-commit timer ---
    const res = await page.evaluate(async () => {
      const pt = (window as unknown as PtWin).__pt;
      const bytes = new Uint8Array(
        await (await fetch('sample/WStarCats.pdf')).arrayBuffer());
      const container = document.getElementById('viewerContainer')!;
      const viewerEl = document.getElementById('viewer')!;
      // Start a pinch (ctrl+wheel); its commit timer is now armed.
      for (let i = 0; i < 3; i++) {
        container.dispatchEvent(new WheelEvent('wheel', {
          ctrlKey: true, deltaY: -40, clientX: 700, clientY: 450,
          bubbles: true, cancelable: true,
        }));
      }
      const transformDuring = viewerEl.style.transform;
      // Swap the document while the gesture is mid-flight.
      await pt.controller.openData(bytes, 'copy.pdf');
      const transformAfterOpen = viewerEl.style.transform;
      const scaleAfterOpen = pt.viewer.scale;
      // Give the stale 180ms pinch timer every chance to fire.
      await new Promise((r) => setTimeout(r, 600));
      return {
        transformDuring,
        transformAfterOpen,
        willChangeAfter: viewerEl.style.willChange,
        scaleAfterOpen,
        scaleAfterTimer: pt.viewer.scale,
        transformAfterTimer: viewerEl.style.transform,
        fitAfterTimer: pt.viewer.fitWidth,
      };
    });
    check('the gesture applied a live transform (test premise)',
      /scale\(/.test(res.transformDuring), res.transformDuring);
    check('a document swap clears the mid-gesture transform',
      res.transformAfterOpen === '' && res.willChangeAfter === '',
      JSON.stringify({ t: res.transformAfterOpen, w: res.willChangeAfter }));
    check('the stale pinch timer does not commit onto the new document',
      res.scaleAfterTimer === res.scaleAfterOpen
        && res.fitAfterTimer === true
        && res.transformAfterTimer === '',
      JSON.stringify(res));

    // --- leak 2: an armed hover-preview timer across a swap ---
    await page.waitForSelector('.pdfLink', { timeout: 20_000 });
    const prev = await page.evaluate(async () => {
      const pt = (window as unknown as PtWin).__pt;
      const bytes = new Uint8Array(
        await (await fetch('sample/WStarCats.pdf')).arrayBuffer());
      const link = document.querySelector('.pdfLink') as HTMLElement;
      // Arms the 350ms preview timer…
      link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      const t0 = performance.now();
      // …and the document swaps before it fires.
      await pt.controller.openData(bytes, 'copy2.pdf');
      const openMs = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 900));
      pt.session.dirty = false;
      return {
        hidden: document.getElementById('preview')!.classList.contains('hidden'),
        openMs: Math.round(openMs),
      };
    });
    // If the swap outlasted the 350ms hover delay, the timer fired against
    // a half-open document and this leg proves less — surface the timing.
    check('an armed hover-preview timer does not open onto the swapped document',
      prev.hidden, `swap took ${prev.openMs}ms (hover delay is 350ms)`);
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
