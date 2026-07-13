// Desktop close behaviour. When autosave is ON (the session is bound to a
// .ptl path on disk) and the user closes the window before the next
// auto-save fires, it must NOT prompt "Do you want to save?" — the window
// closes AT ONCE and the change is flushed in the background (the main
// process writes the file after the window is gone). A session with NO
// silent write target still prompts, so unsaved progress is never lost.
//
// Both cases run in one window: the stubbed prompt answers Cancel, which
// keeps the window open, so a prompt that fires is observed without losing
// the window; the second (bound) close must then close with no prompt.
//
// Run: npx electron build-node/test/desktopCloseAutosave.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-close-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { app, BrowserWindow, dialog } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

const SAVE_PROMPT = 'Do you want to save your reading session?';
const ptlPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'pt-closefile-')), 'reading.ptl');
// A path whose parent directory does not exist: writeFileSync fails, so the
// close-flush fails and must fall back to the normal save prompt.
const unwritablePath = path.join(os.tmpdir(), 'pt-close-NO-SUCH-DIR', 'nested', 'reading.ptl');

// Record every native prompt; answer Cancel (2) so a prompt that DOES fire
// leaves the window open — we keep driving instead of losing it.
const prompts: string[] = [];
(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync =
  (_win: unknown, opts: { message: string }) => { prompts.push(opts.message); return 2; };

// Keep the process alive after the last window closes so the assertions
// finish (the background flush is synchronous, so it has already landed).
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
  // Wait for the first window and its __pt hooks.
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

  // Open a PDF so the window has a document (and a session to bind).
  await win.webContents.executeJavaScript(`(async () => {
    const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
    await window.__pt.controller.openFile(new File([bytes], 'cjk.pdf'));
  })()`);
  await sleep(1200);

  // ---- 1) regression: an UNBOUND dirty session still prompts on close ----
  await win.webContents.executeJavaScript(`(() => {
    const pt = window.__pt;
    pt.session.path = null; pt.session.handle = null; // no silent target
    pt.session.dirty = false;
    pt.jumpVia({ page: 1, yRatio: 0.4 }, 'unbound-change'); // -> dirty
    return pt.session.dirty;
  })()`);
  const promptsBeforeUnbound = prompts.length;
  win.close(); // beforeunload prevents -> prompt (stub Cancel keeps it open)
  await sleep(1500);
  check('an unbound dirty session still prompts on close (no regression)',
    prompts.length > promptsBeforeUnbound && prompts.includes(SAVE_PROMPT),
    `prompts=${prompts.length}`);
  check('after Cancel the unbound window stayed open',
    !win.isDestroyed());
  if (win.isDestroyed()) return;

  // ---- 2) FAILURE: a path-bound close whose write FAILS falls back to the
  //         normal save prompt; the window stays and the change is NOT lost.
  await win.webContents.executeJavaScript(`(() => {
    const pt = window.__pt;
    pt.session.path = ${JSON.stringify(unwritablePath)}; // parent dir missing -> write fails
    pt.session.dirty = false;
    pt.jumpVia({ page: 1, yRatio: 0.6 }, 'failwrite-change'); // -> dirty
    return pt.session.dirty;
  })()`);
  const promptsBeforeFail = prompts.length;
  win.close(); // sync write fails -> beforeunload preventDefault -> prompt (Cancel keeps it)
  await sleep(1500);
  check('a FAILED background write brings back the normal save prompt',
    prompts.length > promptsBeforeFail && prompts.includes(SAVE_PROMPT),
    `prompts=${prompts.length}`);
  check('after a failed write the window stayed open (change not lost)',
    !win.isDestroyed());
  const stillDirty = await win.webContents
    .executeJavaScript('window.__pt.session.dirty').catch(() => false);
  check('after a failed write the unsaved change is preserved (still dirty)',
    stillDirty === true, `dirty=${stillDirty}`);
  if (win.isDestroyed()) return;

  // ---- 3) SUCCESS: a PATH-BOUND session closes with NO prompt + bg save ----
  fs.rmSync(ptlPath, { force: true });
  await win.webContents.executeJavaScript(`(() => {
    const pt = window.__pt;
    pt.session.path = ${JSON.stringify(ptlPath)}; // autosave target on disk
    pt.jumpVia({ page: 1, yRatio: 0.8 }, 'bound-change'); // fresh unsaved change
    return { dirty: pt.session.dirty, path: pt.session.path };
  })()`);
  const promptsBeforeBound = prompts.length;
  win.close(); // beforeunload flushes to main + does NOT prevent -> closes
  for (let i = 0; i < 24 && !win.isDestroyed(); i += 1) await sleep(250);

  check('the autosave-bound window closed at once (no prompt blocked it)',
    win.isDestroyed());
  check('closing an autosave-bound session showed NO save prompt',
    prompts.length === promptsBeforeBound,
    `new prompts=${prompts.length - promptsBeforeBound}`);
  let text = '';
  for (let i = 0; i < 24; i += 1) {
    if (fs.existsSync(ptlPath)) {
      text = fs.readFileSync(ptlPath, 'utf8');
      if (text.includes('bound-change')) break;
    }
    await sleep(250);
  }
  check('the change was flushed to the bound file in the background',
    text.includes('bound-change'), text ? `${text.length} bytes on disk` : '(no file written)');
}

void app.whenReady().then(() => run().then(() => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}).catch((e: unknown) => {
  console.error('FAIL  desktopCloseAutosave errored', e);
  app.exit(1);
}));
