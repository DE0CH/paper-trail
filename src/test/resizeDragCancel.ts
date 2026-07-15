// A panel-resize drag that ends abnormally must still clean up. The old
// handler listened only for pointerup/pointermove on the handle: after a
// pointercancel, or after the handle unmounted mid-drag (mod+B closes the
// sidebar), body.resizing stuck — a global col-resize cursor with text
// selection disabled everywhere — and the dragged width was never
// persisted. Every ending now runs the same finish path.
// Run: node build-node/test/resizeDragCancel.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const bodyResizing = (page: Page) =>
  page.evaluate(() => document.body.classList.contains('resizing'));

// Press down on a divider and drag it dx pixels (button stays down).
async function startDrag(page: Page, handleId: string, dx: number): Promise<void> {
  const box = (await page.locator(`#${handleId}`).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy, { steps: 4 });
}

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.histItem .lbl', { timeout: 20_000 });

    // --- pointercancel mid-drag -------------------------------------
    await startDrag(page, 'resizeStacks', 20);
    check('dragging sets body.resizing', await bodyResizing(page));
    await page.evaluate(() => {
      document.getElementById('resizeStacks')!.dispatchEvent(
        new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
    });
    check('pointercancel clears body.resizing', !(await bodyResizing(page)));
    check('pointercancel clears the handle highlight',
      await page.evaluate(() => !document.getElementById('resizeStacks')!
        .classList.contains('bg-[rgba(79,140,255,0.35)]')));
    const persisted = await page.evaluate(() => {
      const w = (document.getElementById('stacksCol') as HTMLElement).offsetWidth;
      const saved = (JSON.parse(localStorage.getItem('pt:ui') ?? '{}') as
        { stacksW?: number }).stacksW;
      return { w, saved };
    });
    check('pointercancel persists the dragged width',
      persisted.saved != null && Math.abs(persisted.saved - persisted.w) <= 1,
      JSON.stringify(persisted));
    await page.mouse.up();
    check('the late pointerup after a cancel stays a no-op',
      !(await bodyResizing(page)));

    // --- the handle unmounts mid-drag (mod+B hides the sidebar) ------
    await startDrag(page, 'resizeSidebar', 15);
    check('dragging the sidebar divider sets body.resizing', await bodyResizing(page));
    await page.keyboard.press('Control+b');
    await page.locator('#sidebar').waitFor({ state: 'detached', timeout: 5_000 });
    await page.mouse.up();
    check('releasing after the handle unmounted clears body.resizing',
      !(await bodyResizing(page)));
    await page.keyboard.press('Control+b'); // restore the sidebar
    await page.locator('#sidebar').waitFor({ state: 'visible', timeout: 5_000 });

    // --- a normal drag afterwards still works end-to-end -------------
    const before = await page.evaluate(
      () => (document.getElementById('stacksCol') as HTMLElement).offsetWidth);
    await startDrag(page, 'resizeStacks', 25);
    await page.mouse.up();
    const after = await page.evaluate(
      () => (document.getElementById('stacksCol') as HTMLElement).offsetWidth);
    check('a normal resize still works after the aborted ones',
      Math.abs(after - (before + 25)) <= 2 && !(await bodyResizing(page)),
      `before=${before} after=${after}`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
