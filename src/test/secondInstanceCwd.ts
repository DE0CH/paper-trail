// `paper-trail doc.pdf` run from some directory: the file path arrives
// in a second process's argv RELATIVE to that process's cwd, which
// Electron hands to the 'second-instance' handler. The bug: the handler
// ran fs.existsSync on the raw argument, resolving it against the FIRST
// instance's cwd — the file was never found (or a same-named file
// somewhere else would open instead). The resolution itself is unit
// tested (desktopShellUnit); this witnesses the wired-up handler.
//
// Run (CI): npx electron build-node/test/secondInstanceCwd.js

const nodeFs = require('node:fs') as typeof import('node:fs');
const nodePath = require('node:path') as typeof import('node:path');
const nodeOs = require('node:os') as typeof import('node:os');
const cwd = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'pt-cwd-'));
process.env.PT_USERDATA = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'pt-cwd-ud-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';

// The second process's working directory holds the document; our own
// cwd (the repo root) has no file by this name.
const SAMPLE = path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf');
nodeFs.copyFileSync(SAMPLE, path.join(cwd, 'RelativeDoc.pdf'));

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function windows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
}

async function waitFor<T>(get: () => T, want: (v: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  let v = get();
  while (!want(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    v = get();
  }
  return v;
}

async function run(): Promise<void> {
  check('the app starts with one empty window', windows().length === 1,
    `${windows().length}`);

  // A CLI launch from `cwd`: relative file argument + that directory.
  app.emit('second-instance', {}, [process.execPath, 'RelativeDoc.pdf'], cwd);

  const title = await waitFor(
    () => windows().map((w) => w.getTitle()).find((t) => t.includes('RelativeDoc')) ?? '',
    (t) => t.includes('RelativeDoc'), 30_000);
  check('a relative CLI path opens the file from the CALLER’s directory',
    title.includes('RelativeDoc'),
    title || `(never opened; titles: ${JSON.stringify(windows().map((w) => w.getTitle()))})`);
  check('no extra window spawned for it (the empty window was reused)',
    windows().length === 1, `${windows().length} windows`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  second-instance cwd regression errored', e);
      app.exit(1);
    });
  }, 14_000);
});
