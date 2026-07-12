// Prints the layout inputs the e2e suite's geometry depends on, so a
// runner whose checks disagree with the others can be diagnosed from
// data instead of guesses: browser build, scrollbar width, toolbar and
// first-page rectangles, fit scale, and the hover-preview popup box.
// Prereq: app built and server running. Usage: node build-node/tools/geometry.js [baseUrl]

import { findBrowser } from '../test/browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

async function run(): Promise<void> {
  const executablePath = findBrowser();
  console.log('browser:', executablePath);
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    console.log('version:', browser.version());
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.page[data-page="1"] .annotLayer .pdfLink', { timeout: 20000 });
    const geo = await page.evaluate(() => {
      const rect = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const container = document.getElementById('viewerContainer')!;
      return {
        dpr: window.devicePixelRatio,
        scrollbar: container.offsetWidth - container.clientWidth,
        toolbar: rect(document.getElementById('toolbar')),
        page1: rect(document.querySelector('.page[data-page="1"]')),
        link4: rect(document.querySelectorAll(
          '.page[data-page="1"] .annotLayer .pdfLink:not(.external)')[3] ?? null),
        font: getComputedStyle(document.body).fontFamily,
      };
    });
    console.log(JSON.stringify(geo, null, 1));
    // the popup the resize checks drag: hover the 4th internal link
    const link = page.locator('.page[data-page="1"] .annotLayer .pdfLink:not(.external)').nth(3);
    await link.hover();
    await page.waitForSelector('#preview', { timeout: 5000 });
    await page.waitForTimeout(600);
    console.log('preview box:', JSON.stringify(await page.locator('#preview').boundingBox()));
  } finally {
    await browser.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
