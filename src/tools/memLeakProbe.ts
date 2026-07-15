// DIAGNOSTIC (temporary): decide whether per-page memory is a LEAK or a
// bounded cache. The viewer evicts canvases beyond DESTROY_MARGIN, but
// destroyPage never calls pdf.js page.cleanup() — so pdf.js-internal
// per-page caches (decoded images, operator lists) may accumulate for
// every distinct page visited and never be reclaimed.
//
// Scenarios, each reported via app.getAppMetrics (workingSetSize):
//   empty-window  → baseline shell
//   paper-open    → fixture paper open, first pages rendered
//   sweep-end     → after scrolling through EVERY page once
//   back-at-top   → returned to page 1, eviction settled
//   after-gc      → 3 forced GCs later; still-elevated = reachable = leak
//   cycle-end     → 20 round-trips over the SAME pages, then GC
//
// VERDICT lines make the run self-reading:
//   distinct-pages: LEAK-SHAPED when after-gc ≫ paper-open
//   same-pages:     LEAK-SHAPED when cycle-end ≫ after-gc
// Run: npx electron build-node/tools/memLeakProbe.js

import * as path from 'node:path';
import * as fs from 'node:fs';
import { app, BrowserWindow } from 'electron';

// Renderer GC must be forceable for the reachability probe.
app.commandLine.appendSwitch('js-flags', '--expose-gc');

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Snap { total: number; tab: number }

function snap(tag: string): Snap {
  const rows = app.getAppMetrics().map((m) => ({
    type: m.type,
    rssMB: m.memory.workingSetSize / 1024, // KB → MB
  }));
  const total = rows.reduce((s, r) => s + r.rssMB, 0);
  const tab = rows.filter((r) => r.type === 'Tab').reduce((s, r) => s + r.rssMB, 0);
  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0) + r.rssMB);
  console.log(`MEM ${tag}: totalMB=${total.toFixed(1)} tabMB=${tab.toFixed(1)} ` +
    JSON.stringify(Object.fromEntries(
      [...byType.entries()].map(([k, v]) => [k, Math.round(v * 10) / 10]))));
  return { total, tab };
}

async function gcRenderer(win: BrowserWindow): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await win.webContents.executeJavaScript(
      '(() => { if (typeof window.gc === "function") window.gc(); return true; })()');
    await sleep(1000);
  }
}

async function run(): Promise<void> {
  await app.whenReady();
  let win: BrowserWindow | null = null;
  for (let i = 0; i < 100 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0] ?? null;
    await sleep(200);
  }
  if (!win) throw new Error('no window');
  await sleep(4000);
  snap('empty-window');

  const pdfB64 = fs
    .readFileSync(path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf'))
    .toString('base64');
  await win.webContents.executeJavaScript(`(async () => {
    const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
    await window.__pt.controller.openData(bytes.buffer, 'WStarCats.pdf', {});
    return true;
  })()`);
  await sleep(6000);
  const paperOpen = snap('paper-open');

  // Visit every page once: scroll to each page's own offset and let it render.
  const pageCount: number = await win.webContents.executeJavaScript(
    'window.__pt.viewer.pages.length');
  for (let i = 0; i < pageCount; i += 1) {
    await win.webContents.executeJavaScript(
      `(() => { const v = window.__pt.viewer;
         v.container.scrollTop = v.pages[${i}].el.offsetTop; })()`);
    await sleep(700);
  }
  snap('sweep-end');

  await win.webContents.executeJavaScript(
    '(() => { window.__pt.viewer.container.scrollTop = 0; })()');
  await sleep(3000); // eviction of far pages + re-render of page 1
  snap('back-at-top');

  await gcRenderer(win);
  const afterGc = snap('after-gc');

  // Same-pages churn: 20 round-trips between page 1 and page 3.
  for (let i = 0; i < 20; i += 1) {
    await win.webContents.executeJavaScript(
      `(() => { const v = window.__pt.viewer;
         v.container.scrollTop = v.pages[${i % 2 === 0 ? 2 : 0}].el.offsetTop; })()`);
    await sleep(400);
  }
  await gcRenderer(win);
  const cycleEnd = snap('cycle-end');

  const distinct = afterGc.tab - paperOpen.tab;
  const same = cycleEnd.tab - afterGc.tab;
  console.log(`VERDICT distinct-pages: ${distinct > 25 ? 'LEAK-SHAPED' : 'PLATEAU'} ` +
    `(renderer ${distinct >= 0 ? '+' : ''}${distinct.toFixed(1)}MB vs paper-open after return+GC)`);
  console.log(`VERDICT same-pages: ${same > 25 ? 'LEAK-SHAPED' : 'PLATEAU'} ` +
    `(renderer ${same >= 0 ? '+' : ''}${same.toFixed(1)}MB over 20 same-page round-trips)`);

  app.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
