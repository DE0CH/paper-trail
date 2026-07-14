// Async close-and-save (desktop). The renderer's beforeunload CANCELS a dirty
// close and hands off to an async save while the window is held open; on
// success it closes silently, on failure it shows the native dialog. Because
// the save is async it can use the HANDLE write (createWritable), not just a
// path — so a HANDLE-bound session (opened via Open Recent, no on-disk path)
// now closes silently too. That handle case is the regression this pins:
// before the async flow it fell through to the "save?" prompt.
//
// The handle is a REAL FileSystemFileHandle from OPFS (navigator.storage) —
// not a stub — so the actual createWritable/write/close path runs for real.
//
// Run: npx electron build-node/test/desktopCloseAsync.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-close-async-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import * as fs from 'node:fs';
import { app, BrowserWindow, dialog } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

const SAVE_PROMPT = 'Do you want to save your reading session?';

// Record every native prompt; answer Cancel (2) so a prompt that DOES fire
// leaves the window open (a hollow-close regression is caught, not lost).
const prompts: string[] = [];
(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync =
  (_win: unknown, opts: { message: string }) => { prompts.push(opts.message); return 2; };

// Keep the process alive after the last window closes so assertions finish.
app.on('before-quit', (e) => e.preventDefault());

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pdfB64 = fs
  .readFileSync(path.resolve(__dirname, '..', '..', 'sample', 'cjk.pdf'))
  .toString('base64');

async function run(): Promise<void> {
  let win: BrowserWindow | undefined;
  for (let i = 0; i < 80 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0];
    if (!win) await sleep(500);
  }
  if (!win) { check('a window opened', false); return; }
  for (let i = 0; i < 80; i += 1) {
    const ready = await win.webContents
      .executeJavaScript('!!(window.__pt && window.__pt.controller && window.__pt.jumpVia)')
      .catch(() => false);
    if (ready) break;
    await sleep(500);
  }

  await win.webContents.executeJavaScript(`(async () => {
    const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
    await window.__pt.controller.openFile(new File([bytes], 'cjk.pdf'));
  })()`);
  await sleep(1200);

  // OPFS must be available (secure context) for the real-handle tests.
  const opfsOk = await win.webContents
    .executeJavaScript('!!(navigator.storage && navigator.storage.getDirectory)').catch(() => false);
  check('OPFS available for a real FileSystemFileHandle', !!opfsOk);
  if (!opfsOk) return;

  // ---- A) the async HANDLE write actually persists (real createWritable) ----
  const wrote = await win.webContents.executeJavaScript(`(async () => {
    const dir = await navigator.storage.getDirectory();
    const h = await dir.getFileHandle('reading.ptl', { create: true });
    const pt = window.__pt;
    pt.session.handle = h; pt.session.path = null; pt.session.dirty = false;
    pt.jumpVia({ page: 1, yRatio: 0.4 }, 'handle-write-A'); // -> dirty
    await pt.writeProgress();                               // async handle write
    const back = await (await h.getFile()).text();
    return { dirty: pt.session.dirty, has: back.includes('handle-write-A'), len: back.length };
  })()`) as { dirty: boolean; has: boolean; len: number };
  check('a handle-bound async write persists to the file (real createWritable)',
    wrote.has, `${wrote.len} bytes; contains change=${wrote.has}`);
  check('a successful handle write clears dirty', wrote.dirty === false, `dirty=${wrote.dirty}`);

  // ---- B) REGRESSION: a dirty HANDLE-bound session closes SILENTLY ----------
  // Before the async flow this prompted (beforeunload keyed on session.path,
  // which is null for a handle binding). Now closeAndSave writes via the handle
  // and closes with no prompt.
  await win.webContents.executeJavaScript(`(() => {
    const pt = window.__pt;
    clearTimeout(pt.controller.fileSaveTimer); // no stray auto-save clearing dirty under us
    pt.jumpVia({ page: 1, yRatio: 0.9 }, 'handle-close-B'); // fresh dirty change (handle still bound)
    return { dirty: pt.session.dirty, hasHandle: !!pt.session.handle, path: pt.session.path };
  })()`);
  const promptsBefore = prompts.length;
  win.close();
  for (let i = 0; i < 40 && !win.isDestroyed(); i += 1) await sleep(250);

  check('a dirty HANDLE-bound session closed silently (window is gone)',
    win.isDestroyed());
  check('closing a handle-bound session showed NO save prompt',
    prompts.length === promptsBefore,
    `new prompts=${prompts.length - promptsBefore}${prompts.includes(SAVE_PROMPT) ? ' (SAVE_PROMPT fired)' : ''}`);
}

void app.whenReady().then(() => run().then(() => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}).catch((e: unknown) => {
  console.error('FAIL  desktopCloseAsync errored', e);
  app.exit(1);
}));
