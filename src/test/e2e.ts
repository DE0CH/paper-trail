// Headless end-to-end tests for Paper Trail.
//
// Runs against a *separate* headless Chromium-family browser (Edge or
// Chrome binary on this machine) with its own profile, so it never
// interferes with the user's browsing session.
//
// Prereq: the app must be built (npm run build) and the server running
// (npm start). Usage: node build-node/test/e2e.js [baseUrl]

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const LINK_SEL = '.page[data-page="1"] .annotLayer .pdfLink:not(.external)';

async function run(): Promise<void> {
  const executablePath = findBrowser();

  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => check('no page errors', false, String(e)));
    // Accept beforeunload prompts so test navigations never race the
    // dirty flag (the dirty/beforeunload logic has its own checks).
    page.on('dialog', (d) => void d.accept());

    // fresh state
    await page.goto(BASE + '/');
    await page.evaluate(() => {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('pt:'))
        .forEach((k) => localStorage.removeItem(k));
      indexedDB.deleteDatabase('paper-trail');
    });

    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector(LINK_SEL, { timeout: 20000 });
    check('PDF loads and page 1 links render', true);

    // --- link click pushes a labelled entry ---
    await page.locator(LINK_SEL).nth(3).click();
    await page.waitForTimeout(600);
    const st1 = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      return {
        entries: pt.hist.active.entries.map((e) => e.label),
        index: pt.hist.active.index,
        page: pt.viewer.currentPosition().page,
      };
    });
    check('link click pushes entry', st1.entries.length === 2 && st1.index === 1,
      JSON.stringify(st1.entries));
    check('entry label extracted', /Definition 4\.1/.test(st1.entries[1]), st1.entries[1]);
    check('jumped to destination page', st1.page === 22, `page ${st1.page}`);

    // --- back restores exact position, preserves forward tail ---
    const posBefore = await page.evaluate(() =>
      (window as never as { __pt: PtHooks }).__pt.hist.active.entries[0].pos);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);
    const st2 = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      return {
        index: pt.hist.active.index,
        n: pt.hist.active.entries.length,
        pos: pt.viewer.currentPosition(),
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
      (window as never as { __pt: PtHooks }).__pt.hist.active.index);
    check('forward descends again', idx === 1);

    // --- cmd+click forks the whole history into a new stack ---
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);
    await page.waitForSelector(LINK_SEL, { timeout: 10000 });
    await page.locator(LINK_SEL).nth(0).click({ modifiers: ['Meta'] });
    await page.waitForTimeout(600);
    const st3 = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      return {
        stacks: pt.hist.stacks.map((s) => ({ name: s.name, n: s.entries.length, idx: s.index })),
        active: pt.hist.active.name,
        entries: pt.hist.active.entries.map((e) => e.label),
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
      const pt = (window as never as { __pt: PtHooks }).__pt;
      pt.hist.jumpTo(0);
      pt.viewer.scrollTo({ page: 1, yRatio: 0 });
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
      (window as never as { __pt: PtHooks }).__pt.hist.active.entries[0].label);
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
      const h = (window as never as { __pt: PtHooks }).__pt.hist.active;
      return { index: h.index };
    });
    await page.locator('#thumbList .thumb').nth(2).click();
    await page.waitForTimeout(400);
    const afterThumb = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      return {
        page: pt.viewer.currentPosition().page,
        n: pt.hist.active.entries.length,
        label: pt.hist.active.entries[pt.hist.active.index].label,
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
      (window as never as { __pt: PtHooks }).__pt.viewer.scrollTo({ page: 1, yRatio: 0 });
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
      const pt = (window as never as { __pt: PtFormatHooks }).__pt;
      const activeId = pt.hist.stacks.find((s) => s.name === pt.hist.active.name);
      void activeId;
      // rename the ACTIVE stack and its first entry
      const active = pt.hist.stacks.find((s) => s.entries === pt.hist.active.entries)!;
      pt.hist.renameStack(active.id, w);
      pt.hist.renameEntry(0, w + ' as a label\nwith newline');
    }, weird);
    await page.waitForTimeout(300); // let React render
    const weirdRes = await page.evaluate((w) => {
      const pt = (window as never as { __pt: PtFormatHooks }).__pt;
      const parsed = pt.parseProgressText(pt.progressText());
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
      const pt = (window as never as { __pt: PtUndoHooks }).__pt;
      const out: Record<string, unknown> = {};
      // Overwrite scenario: mid-stack, jump somewhere -> tail overwritten.
      pt.hist.jumpTo(0);
      const tailBefore = pt.hist.active.entries.map((e) => e.label);
      pt.jumpVia({ page: 5, yRatio: 0 }, 'overwriter');
      out.afterOverwrite = pt.hist.active.entries.map((e) => e.label);
      pt.controller.undoHist();
      out.afterUndo = pt.hist.active.entries.map((e) => e.label);
      out.tailRestored =
        JSON.stringify(out.afterUndo) === JSON.stringify(tailBefore);
      pt.controller.redoHist();
      out.afterRedo = pt.hist.active.entries.map((e) => e.label);
      // Close-stack scenario + redo cleared by a new action.
      const stackCount = pt.hist.stacks.length;
      pt.hist.closeStack(pt.hist.stacks[pt.hist.stacks.length - 1].id);
      out.closed = pt.hist.stacks.length === stackCount - 1;
      pt.controller.undoHist();
      out.closeUndone = pt.hist.stacks.length === stackCount;
      out.canRedoBefore = pt.hist.canRedo();
      pt.jumpVia({ page: 2, yRatio: 0 }, 'redo-killer');
      out.redoClearedByNewAction = !pt.hist.canRedo();
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

    // --- undo depth is capped at 50; the oldest snapshot is dropped ---
    const capProbe = await page.evaluate(() => {
      const pt = (window as never as {
        __pt: PtUndoHooks & { controller: { clearHistory(): void } };
      }).__pt;
      pt.controller.clearHistory(); // fresh single-entry stack (undoable itself)
      const base = pt.hist.active.entries.length; // 1 ("Start")
      for (let i = 0; i < 55; i++) {
        pt.jumpVia({ page: 1 + (i % 5), yRatio: 0 }, `fill ${i}`);
      }
      let undos = 0;
      while (undos < 200) {
        pt.controller.undoHist();
        undos++;
        if (!(pt.hist as never as { canUndo(): boolean }).canUndo()) break;
      }
      const res = { base, undos, len: pt.hist.active.entries.length };
      // restore a two-stack state for the checks further down
      (pt.jumpVia as (p: unknown, l: string, f?: boolean) => void)(
        { page: 2, yRatio: 0 }, 'branch', true,
      );
      return res;
    });
    // 55 pushes recorded 55 snapshots; the cap keeps the latest 50, so undo
    // can rewind to the state after the 5th push (1 + 5 entries).
    check('undo cap drops the oldest snapshots (50 deep)',
      capProbe.undos === 50 && capProbe.len === capProbe.base + 5,
      JSON.stringify(capProbe));

    // --- save button: fixed width, dot indicator for unsaved changes ---
    await page.waitForTimeout(900); // let pending scroll-settle timers fire
    await page.evaluate(() => {
      const pt = (window as never as {
        __pt: PtHooks & { controller: { dismissMismatch(): void } };
      }).__pt;
      pt.session.dirty = false;
      pt.controller.dismissMismatch(); // also forces a re-render
    });
    await page.waitForTimeout(150);
    const wClean = (await page.locator('#btnSave').boundingBox())!.width;
    const dotClean = await page.locator('#saveDirtyDot').count();
    await page.evaluate(() => {
      (window as never as { __pt: PtHooks }).__pt
        .jumpVia({ page: 4, yRatio: 0 }, 'dirty probe');
    });
    await page.waitForTimeout(250);
    const wDirty = (await page.locator('#btnSave').boundingBox())!.width;
    const dotDirty = await page.locator('#saveDirtyDot').count();
    check('unsaved-changes dot appears without shifting the toolbar',
      dotClean === 0 && dotDirty === 1 && Math.abs(wClean - wDirty) < 0.5,
      JSON.stringify({ wClean, wDirty, dotClean, dotDirty }));

    // --- progress session: dirty flag + fake-handle save ---
    const st4 = await page.evaluate(async () => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      const out: {
        dirtyAfterJump: boolean | null;
        dirtyAfterSave: boolean | null;
        savedJson: { type: string; name: string; size: number; stacks: number } | null;
      } = { dirtyAfterJump: null, dirtyAfterSave: null, savedJson: null };
      pt.jumpVia({ page: 3, yRatio: 0 }, 'probe');
      await new Promise((r) => setTimeout(r, 100));
      out.dirtyAfterJump = pt.session.dirty;
      let captured = '';
      pt.session.handle = {
        name: 't.ptl',
        createWritable: async () => {
          let data = '';
          return {
            write: async (d: string) => { data = d; },
            close: async () => { captured = data; },
          };
        },
      } as never;
      await pt.writeProgress();
      out.dirtyAfterSave = pt.session.dirty;
      const lines = captured.split('\n');
      const get = (k: string) =>
        (lines.find((l) => l.startsWith(k + ' ')) ?? '').slice(k.length + 1);
      out.savedJson = {
        type: lines[0],
        name: get('pdf.name'),
        size: parseInt(get('pdf.size'), 10),
        stacks: lines.filter((l) => l.startsWith('stack ')).length,
      };
      pt.session.handle = null;
      pt.session.dirty = false;
      return out;
    });
    check('jump marks session dirty', st4.dirtyAfterJump === true);

    // --- auto-save never triggers a permission prompt: without silent
    // write permission the timer skips (stays dirty); with it, it saves ---
    const autoSave = await page.evaluate(async () => {
      const pt = (window as never as { __pt: PtHooks & { jumpVia(p: unknown, l: string): void } }).__pt;
      let writes = 0;
      let permission = 'prompt';
      pt.session.handle = {
        name: 'perm.ptl',
        queryPermission: async () => permission,
        createWritable: async () => ({ write: async () => { writes++; }, close: async () => {} }),
      } as never;
      pt.jumpVia({ page: 2, yRatio: 0 }, 'auto probe 1');
      await new Promise((r) => setTimeout(r, 2200)); // past the 1.5s debounce
      const skipped = { writes, dirty: pt.session.dirty };
      permission = 'granted';
      pt.jumpVia({ page: 3, yRatio: 0 }, 'auto probe 2');
      await new Promise((r) => setTimeout(r, 2200));
      const saved = { writes, dirty: pt.session.dirty };
      pt.session.handle = null;
      pt.session.dirty = false;
      return { skipped, saved };
    });
    check('auto-save skips (stays dirty) when a prompt would be needed',
      autoSave.skipped.writes === 0 && autoSave.skipped.dirty === true,
      JSON.stringify(autoSave.skipped));
    check('auto-save writes silently once permission is granted',
      autoSave.saved.writes >= 1 && autoSave.saved.dirty === false,
      JSON.stringify(autoSave.saved));
    check('save writes line-oriented progress file and clears dirty',
      st4.dirtyAfterSave === false
        && st4.savedJson!.type === 'paper-trail-session v1'
        && st4.savedJson!.size > 10000
        && st4.savedJson!.stacks === 2,
      JSON.stringify(st4.savedJson));
    const noIds = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtFormatHooks }).__pt;
      const text = pt.progressText();
      return {
        stackLinesPlainNames: text.split('\n')
          .filter((l) => l.startsWith('stack '))
          .every((l) => !/^stack \d+ /.test(l)),
        activeLine: text.split('\n').find((l) => l.startsWith('active ')),
      };
    });
    check('save format has no internal stack ids',
      noIds.stackLinesPlainNames && /^active \d+$/.test(noIds.activeLine ?? ''),
      JSON.stringify(noIds));

    // --- progress file round trip over HTTP (?file=…pt.json) ---
    await page.evaluate(() => {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('pt:doc:'))
        .forEach((k) => localStorage.removeItem(k));
      (window as never as { __pt: PtHooks }).__pt.session.dirty = false;
    });
    await page.goto(BASE + '/?file=sample/WStarCats.ptl');
    await page.waitForSelector('.page canvas', { timeout: 20000 });
    await page.waitForTimeout(800);
    const st5 = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      return {
        stack: pt.hist.active.name,
        labels: pt.hist.active.entries.map((e) => e.label),
        pos: pt.viewer.currentPosition(),
        bound: !!pt.session.handle,
      };
    });
    check('progress file restores stack and position',
      st5.stack === 'RoundTrip' && st5.pos.page === 17 && !st5.bound, JSON.stringify(st5));
    await page.evaluate(() => {
      (window as never as { __pt: PtHooks }).__pt.session.dirty = false;
    });

    // --- cross-directory round trip: relPath ../WStarCats.pdf resolves
    // relative to the progress file's own location ---
    await page.goto(BASE + '/?file=sample/sub/WStarCats-sub.ptl');
    await page.waitForSelector('.page canvas', { timeout: 20000 });
    await page.waitForTimeout(600);
    const sub = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      return {
        stacks: pt.hist.stacks.map((s) => s.name),
        active: pt.hist.active.name,
        page: pt.viewer.currentPosition().page,
      };
    });
    check('cross-directory relPath resolves against the progress file',
      sub.active === 'SubDir' && sub.page === 9
        && sub.stacks.join('|') === 'Main line|SubDir',
      JSON.stringify(sub));
    await page.evaluate(() => {
      (window as never as { __pt: PtHooks }).__pt.session.dirty = false;
    });

    // --- corrupt progress file degrades to a clear error ---
    await page.goto(BASE + '/?file=sample/corrupt.ptl');
    await page.waitForSelector('#toast', { timeout: 10000 });
    const corruptToast = await page.evaluate(() =>
      document.getElementById('toast')?.textContent ?? '');
    check('corrupt progress file shows a clear error',
      /not a progress file|Could not load/i.test(corruptToast), corruptToast);

    // --- missing PDF: session is kept pending; opening the PDF manually
    // restores it ---
    await page.goto(BASE + '/?file=sample/sub/missing-pdf.ptl');
    await page.waitForSelector('#toast', { timeout: 10000 });
    const missToast = await page.evaluate(() =>
      document.getElementById('toast')?.textContent ?? '');
    check('missing PDF asks the user for it',
      /open the PDF manually/i.test(missToast), missToast);
    // The sidebar previews the loaded session while waiting for the PDF,
    // and clicking around must be inert (no anchor corruption).
    const preview = await page.evaluate(() => {
      const pt = (window as never as {
        __pt: PtHooks & { controller: { histEntryClick(i: number): void } };
      }).__pt;
      const stackNames = [...document.querySelectorAll('#stacksPanel .stackRow .name')]
        .map((el) => el.textContent);
      const entryLabels = [...document.querySelectorAll('#historyPanel .histItem .lbl')]
        .map((el) => el.textContent);
      const before = JSON.stringify(pt.hist.active.entries.map((e) => e.pos));
      pt.controller.histEntryClick(0); // must be a no-op without a PDF
      const after = JSON.stringify(pt.hist.active.entries.map((e) => e.pos));
      return { stackNames, entryLabels, inert: before === after };
    });
    check('pending session previews its trails in the sidebar',
      preview.stackNames.includes('Recovered session')
        && preview.entryLabels.includes('Lemma recovery-marker'),
      JSON.stringify(preview));
    check('preview clicks are inert and do not corrupt anchors', preview.inert);
    await page.evaluate(async () => {
      const pt = (window as never as {
        __pt: { controller: { openFile(f: File): Promise<void> } };
      }).__pt;
      const bytes = await (await fetch('/sample/WStarCats.pdf')).arrayBuffer();
      await pt.controller.openFile(new File([bytes], 'WStarCats.pdf'));
    });
    await page.waitForSelector('.page canvas', { timeout: 20000 });
    await page.waitForTimeout(600);
    const recovered = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      return {
        stack: pt.hist.active.name,
        label: pt.hist.active.entries[pt.hist.active.index]?.label,
        page: pt.viewer.currentPosition().page,
      };
    });
    check('manually opening the PDF restores the pending session',
      recovered.stack === 'Recovered session'
        && recovered.label === 'Lemma recovery-marker'
        && recovered.page === 12,
      JSON.stringify(recovered));
    await page.evaluate(() => {
      (window as never as { __pt: PtHooks }).__pt.session.dirty = false;
    });

    // --- mismatching PDF: banner + adopt + out-of-range positions clamp ---
    await page.goto(BASE + '/?file=sample/sub/mismatch.ptl');
    await page.waitForSelector('.page canvas', { timeout: 20000 });
    await page.waitForSelector('#mismatchBanner', { timeout: 5000 });
    const mm = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      return {
        page: pt.viewer.currentPosition().page,
        bannerText: document.getElementById('mismatchBanner')?.textContent ?? '',
      };
    });
    check('mismatch banner names both PDFs',
      /SomeOtherPaper\.pdf/.test(mm.bannerText) && /WStarCats\.pdf/.test(mm.bannerText),
      mm.bannerText.slice(0, 90));
    check('out-of-range saved position clamps to the top', mm.page === 1, `page ${mm.page}`);
    await page.click('#btnMismatchDismiss');
    check('mismatch banner can be dismissed',
      (await page.locator('#mismatchBanner').count()) === 0);
    // reload -> banner reappears (dismiss is once per occurrence); adopt fixes it
    await page.evaluate(() => {
      (window as never as { __pt: PtHooks }).__pt.session.dirty = false;
    });
    await page.goto(BASE + '/?file=sample/sub/mismatch.ptl');
    await page.waitForSelector('#mismatchBanner', { timeout: 20000 });
    await page.click('#btnAdoptPdf');
    const adopted = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtFormatHooks }).__pt;
      const text = pt.progressText();
      return {
        bannerGone: !document.getElementById('mismatchBanner'),
        nameLine: text.split('\n').find((l) => l.startsWith('pdf.name ')),
        fpIsReal: !/deadbeef/.test(text),
      };
    });
    check('"Use this PDF" adopts the open PDF into the session',
      adopted.bannerGone && adopted.nameLine === 'pdf.name WStarCats.pdf' && adopted.fpIsReal,
      JSON.stringify(adopted));

    // --- loading a session into an already open PDF asks for confirmation ---
    await page.evaluate(() => {
      (window as never as { __pt: PtHooks }).__pt.session.dirty = false;
    });
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector(LINK_SEL, { timeout: 20000 });
    await page.evaluate(async () => {
      const pt = (window as never as {
        __pt: PtHooks & { controller: { openFile(f: File): Promise<void> } };
      }).__pt;
      pt.jumpVia({ page: 3, yRatio: 0 }, 'existing history');
      const text = await (await fetch('/sample/WStarCats.ptl')).text();
      await pt.controller.openFile(new File([text], 'WStarCats.ptl'));
    });
    await page.waitForSelector('#sessionConfirm', { timeout: 5000 });
    check('loading a session over existing history asks first', true);
    await page.click('#btnSessionCancel');
    const cancelled = await page.evaluate(() =>
      (window as never as { __pt: PtHooks }).__pt.hist.active.entries.at(-1)?.label);
    check('cancel keeps the current history', cancelled === 'existing history', String(cancelled));
    await page.evaluate(async () => {
      const pt = (window as never as {
        __pt: PtHooks & { controller: { openFile(f: File): Promise<void> } };
      }).__pt;
      const text = await (await fetch('/sample/WStarCats.ptl')).text();
      await pt.controller.openFile(new File([text], 'WStarCats.ptl'));
    });
    await page.waitForSelector('#sessionConfirm', { timeout: 5000 });
    await page.click('#btnSessionReplace');
    await page.waitForTimeout(400);
    const replaced = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      return { stack: pt.hist.active.name, page: pt.viewer.currentPosition().page };
    });
    check('replace applies the loaded session',
      replaced.stack === 'RoundTrip' && replaced.page === 17, JSON.stringify(replaced));

    // --- re-anchor an entry to the current position ---
    await page.evaluate(() => {
      (window as never as { __pt: PtHooks }).__pt.viewer.scrollTo({ page: 5, yRatio: 0.3 });
    });
    await page.waitForTimeout(700);
    await page.locator('#historyPanel .histItem').first().hover();
    await page.locator('#historyPanel .histItem .setPos').first().click({ force: true });
    await page.waitForTimeout(200);
    const anchored = await page.evaluate(() =>
      (window as never as { __pt: PtHooks }).__pt.hist.active.entries[0].pos);
    check('entry can be re-anchored to the current position',
      anchored.page === 5 && Math.abs(anchored.yRatio - 0.3) < 0.02,
      JSON.stringify(anchored));

    // --- manually mark the current position onto the trail ---
    await page.evaluate(() => {
      (window as never as { __pt: PtHooks }).__pt.viewer.scrollTo({ page: 7, yRatio: 0.6 });
    });
    await page.waitForTimeout(700);
    const markBefore = await page.evaluate(() =>
      (window as never as { __pt: PtHooks }).__pt.hist.active.entries.length);
    await page.click('#viewerContainer'); // focus outside inputs
    await page.keyboard.press('m');
    await page.waitForTimeout(300);
    const marked = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      const cur = pt.hist.active.entries[pt.hist.active.index];
      return { n: pt.hist.active.entries.length, label: cur.label, pos: cur.pos };
    });
    check('"m" marks the current position as a trail entry',
      marked.label === 'Marked p.7' && marked.pos.page === 7
        && Math.abs(marked.pos.yRatio - 0.6) < 0.05,
      JSON.stringify({ markBefore, marked }));
    const stacksBeforeMarkFork = await page.evaluate(() =>
      (window as never as { __pt: PtHooks }).__pt.hist.stacks.length);
    await page.click('#btnMark', { modifiers: ['Meta'] });
    await page.waitForTimeout(300);
    const markFork = await page.evaluate(() => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      return { stacks: pt.hist.stacks.length };
    });
    check('cmd+click on + branches the mark into a new trail',
      markFork.stacks === stacksBeforeMarkFork + 1,
      JSON.stringify({ before: stacksBeforeMarkFork, after: markFork.stacks }));

    // --- scrolling must NOT move entry anchors (explicit actions only) ---
    const scrollProbe = await page.evaluate(async () => {
      const pt = (window as never as { __pt: PtHooks }).__pt;
      const before = JSON.stringify(pt.hist.active.entries.map((e) => e.pos));
      pt.viewer.scrollTo({ page: 20, yRatio: 0.5 });
      await new Promise((r) => setTimeout(r, 900)); // past the settle debounce
      const after = JSON.stringify(pt.hist.active.entries.map((e) => e.pos));
      return { same: before === after };
    });
    check('scrolling does not move history entry anchors', scrollProbe.same);

    // --- replace the PDF while keeping the reading state ---
    const rep = await page.evaluate(async () => {
      const pt = (window as never as {
        __pt: PtFormatHooks & {
          controller: { replaceWithFile(f: File): Promise<void> };
        };
      }).__pt;
      const before = pt.hist.active.entries.map((e) => e.label);
      const bytes = await (await fetch('/sample/WStarCats.pdf')).arrayBuffer();
      await pt.controller.replaceWithFile(new File([bytes], 'RevisedCopy.pdf'));
      await new Promise((r) => setTimeout(r, 800));
      return {
        before,
        after: pt.hist.active.entries.map((e) => e.label),
        nameLine: pt.progressText().split('\n').find((l) => l.startsWith('pdf.name ')),
        banner: !!document.getElementById('mismatchBanner'),
      };
    });
    check('replacing the PDF keeps the reading history',
      JSON.stringify(rep.before) === JSON.stringify(rep.after)
        && rep.nameLine === 'pdf.name RevisedCopy.pdf'
        && !rep.banner,
      JSON.stringify(rep));

    // --- replacing the PDF is undoable (and redoable) ---
    const repUndo = await page.evaluate(async () => {
      const pt = (window as never as {
        __pt: PtFormatHooks & {
          controller: { undoHist(): void; redoHist(): void };
          hist: { active: { entries: Array<{ label: string }> } };
        };
      }).__pt;
      const historyBefore = pt.hist.active.entries.map((e) => e.label);
      pt.controller.undoHist();
      await new Promise((r) => setTimeout(r, 1200));
      const afterUndo = {
        title: document.title,
        history: pt.hist.active.entries.map((e) => e.label),
      };
      pt.controller.redoHist();
      await new Promise((r) => setTimeout(r, 1200));
      const afterRedo = { title: document.title };
      return { historyBefore, afterUndo, afterRedo };
    });
    check('undo restores the previous PDF with history intact',
      repUndo.afterUndo.title.startsWith('WStarCats.pdf')
        && JSON.stringify(repUndo.afterUndo.history) === JSON.stringify(repUndo.historyBefore),
      JSON.stringify(repUndo.afterUndo));
    check('redo re-applies the replacement',
      repUndo.afterRedo.title.startsWith('RevisedCopy.pdf'),
      JSON.stringify(repUndo.afterRedo));
    await page.evaluate(() => {
      (window as never as { __pt: PtHooks }).__pt.session.dirty = false;
    });
    // --- rendering sharpness on a retina display (deviceScaleFactor 2) ---
    const retina = await browser.newPage({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 2,
    });
    await retina.goto(BASE + '/?file=sample/WStarCats.pdf');
    await retina.waitForSelector('.page[data-page="1"] canvas', { timeout: 20000 });
    const sharpness = async () => {
      // wait until a freshly rendered (non-placeholder) canvas exists —
      // stale canvases are intentionally kept stretched during re-renders
      await retina.waitForFunction(() =>
        [...document.querySelectorAll<HTMLCanvasElement>('.page canvas')].some(
          (c) => Math.abs(c.width / parseFloat(c.style.width) - window.devicePixelRatio) < 1e-9,
        ), undefined, { timeout: 15000 });
      return retina.evaluate(() => {
        const c = [...document.querySelectorAll<HTMLCanvasElement>('.page canvas')].find(
          (x) => Math.abs(x.width / parseFloat(x.style.width) - window.devicePixelRatio) < 1e-9,
        )!;
        const r = c.getBoundingClientRect();
        return {
          backing: c.width,
          css: r.width,
          ratio: c.width / r.width,
          // the bitmap must map exactly 1:1 onto device pixels
          exact: Math.abs(c.width / parseFloat(c.style.width) - window.devicePixelRatio) < 1e-9,
        };
      });
    };
    let sh = await sharpness();
    check('canvas renders at device resolution (fit zoom)', sh.ratio >= 1.9 && sh.exact,
      JSON.stringify(sh));
    await retina.evaluate(() => {
      (window as never as { __pt: { viewer: { setScale(s: number): void } } })
        .__pt.viewer.setScale(2.5);
    });
    await retina.waitForTimeout(1200);
    await retina.waitForSelector('.page[data-page="1"] canvas', { timeout: 10000 });
    sh = await sharpness();
    check('canvas stays at device resolution at high zoom', sh.ratio >= 1.9 && sh.exact,
      JSON.stringify(sh));

    // --- trackpad pinch (ctrl+wheel): smooth CSS feedback during the
    // gesture, crisp re-render on commit, never a blank page ---
    const pinch = await retina.evaluate(async () => {
      const pt = (window as never as {
        __pt: { viewer: { scale: number; setScale(s: number, o?: unknown): void } };
      }).__pt;
      pt.viewer.setScale(1.2);
      await new Promise((r) => setTimeout(r, 400));
      const before = pt.viewer.scale;
      const target = document.getElementById('viewerContainer')!;
      const viewerEl = document.getElementById('viewer')!;
      let liveTransform = '';
      for (let i = 0; i < 5; i++) {
        target.dispatchEvent(new WheelEvent('wheel', {
          ctrlKey: true, deltaY: -40, clientX: 700, clientY: 450,
          bubbles: true, cancelable: true,
        }));
        liveTransform = viewerEl.style.transform; // instant feedback?
        await new Promise((r) => setTimeout(r, 40));
      }
      const midGesture = /scale\(/.test(liveTransform);
      await new Promise((r) => setTimeout(r, 500)); // commit fires
      const committed = viewerEl.style.transform === '';
      // placeholder canvas must exist immediately after a scale change
      pt.viewer.setScale(pt.viewer.scale * 1.3);
      const placeholder = !!document.querySelector('.page[data-page="1"] canvas');
      await new Promise((r) => setTimeout(r, 800));
      return { before, after: pt.viewer.scale, midGesture, committed, placeholder };
    });
    check('pinch gives instant visual feedback and commits a re-render',
      pinch.after > pinch.before * 1.5 && pinch.midGesture && pinch.committed,
      JSON.stringify(pinch));
    check('scale changes keep a placeholder canvas (no blank flash)',
      pinch.placeholder === true);

    // --- releasing a pinch must not make the content jump (regression:
    // constant inter-page gaps + approximate anchor math caused an
    // ~800px jump deep in the document) ---
    const jump = await retina.evaluate(async () => {
      const pt = (window as never as {
        __pt: {
          viewer: {
            scale: number;
            setScale(s: number, o?: unknown): void;
            scrollTo(p: { page: number; yRatio: number }): void;
          };
        };
      }).__pt;
      pt.viewer.setScale(1.2);
      pt.viewer.scrollTo({ page: 20, yRatio: 0.4 });
      await new Promise((r) => setTimeout(r, 900));
      const target = document.getElementById('viewerContainer')!;
      const landmark = () =>
        document.querySelector('.page[data-page="20"]')!.getBoundingClientRect().top;
      for (let i = 0; i < 5; i++) {
        target.dispatchEvent(new WheelEvent('wheel', {
          ctrlKey: true, deltaY: -30, clientX: 700, clientY: 450,
          bubbles: true, cancelable: true,
        }));
        await new Promise((r) => setTimeout(r, 30));
      }
      const during = landmark();
      await new Promise((r) => setTimeout(r, 450)); // commit
      const after = landmark();
      return { delta: Math.abs(after - during) };
    });
    check('pinch release does not jump (deep in the document)',
      jump.delta < 4, `delta ${jump.delta.toFixed(1)}px`);
    await retina.waitForSelector('.page canvas', { timeout: 10000 });
    await retina.waitForTimeout(600);
    sh = await sharpness();
    check('canvas is sharp after pinch zoom', sh.ratio >= 1.9 && sh.exact, JSON.stringify(sh));
    await retina.close();
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

interface PtUndoHooks extends PtHooks {
  controller: { undoHist(): void; redoHist(): void };
}

interface PtFormatHooks extends PtHooks {
  progressText(): string;
  parseProgressText(t: string): {
    state: { hist: { stacks: Array<{ name: string; entries: Array<{ label: string }> }> } };
  } | null;
}

// Shape of the window.__pt test hooks (see core/controller.ts).
interface PtHooks {
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
