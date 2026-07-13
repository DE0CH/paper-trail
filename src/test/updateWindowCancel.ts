// The Software Update window's download is INTERRUPTABLE: while it is
// downloading, the secondary button is a real "Cancel" that STOPS the
// transfer (it doesn't keep running in the background) and drops back
// to the "available" offer, from which Update Now downloads again. The
// feed drips the zip slowly so the download is caught mid-flight, and
// the fake server records whether the zip request was aborted — proof
// the transfer actually stopped rather than the window merely hiding.
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

let zipRequests = 0;
let zipAborted = false;
let zipCompleted = false;

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
    zipRequests += 1;
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(zipBytes.length),
    });
    // ~40s drip: slow enough to reliably cancel mid-download.
    const chunk = Math.ceil(zipBytes.length / 80);
    let sent = 0;
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return; }
      if (sent >= zipBytes.length) {
        clearInterval(timer);
        zipCompleted = true;
        res.end();
        return;
      }
      res.write(zipBytes.subarray(sent, sent + chunk));
      sent += chunk;
    }, 500);
    // The updater aborting the download closes the socket before the
    // body finishes — that is the transfer really stopping.
    res.on('close', () => { clearInterval(timer); if (!zipCompleted) zipAborted = true; });
  } else {
    res.writeHead(404);
    res.end('not found');
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

async function run(): Promise<void> {
  Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click();
  const uw = await waitFor(updateWindow, (w) => !!w, 15_000);
  if (!uw) { console.error('FAIL  the Software Update window never opened'); app.exit(1); return; }
  const available = await waitFor(() => readState(uw), (s) => s === 'available', 30_000);
  check('an update is offered', available === 'available', available);

  // Update Now → downloading, and progress is really moving.
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

  // Cancel → back to the offer, and the transfer actually stops.
  await js(uw, `document.getElementById('pt-update-secondary').click()`); // Cancel
  const afterCancel = await waitFor(() => readState(uw), (s) => s === 'available', 10_000);
  check('Cancel drops back to the offer (Update Now / Later)',
    afterCancel === 'available', afterCancel);
  check('the window stays open after Cancel', updateWindow() !== undefined);
  const stopped = await waitFor(() => zipAborted, (v) => v, 10_000);
  check('Cancel actually stops the download (the transfer was aborted)', stopped);

  // It must not have quietly finished in the background: give it well
  // past the point completion would have arrived, then confirm the state
  // never flipped to downloaded and no update-downloaded landed.
  await new Promise((r) => setTimeout(r, 4000));
  check('no update-downloaded lands after Cancel (state still available)',
    (await readState(uw)) === 'available' && !zipCompleted,
    `state=${await readState(uw)} completed=${zipCompleted}`);

  // And the flow is not wedged: Update Now works again.
  const requestsBefore = zipRequests;
  await js(uw, `document.getElementById('pt-update-primary').click()`);
  const dl2 = await waitFor(() => readState(uw), (s) => s === 'downloading', 20_000);
  check('Update Now downloads again after a cancel', dl2 === 'downloading', dl2);
  check('...as a fresh transfer', zipRequests > requestsBefore,
    `${requestsBefore} -> ${zipRequests}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  server.close();
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  update window cancel flow errored', e);
      app.exit(1);
    });
  }, 14_000);
});
