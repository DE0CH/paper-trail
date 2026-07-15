// Regression: in the session-first flow (open a .ptl, app asks for its PDF)
// the pending session was consumed BEFORE the PDF actually opened. Picking a
// corrupt/unreadable PDF therefore discarded the waiting session: the prompt
// vanished and re-picking the RIGHT PDF opened it fresh, without the session.
// The pending state must survive a failed pick and bind on the next good one.
//
// Run: node build-node/test/pendingSessionCorruptPdf.js   (server on 8377 first)

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
    await page.goto(BASE + '/');
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => !!(window as any).__pt?.controller,
      undefined, { timeout: 20_000 });

    const out = await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      const ptlText = [
        'paper-trail-session v1',
        'saved 2026-07-15T00:00:00.000Z',
        'pdf.name WStarCats.pdf',
        'view.scale 1',
        'view.fitWidth true',
        'view.page 2',
        'view.yRatio 0.5',
        'active 0',
        '',
        'stack Main',
        'cursor 1',
        'entry 1 0 Start',
        'entry 2 0.5 Section',
        '',
      ].join('\n');
      const ptlHandle = {
        kind: 'file', name: 'reading.ptl', __tag: 'ptl',
        createWritable: async () => ({ write: async () => { /* sink */ }, close: async () => { /* sink */ } }),
      };

      // Session first: the app now waits for the PDF.
      await c.openFile(new File([ptlText], 'reading.ptl'), ptlHandle);
      const pendingBefore: string | null = c.getSnapshot().pendingPdfName;

      // The user picks a corrupt PDF — the open fails.
      await c.openFile(new File([new Uint8Array([1, 2, 3, 4])], 'corrupt.pdf'));
      await sleep(200);
      const pendingAfterBad: string | null = c.getSnapshot().pendingPdfName;

      // Then the right PDF: it must open WITH the waiting session.
      const bytes = new Uint8Array(
        await (await fetch('sample/WStarCats.pdf')).arrayBuffer());
      await c.openFile(new File([bytes], 'WStarCats.pdf'));
      for (let i = 0; i < 100 && !c.getSnapshot().docOpen; i++) await sleep(100);

      return {
        pendingBefore,
        pendingAfterBad,
        boundTag: (c.session.handle && c.session.handle.__tag) ?? null,
        entries: c.hist.active.entries.length,
        pendingAfterGood: c.getSnapshot().pendingPdfName as string | null,
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    check('the session enters the waiting-for-PDF state',
      out.pendingBefore === 'WStarCats.pdf', `pending=${JSON.stringify(out.pendingBefore)}`);
    check('a corrupt PDF pick keeps the session waiting',
      out.pendingAfterBad === 'WStarCats.pdf', `pending=${JSON.stringify(out.pendingAfterBad)}`);
    check('the next (good) PDF binds the waiting session',
      out.boundTag === 'ptl', `bound handle tag=${JSON.stringify(out.boundTag)}`);
    check('the session history was restored (2 entries)',
      out.entries === 2, `entries=${out.entries}`);
    check('the waiting state is consumed once the PDF opens',
      out.pendingAfterGood === null, `pending=${JSON.stringify(out.pendingAfterGood)}`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
