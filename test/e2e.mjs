// Headless end-to-end tests for PDF Stack Reader.
//
// Runs against a *separate* headless Chromium-family browser (Edge or
// Chrome binary on this machine) with its own profile, so it never
// interferes with the user's browsing session.
//
// Prereq: the app server must be running (node server.js 8377).
// Usage:   node test/e2e.mjs [baseUrl]

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8377';
const CANDIDATES = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const executablePath = CANDIDATES.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('No Chromium-family browser found');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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
  const linkSel = '.page[data-page="1"] .annotLayer .pdfLink:not(.external)';
  await page.waitForSelector(linkSel, { timeout: 20000 });
  check('PDF loads and page 1 links render', true);

  // --- link click pushes a labelled entry ---
  await page.locator(linkSel).nth(3).click();
  await page.waitForTimeout(600);
  let st = await page.evaluate(() => {
    const h = window.__psr.hist;
    return {
      entries: h.active.entries.map((e) => e.label),
      index: h.active.index,
      page: window.__psr.viewer.currentPosition().page,
    };
  });
  check('link click pushes entry', st.entries.length === 2 && st.index === 1,
    JSON.stringify(st.entries));
  check('entry label extracted', /Definition 4\.1/.test(st.entries[1]), st.entries[1]);
  check('jumped to destination page', st.page === 22, 'page ' + st.page);

  // --- back restores exact position, preserves forward tail ---
  const posBefore = await page.evaluate(() => window.__psr.hist.active.entries[0].pos);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);
  st = await page.evaluate(() => ({
    index: window.__psr.hist.active.index,
    n: window.__psr.hist.active.entries.length,
    pos: window.__psr.viewer.currentPosition(),
  }));
  check('back pops the cursor, stack preserved', st.index === 0 && st.n === 2);
  check('back restores exact position',
    st.pos.page === posBefore.page && Math.abs(st.pos.yRatio - posBefore.yRatio) < 0.01,
    JSON.stringify(st.pos));

  // --- forward ---
  await page.keyboard.press('Shift+Backspace');
  await page.waitForTimeout(400);
  st = await page.evaluate(() => window.__psr.hist.active.index);
  check('forward descends again', st === 1);

  // --- cmd+click forks the whole history into a new stack ---
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);
  await page.waitForSelector(linkSel, { timeout: 10000 });
  await page.locator(linkSel).nth(0).click({ modifiers: ['Meta'] });
  await page.waitForTimeout(600);
  st = await page.evaluate(() => {
    const h = window.__psr.hist;
    return {
      stacks: h.stacks.map((s) => ({ name: s.name, n: s.entries.length, idx: s.index })),
      active: h.active.name,
      entries: h.active.entries.map((e) => e.label),
    };
  });
  check('meta+click forks into a new stack',
    st.stacks.length === 2 && st.active === 'Untitled 2', JSON.stringify(st.stacks));
  check('fork copies history and pushes jump',
    st.entries.length === 2 && st.entries[0] === 'Start', JSON.stringify(st.entries));
  check('original stack untouched',
    st.stacks[0].n === 2 && st.stacks[0].idx === 0, JSON.stringify(st.stacks[0]));

  // --- stack panel UI ---
  const stackRows = await page.locator('#stacksPanel .stackRow').count();
  check('stacks panel lists stacks', stackRows === 2, String(stackRows));

  // --- hover preview ---
  await page.evaluate(() => window.__psr.hist.jumpTo(0));
  await page.evaluate(() => window.__psr.viewer.scrollTo({ page: 1, yRatio: 0 }));
  await page.waitForSelector(linkSel, { timeout: 10000 });
  await page.locator(linkSel).nth(3).hover();
  try {
    await page.waitForSelector('#preview:not(.hidden)', { timeout: 3000 });
    const pv = await page.evaluate(() => {
      const el = document.getElementById('preview');
      const c = el.querySelector('canvas');
      // count non-white pixels to prove something was drawn
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, Math.min(c.height, 200)).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 200) ink++;
      return { label: el.querySelector('.previewPage').textContent, ink };
    });
    check('hover preview appears with rendered content',
      pv.ink > 100 && /p\.\s*22/.test(pv.label), JSON.stringify(pv));
  } catch {
    check('hover preview appears with rendered content', false, 'never became visible');
  }
  await page.mouse.move(10, 500);
  await page.waitForTimeout(300);
  const previewHidden = await page.evaluate(() =>
    document.getElementById('preview').classList.contains('hidden'));
  check('preview hides on mouseleave', previewHidden);

  // --- search ---
  await page.fill('#searchInput', 'equivariant');
  await page.waitForFunction(
    () => document.getElementById('searchCount').textContent.includes('/ 4'),
    { timeout: 15000 },
  );
  let hlCount = 0;
  try {
    await page.waitForSelector('.searchHl', { timeout: 10000 });
    hlCount = await page.evaluate(() => document.querySelectorAll('.searchHl').length);
  } catch { /* hlCount stays 0 */ }
  check('search finds 4 matches with highlights', hlCount >= 1, 'highlights: ' + hlCount);

  // --- progress session: dirty flag + fake-handle save ---
  st = await page.evaluate(async () => {
    const P = window.__psr;
    const out = { dirtyAfterJump: null, savedJson: null, dirtyAfterSave: null };
    P.jumpVia({ page: 3, yRatio: 0 }, 'probe');
    await new Promise((r) => setTimeout(r, 100));
    out.dirtyAfterJump = P.session.dirty;
    let captured = null;
    P.session.handle = {
      name: 't.psr.json',
      async createWritable() {
        let data = null;
        return { async write(d) { data = d; }, async close() { captured = data; } };
      },
    };
    await P.writeProgress();
    out.dirtyAfterSave = P.session.dirty;
    const j = JSON.parse(captured);
    out.savedJson = { type: j.type, name: j.pdf.name, size: j.pdf.size, stacks: j.state.hist.stacks.length };
    P.session.handle = null;
    P.session.dirty = false;
    return out;
  });
  check('jump marks session dirty', st.dirtyAfterJump === true);
  check('save writes progress file and clears dirty',
    st.dirtyAfterSave === false
      && st.savedJson.type === 'pdf-stack-reader-progress'
      && st.savedJson.size > 100000
      && st.savedJson.stacks === 2,
    JSON.stringify(st.savedJson));

  // --- progress file round trip over HTTP (?file=…psr.json) ---
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('psr:doc:'))
      .forEach((k) => localStorage.removeItem(k));
    window.__psr.session.dirty = false;
  });
  await page.goto(BASE + '/?file=sample/WStarCats.psr.json');
  await page.waitForSelector('.page canvas', { timeout: 20000 });
  await page.waitForTimeout(800);
  st = await page.evaluate(() => ({
    stack: window.__psr.hist.active.name,
    labels: window.__psr.hist.active.entries.map((e) => e.label),
    pos: window.__psr.viewer.currentPosition(),
    bound: !!window.__psr.session.handle,
  }));
  check('progress file restores stack and position',
    st.stack === 'RoundTrip' && st.pos.page === 17 && !st.bound, JSON.stringify(st));
  await page.evaluate(() => { window.__psr.session.dirty = false; });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
