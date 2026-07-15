// An Explorer double-click while the app is minimized arrives as a
// second-instance file open that routes into the existing empty window.
// That window must come forward — the bug: the file branch never
// showed/focused/restored anything (only the NO-file branch did), so
// the document loaded invisibly in a minimized window and the app
// looked dead. Emitted directly, so the check runs on every platform.
//
// Run (CI): npx electron build-node/test/secondInstanceReveal.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-sireveal-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';

const SAMPLE = path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf');

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
  const win = windows()[0];

  win.minimize();
  const minimized = await waitFor(() => win.isMinimized(), (m) => m, 10_000);
  check('the window can be minimized on this runner', minimized,
    String(minimized));

  // Explorer double-click while the app is minimized: a second process
  // with the file in argv, routed into the existing empty window.
  app.emit('second-instance', {}, [process.execPath, SAMPLE], {});

  const restored = await waitFor(
    () => !win.isMinimized() && win.isVisible(), (v) => v, 15_000);
  check('the receiving window is restored and visible (not loading invisibly)',
    restored, `minimized=${win.isMinimized()} visible=${win.isVisible()}`);

  const title = await waitFor(() => win.getTitle(),
    (t) => t.includes('WStarCats'), 30_000);
  check('…and it is the one showing the document', title.includes('WStarCats'),
    title);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  second-instance reveal regression errored', e);
      app.exit(1);
    });
  }, 14_000);
});
