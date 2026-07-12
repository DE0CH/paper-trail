// Reopening the app WHILE a quit-install is replacing its files must
// not flash-close and vanish (the owner's report: "looks like it's
// corrupt"). The contract: a reopen attempted as early as possible
// during the install ends with the app RUNNING, on the NEW version —
// on the fixed shell via a small detached "Updating Paper Trail…"
// window that holds no locks and starts the app when the installer
// exits. Race-tolerant by design: if the installer wins the race the
// app simply starts normally, and the assertions still hold.
// Run (CI, Windows): node build-node/test/updateWinOpenDuringInstall.js

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron } from 'playwright-core';

const ROOT = path.resolve(__dirname, '..', '..');
const PRODUCT = 'Paper Trail';
const FEED = path.join(ROOT, 'dist-update-feed');

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function ps(cmd: string): string {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', cmd],
    { encoding: 'utf8' }).trim();
}

function shortcutTarget(lnk: string): string {
  return ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`);
}

function findShortcut(): string | null {
  const candidates = [
    path.join(os.homedir(), 'Desktop', `${PRODUCT}.lnk`),
    path.join(os.homedir(), 'OneDrive', 'Desktop', `${PRODUCT}.lnk`),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function exeVersion(exe: string): string {
  try {
    return ps(`(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`);
  } catch {
    return ''; // mid-replacement
  }
}

function norm(v: string): string {
  return v.trim().replace(/(\.0)+$/, '');
}

function running(imageName: string): boolean {
  return spawnSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`],
    { encoding: 'utf8' }).stdout.toLowerCase()
    .includes(imageName.toLowerCase());
}

async function waitFor(cond: () => boolean, ms: number, step = 1000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}

function serveFeed(): http.Server {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(
      new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '');
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
  server.listen(8776, '127.0.0.1');
  return server;
}

async function run(): Promise<void> {
  const newVersion = /version:\s*(\S+)/.exec(
    fs.readFileSync(path.join(FEED, 'latest.yml'), 'utf8'))?.[1] ?? '';
  const distDir = path.join(ROOT, 'dist-electron');
  const setup = fs.readdirSync(distDir).find((f) => /Setup.*\.exe$/i.test(f));
  if (!setup || !newVersion) {
    console.error('FAIL  need the packaged Setup and the update feed first');
    process.exit(1);
  }

  spawnSync(path.join(distDir, setup), ['/S'], { timeout: 300_000 });
  const lnk = (await waitFor(() => findShortcut() !== null, 90_000))
    ? findShortcut() : null;
  const exe = lnk ? shortcutTarget(lnk) : '';
  if (!exe || !fs.existsSync(exe)) {
    console.error('FAIL  the app did not install');
    process.exit(1);
  }
  console.log(`reopen during install: ${exeVersion(exe)} -> ${newVersion} (${os.arch()})`);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updd-'));

  // A stale pending installer from a sibling test would fake the
  // download; wipe the shared updater cache.
  const cfg = fs.readFileSync(
    path.join(path.dirname(exe), 'resources', 'app-update.yml'), 'utf8');
  const cacheName = /updaterCacheDirName:\s*(\S+)/.exec(cfg)?.[1]
    ?? 'paper-trail-updater';
  const pending = path.join(process.env.LOCALAPPDATA ?? '', cacheName, 'pending');
  fs.rmSync(path.join(process.env.LOCALAPPDATA ?? '', cacheName),
    { recursive: true, force: true });

  const feedSetup = fs.readdirSync(FEED).find((f) => /Setup.*\.exe$/i.test(f));
  const feedSize = feedSetup ? fs.statSync(path.join(FEED, feedSetup)).size : -1;

  // The reopen carries a file argument, like a real double-click.
  const pdf = path.join(userData, 'Reopened Paper.pdf');
  fs.copyFileSync(path.join(ROOT, 'sample', 'WStarCats.pdf'), pdf);

  const server = serveFeed();
  const env = {
    ...process.env as Record<string, string>,
    PT_USERDATA: userData,
    PT_SHOT: '1',
    PT_UPDATE_URL: 'http://127.0.0.1:8776',
  };
  const appImage = path.basename(exe);

  const eApp = await _electron.launch({ executablePath: exe, args: [], env });
  let installerName = '';
  try {
    await eApp.firstWindow();
    const downloaded = await waitFor(() =>
      fs.existsSync(pending)
        && fs.readdirSync(pending).some((f) =>
          f.toLowerCase().endsWith('.exe')
            && fs.statSync(path.join(pending, f)).size === feedSize),
    300_000);
    check('the background download completes into the updater cache',
      downloaded, pending);
    if (!downloaded) process.exit(1);
    installerName = fs.readdirSync(pending)
      .find((f) => f.toLowerCase().endsWith('.exe')) ?? '';

    // A normal quit: install-on-quit kicks off the installer.
    await eApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((w) => w.close());
    });
  } finally {
    await eApp.close().catch(() => { /* quit on its own */ });
  }

  // Reopen at the WORST moment: the instant the installer process is
  // seen (or the version already flipped — then the installer simply
  // won the race and the reopen is an ordinary start).
  const raceSeen = await waitFor(
    () => running(installerName) || norm(exeVersion(exe)) === norm(newVersion),
    120_000, 200);
  check('the quit-install begins (installer process or already-new version)',
    raceSeen, installerName);
  const duringInstall = running(installerName);
  console.log(`  reopening ${duringInstall ? 'DURING the install' : 'after it finished'}`);
  spawn(exe, [pdf], { detached: true, stdio: 'ignore', env }).unref();

  // The end state is the whole contract: the update completed…
  const updated = await waitFor(
    () => norm(exeVersion(exe)) === norm(newVersion), 300_000);
  check('the update still completes (the reopen must not wedge it)',
    updated, `exe now ${exeVersion(exe) || '(unreadable)'}`);

  // …and the app the user asked for is actually running — no flash.
  const appUp = await waitFor(() => running(appImage), 180_000);
  check('the reopened app ends up running the new version (no flash-close)',
    appUp && updated, `running=${appUp}`);

  // Cleanup: the reopened app is a detached process.
  spawnSync('taskkill', ['/F', '/IM', appImage], { timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 2000));
  server.close();
  const uninstaller = path.join(path.dirname(exe), `Uninstall ${PRODUCT}.exe`);
  if (fs.existsSync(uninstaller)) {
    spawnSync(uninstaller, ['/S'], { timeout: 300_000 });
    await waitFor(() => !fs.existsSync(exe), 90_000);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
