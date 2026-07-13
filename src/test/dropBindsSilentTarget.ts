// Regression: every way of opening a .ptl in the desktop shell must bind
// the SAME silent-write target, so auto-save arms AND the window closes
// with no "Do you want to save?" prompt — no matter how it was opened.
//
// The bug: opens that come through a browser handle (Load session…, the
// file picker, drag-drop) bound session.handle but NOT session.path. The
// close-flush keys off session.path, so a handle-only session fell through
// to beforeunload's preventDefault() -> native save prompt, even with
// auto-save armed. The fix derives the on-disk path at each bind site via
// the desktop shell (ptDesktop.getPathForFile).
//
// This drives the REAL code paths (requestLoadSession, openDropped) with
// ptDesktop.getPathForFile STUBBED to a known path — it verifies the
// binding + close wiring deterministically, NOT Electron's own path
// resolution (a real OS drop/picker can't be synthesized headlessly; that
// is covered by a separate real-build probe). Pre-fix: session.path stays
// null and beforeunload calls preventDefault -> FAIL. Post-fix: bound and
// the close flushes silently -> PASS.
//
// Run: node build-node/test/dropBindsSilentTarget.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const PTL_PATH = '/tmp/paper-trail/reading.ptl';

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

    const out = await page.evaluate(async (ptlPath) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const ptlText: string = pt.progressText(); // a valid .ptl for this doc
      const closeSaves: string[] = [];

      // Stand in for the Electron preload bridge.
      (window as any).ptDesktop = {
        platform: 'darwin',
        getPathForFile: (f: File) => (/\.ptl$/i.test(f.name) ? ptlPath : ''),
        saveSessionOnClose: (p: string) => { closeSaves.push(p); return true; },
        // The native "Load session…" dialog hands back the real path.
        openSessionDialog: async () => ({ name: 'reading.ptl', text: ptlText, path: ptlPath }),
      };
      // The desktop path must NOT fall back to the Chromium picker; make it
      // abort if reached, so pre-fix code (which lacks openSessionDialog)
      // ends up unbound rather than binding some other way.
      (window as any).showOpenFilePicker = async () => {
        const e: any = new Error('abort'); e.name = 'AbortError'; throw e;
      };
      const makePtl = () => new File([ptlText], 'reading.ptl', { type: 'text/plain' });
      const applyIfPending = () => {
        if (!c.session.path && c.confirmSession) c.applyConfirmedSession();
      };

      // (1) Load session… — the NATIVE desktop open dialog binds the path.
      await c.requestLoadSession();
      applyIfPending();
      const pickerBound: string | null = c.session.path;

      // (2) The close-flush: a dirty, bound session must close SILENTLY —
      // beforeunload writes and does NOT preventDefault (no native prompt).
      c.session.dirty = true;
      const ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      const closePrevented = ev.defaultPrevented;

      // (3) A dropped .ptl binds the same way (independent of the picker).
      c.session.path = null; c.session.handle = null; c.confirmSession = null;
      const fakeDt = { items: [], files: [makePtl()] } as unknown as DataTransfer;
      await c.openDropped(fakeDt);
      // openDropped fires openFile without awaiting (the drop handler is
      // sync); wait for that async open to settle before asserting.
      for (let i = 0; i < 60 && !c.session.path && !c.confirmSession; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      applyIfPending();
      const dropBound: string | null = c.session.path;

      return { pickerBound, closePrevented, closeSaves, dropBound };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }, PTL_PATH);

    check('Load session… binds the desktop silent-write path',
      out.pickerBound === PTL_PATH, `session.path=${JSON.stringify(out.pickerBound)}`);
    check('a dirty autosaved session closes silently (no preventDefault, no prompt)',
      out.closePrevented === false && out.closeSaves.length >= 1,
      `preventDefault=${out.closePrevented} closeWrites=${out.closeSaves.length}`);
    check('a dropped .ptl binds the same silent-write path',
      out.dropBound === PTL_PATH, `session.path=${JSON.stringify(out.dropBound)}`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
