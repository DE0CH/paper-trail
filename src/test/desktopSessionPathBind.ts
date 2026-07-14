// Desktop regression: opening a .ptl session from the OS (double-click)
// and then its PDF must BIND the session to the .ptl's on-disk path, so
// auto-save writes back silently and a manual Save does not pop the
// "where do you want to save?" dialog. There is no FileSystemFileHandle
// for a file the shell handed us, so the binding is by path
// (pt-save-session-to-path). Before the fix the session stayed unbound
// (handle null, no path) — auto-save was off and Save prompted.
//
// Run: npx electron build-node/test/desktopSessionPathBind.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-spb-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { app, BrowserWindow, dialog } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

// A BOUND session must never reach the save-location dialog. Auto-cancel
// it so the test can never block: with the fix the dialog is never used
// (the path binding saves silently); WITHOUT the fix an unbound Save
// falls through to this dialog — cancelling it makes that path a clean
// no-write failure instead of a hang.
(dialog as { showSaveDialog: unknown }).showSaveDialog =
  async () => ({ canceled: true, filePath: undefined });

const pdfBytes = fs.readFileSync(path.resolve(__dirname, '..', '..', 'sample', 'cjk.pdf'));
const pdfB64 = pdfBytes.toString('base64');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-spb-files-'));
const ptlPath = path.join(tmpDir, 'reading.ptl');
const pdfPath = path.join(tmpDir, 'cjk.pdf');
fs.writeFileSync(pdfPath, pdfBytes);

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function waitForPt(win: BrowserWindow, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ready = await win.webContents.executeJavaScript(
      `!!(window.__pt && window.__pt.controller)`).catch(() => false);
    if (ready) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

void app.whenReady().then(() => {
  setTimeout(() => { void run(); }, 14_000);
});

async function run(): Promise<void> {
  try {
    const win = BrowserWindow.getAllWindows()[0];

    // Phase 1: produce a genuine .ptl for this PDF, write it to disk.
    const sessionText = await win.webContents.executeJavaScript(`(async () => {
      const pt = window.__pt;
      const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
      await pt.controller.openFile(new File([bytes], 'cjk.pdf'));
      await new Promise((r) => setTimeout(r, 1000));
      pt.jumpVia({ page: 1, yRatio: 0.4 }, 'seed entry');
      return pt.progressText();
    })()`) as string;
    fs.writeFileSync(ptlPath, sessionText, 'utf8');
    const original = fs.readFileSync(ptlPath, 'utf8');

    // Clear the Phase-1 session's dirty flag before reloading. Reload here is
    // only a state reset, but it fires beforeunload — and a dirty, never-saved
    // session would drive the async close-save (confirmCloseSave), whose native
    // dialog blocks this headless run forever. [owner-authorized harness fix]
    await win.webContents.executeJavaScript(
      `(() => { if (window.__pt && window.__pt.session) window.__pt.session.dirty = false; })()`);

    // Fresh, empty window state for the OS-open flow.
    win.webContents.reload();
    await waitForPt(win, 30_000);
    await new Promise((r) => setTimeout(r, 1000));

    // Phase 2: OS-open the .ptl (carrying its real path), then the PDF —
    // the shell delivers both with a `path` and no handle.
    const bound = await win.webContents.executeJavaScript(`(async () => {
      const pt = window.__pt;
      const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
      await pt.controller.openFile(
        new File([${JSON.stringify(sessionText)}], 'reading.ptl'), null, ${JSON.stringify(ptlPath)});
      await new Promise((r) => setTimeout(r, 500));
      await pt.controller.openFile(new File([bytes], 'cjk.pdf'), null, ${JSON.stringify(pdfPath)});
      await new Promise((r) => setTimeout(r, 800));
      const s = pt.controller.getSnapshot();
      return { saveBound: s.saveBound, save: s.save, docOpen: !!pt.session };
    })()`) as { saveBound: boolean; save: string };
    check('the OS-opened .ptl+PDF session is bound for saving',
      bound.saveBound === true, `saveBound=${bound.saveBound} save=${bound.save}`);

    // Phase 3: a change must AUTO-SAVE back to the .ptl silently.
    await win.webContents.executeJavaScript(`(async () => {
      const pt = window.__pt;
      pt.jumpVia({ page: 1, yRatio: 0.7 }, 'change after reopen');
    })()`);
    await new Promise((r) => setTimeout(r, 2800)); // past the 1.5s debounce
    const afterAuto = fs.readFileSync(ptlPath, 'utf8');
    check('auto-save wrote back to the .ptl file (no prompt)',
      afterAuto !== original, afterAuto === original ? 'file unchanged' : 'file updated');

    // Phase 4: manual Save writes to the .ptl WITHOUT a dialog (a dialog
    // would block here and the test would time out).
    const savedText = 'x'; void savedText;
    await win.webContents.executeJavaScript(`(async () => {
      const pt = window.__pt;
      pt.jumpVia({ page: 1, yRatio: 0.55 }, 'change before manual save');
      await pt.controller.saveProgress();
      await new Promise((r) => setTimeout(r, 300));
    })()`);
    const afterManual = fs.readFileSync(ptlPath, 'utf8');
    check('manual Save wrote to the bound .ptl without a dialog',
      afterManual !== afterAuto, 'file updated again');

    // Let the harness quit without an unsaved prompt.
    await win.webContents.executeJavaScript(
      `(async () => { window.__pt.session.dirty = false; })()`);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    app.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error('FAIL  desktop session path-bind test errored', e);
    app.exit(1);
  }
}
