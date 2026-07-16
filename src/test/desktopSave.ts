// Desktop regression: menu-triggered actions carry no user activation,
// so the renderer's file pickers throw SecurityError. Saving an unbound
// session from the menu must fall back to a shell-side save dialog.
// dialog.showSaveDialog is stubbed to a temp path so nothing native
// appears; the check is that the .ptl really lands on disk.
//
// Run: npx electron build-node/test/desktopSave.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-dsave-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { app, BrowserWindow, dialog } from 'electron';

const target = path.join(os.tmpdir(), `pt-save-test-${Date.now()}.ptl`);
// Stub the native dialog before the shell registers its handler.
(dialog as { showSaveDialog: unknown }).showSaveDialog =
  async () => ({ canceled: false, filePath: target });

process.argv.push(path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

void app.whenReady().then(() => {
  setTimeout(() => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.executeJavaScript(`(async () => {
      const pt = window.__pt;
      pt.jumpVia({ page: 3, yRatio: 0 }, 'save-repro');
      pt.controller.saveProgressSafe(); // like the menu: no user activation
      await new Promise((r) => setTimeout(r, 2500));
      return document.getElementById('toast')?.textContent ?? '(no toast)';
    })()`).then((toast: string) => {
      const exists = fs.existsSync(target);
      const header = exists ? fs.readFileSync(target, 'utf8').split('\n')[0] : null;
      const ok = exists && header === 'paper-trail-session v2';
      console.log(`${ok ? 'PASS' : 'FAIL'}  menu save without user activation writes the session`,
        JSON.stringify({ toast, exists, header }));
      try { fs.rmSync(target, { force: true }); } catch { /* fine */ }
      app.exit(ok ? 0 : 1);
    }).catch((e: unknown) => {
      console.error('FAIL  desktop save regression errored', e);
      app.exit(1);
    });
  }, 14_000);
});
