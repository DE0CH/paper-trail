// writeProgress must NOT mark the session clean when the write FAILS. A
// failed auto-save that cleared dirty would silently lose the change — the
// exact data loss the owner is worried about, on the TIMER auto-save path
// (a bound path whose disk write fails, or a handle whose write throws).
//
// Run: npx electron build-node/test/desktopWriteFailKeepsDirty.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-wfd-'));
process.env.PT_SHOT = '1';

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { app, BrowserWindow } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

const writablePath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'pt-wfd-ok-')), 'ok.ptl');
// Parent directory does not exist -> the main process's write returns false.
const unwritablePath = path.join(os.tmpdir(), 'pt-wfd-NO-SUCH-DIR', 'x.ptl');

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
      .executeJavaScript('!!(window.__pt && window.__pt.controller)')
      .catch(() => false);
    if (ready) break;
    await sleep(500);
  }

  const out = await win.webContents.executeJavaScript(`(async () => {
    const pt = window.__pt;
    const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
    await pt.controller.openFile(new File([bytes], 'cjk.pdf'));
    await new Promise((r) => setTimeout(r, 800));
    const r = {};

    // 1) a SUCCESSFUL write to a writable path clears dirty
    pt.session.handle = null;
    pt.session.path = ${JSON.stringify(writablePath)};
    pt.session.saving = false; pt.session.dirty = true;
    await pt.controller.writeProgress();
    r.successCleared = pt.session.dirty === false;

    // 2) a FAILED path write leaves the change dirty (main returns false)
    pt.session.path = ${JSON.stringify(unwritablePath)};
    pt.session.saving = false; pt.session.dirty = true;
    await pt.controller.writeProgress();
    r.pathFailureKeptDirty = pt.session.dirty === true;

    // 3) a THROWN handle write leaves the change dirty
    pt.session.path = null;
    pt.session.handle = {
      kind: 'file', name: 'x.ptl',
      createWritable: async () => ({ async write() { throw new Error('boom'); }, async close() {} }),
    };
    pt.session.saving = false; pt.session.dirty = true;
    try { await pt.controller.writeProgress(); } catch (e) { /* throw is expected */ }
    r.handleThrowKeptDirty = pt.session.dirty === true;

    pt.session.handle = null; pt.session.path = null; pt.session.dirty = false; // quit clean
    return r;
  })()`);

  check('a successful write clears dirty', out.successCleared === true);
  check('a FAILED path write leaves the change dirty (not silently lost)',
    out.pathFailureKeptDirty === true);
  check('a THROWN handle write leaves the change dirty',
    out.handleThrowKeptDirty === true);
  check('the writable path actually received the successful write',
    fs.existsSync(writablePath));
}

void app.whenReady().then(() => run().then(() => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}).catch((e: unknown) => {
  console.error('FAIL  desktopWriteFailKeepsDirty errored', e);
  app.exit(1);
}));
