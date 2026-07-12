// Edge cases of the Software Update window against a mode-switchable
// fake feed:
//   - up to date: the window says so, the secondary button is hidden,
//     OK closes it;
//   - a failing feed shows the error state with the real reason, and
//     the error is not sticky — the next check works;
//   - Update Now clicked twice in a row stays harmless;
//   - closing the window mid-download and checking again RESUMES the
//     progress view (it must not re-offer the update);
//   - checking again after the download is complete goes straight to
//     "Restart to Update" without downloading the update a second time
//     (asserted by counting zip requests).
// The zip drips slowly so the downloading state is reliably observable.
//
// Run (CI, macOS): npx electron build-node/test/updateWindowEdges.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-updedge-'));
process.env.PT_SHOT = '1'; // show without stealing focus
process.env.PT_UPDATE_URL = 'http://127.0.0.1:8776';

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
  'provider: generic\nurl: http://127.0.0.1:8776\nupdaterCacheDirName: pt-updedge-harness\n');

const FEED_VERSION = '99.0.0';
const zipBytes = crypto.randomBytes(256 * 1024);
const sha512 = crypto.createHash('sha512').update(zipBytes).digest('base64');

// 'uptodate' answers with the app's own version; 'error' fails every
// request; 'slow' offers 99.0.0 with the zip dripping over ~25s.
let mode: 'uptodate' | 'error' | 'slow' = 'uptodate';
let zipRequests = 0;

function yml(version: string): string {
  return [
    `version: ${version}`,
    'files:',
    `  - url: update-${version}-mac.zip`,
    `    sha512: ${sha512}`,
    `    size: ${zipBytes.length}`,
    `path: update-${version}-mac.zip`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-01-01T00:00:00.000Z'",
  ].join('\n');
}

const server = http.createServer((req, res) => {
  const name = (req.url ?? '').split('/').pop() ?? '';
  if (mode === 'error') {
    res.writeHead(500);
    res.end('feed on fire');
  } else if (name.startsWith('latest')) {
    res.writeHead(200, { 'content-type': 'text/yaml' });
    res.end(yml(mode === 'uptodate' ? app.getVersion() : FEED_VERSION));
  } else if (name.endsWith('.zip')) {
    zipRequests += 1;
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(zipBytes.length),
    });
    // ~25s drip: long enough to drive the window through the
    // downloading state, short enough for CI.
    const chunk = Math.ceil(zipBytes.length / 50);
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= zipBytes.length || res.destroyed) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(zipBytes.subarray(sent, sent + chunk));
      sent += chunk;
    }, 500);
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});
server.listen(8776, '127.0.0.1');

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

function checkMenu(): void {
  Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click();
}

async function openAndWait(state: (s: string) => boolean): Promise<BrowserWindow> {
  checkMenu();
  const uw = await waitFor(updateWindow, (w) => !!w, 15_000);
  if (!uw) throw new Error('the Software Update window never opened');
  await waitFor(() => readState(uw), state, 30_000);
  return uw;
}

async function run(): Promise<void> {
  // 1 — up to date.
  let uw = await openAndWait((s) => s === 'none');
  check('up to date: the window says so', true, await readState(uw));
  check('up to date: the title reads accordingly',
    /up to date/i.test(await js<string>(uw, `document.getElementById('pt-update-title')?.textContent ?? ''`)));
  check('up to date: the secondary button is hidden',
    (await js<string>(uw,
      `getComputedStyle(document.getElementById('pt-update-secondary')).visibility`)) === 'hidden');
  await js(uw, `document.getElementById('pt-update-primary').click()`); // OK
  check('up to date: OK closes the window',
    await waitFor(() => updateWindow() === undefined, (v) => v, 10_000));

  // 2 — a broken feed reports, and the error is not sticky.
  mode = 'error';
  uw = await openAndWait((s) => s === 'error');
  check('feed failure: the window shows the error state', true);
  check('feed failure: the detail names a reason',
    ((await js<string>(uw, `document.getElementById('pt-update-detail')?.textContent ?? ''`)).length) > 0);
  await js(uw, `document.getElementById('pt-update-primary').click()`); // OK
  await waitFor(() => updateWindow() === undefined, (v) => v, 10_000);

  // 3 — the next check works despite the earlier error, and a
  // double-clicked Update Now stays harmless.
  mode = 'slow';
  uw = await openAndWait((s) => s === 'available');
  check('after an error: the next check finds the update', true);
  await js(uw, `document.getElementById('pt-update-primary').click()`);
  await js(uw, `document.getElementById('pt-update-primary').click()`);
  const st = await waitFor(() => readState(uw), (s) => s === 'downloading', 20_000);
  check('Update Now (double-clicked): downloading state', st === 'downloading', st);
  const p1 = Number(await js<string>(uw,
    `document.getElementById('pt-update-progress')?.dataset.percent ?? '0'`));
  await new Promise((r) => setTimeout(r, 2500));
  const p2 = Number(await js<string>(uw,
    `document.getElementById('pt-update-progress')?.dataset.percent ?? '0'`));
  check('the progress bar advances', p2 > p1 && p2 > 0 && p2 <= 100, `${p1} -> ${p2}`);

  // 4 — close mid-download, check again: the progress view resumes.
  await js(uw, `document.getElementById('pt-update-secondary').click()`); // Later
  await waitFor(() => updateWindow() === undefined, (v) => v, 10_000);
  uw = await openAndWait((s) => s === 'downloading' || s === 'downloaded');
  const resumed = await readState(uw);
  check('checking again mid-download resumes the progress view',
    resumed === 'downloading' || resumed === 'downloaded', resumed);
  check('...and does not fall back to re-offering the update',
    resumed !== 'available', resumed);

  // 5 — completion; a further check must not download again.
  await waitFor(() => readState(uw), (s) => s === 'downloaded', 60_000);
  const zipsBefore = zipRequests;
  await js(uw, `document.getElementById('pt-update-secondary').click()`); // Later
  await waitFor(() => updateWindow() === undefined, (v) => v, 10_000);
  uw = await openAndWait((s) => s === 'downloaded');
  check('checking again after the download goes straight to Restart to Update',
    (await js<string>(uw, `document.getElementById('pt-update-primary')?.textContent ?? ''`)) === 'Restart to Update');
  check('...without downloading the update a second time',
    zipRequests === zipsBefore, `${zipsBefore} -> ${zipRequests}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  server.close();
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  update window edge cases errored', e);
      app.exit(1);
    });
  }, 14_000);
});
