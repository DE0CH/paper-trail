// REAL desktop-e2e: dragging-and-dropping a .ptl onto the window must bind
// the on-disk path for real — NO stubbing of webUtils.getPathForFile (a stub
// is exactly what let the "open PDF, then drop the .ptl" bug ship). We launch
// the real Electron shell, write a real .ptl to disk, obtain a real
// File-with-path via <input type=file> (Electron backs it with the OS path,
// same as a drop), and dispatch a real 'drop' through the app's own handler.
//
//   getPathForFile diagnostic — proves the preload bridge resolves a real
//     File's path (if this is "", the whole path-binding approach is broken,
//     not just the routing).
//   open PDF FIRST, then drop the .ptl (the shipped bug) — session.path must
//     bind to the real path; autosave arms.
//   drop the .ptl with nothing open (control) — also binds.
//
// Prereq: npm run build.  Usage: node build-node/test/desktopDropBinds.js

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron, type Page } from 'playwright-core';

const BASE = 'paper-trail://app';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function dropRealPtl(page: Page, inputSel: string): Promise<{
  getPathForFile: string; bound: string | null; saveBound: boolean; docOpen: boolean;
}> {
  return page.evaluate(async (sel) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const pt = (window as any).__pt;
    const c = pt.controller;
    const input = document.querySelector(sel) as HTMLInputElement;
    const file = input.files![0]; // a REAL File carrying its OS path
    const gp = (window as any).ptDesktop?.getPathForFile?.(file) ?? '';
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt }); // not settable via ctor
    window.dispatchEvent(ev); // the app's own window 'drop' listener runs
    for (let i = 0; i < 160 && !c.session.path && !c.confirmSession; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!c.session.path && c.confirmSession) c.applyConfirmedSession();
    return {
      getPathForFile: String(gp),
      bound: c.session.path as string | null,
      saveBound: !!c.getSnapshot().saveBound,
      docOpen: !!c.getSnapshot().docOpen,
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, inputSel);
}

async function makeInput(page: Page, id: string, filePath: string): Promise<void> {
  await page.evaluate((elId) => {
    const i = document.createElement('input');
    i.type = 'file'; i.id = elId;
    i.style.position = 'fixed'; i.style.left = '-9999px';
    document.body.appendChild(i);
  }, id);
  await page.setInputFiles('#' + id, filePath);
}

async function run(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-drop-'));
  const eApp = await _electron.launch({
    executablePath: electronPath,
    args: [path.resolve(__dirname, '..', 'desktop', 'main.js')],
    env: { ...process.env as Record<string, string>, PT_USERDATA: userData, PT_SHOT: '1' },
  });
  try {
    // Native dialogs would hang the run — stub ONLY the dialogs (never
    // getPathForFile). A stubbed showSaveDialog also lets us prove a bound
    // session never reaches the picker.
    await eApp.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 1) as typeof dialog.showMessageBoxSync;
      dialog.showSaveDialog = (async () => ({ canceled: true, filePath: '' })) as typeof dialog.showSaveDialog;
      dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
    });
    const page: Page = await eApp.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    page.on('dialog', (d) => d.accept().catch(() => { /* already handled */ }));

    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => !!(window as any).__pt?.controller?.getSnapshot().docOpen,
      undefined, { timeout: 20_000 });

    // A real, valid .ptl for the open doc, written to a real path on disk.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ptlText: string = await page.evaluate(() => (window as any).__pt.progressText());
    const ptlPath = path.join(userData, 'reading.ptl');
    fs.writeFileSync(ptlPath, ptlText, 'utf8');

    // ---- primary: PDF already open, THEN drop the .ptl (the shipped bug) ----
    await makeInput(page, '__drop1', ptlPath);
    const a = await dropRealPtl(page, '#__drop1');
    check('the preload resolves a real dropped File to its on-disk path',
      a.getPathForFile === ptlPath, `getPathForFile=${JSON.stringify(a.getPathForFile)}`);
    check('a PDF is already open (the doc-open drop branch is under test)',
      a.docOpen === true, `docOpen=${a.docOpen}`);
    check('dropping a .ptl onto the open PDF binds the real silent-write path',
      a.bound === ptlPath, `session.path=${JSON.stringify(a.bound)}`);
    check('autosave is armed after the drop', a.saveBound === true, `saveBound=${a.saveBound}`);

    // ---- control: drop a .ptl with NOTHING open (the path that already worked) ----
    await page.goto(BASE + '/');
    await page.evaluate(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('pt:')).forEach((k) => localStorage.removeItem(k));
    });
    await page.waitForTimeout(300);
    await makeInput(page, '__drop2', ptlPath);
    const b = await dropRealPtl(page, '#__drop2');
    check('dropping a .ptl with nothing open also binds the real path',
      b.bound === ptlPath, `session.path=${JSON.stringify(b.bound)}`);
  } finally {
    await eApp.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error('FAIL  desktopDropBinds errored', e); process.exit(1); });
