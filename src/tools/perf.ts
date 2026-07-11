// Performance profile for the history stacks + snapshot-based undo/redo.
//
// The undo implementation is the simplest possible one: every structural
// mutation deep-copies the entire state (all stacks) onto an undo stack
// (capped at 50). This script measures whether that falls apart as the
// number of stacks / entries / undo depth grows, inside the real app
// (including the React re-render and viewer work), and then takes a CPU
// profile of the heaviest scenario via the DevTools protocol to show where
// the time actually goes.
//
// Prereq: npm run build && npm start.  Usage: node build-node/tools/perf.js

import { findBrowser } from '../test/browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

// From "a normal paper-reading session" up to "absurd".
const SCENARIOS = [
  { name: 'realistic', stacks: 5, perStack: 50 },
  { name: 'heavy reader', stacks: 20, perStack: 200 },
  { name: 'many stacks', stacks: 200, perStack: 50 },
  { name: 'deep stacks', stacks: 10, perStack: 2_000 },
  { name: 'absurd', stacks: 20, perStack: 5_000 },
];

interface Metrics {
  totalEntries: number;
  stateKB: number;
  serializeMs: number; // one undo snapshot (deep copy of everything)
  persistMs: number; // JSON.stringify + localStorage.setItem
  visitMs: number; // full jump: snapshot + scroll + React render
  undoMs: number; // full undo: restore + scroll + React render
  redoMs: number;
  forkMs: number; // copies the active stack
  heap50MB: number; // heap growth from filling the 50-deep undo stack
}

async function measure(page: Page, stacks: number, perStack: number): Promise<Metrics> {
  return page.evaluate(async (cfg) => {
    interface Entry { label: string; pos: { page: number; yRatio: number } }
    interface Pt {
      hist: {
        load(d: unknown): boolean;
        serialize(): unknown;
        visit(e: Entry): Entry;
        fork(e: Entry): Entry;
      };
      controller: { undoHist(): void; redoHist(): void };
      jumpVia(pos: { page: number; yRatio: number }, label: string): void;
    }
    const pt = (window as never as { __pt: Pt }).__pt;
    const raf = () => new Promise((r) => requestAnimationFrame(r));

    // Seed the state in one load() (a single emit).
    const seeded = [];
    for (let s = 0; s < cfg.stacks; s++) {
      const entries: Entry[] = [];
      for (let i = 0; i < cfg.perStack; i++) {
        entries.push({
          label: `Lemma ${s}.${i} probe entry with a plausible label`,
          pos: { page: 1 + (i % 40), yRatio: (i % 100) / 100 },
        });
      }
      seeded.push({ id: s + 1, name: `Stack ${s}`, index: entries.length - 1, entries });
    }
    pt.hist.load({ v: 3, activeId: 1, nameCounter: cfg.stacks + 1, stacks: seeded });
    await raf();

    const timed = (fn: () => void): number => {
      const t0 = performance.now();
      fn();
      return performance.now() - t0;
    };

    // (a) one undo snapshot: serialize() is exactly what recordUndo copies
    let serialize = 0;
    for (let i = 0; i < 10; i++) serialize += timed(() => pt.hist.serialize());
    serialize /= 10;

    // (b) localStorage persistence of the same state (the app catches
    // quota errors; ~5MB states exceed the browser quota)
    const json = JSON.stringify(pt.hist.serialize());
    let persist = -1;
    try {
      persist = timed(() => localStorage.setItem('pt:perf-probe', json));
      localStorage.removeItem('pt:perf-probe');
    } catch { /* quota exceeded */ }

    // (c) full user-visible operations, averaged (includes React render,
    // history-panel DOM, viewer scroll)
    const OPS = 12;
    let visit = 0;
    for (let i = 0; i < OPS; i++) {
      const t0 = performance.now();
      pt.jumpVia({ page: 2 + (i % 3), yRatio: 0.5 }, `perf probe ${i}`);
      await raf();
      visit += performance.now() - t0;
    }
    visit /= OPS;

    let undo = 0;
    for (let i = 0; i < OPS; i++) {
      const t0 = performance.now();
      pt.controller.undoHist();
      await raf();
      undo += performance.now() - t0;
    }
    undo /= OPS;

    let redo = 0;
    for (let i = 0; i < OPS; i++) {
      const t0 = performance.now();
      pt.controller.redoHist();
      await raf();
      redo += performance.now() - t0;
    }
    redo /= OPS;

    const fork = timed(() => pt.hist.fork({ label: 'fork probe', pos: { page: 1, yRatio: 0 } }));

    return {
      totalEntries: cfg.stacks * cfg.perStack,
      stateKB: Math.round(json.length / 1024),
      serializeMs: serialize,
      persistMs: persist,
      visitMs: visit,
      undoMs: undo,
      redoMs: redo,
      forkMs: fork,
      heap50MB: 0, // filled in by the caller via CDP
    };
  }, { stacks, perStack });
}

// Heap growth from filling the undo stack to its 50-snapshot cap, measured
// with the DevTools protocol (GC-fenced, unlike performance.memory).
async function measureUndoHeap(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const gcAndUsage = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    return usedSize;
  };
  const before = await gcAndUsage();
  await page.evaluate(() => {
    interface Pt { hist: { visit(e: unknown): unknown } }
    const pt = (window as never as { __pt: Pt }).__pt;
    for (let i = 0; i < 50; i++) {
      pt.hist.visit({ label: `fill ${i}`, pos: { page: 1, yRatio: 0 } });
    }
  });
  const after = await gcAndUsage();
  await cdp.detach();
  return (after - before) / 1048576;
}

async function cpuProfile(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
  await page.evaluate(async () => {
    interface Pt {
      controller: { undoHist(): void; redoHist(): void };
      jumpVia(pos: { page: number; yRatio: number }, label: string): void;
    }
    const pt = (window as never as { __pt: Pt }).__pt;
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 20; i++) {
      pt.jumpVia({ page: 2, yRatio: 0.5 }, `profiled ${i}`);
      await raf();
      pt.controller.undoHist();
      await raf();
    }
  });
  const { profile } = await cdp.send('Profiler.stop');

  // Aggregate self time per function.
  const total = profile.endTime - profile.startTime; // microseconds
  const samples = profile.samples ?? [];
  const hitByNode = new Map<number, number>();
  for (const s of samples) hitByNode.set(s, (hitByNode.get(s) ?? 0) + 1);
  const perFn = new Map<string, number>();
  for (const node of profile.nodes) {
    const hits = hitByNode.get(node.id) ?? 0;
    if (!hits) continue;
    const cf = node.callFrame;
    const url = cf.url ? cf.url.split('/').pop() : '';
    const key = `${cf.functionName || '(anonymous)'}  [${url}:${cf.lineNumber}]`;
    perFn.set(key, (perFn.get(key) ?? 0) + hits);
  }
  const sampleCount = samples.length || 1;
  return [...perFn.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([fn, hits]) => {
      const ms = ((hits / sampleCount) * total) / 1000;
      const pct = ((hits / sampleCount) * 100).toFixed(1);
      return `${pct.padStart(5)}%  ${ms.toFixed(1).padStart(8)}ms  ${fn}`;
    });
}

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--enable-precise-memory-info'],
  });
  try {
    const header = [
      'scenario'.padEnd(14),
      'entries'.padStart(8),
      'stateKB'.padStart(8),
      'snapshot'.padStart(9),
      'persist'.padStart(8),
      'visit'.padStart(7),
      'undo'.padStart(7),
      'redo'.padStart(7),
      'fork'.padStart(7),
      'undo50MB'.padStart(9),
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length));

    for (const sc of SCENARIOS) {
      // Fresh page per scenario so scenarios don't contaminate each other.
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(BASE + '/');
      await page.evaluate(() => {
        Object.keys(localStorage)
          .filter((k) => k.startsWith('pt:'))
          .forEach((k) => localStorage.removeItem(k));
      });
      await page.goto(BASE + '/?file=sample/WStarCats.pdf');
      await page.waitForSelector('.page canvas', { timeout: 20000 });
      const m = await measure(page, sc.stacks, sc.perStack);
      m.heap50MB = await measureUndoHeap(page);
      console.log([
        sc.name.padEnd(14),
        String(m.totalEntries).padStart(8),
        String(m.stateKB).padStart(8),
        `${m.serializeMs.toFixed(2)}ms`.padStart(9),
        (m.persistMs < 0 ? 'QUOTA!' : `${m.persistMs.toFixed(1)}ms`).padStart(8),
        `${m.visitMs.toFixed(1)}ms`.padStart(7),
        `${m.undoMs.toFixed(1)}ms`.padStart(7),
        `${m.redoMs.toFixed(1)}ms`.padStart(7),
        `${m.forkMs.toFixed(1)}ms`.padStart(7),
        `${m.heap50MB.toFixed(1)}MB`.padStart(9),
      ].join('  '));

      if (sc === SCENARIOS[SCENARIOS.length - 1]) {
        console.log('\nCPU profile of jump+undo loop at the largest size (self time):');
        for (const line of await cpuProfile(page)) console.log('  ' + line);
      }
      await page.close();
    }

    // ---- empirical limits: where does it actually stop being usable? ----
    console.log('\nLimit search (hard = fails outright, soft = unusably slow):');
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.page canvas', { timeout: 20000 });

    // Hard limit: localStorage quota for auto-resume state.
    const quota = await page.evaluate(() => {
      // grow a synthetic state until setItem fails
      const entry = () => ({
        label: 'Lemma probe entry with a plausible label',
        pos: { page: 3, yRatio: 0.5 },
      });
      let lo = 0;
      let hi = 400_000;
      const fits = (n: number): boolean => {
        const s = JSON.stringify({
          stacks: [{ id: 1, name: 'x', index: 0, entries: Array.from({ length: n }, entry) }],
        });
        try {
          localStorage.setItem('pt:quota-probe', s);
          localStorage.removeItem('pt:quota-probe');
          return true;
        } catch {
          return false;
        }
      };
      while (hi - lo > 2000) {
        const mid = Math.floor((lo + hi) / 2);
        if (fits(mid)) lo = mid; else hi = mid;
      }
      return lo;
    });
    console.log(`  HARD  localStorage auto-resume stops working beyond ~${Math.round(quota / 1000)}k`
      + ' total entries (browser quota; session FILES have no such limit)');

    // Soft limit: visit latency vs entries in the ACTIVE stack (the history
    // panel renders all of them).
    let softAt = 0;
    for (const n of [2_000, 5_000, 10_000, 20_000, 40_000, 80_000]) {
      const ms = await page.evaluate(async (count) => {
        interface Pt {
          hist: { load(d: unknown): boolean };
          jumpVia(pos: { page: number; yRatio: number }, label: string): void;
        }
        const pt = (window as never as { __pt: Pt }).__pt;
        const entries = Array.from({ length: count }, (_, i) => ({
          label: `Lemma ${i} probe entry with a plausible label`,
          pos: { page: 1 + (i % 40), yRatio: (i % 100) / 100 },
        }));
        pt.hist.load({
          v: 3, activeId: 1, nameCounter: 2,
          stacks: [{ id: 1, name: 'big', index: count - 1, entries }],
        });
        await new Promise((r) => requestAnimationFrame(r));
        const t0 = performance.now();
        pt.jumpVia({ page: 2, yRatio: 0.5 }, 'probe');
        await new Promise((r) => requestAnimationFrame(r));
        return performance.now() - t0;
      }, n);
      console.log(`        active stack ${String(n).padStart(6)} entries -> visit ${ms.toFixed(0)}ms`);
      if (ms > 100 && !softAt) softAt = n;
    }
    console.log(softAt
      ? `  SOFT  interaction exceeds ~100ms (feels sluggish) around ${Math.round(softAt / 1000)}k entries in the active stack`
      : '  SOFT  never exceeded 100ms in the tested range');
    await page.close();
  } finally {
    await browser.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
