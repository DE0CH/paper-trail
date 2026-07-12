// The taskbar Jump List's "New Window" task (Windows) launches a
// second process with --new-window; the running instance receives it
// through the 'second-instance' event and must open a fresh window —
// while a plain second launch (no flag, no files) must only focus the
// existing window, not spawn one. The event is emitted directly, so
// the check runs identically on every platform.
//
// Run (CI): npx electron build-node/test/newWindowTask.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-newwin-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function windowCount(): number {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 2500));
}

async function run(): Promise<void> {
  const before = windowCount();
  check('the app starts with one window', before === 1, String(before));

  app.emit('second-instance', {}, [process.execPath, '--new-window'], {});
  await settle();
  check('the Jump List New Window task opens a fresh window',
    windowCount() === before + 1, `now ${windowCount()}`);

  app.emit('second-instance', {}, [process.execPath], {});
  await settle();
  check('a plain second launch only focuses, it does not spawn',
    windowCount() === before + 1, `now ${windowCount()}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  new-window task regression errored', e);
      app.exit(1);
    });
  }, 14_000);
});
