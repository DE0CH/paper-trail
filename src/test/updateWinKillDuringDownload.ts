// Resilience: a hard kill (taskkill /F — the Windows stand-in for a
// force shutdown / SIGKILL) WHILE the update is downloading must never
// corrupt anything. After the kill the installed app is untouched (old
// version, smoke-clean), a reading session saved beforehand still
// loads, and the updater recovers — a fresh launch re-downloads and a
// normal quit installs the new version. The feed drips the installer
// so the kill lands mid-download deterministically.
// Run (CI, Windows): node build-node/test/updateWinKillDuringDownload.js

import { execFileSync, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron } from 'playwright-core';

const ROOT = path.resolve(__dirname, '..', '..');
const PRODUCT = 'Paper Trail';
const FEED = path.join(ROOT, 'dist-update-feed');
// Every PowerShell/child call is bounded — a resilience test must never
// hang on a locked/half-written file the way an unbounded call would.
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
    return ''; // mid-replacement or locked
  }
}

function norm(v: string): string {
  return v.trim().replace(/(\.0)+$/, '');
}

function running(image: string): boolean {
  return spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`],
    { encoding: 'utf8', timeout: PS_TIMEOUT }).stdout
    .toLowerCase().includes(image.toLowerCase());
}

function kill(image: string): void {
  spawnSync('taskkill', ['/F', '/IM', image], { timeout: PS_TIMEOUT });
}

async function waitFor(cond: () => boolean, ms: number, step = 1000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}

// Drip the installer so the download is reliably in-flight when we
// kill; a `live` flag lets the recovery phase serve it at full speed.
let dripMs = 30_000;
function serveFeed(port: number): http.Server {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(
      new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '');
    const onDisk = fs.readdirSync(FEED)
      .find((f) => f === name || f.replace(/ /g, '-') === name);
    const file = onDisk ? path.join(FEED, onDisk) : '';
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404); res.end('not found'); return;
    }
    if (!name.toLowerCase().endsWith('.exe')) {
      res.writeHead(200); fs.createReadStream(file).pipe(res); return;
    }
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(buf.length),
    });
    if (dripMs <= 0) { res.end(buf); return; }
    const chunks = 40;
    const size = Math.ceil(buf.length / chunks);
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= buf.length || res.destroyed) { clearInterval(timer); res.end(); return; }
      res.write(buf.subarray(sent, sent + size));
      sent += size;
    }, Math.max(1, Math.floor(dripMs / chunks)));
  });
  server.listen(port, '127.0.0.1');
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
  const lnk = (await waitFor(() => findShortcut() !== null, 90_000)) ? findShortcut() : null;
  const exe = lnk ? shortcutTarget(lnk) : '';
  if (!exe || !fs.existsSync(exe)) {
    console.error('FAIL  the app did not install'); process.exit(1);
  }
  const image = path.basename(exe);
  const oldVersion = exeVersion(exe);
  console.log(`kill during download: ${oldVersion} -> ${newVersion} (${os.arch()})`);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-killdl-'));
  const cfg = fs.readFileSync(
    path.join(path.dirname(exe), 'resources', 'app-update.yml'), 'utf8');
  const cacheName = /updaterCacheDirName:\s*(\S+)/.exec(cfg)?.[1] ?? 'paper-trail-updater';
  const cacheDir = path.join(process.env.LOCALAPPDATA ?? '', cacheName);
  const pending = path.join(cacheDir, 'pending');
  fs.rmSync(cacheDir, { recursive: true, force: true });

  // A reading session saved before the crash must survive it intact.
  const session = path.join(userData, 'before-crash.ptl');
  fs.copyFileSync(path.join(ROOT, 'sample', 'WStarCats.ptl'), session);
  const sessionBefore = fs.readFileSync(session, 'utf8');

  const env = {
    ...process.env as Record<string, string>,
    PT_USERDATA: userData, PT_SHOT: '1', PT_UPDATE_URL: 'http://127.0.0.1:8781',
  };

  // Phase 1: launch, let the drip start, then HARD-KILL mid-download.
  dripMs = 30_000;
  let server = serveFeed(8781);
  const eApp = await _electron.launch({ executablePath: exe, args: [], env });
  try {
    await eApp.firstWindow();
    // Download is in flight once a partial file appears in the cache.
    const downloading = await waitFor(() =>
      fs.existsSync(pending) && fs.readdirSync(pending)
        .some((f) => fs.statSync(path.join(pending, f)).size > 0), 120_000);
    await new Promise((r) => setTimeout(r, 3000)); // a few % in
    check('the download is in flight before the kill', downloading);
  } finally {
    // The force shutdown: no graceful close, just SIGKILL-equivalent.
    kill(image);
  }
  server.close();
  await waitFor(() => !running(image), 30_000);

  // The installed app is untouched: still the old version, still runnable.
  check('the installed app is untouched (old version) after the kill',
    norm(exeVersion(exe)) === norm(oldVersion), exeVersion(exe));
  const smoke1 = spawnSync(exe, ['--smoke'], {
    timeout: 180_000,
    env: { ...process.env, PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-killdl-s1-')) },
  });
  check('the app still smoke-passes after a kill mid-download', smoke1.status === 0,
    `exit ${smoke1.status}`);
  check('the saved reading session survived intact',
    fs.existsSync(session) && fs.readFileSync(session, 'utf8') === sessionBefore);
  check('no complete installer was left staged',
    !(fs.existsSync(pending) && fs.readdirSync(pending).some((f) =>
      f.toLowerCase().endsWith('.exe')
      && fs.statSync(path.join(pending, f)).size
        === (fs.readdirSync(FEED).map((n) => path.join(FEED, n))
          .filter((p) => /Setup.*\.exe$/i.test(p)).map((p) => fs.statSync(p).size)[0] ?? -1))));

  // Phase 2: the updater RECOVERS — a fresh launch re-downloads (full
  // speed now) and a normal quit installs the new version.
  fs.rmSync(cacheDir, { recursive: true, force: true });
  dripMs = 0;
  server = serveFeed(8781);
  const feedSetup = fs.readdirSync(FEED).find((f) => /Setup.*\.exe$/i.test(f));
  const feedSize = feedSetup ? fs.statSync(path.join(FEED, feedSetup)).size : -1;
  const eApp2 = await _electron.launch({ executablePath: exe, args: [], env });
  try {
    await eApp2.firstWindow();
    const redownloaded = await waitFor(() =>
      fs.existsSync(pending) && fs.readdirSync(pending).some((f) =>
        f.toLowerCase().endsWith('.exe') && fs.statSync(path.join(pending, f)).size === feedSize),
    300_000);
    check('a fresh launch re-downloads the update cleanly', redownloaded);
    await eApp2.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((w) => w.close());
    });
    const updated = await waitFor(() => norm(exeVersion(exe)) === norm(newVersion), 300_000);
    check('a normal quit then installs the new version (updater recovered)',
      updated, `exe now ${exeVersion(exe) || '(unreadable)'}`);
  } finally {
    await eApp2.close().catch(() => { /* quit on its own */ });
    server.close();
  }
  if (running(image)) kill(image);
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
