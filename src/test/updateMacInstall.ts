// Auto-update INSTALL test, macOS: the full cycle, possible only when
// the build is code-signed (Squirrel.Mac refuses unsigned updates, so
// CI runs this only when the signing secrets are available). The
// current signed app downloads the next version from a local feed and
// quits into Squirrel (PT_UPDATE_TEST=install); the test passes when
// the app bundle on disk has actually advanced to the new version and
// the updated app passes the smoke probe.
// Run (CI, macOS, signed builds): node build-node/test/updateMacInstall.js

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const FEED = path.join(ROOT, 'dist-update-feed');

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
  server.listen(8768, '127.0.0.1');
  return server;
}

function findApp(): string | null {
  const dist = path.join(ROOT, 'dist-electron');
  for (const dir of fs.readdirSync(dist)) {
    const app = path.join(dist, dir, 'Paper Trail.app');
    if (dir.startsWith('mac') && fs.existsSync(app)) return app;
  }
  return null;
}

function bundleVersion(app: string): string {
  try {
    return execFileSync('defaults',
      ['read', path.join(app, 'Contents', 'Info'), 'CFBundleShortVersionString'],
      { encoding: 'utf8' }).trim();
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

async function run(): Promise<void> {
  const newVersion = /version:\s*(\S+)/.exec(
    fs.readFileSync(path.join(FEED, 'latest-mac.yml'), 'utf8'))?.[1] ?? '';
  const app = findApp();
  if (!app) {
    console.error('FAIL  no packaged Paper Trail.app in dist-electron');
    process.exit(1);
  }
  const bin = path.join(app, 'Contents', 'MacOS', 'Paper Trail');
  console.log(`signed update install: ${bundleVersion(app)} -> ${newVersion} (${os.arch()})`);

  const server = serveFeed();
  try {
    const child = spawn(bin, [], {
      env: {
        ...process.env,
        PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updi-')),
        PT_SHOT: '1',
        PT_UPDATE_URL: 'http://127.0.0.1:8768',
        PT_UPDATE_TEST: 'install',
      },
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    // the app downloads, quits into Squirrel, and Squirrel replaces the
    // bundle in place (and relaunches the new version)
    const updated = await waitFor(() => bundleVersion(app) === newVersion, 240_000);
    console.log(`${updated ? 'PASS' : 'FAIL'}  Squirrel installs the signed update`
      + `  — bundle now ${bundleVersion(app) || '(unreadable)'}`);
    // stop the relaunched copy before smoking our own
    spawnSync('pkill', ['-f', bin]);
    await new Promise((r) => setTimeout(r, 2000));

    let smoked = false;
    if (updated) {
      const smoke = spawnSync(bin, ['--smoke'], {
        timeout: 180_000,
        env: { ...process.env, PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updi2-')) },
      });
      smoked = smoke.status === 0;
      console.log(`${smoked ? 'PASS' : 'FAIL'}  updated app passes the smoke probe`
        + `  — exit ${smoke.status}`);
    }
    process.exit(updated && smoked ? 0 : 1);
  } finally {
    server.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
