// The Software Update window walks the standard states end to end
// against a local fake feed: Check for Updates… opens the window, an
// available update names both versions, Update Now shows the download
// and ends in an enabled "Restart to Update", and Later closes the
// window while the app keeps running. The feed serves 404 until the
// test enables it, so the launch-time background check finds nothing
// and the window really passes through the 'available' state.
//
// Run (CI, macOS): npx electron build-node/test/updateWindow.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-updwin-'));
process.env.PT_SHOT = '1'; // show without stealing focus
process.env.PT_UPDATE_URL = 'http://127.0.0.1:8771';

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
  'provider: generic\nurl: http://127.0.0.1:8771\nupdaterCacheDirName: pt-updwin-harness\n');

// A fake update feed: any zip whose sha512 matches the yml downloads
// and verifies fine (installing it would fail, but the window flow
// never installs here).
let feedLive = false;
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
  if (!feedLive || !name) {
    res.writeHead(404);
    res.end('not found');
  } else if (name.startsWith('latest')) {
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
server.listen(8771, '127.0.0.1');

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

async function readText(w: BrowserWindow, id: string): Promise<string> {
  return await w.webContents.executeJavaScript(
    `document.getElementById(${JSON.stringify(id)})?.textContent ?? ''`) as string;
}

async function clickButton(w: BrowserWindow, id: string): Promise<void> {
  await w.webContents.executeJavaScript(
    `document.getElementById(${JSON.stringify(id)})?.click()`);
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

async function run(): Promise<void> {
  feedLive = true;
  const item = Menu.getApplicationMenu()?.getMenuItemById('check-updates');
  check('the Check for Updates menu item exists', !!item);
  item?.click();

  const uw = await waitFor(updateWindow, (w) => !!w, 15_000);
  check('the Software Update window opens', !!uw, uw?.getTitle() ?? 'no window');
  if (!uw) { app.exit(1); return; }

  const state = await waitFor(() => readState(uw), (s) => s === 'available', 30_000);
  check('an update is offered (state: available)', state === 'available', state);
  const detail = await readText(uw, 'pt-update-detail');
  check('the offer names the new version and the current one',
    detail.includes(FEED_VERSION) && detail.includes(app.getVersion()), detail);
  check('the primary button says Update Now',
    (await readText(uw, 'pt-update-primary')) === 'Update Now');

  await clickButton(uw, 'pt-update-primary');
  const done = await waitFor(() => readState(uw), (s) => s === 'downloaded', 120_000);
  check('the download completes (state: downloaded)', done === 'downloaded', done);
  check('the primary button now says Restart to Update',
    (await readText(uw, 'pt-update-primary')) === 'Restart to Update');
  const enabled = await uw.webContents.executeJavaScript(
    `!document.getElementById('pt-update-primary')?.disabled`) as boolean;
  check('Restart to Update is enabled', enabled === true);

  await clickButton(uw, 'pt-update-secondary'); // Later
  const gone = await waitFor(
    () => updateWindow() === undefined, (v) => v, 10_000);
  check('Later closes the update window', gone);
  check('the app itself keeps running with its document window',
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 1);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  server.close();
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  update window flow errored', e);
      app.exit(1);
    });
  }, 14_000);
});
