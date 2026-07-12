// Double-clicking a PDF against a closed app that installed a pending
// update on its way out: the double-click (the exe launched with a
// file argument) must come up as the NEW version, with the PDF open
// in its window, the update announcement showing, and no second
// window. The mid-install race is deliberately not simulated — the
// installer side of that is covered by installerCloseUnsaved's
// graceful-close contract.
// Run (CI, Windows): node build-node/test/updateWinOpenAfterUpdate.js

import { execFileSync, spawnSync } from 'node:child_process';
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

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 2000));
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
  server.listen(8778, '127.0.0.1');
  return server;
}

async function run(): Promise<void> {
  const newVersion = /version:\s*(\S+)/.exec(
    fs.readFileSync(path.join(FEED, 'latest.yml'), 'utf8'))?.[1] ?? '';
  const distDir = path.join(ROOT, 'dist-electron');
  const setup = fs.readdirSync(distDir).find((f) => /Setup.*\.exe$/i.test(f));
  const pdf = path.resolve(ROOT, 'sample', 'WStarCats.pdf');
  if (!setup || !newVersion || !fs.existsSync(pdf)) {
    console.error('FAIL  need the Setup exe, the update feed and the fixture PDF');
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

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updopen-'));
  const cfg = fs.readFileSync(
    path.join(path.dirname(exe), 'resources', 'app-update.yml'), 'utf8');
  const cacheName = /updaterCacheDirName:\s*(\S+)/.exec(cfg)?.[1]
    ?? 'paper-trail-updater';
  fs.rmSync(path.join(process.env.LOCALAPPDATA ?? '', cacheName),
    { recursive: true, force: true });
  const pending = path.join(process.env.LOCALAPPDATA ?? '', cacheName, 'pending');
  const feedSetup = fs.readdirSync(FEED).find((f) => /Setup.*\.exe$/i.test(f));
  const feedSize = feedSetup ? fs.statSync(path.join(FEED, feedSetup)).size : -1;

  const server = serveFeed();
  const env = {
    ...process.env as Record<string, string>,
    PT_USERDATA: userData,
    PT_SHOT: '1',
    PT_UPDATE_URL: 'http://127.0.0.1:8778',
  };

  // Phase 1: download silently, quit, let the update install with the
  // app closed — the "pending update" state a double-click can meet.
  const first = await _electron.launch({ executablePath: exe, args: [], env });
  try {
    await first.firstWindow();
    const downloaded = await waitFor(() =>
      fs.existsSync(pending)
        && fs.readdirSync(pending).some((f) =>
          f.toLowerCase().endsWith('.exe')
            && fs.statSync(path.join(pending, f)).size === feedSize),
    300_000);
    check('the update download completes in the background', downloaded);
    await first.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((w) => w.close());
    });
  } finally {
    await first.close().catch(() => { /* quit on its own */ });
  }
  const updated = await waitFor(
    () => norm(exeVersion(exe)) === norm(newVersion), 300_000);
  check('the pending update installs while the app is closed',
    updated, `exe now ${exeVersion(exe) || '(unreadable)'}`);

  // Phase 2: the double-click — the (new) exe launched with a PDF.
  const second = await _electron.launch({
    executablePath: exe, args: [pdf], env,
  });
  try {
    const page = await second.firstWindow();
    let opened = false;
    try {
      await page.waitForFunction(
        () => document.title.includes('WStarCats'), undefined, { timeout: 60_000 });
      opened = true;
    } catch { /* reported below */ }
    check('the double-clicked PDF opens', opened);
    check('...in exactly one window',
      await second.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().length) === 1);
    check('...running the new version',
      norm(await second.evaluate(({ app }) => app.getVersion())) === norm(newVersion));
    let announced = false;
    try {
      await page.waitForFunction((v) => {
        const t = document.getElementById('toast')?.textContent ?? '';
        return t.includes('updated to') && t.includes(v);
      }, norm(newVersion), { timeout: 30_000 });
      announced = true;
    } catch { /* reported below */ }
    check('...and announcing the update it applied', announced);
  } finally {
    await second.close().catch(() => { /* fine */ });
    server.close();
  }

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
