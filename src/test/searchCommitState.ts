// A search history entry has two in-memory-only states. UNCOMMITTED right
// after a search: find-next moves that same entry (no new entry), and
// scrolling/zooming/auto-save leave it uncommitted. COMMITTED once the
// user does something that says "found it, moved on" (an explicit list:
// Save, dismissing the find bar, following a link, switching trails,
// clicking a history entry, …): the entry freezes and the NEXT search
// adds a fresh one.
//
// This drives the controller (and the real find-bar UI for the dismiss
// case) and counts the "…"-labelled search entries: a committing action
// makes the next search add one (+1); a non-committing action leaves the
// single entry to be overwritten (+0). Save and dismissing the find bar
// are the two actions that do NOT move the history cursor, so before this
// change they silently kept overwriting — those are the red/green
// differentiators; the rest confirm the committed/uncommitted contract.
//
// Run (CI): node build-node/test/searchCommitState.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const LINK = '.page[data-page="1"] .annotLayer .pdfLink:not(.external)';
const Q = 'the'; // a word with many matches in the sample PDF

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface Hooks {
  controller: {
    runSearch(q: string, o?: { jump?: boolean }): Promise<void>;
    gotoMatch(dir: 1 | -1): Promise<void>;
    saveProgress(): Promise<void>;
    jumpVia(pos: { page: number; yRatio: number }, label: string, fork?: boolean): void;
    stackNew(): void;
    stackSwitch(id: number): void;
    histEntryClick(i: number): void;
    zoomIn(): void;
    writeProgress(): Promise<void>;
  };
  hist: {
    active: { index: number; entries: Array<{ label: string }> };
    stacks: Array<{ id: number; entries: Array<{ label: string }> }>;
  };
  viewer: { currentPosition(): { page: number; yRatio: number } };
  session: { handle: unknown };
  search: { matches: unknown[] };
}
type W = { __pt: Hooks };

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => check('no page errors', false, String(e)));
    page.on('dialog', (d) => void d.accept());

    await page.goto(BASE + '/');
    await page.evaluate(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('pt:')).forEach((k) => localStorage.removeItem(k));
      indexedDB.deleteDatabase('paper-trail');
    });

    // Clean single-stack state with a no-op save sink so the Save and
    // auto-save paths run fully (and deterministically) without a picker.
    const reset = async (): Promise<void> => {
      await page.goto(BASE + '/?file=sample/WStarCats.pdf');
      await page.waitForSelector(LINK, { timeout: 20_000 });
      await page.evaluate(() => {
        (window as unknown as W).__pt.session.handle = {
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          createWritable: async () => ({ write: async () => { /* sink */ }, close: async () => { /* sink */ } }),
        } as unknown;
      });
    };
    const theCount = (): Promise<number> => page.evaluate(() =>
      (window as unknown as W).__pt.hist.stacks
        .flatMap((s) => s.entries)
        .filter((e) => e.label.startsWith('“')).length);
    const search = (q = Q): Promise<void> =>
      page.evaluate((qq) => (window as unknown as W).__pt.controller.runSearch(qq), q);
    const findNext = (): Promise<void> =>
      page.evaluate(() => (window as unknown as W).__pt.controller.gotoMatch(1));
    const settle = (): Promise<void> => page.waitForTimeout(250);

    await reset();

    // --- sanity: the query matches, so a search really makes an entry ---
    await search(); await settle();
    const m = await page.evaluate(() => (window as unknown as W).__pt.search.matches.length);
    const c1 = await theCount();
    check('a search produces one entry with matches', m > 1 && c1 === 1, `matches=${m} entries=${c1}`);

    // --- non-committing: find-next OVERWRITES the same entry ---
    const n0 = await theCount();
    await findNext(); await settle();
    check('find-next overwrites (stays uncommitted)', (await theCount()) === n0, `${n0} -> ${await theCount()}`);

    // === committing actions: the next search must ADD a new entry ===

    // Save (explicit) — a differentiator: it does NOT move the cursor.
    await reset();
    await search(); await settle();
    const sv0 = await theCount();
    await page.evaluate(() => (window as unknown as W).__pt.controller.saveProgress()); await settle();
    await search(); await settle();
    const sv1 = await theCount();
    check('Save commits: next search adds an entry', sv1 === sv0 + 1, `${sv0} -> ${sv1}`);

    // Dismiss the find bar (Esc / ×) — a differentiator, driven through
    // the real UI (the commit lives in SearchBar's close()).
    await reset();
    await page.keyboard.press('Control+f');
    await page.waitForSelector('#searchInput', { timeout: 5_000 });
    await search(); await settle();
    const dm0 = await theCount();
    await page.locator('#searchBar button[title="Close search"]').click();
    await settle();
    await page.keyboard.press('Control+f');
    await page.waitForSelector('#searchInput', { timeout: 5_000 });
    await search(); await settle();
    const dm1 = await theCount();
    check('dismissing the find bar commits: next search adds an entry', dm1 === dm0 + 1, `${dm0} -> ${dm1}`);

    // Follow a link (via jumpVia).
    await reset();
    await search(); await settle();
    const lk0 = await theCount();
    await page.evaluate(() => (window as unknown as W).__pt.controller.jumpVia({ page: 1, yRatio: 0.6 }, 'Jumped'));
    await settle();
    await search(); await settle();
    const lk1 = await theCount();
    check('following a link commits: next search adds an entry', lk1 === lk0 + 1, `${lk0} -> ${lk1}`);

    // Switch trails.
    await reset();
    const stackA = await page.evaluate(() => (window as unknown as W).__pt.hist.stacks[0].id);
    await page.evaluate(() => (window as unknown as W).__pt.controller.stackNew()); await settle();
    await search(); await settle();
    const tr0 = await theCount();
    await page.evaluate((id) => (window as unknown as W).__pt.controller.stackSwitch(id), stackA); await settle();
    await search(); await settle();
    const tr1 = await theCount();
    check('switching trails commits: next search adds an entry', tr1 === tr0 + 1, `${tr0} -> ${tr1}`);

    // Click another history entry. (Jumping back and searching truncates
    // the forward tail, so assert the shape: the clicked entry is kept and
    // the search is a fresh push, not an overwrite of the clicked entry.)
    await reset();
    await search(); await settle();
    const root = await page.evaluate(() => (window as unknown as W).__pt.hist.active.entries[0].label);
    await page.evaluate(() => (window as unknown as W).__pt.controller.histEntryClick(0)); await settle();
    await search(); await settle();
    const h = await page.evaluate(() => {
      const a = (window as unknown as W).__pt.hist.active;
      return { labels: a.entries.map((e) => e.label), index: a.index };
    });
    check('clicking a history entry commits: search pushes a new entry, keeps the clicked one',
      h.labels[0] === root && h.index === 1 && h.labels.length === 2 && h.labels[1].startsWith('“'),
      JSON.stringify(h));

    // === non-committing actions: find-next must still OVERWRITE ===

    // Scroll (a real wheel scroll, past the 500ms tracking timer).
    await reset();
    await search(); await settle();
    const scr0 = await theCount();
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(700);
    await findNext(); await settle();
    check('scrolling keeps it uncommitted (find-next overwrites)', (await theCount()) === scr0, `${scr0} -> ${await theCount()}`);

    // Zoom.
    await reset();
    await search(); await settle();
    const zm0 = await theCount();
    await page.evaluate(() => (window as unknown as W).__pt.controller.zoomIn()); await settle();
    await findNext(); await settle();
    check('zooming keeps it uncommitted (find-next overwrites)', (await theCount()) === zm0, `${zm0} -> ${await theCount()}`);

    // Auto-save (writeProgress) must NOT commit — only explicit Save does.
    await reset();
    await search(); await settle();
    const as0 = await theCount();
    await page.evaluate(() => (window as unknown as W).__pt.controller.writeProgress()); await settle();
    await findNext(); await settle();
    check('auto-save (writeProgress) keeps it uncommitted (find-next overwrites)', (await theCount()) === as0, `${as0} -> ${await theCount()}`);

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
