// An open history-entry rename must never land on a DIFFERENT entry.
// History rows are addressed by index, and native menu actions (History >
// Mark This Spot, Clear History) don't blur the rename input first: a
// structural change could move another entry under the editor's index, and
// Enter would commit the stale text onto it. The fix cancels an open
// editor on any structural history change; a rename with no such change
// still commits normally.
// Run: node build-node/test/histRenameTarget.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface PtWin {
  __pt: {
    hist: { active: { index: number; entries: { label: string }[] } };
    controller: { markPosition: (fork?: boolean) => void; clearHistory: () => void };
    goBack: () => void;
    session: { dirty: boolean };
  };
}

const labels = (page: Page) => page.evaluate(
  () => (window as never as PtWin).__pt.hist.active.entries.map((e) => e.label));

// Open the rename editor on the history row at the given index and type
// a replacement text (without committing it).
async function openRename(page: Page, idx: number, text: string): Promise<void> {
  await page.dblclick(`.histItem[data-idx="${idx}"] .lbl`);
  const input = page.locator('.histItem input.rename');
  await input.waitFor({ state: 'visible', timeout: 5_000 });
  await input.fill(text);
}

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.histItem .lbl', { timeout: 20_000 });
    // The history rows render before the PDF finishes opening, and the
    // controller's actions (entryRename, markPosition, clearHistory)
    // no-op until docOpen — the page input enabling is the direct
    // docOpen signal.
    await page.waitForSelector('#pageInput:not([disabled])', { timeout: 20_000 });

    // Sanity: an undisturbed rename still commits to its own entry.
    await openRename(page, 0, 'My Spot');
    await page.keyboard.press('Enter');
    await page.locator('.histItem input.rename').waitFor({ state: 'detached', timeout: 5_000 });
    check('a plain rename still commits to the edited entry',
      (await labels(page))[0] === 'My Spot', `labels=${JSON.stringify(await labels(page))}`);

    // Scenario 1 — menu-style Mark This Spot truncates the edited entry.
    // Two entries, cursor moved BACK to 0 (back/forward are cursor moves,
    // not structural — the editor must survive them), rename open on
    // entry 1. markPosition() truncates entry 1 and pushes a NEW entry at
    // index 1; committing now would rename the new entry.
    await page.click('#btnMark');
    await page.waitForFunction(
      () => document.querySelectorAll('.histItem').length === 2, undefined,
      { timeout: 5_000 });
    await openRename(page, 1, 'WRONG TARGET');
    await page.evaluate(() => (window as never as PtWin).__pt.goBack());
    check('a cursor move (back) does not cancel the open editor',
      await page.locator('.histItem input.rename').isVisible());
    await page.evaluate(() => (window as never as PtWin).__pt.controller.markPosition());
    check('a structural change cancels the open editor',
      await page.locator('.histItem input.rename').count() === 0);
    await page.keyboard.press('Enter');
    const after1 = await labels(page);
    check('the stale rename never lands on the entry now at that index',
      after1[1] !== 'WRONG TARGET', `labels=${JSON.stringify(after1)}`);

    // Scenario 2 — menu-style Clear History replaces everything; a rename
    // opened on the old entry 0 must not rename the fresh Start entry.
    await openRename(page, 0, 'STALE NAME');
    await page.evaluate(() => (window as never as PtWin).__pt.controller.clearHistory());
    await page.keyboard.press('Enter');
    const after2 = await labels(page);
    check('after Clear History the fresh entry keeps its own label',
      after2.length === 1 && after2[0] === 'Start', `labels=${JSON.stringify(after2)}`);

    // The scenarios dirtied the session; clear the flag so the harness
    // never sees an unsaved-changes prompt.
    await page.evaluate(() => {
      (window as never as PtWin).__pt.session.dirty = false;
    });

    // Scenario 3 — the placeholder rows are visible before a document
    // opens, and the no-jank suite opens renames in that window. The
    // history reset that fires when the document finishes opening is
    // NOT an editor-cancelling structural change: the editor must
    // survive the open (cancelling here made renameNoShift flaky on
    // slow runners).
    const page2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page2.on('dialog', (d) => void d.accept());
    await page2.goto(BASE + '/');
    await page2.dblclick('.histItem[data-idx="0"] .lbl');
    const preInput = page2.locator('.histItem input.rename');
    await preInput.waitFor({ state: 'visible', timeout: 5_000 });
    await preInput.fill('PREOPEN');
    await page2.evaluate(async () => {
      const res = await fetch('sample/WStarCats.pdf');
      const data = await res.arrayBuffer();
      await (window as never as {
        __pt: { controller: { openFile: (f: File, x: null, p: null) => Promise<void> } };
      }).__pt.controller.openFile(new File([data], 'WStarCats.pdf'), null, null);
    });
    await page2.waitForSelector('#pageInput:not([disabled])', { timeout: 20_000 });
    check('a rename opened before the document finished opening survives it',
      await preInput.isVisible());
    check('the surviving editor keeps its text',
      await preInput.inputValue().catch(() => '') === 'PREOPEN');
    await page2.keyboard.press('Escape');
    const preLabels = await labels(page2);
    check('escaping the surviving editor commits nothing',
      preLabels[0] === 'Start', `labels=${JSON.stringify(preLabels)}`);
    await page2.evaluate(() => {
      (window as never as PtWin).__pt.session.dirty = false;
    });
    await page2.close();
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
