// Manual-update INSTALL test, macOS: the complete user journey through
// the menu, ending in a verified install (signed builds only —
// Squirrel.Mac refuses unsigned updates). "Check for Updates…" is
// clicked, the stubbed dialogs answer "Update Now" and then "Restart
// Now", the app quits into Squirrel, and the test passes only when the
// app bundle on disk reports the NEW version and still passes the
// smoke probe.
// Run (CI, macOS, signed builds): node build-node/test/updateMacManualInstall.js

import { execFileSync, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron } from 'playwright-core';

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
  server.listen(8770, '127.0.0.1');
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
  const app = findApp();
  if (!app) {
    console.error('FAIL  no packaged Paper Trail.app in dist-electron');
    process.exit(1);
  }
  const bin = path.join(app, 'Contents', 'MacOS', 'Paper Trail');
  console.log(`manual update to install: ${bundleVersion(app)} -> ${newVersion} (${os.arch()})`);

  const server = serveFeed();
  const eApp = await _electron.launch({
    executablePath: bin,
    args: [],
    env: {
      ...process.env as Record<string, string>,
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updmi-')),
      PT_SHOT: '1',
      PT_UPDATE_URL: 'http://127.0.0.1:8770',
    },
  });
  try {
    // Answer like a user finishing the update: "Update Now" (0) at the
    // offer, then "Restart Now" (0) at the ready prompt.
    await eApp.evaluate(({ dialog }) => {
      const seen: string[] = [];
      (globalThis as { __ptDialogs?: string[] }).__ptDialogs = seen;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { message: string };
        seen.push(opts.message);
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    await eApp.firstWindow();
    await eApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click();
    });
    // the app downloads, restarts into Squirrel, and the bundle on disk
    // is replaced by the new version
    const updated = await waitFor(() => bundleVersion(app) === newVersion, 480_000);
    console.log(`${updated ? 'PASS' : 'FAIL'}  the manual flow installs the new version`
      + `  — bundle now ${bundleVersion(app) || '(unreadable)'}`);
    // stop the relaunched copy before smoking our own
    spawnSync('pkill', ['-f', bin]);
    await new Promise((r) => setTimeout(r, 2000));

    let smoked = false;
    if (updated) {
      const smoke = spawnSync(bin, ['--smoke'], {
        timeout: 180_000,
        env: { ...process.env, PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updmi2-')) },
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
