// Screenshot MATRIX for the one-container row-tools redesign (owner
// visual review). Boots the web app headless (the e2e idiom), builds
// each scenario through the __pt hooks, and captures tightly clipped
// shots of the Trails + History panels into matrix-shots/. Every shot
// is VERIFIED programmatically (visible-button count, equal gaps,
// ellipsis position, input reach) before it is taken — a failed check
// fails the run, so a wrong screenshot cannot ship silently.
// Run: node build-node/test/screenshotMatrix.js   (server on 8377 first)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { findBrowser } from './browsers';
import { chromium, type Browser, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const OUT = process.env.MATRIX_SHOTS_DIR ?? 'matrix-shots';

const LONG_TRAIL = 'Investigating the equivariant completeness argument in section four of the paper';
const LONG_ENTRY = 'A very long automatically extracted label that certainly overflows the row width';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function shoot(page: Page, name: string): Promise<void> {
  const box = await page.evaluate(() => {
    const a = document.getElementById('stacksCol')!.getBoundingClientRect();
    const b = document.getElementById('sideCol')!.getBoundingClientRect();
    const x = Math.max(0, Math.min(a.left, b.left) - 6);
    const y = Math.max(0, Math.min(a.top, b.top) - 6);
    return {
      x, y,
      width: Math.min(window.innerWidth, Math.max(a.right, b.right) + 6) - x,
      height: Math.min(window.innerHeight, Math.max(a.bottom, b.bottom) + 6) - y,
    };
  });
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: box });
  console.log(`shot  ${name}.png`);
}

interface BtnBox {
  sel: string; left: number; right: number; top: number; bottom: number;
  width: number; opacity: string; display: string;
}
interface RowProbe {
  buttons: BtnBox[]; // ALL .tools buttons, visible or not
  labelLeft: number; labelRight: number; rowLeft: number; rowRight: number;
  labelEllipsized: boolean; centerIsLabel: boolean;
}

async function probeRow(page: Page, rowSel: string): Promise<RowProbe> {
  return await page.evaluate((rowSel) => {
    const row = document.querySelector(rowSel) as HTMLElement;
    const label = row.querySelector('.name, .lbl') as HTMLElement;
    const rr = row.getBoundingClientRect();
    const lr = label.getBoundingClientRect();
    const at = document.elementFromPoint(lr.x + lr.width / 2, lr.y + lr.height / 2);
    return {
      buttons: ([...row.querySelectorAll('.tools > button')] as HTMLElement[]).map((b) => {
        const r = b.getBoundingClientRect();
        const st = getComputedStyle(b);
        return {
          sel: b.className.split(' ')[0],
          left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          width: r.width, opacity: st.opacity, display: st.display,
        };
      }),
      labelLeft: lr.left, labelRight: lr.right,
      rowLeft: rr.left, rowRight: rr.right,
      labelEllipsized: label.scrollWidth > label.clientWidth + 1,
      centerIsLabel: at === label || label.contains(at),
    };
  }, rowSel);
}

const shown = (b: BtnBox): boolean =>
  b.width > 0 && b.display !== 'none' && b.opacity !== '0';

function checkHoveredTools(kind: string, p: RowProbe): void {
  const vis = p.buttons.filter(shown).sort((a, b) => a.left - b.left);
  check(`${kind}: all 3 tools visible`, vis.length === 3,
    `[${vis.map((b) => b.sel).join(', ')}]`);
  const gaps: number[] = [];
  for (let i = 1; i < vis.length; i++) gaps.push(vis[i].left - vis[i - 1].right);
  const spread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 99;
  check(`${kind}: equal gaps (spread ${spread.toFixed(2)}px)`,
    gaps.length > 0 && spread <= 0.5 && gaps.every((g) => g >= 4),
    `gaps=[${gaps.map((g) => g.toFixed(1)).join(', ')}]`);
  check(`${kind}: label click center is the label`, p.centerIsLabel);
}

function checkIdleRow(kind: string, p: RowProbe, xShown: boolean): void {
  const hover = p.buttons.filter((b) => b.sel !== 'x' && b.sel !== 'rmEntry');
  check(`${kind}: hover-only tools take no space`, hover.every((b) => b.width === 0),
    hover.map((b) => `${b.sel}=${b.width}`).join(' '));
  const x = p.buttons.find((b) => b.sel === 'x' || b.sel === 'rmEntry');
  check(`${kind}: ✕ slot laid out`, !!x && x.width > 0);
  check(`${kind}: ✕ ${xShown ? 'visible' : 'invisible (slot held)'}`,
    !!x && (x.opacity !== '0') === xShown, `opacity=${x?.opacity}`);
}

async function boot(browser: Browser, scale: number): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 }, deviceScaleFactor: scale,
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  await page.goto(BASE + '/?file=sample/WStarCats.pdf');
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => !!(window as any).__pt?.controller?.getSnapshot().docOpen,
    undefined, { timeout: 20_000 });
  await page.waitForSelector('.stackRow .name', { timeout: 20_000 });
  await page.waitForSelector('.histItem .lbl', { timeout: 20_000 });
  return page;
}

const unhover = async (page: Page): Promise<void> => {
  await page.mouse.move(900, 500);
  await page.waitForTimeout(200);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pt = any;

async function main(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page = await boot(browser, 1);

    // ---- Phase A: fresh load — one trail, one history entry, short labels.
    await unhover(page);
    checkIdleRow('02 trail (current)', await probeRow(page, '.stackRow'), true);
    checkIdleRow('02 history (current, single entry)', await probeRow(page, '.histItem.current'), true);
    await shoot(page, '02-short-unhovered-current');

    await page.hover('.stackRow');
    checkHoveredTools('03 trail hovered', await probeRow(page, '.stackRow'));
    await shoot(page, '03-short-hovered-current-trail');

    // Single-entry history hovered: ✕ renders (inert) — three tools.
    await page.hover('.histItem.current');
    checkHoveredTools('12 single-entry history hovered', await probeRow(page, '.histItem.current'));
    await shoot(page, '12-single-entry-history-hovered-inert-x');
    await page.click('.histItem.current .rmEntry');
    await page.waitForTimeout(150);
    check('12: clicking the single-entry ✕ is a no-op',
      await page.evaluate(() => document.querySelectorAll('.histItem').length === 1));

    // ---- Phase B: long labels.
    await page.evaluate(({ t, e }) => {
      const pt = (window as never as { __pt: Pt }).__pt;
      pt.hist.renameStack(pt.hist.activeId, t);
      pt.controller.entryRename(0, e);
    }, { t: LONG_TRAIL, e: LONG_ENTRY });
    await page.waitForTimeout(200);
    await unhover(page);
    const p04 = await probeRow(page, '.stackRow');
    check('04: long trail label ellipsizes', p04.labelEllipsized);
    const x04 = p04.buttons.find((b) => b.sel === 'x')!;
    check(`04: ellipsis ends at the ✕ slot (gap ${(x04.left - p04.labelRight).toFixed(1)}px)`,
      x04.left - p04.labelRight >= 4 && x04.left - p04.labelRight <= 8);
    await shoot(page, '04-long-unhovered-current');

    await page.hover('.stackRow');
    const p05 = await probeRow(page, '.stackRow');
    checkHoveredTools('05 long trail hovered', p05);
    check(`05: label shrank to make room (Δ ${(p04.labelRight - p05.labelRight).toFixed(1)}px)`,
      p04.labelRight - p05.labelRight >= 40);
    await shoot(page, '05-long-hovered-trail');

    // ---- Phase C: multiple trails, mixed name lengths, current = last.
    await page.evaluate((long) => {
      const pt = (window as never as { __pt: Pt }).__pt;
      pt.jumpVia({ page: 2, yRatio: 0.1 }, 'Section two', true);
      pt.hist.renameStack(pt.hist.activeId, long + ' (branch B)');
      pt.jumpVia({ page: 3, yRatio: 0.2 }, 'Lemma 3.1', true);
      pt.jumpVia({ page: 4, yRatio: 0.3 }, 'Theorem 4.2', true);
    }, LONG_TRAIL);
    await page.waitForTimeout(200);
    await unhover(page);
    const idle06 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.stackRow')];
      return rows.map((r) => ({
        xOn: getComputedStyle(r.querySelector('.x')!).opacity !== '0',
        toolW: (r.querySelector('.editName') as HTMLElement).getBoundingClientRect().width,
      }));
    });
    check('06: four trails', idle06.length === 4, `${idle06.length}`);
    check('06: exactly one (the active) trail shows its ✕ unhovered',
      idle06.filter((r) => r.xOn).length === 1, JSON.stringify(idle06));
    check('06: no idle row leaks hover tools', idle06.every((r) => r.toolW === 0));
    await shoot(page, '06-multi-trails-unhovered');

    await page.hover('.stackRow'); // first row: long name, NON-current
    checkHoveredTools('07 long non-current trail hovered', await probeRow(page, '.stackRow'));
    check('07: hovered row is not the active one', await page.evaluate(() => {
      const pt = (window as never as { __pt: Pt }).__pt;
      const first = document.querySelector('.stackRow') as HTMLElement;
      return Number(first.dataset.id) !== pt.hist.activeId;
    }));
    await shoot(page, '07-multi-trails-hover-long-noncurrent');

    // ---- Phase D: history with many entries, current mid-list.
    await page.evaluate((long) => {
      const pt = (window as never as { __pt: Pt }).__pt;
      for (let i = 0; i < 8; i++) {
        const isLong = i % 2 === 1;
        pt.jumpVia({ page: 2 + i, yRatio: 0.1 * i },
          isLong ? `${long} #${i}` : `Note p. ${2 + i}`);
      }
    }, LONG_ENTRY);
    await page.waitForTimeout(200);
    const mid = await page.evaluate(() => {
      const pt = (window as never as { __pt: Pt }).__pt;
      const n = document.querySelectorAll('.histItem').length;
      const mid = Math.floor(n / 2);
      pt.controller.histEntryClick(mid);
      return { n, mid };
    });
    await page.waitForTimeout(300);
    await unhover(page);
    const idle08 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.histItem')];
      const cur = rows.findIndex((r) => r.classList.contains('current'));
      return {
        n: rows.length, cur,
        curRm: getComputedStyle(rows[cur].querySelector('.rmEntry')!).opacity !== '0',
        othersRm: rows.filter((_, i) => i !== cur)
          .every((r) => getComputedStyle(r.querySelector('.rmEntry')!).opacity === '0'),
      };
    });
    check(`08: many entries (${idle08.n}), current mid-list (idx ${idle08.cur})`,
      idle08.n >= 10 && idle08.cur === mid.mid);
    check('08: only the current entry shows its ✕ unhovered',
      idle08.curRm && idle08.othersRm);
    await shoot(page, '08-history-many-unhovered-current-midlist');

    // Hover a LONG-labeled non-current entry. Found by TEXT, not by a
    // hard-coded index: forks clone the source trail's entries, so the
    // list layout depends on the fork implementation, not this script.
    const longIdx = await page.evaluate((long) => {
      const rows = [...document.querySelectorAll('.histItem')] as HTMLElement[];
      const row = rows.find((r) => !r.classList.contains('current')
        && (r.querySelector('.lbl')?.textContent ?? '').startsWith(long.slice(0, 24)));
      return row ? Number(row.dataset.idx) : -1;
    }, LONG_ENTRY);
    check('09: found a long-labeled non-current entry', longIdx >= 0, `idx=${longIdx}`);
    await page.hover(`.histItem[data-idx="${longIdx}"]`);
    const p09 = await probeRow(page, `.histItem[data-idx="${longIdx}"]`);
    checkHoveredTools('09 long history entry hovered', p09);
    check('09: hovered entry is long (ellipsized even while hovered)', p09.labelEllipsized);
    await shoot(page, '09-history-hover-long-entry');

    // Hover the CURRENT mid-list entry: ✕ already visible + tools join.
    await page.hover('.histItem.current');
    checkHoveredTools('13 current history entry hovered', await probeRow(page, '.histItem.current'));
    await shoot(page, '13-history-hover-current-midlist');

    // ---- Phase E: edit mode on a long-labeled entry.
    await page.dblclick(`.histItem[data-idx="${longIdx}"] .lbl`);
    await page.waitForSelector(`.histItem[data-idx="${longIdx}"] input.rename`, { timeout: 5_000 });
    const edit = await page.evaluate((idx) => {
      const row = document.querySelector(`.histItem[data-idx="${idx}"]`) as HTMLElement;
      const inp = row.querySelector('input.rename') as HTMLElement;
      const rr = row.getBoundingClientRect();
      const padR = parseFloat(getComputedStyle(row).paddingRight) || 0;
      return {
        short: rr.right - padR - inp.getBoundingClientRect().right,
        tools: row.querySelectorAll('.tools > button').length,
      };
    }, longIdx);
    check(`10: rename input reaches the row edge (short by ${edit.short.toFixed(1)}px)`,
      edit.short <= 1);
    check('10: zero tool buttons mounted in edit mode', edit.tools === 0);
    await shoot(page, '10-edit-mode-long-entry');
    await page.keyboard.press('Escape');
    await page.waitForSelector(`.histItem[data-idx="${longIdx}"] input.rename`,
      { state: 'detached', timeout: 5_000 });

    // ---- Phase F: narrow Trails panel (moderate), long label hovered.
    // Three w-5 buttons + two 6px gaps need 72px; at ~110px panel width
    // they fit and the label keeps a clickable sliver.
    const drag = async (dx: number): Promise<void> => {
      const h = (await page.locator('#resizeStacks').boundingBox())!;
      await page.mouse.move(h.x + h.width / 2, h.y + 300);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 + dx, h.y + 300, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);
    };
    const width = () => page.evaluate(() =>
      document.getElementById('stacksCol')!.getBoundingClientRect().width);
    const before = await width();
    await drag(-40);
    const after = await width();
    check(`11: panel narrowed (${before.toFixed(0)} → ${after.toFixed(0)}px)`,
      before - after >= 30);
    await page.hover('.stackRow');
    const p11 = await probeRow(page, '.stackRow');
    checkHoveredTools('11 narrow panel, long label hovered', p11);
    check('11: tools stay inside the row', p11.buttons.filter(shown)
      .every((b) => b.right <= p11.rowRight + 0.5));
    await shoot(page, '11-narrow-panel-long-hovered');
    await unhover(page);

    // 14 — EXTREME narrowness (the panel's drag minimum): the 72px tool
    // block no longer fits the row's content width, so the hovered tools
    // OVERFLOW the row and the label collapses. Captured deliberately as
    // a design edge for the owner to rule on (not asserted as good).
    await drag(-200); // slam into the panel's minimum width
    const minW = await width();
    await page.hover('.stackRow');
    const p14 = await probeRow(page, '.stackRow');
    const vis14 = p14.buttons.filter(shown);
    check(`14: at the ${minW.toFixed(0)}px minimum all 3 tools still render`,
      vis14.length === 3);
    const overflow = Math.max(...vis14.map((b) => b.right)) - p14.rowRight;
    console.log(`14: documented edge — tools overflow the row by ${overflow.toFixed(1)}px `
      + `at the ${minW.toFixed(0)}px panel minimum (owner decision pending)`);
    await shoot(page, '14-min-width-panel-hovered-tools-overflow-edge');
    await unhover(page);
    await drag(before - minW); // restore for the final wide shot

    // 01 — short-label unhovered NON-current rows (trails have a short
    // non-current row, history has short non-current entries).
    checkIdleRow('01 trail (non-current, short "Lemma 3.1" row)',
      await probeRow(page, '.stackRow[data-id="3"]'), false);
    checkIdleRow('01 history (non-current short entry)',
      await probeRow(page, '.histItem[data-idx="2"]'), false);
    await shoot(page, '01-short-unhovered-noncurrent-rows');

    await page.evaluate(() => {
      (window as never as { __pt: Pt }).__pt.session.dirty = false;
    });
    await page.context().close();

    // ---- Phase G: retina (deviceScaleFactor 2) re-verification of 03/05/09.
    const r = await boot(browser, 2);
    await r.hover('.stackRow');
    checkHoveredTools('03@2x trail hovered', await probeRow(r, '.stackRow'));
    await shoot(r, '03-retina-short-hovered-trail');
    await r.evaluate((t) => {
      const pt = (window as never as { __pt: Pt }).__pt;
      pt.hist.renameStack(pt.hist.activeId, t);
    }, LONG_TRAIL);
    await r.waitForTimeout(200);
    await r.hover('.stackRow');
    const r05 = await probeRow(r, '.stackRow');
    checkHoveredTools('05@2x long trail hovered', r05);
    check('05@2x: long label ellipsized', r05.labelEllipsized);
    await shoot(r, '05-retina-long-hovered-trail');
    await r.click('#btnMark');
    await r.waitForFunction(
      () => document.querySelectorAll('.histItem').length > 1,
      undefined, { timeout: 15_000 });
    await r.evaluate((e) => {
      (window as never as { __pt: Pt }).__pt.controller.entryRename(0, e);
    }, LONG_ENTRY);
    await r.waitForTimeout(200);
    await r.hover('.histItem[data-idx="0"]');
    const r09 = await probeRow(r, '.histItem[data-idx="0"]');
    checkHoveredTools('09@2x long history entry hovered', r09);
    check('09@2x: long label ellipsized', r09.labelEllipsized);
    await shoot(r, '09-retina-history-hover-long-entry');
    await r.evaluate(() => {
      (window as never as { __pt: Pt }).__pt.session.dirty = false;
    });
    await r.context().close();
  } finally {
    await browser.close();
  }
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
