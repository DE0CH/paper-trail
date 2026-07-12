// No stray focus rings. Two paths painted Chromium's default (yellow)
// ring around toolbar buttons: Tab cycled focus through buttons in an
// arbitrary order, and a pointer-clicked button kept focus so ANY
// later keystroke upgraded it to :focus-visible. Tab cycling is
// removed outright (owner's call — a11y revisited later) and clicked
// buttons give focus back, so no element ever shows the UA ring.
// Run: node build-node/test/focusRing.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

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
    await page.waitForSelector('.page canvas', { timeout: 20_000 });

    const probe = () => page.evaluate(() => {
      const el = document.activeElement;
      return {
        tag: el?.tagName ?? '(none)',
        ringed: el && el !== document.body
          ? getComputedStyle(el).outlineStyle === 'auto' : false,
      };
    });

    // Tab must not cycle focus through buttons.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    let a = await probe();
    check('Tab does not move focus onto buttons',
      a.tag !== 'BUTTON' && !a.ringed, JSON.stringify(a));

    // A clicked button must not keep focus for later keystrokes to ring.
    await page.click('#btnNavToggle');
    await page.keyboard.press('j');
    await page.keyboard.press('Tab');
    a = await probe();
    check('a clicked button holds no focus ring after keystrokes',
      a.tag !== 'BUTTON' && !a.ringed, JSON.stringify(a));

    // Typing still works where it should: the search box keeps focus.
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    await page.waitForSelector('#searchInput', { timeout: 5_000 });
    a = await probe();
    check('deliberate focus (the search box) still works', a.tag === 'INPUT',
      JSON.stringify(a));

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
