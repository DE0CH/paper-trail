// Resilience: a hard kill of BOTH the app and the NSIS installer
// (taskkill /F — the stand-in for a force shutdown) WHILE the
// quit-install is replacing files must not leave a corrupt, unrunnable
// app. After the kill + a relaunch the app is always a COHERENT
// version — the old one (install never committed) or the fully new one
// (install had finished) — it smoke-passes, a session saved beforehand
// still loads, and if it did land broken the updater recovers on the
// next check. This is the abrupt-crash sibling of the graceful
// reopen-during-install case (owned elsewhere).
// Run (CI, Windows): node build-node/test/updateWinKillDuringInstall.js

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
function kill(image: string): void {
  spawnSync('taskkill', ['/F', '/IM', image], { timeout: PS_TIMEOUT });
}
async function waitFor(cond: () => boolean, ms: number, step = 500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}
function serveFeed(port: number): http.Server {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '');
    const onDisk = fs.readdirSync(FEED).find((f) => f === name || f.replace(/ /g, '-') === name);
    const file = onDisk ? path.join(FEED, onDisk) : '';
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
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
  const installerImage = feedSetup; // the NSIS installer's process image
  spawnSync(path.join(distDir, setup), ['/S'], { timeout: 300_000 });
  const lnk = (await waitFor(() => findShortcut() !== null, 90_000)) ? findShortcut() : null;
  const exe = lnk ? shortcutTarget(lnk) : '';
  if (!exe || !fs.existsSync(exe)) { console.error('FAIL  the app did not install'); process.exit(1); }
  const image = path.basename(exe);
  const oldVersion = exeVersion(exe);
  const feedSize = fs.statSync(path.join(FEED, feedSetup)).size;
  console.log(`kill during install: ${oldVersion} -> ${newVersion} (${os.arch()})`);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-killin-'));
  const cfg = fs.readFileSync(path.join(path.dirname(exe), 'resources', 'app-update.yml'), 'utf8');
  const cacheName = /updaterCacheDirName:\s*(\S+)/.exec(cfg)?.[1] ?? 'paper-trail-updater';
  const cacheDir = path.join(process.env.LOCALAPPDATA ?? '', cacheName);
  const pending = path.join(cacheDir, 'pending');
  fs.rmSync(cacheDir, { recursive: true, force: true });

  const session = path.join(userData, 'before-crash.ptl');
  fs.copyFileSync(path.join(ROOT, 'sample', 'WStarCats.ptl'), session);
  const sessionBefore = fs.readFileSync(session, 'utf8');

  const env = {
    ...process.env as Record<string, string>,
    PT_USERDATA: userData, PT_SHOT: '1', PT_UPDATE_URL: 'http://127.0.0.1:8782',
  };
  const server = serveFeed(8782);
  const eApp = await _electron.launch({ executablePath: exe, args: [], env });
  try {
    await eApp.firstWindow();
    const downloaded = await waitFor(() =>
      fs.existsSync(pending) && fs.readdirSync(pending).some((f) =>
        f.toLowerCase().endsWith('.exe') && fs.statSync(path.join(pending, f)).size === feedSize),
    300_000);
    check('the update downloaded before the install', downloaded, pending);
    if (!downloaded) process.exit(1);
    // A normal quit spawns the install-on-quit installer.
    await eApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((w) => w.close());
    });
  } finally {
    await eApp.close().catch(() => { /* quitting */ });
  }

  // The installer is now replacing files. HARD-KILL it and the app the
  // instant it appears — the force-shutdown-mid-install moment.
  const sawInstaller = await waitFor(() => running(installerImage), 60_000, 100);
  check('the quit-install spawned the installer', sawInstaller);
  kill(installerImage);
  kill(image);
  await waitFor(() => !running(installerImage) && !running(image), 30_000);
  console.log(`  killed mid-install; exe reads "${exeVersion(exe) || '(unreadable)'}"`);

  // Recovery: give the updater a chance to finish/repair, then the
  // invariant — the app is a COHERENT version and smoke-passes. If the
  // kill left it broken, a fresh launch + re-check must heal it.
  let coherent = await waitFor(() => {
    const v = norm(exeVersion(exe));
    return v === norm(oldVersion) || v === norm(newVersion);
  }, 60_000, 1000);
  if (!coherent || (fs.existsSync(exe) && spawnSync(exe, ['--smoke'],
    { timeout: 120_000, env: { ...process.env, PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-killin-s0-')) } }).status !== 0)) {
    // Broken mid-install: the updater should heal on the next launch
    // (re-run the pending installer / re-download).
    console.log('  app looked broken post-kill; attempting recovery launch');
    const heal = await _electron.launch({ executablePath: exe, args: [], env }).catch(() => null);
    if (heal) {
      await heal.firstWindow().catch(() => { /* */ });
      await waitFor(() => norm(exeVersion(exe)) === norm(newVersion), 300_000);
      await heal.close().catch(() => { /* */ });
    }
    coherent = [norm(oldVersion), norm(newVersion)].includes(norm(exeVersion(exe)));
    if (running(image)) kill(image);
  }
  check('after the kill the app is a coherent version (old or new), never broken',
    coherent, exeVersion(exe) || '(unreadable)');
  const smoke = spawnSync(exe, ['--smoke'], {
    timeout: 180_000,
    env: { ...process.env, PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-killin-s-')) },
  });
  check('the app smoke-passes after a kill mid-install (not corrupt)',
    smoke.status === 0, `exit ${smoke.status}`);
  check('the saved reading session survived intact',
    fs.existsSync(session) && fs.readFileSync(session, 'utf8') === sessionBefore);

  if (running(image)) kill(image);
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

run().catch((e) => { console.error(e); process.exit(1); });
