// Hot-path profiler — measures the paths the history profiler (perf.ts)
// does NOT: pdf.js page render, text extraction, the full-document search
// index build + query, zoom re-layout, and outline parse. Every number is
// measured in the real app on a large document (sample/perf-big.pdf), plus
// heap (GC-fenced via CDP) and a CPU profile of a render loop.
//
// Prereq: npm run build && node build-node/tools/perfBigPdf.js && npm start.
// Usage: node build-node/tools/perfHot.js [baseUrl]
import { findBrowser } from '../test/browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Stat { avg: number; med: number; min: number; max: number }

async function heapMB(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  await cdp.detach();
  return usedSize / 1048576;
}

async function cpuProfileRenderLoop(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
  await page.evaluate(async () => {
    const pt = (window as never as { __pt: { viewer: { doc: PdfDoc } } }).__pt;
    interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage> }
    interface PdfPage {
      getViewport(o: { scale: number }): { width: number; height: number };
      render(o: unknown): { promise: Promise<void> };
      getTextContent(): Promise<unknown>;
    }
    const doc = pt.viewer.doc;
    const dpr = window.devicePixelRatio || 1;
    for (let k = 0; k < 24; k++) {
      const n = 1 + Math.floor((k * (doc.numPages - 1)) / 23);
      const pg = await doc.getPage(n);
      const vp = pg.getViewport({ scale: 1.5 });
      const c = document.createElement('canvas');
      const bw = Math.floor(vp.width * dpr); const bh = Math.floor(vp.height * dpr);
      c.width = bw; c.height = bh;
      const ctx = c.getContext('2d', { alpha: false });
      await pg.render({ canvas: c, canvasContext: ctx, viewport: vp,
        transform: [bw / vp.width, 0, 0, bh / vp.height, 0, 0] }).promise;
      await pg.getTextContent();
    }
  });
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.detach();
  const total = profile.endTime - profile.startTime;
  const hitByNode = new Map<number, number>();
  for (const s of profile.samples ?? []) hitByNode.set(s, (hitByNode.get(s) ?? 0) + 1);
  const perFn = new Map<string, number>();
  for (const node of profile.nodes) {
    const hits = hitByNode.get(node.id) ?? 0;
    if (!hits) continue;
    const cf = node.callFrame;
    const url = cf.url ? cf.url.split('/').pop() : '';
    perFn.set(`${cf.functionName || '(anonymous)'}  [${url}:${cf.lineNumber}]`,
      (perFn.get(`${cf.functionName || '(anonymous)'}  [${url}:${cf.lineNumber}]`) ?? 0) + hits);
  }
  const sc = (profile.samples ?? []).length || 1;
  return [...perFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([fn, hits]) => {
    const ms = ((hits / sc) * total) / 1000;
    return `${((hits / sc) * 100).toFixed(1).padStart(5)}%  ${ms.toFixed(1).padStart(8)}ms  ${fn}`;
  });
}

async function run(): Promise<void> {
  const browser = await chromium.launch({
    executablePath: findBrowser(), headless: true,
    args: ['--enable-precise-memory-info'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(BASE + '/?file=sample/perf-big.pdf');
    await page.waitForSelector('.page canvas', { timeout: 90_000 });
    const heapAfterOpen = await heapMB(page);

    const m = await page.evaluate(async () => {
      interface PdfPage {
        getViewport(o: { scale: number }): { width: number; height: number };
        render(o: unknown): { promise: Promise<void> };
        getTextContent(): Promise<{ items: unknown[] }>;
      }
      interface Pt {
        viewer: { doc: { numPages: number; getPage(n: number): Promise<PdfPage>; getOutline(): Promise<unknown[]> }; scale: number; setScale(s: number, o?: unknown): void };
        search: { setQuery(q: string): Promise<void>; matches: unknown[] };
      }
      const pt = (window as never as { __pt: Pt }).__pt;
      const doc = pt.viewer.doc;
      const N = doc.numPages;
      const dpr = window.devicePixelRatio || 1;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      const stat = (a: number[]): Stat => {
        const s = [...a].sort((x, y) => x - y);
        return { avg: a.reduce((x, y) => x + y, 0) / a.length, med: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] };
      };
      interface Stat { avg: number; med: number; min: number; max: number }

      const sample: number[] = [];
      for (let k = 0; k < 12; k++) sample.push(1 + Math.floor((k * (N - 1)) / 11));

      // (1) per-page canvas render at fit-ish scale, and (2) at high zoom (DPI cost)
      const renderMs: number[] = []; const renderHiMs: number[] = []; const textMs: number[] = [];
      const renderAt = async (pg: PdfPage, scale: number): Promise<number> => {
        const vp = pg.getViewport({ scale });
        const c = document.createElement('canvas');
        const bw = Math.floor(vp.width * dpr); const bh = Math.floor(vp.height * dpr);
        c.width = bw; c.height = bh;
        const ctx = c.getContext('2d', { alpha: false });
        const t0 = performance.now();
        await pg.render({ canvas: c, canvasContext: ctx, viewport: vp, transform: [bw / vp.width, 0, 0, bh / vp.height, 0, 0] }).promise;
        return performance.now() - t0;
      };
      for (const n of sample) {
        const pg = await doc.getPage(n);
        renderMs.push(await renderAt(pg, 1.5));
        renderHiMs.push(await renderAt(pg, 3.0));
        const t1 = performance.now();
        await pg.getTextContent();
        textMs.push(performance.now() - t1);
      }

      // (3) full-document search index build (first query builds pageTexts across ALL pages)
      const tb = performance.now();
      await pt.search.setQuery('category');
      const searchBuildMs = performance.now() - tb;
      const matchesBuild = pt.search.matches.length;
      // (4) query on the already-built index (pure indexOf scan)
      const tq = performance.now();
      await pt.search.setQuery('morphism');
      const searchQueryMs = performance.now() - tq;
      const matchesQuery = pt.search.matches.length;

      // (5) zoom re-layout (synchronous relayout of the whole page list)
      const cur = pt.viewer.scale;
      const tz = performance.now();
      pt.viewer.setScale(cur * 1.5);
      const zoomRelayoutMs = performance.now() - tz;
      await raf();
      pt.viewer.setScale(cur);
      await raf();

      return {
        numPages: N, dpr,
        renderFit: stat(renderMs), renderHi: stat(renderHiMs), textContent: stat(textMs),
        searchBuildMs, matchesBuild, searchQueryMs, matchesQuery, zoomRelayoutMs,
      };
    });

    const heapAfterSearch = await heapMB(page);
    const cpu = await cpuProfileRenderLoop(page);

    // outline parse on a doc that actually has an outline (WStarCats)
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.page canvas', { timeout: 30_000 });
    const outline = await page.evaluate(async () => {
      const pt = (window as never as { __pt: { viewer: { doc: { getOutline(): Promise<unknown[]> } } } }).__pt;
      const t0 = performance.now();
      const o = await pt.viewer.doc.getOutline();
      return { ms: performance.now() - t0, count: (o ?? []).length };
    });

    console.log('=== PAPER TRAIL HOT-PATH PROFILE ===');
    console.log(JSON.stringify({ heapAfterOpenMB: heapAfterOpen, heapAfterSearchMB: heapAfterSearch, outline, ...m, consoleErrors: errors.slice(0, 5) }, null, 2));
    console.log('\n=== CPU profile: render+getTextContent loop, self-time ===');
    for (const l of cpu) console.log('  ' + l);
    await page.close();
  } finally {
    await browser.close();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
