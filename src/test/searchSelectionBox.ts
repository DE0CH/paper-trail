// Regression: the native context menu's "Search for this" action
// ('search-selection') must POPULATE the find box with the selected text,
// not merely run the search. The old handler set the input value inside a
// queueMicrotask that fired BEFORE React mounted the (unmounted-while-
// closed) SearchBar, so searchRef.current was null, the value was never
// set, and the box stayed empty while the search still ran. Desktop-only
// (no native menu on the web); the renderer handler is identical on
// Windows and macOS, so one desktop run covers both.
//
// Run: node build-node/test/searchSelectionBox.js

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
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-searchsel-')),
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
    await page.waitForSelector('.page[data-page="1"]', { timeout: 20000 });
    check('find bar starts closed',
      !(await page.evaluate(() => !!document.getElementById('searchBar'))));

    // Fire the REAL native-menu action from the main process — exactly
    // what right-click > "Search for this" sends.
    const term = 'equivariant';
    await eApp.evaluate(({ BrowserWindow }, t) => {
      BrowserWindow.getAllWindows()[0].webContents.send('pt-menu', 'search-selection', t);
    }, term);

    await page.waitForSelector('#searchInput', { timeout: 5000 });
    // let the mount effect + the search settle
    await page.waitForFunction(
      () => (document.getElementById('searchCount')?.textContent ?? '').includes('/'),
      { timeout: 5000 },
    ).catch(() => { /* assertion below reports the real state */ });

    const state = await page.evaluate(() => ({
      value: (document.getElementById('searchInput') as HTMLInputElement | null)?.value ?? null,
      count: (document.getElementById('searchCount')?.textContent ?? '').trim(),
    }));
    check(`"Search for this" fills the find box with the selection (got "${state.value}")`,
      state.value === term);
    check(`"Search for this" still runs the search (count "${state.count}")`,
      /[1-9]/.test(state.count));
  } finally {
    await eApp.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
