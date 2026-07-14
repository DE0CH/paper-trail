// REAL desktop-e2e: with a PDF already open, dragging-and-dropping its .ptl
// onto the window must bind the on-disk path FOR REAL — NO stub of
// webUtils.getPathForFile (a stub is exactly what let this bug ship). We
// launch the real Electron shell, write a real .ptl to disk, obtain a real
// File-with-path via <input type=file> (Electron backs it with the OS path,
// same as a drop), and dispatch a real 'drop' through the app's own handler.
//
// Asserts the whole chain: the preload resolves the real path; the drop
// binds session.path; autosave arms; and a dirty close writes silently (no
// "Do you want to save?" prompt). The bug: App.tsx's "a document is already
// open" drop branch called openFile with NO path, so session.path stayed
// null even though getPathForFile works.
//
// (A .ptl dropped with NOTHING open is deliberately not asserted here — it is
// pending its PDF and binds only once the PDF opens.)
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
    // Stub ONLY native dialogs (they'd hang a scripted run) — never
    // getPathForFile. A stubbed showSaveDialog also proves a bound session
    // never reaches the picker.
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

    // A real, valid .ptl for the open doc, on a real path on disk.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ptlText: string = await page.evaluate(() => (window as any).__pt.progressText());
    const ptlPath = path.join(userData, 'reading.ptl');
    fs.writeFileSync(ptlPath, ptlText, 'utf8');

    // A real File-with-path from <input type=file>: Electron backs it with
    // the OS path exactly like a dropped file (so getPathForFile resolves it).
    await page.evaluate(() => {
      const i = document.createElement('input');
      i.type = 'file'; i.id = '__drop'; i.style.position = 'fixed'; i.style.left = '-9999px';
      document.body.appendChild(i);
    });
    await page.setInputFiles('#__drop', ptlPath);

    const out = await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const file = (document.querySelector('#__drop') as HTMLInputElement).files![0];
      const gp = (window as any).ptDesktop?.getPathForFile?.(file) ?? '';

      // Dispatch a REAL drop through the app's own window 'drop' handler.
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt }); // not settable via ctor
      window.dispatchEvent(ev);
      for (let i = 0; i < 160 && !c.session.path && !c.confirmSession; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!c.session.path && c.confirmSession) c.applyConfirmedSession();

      // Full chain: a dirty bound session closes without a prompt —
      // beforeunload writes silently and does NOT preventDefault.
      c.session.dirty = true;
      const bu = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(bu);

      return {
        getPathForFile: String(gp),
        docOpen: !!c.getSnapshot().docOpen,
        bound: c.session.path as string | null,
        saveBound: !!c.getSnapshot().saveBound,
        closePrevented: bu.defaultPrevented,
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    check('the preload resolves a real dropped File to its on-disk path',
      out.getPathForFile === ptlPath, `getPathForFile=${JSON.stringify(out.getPathForFile)}`);
    check('a PDF is already open (the doc-open drop branch is under test)',
      out.docOpen === true, `docOpen=${out.docOpen}`);
    check('dropping a .ptl onto the open PDF binds the real silent-write path',
      out.bound === ptlPath, `session.path=${JSON.stringify(out.bound)}`);
    check('autosave is armed after the drop', out.saveBound === true, `saveBound=${out.saveBound}`);
    check('the bound session closes without a save prompt (no preventDefault)',
      out.closePrevented === false, `closePrevented=${out.closePrevented}`);

    // ---- PROBE (non-fatal, reported not asserted): does getPathForFile
    // resolve a File from a FileSystemFileHandle.getFile()? That is the
    // "picker handle" case openRecent uses (entry.handle.getFile()) — the one
    // the binding fork flagged as unverified. We obtain a real handle by
    // pointing the native open dialog at the real .ptl and calling
    // showOpenFilePicker (Electron's FSA routes through it). Timeout-guarded
    // so a non-routing / unsupported picker can't hang the run.
    await eApp.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
    }, ptlPath);
    const handleProbe = await page.evaluate(async (want) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      try {
        const picker = (window as any).showOpenFilePicker;
        if (!picker) return '(no showOpenFilePicker)';
        const picked: any = await Promise.race([
          picker(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
        ]);
        const handle = picked && picked[0];
        if (!handle) return '(no handle returned)';
        const f = await handle.getFile();
        const p = (window as any).ptDesktop?.getPathForFile?.(f);
        return { result: p ? String(p) : '(empty string)', matchesReal: p === want };
      } catch (e: any) {
        return '(could not obtain a picker handle: ' + (e?.message ?? String(e)) + ')';
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }, ptlPath);
    console.log(`\nPROBE  getPathForFile on a FileSystemFileHandle.getFile() File (openRecent's case) = ${JSON.stringify(handleProbe)}`);

    // ---- pickViaInput: opening a .ptl through the <input type=file> fallback
    // must ALSO bind (the same gap — it omitted the path pickFile passes).
    // Drive the real fallback via Playwright's filechooser (no native dialog).
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => !!(window as any).__pt?.controller?.getSnapshot().docOpen,
      undefined, { timeout: 20_000 });
    page.once('filechooser', (fc) => { void fc.setFiles(ptlPath); });
    const pickBound = await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const c = (window as any).__pt.controller;
      c.pickViaInput(); // creates the <input> and clicks it -> filechooser fires
      for (let i = 0; i < 200 && !c.session.path && !c.confirmSession; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!c.session.path && c.confirmSession) c.applyConfirmedSession();
      return c.session.path as string | null;
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    check('opening a .ptl via the <input type=file> fallback binds the path',
      pickBound === ptlPath, `session.path=${JSON.stringify(pickBound)}`);
  } finally {
    await eApp.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error('FAIL  desktopDropBinds errored', e); process.exit(1); });
