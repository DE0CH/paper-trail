// The reference preview popup stays inside the app window. Its top
// edge already stops below the toolbar (a 0.5.5 fix); its BOTTOM edge
// must equally stop at the window's bottom — dragging the bottom
// handle far down used to push the popup past the window bounds
// (reported on Windows; the clamp ignored where the popup's top sat).
// Run: node build-node/test/previewClamp.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const LINK = '.page[data-page="1"] .annotLayer .pdfLink:not(.external)';

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
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector(LINK, { timeout: 20_000 });

    // Open the preview over a mid-page link so its top sits well below
    // the toolbar (that is what exposes the bottom clamp).
    await page.locator(LINK).nth(3).hover();
    await page.waitForSelector('#preview:not(.hidden)', { timeout: 5_000 });
    await page.waitForTimeout(400);

    // Drag the bottom handle far past the window bottom with the REAL
    // mouse: on Windows the OS pointer keeps reporting positions below
    // the window while captured, which synthetic in-page events cannot
    // reproduce (an earlier synthetic version of this drag silently
    // did nothing and passed vacuously).
    const handle = page.locator('#preview .previewResize');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, 900 + 600, { steps: 12 });
    const dragged = await page.evaluate(() => {
      const r = document.getElementById('preview')!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, innerHeight: window.innerHeight };
    });
    await page.mouse.up();
    check('the drag really engaged the resize (the popup grew)',
      dragged.bottom - dragged.top > 120, JSON.stringify(dragged));
    check('the preview bottom never leaves the app window',
      dragged.bottom <= dragged.innerHeight,
      JSON.stringify(dragged));

    await page.evaluate(() => {
      (window as never as { __pt: { session: { dirty: boolean } } })
        .__pt.session.dirty = false;
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
