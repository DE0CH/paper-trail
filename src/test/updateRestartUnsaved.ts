// Restart to Update must respect unsaved reading progress. With a
// downloaded update ready and a dirty session open, clicking "Restart
// to Update" has to raise the standard save prompt — and answering
// Cancel or Save… must abandon the restart cleanly: the document
// window stays open, the update window returns to its ready state, and
// nothing half-quits. Save… must additionally write the session file.
// The native prompts are stubbed, so nothing appears on screen.
//
// Run (CI, macOS): npx electron build-node/test/updateRestartUnsaved.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-updrst-'));
process.env.PT_SHOT = '1'; // show without stealing focus
process.env.PT_UPDATE_URL = 'http://127.0.0.1:8772';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, Menu } from 'electron';

// Stub the native prompts before the shell registers its handlers.
// The unsaved-session prompt is synchronous; its answer is switched
// per phase (2 = Cancel, 0 = Save…).
let closeChoice = 2;
const prompts: string[] = [];
(dialog as { showMessageBoxSync: unknown }).showMessageBoxSync =
  (...args: unknown[]) => {
    const opts = (args.length > 1 ? args[1] : args[0]) as { message: string };
    prompts.push(opts.message);
    return closeChoice;
  };
// Save… on an unbound session falls back to the shell-side save dialog.
const savedTo = path.join(os.tmpdir(), `pt-upd-unsaved-${Date.now()}.ptl`);
(dialog as { showSaveDialog: unknown }).showSaveDialog =
  async () => ({ canceled: false, filePath: savedTo });

// A fake update feed, live from the start: the launch-time background
// check downloads it, so the update is ready the moment it matters.
const FEED_VERSION = '99.0.0';
const zipBytes = crypto.randomBytes(64 * 1024);
const sha512 = crypto.createHash('sha512').update(zipBytes).digest('base64');
const yml = [
  `version: ${FEED_VERSION}`,
  'files:',
  `  - url: update-${FEED_VERSION}-mac.zip`,
  `    sha512: ${sha512}`,
  `    size: ${zipBytes.length}`,
  `path: update-${FEED_VERSION}-mac.zip`,
  `sha512: ${sha512}`,
  "releaseDate: '2026-01-01T00:00:00.000Z'",
].join('\n');
const server = http.createServer((req, res) => {
  const name = (req.url ?? '').split('/').pop() ?? '';
  if (name.startsWith('latest')) {
    res.writeHead(200, { 'content-type': 'text/yaml' });
    res.end(yml);
  } else if (name.endsWith('.zip')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(zipBytes);
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});
server.listen(8772, '127.0.0.1');

process.argv.push(path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function updateWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()
    .find((w) => !w.isDestroyed() && w.webContents.getURL().includes('update.html'));
}

async function readState(w: BrowserWindow): Promise<string> {
  return await w.webContents.executeJavaScript(
    `document.getElementById('pt-update-root')?.dataset.state ?? ''`) as string;
}

async function waitFor<T>(get: () => Promise<T> | T, want: (v: T) => boolean,
  ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  let v = await get();
  while (!want(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    v = await get();
  }
  return v;
}

const SAVE_PROMPT = 'Do you want to save your reading session?';

async function run(): Promise<void> {
  const main = BrowserWindow.getAllWindows()[0];

  // Unsaved reading progress: a navigation dirties the session.
  await main.webContents.executeJavaScript(
    `window.__pt.jumpVia({ page: 2, yRatio: 0 }, 'unsaved-repro')`);
  await new Promise((r) => setTimeout(r, 1000));

  Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click();
  const uw = await waitFor(updateWindow, (w) => !!w, 15_000);
  if (!uw) {
    console.error('FAIL  the Software Update window never opened');
    app.exit(1);
    return;
  }
  // The background download races the click; go through Update Now if
  // it hasn't finished yet.
  let state = await waitFor(() => readState(uw),
    (s) => s === 'available' || s === 'downloaded', 60_000);
  if (state === 'available') {
    await uw.webContents.executeJavaScript(
      `document.getElementById('pt-update-primary')?.click()`);
    state = await waitFor(() => readState(uw), (s) => s === 'downloaded', 120_000);
  }
  check('the update is ready (state: downloaded)', state === 'downloaded', state);

  // Phase 1 — Cancel at the save prompt abandons the restart cleanly.
  closeChoice = 2;
  await uw.webContents.executeJavaScript(
    `document.getElementById('pt-update-primary')?.click()`);
  await new Promise((r) => setTimeout(r, 4000));
  check('Restart to Update raises the save prompt',
    prompts.some((m) => m === SAVE_PROMPT), prompts.join(' | ') || '(none)');
  check('Cancel keeps the document window open',
    !main.isDestroyed());
  check('Cancel keeps the update window open',
    updateWindow() !== undefined);
  check('the update window returns to its ready state after Cancel',
    (await waitFor(() => readState(uw), (s) => s === 'downloaded', 5_000)) === 'downloaded');
  check('no window was lost along the way',
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 2);

  // Phase 2 — Save… writes the session and equally abandons the restart.
  prompts.length = 0;
  closeChoice = 0;
  await uw.webContents.executeJavaScript(
    `document.getElementById('pt-update-primary')?.click()`);
  await new Promise((r) => setTimeout(r, 5000));
  check('the save prompt appears again on the next restart attempt',
    prompts.some((m) => m === SAVE_PROMPT), prompts.join(' | ') || '(none)');
  const header = fs.existsSync(savedTo)
    ? fs.readFileSync(savedTo, 'utf8').split('\n')[0] : null;
  check('Save… really writes the session file',
    header === 'paper-trail-session v1', String(header));
  check('Save… keeps the document window open', !main.isDestroyed());
  check('the update window is still ready after Save…',
    updateWindow() !== undefined
      && (await readState(uw)) === 'downloaded');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  try { fs.rmSync(savedTo, { force: true }); } catch { /* fine */ }
  server.close();
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  update restart with unsaved session errored', e);
      app.exit(1);
    });
  }, 14_000);
});
