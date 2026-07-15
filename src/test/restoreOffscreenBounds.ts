// Remembered window bounds from a monitor that is no longer connected
// (saved x/y far outside every display) must not restore an invisible
// window: the position is dropped — the OS places the window — while
// the remembered SIZE survives. The bug: loadBounds restored x/y
// verbatim, so after a monitor unplug the app came back fully
// off-screen and looked broken. The intersection logic itself is unit
// tested (desktopShellUnit); this witnesses the wired-up loadBounds.
//
// Run (CI): npx electron build-node/test/restoreOffscreenBounds.js

const nodeFs = require('node:fs') as typeof import('node:fs');
const nodePath = require('node:path') as typeof import('node:path');
const userData = nodeFs.mkdtempSync(
  nodePath.join((require('node:os') as typeof import('node:os')).tmpdir(), 'pt-offscreen-'));
process.env.PT_USERDATA = userData;
process.env.PT_SHOT = '1'; // show without stealing focus

// A position no runner display can reach — the leftover of an unplugged
// monitor — with a size that fits the runners' smallest display.
nodeFs.writeFileSync(nodePath.join(userData, 'window-state.json'),
  JSON.stringify({ x: 20000, y: 20000, width: 800, height: 560 }));

import { app, BrowserWindow, screen } from 'electron';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function run(): Promise<void> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) throw new Error('no window appeared');
  const b = win.getBounds();
  const areas = screen.getAllDisplays().map((d) => d.workArea);

  // At least a grabbable corner of the window on some real display.
  const visible = areas.some((a) =>
    Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= 64
    && Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y) >= 64);
  check('a window restored from unplugged-monitor bounds lands on a real display',
    visible, JSON.stringify({ bounds: b, displays: areas }));
  check('the remembered size still survives',
    b.width === 800 && b.height === 560, JSON.stringify(b));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    run().catch((e) => {
      console.error('FAIL  off-screen bounds regression errored', e);
      app.exit(1);
    });
  }, 5_000);
});
