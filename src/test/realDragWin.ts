// REAL-INPUT drag test, Windows: unlike the e2e suites (synthesized
// CDP events that bypass the OS), this posts genuine input through
// user32 SendInput/SetCursorPos, so the compositor's hit-testing —
// including the toolbar's -webkit-app-region: drag — is fully
// exercised. It drags the preview popup's top edge up through the
// toolbar band with a really pressed mouse and asserts the OS never
// turned it into a window drag (the window must not move), the popup
// survived, and its top rose.
//
// Real input owns the machine's actual cursor, so this only runs in
// CI (or with PT_REAL_INPUT=1 set deliberately).
// Run (CI, Windows): node build-node/test/realDragWin.js

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron } from 'playwright-core';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const MOUSE_PS = `
Add-Type -Name U32 -Namespace PT -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.UIntPtr e);
'
function Move($x, $y) { [PT.U32]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 80 }
function Down() { [PT.U32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 120 }
function Up() { [PT.U32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 120 }
`;

function mouse(script: string): void {
  execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', MOUSE_PS + script], { stdio: 'ignore' });
}

async function run(): Promise<void> {
  if (!process.env.CI && !process.env.PT_REAL_INPUT) {
    console.log('SKIP  real-input test controls the actual cursor; set PT_REAL_INPUT=1 or run in CI');
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const sample = path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf');
  const eApp = await _electron.launch({
    executablePath: electronPath,
    args: [path.resolve(__dirname, '..', 'desktop', 'main.js'), sample],
    env: {
      ...process.env as Record<string, string>,
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-real-')),
    },
  });
  try {
    const page = await eApp.firstWindow();
    await page.waitForSelector(
      '.page[data-page="1"] .annotLayer .pdfLink:not(.external)', { timeout: 30000 });
    // a deterministic, visible, focused window at known screen coords
    const content = await eApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setBounds({ x: 60, y: 60, width: 1400, height: 900 });
      win.show();
      win.focus();
      return win.getContentBounds();
    });
    const toScreen = (cssX: number, cssY: number) =>
      [Math.round(content.x + cssX), Math.round(content.y + cssY)] as const;

    // real-hover the 4th internal link until the popup opens
    const link = (await page.locator(
      '.page[data-page="1"] .annotLayer .pdfLink:not(.external)').nth(3).boundingBox())!;
    const [lx, ly] = toScreen(link.x + link.width / 2, link.y + link.height / 2);
    mouse(`Move ${lx} ${ly}; Move ${lx + 1} ${ly}`);
    await page.waitForSelector('#preview:not(.hidden)', { timeout: 8000 });
    await page.waitForTimeout(600);

    const before = await eApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds());
    const pv = (await page.locator('#preview').boundingBox())!;
    const [dx, dy] = toScreen(pv.x + pv.width / 2, pv.y + 2);

    // the real drag: press on the top edge, pull up through the toolbar
    // band (content y ≈ 20) in small steps, release there
    const [tx, ty] = toScreen(pv.x + pv.width / 2, 20);
    const steps = Array.from({ length: 6 }, (_, i) =>
      `Move ${tx} ${Math.round(dy + (ty - dy) * ((i + 1) / 6))}`).join('; ');
    mouse(`Move ${dx} ${dy}; Down; ${steps}; Up`);
    await page.waitForTimeout(400);

    const after = await eApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds());
    const pvAfter = await page.locator('#preview').boundingBox();
    const stillOpen = await page.evaluate(() =>
      !document.getElementById('preview')!.classList.contains('hidden'));

    check('a real drag over the toolbar never becomes a window drag',
      after.x === before.x && after.y === before.y,
      JSON.stringify({ before, after }));
    check('the popup survives a real drag through the toolbar band',
      stillOpen && pvAfter !== null, JSON.stringify({ stillOpen, pvAfter }));
    check('the real drag actually resized the popup upward',
      pvAfter !== null && pvAfter.y < pv.y - 10,
      JSON.stringify({ from: pv.y, to: pvAfter?.y }));
  } finally {
    await eApp.close().catch(() => { /* already gone */ });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
