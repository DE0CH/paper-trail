// The no-flash contract must hold against Electron's DERIVED titles:
// during navigation, page-title-updated can fire with a title derived
// from the URL (explicitSet false) before the document sets a real
// one. Whether that early event arrives depends on machine speed —
// which is why osOpenFlash only fails intermittently. This harness
// synthesizes the derived-title event the moment the hidden window
// exists, so a reveal listener that trusts derived titles fails every
// run, deterministically.
//
// Run (CI): npx electron build-node/test/osOpenDerivedTitle.js

const nodeFs = require('node:fs') as typeof import('node:fs');
const nodePath = require('node:path') as typeof import('node:path');
const userData = nodeFs.mkdtempSync(
  nodePath.join((require('node:os') as typeof import('node:os')).tmpdir(), 'pt-derived-'));
process.env.PT_USERDATA = userData;

import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';

const SAMPLE = path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf');
process.argv.push(SAMPLE); // a double-clicked PDF arrives as an argument

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function waitFor<T>(get: () => T, want: (v: T) => boolean,
  ms: number, step = 250): Promise<T> {
  const deadline = Date.now() + ms;
  let v = get();
  while (!want(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, step));
    v = get();
  }
  return v;
}

async function run(): Promise<void> {
  // Grab the window the instant it exists: the renderer needs far
  // longer to boot than this poll needs to see the window, so the
  // synthetic event below always lands before any real title.
  const win = await waitFor(
    () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()),
    (w) => !!w, 10_000, 5);
  if (!win) throw new Error('no window appeared');

  check('a window created for a document starts hidden', !win.isVisible());

  // Electron's early navigation report: a URL-derived title,
  // explicitSet false — exactly what a fast machine delivers
  // milliseconds into the load. The listener runs synchronously.
  win.webContents.emit('page-title-updated', {}, 'app/index.html', false);
  check('a derived title must not reveal the still-empty window',
    !win.isVisible(), `visible=${win.isVisible()}`);

  // The genuine document title (explicitly set by the renderer) is
  // still the reveal signal: the window must not stay hidden forever.
  await waitFor(() => win.getTitle(), (t) => t.includes('WStarCats'), 30_000);
  const revealed = await waitFor(() => win.isVisible(), (v) => v, 5_000);
  check('the real document title still reveals the window', revealed,
    `title=${JSON.stringify(win.getTitle())}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  run().catch((e) => {
    console.error('FAIL  derived-title reveal regression errored', e);
    app.exit(1);
  });
});
