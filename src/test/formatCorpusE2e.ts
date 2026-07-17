// Back-compat corpus, end to end: the OLDEST shipped session-file variant
// (v0.2.0-era `paper-trail-session v1` with the legacy pdf.relPath /
// pdf.fingerprint / pdf.size identity lines — src/test/fixtures/ptl/
// v1-earliest-legacy.ptl) must still open through the real UI flow:
// session file first -> pending preview state -> PDF second -> trails,
// cursor and position restored. The fixture's legacy identity lines point
// at a DIFFERENT file on purpose: only the visible pdf.name may decide the
// mismatch banner, so no banner may appear. Saving back must keep the file
// v1 with its recorded time untouched.
//
// Run: node build-node/test/formatCorpusE2e.js   (server on 8377 first)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

// build-node/test -> the committed corpus under src/test/fixtures/ptl.
const FIXTURE = path.resolve(
  __dirname, '..', '..', 'src', 'test', 'fixtures', 'ptl', 'v1-earliest-legacy.ptl');

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function run(): Promise<void> {
  const fixtureText = fs.readFileSync(FIXTURE, 'utf8');
  const savedLine = fixtureText.split('\n').find((l) => l.startsWith('saved '));
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => check('no page errors', false, String(e)));
    page.on('dialog', (d) => void d.accept());

    // Fresh state, then hand the app the SESSION FILE FIRST, exactly as a
    // picker or drag-drop would.
    await page.goto(BASE + '/');
    await page.evaluate(() => {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('pt:'))
        .forEach((k) => localStorage.removeItem(k));
      indexedDB.deleteDatabase('paper-trail');
    });
    await page.evaluate(async (text) => {
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      await pt.controller.openFile(new File([text], 'v1-earliest-legacy.ptl'));
    }, fixtureText);

    // Pending state: the app must ask for the PDF, never fetch it itself,
    // and must already preview the session's trails in the sidebar.
    await page.waitForSelector('#sessionPrompt', { timeout: 20000 });
    const pending = await page.evaluate(() => ({
      docOpen: !!document.querySelector('.page canvas'),
      promptText: document.getElementById('sessionPrompt')?.textContent ?? '',
      stackNames: [...document.querySelectorAll('#stacksPanel .stackRow .name')]
        .map((el) => el.textContent),
      entryLabels: [...document.querySelectorAll('#historyPanel .histItem .lbl')]
        .map((el) => el.textContent),
    }));
    check('oldest v1 session enters the pending state (no PDF auto-load)',
      !pending.docOpen && /WStarCats\.pdf/.test(pending.promptText),
      JSON.stringify({ docOpen: pending.docOpen, prompt: pending.promptText.slice(0, 80) }));
    check('pending preview lists both trails from the 2026-07-10 file',
      pending.stackNames.includes('RoundTrip')
        && pending.stackNames.includes('Détour — §3 examples'),
      JSON.stringify(pending.stackNames));
    check('pending preview shows the active trail\'s entries',
      pending.entryLabels.includes('Corollary 3.12'),
      JSON.stringify(pending.entryLabels));

    // Second step: the PDF. Its name matches the fixture's pdf.name, while
    // the legacy fingerprint/size/relPath lines do not match anything.
    await page.evaluate(async () => {
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const bytes = await (await fetch('/sample/WStarCats.pdf')).arrayBuffer();
      await pt.controller.openFile(new File([bytes], 'WStarCats.pdf'));
    });
    await page.waitForSelector('.page canvas', { timeout: 20000 });
    await page.waitForTimeout(800); // restore + banner logic settle

    const restored = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      return {
        stacks: pt.hist.stacks.map(
          (s: { name: string; index: number; entries: unknown[] }) =>
            ({ name: s.name, n: s.entries.length, idx: s.index })),
        active: pt.hist.active.name,
        activeIdx: pt.hist.active.index,
        pos: pt.viewer.currentPosition(),
        banner: !!document.getElementById('mismatchBanner'),
        progressText: pt.progressText() as string,
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    check('both trails restore with their entry counts and cursors',
      restored.stacks.length === 2
        && restored.stacks[0].name === 'RoundTrip' && restored.stacks[0].n === 2
        && restored.stacks[0].idx === 1
        && restored.stacks[1].name === 'Détour — §3 examples' && restored.stacks[1].n === 3
        && restored.stacks[1].idx === 2,
      JSON.stringify(restored.stacks));
    check('the active trail is the second one, cursor on its last entry',
      restored.active === 'Détour — §3 examples' && restored.activeIdx === 2,
      JSON.stringify({ active: restored.active, idx: restored.activeIdx }));
    check('the saved reading position restores exactly',
      restored.pos.page === 17 && Math.abs(restored.pos.yRatio - 0.42021803766105054) < 0.02,
      JSON.stringify(restored.pos));
    check('legacy identity lines never trigger the mismatch banner (name matches)',
      !restored.banner);
    check('saving back keeps the file v1 with its recorded time untouched',
      restored.progressText.startsWith('paper-trail-session v1\n')
        && restored.progressText.split('\n')[1] === savedLine
        && !/pdf\.(relPath|fingerprint|size)/.test(restored.progressText),
      restored.progressText.split('\n').slice(0, 2).join(' | '));

    await page.evaluate(() => {
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      (window as any).__pt.session.dirty = false;
    });
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
