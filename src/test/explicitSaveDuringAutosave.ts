// Regression: whole-file session writes raced and lied.
//  (1) An explicit Save during an in-flight auto-save was silently DROPPED —
//      writeProgress bailed on the `saving` flag — while saveProgress cleared
//      dirty and toasted "Session saved" anyway.
//  (2) The desktop path branch of saveProgress skipped the guard entirely,
//      putting two whole-file IPC writes in flight at once.
//  (3) A false return from the path write gave no feedback at all.
// Saves must queue behind an in-flight write, never overlap, and failures
// must say so.
//
// Run: node build-node/test/explicitSaveDuringAutosave.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function run(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => !!(window as any).__pt?.controller?.getSnapshot().docOpen,
      undefined, { timeout: 20_000 });

    const out = await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // ---- (1) handle-bound: explicit Save during an in-flight auto-save
      let release1: () => void = () => {};
      const gate1 = new Promise<void>((r) => { release1 = r; });
      const writes: string[] = [];
      c.session.handle = {
        kind: 'file', name: 's.ptl',
        createWritable: async () => ({
          write: async (t: string) => { writes.push(t); await gate1; },
          close: async () => { /* sink */ },
        }),
      };
      c.session.path = null;
      c.session.dirty = true;
      const auto1 = c.writeProgress();      // in flight, parked on the gate
      await sleep(100);
      const explicit1 = c.saveProgress();   // must QUEUE, not drop
      await sleep(100);
      release1();
      await auto1; await explicit1;
      const handleCase = { writes: writes.length, dirty: c.session.dirty };

      // ---- (2) path-bound: never two concurrent whole-file IPC writes
      let active = 0; let maxActive = 0; let calls = 0;
      let release2: () => void = () => {};
      const gate2 = new Promise<void>((r) => { release2 = r; });
      (window as any).ptDesktop = {
        saveSessionToPath: async () => {
          calls += 1; active += 1;
          maxActive = Math.max(maxActive, active);
          await gate2;
          active -= 1;
          return true;
        },
      };
      c.session.handle = null;
      c.session.path = '/tmp/pt-savequeue/x.ptl';
      c.session.dirty = true;
      const auto2 = c.writeProgress();
      await sleep(100);
      const explicit2 = c.saveProgress();
      await sleep(100);
      release2();
      await auto2; await explicit2;
      const pathCase = { calls, maxActive, dirty: c.session.dirty };

      // ---- (3) the path write reports failure: false must toast, precisely
      (window as any).ptDesktop = { saveSessionToPath: async () => false };
      c.session.dirty = true;
      await c.saveProgress();
      const failCase = {
        toast: (c.getSnapshot().toast?.msg ?? '') as string,
        dirty: c.session.dirty,
      };

      delete (window as any).ptDesktop;
      c.session.handle = null; c.session.path = null; c.session.dirty = false;
      return { handleCase, pathCase, failCase };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    check('an explicit Save during an in-flight auto-save still writes',
      out.handleCase.writes === 2, `writes=${out.handleCase.writes}`);
    check('the queued explicit save leaves the session clean',
      out.handleCase.dirty === false, `dirty=${out.handleCase.dirty}`);
    check('path-bound saves never overlap (one whole-file write at a time)',
      out.pathCase.maxActive === 1 && out.pathCase.calls === 2,
      `maxActive=${out.pathCase.maxActive} calls=${out.pathCase.calls}`);
    check('a failed path write toasts what could not be written',
      /couldn.t write to .*x\.ptl/i.test(out.failCase.toast),
      `toast=${JSON.stringify(out.failCase.toast)}`);
    check('the failed save leaves the session dirty',
      out.failCase.dirty === true, `dirty=${out.failCase.dirty}`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
