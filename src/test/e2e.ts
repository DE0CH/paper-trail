// Headless end-to-end tests for PDF Stack Reader.
//
// Runs against a *separate* headless Chromium-family browser (Edge or
// Chrome binary on this machine) with its own profile, so it never
// interferes with the user's browsing session.
//
// Prereq: the app must be built (npm run build) and the server running
// (npm start). Usage: node build-node/test/e2e.js [baseUrl]

import { chromium, type Page } from 'playwright-core';
import * as fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const CANDIDATES = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const LINK_SEL = '.page[data-page="1"] .annotLayer .pdfLink:not(.external)';

async function run(): Promise<void> {
  const executablePath = CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) {
    console.error('No Chromium-family browser found');
    process.exit(2);
  }

  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => check('no page errors', false, String(e)));

    // fresh state
    await page.goto(BASE + '/');
    await page.evaluate(() => {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('psr:'))
        .forEach((k) => localStorage.removeItem(k));
      indexedDB.deleteDatabase('psr');
    });

    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector(LINK_SEL, { timeout: 20000 });
    check('PDF loads and page 1 links render', true);

    // --- link click pushes a labelled entry ---
    await page.locator(LINK_SEL).nth(3).click();
    await page.waitForTimeout(600);
    const st1 = await page.evaluate(() => {
      const psr = (window as never as { __psr: PsrHooks }).__psr;
      return {
        entries: psr.hist.active.entries.map((e) => e.label),
        index: psr.hist.active.index,
        page: psr.viewer.currentPosition().page,
      };
    });
    check('link click pushes entry', st1.entries.length === 2 && st1.index === 1,
      JSON.stringify(st1.entries));
    check('entry label extracted', /Definition 4\.1/.test(st1.entries[1]), st1.entries[1]);
    check('jumped to destination page', st1.page === 22, `page ${st1.page}`);

    // --- back restores exact position, preserves forward tail ---
    const posBefore = await page.evaluate(() =>
      (window as never as { __psr: PsrHooks }).__psr.hist.active.entries[0].pos);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);
    const st2 = await page.evaluate(() => {
      const psr = (window as never as { __psr: PsrHooks }).__psr;
      return {
        index: psr.hist.active.index,
        n: psr.hist.active.entries.length,
        pos: psr.viewer.currentPosition(),
      };
    });
    check('back pops the cursor, stack preserved', st2.index === 0 && st2.n === 2);
    check('back restores exact position',
      st2.pos.page === posBefore.page && Math.abs(st2.pos.yRatio - posBefore.yRatio) < 0.01,
      JSON.stringify(st2.pos));

    // --- forward ---
    await page.keyboard.press('Shift+Backspace');
    await page.waitForTimeout(400);
    const idx = await page.evaluate(() =>
      (window as never as { __psr: PsrHooks }).__psr.hist.active.index);
    check('forward descends again', idx === 1);

    // --- cmd+click forks the whole history into a new stack ---
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);
    await page.waitForSelector(LINK_SEL, { timeout: 10000 });
    await page.locator(LINK_SEL).nth(0).click({ modifiers: ['Meta'] });
    await page.waitForTimeout(600);
    const st3 = await page.evaluate(() => {
      const psr = (window as never as { __psr: PsrHooks }).__psr;
      return {
        stacks: psr.hist.stacks.map((s) => ({ name: s.name, n: s.entries.length, idx: s.index })),
        active: psr.hist.active.name,
        entries: psr.hist.active.entries.map((e) => e.label),
      };
    });
    check('meta+click forks into a new stack',
      st3.stacks.length === 2 && st3.active === 'Untitled 2', JSON.stringify(st3.stacks));
    check('fork copies history and pushes jump',
      st3.entries.length === 2 && st3.entries[0] === 'Start', JSON.stringify(st3.entries));
    check('original stack untouched',
      st3.stacks[0].n === 2 && st3.stacks[0].idx === 0, JSON.stringify(st3.stacks[0]));

    // --- stack panel UI ---
    const stackRows = await page.locator('#stacksPanel .stackRow').count();
    check('stacks panel lists stacks', stackRows === 2, String(stackRows));

    // --- hover preview ---
    await page.evaluate(() => {
      const psr = (window as never as { __psr: PsrHooks }).__psr;
      psr.hist.jumpTo(0);
      psr.viewer.scrollTo({ page: 1, yRatio: 0 });
    });
    await page.waitForSelector(LINK_SEL, { timeout: 10000 });
    await page.locator(LINK_SEL).nth(3).hover();
    try {
      await page.waitForSelector('#preview:not(.hidden)', { timeout: 4000 });
      const pv = await page.evaluate(() => {
        const el = document.getElementById('preview')!;
        const c = el.querySelector('canvas')!;
        const ctx = c.getContext('2d')!;
        const d = ctx.getImageData(0, 0, c.width, Math.min(c.height, 300)).data;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 200) ink++;
        const r = el.getBoundingClientRect();
        const pr = document.querySelector('.page')!.getBoundingClientRect();
        return {
          label: el.querySelector('.previewPage')!.textContent,
          ink,
          alignedLeft: Math.abs(r.left - pr.left) < 3,
          sameWidth: Math.abs(r.width - pr.width) < 3,
          scrollable: !!el.querySelector('.previewScroll'),
        };
      });
      check('hover preview appears with rendered content',
        pv.ink > 100 && /p\.\s*22/.test(pv.label ?? ''), JSON.stringify({ label: pv.label, ink: pv.ink }));
      check('preview is page-width and aligned with the PDF',
        pv.alignedLeft && pv.sameWidth && pv.scrollable,
        JSON.stringify({ alignedLeft: pv.alignedLeft, sameWidth: pv.sameWidth }));
    } catch {
      check('hover preview appears with rendered content', false, 'never became visible');
    }
    await page.mouse.move(10, 500);
    await page.waitForTimeout(500);
    const previewHidden = await page.evaluate(() =>
      document.getElementById('preview')!.classList.contains('hidden'));
    check('preview hides on mouseleave', previewHidden);

    // --- search ---
    await page.fill('#searchInput', 'equivariant');
    await page.waitForFunction(
      () => document.getElementById('searchCount')!.textContent!.includes('/ 4'),
      undefined,
      { timeout: 15000 },
    );
    let hlCount = 0;
    try {
      await page.waitForSelector('.searchHl', { timeout: 10000 });
      hlCount = await page.evaluate(() => document.querySelectorAll('.searchHl').length);
    } catch { /* hlCount stays 0 */ }
    check('search finds 4 matches with highlights', hlCount >= 1, `highlights: ${hlCount}`);

    // --- panel resizing: extreme drags must not break the layout ---
    async function dragHandle(sel: string, toX: number): Promise<void> {
      const box = (await page.locator(sel).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(toX, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
    }
    const widths = () => page.evaluate(() => ({
      sidebar: document.getElementById('sidebar')!.getBoundingClientRect().width,
      stacks: document.getElementById('stacksCol')!.getBoundingClientRect().width,
      sideCol: document.getElementById('sideCol')!.getBoundingClientRect().width,
      win: window.innerWidth,
    }));
    await dragHandle('#resizeSidebar', 0);
    let w = await widths();
    check('sidebar drag to far left keeps panels usable',
      w.stacks >= 79 && w.sideCol >= 140 && w.sidebar >= w.stacks + 140, JSON.stringify(w));
    await dragHandle('#resizeStacks', 0);
    w = await widths();
    check('stacks drag to far left keeps a usable column',
      w.stacks >= 79 && w.sideCol >= 140, JSON.stringify(w));
    await dragHandle('#resizeStacks', 1300);
    w = await widths();
    check('stacks drag to far right leaves room for history',
      w.sideCol >= 140 && w.stacks <= w.sidebar - 140, JSON.stringify(w));
    await dragHandle('#resizeSidebar', 1390);
    w = await widths();
    check('sidebar drag to far right leaves room for the viewer',
      w.sidebar <= w.win - 250, JSON.stringify(w));
    await dragHandle('#resizeSidebar', 440);

    // --- undo/redo of history mutations ---
    const stU = await page.evaluate(async () => {
      const psr = (window as never as { __psr: PsrUndoHooks }).__psr;
      const out: Record<string, unknown> = {};
      // Overwrite scenario: mid-stack, jump somewhere -> tail overwritten.
      psr.hist.jumpTo(0);
      const tailBefore = psr.hist.active.entries.map((e) => e.label);
      psr.jumpVia({ page: 5, yRatio: 0 }, 'overwriter');
      out.afterOverwrite = psr.hist.active.entries.map((e) => e.label);
      psr.controller.undoHist();
      out.afterUndo = psr.hist.active.entries.map((e) => e.label);
      out.tailRestored =
        JSON.stringify(out.afterUndo) === JSON.stringify(tailBefore);
      psr.controller.redoHist();
      out.afterRedo = psr.hist.active.entries.map((e) => e.label);
      // Close-stack scenario + redo cleared by a new action.
      const stackCount = psr.hist.stacks.length;
      psr.hist.closeStack(psr.hist.stacks[psr.hist.stacks.length - 1].id);
      out.closed = psr.hist.stacks.length === stackCount - 1;
      psr.controller.undoHist();
      out.closeUndone = psr.hist.stacks.length === stackCount;
      out.canRedoBefore = psr.hist.canRedo();
      psr.jumpVia({ page: 2, yRatio: 0 }, 'redo-killer');
      out.redoClearedByNewAction = !psr.hist.canRedo();
      return out;
    });
    check('undo restores overwritten forward tail', stU.tailRestored === true,
      JSON.stringify({ before: stU.afterUndo, after: stU.afterOverwrite }));
    check('redo reapplies the overwrite',
      Array.isArray(stU.afterRedo)
        && (stU.afterRedo as string[]).at(-1) === 'overwriter');
    check('undo restores a closed stack',
      stU.closed === true && stU.closeUndone === true);
    check('redo is cleared by a new action',
      stU.canRedoBefore === true && stU.redoClearedByNewAction === true);

    // --- progress session: dirty flag + fake-handle save ---
    const st4 = await page.evaluate(async () => {
      const psr = (window as never as { __psr: PsrHooks }).__psr;
      const out: {
        dirtyAfterJump: boolean | null;
        dirtyAfterSave: boolean | null;
        savedJson: { type: string; name: string; size: number; stacks: number } | null;
      } = { dirtyAfterJump: null, dirtyAfterSave: null, savedJson: null };
      psr.jumpVia({ page: 3, yRatio: 0 }, 'probe');
      await new Promise((r) => setTimeout(r, 100));
      out.dirtyAfterJump = psr.session.dirty;
      let captured = '';
      psr.session.handle = {
        name: 't.psr',
        createWritable: async () => {
          let data = '';
          return {
            write: async (d: string) => { data = d; },
            close: async () => { captured = data; },
          };
        },
      } as never;
      await psr.writeProgress();
      out.dirtyAfterSave = psr.session.dirty;
      const lines = captured.split('\n');
      const get = (k: string) =>
        (lines.find((l) => l.startsWith(k + ' ')) ?? '').slice(k.length + 1);
      out.savedJson = {
        type: lines[0],
        name: get('pdf.name'),
        size: parseInt(get('pdf.size'), 10),
        stacks: lines.filter((l) => l.startsWith('stack ')).length,
      };
      psr.session.handle = null;
      psr.session.dirty = false;
      return out;
    });
    check('jump marks session dirty', st4.dirtyAfterJump === true);
    check('save writes line-oriented progress file and clears dirty',
      st4.dirtyAfterSave === false
        && st4.savedJson!.type === 'psr-progress v1'
        && st4.savedJson!.size > 100000
        && st4.savedJson!.stacks === 2,
      JSON.stringify(st4.savedJson));

    // --- progress file round trip over HTTP (?file=…psr.json) ---
    await page.evaluate(() => {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('psr:doc:'))
        .forEach((k) => localStorage.removeItem(k));
      (window as never as { __psr: PsrHooks }).__psr.session.dirty = false;
    });
    await page.goto(BASE + '/?file=sample/WStarCats.psr');
    await page.waitForSelector('.page canvas', { timeout: 20000 });
    await page.waitForTimeout(800);
    const st5 = await page.evaluate(() => {
      const psr = (window as never as { __psr: PsrHooks }).__psr;
      return {
        stack: psr.hist.active.name,
        labels: psr.hist.active.entries.map((e) => e.label),
        pos: psr.viewer.currentPosition(),
        bound: !!psr.session.handle,
      };
    });
    check('progress file restores stack and position',
      st5.stack === 'RoundTrip' && st5.pos.page === 17 && !st5.bound, JSON.stringify(st5));
    await page.evaluate(() => {
      (window as never as { __psr: PsrHooks }).__psr.session.dirty = false;
    });
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

interface PsrUndoHooks extends PsrHooks {
  controller: { undoHist(): void; redoHist(): void };
}

// Shape of the window.__psr test hooks (see core/controller.ts).
interface PsrHooks {
  hist: {
    active: { name: string; index: number; entries: Array<{ label: string; pos: { page: number; yRatio: number } }> };
    stacks: Array<{ id: number; name: string; index: number; entries: Array<{ label: string }> }>;
    jumpTo(i: number): unknown;
    closeStack(id: number): boolean;
    canRedo(): boolean;
  };
  viewer: {
    currentPosition(): { page: number; yRatio: number };
    scrollTo(pos: { page: number; yRatio: number }): void;
  };
  session: { dirty: boolean; handle: unknown };
  jumpVia(pos: { page: number; yRatio: number }, label: string, fork?: boolean): void;
  writeProgress(): Promise<void>;
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
