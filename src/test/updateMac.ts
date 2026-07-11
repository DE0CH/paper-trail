// Auto-update test, macOS: the packaged current-version app is pointed
// at a local HTTP feed carrying the next version (built by CI into
// dist-update-feed) and must find and fully download it. Installation
// itself is exercised only by real releases — Squirrel.Mac refuses the
// unsigned builds CI produces — so the check stops at the
// update-downloaded event, which the app reports via PT_UPDATE_TEST.
// Run (CI, macOS): node build-node/test/updateMac.js

import { execFileSync, spawn } from 'node:child_process';
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
  server.listen(8766, '127.0.0.1');
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

async function run(): Promise<void> {
  const feedYml = fs.readFileSync(path.join(FEED, 'latest-mac.yml'), 'utf8');
  const newVersion = /version:\s*(\S+)/.exec(feedYml)?.[1] ?? '';
  const app = findApp();
  if (!app) {
    console.error('FAIL  no packaged Paper Trail.app in dist-electron');
    process.exit(1);
  }
  const bin = path.join(app, 'Contents', 'MacOS', 'Paper Trail');
  const oldVersion = execFileSync('defaults',
    ['read', path.join(app, 'Contents', 'Info'), 'CFBundleShortVersionString'],
    { encoding: 'utf8' }).trim();
  console.log(`update feed: ${oldVersion} -> ${newVersion} (${os.arch()})`);

  const server = serveFeed();
  try {
    // spawn, not spawnSync: the feed server lives in THIS process and
    // a blocked event loop would refuse the app's connections
    const out = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(bin, [], {
          env: {
            ...process.env,
            PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updm-')),
            PT_SHOT: '1',
            PT_UPDATE_URL: 'http://127.0.0.1:8766',
            PT_UPDATE_TEST: 'download',
          },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d; });
        child.stderr.on('data', (d: Buffer) => { stderr += d; });
        const timer = setTimeout(() => child.kill(), 300_000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve({ status: code, stdout, stderr });
        });
      });
    const downloaded = out.status === 0
      && out.stdout.includes(`PT_UPDATE_DOWNLOADED ${newVersion}`);
    console.log(`${downloaded ? 'PASS' : 'FAIL'}  the app finds and downloads the update`
      + `  — exit ${out.status} ${out.stdout.trim().slice(-200)} ${out.stderr.trim().slice(-200)}`);
    process.exit(downloaded ? 0 : 1);
  } finally {
    server.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
