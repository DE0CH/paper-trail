// Desktop regression: saving a reading session must NOT register the file
// with the OS "Open Recent" list. macOS's app.addRecentDocument reaches into
// AppKit's noteNewRecentDocumentURL, and LaunchServices then touches the
// containing folder to build the entry — which trips the folder-level TCC
// gate and pops "Paper Trail.app would like to access files in your Documents
// folder" right after a Save-panel-blessed write. Paper Trail keeps its own
// in-app Recent list, so the OS registration is pure redundant prompt-bait.
// This pins that no addRecentDocument call happens on the save path (nor on
// the initial OS-open of the PDF): the spy must see ZERO calls while the
// .ptl still lands on disk. (The dead "Open Recent" menu item is removed in
// the same fix, but the built app menu isn't reliably introspectable from
// this harness — so the spy count, which cleanly discriminates fixed from
// unfixed, is the guard here.)
//
// Run: npx electron build-node/test/desktopNoRecentDoc.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-norecent-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { app, BrowserWindow, dialog } from 'electron';

const target = path.join(os.tmpdir(), `pt-norecent-test-${Date.now()}.ptl`);

// Count every OS "Open Recent" registration. Spy BEFORE the shell requires
// main.js and wires its handlers, so nothing slips past.
const recentCalls: string[] = [];
(app as { addRecentDocument: (p: string) => void }).addRecentDocument =
  (p: string) => { recentCalls.push(p); };

// Stub the native save panel before the shell registers its handler.
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
      pt.jumpVia({ page: 3, yRatio: 0 }, 'norecent-repro');
      pt.controller.saveProgressSafe(); // like the menu: no user activation
      await new Promise((r) => setTimeout(r, 2500));
      return document.getElementById('toast')?.textContent ?? '(no toast)';
    })()`).then((toast: string) => {
      const exists = fs.existsSync(target);
      const header = exists ? fs.readFileSync(target, 'utf8').split('\n')[0] : null;
      const wrote = exists && header === 'paper-trail-session v2';

      const ok = wrote && recentCalls.length === 0;
      console.log(`${ok ? 'PASS' : 'FAIL'}  save writes the .ptl without any OS Open-Recent registration`,
        JSON.stringify({ toast, exists, header, recentCalls }));
      try { fs.rmSync(target, { force: true }); } catch { /* fine */ }
      app.exit(ok ? 0 : 1);
    }).catch((e: unknown) => {
      console.error('FAIL  desktop no-recent-document regression errored', e);
      app.exit(1);
    });
  }, 14_000);
});
