// Reopening the app WHILE a quit-install is replacing its files must
// not flash-close and vanish (the owner's report: "looks like it's
// corrupt"). The contract: a reopen that lands mid-install ends with
// the app RUNNING, on the NEW version, with the double-clicked
// document open. Runners install in ~2s, so a raced reopen keeps
// missing the window (runs 29208984460, 29209714448); this witness
// removes the race: it FREEZES the installer process the moment it
// appears (NtSuspendProcess), reopens against the frozen mid-install
// state, then thaws the installer and asserts the end state.
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

// The app's window titles, for asserting the reopened document made it
// through (the reopen carries a file argument, like a real double-click).
function windowTitles(imageName: string): string {
  const base = imageName.replace(/\.exe$/i, '').replace(/'/g, "''");
  try {
    return ps(`(Get-Process -Name '${base}' -ErrorAction SilentlyContinue |
      ForEach-Object { $_.MainWindowTitle }) -join ' | '`);
  } catch {
    return '';
  }
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

// ntdll suspend/resume: the only deterministic way to hold an NSIS
// installer mid-install (its internal waits freeze with it, so nothing
// times out while frozen).
const NATIVE = `
Add-Type -Name Native -Namespace PT -MemberDefinition @'
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
'@
`;

/**
 * Watch for a process with this image name and freeze it the instant
 * it appears. A single long-lived PowerShell polls at 25ms — spawning
 * one per poll would be far too coarse for a ~2s installer. Resolves
 * with the frozen PID, or null if none appeared in time.
 */
function freezeOnSight(imageName: string): { armed: Promise<void>; frozen: Promise<number | null> } {
  const base = imageName.replace(/\.exe$/i, '').replace(/'/g, "''");
  const script = `
${NATIVE}
Write-Output 'ARMED'
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Name '${base}' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p) {
    [PT.Native]::NtSuspendProcess($p.Handle) | Out-Null
    Write-Output "FROZEN $($p.Id)"
    exit 0
  }
  Start-Sleep -Milliseconds 25
}
Write-Output 'TIMEOUT'
exit 1
`;
  const child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  let armedResolve: () => void;
  let frozenResolve: (pid: number | null) => void;
  const armed = new Promise<void>((r) => { armedResolve = r; });
  const frozen = new Promise<number | null>((r) => { frozenResolve = r; });
  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    if (buf.includes('ARMED')) armedResolve();
    const m = /FROZEN (\d+)/.exec(buf);
    if (m) frozenResolve(Number(m[1]));
    if (buf.includes('TIMEOUT')) frozenResolve(null);
  });
  child.on('exit', () => frozenResolve(null));
  return { armed, frozen };
}

function thaw(pid: number): void {
  ps(`${NATIVE}
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($p) { [PT.Native]::NtResumeProcess($p.Handle) | Out-Null }`);
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

  // The reopen carries a file argument, like a real double-click. The
  // name keeps a space on purpose: the argument must survive whatever
  // hands the reopen to the new version.
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
  let watcher: ReturnType<typeof freezeOnSight> | null = null;
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

    // Arm the freeze BEFORE the quit spawns the installer: nothing to
    // race — the watcher polls at 25ms, the install takes ~2s.
    watcher = freezeOnSight(installerName);
    await watcher.armed;

    // A normal quit: install-on-quit kicks off the installer.
    await eApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((w) => w.close());
    });
  } finally {
    await eApp.close().catch(() => { /* quit on its own */ });
  }

  // The installer is now frozen mid-install; the old app process has
  // exited. This is the exact state the owner's double-click meets —
  // and it stays that way until we thaw.
  if (!watcher) process.exit(1);
  const frozenPid = await watcher.frozen;
  check('the quit-install spawned an installer (now frozen mid-install)',
    frozenPid !== null, `pid ${frozenPid}`);
  if (frozenPid === null) process.exit(1);
  const appGone = await waitFor(() => !running(appImage), 60_000);
  check('the quitting app exited (the reopen is a fresh process)', appGone);

  console.log(`  exe mid-install: version "${exeVersion(exe) || '(unreadable)'}";`
    + ` reopening now`);
  spawn(exe, [pdf], { detached: true, stdio: 'ignore', env }).unref();

  // Let the reopen do whatever it does against the frozen install —
  // start the old version, crash, or (fixed) hand off and get out of
  // the way. Observe, don't assert: the contract is the end state.
  await waitFor(() => running(appImage), 15_000, 500);
  console.log(`  reopen settled: app running=${running(appImage)};`
    + ` thawing the installer`);
  thaw(frozenPid);

  // The end state is the whole contract: the update completed…
  const updated = await waitFor(
    () => norm(exeVersion(exe)) === norm(newVersion), 180_000);
  check('the update still completes (the reopen must not wedge it)',
    updated, `exe now ${exeVersion(exe) || '(unreadable)'}`);

  // …the app the user asked for is actually running — no flash…
  const appUp = await waitFor(() => running(appImage), 120_000);
  check('the reopened app ends up running the new version (no flash-close)',
    appUp && updated, `running=${appUp}`);

  // …and it opened the document the user double-clicked.
  const docOpen = await waitFor(
    () => windowTitles(appImage).includes('Reopened Paper'), 60_000);
  check('…with the double-clicked document open',
    docOpen, windowTitles(appImage) || '(no window titles)');

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
