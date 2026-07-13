// Update RESILIENCE, macOS install phase (signed builds only —
// Squirrel.Mac refuses unsigned updates, so CI runs this only when the
// signing secrets are present). Force-killing everything WHILE Squirrel
// is replacing the app bundle — the abrupt case of a force-quit or a
// power-off mid-install — must never leave a half-replaced, broken
// bundle. Squirrel stages the new app and swaps it in with an atomic
// rename, so the live bundle is only ever the OLD or the fully-NEW
// version; this proves that invariant holds under a hard kill:
//   - after the interruption the bundle reports a coherent version
//     (old or new, never empty/garbage) and passes the smoke probe;
//   - the updater recovers — a subsequent install cycle still works;
//   - a reading session written beforehand is intact.
// Run against a COPY so the packaged original stays pristine.
// Run (CI, macOS, signed builds): node build-node/test/updateMacKillDuringInstall.js

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
  server.listen(8770, '127.0.0.1');
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

function bundleVersion(app: string): string {
  try {
    return execFileSync('defaults',
      ['read', path.join(app, 'Contents', 'Info'), 'CFBundleShortVersionString'],
      { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    return ''; // mid-replacement or unreadable
  }
}

function killAll(): void {
  // Everything that could be mid-install: the app, Squirrel's helper,
  // and ditto (the unpack). Never blocks — bounded.
  for (const pat of [`${PRODUCT}.app`, 'ShipIt', 'Squirrel', 'ditto']) {
    spawnSync('pkill', ['-9', '-f', pat], { timeout: 10_000 });
  }
}

async function waitFor(cond: () => boolean, ms: number, step = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}

async function run(): Promise<void> {
  const newVersion = /version:\s*(\S+)/.exec(
    fs.readFileSync(path.join(FEED, 'latest-mac.yml'), 'utf8'))?.[1] ?? '';
  const packaged = findApp();
  if (!packaged) {
    console.error('FAIL  no packaged Paper Trail.app in dist-electron');
    process.exit(1);
  }
  // Work on a COPY (ditto preserves the signature); the original stays
  // pristine for sibling tests.
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-killinst-app-')),
    `${PRODUCT}.app`);
  execFileSync('ditto', [packaged, app], { timeout: 120_000 });
  const bin = path.join(app, 'Contents', 'MacOS', PRODUCT);
  const oldVersion = bundleVersion(app);
  console.log(`kill during install: ${oldVersion} -> ${newVersion} (${os.arch()})`);

  // A reading session that must survive the crash.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-killinst-'));
  const session = path.join(userData, 'resilience.ptl');
  const sessionBody = 'paper-trail-session v1\npdf WStarCats.pdf\nh 1 0 start\n';
  fs.writeFileSync(session, sessionBody);

  const server = serveFeed();
  try {
    // Launch into the install path: PT_UPDATE_TEST=install makes the
    // app download and quitAndInstall, handing off to Squirrel.
    const child = spawn(bin, [], {
      env: {
        ...process.env,
        PT_USERDATA: userData,
        PT_SHOT: '1',
        PT_UPDATE_URL: 'http://127.0.0.1:8770',
        PT_UPDATE_TEST: 'install',
      },
      stdio: 'ignore',
      detached: true,
    });
    child.unref();

    // Wait until the replacement is actually in flight — either the
    // bundle version already flipped, or its Info is momentarily
    // unreadable (mid-swap) — then hard-kill EVERYTHING repeatedly
    // across the install window to maximize the chance of landing a
    // kill mid-replace. Bounded by a deadline throughout.
    await waitFor(() => bundleVersion(app) !== oldVersion, 240_000, 500);
    const sprayDeadline = Date.now() + 8000;
    while (Date.now() < sprayDeadline) {
      killAll();
      await new Promise((r) => setTimeout(r, 400));
    }
    // Let any half-finished Squirrel work settle, then make sure
    // nothing update-related is still alive.
    await new Promise((r) => setTimeout(r, 4000));
    killAll();
    await new Promise((r) => setTimeout(r, 2000));

    // THE INVARIANT: the live bundle is a coherent version — old or
    // new, never empty/garbage — and it launches.
    const version = bundleVersion(app);
    const coherent = version === oldVersion || version === newVersion;
    check('after a hard kill mid-install the bundle is a coherent version (old or new)',
      coherent, `bundle now "${version || '(unreadable)'}"`);
    check('the app binary still exists (not a half-deleted bundle)',
      fs.existsSync(bin));

    const smoke = spawnSync(bin, ['--smoke'], {
      timeout: 180_000,
      env: { ...process.env, PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-killinst2-')) },
    });
    check('the interrupted app still passes the smoke probe (not corrupt)',
      smoke.status === 0, `exit ${smoke.status}`);

    // The updater recovers: a fresh install cycle still reaches the new
    // version (unless the crash already left us there).
    if (version !== newVersion) {
      const retry = spawn(bin, [], {
        env: {
          ...process.env,
          PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-killinst3-')),
          PT_SHOT: '1',
          PT_UPDATE_URL: 'http://127.0.0.1:8770',
          PT_UPDATE_TEST: 'install',
        },
        stdio: 'ignore',
        detached: true,
      });
      retry.unref();
      const recovered = await waitFor(() => bundleVersion(app) === newVersion, 240_000);
      check('the updater recovers — a retry install reaches the new version',
        recovered, `bundle now "${bundleVersion(app) || '(unreadable)'}"`);
      spawnSync('pkill', ['-9', '-f', bin], { timeout: 10_000 });
    } else {
      check('the updater recovers — a retry install reaches the new version',
        true, '(the interrupted install already completed)');
    }

    check('the reading session written beforehand is intact',
      fs.existsSync(session) && fs.readFileSync(session, 'utf8') === sessionBody);
  } finally {
    killAll();
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
