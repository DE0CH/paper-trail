// The toast path of Windows auto-update: a background download
// finishes while the user reads ("Paper Trail X is ready — quit the
// app to finish updating"), the user quits NORMALLY (no menu, no test
// seams), and autoInstallOnAppQuit applies the update on the way out.
// The next launch must be the new version. This is the flow real users
// live in — the existing updateWin test drives quitAndInstall
// directly and never exercised install-on-quit.
// Run (CI, Windows): node build-node/test/updateWinQuitInstall.js

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
  server.listen(8774, '127.0.0.1');
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
  console.log(`install on quit: ${exeVersion(exe)} -> ${newVersion} (${os.arch()})`);

  const server = serveFeed();
  const eApp = await _electron.launch({
    executablePath: exe,
    args: [],
    env: {
      ...process.env as Record<string, string>,
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updq-')),
      PT_SHOT: '1',
      PT_UPDATE_URL: 'http://127.0.0.1:8774',
    },
  });
  try {
    const page = await eApp.firstWindow();

    // The user-visible signal that the background download finished.
    await page.waitForFunction((v) =>
      (document.getElementById('toast')?.textContent ?? '').includes(v),
    newVersion, { timeout: 300_000 });
    check('the update-ready toast names the new version', true);

    // A normal quit: close the only window, no seams involved.
    await eApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((w) => w.close());
    });

    const updated = await waitFor(() => exeVersion(exe) === newVersion, 300_000);
    check('quitting installs the downloaded update',
      updated, `exe now ${exeVersion(exe) || '(unreadable)'}`);

    let smoked = false;
    if (updated) {
      const smoke = spawnSync(exe, ['--smoke'], {
        timeout: 180_000,
        env: { ...process.env, PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updq2-')) },
        encoding: 'utf8',
      });
      smoked = smoke.status === 0;
      check('the updated app passes the smoke probe', smoked, `exit ${smoke.status}`);
    }

    // Cleanup: the update may relaunch the app (force-run); stop it,
    // then uninstall.
    spawnSync('taskkill', ['/F', '/IM', path.basename(exe)], { timeout: 60_000 });
    const uninstaller = path.join(path.dirname(exe), `Uninstall ${PRODUCT}.exe`);
    if (fs.existsSync(uninstaller)) {
      spawnSync(uninstaller, ['/S'], { timeout: 300_000 });
      await waitFor(() => !fs.existsSync(exe), 90_000);
    }
  } finally {
    await eApp.close().catch(() => { /* the app quit on its own */ });
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
