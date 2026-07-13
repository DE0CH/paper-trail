// Update RESILIENCE, macOS (download phase — no signing needed, so it
// runs everywhere). Something unexpected happening while an update is
// downloading must never leave the app corrupt or the updater wedged:
//   1. a corrupted download (bytes that fail the sha512 in the feed)
//      surfaces a clean error and installs nothing;
//   2. after that failure the NEXT check/download succeeds — the
//      updater recovers, it isn't stuck;
//   3. force-killing (SIGKILL) the app mid-download and relaunching
//      leaves no poisoned pending state — the fresh download completes;
//   4. a reading session written before all this is byte-for-byte
//      intact afterward (user data is never touched by the updater).
// The app runs unpackaged here (electron entry + forceDevUpdateConfig),
// which reaches the download states without a code signature; the
// signed bundle-replacement corruption case is updateMacKillDuringInstall.
// Run (CI, macOS): node build-node/test/updateMacInterruptResilience.js

import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'build-node', 'desktop', 'main.js');
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron');
const PORT = 8769;
const CACHE = 'pt-resil-updater';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// A mode-switchable feed. 'good' serves a zip matching the yml sha512;
// 'corrupt' serves the RIGHT length but wrong bytes (sha512 fails);
// 'slow' serves the good bytes dripped so a kill can land mid-download.
const FEED_VERSION = '99.0.0';
const zipBytes = crypto.randomBytes(512 * 1024);
const sha512 = crypto.createHash('sha512').update(zipBytes).digest('base64');
const corruptBytes = crypto.randomBytes(zipBytes.length); // same size, wrong hash
let mode: 'good' | 'corrupt' | 'slow' = 'good';

function yml(): string {
  return [
    `version: ${FEED_VERSION}`,
    'files:',
    `  - url: update-${FEED_VERSION}-mac.zip`,
    `    sha512: ${sha512}`,
    `    size: ${zipBytes.length}`,
    `path: update-${FEED_VERSION}-mac.zip`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-01-01T00:00:00.000Z'",
  ].join('\n');
}

function serveFeed(): http.Server {
  const server = http.createServer((req, res) => {
    const name = (req.url ?? '').split('/').pop() ?? '';
    if (name.startsWith('latest')) {
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(yml());
    } else if (name.endsWith('.zip')) {
      if (mode === 'corrupt') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(corruptBytes.length),
        });
        res.end(corruptBytes);
      } else if (mode === 'slow') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(zipBytes.length),
        });
        const chunk = Math.ceil(zipBytes.length / 40);
        let sent = 0;
        const timer = setInterval(() => {
          if (sent >= zipBytes.length || res.destroyed) {
            clearInterval(timer);
            res.end();
            return;
          }
          res.write(zipBytes.subarray(sent, sent + chunk));
          sent += chunk;
        }, 500);
      } else {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(zipBytes.length),
        });
        res.end(zipBytes);
      }
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  server.listen(PORT, '127.0.0.1');
  return server;
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-resil-'));

function baseEnv(): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    PT_USERDATA: userData,
    PT_SHOT: '1', // never steal focus on the runner
    PT_UPDATE_URL: `http://127.0.0.1:${PORT}`,
  };
}

// Run the app to a self-reported updater outcome. With PT_UPDATE_TEST
// the shell prints PT_UPDATE_DOWNLOADED and exits 0 on a good download,
// or PT_UPDATE_ERROR and exits 1 on any updater error. Always bounded:
// killed if it overruns the deadline.
async function runUntilOutcome(ms: number): Promise<{ code: number | null; out: string }> {
  return await new Promise((resolve) => {
    const child = spawn(ELECTRON, [ENTRY], {
      env: { ...baseEnv(), PT_UPDATE_TEST: 'download' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const grab = (b: Buffer): void => { out += b.toString(); };
    child.stdout?.on('data', grab);
    child.stderr?.on('data', grab);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, ms);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, out }); });
  });
}

function pendingDir(): string {
  return path.join(process.env.HOME ?? os.homedir(), 'Library', 'Caches', CACHE, 'pending');
}

async function run(): Promise<void> {
  if (!fs.existsSync(ELECTRON) || !fs.existsSync(ENTRY)) {
    console.error('FAIL  need the built app entry and local electron');
    process.exit(1);
  }
  // Dev runs read dev-app-update.yml for the updater cache-dir name
  // (the feed itself comes from PT_UPDATE_URL). electron-updater looks
  // relative to the resolved app path, which can be the repo root or
  // the entry's directory depending on how electron is invoked — write
  // it to both so it's always found.
  const devYml = `provider: generic\nurl: http://127.0.0.1:${PORT}\nupdaterCacheDirName: ${CACHE}\n`;
  for (const dir of [ROOT, path.dirname(ENTRY)]) {
    try { fs.writeFileSync(path.join(dir, 'dev-app-update.yml'), devYml); } catch { /* fine */ }
  }
  // Clean slate for the shared updater cache.
  fs.rmSync(path.join(process.env.HOME ?? os.homedir(), 'Library', 'Caches', CACHE),
    { recursive: true, force: true });

  // A reading session the interruptions must never touch.
  const session = path.join(userData, 'resilience.ptl');
  const sessionBody = 'paper-trail-session v1\npdf WStarCats.pdf\nh 1 0 start\n';
  fs.writeFileSync(session, sessionBody);

  const server = serveFeed();
  try {
    // 1 — a corrupted download fails cleanly and installs nothing.
    mode = 'corrupt';
    const corrupt = await runUntilOutcome(120_000);
    check('a corrupted download surfaces a clean error (non-zero exit, no crash)',
      corrupt.code === 1 && /PT_UPDATE_ERROR/.test(corrupt.out),
      `exit ${corrupt.code}`);
    check('the corrupted download installs nothing (no completed pending update)',
      !fs.existsSync(pendingDir())
        || !fs.readdirSync(pendingDir()).some((f) => f.endsWith('.zip')
          && fs.statSync(path.join(pendingDir(), f)).size === zipBytes.length),
      pendingDir());

    // 2 — the updater recovers: the next download succeeds.
    mode = 'good';
    const recover = await runUntilOutcome(120_000);
    check('after the corrupt failure the next download succeeds (updater recovered)',
      recover.code === 0 && /PT_UPDATE_DOWNLOADED/.test(recover.out),
      `exit ${recover.code}`);

    // 3 — force-kill mid-download, then relaunch: no poisoned state.
    fs.rmSync(path.join(process.env.HOME ?? os.homedir(), 'Library', 'Caches', CACHE),
      { recursive: true, force: true });
    mode = 'slow';
    const bg = spawn(ELECTRON, [ENTRY], { env: baseEnv(), stdio: 'ignore' }) as ChildProcess;
    await new Promise((r) => setTimeout(r, 6000)); // let the slow download get underway
    const midHadPartial = fs.existsSync(pendingDir())
      && fs.readdirSync(pendingDir()).length > 0;
    try { bg.kill('SIGKILL'); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 2000));
    check('a partial download was underway when it was force-killed',
      midHadPartial, pendingDir());
    mode = 'good';
    const afterKill = await runUntilOutcome(120_000);
    check('relaunch after a force-killed download completes cleanly (no poisoned partial)',
      afterKill.code === 0 && /PT_UPDATE_DOWNLOADED/.test(afterKill.out),
      `exit ${afterKill.code}`);

    // 4 — the reading session is byte-for-byte intact through all of it.
    check('the reading session written beforehand is intact',
      fs.existsSync(session) && fs.readFileSync(session, 'utf8') === sessionBody);
  } finally {
    server.close();
    spawnSync('pkill', ['-f', ENTRY], { timeout: 30_000 });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
