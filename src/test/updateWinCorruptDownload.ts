// Resilience: a corrupted download (right size, wrong bytes — a
// sha512 mismatch, as a flaky network or a tampered mirror would
// produce) must be REJECTED, never installed. The app stays on the old
// version, nothing corrupt is staged, it smoke-passes — and once the
// feed serves the genuine installer, the updater recovers and a normal
// quit installs the new version.
// Run (CI, Windows): node build-node/test/updateWinCorruptDownload.js

import { execFileSync, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron } from 'playwright-core';

const ROOT = path.resolve(__dirname, '..', '..');
const PRODUCT = 'Paper Trail';
const FEED = path.join(ROOT, 'dist-update-feed');
const PS_TIMEOUT = 15_000;

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function ps(cmd: string): string {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', cmd],
    { encoding: 'utf8', timeout: PS_TIMEOUT }).trim();
}
function shortcutTarget(lnk: string): string {
  return ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`);
}
function findShortcut(): string | null {
  return [path.join(os.homedir(), 'Desktop', `${PRODUCT}.lnk`),
    path.join(os.homedir(), 'OneDrive', 'Desktop', `${PRODUCT}.lnk`)]
    .find((p) => fs.existsSync(p)) ?? null;
}
function exeVersion(exe: string): string {
  try {
    return ps(`(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`);
  } catch { return ''; }
}
function norm(v: string): string { return v.trim().replace(/(\.0)+$/, ''); }
function running(image: string): boolean {
  return spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`],
    { encoding: 'utf8', timeout: PS_TIMEOUT }).stdout.toLowerCase().includes(image.toLowerCase());
}
async function waitFor(cond: () => boolean, ms: number, step = 1000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}

// When `corrupt` is set, the .exe body is served at the right length
// but with a flipped byte, so its sha512 won't match the yml — exactly
// what electron-updater must catch and refuse.
let corrupt = true;
function serveFeed(port: number): http.Server {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '');
    const onDisk = fs.readdirSync(FEED).find((f) => f === name || f.replace(/ /g, '-') === name);
    const file = onDisk ? path.join(FEED, onDisk) : '';
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    if (corrupt && name.toLowerCase().endsWith('.exe')) {
      const buf = Buffer.from(fs.readFileSync(file)); // same length
      buf[Math.floor(buf.length / 2)] ^= 0xff;        // one flipped byte
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) });
      res.end(buf);
      return;
    }
    res.writeHead(200); fs.createReadStream(file).pipe(res);
  });
  server.listen(port, '127.0.0.1');
  return server;
}

async function run(): Promise<void> {
  const newVersion = /version:\s*(\S+)/.exec(
    fs.readFileSync(path.join(FEED, 'latest.yml'), 'utf8'))?.[1] ?? '';
  const distDir = path.join(ROOT, 'dist-electron');
  const setup = fs.readdirSync(distDir).find((f) => /Setup.*\.exe$/i.test(f));
  const feedSetup = fs.readdirSync(FEED).find((f) => /Setup.*\.exe$/i.test(f));
  if (!setup || !feedSetup || !newVersion) {
    console.error('FAIL  need the packaged Setup + update feed first'); process.exit(1);
  }
  spawnSync(path.join(distDir, setup), ['/S'], { timeout: 300_000 });
  const lnk = (await waitFor(() => findShortcut() !== null, 90_000)) ? findShortcut() : null;
  const exe = lnk ? shortcutTarget(lnk) : '';
  if (!exe || !fs.existsSync(exe)) { console.error('FAIL  the app did not install'); process.exit(1); }
  const image = path.basename(exe);
  const oldVersion = exeVersion(exe);
  const feedSize = fs.statSync(path.join(FEED, feedSetup)).size;
  console.log(`corrupt download: ${oldVersion} -> ${newVersion} (${os.arch()})`);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-corrupt-'));
  const cfg = fs.readFileSync(path.join(path.dirname(exe), 'resources', 'app-update.yml'), 'utf8');
  const cacheName = /updaterCacheDirName:\s*(\S+)/.exec(cfg)?.[1] ?? 'paper-trail-updater';
  const cacheDir = path.join(process.env.LOCALAPPDATA ?? '', cacheName);
  const pending = path.join(cacheDir, 'pending');
  fs.rmSync(cacheDir, { recursive: true, force: true });

  const env = {
    ...process.env as Record<string, string>,
    PT_USERDATA: userData, PT_SHOT: '1', PT_UPDATE_URL: 'http://127.0.0.1:8783',
  };

  // Phase 1: corrupt feed. The download must be refused (sha512).
  corrupt = true;
  const server = serveFeed(8783);
  const eApp = await _electron.launch({ executablePath: exe, args: [], env });
  try {
    await eApp.firstWindow();
    // Give the updater ample time to fetch + verify + reject.
    await new Promise((r) => setTimeout(r, 45_000));
    const staged = fs.existsSync(pending) && fs.readdirSync(pending).some((f) =>
      f.toLowerCase().endsWith('.exe') && fs.statSync(path.join(pending, f)).size === feedSize);
    check('the corrupt installer is not staged for install', !staged,
      staged ? 'a full installer landed in pending' : 'nothing valid staged');
    // A quit must NOT install anything from the bad download.
    await eApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((w) => w.close());
    });
  } finally {
    await eApp.close().catch(() => { /* */ });
  }
  await new Promise((r) => setTimeout(r, 8000));
  check('the app stays on the old version after a corrupt download',
    norm(exeVersion(exe)) === norm(oldVersion), exeVersion(exe));
  const smoke1 = spawnSync(exe, ['--smoke'], {
    timeout: 180_000,
    env: { ...process.env, PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-corrupt-s1-')) },
  });
  check('the app still smoke-passes after refusing the corrupt update',
    smoke1.status === 0, `exit ${smoke1.status}`);

  // Phase 2: the genuine feed heals it — a normal download + quit
  // installs the new version.
  fs.rmSync(cacheDir, { recursive: true, force: true });
  corrupt = false;
  const eApp2 = await _electron.launch({ executablePath: exe, args: [], env });
  try {
    await eApp2.firstWindow();
    const downloaded = await waitFor(() =>
      fs.existsSync(pending) && fs.readdirSync(pending).some((f) =>
        f.toLowerCase().endsWith('.exe') && fs.statSync(path.join(pending, f)).size === feedSize),
    300_000);
    check('the genuine installer downloads cleanly after the corrupt one', downloaded);
    await eApp2.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((w) => w.close());
    });
    const updated = await waitFor(() => norm(exeVersion(exe)) === norm(newVersion), 300_000);
    check('a normal quit then installs the new version (updater recovered)',
      updated, `exe now ${exeVersion(exe) || '(unreadable)'}`);
  } finally {
    await eApp2.close().catch(() => { /* */ });
    server.close();
  }
  if (running(image)) spawnSync('taskkill', ['/F', '/IM', image], { timeout: PS_TIMEOUT });
  await new Promise((r) => setTimeout(r, 2000));

  const uninstaller = path.join(path.dirname(exe), `Uninstall ${PRODUCT}.exe`);
  if (fs.existsSync(uninstaller)) {
    spawnSync(uninstaller, ['/S'], { timeout: 300_000 });
    await waitFor(() => !fs.existsSync(exe), 90_000);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
