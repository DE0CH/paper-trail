// The app has exactly one theme — dark — so scrollbars must blend
// with the surfaces they ride on. Chromium renders native LIGHT
// scrollbars (a glaring white rail next to the dark panels) unless
// the page both declares `color-scheme: dark` and styles the
// scrollbar parts: this checks the declaration, a dark thumb, and a
// track that disappears into the background.
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
      const viewer = document.getElementById('viewerContainer') ?? document.body;
      const luminance = (color: string): number | null => {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(color);
        if (!m) return null;
        if (m[4] !== undefined && Number(m[4]) === 0) return -1; // transparent
        return (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3;
      };
      const thumb = getComputedStyle(viewer, '::-webkit-scrollbar-thumb').backgroundColor;
      const track = getComputedStyle(viewer, '::-webkit-scrollbar-track').backgroundColor;
      return {
        scheme: getComputedStyle(document.documentElement).colorScheme,
        thumb,
        thumbLum: luminance(thumb),
        track,
        trackLum: luminance(track),
      };
    });
    check('the document declares a dark color scheme',
      style.scheme === 'dark', style.scheme);
    check('the scrollbar thumb is dark, not a white rail',
      style.thumbLum !== null && style.thumbLum >= 0 && style.thumbLum < 128,
      `${style.thumb} (luminance ${style.thumbLum})`);
    check('the scrollbar track blends into the background',
      style.trackLum !== null && (style.trackLum === -1 || style.trackLum < 128),
      `${style.track} (luminance ${style.trackLum})`);

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
