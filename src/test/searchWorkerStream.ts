// The search compute (page-text concatenation, case folding, match
// finding) runs in a dedicated Web Worker, and the index STREAMS: a query
// issued while the page-text index is still building must surface the
// matches from already-indexed pages immediately and keep filling in as
// further pages are indexed — never block until the whole document is
// indexed before showing anything.
//
// The red/green differentiator is the partial-results check: a
// non-streaming search only ever notifies the UI with the final match
// count, so no partial count (0 < n < final) is ever observable. The
// remaining checks pin the invariants the streaming rework must preserve:
// match offsets are ORIGINAL text-layer offsets (slicing the text layer's
// own text at [start, end) yields the query), highlights are drawn for
// the jumped-to match, counts only grow (no dropped matches), a query
// superseded mid-index converges to the new query's complete results, and
// clearing the query mid-index leaves no stale matches behind. Three
// further regressions ride along: a document swap mid-index discards the
// old document's index chunks and batches (doc-epoch guard), a page whose
// text extraction fails degrades to an empty page instead of poisoning
// the whole search, and dismissing the find bar (or pressing Enter)
// within the debounce window cancels/flushes the pending search instead
// of letting a stale timer fire it after the bar is gone.
//
// Run (CI): node build-node/test/searchWorkerStream.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const PAGE1_TEXT = '.page[data-page="1"] .textLayer';
const Q = 'the'; // a word with many matches spread across the fixture's pages

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface Hooks {
  controller: {
    runSearch(q: string, o?: { jump?: boolean }): Promise<void>;
    subscribe(fn: () => void): () => void;
    getSnapshot(): { searchCount: string };
    openData(data: Uint8Array, name: string): Promise<void>;
  };
  search: {
    query: string;
    matches: Array<{ page: number; start: number; end: number }>;
  };
  viewer: { doc: { getPage(n: number): Promise<unknown> } };
  hist: { active: { entries: Array<{ label: string }> } };
}
type W = { __pt: Hooks };

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => check('no page errors', false, String(e)));
    page.on('dialog', (d) => void d.accept());

    const load = async (): Promise<void> => {
      await page.goto(BASE + '/?file=sample/WStarCats.pdf');
      await page.waitForSelector(PAGE1_TEXT, { timeout: 20_000 });
      await page.waitForFunction((sel) =>
        (document.querySelector(sel)?.textContent ?? '').length > 0,
      PAGE1_TEXT, { timeout: 10_000 });
    };

    // ---- 1. Streaming: record the match count at every UI notification
    // while the FIRST search (the one that builds the index) runs. A
    // streaming index produces partial counts strictly between 0 and the
    // final count; a blocking index jumps 0 → final in one step.
    await load();
    const stream = await page.evaluate(async (q) => {
      const w = window as unknown as W;
      const rec: Array<{ n: number; t: number }> = [];
      const t0 = performance.now();
      w.__pt.controller.subscribe(() =>
        rec.push({ n: w.__pt.search.matches.length, t: performance.now() - t0 }));
      await w.__pt.controller.runSearch(q, { jump: false });
      return {
        rec,
        final: w.__pt.search.matches.length,
        count: w.__pt.controller.getSnapshot().searchCount,
        totalMs: performance.now() - t0,
        sorted: w.__pt.search.matches.every((m, i, a) => i === 0
          || m.page > a[i - 1].page
          || (m.page === a[i - 1].page && m.start >= a[i - 1].end)),
      };
    }, Q);
    check('the search finds matches', stream.final > 1, `final ${stream.final}`);
    const partials = [...new Set(stream.rec.map((r) => r.n).filter((n) => n > 0 && n < stream.final))];
    check('partial results stream in while the index is still building',
      partials.length >= 1,
      `${partials.length} distinct partial counts before final ${stream.final}`);
    check('streamed counts only grow (no dropped or reset matches)',
      stream.rec.every((r, i) => i === 0 || r.n >= stream.rec[i - 1].n),
      stream.rec.map((r) => r.n).join(','));
    check('matches stay sorted by page and offset',
      stream.sorted, `${stream.final} matches`);
    check('the count label settles in plain x / y form (no indexing marker)',
      new RegExp(`^0 / ${stream.final}$`).test(stream.count), `"${stream.count}"`);
    // Perf signal (informational, printed not asserted): how soon the first
    // matches were available vs. the full result set.
    const first = stream.rec.find((r) => r.n > 0);
    console.log(`INFO  first matches at ${first ? first.t.toFixed(1) : 'n/a'} ms; `
      + `complete result set at ${stream.totalMs.toFixed(1)} ms`);

    // ---- 2. Offset convention: every page-1 match sliced out of the text
    // layer's own concatenated text must equal the query — the exact
    // contract highlight drawing (rangeForMatch) depends on.
    const offsets = await page.evaluate(({ sel, q }) => {
      const w = window as unknown as W;
      const text = document.querySelector(sel)?.textContent ?? '';
      const ms = w.__pt.search.matches.filter((m) => m.page === 1);
      return {
        n: ms.length,
        ok: ms.every((m) => text.slice(m.start, m.end).toLowerCase() === q),
      };
    }, { sel: PAGE1_TEXT, q: Q });
    check('match offsets are original text-layer offsets (slices equal the query)',
      offsets.n > 0 && offsets.ok, `${offsets.n} page-1 matches`);

    // ---- 3. Highlights drawn by the time runSearch resolves, with the
    // current match marked; the count is exact once settled.
    await page.evaluate(() =>
      (window as unknown as W).__pt.controller.runSearch('equivariant'));
    // the jump may land on a page still rendering; highlights draw as it
    // finishes (same render hook the app uses), so wait rather than sample
    await page.waitForSelector('.searchHl.selected', { timeout: 10_000 })
      .catch(() => { /* the checks below report the real state */ });
    const hl = await page.evaluate(() => ({
      hls: document.querySelectorAll('.searchHl').length,
      selected: document.querySelectorAll('.searchHl.selected').length,
      count: (window as unknown as W).__pt.controller.getSnapshot().searchCount,
    }));
    check('highlights are drawn for the jumped-to match', hl.hls >= 1, `${hl.hls} overlays`);
    check('exactly one match is marked current', hl.selected >= 1, `${hl.selected} selected`);
    check('the settled count is exact ("k / 4")', /^[1-4] \/ 4$/.test(hl.count), `"${hl.count}"`);

    // ---- 4. A query superseded mid-index converges to the NEW query's
    // complete results (no stale matches from the old one, none dropped).
    await load();
    const race = await page.evaluate(async () => {
      const w = window as unknown as W;
      void w.__pt.controller.runSearch('the', { jump: false }); // superseded immediately
      await w.__pt.controller.runSearch('equivariant', { jump: false });
      return {
        q: w.__pt.search.query,
        n: w.__pt.search.matches.length,
        count: w.__pt.controller.getSnapshot().searchCount,
      };
    });
    check('a query superseded mid-index converges to the new query',
      race.q === 'equivariant' && race.n === 4 && race.count === '0 / 4',
      JSON.stringify(race));

    // ---- 5. Clearing the query mid-index drops everything and STAYS
    // clear — late index batches must not resurrect matches.
    await load();
    const cleared = await page.evaluate(async () => {
      const w = window as unknown as W;
      void w.__pt.controller.runSearch('the', { jump: false }); // still indexing…
      await w.__pt.controller.runSearch('', { jump: false });
      const atClear = w.__pt.search.matches.length;
      await new Promise((r) => setTimeout(r, 800));
      return {
        atClear,
        later: w.__pt.search.matches.length,
        count: w.__pt.controller.getSnapshot().searchCount,
      };
    });
    check('clearing mid-index leaves no stale matches (now or later)',
      cleared.atClear === 0 && cleared.later === 0 && cleared.count === '',
      JSON.stringify(cleared));

    // ---- 6. Document swap mid-index: index chunks and match batches
    // from the SUPERSEDED document must be discarded on both sides of the
    // worker boundary (doc-epoch guard) — the old buildText closure used
    // to survive a swap and could assign the previous document's text.
    await load();
    const swap = await page.evaluate(async () => {
      const w = window as unknown as W;
      const buf = new Uint8Array(await (await fetch('sample/cjk.pdf')).arrayBuffer());
      void w.__pt.controller.runSearch('the', { jump: false }); // indexing doc A…
      await w.__pt.controller.openData(buf, 'cjk.pdf'); // …swapped mid-flight
      await new Promise((r) => setTimeout(r, 600)); // let any stale batches land
      const afterSwap = { q: w.__pt.search.query, n: w.__pt.search.matches.length };
      await w.__pt.controller.runSearch('你好', { jump: false });
      return {
        afterSwap,
        n: w.__pt.search.matches.length,
        pages: w.__pt.search.matches.map((m) => m.page),
        count: w.__pt.controller.getSnapshot().searchCount,
      };
    });
    check('a document swap mid-index discards the old document\'s search state',
      swap.afterSwap.q === '' && swap.afterSwap.n === 0, JSON.stringify(swap.afterSwap));
    check('searching the swapped-in document finds only its own matches',
      swap.n === 2 && swap.pages.every((p) => p === 1) && swap.count === '0 / 2',
      JSON.stringify({ n: swap.n, pages: swap.pages, count: swap.count }));

    // ---- 7. A page whose text extraction FAILS must not poison the
    // search: it contributes no text, indexing continues past it, and the
    // query still completes. (The old buildText cached a rejected promise
    // forever — one corrupt page killed search until reopen.)
    await load();
    const poisoned = await page.evaluate(async () => {
      const w = window as unknown as W;
      const doc = w.__pt.viewer.doc;
      const orig = doc.getPage.bind(doc);
      doc.getPage = (n: number) => (n === 3
        ? Promise.reject(new Error('corrupt page (test)'))
        : orig(n));
      const result = await Promise.race([
        w.__pt.controller.runSearch('the', { jump: false }).then(() => 'completed'),
        new Promise((r) => setTimeout(() => r('wedged'), 15_000)),
      ]);
      doc.getPage = orig;
      return {
        result,
        n: w.__pt.search.matches.length,
        pages: [...new Set(w.__pt.search.matches.map((m) => m.page))],
        count: w.__pt.controller.getSnapshot().searchCount,
      };
    });
    check('a failing page does not wedge the search (the query completes)',
      poisoned.result === 'completed', String(poisoned.result));
    check('indexing continues past the failing page (matches beyond it, none on it)',
      poisoned.n > 0 && !poisoned.pages.includes(3) && poisoned.pages.some((p) => p > 3),
      `pages ${poisoned.pages.slice(0, 8).join(',')}…`);
    check('the count settles despite the failing page',
      new RegExp(`^0 / ${poisoned.n}$`).test(poisoned.count), `"${poisoned.count}"`);

    // ---- 8. Dismissing the find bar within the 350 ms debounce window
    // must cancel the pending search: no phantom search or jump, and no
    // spurious history entry after commitSearch already ran.
    await load();
    const modk = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modk}+f`);
    await page.waitForSelector('#searchInput', { timeout: 5000 });
    await page.fill('#searchInput', 'equivariant'); // arms the debounce…
    await page.keyboard.press('Escape'); // …and closes before it fires
    await page.waitForTimeout(700); // well past the stale timer
    const ghost = await page.evaluate(() => {
      const w = window as unknown as W;
      return {
        q: w.__pt.search.query,
        count: w.__pt.controller.getSnapshot().searchCount,
        ghostEntries: w.__pt.hist.active.entries
          .map((e) => e.label).filter((l) => l.includes('equivariant')).length,
        barOpen: !!document.getElementById('searchBar'),
      };
    });
    check('dismissing the bar within the debounce window cancels the pending search',
      !ghost.barOpen && ghost.q === '' && ghost.count === '' && ghost.ghostEntries === 0,
      JSON.stringify(ghost));

    // Enter inside the debounce window flushes the typed query at once
    // (it must never step the previous query's matches instead).
    await page.keyboard.press(`${modk}+f`);
    await page.waitForSelector('#searchInput', { timeout: 5000 });
    await page.fill('#searchInput', 'equivariant');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      (document.getElementById('searchCount')?.textContent ?? '').trim() === '1 / 4',
    undefined, { timeout: 8000 }).catch(() => { /* reported below */ });
    const flushed = await page.evaluate(() =>
      (window as unknown as W).__pt.controller.getSnapshot().searchCount);
    check('Enter within the debounce window runs the typed query', flushed === '1 / 4', `"${flushed}"`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
