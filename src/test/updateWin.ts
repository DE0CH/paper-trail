// Auto-update test, Windows: the REAL cycle a user's machine goes
// through. Installs the current-version Setup, points the installed
// app at a local HTTP feed carrying the next version (built by CI into
// dist-update-feed), and lets electron-updater download and install
// it; the test passes when the installed app's version has actually
// advanced and the updated app still passes the smoke probe.
// Run (CI, Windows): node build-node/test/updateWin.js

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const FEED = path.join(ROOT, 'dist-update-feed');
const PRODUCT = 'Paper Trail';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function ps(cmd: string): string {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }).trim();
}

function shortcutTarget(lnk: string): string {
  return ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`);
}

function productVersion(exe: string): string {
  // during the update the exe is briefly locked or absent — report ''
  try {
    return ps(`(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`);
  } catch {
    return '';
  }
}

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
  server.listen(8766, '127.0.0.1');
  return server;
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
  const oldVersion = (JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  const feedYml = fs.readFileSync(path.join(FEED, 'latest.yml'), 'utf8');
  const newVersion = /version:\s*(\S+)/.exec(feedYml)?.[1] ?? '';
  check('feed carries a newer version', newVersion !== '' && newVersion !== oldVersion,
    `${oldVersion} -> ${newVersion}`);

  const setup = fs.readdirSync(path.join(ROOT, 'dist-electron'))
    .find((f) => /Setup.*\.exe$/i.test(f));
  if (!setup) {
    console.error('FAIL  no current-version Setup exe in dist-electron');
    process.exit(1);
  }
  spawnSync(path.join(ROOT, 'dist-electron', setup), ['/S'], { timeout: 300_000 });
  const lnk = path.join(os.homedir(), 'Desktop', `${PRODUCT}.lnk`);
  await waitFor(() => fs.existsSync(lnk), 90_000);
  const exe = shortcutTarget(lnk);
  check('old version installs', fs.existsSync(exe) && productVersion(exe).startsWith(oldVersion),
    `${exe} at ${productVersion(exe)}`);

  const server = serveFeed();
  try {
    // The app checks the local feed, downloads, and quits into the
    // updater (PT_UPDATE_TEST=install); NSIS then installs silently.
    const child = spawn(exe, [], {
      env: {
        ...process.env,
        PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-upd-')),
        PT_UPDATE_URL: 'http://127.0.0.1:8766',
        PT_UPDATE_TEST: 'install',
      },
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    const updated = await waitFor(
      () => fs.existsSync(exe) && productVersion(exe).startsWith(newVersion), 240_000);
    check('the installed app updates itself from the feed', updated,
      `installed version now ${fs.existsSync(exe) ? productVersion(exe) : 'gone'}`);

    if (updated) {
      const smoke = spawnSync(exe, ['--smoke'], {
        timeout: 180_000,
        env: { ...process.env, PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-upd2-')) },
      });
      check('updated app passes the smoke probe', smoke.status === 0, `exit ${smoke.status}`);
    }
  } finally {
    server.close();
  }

  const uninstaller = path.join(path.dirname(exe), `Uninstall ${PRODUCT}.exe`);
  if (fs.existsSync(uninstaller)) spawnSync(uninstaller, ['/S'], { timeout: 300_000 });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
