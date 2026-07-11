// Desktop regression: reopening a PDF + session pair from Recents must
// re-arm continuous auto-save. Handles restored from IndexedDB come
// back with permission state "prompt"; in the browser the auto-save
// timer must never prompt, so it skips — but the desktop shell has no
// permission UI at all (requests are granted invisibly), so skipping
// there just leaves auto-save silently off until a manual save.
//
// Run: npx electron build-node/test/desktopAutosave.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-as-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import * as fs from 'node:fs';
import { app, BrowserWindow } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

const pdfB64 = fs
  .readFileSync(path.resolve(__dirname, '..', '..', 'sample', 'cjk.pdf'))
  .toString('base64');

void app.whenReady().then(() => {
  setTimeout(() => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.executeJavaScript(`(async () => {
      const pt = window.__pt;
      const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
      // open the PDF once to produce a genuine session file for it
      await pt.controller.openFile(new File([bytes], 'cjk.pdf'));
      await new Promise((r) => setTimeout(r, 1000));
      pt.jumpVia({ page: 1, yRatio: 0.4 }, 'seed entry');
      const sessionText = pt.progressText();
      // fake handles that behave like handles restored from IndexedDB:
      // each permission mode starts at 'prompt' and is granted on
      // request (Chromium tracks read and readwrite separately)
      const written = [];
      const mkHandle = (name, file) => {
        const state = { read: 'prompt', readwrite: 'prompt' };
        const mode = (d) => (d && d.mode) || 'read';
        return {
          kind: 'file', name,
          queryPermission: async (d) => state[mode(d)],
          requestPermission: async (d) => { state[mode(d)] = 'granted'; return 'granted'; },
          getFile: async () => file(),
          createWritable: async () => ({
            async write(t) { written.push(t); },
            async close() {},
          }),
        };
      };
      const pdfHandle = mkHandle('cjk.pdf', () => new File([bytes], 'cjk.pdf'));
      const sessHandle = mkHandle('cjk.ptl', () => new File([sessionText], 'cjk.ptl'));
      await pt.controller.openRecent({
        fp: 'autosave-test', name: 'cjk.pdf', ts: Date.now(),
        handle: pdfHandle, progressHandle: sessHandle,
      });
      await new Promise((r) => setTimeout(r, 1000));
      const openedWithSession = pt.hist.active.entries.length >= 2;
      pt.jumpVia({ page: 1, yRatio: 0.7 }, 'change after reopen');
      await new Promise((r) => setTimeout(r, 2800)); // past the 1.5s debounce
      const out = {
        openedWithSession,
        autosaves: written.length,
        dirty: pt.session.dirty,
      };
      pt.session.dirty = false; // let the harness quit without a prompt
      return out;
    })()`).then((out: { openedWithSession: boolean; autosaves: number; dirty: boolean }) => {
      const ok = out.openedWithSession && out.autosaves >= 1 && !out.dirty;
      console.log(`${ok ? 'PASS' : 'FAIL'}  reopening from Recents re-arms desktop auto-save`,
        JSON.stringify(out));
      app.exit(ok ? 0 : 1);
    }).catch((e: unknown) => {
      console.error('FAIL  desktop auto-save regression errored', e);
      app.exit(1);
    });
  }, 14_000);
});
