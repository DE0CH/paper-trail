// Regression: the replace-undo/redo slots were captured once, at replace
// time. Reading done AFTER the replace — back/forward, scrolling, zoom (none
// of which supersede a pending replace-undo) — was silently discarded when
// undo/redo restored the stale snapshot. Undoing must first re-capture the
// LIVE state into the redo slot (and vice versa), so undo→redo round-trips
// to where the user actually was.
//
// Run: node build-node/test/replaceUndoRecapture.js   (server on 8377 first)

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
      const waitDoc = async (title: string) => {
        for (let i = 0; i < 200; i++) {
          const s = c.getSnapshot();
          if (s.docOpen && s.numPages > 0 && s.docTitle === title) return true;
          await sleep(100);
        }
        return false;
      };

      // Doc A with a two-entry trail, cursor on entry 1.
      pt.jumpVia({ page: 2, yRatio: 0 }, 'section');
      const idxBeforeReplace: number = pt.hist.active.index; // 1

      // Replace with doc B (state carries over).
      const bBytes = new Uint8Array(
        await (await fetch('sample/cjk.pdf')).arrayBuffer());
      await c.replaceWithFile(new File([bBytes], 'cjk.pdf'));
      if (!(await waitDoc('cjk.pdf'))) return { fail: 'replace never opened' };

      // Navigation AFTER the replace: back to entry 0. Back/forward do not
      // supersede the pending replace-undo (only history MUTATIONS do).
      c.goBack();
      const idxAfterNav: number = pt.hist.active.index; // 0

      // Undo the replacement (back to A), then redo (forward to B again).
      c.undoHist();
      if (!(await waitDoc('WStarCats.pdf'))) return { fail: 'undo never reopened A' };
      const idxInA: number = pt.hist.active.index;
      c.redoHist();
      if (!(await waitDoc('cjk.pdf'))) return { fail: 'redo never reopened B' };
      const idxAfterRedo: number = pt.hist.active.index;

      return { idxBeforeReplace, idxAfterNav, idxInA, idxAfterRedo };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    if ('fail' in out) {
      check(String(out.fail), false);
    } else {
      check('setup: the trail cursor sat on entry 1 before the replace',
        out.idxBeforeReplace === 1 && out.idxAfterNav === 0,
        `before=${out.idxBeforeReplace} afterNav=${out.idxAfterNav}`);
      check('undo restores the pre-replace state',
        out.idxInA === 1, `idxInA=${out.idxInA}`);
      check('redo returns to the navigation done after the replace (not the stale replace-time snapshot)',
        out.idxAfterRedo === 0, `idxAfterRedo=${out.idxAfterRedo}`);
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
