// Desktop regression: the app must work ENTIRELY offline. Every HTTP(S)
// request any web contents attempts is cancelled and recorded; the app
// is then exercised end to end (open a PDF from disk, navigate, search,
// save a session through the shell dialog) and the test fails if
// anything broke — or if the app attempted network at all.
//
// Run: npx electron build-node/test/desktopOffline.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-off-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { app, BrowserWindow, dialog } from 'electron';

const attempted: string[] = [];
app.on('web-contents-created', (_event, wc) => {
  wc.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, cb) => {
      attempted.push(details.url);
      cb({ cancel: true });
    },
  );
});

const target = path.join(os.tmpdir(), `pt-offline-save-${Date.now()}.ptl`);
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
      const out = {};
      out.title = document.title;
      // navigate: a jump and an exact back
      pt.jumpVia({ page: 22, yRatio: 0.3 }, 'Definition 4.1');
      await new Promise((r) => setTimeout(r, 400));
      out.jumpedTo = pt.viewer.currentPosition().page;
      // full-text search runs locally
      await pt.controller.runSearch('equivariant');
      await new Promise((r) => setTimeout(r, 1500));
      out.searchCount = pt.controller.getSnapshot().searchCount;
      // pdf.js side data must be served over the app protocol, not the
      // network: CJK (CID-encoded) PDFs need the cMaps to render at all
      out.cmap = (await fetch('pdfjs/cmaps/UniGB-UCS2-H.bcmap')).ok;
      out.stdFont = (await fetch('pdfjs/standard_fonts/FoxitSerif.pfb')).ok;
      // save the session through the (stubbed) shell dialog
      pt.controller.saveProgressSafe();
      await new Promise((r) => setTimeout(r, 2500));
      return out;
    })()`).then((out: {
      title: string; jumpedTo: number; searchCount: string;
      cmap: boolean; stdFont: boolean;
    }) => {
      const saved = fs.existsSync(target)
        && fs.readFileSync(target, 'utf8').startsWith('paper-trail-session v');
      const ok = out.title.includes('WStarCats.pdf')
        && out.jumpedTo === 22
        && /4/.test(out.searchCount)
        && out.cmap && out.stdFont
        && saved
        && attempted.length === 0;
      console.log(`${ok ? 'PASS' : 'FAIL'}  the desktop app works entirely offline`,
        JSON.stringify({ ...out, saved, attemptedNetwork: attempted.slice(0, 5) }));
      try { fs.rmSync(target, { force: true }); } catch { /* fine */ }
      app.exit(ok ? 0 : 1);
    }).catch((e: unknown) => {
      console.error('FAIL  offline regression errored', e);
      app.exit(1);
    });
  }, 14_000);
});
