// Regression: the recents list was last-writer-wins across windows. Each
// window snapshotted the stored list once at attach and saveRecents wrote its
// whole in-memory copy back blind — so a window that attached earlier erased
// every entry other windows had recorded since (and a fast open at startup
// could overwrite the whole store with a one-entry list). recordRecent must
// read-merge-write against the CURRENT store, never its stale snapshot.
//
// Run: node build-node/test/recentsTwoWindows.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page, type BrowserContext } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Open a PDF in this page keyed by an on-disk PATH (a path ref is a plain
// string, so it survives IndexedDB's structured clone — a fake handle object
// with function properties would make the store write throw), and wait until
// its recent has been recorded and SAVED to IndexedDB.
async function openAndRecord(page: Page, name: string): Promise<void> {
  await page.evaluate(async (pdfName) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const c = (window as any).__pt.controller;
    const bytes = new Uint8Array(
      await (await fetch('sample/WStarCats.pdf')).arrayBuffer());
    await c.openFile(new File([bytes], pdfName), null, '/tmp/pt-recents/' + pdfName);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, name);
  await page.waitForFunction((pdfName) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const c = (window as any).__pt.controller;
    return c.getSnapshot().recents.some((r: any) => r.entry.pdfName === pdfName);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, name, { timeout: 20_000 });
  // The IDB save itself is fire-and-forget after the list updates; give it
  // a beat so the next window reads a settled store.
  await page.waitForTimeout(400);
}

async function run(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const context: BrowserContext = await browser.newContext(
      { viewport: { width: 1200, height: 800 } });
    const ready = (p: Page) => p.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => !!(window as any).__pt?.controller, undefined, { timeout: 20_000 });

    // A fresh browser profile per launch means the store starts empty.
    // Window 1 attaches first (snapshotting that empty store)…
    const w1 = await context.newPage();
    w1.on('dialog', (d) => void d.accept());
    await w1.goto(BASE + '/');
    await ready(w1);

    // …then window 2 opens a PDF and records its recent.
    const w2 = await context.newPage();
    w2.on('dialog', (d) => void d.accept());
    await w2.goto(BASE + '/');
    await ready(w2);
    await openAndRecord(w2, 'b.pdf');

    // Window 1 (whose in-memory copy predates b.pdf) now records its own.
    await openAndRecord(w1, 'a.pdf');

    // A fresh window shows what actually survived in the store.
    const w3 = await context.newPage();
    await w3.goto(BASE + '/');
    await ready(w3);
    await w3.waitForTimeout(600); // let the welcome screen load recents
    const stored: string[] = await w3.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__pt.controller.getSnapshot()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .recents.map((r: any) => r.entry.pdfName));

    check('window 2’s entry survives window 1’s later save',
      stored.includes('b.pdf'), `stored=${JSON.stringify(stored)}`);
    check('window 1’s own entry is recorded too',
      stored.includes('a.pdf'), `stored=${JSON.stringify(stored)}`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
