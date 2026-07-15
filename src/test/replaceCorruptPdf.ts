// Regression: openData swallowed an open FAILURE after the old document was
// already torn down (viewer.open closes the current doc before parsing), so
// replaceWithFile carried on as if the swap had worked — adoptCurrentPdf
// marked the session dirty and wrote it with pos page 1/yRatio 0 (there are
// no pages), overwriting the real reading position on disk, then toasted
// "PDF replaced" over a blank window. A failed replace must leave the
// session file untouched, show no success toast, and stay recoverable.
//
// Run: node build-node/test/replaceCorruptPdf.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function run(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => !!(window as any).__pt?.controller?.getSnapshot().docOpen,
      undefined, { timeout: 20_000 });

    const out = await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // A real reading position, then a clean, bound session.
      pt.jumpVia({ page: 3, yRatio: 0.25 }, 'reading spot');
      // Make the teardown-scroll race DETERMINISTIC: jumpVia's programmatic
      // scroll suppresses position tracking for 600ms, and on fast machines
      // the failed replace's teardown scroll (viewer.close emptying the
      // container clamps scrollTop to 0) landed inside that window — hiding
      // the bug except on slow/loaded runners. A real user replaces the PDF
      // more than a moment after their last jump, so wait the window out.
      await sleep(700);
      const writes: string[] = [];
      c.session.handle = {
        kind: 'file', name: 's.ptl',
        queryPermission: async () => 'granted',
        createWritable: async () => ({
          write: async (t: string) => { writes.push(t); },
          close: async () => { /* sink */ },
        }),
      };
      c.session.dirty = false;
      const nameBefore = c.getSnapshot().docTitle;

      // Replace with garbage bytes: pdf.js must reject them.
      await c.replaceWithFile(
        new File([new Uint8Array([37, 37, 1, 2, 3, 4, 5, 6])], 'corrupt.pdf'));
      await sleep(2200); // let any (wrongly armed) debounced auto-save fire
      const sessionWrites = writes.length;
      const toastMsg: string = c.getSnapshot().toast?.msg ?? '';
      const dirty: boolean = c.session.dirty;

      // Recovery: undo must bring the previous PDF back.
      c.undoHist();
      let recovered = false;
      for (let i = 0; i < 200; i++) {
        const s = c.getSnapshot();
        if (s.docOpen && s.numPages > 0 && s.docTitle === nameBefore) { recovered = true; break; }
        await sleep(100);
      }
      return { sessionWrites, toastMsg, dirty, recovered };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    check('the session file is never written after a failed replace',
      out.sessionWrites === 0, `writes=${out.sessionWrites}`);
    check('no "PDF replaced" success toast over the failure',
      !/PDF replaced/.test(out.toastMsg), `toast=${JSON.stringify(out.toastMsg)}`);
    check('the session stays clean (nothing to lose on close)',
      out.dirty === false, `dirty=${out.dirty}`);
    check('undo recovers the previous PDF', out.recovered === true);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
