// Edge cases of the web app beyond e2e.ts: boundary navigation
// (back at the start, forward at the end), forking straight from
// Start, hostile search queries, cancelling a session load, PDF
// drag-drop being a no-op while a document is open, undoing a fresh
// trail, and non-ASCII trail names reaching both the UI and the save
// format. Uses the same server and fixtures as e2e.ts.
//
// Run: node build-node/test/e2eEdges.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const LINK_SEL = '.page[data-page="1"] .annotLayer .pdfLink:not(.external)';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface PtHooks {
  hist: {
    active: {
      name: string; index: number;
      entries: Array<{ label: string; pos: { page: number; yRatio: number } }>;
    };
    stacks: Array<{ id: number; name: string; entries: Array<{ label: string }> }>;
    activeId: number;
    canBack(): boolean;
    canForward(): boolean;
    renameStack(id: number, name: string): void;
  };
  viewer: { currentPosition(): { page: number; yRatio: number } };
  session: { dirty: boolean };
  controller: {
    stackNew(): void;
    undoHist(): void;
    openFile(f: File): Promise<void>;
    runSearch(q: string, opts?: { jump?: boolean }): Promise<void>;
  };
  goBack(): void;
  goForward(): void;
  jumpVia(pos: { page: number; yRatio: number }, label: string, fork?: boolean): void;
  progressText(): string;
}
type W = { __pt: PtHooks };

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => check('no page errors', false, String(e)));
    page.on('dialog', (d) => void d.accept());

    await page.goto(BASE + '/');
    await page.evaluate(() => {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('pt:'))
        .forEach((k) => localStorage.removeItem(k));
      indexedDB.deleteDatabase('paper-trail');
    });
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector(LINK_SEL, { timeout: 20_000 });

    // Boundary navigation: back at Start and forward at the end are
    // refusals, not jumps or crashes.
    const bounds = await page.evaluate(() => {
      const p = (window as never as W).__pt;
      const before = {
        canBack: p.hist.canBack(),
        page: p.viewer.currentPosition().page,
        entries: p.hist.active.entries.length,
      };
      p.goBack();
      p.goForward(); // already at the end too
      return {
        before,
        after: {
          canBack: p.hist.canBack(),
          canForward: p.hist.canForward(),
          page: p.viewer.currentPosition().page,
          entries: p.hist.active.entries.length,
        },
      };
    });
    check('back at Start is a no-op', !bounds.before.canBack
      && bounds.after.entries === bounds.before.entries
      && bounds.after.page === bounds.before.page, JSON.stringify(bounds));
    check('forward at the end is a no-op', !bounds.after.canForward);

    // Forking straight from Start (cursor 0) starts a proper new trail.
    const fork = await page.evaluate(() => {
      const p = (window as never as W).__pt;
      p.jumpVia({ page: 5, yRatio: 0 }, 'forked-from-start', true);
      return {
        stacks: p.hist.stacks.length,
        labels: p.hist.active.entries.map((e) => e.label),
      };
    });
    check('forking from Start opens a second trail with Start + the jump',
      fork.stacks === 2 && fork.labels.length === 2
        && fork.labels[1] === 'forked-from-start', JSON.stringify(fork));

    // Hostile search queries: regex specials must not throw, and a
    // no-match query leaves zero highlights.
    await page.evaluate(async () => {
      await (window as never as W).__pt.controller.runSearch('(∀x. \\d+ [a-z', { jump: false });
    });
    const hostile = await page.locator('.searchHl').count();
    check('a regex-special query neither crashes nor matches', hostile === 0,
      `${hostile} highlights`);
    await page.evaluate(async () => {
      await (window as never as W).__pt.controller.runSearch('zzzyyyxxx-not-in-fixture', { jump: false });
    });
    check('a no-match query shows zero highlights',
      (await page.locator('.searchHl').count()) === 0);
    await page.evaluate(async () => {
      await (window as never as W).__pt.controller.runSearch('equivariant', { jump: false });
    });
    const found = await page.locator('.searchHl').count();
    check('search still works after the hostile queries', found > 0, `${found}`);
    await page.evaluate(async () => {
      await (window as never as W).__pt.controller.runSearch('', { jump: false });
    });
    check('an empty query clears the highlights',
      (await page.locator('.searchHl').count()) === 0);

    // Cancelling a session load leaves the document and history alone.
    const beforeCancel = await page.evaluate(() => {
      const p = (window as never as W).__pt;
      return {
        stacks: p.hist.stacks.length,
        entries: p.hist.active.entries.length,
        title: document.title,
      };
    });
    await page.evaluate(async () => {
      const r = await fetch('/sample/WStarCats.ptl');
      const f = new File([await r.blob()], 'WStarCats.ptl');
      void (window as never as W).__pt.controller.openFile(f);
    });
    await page.waitForSelector('#sessionConfirm', { timeout: 10_000 });
    await page.click('#btnSessionCancel');
    await page.waitForTimeout(400);
    const afterCancel = await page.evaluate(() => {
      const p = (window as never as W).__pt;
      return {
        stacks: p.hist.stacks.length,
        entries: p.hist.active.entries.length,
        title: document.title,
        confirmGone: !document.getElementById('sessionConfirm'),
      };
    });
    check('cancelling a session load changes nothing',
      afterCancel.confirmGone
        && afterCancel.stacks === beforeCancel.stacks
        && afterCancel.entries === beforeCancel.entries
        && afterCancel.title === beforeCancel.title,
      JSON.stringify({ beforeCancel, afterCancel }));

    // Dropping a PDF while a document is open is a deliberate no-op.
    const dropped = await page.evaluate(async () => {
      const p = (window as never as W).__pt;
      const before = { title: document.title, stacks: p.hist.stacks.length };
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
      const file = new File([bytes], 'dropped.pdf', { type: 'application/pdf' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.getElementById('viewerContainer') ?? document.body;
      target.dispatchEvent(new DragEvent('dragover',
        { dataTransfer: dt, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('drop',
        { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 600));
      return {
        before,
        after: { title: document.title, stacks: p.hist.stacks.length },
      };
    });
    check('dropping a PDF on an open document is a no-op',
      dropped.after.title === dropped.before.title
        && dropped.after.stacks === dropped.before.stacks,
      JSON.stringify(dropped));

    // A fresh trail is undoable.
    const undoTrail = await page.evaluate(() => {
      const p = (window as never as W).__pt;
      const before = p.hist.stacks.length;
      p.controller.stackNew();
      const during = p.hist.stacks.length;
      p.controller.undoHist();
      return { before, during, after: p.hist.stacks.length };
    });
    check('a new trail is undoable', undoTrail.during === undoTrail.before + 1
      && undoTrail.after === undoTrail.before, JSON.stringify(undoTrail));

    // Non-ASCII trail names reach the UI and the save format.
    const exotic = await page.evaluate(() => {
      const p = (window as never as W).__pt;
      p.hist.renameStack(p.hist.activeId, '读书 🎯 ملاحظات');
      return p.progressText();
    });
    await page.waitForTimeout(300);
    const shown = await page.locator('.stackRow .name').allTextContents();
    check('a CJK/emoji/RTL trail name shows in the panel',
      shown.some((s) => s.includes('读书 🎯 ملاحظات')), shown.join(' | '));
    check('...and lands verbatim in the session text',
      exotic.includes('stack 读书 🎯 ملاحظات'));

    await page.evaluate(() => {
      (window as never as W).__pt.session.dirty = false;
    });
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
