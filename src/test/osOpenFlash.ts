// Double-clicking a PDF must open it cleanly:
//   - launching the app with a file shows ONE window that is never
//     visible while still empty (no flash of a blank window), at the
//     exact remembered position (no cascade offset);
//   - an OS file-open while the app is running reuses ANY empty
//     window, not just a focused one — it must not spawn an offset
//     third window while an empty one sits there.
// This harness deliberately runs WITHOUT PT_SHOT: visibility is the
// thing under test (CI only — windows do appear on the runner).
//
// Run (CI): npx electron build-node/test/osOpenFlash.js

const nodeFs = require('node:fs') as typeof import('node:fs');
const nodePath = require('node:path') as typeof import('node:path');
const userData = nodeFs.mkdtempSync(
  nodePath.join((require('node:os') as typeof import('node:os')).tmpdir(), 'pt-osopen-'));
process.env.PT_USERDATA = userData;
// The remembered position: any cascade offset shows up against it.
nodeFs.writeFileSync(nodePath.join(userData, 'window-state.json'),
  JSON.stringify({ x: 180, y: 120, width: 1200, height: 800 }));

import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';

const SAMPLE = path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf');
process.argv.push(SAMPLE); // a double-clicked PDF arrives as an argument

// Record the FIRST moment any window becomes visible, and what it was
// showing at that moment. The polling starts before the app is ready.
let firstVisible: { title: string } | null = null;
const visPoll = setInterval(() => {
  if (firstVisible) return;
  const w = BrowserWindow.getAllWindows().find(
    (x) => !x.isDestroyed() && x.isVisible());
  if (w) firstVisible = { title: w.getTitle() };
}, 50);

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
  await waitFor(() => windows()[0]?.getTitle() ?? '',
    (t) => t.includes('WStarCats'), 30_000);
  clearInterval(visPoll);

  check('launching with a PDF opens exactly one window',
    windows().length === 1, `${windows().length}`);
  check('the window was never visible while still empty (no flash)',
    !!firstVisible && firstVisible.title.includes('WStarCats'),
    firstVisible?.title ?? '(never became visible)');
  const b = windows()[0].getBounds();
  check('it sits at the remembered position (no cascade offset)',
    b.x === 180 && b.y === 120, JSON.stringify(b));

  // While running: an empty second window exists; an OS open must
  // land in it, not spawn an offset third window.
  app.emit('second-instance', {}, [process.execPath, '--new-window'], {});
  await waitFor(() => windows().length, (n) => n === 2, 15_000);
  app.emit('open-file', { preventDefault: () => { /* handled */ } }, SAMPLE);
  const reusedTitle = await waitFor(
    () => windows().filter((w) => w.getTitle().includes('WStarCats')).length,
    (n) => n === 2, 30_000);
  check('an OS open reuses the empty window that is already there',
    windows().length === 2 && reusedTitle === 2,
    `${windows().length} windows, ${reusedTitle} showing the PDF`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  os-open flash regression errored', e);
      app.exit(1);
    });
  }, 2_000);
});
