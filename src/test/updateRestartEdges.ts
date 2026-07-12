// Edge cases around "Restart to Update" and the unsaved-session
// prompt, past what updateRestartUnsaved covers:
//   - after Restart → Cancel, closing the update window and clicking
//     "Check for Updates…" again lands directly on the ready state —
//     Restart to Update stays available;
//   - a second document window survives the whole Cancel round trip
//     (the dirty window prompts first, so nothing is lost);
//   - clicking Restart again raises the prompt again, and answering
//     Don't Save this time lets the restart proceed: the document
//     windows really close, with no further prompt.
// Native prompts are stubbed; nothing appears on screen.
//
// Run (CI, macOS): npx electron build-node/test/updateRestartEdges.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-rstedge-'));
process.env.PT_SHOT = '1'; // show without stealing focus
process.env.PT_UPDATE_URL = 'http://127.0.0.1:8775';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, Menu } from 'electron';

// electron-updater in a dev (unpackaged) run reads dev-app-update.yml
// from the app path for its cache-directory name even though the feed
// itself comes from PT_UPDATE_URL — without it the download rejects
// with ENOENT before it starts. Provide one next to the entry module.
fs.writeFileSync(path.join(__dirname, 'dev-app-update.yml'),
  'provider: generic\nurl: http://127.0.0.1:8775\nupdaterCacheDirName: pt-rstedge-harness\n');

// Stub the unsaved-session prompt before the shell registers handlers;
// the answer switches per phase (2 = Cancel, 1 = Don't Save).
let closeChoice = 2;
const prompts: string[] = [];
(dialog as { showMessageBoxSync: unknown }).showMessageBoxSync =
  (...args: unknown[]) => {
    const opts = (args.length > 1 ? args[1] : args[0]) as { message: string };
    prompts.push(opts.message);
    return closeChoice;
  };

// The dev build cannot really install the fake update: once the
// restart legitimately proceeds, quitAndInstall would tear the app
// down mid-test. Keep the process alive; the assertions only concern
// what happens up to that point.
let allowQuit = false;

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
server.listen(8775, '127.0.0.1');

process.argv.push(path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

app.on('before-quit', (e) => {
  if (!allowQuit) e.preventDefault();
});

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

function docWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed() && !w.webContents.getURL().includes('update.html'));
}

async function readState(w: BrowserWindow): Promise<string> {
  return await w.webContents.executeJavaScript(
    `document.getElementById('pt-update-root')?.dataset.state ?? ''`) as string;
}

async function clickPrimary(w: BrowserWindow): Promise<void> {
  await w.webContents.executeJavaScript(
    `document.getElementById('pt-update-primary')?.click()`);
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
  const main = docWindows()[0];
  await main.webContents.executeJavaScript(
    `window.__pt.jumpVia({ page: 2, yRatio: 0 }, 'edge-repro')`);

  // A second, clean window: it must survive a canceled restart.
  app.emit('second-instance', {}, [process.execPath, '--new-window'], {});
  await waitFor(() => docWindows().length, (n) => n === 2, 15_000);
  check('a second window opened for the scenario', docWindows().length === 2);

  Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click();
  const uw = await waitFor(updateWindow, (w) => !!w, 15_000);
  if (!uw) throw new Error('the Software Update window never opened');
  let state = await waitFor(() => readState(uw),
    (s) => s === 'available' || s === 'downloaded', 60_000);
  if (state === 'available') {
    await clickPrimary(uw);
    state = await waitFor(() => readState(uw), (s) => s === 'downloaded', 120_000);
  }
  check('the update is ready', state === 'downloaded', state);

  // Restart → Cancel: everything survives, including the clean window.
  closeChoice = 2;
  await clickPrimary(uw);
  await new Promise((r) => setTimeout(r, 4000));
  check('Cancel: the save prompt was raised', prompts.includes(SAVE_PROMPT));
  check('Cancel: both document windows survive', docWindows().length === 2,
    String(docWindows().length));
  check('Cancel: the dirty session is intact',
    await main.webContents.executeJavaScript(
      `window.__pt.controller.getSnapshot().save === 'dirty'`) as boolean);

  // Close the update window, then check for updates AGAIN: straight
  // back to the ready state, no re-download, restart still on offer.
  await uw.webContents.executeJavaScript(
    `document.getElementById('pt-update-secondary')?.click()`); // Later
  await waitFor(() => updateWindow() === undefined, (v) => v, 10_000);
  Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click();
  const uw2 = await waitFor(updateWindow, (w) => !!w, 15_000);
  if (!uw2) throw new Error('the update window did not reopen');
  const again = await waitFor(() => readState(uw2), (s) => s === 'downloaded', 30_000);
  check('re-checking after Cancel lands directly on the ready state',
    again === 'downloaded', again);
  check('Restart to Update is still on offer',
    await uw2.webContents.executeJavaScript(
      `document.getElementById('pt-update-primary')?.textContent === 'Restart to Update'
        && !document.getElementById('pt-update-primary')?.disabled`) as boolean);

  // Restart again, Don't Save this time: the restart proceeds — every
  // document window closes, and no third prompt appears.
  const promptsBefore = prompts.length;
  closeChoice = 1;
  await clickPrimary(uw2);
  const allClosed = await waitFor(() => docWindows().length, (n) => n === 0, 20_000);
  check('Don’t Save: the restart proceeds and the document windows close',
    allClosed === 0, `${allClosed} still open`);
  check('Don’t Save: the prompt appeared exactly once more',
    prompts.length === promptsBefore + 1, `${prompts.length - promptsBefore} prompts`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  server.close();
  allowQuit = true;
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  restart edge cases errored', e);
      allowQuit = true;
      app.exit(1);
    });
  }, 14_000);
});
