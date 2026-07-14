// OS shutdown / logout protection. A dirty reading session must survive a
// time-boxed OS shutdown, which the renderer's async close-save can't — so the
// main process guards it: macOS holds the quit in before-quit (preventDefault =
// NSTerminateCancel), Windows vetoes the per-window query-session-end
// (preventDefault returns FALSE to WM_QUERYENDSESSION) and shows the reason
// string registered via ShutdownBlockReasonCreate. Both then drive the SAME
// unsaved-session save dialog as a normal window close.
//
// This exercises the platform's real seam: on Windows the query-session-end
// veto (a real window has a real HWND, so ShutdownBlockReasonCreate runs for
// real when the session goes dirty); on macOS the before-quit veto. A CLEAN
// session must never block the shutdown; a DIRTY one must veto AND surface the
// save dialog, leaving the window open (the stubbed dialog answers Cancel).
//
// Run: npx electron build-node/test/desktopShutdownGuard.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-shutdown-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import * as fs from 'node:fs';
import { app, BrowserWindow, dialog } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

const SAVE_PROMPT = 'Do you want to save your reading session?';

// Record every native prompt; answer Cancel (2) so a veto-driven prompt leaves
// the window open — the veto and its dialog are observed without losing the
// window (and the session stays dirty, so a re-attempt would block again).
const prompts: string[] = [];
(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync =
  (_win: unknown, opts: { message: string }) => { prompts.push(opts.message); return 2; };

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A synthetic OS-shutdown event: records whether the guard vetoed it.
function shutdownEvent(): { prevented: boolean; preventDefault(): void } {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

// The renderer's own save state — a cross-platform barrier. (win.isDocumentEdited()
// is only the macOS close-button flag and never flips on Windows, so it can't be
// used to observe dirtiness here.) That the main process actually received the
// change is proven by the veto itself, below.
async function saveState(win: BrowserWindow): Promise<string> {
  return win.webContents
    .executeJavaScript('window.__pt.controller.getSnapshot().save')
    .catch(() => '') as Promise<string>;
}
async function waitSave(win: BrowserWindow, want: string): Promise<boolean> {
  for (let i = 0; i < 40; i += 1) {
    if ((await saveState(win)) === want) return true;
    await sleep(200);
  }
  return (await saveState(win)) === want;
}

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

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  if (!isWin && !isMac) { check('runs on Windows or macOS only', false, process.platform); return; }
  // Emitting the platform's shutdown signal reaches the guard registered in
  // main.ts (query-session-end on the window; before-quit on the app).
  const fireShutdown = (ev: unknown): void => {
    if (isWin) (win as unknown as { emit(e: string, a: unknown): void }).emit('query-session-end', ev);
    else (app as unknown as { emit(e: string, a: unknown): void }).emit('before-quit', ev);
  };
  const label = isWin ? 'Windows query-session-end' : 'macOS before-quit';

  // ---- A) a CLEAN session must not block the shutdown ----------------------
  await waitSave(win, 'idle');
  const clean = shutdownEvent();
  fireShutdown(clean);
  check(`${label}: a saved/clean session does NOT block OS shutdown`,
    clean.prevented === false, `vetoed=${clean.prevented}`);

  // ---- B) an UNSAVED session must VETO the shutdown ------------------------
  // A never-saved session (no path, no handle) can't be flushed silently, so
  // the guard must fall through to the save dialog.
  await win.webContents.executeJavaScript(`(() => {
    const pt = window.__pt;
    clearTimeout(pt.controller.fileSaveTimer); // no autosave clears dirty under us
    pt.session.handle = null; pt.session.path = null; pt.session.dirty = false;
    pt.jumpVia({ page: 1, yRatio: 0.5 }, 'shutdown-unsaved'); // -> dirty + notify
  })()`);
  check('the change is dirty in the renderer', await waitSave(win, 'dirty'));

  // Fire the shutdown until it vetoes: the retry waits out the pt-document-edited
  // round-trip that populates the main process's editedWindows set, and the veto
  // itself is proof the change reached the main process.
  const promptsBefore = prompts.length;
  let vetoed = false;
  for (let i = 0; i < 40 && !vetoed; i += 1) {
    const ev = shutdownEvent();
    fireShutdown(ev);
    vetoed = ev.prevented;
    if (!vetoed) await sleep(200);
  }
  check(`${label}: an unsaved session VETOES the OS shutdown`, vetoed, `vetoed=${vetoed}`);

  // The veto then drives the normal per-window save dialog.
  for (let i = 0; i < 20 && prompts.length === promptsBefore; i += 1) await sleep(200);
  check('the veto surfaces the same unsaved-session save dialog',
    prompts.slice(promptsBefore).includes(SAVE_PROMPT),
    `new prompts=${JSON.stringify(prompts.slice(promptsBefore))}`);
  check('the window stays open after the veto (the user can still save)',
    !win.isDestroyed());
}

void app.whenReady().then(() => run().then(() => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}).catch((e: unknown) => {
  console.error('FAIL  desktopShutdownGuard errored', e);
  app.exit(1);
}));
