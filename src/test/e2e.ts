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

    // --- panel resizing: each divider resizes exactly one panel; the
    // others keep their widths (they only shift) ---
    async function dragHandle(sel: string, toX: number): Promise<void> {
      const box = (await page.locator(sel).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(toX, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
    }
    const widths = () => page.evaluate(() => ({
      nav: document.getElementById('navCol')?.getBoundingClientRect().width ?? 0,
      stacks: document.getElementById('stacksCol')!.getBoundingClientRect().width,
      side: document.getElementById('sideCol')!.getBoundingClientRect().width,
      win: window.innerWidth,
    }));
    const near = (a: number, b: number) => Math.abs(a - b) < 1.5;

    let w0 = await widths();
    await dragHandle('#resizeNav', 0);
    let w = await widths();
    check('nav drag far left: clamped, neighbors unchanged',
      w.nav >= 89 && near(w.stacks, w0.stacks) && near(w.side, w0.side), JSON.stringify(w));
    await dragHandle('#resizeStacks', 0);
    w0 = w;
    w = await widths();
    check('stacks drag far left: clamped, neighbors unchanged',
      w.stacks >= 79 && near(w.nav, w0.nav) && near(w.side, w0.side), JSON.stringify(w));
    await dragHandle('#resizeStacks', 1390);
    w0 = w;
    w = await widths();
    check('stacks drag far right: viewer keeps room, neighbors unchanged',
      w.nav + w.stacks + w.side <= w.win - 250 && near(w.nav, w0.nav) && near(w.side, w0.side),
      JSON.stringify(w));
    await dragHandle('#resizeSidebar', 1390);
    w0 = w;
    w = await widths();
    check('history drag far right: viewer keeps room, neighbors unchanged',
      w.nav + w.stacks + w.side <= w.win - 250 && near(w.nav, w0.nav) && near(w.stacks, w0.stacks),
      JSON.stringify(w));
    // Closing the nav panel must not resize the others.
    w0 = w;
    await page.click('#btnNavClose');
    w = await widths();
    check('closing nav panel leaves other panels unchanged',
      w.nav === 0 && near(w.stacks, w0.stacks) && near(w.side, w0.side), JSON.stringify(w));
    await page.click('#btnNavToggle');
    // Restore sane sizes for the remaining tests.
    w = await widths();
    await dragHandle('#resizeStacks', w.nav + 150);
    w = await widths();
    await dragHandle('#resizeSidebar', w.nav + w.stacks + 290);

    // --- renaming: history entries, and strange characters in names ---
    await page.locator('#historyPanel .histItem .lbl').first().dblclick();
    await page.fill('#historyPanel .histItem input.rename', '  my renamed entry  ');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const renamed = await page.evaluate(() =>
      (window as never as { __psr: PsrHooks }).__psr.hist.active.entries[0].label);
    check('history entries are renamable (trimmed)', renamed === 'my renamed entry', renamed);

    // --- nav panel: outline + page thumbnails, closable ---
    const navVisible = await page.locator('#navCol').count();
    check('nav panel is visible by default', navVisible === 1);
    const outlineItems = await page.locator('#navCol .outlineItem').count();
    check('outline lives in the nav panel', outlineItems > 3, `${outlineItems} items`);
    await page.click('#navCol button:has-text("Pages")');
    await page.waitForSelector('#thumbList [data-thumb-page="1"] canvas', { timeout: 15000 });
    check('page thumbnails render lazily', true);
    const before = await page.evaluate(() => {
      const h = (window as never as { __psr: PsrHooks }).__psr.hist.active;
      return { index: h.index };
    });
    await page.locator('#thumbList .thumb').nth(2).click();
    await page.waitForTimeout(400);
    const afterThumb = await page.evaluate(() => {
      const psr = (window as never as { __psr: PsrHooks }).__psr;
      return {
        page: psr.viewer.currentPosition().page,
        n: psr.hist.active.entries.length,
        label: psr.hist.active.entries[psr.hist.active.index].label,
      };
    });
    // A jump truncates above the cursor, so the new length is cursor+2.
    check('clicking a thumbnail jumps and pushes history',
      afterThumb.page === 3 && afterThumb.n === before.index + 2 && /p\.\s*3/.test(afterThumb.label),
      JSON.stringify(afterThumb));
    await page.click('#btnNavClose');
    check('nav panel closes', (await page.locator('#navCol').count()) === 0);
    await page.click('#btnNavToggle');
    check('nav panel reopens from the toolbar', (await page.locator('#navCol').count()) === 1);
    await page.click('#navCol button:has-text("Outline")');

    // --- text selection: emulate a person dragging across a line ---
    await page.evaluate(() => {
      (window as never as { __psr: PsrHooks }).__psr.viewer.scrollTo({ page: 1, yRatio: 0 });
    });
    await page.waitForSelector('.page[data-page="1"] .textLayer span', { timeout: 10000 });
    const p1box = (await page.locator('.page[data-page="1"]').boundingBox())!;
    const selY = p1box.y + p1box.height * 0.215; // the title line
    await page.mouse.move(p1box.x + p1box.width * 0.3, selY);
    await page.mouse.down();
    await page.mouse.move(p1box.x + p1box.width * 0.72, selY, { steps: 8 });
    await page.mouse.up();
    const selection = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    check('dragging the mouse selects text', selection.trim().length >= 4,
      JSON.stringify(selection.slice(0, 50)));
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    // --- weird characters in user-controlled names must survive the save
    // format (names/labels are free text) ---
    const weird = 'entry 3 0.5 tricky | "quo\'tes" \\ § 数学 🙂 <b>tag</b>';
    await page.evaluate((w) => {
      const psr = (window as never as { __psr: PsrFormatHooks }).__psr;
      const activeId = psr.hist.stacks.find((s) => s.name === psr.hist.active.name);
      void activeId;
      // rename the ACTIVE stack and its first entry
      const active = psr.hist.stacks.find((s) => s.entries === psr.hist.active.entries)!;
      psr.hist.renameStack(active.id, w);
      psr.hist.renameEntry(0, w + ' as a label\nwith newline');
    }, weird);
    await page.waitForTimeout(300); // let React render
    const weirdRes = await page.evaluate((w) => {
      const psr = (window as never as { __psr: PsrFormatHooks }).__psr;
      const parsed = psr.parseProgressText(psr.progressText());
      const stack = parsed?.state.hist.stacks.find((s) => s.name === w);
      const uiNames = [...document.querySelectorAll('#stacksPanel .stackRow .name')]
        .map((el) => el.textContent);
      return {
        ok: !!parsed,
        name: stack?.name,
        label: stack?.entries[0].label,
        uiHasWeird: uiNames.includes(w),
      };
    }, weird);
    check('weird characters survive the save-format round trip',
      weirdRes.ok && weirdRes.name === weird
        && weirdRes.label === weird + ' as a label with newline', // newline flattened
      JSON.stringify(weirdRes));
    check('weird characters render in the UI', weirdRes.uiHasWeird === true);

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
    // --- rendering sharpness on a retina display (deviceScaleFactor 2) ---
    const retina = await browser.newPage({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 2,
    });
    await retina.goto(BASE + '/?file=sample/WStarCats.pdf');
    await retina.waitForSelector('.page[data-page="1"] canvas', { timeout: 20000 });
    const sharpness = async () => retina.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('.page[data-page="1"] canvas')!;
      const r = c.getBoundingClientRect();
      return { backing: c.width, css: r.width, ratio: c.width / r.width };
    });
    let sh = await sharpness();
    check('canvas renders at device resolution (fit zoom)', sh.ratio >= 1.9,
      JSON.stringify(sh));
    await retina.evaluate(() => {
      (window as never as { __psr: { viewer: { setScale(s: number): void } } })
        .__psr.viewer.setScale(2.5);
    });
    await retina.waitForTimeout(1200);
    await retina.waitForSelector('.page[data-page="1"] canvas', { timeout: 10000 });
    sh = await sharpness();
    check('canvas stays at device resolution at high zoom', sh.ratio >= 1.9,
      JSON.stringify(sh));

    // --- trackpad pinch (ctrl+wheel) re-renders at the new scale instead
    // of magnifying pixels ---
    const pinch = await retina.evaluate(async () => {
      const psr = (window as never as {
        __psr: { viewer: { scale: number; setScale(s: number, o?: unknown): void } };
      }).__psr;
      psr.viewer.setScale(1.2);
      await new Promise((r) => setTimeout(r, 400));
      const before = psr.viewer.scale;
      const target = document.getElementById('viewerContainer')!;
      for (let i = 0; i < 5; i++) {
        target.dispatchEvent(new WheelEvent('wheel', {
          ctrlKey: true, deltaY: -40, clientX: 700, clientY: 450,
          bubbles: true, cancelable: true,
        }));
        await new Promise((r) => setTimeout(r, 40));
      }
      await new Promise((r) => setTimeout(r, 800));
      return { before, after: psr.viewer.scale };
    });
    check('pinch (ctrl+wheel) zooms by re-rendering',
      pinch.after > pinch.before * 1.5, JSON.stringify(pinch));
    await retina.waitForSelector('.page canvas', { timeout: 10000 });
    await retina.waitForTimeout(600);
    sh = await sharpness();
    check('canvas is sharp after pinch zoom', sh.ratio >= 1.9, JSON.stringify(sh));
    await retina.close();
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

interface PsrFormatHooks extends PsrHooks {
  progressText(): string;
  parseProgressText(t: string): {
    state: { hist: { stacks: Array<{ name: string; entries: Array<{ label: string }> }> } };
  } | null;
}

// Shape of the window.__psr test hooks (see core/controller.ts).
interface PsrHooks {
  hist: {
    active: { name: string; index: number; entries: Array<{ label: string; pos: { page: number; yRatio: number } }> };
    stacks: Array<{ id: number; name: string; index: number; entries: Array<{ label: string }> }>;
    jumpTo(i: number): unknown;
    closeStack(id: number): boolean;
    canRedo(): boolean;
    renameStack(id: number, name: string): void;
    renameEntry(i: number, label: string): void;
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
