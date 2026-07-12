// Edge cases of the desktop shell's window and file routing:
//   - an OS file-open lands in the existing EMPTY window (reuse);
//   - a second OS file-open while a document is showing gets a NEW
//     window instead of clobbering it;
//   - external links leave the app for the system browser and never
//     spawn an in-app window;
//   - the macOS title-bar proxy icon represents the open PDF;
//   - window bounds are remembered: the size of the window you closed
//     last is the size the next window opens with.
// Run (CI): npx electron build-node/test/desktopEdges.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-dedge-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';

// No native prompts, no real browser launches.
(dialog as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1; // Don't Save
const externals: string[] = [];
(shell as { openExternal: unknown }).openExternal =
  async (url: string) => { externals.push(url); };

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

const SAMPLE = path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf');

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function windows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
}

async function waitFor<T>(get: () => Promise<T> | T, want: (v: T) => boolean,
  ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  let v = await get();
  while (!want(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    v = await get();
  }
  return v;
}

async function run(): Promise<void> {
  check('the app starts with one empty window', windows().length === 1
    && windows()[0].getTitle() === 'Paper Trail', windows()[0]?.getTitle());
  const first = windows()[0];

  // An OS open lands in the empty window instead of spawning one.
  app.emit('open-file', { preventDefault: () => { /* handled */ } }, SAMPLE);
  const reusedTitle = await waitFor(() => first.getTitle(),
    (t) => t.includes('WStarCats'), 30_000);
  check('an OS file-open reuses the empty window',
    reusedTitle.includes('WStarCats') && windows().length === 1, reusedTitle);

  if (process.platform === 'darwin') {
    check('the title-bar proxy represents the open PDF',
      first.getRepresentedFilename() === SAMPLE, first.getRepresentedFilename());
  }

  // A second OS open while a document is showing gets its own window.
  app.emit('open-file', { preventDefault: () => { /* handled */ } }, SAMPLE);
  const twoWindows = await waitFor(() => windows().length, (n) => n === 2, 30_000);
  check('an OS file-open on an occupied window opens a new one',
    twoWindows === 2, `${twoWindows} windows`);
  const second = windows().find((w) => w !== first)!;
  const secondTitle = await waitFor(() => second.getTitle(),
    (t) => t.includes('WStarCats'), 30_000);
  check('the new window shows the document too',
    secondTitle.includes('WStarCats'), secondTitle);

  // External links leave for the system browser, no in-app window.
  const before = windows().length;
  await first.webContents.executeJavaScript(
    `window.open('https://arxiv.org/abs/2411.01678'); true`);
  await waitFor(() => externals.length, (n) => n > 0, 10_000);
  check('an external link goes to the system browser',
    externals.some((u) => u.startsWith('https://arxiv.org/')), externals.join(' '));
  check('...and never becomes an in-app window', windows().length === before,
    `${windows().length} windows`);

  // Window bounds are remembered from the window closed last.
  second.setBounds({ width: 1111, height: 777 });
  await new Promise((r) => setTimeout(r, 300));
  second.close();
  await waitFor(() => windows().length, (n) => n === 1, 15_000);
  app.emit('second-instance', {}, [process.execPath, '--new-window'], {});
  const reopened = await waitFor(
    () => windows().find((w) => w !== first), (w) => !!w, 15_000);
  const b = reopened?.getBounds();
  check('a new window opens at the size the last one was closed with',
    !!b && b.width === 1111 && b.height === 777, JSON.stringify(b));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  desktop edge cases errored', e);
      app.exit(1);
    });
  }, 14_000);
});
