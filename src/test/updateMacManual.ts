// Manual-update test, macOS: drives the actual "Check for Updates…"
// menu flow of the PACKAGED app against a local feed. The native
// dialogs are stubbed to record their text and answer like a user:
// "Update Now" at the offer, then "Later" at the restart prompt (CI
// builds are unsigned, so the actual install is exercised only by
// real releases). Passes when the two prompts appeared in order with
// the right versions in them.
// Run (CI, macOS): node build-node/test/updateMacManual.js

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
  server.listen(8767, '127.0.0.1');
  return server;
}

function findAppBinary(): string | null {
  const dist = path.join(ROOT, 'dist-electron');
  for (const dir of fs.readdirSync(dist)) {
    const bin = path.join(dist, dir, 'Paper Trail.app', 'Contents', 'MacOS', 'Paper Trail');
    if (dir.startsWith('mac') && fs.existsSync(bin)) return bin;
  }
  return null;
}

async function run(): Promise<void> {
  const newVersion = /version:\s*(\S+)/.exec(
    fs.readFileSync(path.join(FEED, 'latest-mac.yml'), 'utf8'))?.[1] ?? '';
  const bin = findAppBinary();
  if (!bin) {
    console.error('FAIL  no packaged Paper Trail.app in dist-electron');
    process.exit(1);
  }
  const server = serveFeed();
  const eApp = await _electron.launch({
    executablePath: bin,
    args: [],
    env: {
      ...process.env as Record<string, string>,
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updman-')),
      PT_SHOT: '1',
      PT_UPDATE_URL: 'http://127.0.0.1:8767',
    },
  });
  try {
    // Record every dialog and answer like a user: "Update Now" (0) at
    // the offer, "Later" (1) at the restart prompt. Download progress
    // is recorded too so a timeout failure shows how far it got.
    await eApp.evaluate(({ dialog }) => {
      const seen: string[] = [];
      (globalThis as { __ptDialogs?: string[] }).__ptDialogs = seen;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { message: string };
        seen.push(opts.message);
        return { response: seen.length === 1 ? 0 : 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
      // best-effort download diagnostics (playwright's evaluate has no
      // `require` in scope; go through the main module's loader)
      try {
        const req = (process as unknown as {
          mainModule?: { require: (m: string) => typeof import('electron-updater') };
        }).mainModule?.require;
        const g = globalThis as { __ptProgress?: string };
        if (req) {
          const { autoUpdater } = req('electron-updater');
          autoUpdater.on('download-progress', (p) => {
            g.__ptProgress = `${p.percent.toFixed(1)}%`;
          });
          autoUpdater.on('update-downloaded', () => { g.__ptProgress = 'downloaded'; });
          autoUpdater.on('error', (e) => { g.__ptProgress = `error: ${String(e)}`; });
        }
      } catch { /* diagnostics only */ }
    });
    await eApp.firstWindow();
    await eApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click();
    });
    // wait for both prompts (offer + downloaded/ready); Intel runners
    // are slow enough that the download itself dominates
    const deadline = Date.now() + 480_000;
    let dialogs: string[] = [];
    while (Date.now() < deadline) {
      dialogs = await eApp.evaluate(() =>
        (globalThis as { __ptDialogs?: string[] }).__ptDialogs ?? []);
      if (dialogs.length >= 2) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const progress = await eApp.evaluate(() =>
      (globalThis as { __ptProgress?: string }).__ptProgress ?? 'no download activity');
    const ok = dialogs.length >= 2
      && dialogs[0].includes(`${newVersion} is available`)
      && dialogs[1].includes(`${newVersion} is ready`);
    console.log(`${ok ? 'PASS' : 'FAIL'}  Check for Updates offers, downloads, and asks to restart`
      + `  — ${JSON.stringify(dialogs)} (download: ${progress})`);
    process.exit(ok ? 0 : 1);
  } finally {
    await eApp.close().catch(() => { /* app may already be gone */ });
    server.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
