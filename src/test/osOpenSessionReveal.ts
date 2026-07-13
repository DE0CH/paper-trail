// Double-clicking a .ptl session opens it with no PDF yet (the pending
// "open the PDF" state). That window must be revealed BY the loaded
// session — not left hidden until the 4s safety timer fires. The bug:
// enterPendingState set no title, so the shell's title-driven reveal
// never fired and the window only appeared on the timeout. This witness
// pins it deterministically WITHOUT a wall-clock threshold: it checks
// the title AT THE MOMENT of reveal. On the bug the reveal is the timer,
// and the title is still the bare app name; with the fix the reveal is
// the session title itself. (The reveal logic lives in the shell and is
// platform-agnostic, so one OS witnesses it for all.)
//
// Run (CI): npx electron build-node/test/osOpenSessionReveal.js

const nodeFs = require('node:fs') as typeof import('node:fs');
const nodePath = require('node:path') as typeof import('node:path');
const userData = nodeFs.mkdtempSync(
  nodePath.join((require('node:os') as typeof import('node:os')).tmpdir(), 'pt-session-reveal-'));
process.env.PT_USERDATA = userData;

import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';

// A double-clicked .ptl arrives as a file argument, exactly like a PDF.
const SESSION = path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.ptl');
process.argv.push(SESSION);

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function waitFor<T>(get: () => T, want: (v: T) => boolean,
  ms: number, step = 100): Promise<T> {
  const deadline = Date.now() + ms;
  let v = get();
  while (!want(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, step));
    v = get();
  }
  return v;
}

async function run(): Promise<void> {
  // Grab the window the instant it exists — before the renderer boots —
  // so we see it in its initial hidden state.
  const win = await waitFor(
    () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()),
    (w) => !!w, 10_000, 5);
  if (!win) throw new Error('no window appeared');

  check('a window opened for a .ptl starts hidden', !win.isVisible());

  // Wait past the point of reveal (patiently — well beyond the 4s safety
  // timer, so the buggy build DOES eventually reveal and we can inspect
  // why). The title read here is the title AT reveal: the timer never
  // touches it, so on the bug it is still 'Paper Trail'.
  const revealed = await waitFor(() => win.isVisible(), (v) => v, 15_000);
  const titleAtReveal = win.getTitle();

  check('the .ptl window is revealed, not left hidden', revealed,
    `visible=${revealed}`);
  // The whole contract: the loaded session reveals the window. If this
  // fails with title 'Paper Trail', the window was revealed by the
  // fallback timer — the bug.
  check('the loaded session reveals the window (title is the session, not the timer)',
    revealed && titleAtReveal !== 'Paper Trail' && /WStarCats/i.test(titleAtReveal),
    `title=${JSON.stringify(titleAtReveal)}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  run().catch((e) => {
    console.error('FAIL  .ptl session-reveal regression errored', e);
    app.exit(1);
  });
});
