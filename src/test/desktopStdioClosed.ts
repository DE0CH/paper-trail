// Regression: apps launched by Finder/LaunchServices can get stdio
// pipes whose other end is already closed. electron-updater logs to
// the console during its startup check, and that write raised EPIPE
// and crashed the main process with Electron's error dialog the moment
// a session file was double-clicked ("Uncaught Exception: write EPIPE"
// at MacUpdater.getOrCreateStagingUserId).
//
// The packaged app is launched with both stdio pipes destroyed and
// must still complete an update check against a local feed and exit
// cleanly (PT_UPDATE_TEST=download) — no write may crash it.
// Run (CI, macOS): node build-node/test/desktopStdioClosed.js

import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const FEED = path.join(ROOT, 'dist-update-feed');
const TIMEOUT = Number(process.env.PT_STDIO_TEST_TIMEOUT ?? 240_000);

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
  server.listen(8769, '127.0.0.1');
  return server;
}

function findAppBinary(): string | null {
  const dist = path.join(ROOT, 'dist-electron');
  for (const dir of fs.readdirSync(dist)) {
    const bin = path.join(dist, dir, 'Paper Trail.app', 'Contents', 'MacOS', 'Paper Trail');
    if (dir.startsWith('mac') && fs.existsSync(bin)) return bin;
  }
  return null;
}

async function run(): Promise<void> {
  const bin = findAppBinary();
  if (!bin) {
    console.error('FAIL  no packaged Paper Trail.app in dist-electron');
    process.exit(1);
  }
  const server = serveFeed();
  try {
    const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      const child = spawn(bin, [], {
        env: {
          ...process.env,
          PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-epipe-')),
          PT_SHOT: '1',
          PT_UPDATE_URL: 'http://127.0.0.1:8769',
          PT_UPDATE_TEST: 'download',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Simulate the Finder launch: the read ends of stdout/stderr are
      // gone, so any console write inside the app raises EPIPE.
      child.stdout!.destroy();
      child.stderr!.destroy();
      const timer = setTimeout(() => {
        child.kill('SIGKILL'); // on the bug the crash dialog blocks forever
        resolve({ code: null, timedOut: true });
      }, TIMEOUT);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut: false });
      });
    });
    const ok = !result.timedOut && result.code === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  closed stdio never crashes the app`
      + `  — ${result.timedOut ? 'timed out (crash dialog?)' : `exit ${result.code}`}`);
    process.exit(ok ? 0 : 1);
  } finally {
    server.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
