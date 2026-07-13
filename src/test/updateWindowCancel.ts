// The Software Update window's "Cancel" during a download is a DISMISS,
// not a real cancel. autoDownload is on, so stopping the transfer is
// pointless — clicking Cancel just CLOSES the window while the download
// keeps running in the background. Once it finishes there, a later
// "Check for Updates…" goes straight to "Ready to update" (Restart),
// never a fresh offer.
//
// Owner-authorized contract change (2026-07-13): this replaces the
// previous "real Cancel that stops the transfer" contract. The proof it
// kept downloading (rather than stopping): after Cancel closes the
// window, wait past when the transfer finishes, reopen the check, and
// see it land on "downloaded" — with only ONE zip request the whole
// time (a single continuous transfer, never re-fetched).
//
// Run (CI, macOS): npx electron build-node/test/updateWindowCancel.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-updcancel-'));
process.env.PT_SHOT = '1'; // show without stealing focus
process.env.PT_UPDATE_URL = 'http://127.0.0.1:8779';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { app, BrowserWindow, Menu } from 'electron';

// electron-updater in a dev (unpackaged) run reads dev-app-update.yml
// from the app path for its cache-directory name even though the feed
// itself comes from PT_UPDATE_URL — without it the download rejects
// with ENOENT before it starts. Provide one next to the entry module.
fs.writeFileSync(path.join(__dirname, 'dev-app-update.yml'),
  'provider: generic\nurl: http://127.0.0.1:8779\nupdaterCacheDirName: pt-updcancel-harness\n');

const FEED_VERSION = '99.0.0';
const zipBytes = crypto.randomBytes(512 * 1024);
const sha512 = crypto.createHash('sha512').update(zipBytes).digest('base64');

// The zip drips over ~12s: the download is caught mid-flight to click
// Cancel, then finishes in the background a few seconds later.
const DRIP_MS = 12_000;
let feedLive = false;
let zipRequests = 0;

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
  if (!feedLive) {
    res.writeHead(404); res.end('not found'); return;
  }
  if (name.startsWith('latest')) {
    res.writeHead(200, { 'content-type': 'text/yaml' });
    res.end(yml);
  } else if (name.endsWith('.zip')) {
    zipRequests += 1;
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(zipBytes.length),
    });
    const ticks = Math.ceil(DRIP_MS / 200);
    const chunk = Math.ceil(zipBytes.length / ticks);
    let sent = 0;
    const timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) { clearInterval(timer); return; }
      if (sent >= zipBytes.length) { clearInterval(timer); res.end(); return; }
      res.write(zipBytes.subarray(sent, sent + chunk));
      sent += chunk;
    }, 200);
    res.on('close', () => clearInterval(timer));
  } else {
    res.writeHead(404); res.end('not found');
  }
});
server.listen(8779, '127.0.0.1');

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

async function js<T>(w: BrowserWindow, code: string): Promise<T> {
  return await w.webContents.executeJavaScript(code) as T;
}

const readState = (w: BrowserWindow) =>
  js<string>(w, `document.getElementById('pt-update-root')?.dataset.state ?? ''`);

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

function checkForUpdates(): void {
  Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click();
}

async function run(): Promise<void> {
  feedLive = true;
  checkForUpdates();
  const uw = await waitFor(updateWindow, (w) => !!w, 15_000);
  if (!uw) { console.error('FAIL  the Software Update window never opened'); app.exit(1); return; }
  const available = await waitFor(() => readState(uw), (s) => s === 'available', 30_000);
  check('an update is offered', available === 'available', available);

  // Update Now → downloading, with the progress really moving.
  await js(uw, `document.getElementById('pt-update-primary').click()`);
  const dl = await waitFor(() => readState(uw), (s) => s === 'downloading', 20_000);
  check('Update Now starts the download', dl === 'downloading', dl);
  check('the secondary button is Cancel',
    (await js<string>(uw, `document.getElementById('pt-update-secondary')?.textContent ?? ''`)) === 'Cancel');
  const p1 = Number(await js<string>(uw,
    `document.getElementById('pt-update-progress')?.dataset.percent ?? '0'`));
  await new Promise((r) => setTimeout(r, 2000));
  const p2 = Number(await js<string>(uw,
    `document.getElementById('pt-update-progress')?.dataset.percent ?? '0'`));
  check('the download is under way (progress advances)', p2 > p1, `${p1} -> ${p2}`);

  // Cancel → the window DISMISSES (closes). It does not drop back to an
  // offer, and it does not stop the transfer.
  await js(uw, `document.getElementById('pt-update-secondary').click()`); // Cancel
  const closed = await waitFor(() => updateWindow() === undefined, (v) => v, 10_000);
  check('Cancel dismisses the window (it closes)', closed);

  // The download keeps running in the background while the window is
  // closed: wait past when the transfer finishes.
  await new Promise((r) => setTimeout(r, DRIP_MS + 6000));

  // Reopen the check → it lands straight on "Ready to update" (the
  // background download completed), NOT a fresh offer.
  checkForUpdates();
  const uw2 = await waitFor(updateWindow, (w) => !!w, 15_000);
  if (!uw2) { console.error('FAIL  the reopened Software Update window never opened'); app.exit(1); return; }
  const ready = await waitFor(() => readState(uw2), (s) => s === 'downloaded', 20_000);
  check('reopening after Cancel shows Ready to update (the download kept going)',
    ready === 'downloaded', ready);
  check('the primary button is Restart to Update',
    (await js<string>(uw2, `document.getElementById('pt-update-primary')?.textContent ?? ''`)) === 'Restart to Update');
  check('it was ONE continuous transfer — never cancelled and re-fetched',
    zipRequests === 1, `zipRequests=${zipRequests}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  server.close();
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  update window dismiss flow errored', e);
      app.exit(1);
    });
  }, 14_000);
});
