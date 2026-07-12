// The hover preview must survive an annotation-layer rebuild: pdf.js
// replaces the link elements whenever a page re-renders (scroll, zoom,
// quality re-render), so the element the pointer hovered can be
// disconnected by the time the show timer fires — and the preview
// silently never appeared (the intermittent desktopE2e failure; the
// pointer is still on a visually identical link, so to the user the
// preview just randomly doesn't open). This forces that exact
// condition deterministically: hover, replace the link with its clone
// (what a rebuild does to the DOM), and require the preview anyway.
// Run: node build-node/test/previewRebuild.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const LINK_SEL = '.pdfLink';

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
    await page.waitForSelector(LINK_SEL, { timeout: 20_000 });

    // Arm the hover and rebuild the layer in ONE evaluate: the enter
    // event starts the 350ms show timer and the element is replaced by
    // an identical clone in the same tick — the disconnect is
    // GUARANTEED to precede the timer (a separate hover() call can
    // lose that race on a slow machine, seen on macos-15-intel).
    await page.evaluate((sel) => {
      const el = document.querySelectorAll(sel)[3] as HTMLElement;
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      el.replaceWith(el.cloneNode(true));
    }, LINK_SEL);

    let visible = true;
    try {
      await page.waitForSelector('#preview:not(.hidden)', { timeout: 4000 });
    } catch {
      visible = false;
    }
    check('the preview still appears when the hovered link was rebuilt',
      visible, visible ? '' : 'never became visible');

    if (visible) {
      // and it rendered actual content at a sane position
      await page.waitForFunction(
        () => !!document.querySelector('#preview .previewContent canvas'),
        undefined, { timeout: 5000 });
      const box = await page.evaluate(() => {
        const r = document.getElementById('preview')!.getBoundingClientRect();
        return { top: r.top, height: r.height, width: r.width };
      });
      check('the rebuilt-link preview is placed inside the window',
        box.top >= 0 && box.height > 60 && box.width > 100, JSON.stringify(box));
    }

    await page.evaluate(() => {
      const pt = (window as never as { __pt: { session: { dirty: boolean } } }).__pt;
      pt.session.dirty = false;
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
