// Bug B (#13) regression: the in-app find bar floats at the top-RIGHT of
// the page — exactly where Windows paints the native min/max/close buttons
// (titleBarOverlay). Its default 44px top tucked its top edge under those
// buttons, so the two collided. This drives the REAL desktop shell, opens
// the find bar, derives the window-controls region from the titlebar-area
// CSS env vars (the overlay's own geometry) and asserts the find bar's
// rectangle does not intersect it.
//
// macOS keeps its traffic lights at the top-LEFT, clear of the right-
// aligned bar, so the region is empty there and the check is vacuously
// satisfied; the collision — and this test's teeth — is Windows-only.
//
// Run: npx electron build-node/test/findBarWindowControls.js

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { _electron, type Page } from 'playwright-core';

const BASE = 'paper-trail://app';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function run(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const eApp = await _electron.launch({
    executablePath: electronPath,
    args: [path.resolve(__dirname, '..', 'desktop', 'main.js')],
    env: {
      ...process.env as Record<string, string>,
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-findbar-')),
      PT_SHOT: '1', // show the window without stealing focus
    },
  });
  try {
    await eApp.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 1) as typeof dialog.showMessageBoxSync;
    });
    const page: Page = await eApp.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    page.on('pageerror', (e) => check('no page errors', false, String(e)));
    page.on('dialog', (d) => d.accept().catch(() => { /* already handled */ }));

    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.page[data-page="1"]', { timeout: 20_000 });

    // Open the find bar the same way the Find menu item does.
    await eApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('pt-menu', 'find');
    });
    await page.waitForSelector('#searchBar', { timeout: 5_000 });

    const geo = await page.evaluate(() => {
      // The window controls occupy the strip RIGHT of the draggable
      // titlebar area, within the titlebar height. The titlebar-area-*
      // env vars describe exactly that draggable area, so a probe sized to
      // (x + width) × height measures the controls' left/bottom edges.
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;'
        + 'width:calc(env(titlebar-area-x, 0px) + env(titlebar-area-width, 100vw));'
        + 'height:env(titlebar-area-height, 0px);';
      document.body.appendChild(probe);
      const pr = probe.getBoundingClientRect();
      probe.remove();
      const controls = {
        left: pr.width, right: window.innerWidth, top: 0, bottom: pr.height,
      };
      const s = document.getElementById('searchBar')!.getBoundingClientRect();
      const bar = { left: s.left, right: s.right, top: s.top, bottom: s.bottom };
      const intersects = bar.left < controls.right && bar.right > controls.left
        && bar.top < controls.bottom && bar.bottom > controls.top;
      const degenerate = controls.bottom <= 0 || controls.left >= controls.right;
      return { controls, bar, intersects, degenerate };
    });

    console.log(`\nplatform=${process.platform}`);
    console.log(`  window-controls region: ${JSON.stringify(geo.controls)}`);
    console.log(`  find bar rect:          ${JSON.stringify(geo.bar)}`);

    if (process.platform === 'win32') {
      // The overlay must be real for the check to have teeth.
      check('the window-controls region is measurable (titlebar-area env vars present)',
        !geo.degenerate, JSON.stringify(geo.controls));
    }
    check('the find bar does not overlap the native window controls',
      !geo.intersects,
      `bar=${JSON.stringify(geo.bar)} controls=${JSON.stringify(geo.controls)}`);
  } finally {
    await eApp.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
