// Window-update INSTALL test, macOS: the complete user journey through
// the menu and the Software Update window, ending in a verified
// install (signed builds only — Squirrel.Mac refuses unsigned
// updates). "Check for Updates…" is clicked, the update window's
// "Update Now" and then "Restart to Update" buttons are pressed like a
// user would, the app quits into Squirrel, and the test passes only
// when the app bundle on disk reports the NEW version and still passes
// the smoke probe.
// Run (CI, macOS, signed builds): node build-node/test/updateMacWindowInstall.js

import { execFileSync, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron, Page } from 'playwright-core';

const ROOT = path.resolve(__dirname, '..', '..');
const FEED = path.join(ROOT, 'dist-update-feed');

function serveFeed(): http.Server {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(
      new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '');
    // the yml advertises URL-safe names (spaces become dashes) while
    // the artifact on disk keeps its space — serve it under both
    const onDisk = fs.readdirSync(FEED)
      .find((f) => f === name || f.replace(/ /g, '-') === name);
    const file = path.join(FEED, onDisk ?? name);
    if (!name || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(8773, '127.0.0.1');
  return server;
}

function findApp(): string | null {
  const dist = path.join(ROOT, 'dist-electron');
  for (const dir of fs.readdirSync(dist)) {
    const app = path.join(dist, dir, 'Paper Trail.app');
    if (dir.startsWith('mac') && fs.existsSync(app)) return app;
  }
  return null;
}

function bundleVersion(app: string): string {
  try {
    return execFileSync('defaults',
      ['read', path.join(app, 'Contents', 'Info'), 'CFBundleShortVersionString'],
      { encoding: 'utf8' }).trim();
  } catch {
    return ''; // mid-replacement
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return cond();
}

async function run(): Promise<void> {
  const newVersion = /version:\s*(\S+)/.exec(
    fs.readFileSync(path.join(FEED, 'latest-mac.yml'), 'utf8'))?.[1] ?? '';
  const packaged = findApp();
  if (!packaged) {
    console.error('FAIL  no packaged Paper Trail.app in dist-electron');
    process.exit(1);
  }
  // Run against a COPY: Squirrel replaces the bundle it updates, and
  // the packaged original must stay pristine for the other tests
  // (ditto preserves the code signature; cp can drop xattrs).
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updwi-app-')),
    'Paper Trail.app');
  execFileSync('ditto', [packaged, app]);
  const bin = path.join(app, 'Contents', 'MacOS', 'Paper Trail');
  console.log(`window update to install: ${bundleVersion(app)} -> ${newVersion} (${os.arch()})`);

  const server = serveFeed();
  const eApp = await _electron.launch({
    executablePath: bin,
    args: [],
    env: {
      ...process.env as Record<string, string>,
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updwi-')),
      PT_SHOT: '1',
      PT_UPDATE_URL: 'http://127.0.0.1:8773',
    },
  });
  try {
    await eApp.firstWindow();
    await eApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click();
    });

    // The Software Update window is a page of its own.
    let updatePage: Page | undefined;
    const found = await waitFor(() => {
      updatePage = eApp.windows().find((p) => p.url().includes('update.html'));
      return !!updatePage;
    }, 30_000);
    if (!found || !updatePage) {
      console.error('FAIL  the Software Update window never opened');
      process.exit(1);
    }
    const state = () =>
      updatePage!.locator('#pt-update-root').getAttribute('data-state');

    // The background download races the click; go through Update Now if
    // it hasn't finished yet.
    await updatePage.waitForFunction(() => {
      const s = document.getElementById('pt-update-root')?.dataset.state;
      return s === 'available' || s === 'downloaded';
    }, undefined, { timeout: 120_000 });
    if ((await state()) === 'available') {
      await updatePage.locator('#pt-update-primary').click();
    }
    await updatePage.waitForFunction(
      () => document.getElementById('pt-update-root')?.dataset.state === 'downloaded',
      undefined, { timeout: 300_000 });
    console.log('PASS  the window reaches Restart to Update');

    // Like a user finishing the update: Restart to Update.
    await updatePage.locator('#pt-update-primary').click();

    // the app quits into Squirrel and the bundle on disk is replaced
    const updated = await waitFor(() => bundleVersion(app) === newVersion, 480_000);
    console.log(`${updated ? 'PASS' : 'FAIL'}  the window flow installs the new version`
      + `  — bundle now ${bundleVersion(app) || '(unreadable)'}`);
    // stop the relaunched copy before smoking our own
    spawnSync('pkill', ['-f', bin]);
    await new Promise((r) => setTimeout(r, 2000));

    let smoked = false;
    if (updated) {
      const smoke = spawnSync(bin, ['--smoke'], {
        timeout: 180_000,
        env: { ...process.env, PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updwi2-')) },
      });
      smoked = smoke.status === 0;
      console.log(`${smoked ? 'PASS' : 'FAIL'}  updated app passes the smoke probe`
        + `  — exit ${smoke.status}`);
    }
    process.exit(updated && smoked ? 0 : 1);
  } finally {
    await eApp.close().catch(() => { /* the app quit into the updater */ });
    server.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
