// Trail and history rows, measured — never eyeballed:
//   - an unhovered row's text runs up to the close button's slot: the
//     slot itself stays reserved (alignment never shifts), but the
//     edit/duplicate tools must not reserve invisible space;
//   - hovering reveals those tools WITHOUT moving the text (overlay);
//   - a trail's close button shows only on hover or on the active
//     trail, never on idle rows;
//   - the Trails header "+" is centered on the trail close buttons,
//     and the History header trash on the history close buttons
//     (within 1px);
//   - the row close glyph is the same size as the one closing the
//     outline/pages panel.
// Run: node build-node/test/trailRowLayout.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('.page canvas', { timeout: 20_000 });

    // Long names so the ellipsis behavior is in play; a second trail
    // provides an INACTIVE row (its close button must stay hidden).
    await page.evaluate(() => {
      const pt = (window as never as {
        __pt: {
          hist: { activeId: number; renameStack(id: number, n: string): void };
          jumpVia(pos: { page: number; yRatio: number }, label: string, fork?: boolean): void;
          session: { dirty: boolean };
        };
      }).__pt;
      pt.hist.renameStack(pt.hist.activeId,
        'Investigating the equivariant completeness argument in section four');
      pt.jumpVia({ page: 3, yRatio: 0 },
        'A very long automatically extracted label that certainly overflows the row');
      pt.jumpVia({ page: 5, yRatio: 0 }, 'forked away', true); // second trail, now active
    });
    await page.waitForTimeout(400);

    // 1 — unhovered text reaches the close button (no reserved space).
    const unhovered = await page.evaluate(() => {
      const row = document.querySelector('.stackRow')!;
      const name = row.querySelector('.name')!.getBoundingClientRect();
      const x = row.querySelector('.x')!.getBoundingClientRect();
      return { nameRight: name.right, xLeft: x.left };
    });
    check('trail text uses the full width up to the close button',
      unhovered.xLeft - unhovered.nameRight <= 8,
      `gap ${(unhovered.xLeft - unhovered.nameRight).toFixed(1)}px`);

    // 2 — hovering reveals the tools without moving the text.
    await page.hover('.stackRow');
    await page.waitForTimeout(150);
    const hovered = await page.evaluate(() => {
      const row = document.querySelector('.stackRow')!;
      const name = row.querySelector('.name')!.getBoundingClientRect();
      const edit = row.querySelector('.editName');
      const visible = !!edit && getComputedStyle(edit).display !== 'none'
        && getComputedStyle(edit).opacity !== '0';
      return { nameRight: name.right, toolsVisible: visible };
    });
    check('hover reveals the row tools', hovered.toolsVisible);
    check('...without moving the text (no jank)',
      Math.abs(hovered.nameRight - unhovered.nameRight) <= 1,
      `moved ${(hovered.nameRight - unhovered.nameRight).toFixed(1)}px`);

    // 2b — the close button shows only on hover or on the active
    // trail; idle rows keep the slot but not the button.
    await page.mouse.move(700, 450); // leave the rows
    await page.waitForTimeout(200);
    const xVisibility = await page.evaluate(() => {
      const pt = (window as never as {
        __pt: { hist: { activeId: number } };
      }).__pt;
      return [...document.querySelectorAll('.stackRow')].map((row) => ({
        active: Number((row as HTMLElement).dataset.id) === pt.hist.activeId,
        xShown: getComputedStyle(row.querySelector('.x')!).opacity !== '0',
      }));
    });
    check('idle trails hide their close button',
      xVisibility.filter((r) => !r.active).every((r) => !r.xShown),
      JSON.stringify(xVisibility));
    check('the active trail shows its close button',
      xVisibility.some((r) => r.active && r.xShown), JSON.stringify(xVisibility));
    await page.hover('.stackRow');
    await page.waitForTimeout(150);
    check('hovering an idle trail reveals its close button',
      await page.evaluate(() =>
        getComputedStyle(document.querySelector('.stackRow .x')!).opacity !== '0'));
    await page.mouse.move(700, 450);
    await page.waitForTimeout(200);

    // 2c — the panels speak in one voice: same font, same size.
    const fonts = await page.evaluate(() => {
      const probe = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const s = getComputedStyle(el);
        return `${s.fontSize} ${s.fontFamily}`;
      };
      return {
        outline: probe('.outlineItem'),
        trail: probe('.stackRow .name'),
        hist: probe('.histItem .lbl'),
      };
    });
    check('outline, trail and history rows share one font and size',
      !!fonts.outline && fonts.outline === fonts.trail && fonts.trail === fonts.hist,
      JSON.stringify(fonts));

    // 2d — ...and one vertical rhythm: same row height, same step
    // between consecutive rows, in every list.
    const rhythm = await page.evaluate(() => {
      const steps = (sel: string) => {
        const rows = [...document.querySelectorAll(sel)]
          .map((el) => el.getBoundingClientRect());
        if (rows.length < 2) return null;
        return {
          height: Math.round(rows[0].height * 10) / 10,
          step: Math.round((rows[1].top - rows[0].top) * 10) / 10,
        };
      };
      return {
        outline: steps('.outlineItem'),
        hist: steps('.histItem'),
        trails: steps('.stackRow'),
      };
    });
    const rows = [rhythm.outline, rhythm.hist, rhythm.trails]
      .filter((r): r is { height: number; step: number } => r !== null);
    check('outline, trail and history lists share one vertical rhythm',
      rows.length === 3
        && rows.every((r) => Math.abs(r.height - rows[0].height) <= 1)
        && rows.every((r) => Math.abs(r.step - rows[0].step) <= 1),
      JSON.stringify(rhythm));

    // 3 — one alignment system: every header's rightmost button and
    // every row's rightmost button sit at the same distance from
    // their panel's right edge.
    const offsets = await page.evaluate(() => {
      const fromRight = (el: Element | null, panel: Element | null) => {
        if (!el || !panel) return null;
        const r = el.getBoundingClientRect();
        return panel.getBoundingClientRect().right - (r.left + r.width / 2);
      };
      const navCol = document.getElementById('navCol');
      const stacksCol = document.getElementById('stacksCol');
      const sideCol = document.getElementById('sideCol');
      return {
        navClose: fromRight(document.getElementById('btnNavClose'), navCol),
        trailsPlus: fromRight(document.getElementById('btnNewTrail'), stacksCol),
        historyTrash: fromRight(document.getElementById('btnClearHistory'), sideCol),
        trailX: fromRight(document.querySelector('.stackRow .x'), stacksCol),
        histX: fromRight(document.querySelector('.histItem .rmEntry'), sideCol),
      };
    });
    const values = Object.values(offsets).filter((v): v is number => v !== null);
    const spread = Math.max(...values) - Math.min(...values);
    check('all right-edge buttons share one alignment axis (headers and rows)',
      values.length === 5 && spread <= 1,
      `${JSON.stringify(offsets)} spread ${spread.toFixed(2)}px`);

    // 4 — the row close glyph matches the panel close glyph.
    const glyphs = await page.evaluate(() => {
      const size = (el: Element | null) =>
        el?.querySelector('svg')?.getBoundingClientRect().width ?? -1;
      return {
        row: size(document.querySelector('.stackRow .x')),
        panel: size(document.getElementById('btnNavClose')),
      };
    });
    check('the row close glyph is the same size as the panel close glyph',
      glyphs.row > 0 && glyphs.row === glyphs.panel,
      JSON.stringify(glyphs));

    await page.evaluate(() => {
      (window as never as { __pt: { session: { dirty: boolean } } })
        .__pt.session.dirty = false;
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
