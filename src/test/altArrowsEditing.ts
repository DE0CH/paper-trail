// Global Alt+Arrow shortcuts must stay out of text fields. On macOS,
// Option+Left/Right is word-wise caret movement; with the page input (or
// any text field that lets keys bubble) focused, the global handler used
// to run controller.goBack()/goForward() + preventDefault — the document
// navigated away mid-edit. The alt branch now bails out in text fields,
// exactly like the '?' and mod+Z shortcuts already did.
// Run: node build-node/test/altArrowsEditing.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface PtHist { active: { index: number; entries: unknown[] } }
const histIndex = (page: Page) => page.evaluate(
  () => (window as never as { __pt: { hist: PtHist } }).__pt.hist.active.index);
const entryCount = (page: Page) => page.evaluate(
  () => (window as never as { __pt: { hist: PtHist } }).__pt.hist.active.entries.length);

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.histItem .lbl', { timeout: 20_000 });
    // The history rows render before the PDF finishes opening, and the
    // controller's actions no-op until docOpen — the page input enabling
    // is the direct docOpen signal.
    await page.waitForSelector('#pageInput:not([disabled])', { timeout: 20_000 });

    // A second history entry so Back actually has somewhere to go.
    await page.click('#btnMark');
    await page.waitForFunction(
      () => document.querySelectorAll('.histItem').length > 1, undefined,
      { timeout: 5_000 });
    check('setup: marking put the cursor on entry 1', await histIndex(page) === 1,
      `index=${await histIndex(page)}`);

    // Focused text field: Alt+arrows must not navigate the trail.
    await page.click('#pageInput');
    const valueBefore = await page.inputValue('#pageInput');
    await page.keyboard.press('Alt+ArrowLeft');
    check('Alt+Left in the page input does not navigate back',
      await histIndex(page) === 1, `index=${await histIndex(page)}`);
    await page.keyboard.press('Alt+ArrowRight');
    check('Alt+Right in the page input does not navigate forward',
      await histIndex(page) === 1, `index=${await histIndex(page)}`);
    check('the page input kept focus through Alt+arrows',
      await page.evaluate(() => document.activeElement?.id === 'pageInput'));
    check('the page input value is untouched',
      await page.inputValue('#pageInput') === valueBefore,
      `before=${valueBefore} after=${await page.inputValue('#pageInput')}`);
    check('Alt+arrows in a text field created no history entries',
      await entryCount(page) === 2, `entries=${await entryCount(page)}`);

    // Outside a text field the shortcuts must keep working.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Alt+ArrowLeft');
    check('Alt+Left outside a text field still navigates back',
      await histIndex(page) === 0, `index=${await histIndex(page)}`);
    await page.keyboard.press('Alt+ArrowRight');
    check('Alt+Right outside a text field still navigates forward',
      await histIndex(page) === 1, `index=${await histIndex(page)}`);

    // Marking dirtied the session; clear it so the harness sees no prompt.
    await page.evaluate(() => {
      (window as never as { __pt: { session: { dirty: boolean } } }).__pt.session.dirty = false;
    });
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
