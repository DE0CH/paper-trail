// A large-format page (the PDF spec allows 14400x14400pt) zoomed in must
// still render visibly: its backing canvas has to stay inside Chromium's
// hard per-dimension maximum AND the area budget. When the dpr reduction
// gave up too early, the canvas exceeded the platform limit, Chromium
// zeroed its backing store, pdf.js render() resolved anyway, and the page
// went permanently blank with no error and no retry.
// Run: node build-node/test/hugePageZoomBlank.js   (server on 8377 first)

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
    controller: { openFile(f: File): Promise<void> };
    viewer: {
      setScale(s: number): void;
      pages: Array<{ rendered: boolean; stale: boolean; renderedScale: number }>;
    };
    session: { dirty: boolean };
  };
};

async function giantPdfB64(): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([14400, 14400]);
  // Ink the top-left quadrant so a readback there distinguishes a real
  // render from a zeroed (blank) canvas.
  page.drawRectangle({ x: 0, y: 7200, width: 7200, height: 7200, color: rgb(0.1, 0.2, 0.6) });
  const bytes = await doc.save({ useObjectStreams: false });
  return Buffer.from(bytes).toString('base64');
}

async function run(): Promise<void> {
  const b64 = await giantPdfB64();
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/');
    await page.waitForFunction(() => !!(window as unknown as PtWin).__pt, undefined,
      { timeout: 20_000 });
    await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const f = new File([bytes], 'giant.pdf', { type: 'application/pdf' });
      await (window as unknown as PtWin).__pt.controller.openFile(f);
    }, b64);
    await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30_000 });

    // Zoom to where the CSS box (~40320px per side) exceeds every canvas cap.
    await page.evaluate(() => {
      (window as unknown as PtWin).__pt.viewer.setScale(2.8);
    });
    const rerendered = await page.waitForFunction(() => {
      const p = (window as unknown as PtWin).__pt.viewer.pages[0];
      return p.rendered && !p.stale && p.renderedScale === 2.8;
    }, undefined, { timeout: 60_000 }).then(() => true).catch(() => false);
    check('the huge page re-renders at scale 2.8 (render resolved)', rerendered);

    const res = await page.evaluate(() => {
      const c = document.querySelector('.page[data-page="1"] canvas') as HTMLCanvasElement;
      let ink = false;
      let readback = 'ok';
      try {
        const ctx = c.getContext('2d')!;
        // sample inside the inked top-left quadrant
        const d = ctx.getImageData(
          Math.floor(c.width * 0.25), Math.floor(c.height * 0.25), 4, 4).data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) ink = true;
        }
      } catch (e) {
        readback = String(e);
      }
      (window as unknown as PtWin).__pt.session.dirty = false;
      return { w: c.width, h: c.height, ink, readback };
    });
    check('the backing canvas stays inside the per-dimension cap',
      res.w <= 16_384 && res.h <= 16_384, `${res.w}x${res.h}`);
    check('the backing canvas stays inside the area budget',
      res.w * res.h <= 64_000_000 + 2 * 16_384, `area ${res.w * res.h}`);
    check('the rendered page is not blank (ink where the page has ink)',
      res.ink, `readback: ${res.readback}, ${res.w}x${res.h}`);
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
