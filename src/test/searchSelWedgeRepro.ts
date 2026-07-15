// Deterministic reproduction of the searchSelectionBox CI wedge.
//
// The flaky hang: after the right-click "Search for this" flow, the
// in-flight search eventually settles, gotoMatch(1) records a history
// entry, and the session goes DIRTY. If that lands before app.quit()'s
// beforeunload reaches the renderer, the close is vetoed and the
// renderer's closeAndSave() asks the shell for the close-save prompt
// (pt-confirm-close-save) — which since 112deeb is the ASYNC
// dialog.showMessageBox. A test that stubs only showMessageBoxSync
// leaves that prompt REAL, nobody on a headless runner answers it, the
// process never exits, and playwright's eApp.close() waits forever.
//
// This test removes the race: it drives the same product path, WAITS
// until the session is actually dirty (the state the flaky runs hit by
// timing), and only then quits. Two modes via PT_REPRO_STUB:
//   sync-only  — replicates searchSelectionBox.ts's stub (only
//                showMessageBoxSync). Expected on the bug: the async
//                prompt pops for real and the app never exits — this
//                test detects it with an internal watchdog and FAILS
//                (exit 1) instead of wedging the runner.
//   both       — additionally stubs the async showMessageBox to answer
//                "Don't Save". Expected: the app exits promptly.
//
// Run: PT_REPRO_STUB=sync-only node build-node/test/searchSelWedgeRepro.js
//      PT_REPRO_STUB=both      node build-node/test/searchSelWedgeRepro.js

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { _electron, type Page } from 'playwright-core';

const BASE = 'paper-trail://app';
const MODE = process.env.PT_REPRO_STUB === 'both' ? 'both' : 'sync-only';
// Long enough that a slow runner's honest teardown (normally <1s) can
// never trip it; short enough that a wedge fails the step instead of
// hanging the job for an hour.
const EXIT_DEADLINE_MS = 90_000;

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function run(): Promise<void> {
  console.log(`repro mode: ${MODE}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const eApp = await _electron.launch({
    executablePath: electronPath,
    args: [path.resolve(__dirname, '..', 'desktop', 'main.js')],
    env: {
      ...process.env as Record<string, string>,
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-searchwedge-')),
      PT_SHOT: '1', // show the window without stealing focus
    },
  });
  // Main-process console output is the evidence trail (which dialog API
  // the close flow actually hit), so forward it into the step log.
  eApp.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[main] ${d}`));
  eApp.process().stderr?.on('data', (d: Buffer) => process.stderr.write(`[main:err] ${d}`));

  let wedged = false;
  try {
    await eApp.evaluate(({ dialog }, mode) => {
      // Same stub the flaky test installs.
      dialog.showMessageBoxSync = (() => 1) as typeof dialog.showMessageBoxSync;
      if (mode === 'both') {
        // The stub every other desktop test also installs: auto-answer
        // the ASYNC close-save prompt with "Don't Save".
        dialog.showMessageBox = (async () => {
          console.log('PT_REPRO dialog.showMessageBox STUBBED -> response 1 (Don’t Save)');
          return { response: 1, checkboxChecked: false };
        }) as typeof dialog.showMessageBox;
      } else {
        // Leave the async dialog REAL, but log when the product opens it:
        // that log line inside a wedged run is the smoking gun.
        const real = dialog.showMessageBox.bind(dialog);
        dialog.showMessageBox = ((...args: Parameters<typeof real>) => {
          console.log('PT_REPRO dialog.showMessageBox INVOKED (real native prompt, nobody to answer)');
          return real(...args);
        }) as typeof dialog.showMessageBox;
      }
    }, MODE);

    const page: Page = await eApp.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    page.on('pageerror', (e) => check('no page errors', false, String(e)));
    page.on('dialog', (d) => d.accept().catch(() => { /* already handled */ }));

    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.page[data-page="1"]', { timeout: 20000 });

    // The exact product path the flaky test drives: the native context
    // menu's "Search for this" action.
    await eApp.evaluate(({ BrowserWindow }, t) => {
      BrowserWindow.getAllWindows()[0].webContents.send('pt-menu', 'search-selection', t);
    }, 'equivariant');
    await page.waitForSelector('#searchInput', { timeout: 5000 });

    // Deterministic: wait for the state the flaky runs only hit by
    // timing — the search settled, the jump recorded a history entry,
    // and the session is DIRTY.
    await page.waitForFunction(
      () => (window as unknown as { __pt?: { session?: { dirty?: boolean } } })
        .__pt?.session?.dirty === true,
      { timeout: 30000 },
    );
    const state = await page.evaluate(() => ({
      dirty: (window as unknown as { __pt: { session: { dirty: boolean } } }).__pt.session.dirty,
      count: (document.getElementById('searchCount')?.textContent ?? '').trim(),
    }));
    check(`session went dirty after "Search for this" (count "${state.count}")`, state.dirty);

    // Quit exactly the way the flaky test tears down. The app must exit;
    // a close-save prompt nobody can answer keeps the process alive
    // forever, which the watchdog converts into a fast FAIL.
    console.log('closing (app.quit + wait for process exit)…');
    const t0 = Date.now();
    // The ground truth is the electron PROCESS exiting — playwright's
    // close() promise may reject on its own internal timeout without the
    // process being gone, and that must still count as a wedge.
    const exited = new Promise<boolean>((r) => { eApp.process().once('exit', () => r(false)); });
    void eApp.close().catch(() => { /* judged via the process exit below */ });
    wedged = await Promise.race([
      exited,
      new Promise<boolean>((r) => { setTimeout(() => r(true), EXIT_DEADLINE_MS).unref?.(); }),
    ]);
    check(
      `app exits within ${EXIT_DEADLINE_MS / 1000}s of close (no unanswerable close prompt)`,
      !wedged,
      wedged ? 'process still alive — wedge reproduced' : `exited after ${Date.now() - t0}ms`,
    );
  } finally {
    if (wedged) {
      // The runner must not inherit the wedge: kill the app outright.
      const proc = eApp.process();
      console.log(`killing wedged electron pid ${proc.pid}`);
      try { proc.kill(); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      await eApp.close().catch(() => { /* already closed */ });
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
