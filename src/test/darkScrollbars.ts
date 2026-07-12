// The app has exactly one theme — dark — and its scrollbars must be
// the NATIVE dark ones: normal width, a visible rail, arrow buttons,
// native drag. Chromium provides all of that from `color-scheme:
// dark` alone; styling ANY ::-webkit-scrollbar part switches the
// whole widget to legacy custom rendering, which silently drops the
// rail and the arrows (the bug this pins). So: dark scheme declared,
// zero scrollbar styling anywhere.
// Run: node build-node/test/darkScrollbars.js   (server on 8377 first)

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

    const style = await page.evaluate(() => {
      const scrollbarSelectors: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; // cross-origin sheet: not ours, cannot style our bars
        }
        for (const rule of Array.from(rules)) {
          const sel = (rule as CSSStyleRule).selectorText ?? '';
          if (sel.includes('::-webkit-scrollbar')) scrollbarSelectors.push(sel);
        }
      }
      return {
        scheme: getComputedStyle(document.documentElement).colorScheme,
        scrollbarSelectors,
      };
    });
    check('the document declares a dark color scheme',
      style.scheme === 'dark', style.scheme);
    check('no stylesheet customizes the scrollbars (native rail and arrows)',
      style.scrollbarSelectors.length === 0,
      style.scrollbarSelectors.join(', ') || '(none)');

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
