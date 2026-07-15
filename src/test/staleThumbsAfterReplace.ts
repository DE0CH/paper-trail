// Replace PDF with a file of the SAME name and page count (a revised
// same-named download, the mismatch banner's adopt, or replace-undo) must
// refresh the thumbnail panel. The thumbnail cache and the React rows were
// keyed on (docTitle, numPages), which does not change across such a
// replace — so every thumbnail kept showing the OLD document forever. The
// cache is now keyed on a monotonic per-document generation.
// Run: node build-node/test/staleThumbsAfterReplace.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';
import { PDFDocument, rgb } from 'pdf-lib';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

type PtWin = Window & {
  __pt: {
    controller: {
      replaceWithFile(f: File): Promise<void>;
      getSnapshot(): { docTitle: string; numPages: number };
    };
    session: { dirty: boolean };
  };
};

/** Same page count as the fixture (41), visibly different content. */
async function replacementPdfB64(): Promise<string> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 41; i++) {
    const p = doc.addPage([612, 792]);
    p.drawRectangle({ x: 40, y: 40, width: 532, height: 712, color: rgb(0.15, 0.15, 0.2) });
  }
  const bytes = await doc.save({ useObjectStreams: false });
  return Buffer.from(bytes).toString('base64');
}

async function run(): Promise<void> {
  const b64 = await replacementPdfB64();
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 20_000 });

    // Open the thumbnail tab and let the first thumbnail render.
    await page.click('#navCol button:has-text("Pages")');
    await page.waitForSelector('#thumbList [data-thumb-page="1"] canvas', { timeout: 15_000 });
    const before = await page.evaluate(() => {
      const c = document.querySelector(
        '#thumbList [data-thumb-page="1"] canvas') as HTMLCanvasElement;
      return {
        thumb: c.toDataURL(),
        gen: document.getElementById('thumbList')?.dataset.docGen ?? null,
      };
    });

    // Replace with a same-named, same-page-count, different-content PDF.
    await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const f = new File([bytes], 'WStarCats.pdf', { type: 'application/pdf' });
      await (window as unknown as PtWin).__pt.controller.replaceWithFile(f);
    }, b64);
    await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 20_000 });

    // Confirm the premise: name and page count are unchanged, so the old
    // (docTitle, numPages) key cannot tell the documents apart.
    const snap = await page.evaluate(() =>
      (window as unknown as PtWin).__pt.controller.getSnapshot());
    check('the replacement keeps the same name and page count (test premise)',
      snap.docTitle === 'WStarCats.pdf' && snap.numPages === 41, JSON.stringify(snap));

    // The visible thumbnail must show the NEW document's content.
    const refreshed = await page.waitForFunction((old) => {
      const c = document.querySelector(
        '#thumbList [data-thumb-page="1"] canvas') as HTMLCanvasElement | null;
      return !!c && c.toDataURL() !== old;
    }, before.thumb, { timeout: 15_000 }).then(() => true).catch(() => false);
    check('thumbnails re-render after Replace PDF with a same-named file', refreshed);

    const genAfter = await page.evaluate(() =>
      document.getElementById('thumbList')?.dataset.docGen ?? null);
    check('the thumbnail list is keyed on a per-document generation',
      genAfter !== null && genAfter !== before.gen,
      `before=${before.gen} after=${genAfter}`);

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
