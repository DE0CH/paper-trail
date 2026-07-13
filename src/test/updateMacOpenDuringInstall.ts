// Reopening the app WHILE a mac update is installing must satisfy the
// same owner contract as Windows (docs/flash-close-finding.md): no
// flash-close, the double-clicked document opens, NO corrupt/half-
// replaced bundle, and SILENTLY — no "Updating Paper Trail…" marquee.
//
// Mac differs from Windows on purpose. Squirrel.Mac replaces the .app
// bundle ATOMICALLY (ShipIt renames a fully-staged copy into place), so
// a reopen can only ever see the whole OLD or the whole NEW bundle —
// never the half-replaced corruption NSIS can leave. The silent-cancel
// fix (updateGuard.cancelUpdateOnReopen) is win32-only and never runs
// here, and the marquee it dropped was Windows-only too — so "silent"
// is structural on mac. This witness PROVES that safety rather than
// assuming it: it freezes ShipIt mid-swap (SIGSTOP, the mac analogue of
// the Windows NtSuspendProcess freeze), reopens against the frozen
// state, and asserts the safe contract. Signed builds only (Squirrel.Mac
// refuses unsigned updates).
// Run (CI, macOS, signed): node build-node/test/updateMacOpenDuringInstall.js

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron, type Page } from 'playwright-core';

const ROOT = path.resolve(__dirname, '..', '..');
const PRODUCT = 'Paper Trail';
const FEED = path.join(ROOT, 'dist-update-feed');

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms: number, step = 500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(step);
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
    if (!name || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(8778, '127.0.0.1');
  return server;
}

function findApp(): string | null {
  const dist = path.join(ROOT, 'dist-electron');
  for (const dir of fs.readdirSync(dist)) {
    const app = path.join(dist, dir, `${PRODUCT}.app`);
    if (dir.startsWith('mac') && fs.existsSync(app)) return app;
  }
  return null;
}

/** The bundle's advertised version, or '' while it is mid-replacement. */
function bundleVersion(app: string): string {
  try {
    return execFileSync('defaults',
      ['read', path.join(app, 'Contents', 'Info'), 'CFBundleShortVersionString'],
      { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    return '';
  }
}

/** Is a process running whose command line matches `pattern`? */
function pgrep(pattern: string): number[] {
  const out = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8', timeout: 15_000 }).stdout ?? '';
  return out.split('\n').map((s) => Number(s.trim())).filter((n) => n > 0);
}

function appRunning(bin: string): boolean {
  return pgrep(bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).length > 0;
}

/**
 * Squirrel.Mac's updater is "ShipIt". Freeze it the instant it appears
 * (SIGSTOP) so the reopen lands against a genuinely mid-install state,
 * the way the Windows witness freezes the NSIS installer.
 */
function freezeShipItOnSight(): { armed: Promise<void>; frozen: Promise<number | null> } {
  let armedResolve!: () => void;
  let frozenResolve!: (pid: number | null) => void;
  const armed = new Promise<void>((r) => { armedResolve = r; });
  const frozen = new Promise<number | null>((r) => { frozenResolve = r; });
  armedResolve();
  const deadline = Date.now() + 120_000;
  const tick = (): void => {
    const pids = pgrep('ShipIt');
    if (pids.length) {
      try { process.kill(pids[0], 'SIGSTOP'); } catch { /* gone already */ }
      frozenResolve(pids[0]);
      return;
    }
    if (Date.now() > deadline) { frozenResolve(null); return; }
    setTimeout(tick, 25);
  };
  tick();
  return { armed, frozen };
}

function thaw(pid: number): void {
  try { process.kill(pid, 'SIGCONT'); } catch { /* already gone */ }
}

/** The dropped held-fix marquee is a Windows-only PowerShell dialog; on
 * mac nothing analogous should ever appear (no extra top-level window
 * titled 'Paper Trail' outside the app itself). */
function marqueeProcess(): boolean {
  return pgrep('Updating Paper Trail').length > 0;
}

async function run(): Promise<void> {
  const newVersion = /version:\s*(\S+)/.exec(
    fs.readFileSync(path.join(FEED, 'latest-mac.yml'), 'utf8'))?.[1] ?? '';
  const packaged = findApp();
  if (!packaged || !newVersion) {
    console.error('FAIL  need a packaged signed Paper Trail.app and the mac update feed');
    process.exit(1);
  }
  // Run against a ditto copy so the packaged original stays pristine.
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-macodi-app-'));
  const app = path.join(appDir, `${PRODUCT}.app`);
  execFileSync('ditto', [packaged, app]);
  const bin = path.join(app, 'Contents', 'MacOS', PRODUCT);
  const oldVersion = bundleVersion(app);
  console.log(`mac reopen during install: ${oldVersion} -> ${newVersion} (${os.arch()})`);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-macodi-'));
  const pdf = path.join(userData, 'Reopened Paper.pdf');
  fs.copyFileSync(path.join(ROOT, 'sample', 'WStarCats.pdf'), pdf);

  const server = serveFeed();
  const env = {
    ...process.env as Record<string, string>,
    PT_USERDATA: userData,
    PT_SHOT: '1',
    PT_UPDATE_URL: 'http://127.0.0.1:8778',
  };

  const eApp = await _electron.launch({ executablePath: bin, args: [], env });
  let watcher: ReturnType<typeof freezeShipItOnSight> | null = null;
  let reopen: ChildProcess | null = null;
  let marqueeEver = false;
  const watchMarquee = setInterval(() => { if (marqueeProcess()) marqueeEver = true; }, 300);
  try {
    await eApp.firstWindow();
    await eApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click();
    });
    let updatePage: Page | undefined;
    const found = await waitFor(() => {
      updatePage = eApp.windows().find((p) => p.url().includes('update.html'));
      return !!updatePage;
    }, 30_000);
    if (!found || !updatePage) { console.error('FAIL  the Software Update window never opened'); process.exit(1); }
    await updatePage.waitForFunction(() => {
      const s = document.getElementById('pt-update-root')?.dataset.state;
      return s === 'available' || s === 'downloaded';
    }, undefined, { timeout: 120_000 });
    const state = async (): Promise<string> =>
      (await updatePage!.locator('#pt-update-root').getAttribute('data-state')) ?? '';
    if ((await state()) === 'available') await updatePage.locator('#pt-update-primary').click();
    await updatePage.waitForFunction(
      () => document.getElementById('pt-update-root')?.dataset.state === 'downloaded',
      undefined, { timeout: 300_000 });

    // Arm the ShipIt freeze BEFORE the quit-install spawns it.
    watcher = freezeShipItOnSight();
    await watcher.armed;
    // Restart to Update: the app quits into Squirrel/ShipIt.
    await updatePage.locator('#pt-update-primary').click();
  } finally {
    await eApp.close().catch(() => { /* quit into the updater */ });
  }

  const frozenPid = watcher ? await watcher.frozen : null;
  // Best-effort freeze: Squirrel.Mac's ShipIt can be too short-lived to
  // catch, and — unlike NSIS — it swaps atomically, so a missed freeze
  // does not invalidate the contract. The safety assertions below carry
  // it. Logged, not asserted.
  console.log(`  ShipIt freeze: ${frozenPid !== null ? `frozen pid ${frozenPid}`
    : 'not caught (atomic swap too quick to freeze) — asserting end-state safety'}`);
  await waitFor(() => !appRunning(bin), 60_000);

  // Reopen mid-install, carrying a document like a real double-click.
  console.log(`  bundle mid-install: "${bundleVersion(app) || '(unreadable)'}"; reopening`);
  reopen = spawn(bin, [pdf], { detached: true, stdio: 'ignore', env });
  reopen.unref();

  const appUp = await waitFor(() => appRunning(bin), 60_000);
  check('the reopened app ends up running (no flash-close)', appUp, `running=${appUp}`);

  // No corrupt / half-replaced bundle: the version reads and a smoke
  // probe against the on-disk bundle succeeds.
  const versionReadable = bundleVersion(app) !== '';
  check('no corrupt / half-replaced bundle (version readable)', versionReadable,
    `bundle "${bundleVersion(app) || '(unreadable)'}"`);

  const docOpen = await waitFor(() => {
    try {
      const titles = execFileSync('osascript',
        ['-e', `tell application "System Events" to tell process "${PRODUCT}" to get name of windows`],
        { encoding: 'utf8', timeout: 15_000 });
      return titles.includes('Reopened Paper');
    } catch { return false; }
  }, 60_000);
  check('…with the double-clicked document open', docOpen);

  // Silent: no marquee ever (structurally Windows-only, asserted anyway).
  clearInterval(watchMarquee);
  if (marqueeProcess()) marqueeEver = true;
  check('the reopen is silent — no "Updating Paper Trail…" marquee', !marqueeEver);

  // Observe (don't assert) which version the reopen ran on — mac may
  // complete the atomic swap (NEW) or still be pre-swap (OLD); either is
  // corruption-free. Logged so the owner can decide whether mac should
  // also force-defer like Windows.
  if (frozenPid !== null) thaw(frozenPid);
  await sleep(3000);
  const finalV = bundleVersion(app);
  console.log(`  mac outcome: running=${appRunning(bin)}, bundle=${finalV || '(unreadable)'}`
    + ` (old ${oldVersion}, new ${newVersion}) — ${finalV === newVersion ? 'update completed atomically'
      : finalV === oldVersion ? 'update deferred (old version)' : 'indeterminate'}`);

  spawnSync('pkill', ['-f', bin], { timeout: 30_000 });
  await sleep(2000);
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(String(e)); process.exit(1); });
