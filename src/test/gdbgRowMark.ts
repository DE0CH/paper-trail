// TEMPORARY diagnostic probe — DELETED before this branch is handed over.
// Reproduces editRowActions' mark-after-trail-rename sequence with heavy
// instrumentation, to pin down why clicking #btnMark yields no second
// .histItem row on windows-11-arm (Edge fallback browser): does the click
// reach markPosition? does hist.visit run? do subscribers fire? does the
// DOM update? Prints everything; always exits 0 (it is a probe, not a test).
//
// Run: node build-node/test/gdbgRowMark.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

async function run(): Promise<void> {
  const executablePath = findBrowser();
  console.log(`[node] browser: ${executablePath}`);
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('console', (m) => console.log(`[page ${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
    page.on('crash', () => console.log('[node] PAGE CRASHED'));
    page.on('dialog', (d) => { console.log(`[dialog] ${d.type()}: ${d.message()}`); void d.accept(); });
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.stackRow .name', { timeout: 20_000 });
    await page.waitForSelector('.histItem .lbl', { timeout: 20_000 });

    // Instrument controller internals BEFORE touching the UI.
    await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const t0 = Date.now();
      const log = (m: string) => console.log(`[probe +${Date.now() - t0}ms] ${m}`);
      const wrap = (obj: any, name: string) => {
        const orig = obj[name].bind(obj);
        obj[name] = (...args: any[]) => {
          log(`${name}(${args.map((a: any) => { try { return JSON.stringify(a); } catch { return String(a); } }).join(',')})`);
          try {
            return orig(...args);
          } catch (e) {
            log(`${name} THREW: ${(e as Error)?.message}`);
            throw e;
          }
        };
      };
      wrap(c, 'markPosition');
      wrap(c, 'jumpVia');
      wrap(c, 'stackSwitch');
      wrap(c, 'stackRename');
      wrap(c, 'notify'); // instance shadow intercepts internal this.notify()
      wrap(pt.hist, 'visit');
      wrap(pt.hist, 'fork');
      c.subscribe(() => log(`subscriber tick: entries=${pt.hist.active.entries.length}`
        + ` rows=${document.querySelectorAll('.histItem').length}`));
      document.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        log(`doc click on <${t?.tagName}> id=${t?.id || ''} cls=${(t?.className || '').toString().slice(0, 60)}`);
      }, true);
      document.addEventListener('keydown', (e) => {
        log(`keydown ${e.key} on <${(e.target as HTMLElement)?.tagName}>`);
      }, true);
      window.addEventListener('error', (e) => log(`window error: ${e.message}`));
      window.addEventListener('unhandledrejection', (e) => log(`unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}`));
      log('instrumented');
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    // The exact editRowActions prelude: trail-row rename, Escape, detach.
    const span = page.locator('.stackRow .name').first();
    await span.dblclick();
    const input = page.locator('.stackRow input.rename').first();
    await input.waitFor({ state: 'visible', timeout: 5_000 });
    await page.keyboard.press('Escape');
    await input.waitFor({ state: 'detached', timeout: 15_000 });
    console.log('[node] editor detached — clicking #btnMark');

    await page.click('#btnMark');
    console.log('[node] #btnMark clicked (playwright returned)');

    // Poll the model AND the DOM for up to 20s.
    for (let i = 0; i < 40; i++) {
      const s = await page.evaluate(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const pt = (window as any).__pt;
        const snap = pt.controller.getSnapshot();
        const active = snap.stacks.find((x: any) => x.id === snap.activeStackId);
        const ae = document.activeElement as HTMLElement | null;
        return {
          histEntries: pt.hist.active.entries.length,
          stacks: pt.hist.stacks.length,
          snapEntries: active ? active.entries.length : -1,
          rows: document.querySelectorAll('.histItem').length,
          stackRows: document.querySelectorAll('.stackRow').length,
          docOpen: snap.docOpen,
          dirty: pt.session.dirty,
          focus: `${ae?.tagName ?? '?'}#${ae?.id ?? ''}`,
        };
        /* eslint-enable @typescript-eslint/no-explicit-any */
      });
      console.log(`[node poll ${i}] ${JSON.stringify(s)}`);
      if (s.rows > 1 && i >= 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    await browser.close();
  }
  console.log('[node] probe done');
  process.exit(0);
}

run().catch((e) => { console.error('[node] probe errored', e); process.exit(0); });
