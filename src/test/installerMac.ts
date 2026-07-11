// Verifies the macOS artifacts a user installs: the dmg mounts and its
// app passes the smoke probe, the zip (which is also what auto-update
// installs) unpacks to a working app, and both contain a universal
// binary (x86_64 + arm64). CI runs this on Intel and Apple silicon
// runners so each half of the universal binary is exercised natively.
// Run (CI, macOS): node build-node/test/installerMac.js

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const APP_NAME = 'Paper Trail.app';
const BIN = path.join('Contents', 'MacOS', 'Paper Trail');

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function smokeApp(appDir: string, label: string): void {
  const bin = path.join(appDir, BIN);
  check(`${label}: app binary exists`, fs.existsSync(bin), bin);
  if (!fs.existsSync(bin)) return;

  const archs = execFileSync('lipo', ['-archs', bin], { encoding: 'utf8' }).trim();
  check(`${label}: binary is universal (x86_64 + arm64)`,
    archs.includes('x86_64') && archs.includes('arm64'), archs);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-mac-inst-'));
  const smoke = spawnSync(bin, ['--smoke'], {
    timeout: 180_000,
    env: { ...process.env, PT_USERDATA: userData },
    encoding: 'utf8',
  });
  check(`${label}: installed app passes the smoke probe (${os.arch()})`,
    smoke.status === 0,
    `exit ${smoke.status}${smoke.stdout ? ' ' + smoke.stdout.trim().slice(0, 200) : ''}`);
}

async function run(): Promise<void> {
  const distDir = path.join(ROOT, 'dist-electron');
  const artifacts = fs.readdirSync(distDir);
  const dmg = artifacts.find((f) => f.endsWith('.dmg'));
  const zip = artifacts.find((f) => f.endsWith('-mac.zip'));
  check('dmg artifact exists', !!dmg, dmg ?? 'none');
  check('mac zip artifact exists', !!zip, zip ?? 'none');

  if (dmg) {
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dmg-'));
    const appCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dmg-app-'));
    execFileSync('hdiutil', ['attach', path.join(distDir, dmg),
      '-nobrowse', '-readonly', '-mountpoint', mount], { stdio: 'ignore' });
    try {
      const inDmg = path.join(mount, APP_NAME);
      check('dmg contains the app', fs.existsSync(inDmg), inDmg);
      if (fs.existsSync(inDmg)) {
        // copy out like a user dragging it to Applications
        execFileSync('cp', ['-R', inDmg, appCopy]);
      }
    } finally {
      execFileSync('hdiutil', ['detach', mount], { stdio: 'ignore' });
    }
    smokeApp(path.join(appCopy, APP_NAME), 'dmg');
  }

  if (zip) {
    const unzipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-zip-'));
    // ditto preserves symlinks and permissions the way Archive Utility does
    execFileSync('ditto', ['-x', '-k', path.join(distDir, zip), unzipDir]);
    smokeApp(path.join(unzipDir, APP_NAME), 'zip');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
