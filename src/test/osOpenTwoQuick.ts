// Two OS file-opens in quick succession must land in TWO windows, one
// document each. The bug: routing tested only the window title, which
// has not changed yet while the first document is still in flight — so
// both dispatches hit the same "empty" window and the renderer's two
// opens raced, silently losing one PDF. The shell must mark a window
// claimed at dispatch, not at load.
//
// Run (CI): npx electron build-node/test/osOpenTwoQuick.js

const nodeFs = require('node:fs') as typeof import('node:fs');
const nodePath = require('node:path') as typeof import('node:path');
const nodeOs = require('node:os') as typeof import('node:os');
const tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'pt-twoquick-'));
process.env.PT_USERDATA = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'pt-twoquick-ud-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';

// Two distinctly named copies of the sample, so each window's title
// tells which document it ended up with.
const SAMPLE = path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf');
const ALPHA = path.join(tmp, 'AlphaOne.pdf');
const BRAVO = path.join(tmp, 'BravoTwo.pdf');
nodeFs.copyFileSync(SAMPLE, ALPHA);
nodeFs.copyFileSync(SAMPLE, BRAVO);

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

  // Back-to-back, same tick — before the first document can possibly
  // have loaded (the exact shape of a multi-select Open, or two files
  // double-clicked together).
  app.emit('open-file', { preventDefault: () => { /* handled */ } }, ALPHA);
  app.emit('open-file', { preventDefault: () => { /* handled */ } }, BRAVO);

  const count = await waitFor(() => windows().length, (n) => n >= 2, 20_000);
  check('two quick opens land in two windows', count === 2, `${count} windows`);

  const titles = await waitFor(
    () => windows().map((w) => w.getTitle()),
    (ts) => ts.some((t) => t.includes('AlphaOne')) && ts.some((t) => t.includes('BravoTwo')),
    30_000);
  check('neither document was lost (both titles present)',
    titles.some((t) => t.includes('AlphaOne')) && titles.some((t) => t.includes('BravoTwo')),
    JSON.stringify(titles));
  check('no window shows both (one document per window)',
    !titles.some((t) => t.includes('AlphaOne') && t.includes('BravoTwo')),
    JSON.stringify(titles));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  two-quick-opens regression errored', e);
      app.exit(1);
    });
  }, 14_000);
});
