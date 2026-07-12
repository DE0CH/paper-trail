// Verifies that the auto-update feed points at files that really exist
// under the exact names GitHub will serve. electron-builder writes
// URL-safe names (spaces become dashes) into latest*.yml, while GitHub
// renames uploaded release assets (spaces become dots) — so any space
// in an artifact name makes every published update check 404 (the
// v0.5.5 "Update check failed" bug). Two guarantees, per output dir:
//   1. every url:/path: entry in latest*.yml names a file that exists
//      on disk with exactly that name, and
//   2. no artifact file name contains a character GitHub rewrites.
// Run after packaging: node build-node/test/updateFeedNames.js [dir...]

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT_EXT = /\.(exe|zip|dmg|blockmap|yml)$/i;

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function feedFileNames(yml: string): string[] {
  const names: string[] = [];
  for (const line of yml.split('\n')) {
    const m = /^\s*(?:-\s+)?(?:url|path):\s*(.+?)\s*$/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

function checkDir(dir: string): void {
  const label = path.relative(ROOT, dir) || dir;
  if (!fs.existsSync(dir)) {
    check(`${label}: output directory exists`, false, 'package the app first');
    return;
  }
  const entries = fs.readdirSync(dir).filter((f) =>
    fs.statSync(path.join(dir, f)).isFile());

  const feeds = entries.filter((f) => /^latest.*\.yml$/.test(f));
  check(`${label}: update feed (latest*.yml) present`, feeds.length > 0,
    feeds.join(', ') || 'none');

  for (const feed of feeds) {
    const named = feedFileNames(fs.readFileSync(path.join(dir, feed), 'utf8'));
    check(`${label}/${feed}: references at least one file`, named.length > 0);
    for (const name of new Set(named)) {
      check(`${label}/${feed}: "${name}" exists on disk under that exact name`,
        entries.includes(name),
        entries.includes(name) ? '' :
          `closest on disk: ${entries.filter((f) => ARTIFACT_EXT.test(f)).join(', ') || '(none)'}`);
    }
  }

  for (const f of entries.filter((e) => ARTIFACT_EXT.test(e))) {
    check(`${label}: "${f}" survives a GitHub upload unrenamed`,
      !/[ ]/.test(f), /[ ]/.test(f) ? 'GitHub replaces spaces on upload' : '');
  }
}

const dirs = process.argv.slice(2).map((d) => path.resolve(ROOT, d));
if (dirs.length === 0) dirs.push(path.join(ROOT, 'dist-electron'));
for (const dir of dirs) checkDir(dir);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
