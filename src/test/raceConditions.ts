// Race-condition / rapid-action stress tests against the REAL, UNMODIFIED
// app (no test seam in src/). The trick for determinism: slow the whole
// page's JS ~20x with CDP CPU throttling (Emulation.setCPUThrottlingRate),
// then fire rapid user actions from the UNthrottled Node driver. Because the
// app's async ops now run at tens-of-ms while the driver dispatches at Node
// speed, a racing action reliably lands WHILE the first op is still in
// flight — the race window (the app's timescale) dominates OS/runner jitter,
// so it reproduces every run without any real-timing guesswork.
//
// Under a genuine race the exact entry counts are nondeterministic, so we
// assert INVARIANTS that must hold for every interleaving: no page/console
// error or unhandledrejection, history structurally intact (active index in
// range, string labels, non-empty stacks, active stack is real), the search-
// commit state not wedged, and the app still responsive afterwards.
//
// Run (CI): node build-node/test/raceConditions.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page, type CDPSession } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const LINK = '.page[data-page="1"] .annotLayer .pdfLink:not(.external)';
const Q = 'the';
const RATE = 20; // ~20x slowdown: the app's timescale dominates runner jitter

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface Ctrl {
  runSearch(q: string, o?: { jump?: boolean }): Promise<void>;
  gotoMatch(dir: 1 | -1): Promise<void>;
  saveProgress(): Promise<void>;
  writeProgress(): Promise<void>;
  jumpVia(pos: { page: number; yRatio: number }, label: string, fork?: boolean): void;
  stackNew(): void;
  stackSwitch(id: number): void;
  histEntryClick(i: number): void;
  goBack(): void;
  goForward(): void;
  gotoPage(n: number): void;
}
interface Hooks {
  controller: Ctrl;
  hist: {
    activeId: number;
    active: { index: number; entries: Array<{ label: string }> };
    stacks: Array<{ id: number; index: number; entries: Array<{ label: string }> }>;
  };
  search: { matches: unknown[]; query: string };
  session: { handle: unknown };
  searchUncommitted(): boolean;
}
type W = { __pt: Hooks; __raceErrors: string[] };

async function run(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
    page.on('dialog', (d) => void d.accept());
    await page.addInitScript(() => {
      (window as unknown as W).__raceErrors = [];
      window.addEventListener('unhandledrejection', (e) =>
        (window as unknown as W).__raceErrors.push('unhandledrejection: '
          + String((e as PromiseRejectionEvent).reason)));
      window.addEventListener('error', (e) =>
        (window as unknown as W).__raceErrors.push('window.error: ' + String((e as ErrorEvent).message)));
    });

    const cdp: CDPSession = await page.context().newCDPSession(page);
    const throttle = (rate: number): Promise<unknown> =>
      cdp.send('Emulation.setCPUThrottlingRate', { rate });
    // Each fire arrow is SELF-CONTAINED (runs in the page; only touches
    // window). Ops started without `await` stay in flight (throttled) while
    // the driver moves on to the next fire at Node speed.
    const fire = (fn: () => void): Promise<unknown> => page.evaluate(fn);
    const settle = (ms = 700): Promise<void> => page.waitForTimeout(ms);

    await page.goto(BASE + '/');
    await page.evaluate(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('pt:')).forEach((k) => localStorage.removeItem(k));
      indexedDB.deleteDatabase('paper-trail');
    });

    const reset = async (): Promise<void> => {
      await throttle(1); // full speed for setup
      await page.goto(BASE + '/?file=sample/WStarCats.pdf');
      await page.waitForSelector(LINK, { timeout: 20_000 });
      await page.evaluate(() => {
        (window as unknown as W).__raceErrors = [];
        (window as unknown as W).__pt.session.handle = {
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          createWritable: async () => ({ write: async () => { /* sink */ }, close: async () => { /* sink */ } }),
        } as unknown;
      });
    };

    const invariants = (): Promise<{ bad: string[]; jsErrs: string[] }> => page.evaluate(() => {
      const p = (window as unknown as W).__pt;
      const bad: string[] = [];
      const stacks = p.hist.stacks;
      const ids = new Set(stacks.map((s) => s.id));
      if (!ids.has(p.hist.activeId)) bad.push(`activeId ${p.hist.activeId} not among [${[...ids].join(',')}]`);
      const a = p.hist.active;
      if (!a) bad.push('no active stack');
      else if (a.index < 0 || a.index >= a.entries.length) bad.push(`active index ${a.index}/${a.entries.length}`);
      for (const s of stacks) {
        if (s.entries.length === 0) bad.push(`stack ${s.id} empty`);
        if (s.index < 0 || s.index >= Math.max(1, s.entries.length)) bad.push(`stack ${s.id} index ${s.index}/${s.entries.length}`);
        for (const e of s.entries) if (typeof e.label !== 'string') bad.push(`stack ${s.id} label not string`);
      }
      if (typeof p.searchUncommitted() !== 'boolean') bad.push('searchUncommitted() not boolean');
      return { bad, jsErrs: [...((window as unknown as W).__raceErrors ?? [])] };
    });

    const assertHealthy = async (label: string): Promise<void> => {
      await throttle(1);
      await settle();
      const { bad, jsErrs } = await invariants();
      const allErrs = [...errors.splice(0), ...jsErrs];
      check(`${label}: no JS errors during the burst`, allErrs.length === 0, allErrs.slice(0, 3).join(' | '));
      check(`${label}: history stays structurally intact`, bad.length === 0, bad.slice(0, 3).join(' | '));
      await page.evaluate((q) => (window as unknown as W).__pt.controller.runSearch(q), Q);
      await settle(300);
      const m = await page.evaluate(() => (window as unknown as W).__pt.search.matches.length);
      check(`${label}: app still responsive after the burst`, m > 1, `matches=${m}`);
    };

    // ---- 1. Search + find-next + an immediate COMMIT, overlapping. The
    // commit (saveProgress → commitSearch nulls searchEntry) lands while the
    // throttled gotoMatch is between matchYRatio and its searchEntry read-
    // modify-write — stresses the searchEntry===current guard.
    await reset();
    await throttle(RATE);
    await fire(() => { void (window as unknown as W).__pt.controller.runSearch('the'); });
    await fire(() => { void (window as unknown as W).__pt.controller.gotoMatch(1); });
    await fire(() => { void (window as unknown as W).__pt.controller.gotoMatch(1); });
    await fire(() => { void (window as unknown as W).__pt.controller.saveProgress(); });
    await fire(() => { void (window as unknown as W).__pt.controller.gotoMatch(1); });
    await fire(() => { void (window as unknown as W).__pt.controller.runSearch('and'); });
    await fire(() => { void (window as unknown as W).__pt.controller.gotoMatch(1); });
    await assertHealthy('search + find-next + commit race');

    // ---- 2. Overlapping searches (different queries) racing a navigation —
    // the newest load must win cleanly (no stale callback clobber).
    await reset();
    await throttle(RATE);
    await fire(() => { void (window as unknown as W).__pt.controller.runSearch('the'); });
    await fire(() => { void (window as unknown as W).__pt.controller.runSearch('and'); });
    await fire(() => { (window as unknown as W).__pt.controller.jumpVia({ page: 1, yRatio: 0.5 }, 'X'); });
    await fire(() => { void (window as unknown as W).__pt.controller.runSearch('of'); });
    await throttle(1); await settle();
    {
      const st = await page.evaluate(() => ({
        arr: Array.isArray((window as unknown as W).__pt.search.matches),
        q: (window as unknown as W).__pt.search.query,
      }));
      check('overlapping searches+nav: matches not corrupted', st.arr, `query=${st.q}`);
    }
    await assertHealthy('overlapping searches + nav');

    // ---- 3. Auto-save (writeProgress) in flight while history changes under
    // it — must not clobber/wedge (the saving flag must reset).
    await reset();
    await page.evaluate((q) => (window as unknown as W).__pt.controller.runSearch(q), Q);
    await settle(300);
    await throttle(RATE);
    await fire(() => { void (window as unknown as W).__pt.controller.writeProgress(); });
    await fire(() => { (window as unknown as W).__pt.controller.jumpVia({ page: 1, yRatio: 0.3 }, 'Y'); });
    await fire(() => { (window as unknown as W).__pt.controller.stackNew(); });
    await fire(() => { void (window as unknown as W).__pt.controller.writeProgress(); });
    await assertHealthy('auto-save racing history changes');

    // ---- 4. Rapid trail/history navigation burst.
    await reset();
    const ids = await page.evaluate(() => {
      const c = (window as unknown as W).__pt.controller;
      c.jumpVia({ page: 1, yRatio: 0.2 }, 'A'); c.jumpVia({ page: 1, yRatio: 0.4 }, 'B');
      c.stackNew(); c.jumpVia({ page: 1, yRatio: 0.6 }, 'C');
      c.stackNew(); c.jumpVia({ page: 1, yRatio: 0.8 }, 'D');
      return (window as unknown as W).__pt.hist.stacks.map((s) => s.id);
    });
    await settle(300);
    await throttle(RATE);
    for (let i = 0; i < 8; i += 1) {
      const sid = ids[i % ids.length];
      await page.evaluate((id) => { (window as unknown as W).__pt.controller.stackSwitch(id); }, sid);
      await fire(() => { (window as unknown as W).__pt.controller.goBack(); });
      await fire(() => { (window as unknown as W).__pt.controller.histEntryClick(0); });
      await fire(() => { (window as unknown as W).__pt.controller.goForward(); });
      await fire(() => { (window as unknown as W).__pt.controller.gotoPage(1); });
    }
    await assertHealthy('rapid navigation');

    // ---- 5. Concurrent renames through the REAL UI under throttle: open a
    // rename, immediately open another / cancel — no stuck input, no crash.
    await reset();
    await page.evaluate(() => { const c = (window as unknown as W).__pt.controller; c.stackNew(); c.stackNew(); });
    await settle(300);
    const rows = await page.locator('.stackRow').count();
    if (rows >= 2) {
      await throttle(RATE);
      await page.locator('.stackRow').nth(0).locator('.name').dblclick();
      await page.locator('.stackRow').nth(1).locator('.name').dblclick(); // row0 blurs → commits
      await page.keyboard.type('Renamed');
      await page.keyboard.press('Escape');
      await page.locator('.stackRow').nth(0).locator('.name').dblclick();
      await page.keyboard.type('Zed');
      await page.locator('.stackRow').nth(1).locator('.name').dblclick();
      await page.keyboard.press('Enter');
      await throttle(1); await settle();
      const rn = await page.evaluate(() => ({
        inputs: document.querySelectorAll('input.rename').length,
        names: (window as unknown as W).__pt.hist.stacks.map((s) => s.entries[0]?.label),
      }));
      check('concurrent rename: no stuck edit input left open', rn.inputs === 0, `inputs=${rn.inputs}`);
      check('concurrent rename: trail names stay valid strings',
        rn.names.every((n) => typeof n === 'string'), JSON.stringify(rn.names));
    } else {
      check('concurrent rename: at least two trail rows', false, `rows=${rows}`);
    }
    await assertHealthy('concurrent rename');

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  } finally {
    await browser.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
