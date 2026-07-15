// Cancel on the unsaved-close dialog must KEEP the window open, change intact.
// A dirty, NEVER-SAVED session (no path, no handle) can't be saved silently, so
// the async close flow asks via the native confirm dialog. Answering Cancel
// must ABORT the close: the window stays and the unsaved change is preserved.
// This pins the bug where clicking Cancel closed the window anyway.
//
// Run: npx electron build-node/test/desktopCloseCancelKeepsWindow.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-cancel-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import * as fs from 'node:fs';
import { app, BrowserWindow, dialog } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

const SAVE_PROMPT = 'Do you want to save your reading session?';

// The user answers Cancel (button index 2) at the unsaved-close dialog.
const prompts: string[] = [];
(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync =
  (_win: unknown, opts: { message: string }) => { prompts.push(opts.message); return 2; };
// Async twin of the stub above (the close prompt is an async dialog): same
// recording, same Cancel answer.
(dialog as unknown as { showMessageBox: unknown }).showMessageBox =
  async (_win: unknown, opts: { message: string }) => {
    prompts.push(opts.message);
    return { response: 2, checkboxChecked: false };
  };

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

  // A DIRTY, NEVER-SAVED session: no path, no handle, so the close can't save
  // silently and must ask.
  await win.webContents.executeJavaScript(`(async () => {
    const pt = window.__pt;
    const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
    await pt.controller.openFile(new File([bytes], 'cjk.pdf'));
    await new Promise((r) => setTimeout(r, 800));
    clearTimeout(pt.controller.fileSaveTimer); // no stray auto-save clearing dirty under us
    pt.session.handle = null; pt.session.path = null;
    pt.jumpVia({ page: 1, yRatio: 0.5 }, 'unsaved change'); // -> dirty, unbound
  })()`);
  await sleep(300);

  const state = await win.webContents.executeJavaScript(
    `({ dirty: window.__pt.session.dirty, hasHandle: !!window.__pt.session.handle, path: window.__pt.session.path })`,
  ) as { dirty: boolean; hasHandle: boolean; path: string | null };
  check('precondition: session is dirty and unbound (no path, no handle)',
    state.dirty === true && !state.hasHandle && !state.path,
    `dirty=${state.dirty} handle=${state.hasHandle} path=${state.path}`);

  const promptsBefore = prompts.length;
  win.close();
  // Give the async close flow time to run the dialog and act on the choice.
  for (let i = 0; i < 24; i += 1) { if (win.isDestroyed()) break; await sleep(250); }

  check('the unsaved-close confirm dialog fired',
    prompts.length > promptsBefore && prompts.includes(SAVE_PROMPT),
    `new prompts=${prompts.length - promptsBefore}`);
  check('Cancel KEEPS the window open (not destroyed)',
    !win.isDestroyed(), win.isDestroyed() ? 'window was destroyed' : 'window still open');

  if (!win.isDestroyed()) {
    const stillDirty = await win.webContents
      .executeJavaScript('window.__pt.session.dirty').catch(() => null);
    check('the unsaved change is preserved after Cancel', stillDirty === true, `dirty=${stillDirty}`);
    // Clear dirty so the harness can exit without another prompt.
    await win.webContents.executeJavaScript('window.__pt.session.dirty = false').catch(() => {});
  }
}

void app.whenReady().then(() => run().then(() => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}).catch((e: unknown) => {
  console.error('FAIL  desktopCloseCancelKeepsWindow errored', e);
  app.exit(1);
}));
