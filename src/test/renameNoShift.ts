// Double-clicking a trail name or a history entry to rename must not
// shift the text by even a pixel (the app's no-jank rule). The rename
// <input> replaces the display <span> in the same flex slot, so its text
// must start at the exact same x — and stay vertically centred — as the
// span's. A 1px accent BORDER used to push the text ~1px right (the
// negative margin cancels the padding but not the border); the fix draws
// the accent outline as an inset ring (box-shadow — no layout) instead.
// Run: node build-node/test/renameNoShift.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// The x where the text CONTENT starts (rect left + left border + left
// padding) and the element's vertical centre — the same measurement for
// the display span and the edit input, so any drift is a real shift.
const anchor = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    x: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
    cy: r.top + r.height / 2,
  };
};

async function shiftOnRename(page: Page, rowSel: string, nameSel: string):
  Promise<{ dx: number; dy: number }> {
  const span = page.locator(`${rowSel} ${nameSel}`).first();
  await span.waitFor({ state: 'visible', timeout: 15_000 });
  const before = await span.evaluate(anchor);
  await span.dblclick();
  const input = page.locator(`${rowSel} input.rename`).first();
  await input.waitFor({ state: 'visible', timeout: 5_000 });
  const after = await input.evaluate(anchor);
  await page.keyboard.press('Escape');
  await input.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => { /* fine */ });
  return { dx: after.x - before.x, dy: after.cy - before.cy };
}

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    // A loaded PDF gives a default trail ("Untitled 1") and a "Start"
    // history entry — one of each is enough to measure the rename box.
    await page.waitForSelector('.stackRow .name', { timeout: 20_000 });
    await page.waitForSelector('.histItem .lbl', { timeout: 20_000 });

    const trail = await shiftOnRename(page, '.stackRow', '.name');
    check(`trail rename: the text does not shift horizontally (dx=${trail.dx.toFixed(2)}px)`,
      Math.abs(trail.dx) < 0.5, JSON.stringify(trail));
    check(`trail rename: the text does not shift vertically (dy=${trail.dy.toFixed(2)}px)`,
      Math.abs(trail.dy) < 0.5, JSON.stringify(trail));

    const entry = await shiftOnRename(page, '.histItem', '.lbl');
    check(`history rename: the text does not shift horizontally (dx=${entry.dx.toFixed(2)}px)`,
      Math.abs(entry.dx) < 0.5, JSON.stringify(entry));
    check(`history rename: the text does not shift vertically (dy=${entry.dy.toFixed(2)}px)`,
      Math.abs(entry.dy) < 0.5, JSON.stringify(entry));

    // Renaming would dirty the session; the Escapes above cancel it, but
    // clear the flag so the harness never sees an unsaved-changes prompt.
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

run().catch((e) => { console.error(e); process.exit(1); });
