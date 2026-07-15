// Row-tools layout guard: all of a row's tool buttons (✎ / ⌖ or ⧉ / ✕)
// live in ONE flex container (`.tools`) with the row's standard 6px gap,
// so every inter-button gap is equal by construction — no absolute
// anchors, no overlay. The row may reflow on hover (owner decision): the
// hover-only tools join the flex flow and the label shrinks.
// Asserts, on a hovered trail row and a hovered removable history row:
//   (1) every gap between adjacent visible tool buttons is EQUAL (±0.5px)
//       and at least MIN_GAP wide,
//   (2) no tool button intersects another,
//   (3) the label's click center still belongs to the label — double-
//       click-to-rename keeps working (the df187c1 regression tripwire),
// and, without hover:
//   (4) the close/remove ✕ is visible on the CURRENT/active row only,
//       while the hover-only tools take no layout space on any row.
// Run: node build-node/test/hoverIconSpacing.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
// The container's flex gap is 6px (gap-1.5); anything under 4px means the
// buttons stopped sharing the one-container layout.
const MIN_GAP = 4;

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface Box { sel: string; left: number; right: number; top: number; bottom: number }

async function probeHovered(page: Page, kind: string, rowSel: string): Promise<void> {
  const row = page.locator(rowSel).first();
  await row.hover();
  const m = await page.evaluate((rowSel) => {
    const row = document.querySelector(rowSel) as HTMLElement;
    const label = row.querySelector('.name, .lbl') as HTMLElement | null;
    if (!label) return null;
    const buttons = ([...row.querySelectorAll('.tools > button')] as HTMLElement[])
      .map((b) => {
        const r = b.getBoundingClientRect();
        return {
          sel: b.className.split(' ')[0],
          left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          visible: r.width > 0 && getComputedStyle(b).display !== 'none',
        };
      })
      .filter((b) => b.visible)
      .sort((a, b) => a.left - b.left);
    // The label's click center must belong to the label, not any tool —
    // double-click-to-rename lands there (the df187c1 regression).
    const lr = label.getBoundingClientRect();
    const at = document.elementFromPoint(lr.x + lr.width / 2, lr.y + lr.height / 2);
    const centerIsLabel = at === label || label.contains(at);
    return { buttons, centerIsLabel };
  }, rowSel);
  if (!m) { check(`${kind}: probe found the row's label`, false, 'missing element'); return; }

  const expected = 3; // ✎ + (⌖ or ⧉) + ✕, all revealed by hover
  check(`${kind}: hover reveals all ${expected} tool buttons`,
    m.buttons.length === expected,
    `visible: [${m.buttons.map((b) => b.sel).join(', ')}]`);

  const gaps: number[] = [];
  for (let i = 1; i < m.buttons.length; i++) {
    gaps.push(m.buttons[i].left - m.buttons[i - 1].right);
  }
  const spread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 0;
  check(`${kind}: all inter-button gaps are equal (spread ${spread.toFixed(2)}px)`,
    gaps.length > 0 && spread <= 0.5, `gaps=[${gaps.map((g) => g.toFixed(1)).join(', ')}]`);
  check(`${kind}: every gap is at least ${MIN_GAP}px`,
    gaps.every((g) => g >= MIN_GAP), `gaps=[${gaps.map((g) => g.toFixed(1)).join(', ')}]`);

  const hits: string[] = [];
  for (let i = 0; i < m.buttons.length; i++) {
    for (let j = i + 1; j < m.buttons.length; j++) {
      const a: Box = m.buttons[i]; const b: Box = m.buttons[j];
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
        hits.push(`${a.sel}∩${b.sel}`);
      }
    }
  }
  check(`${kind}: no tool button intersects another`,
    hits.length === 0, hits.join(', ') || 'none');

  check(`${kind}: the hovered row leaves the label's click center clickable`,
    m.centerIsLabel, `elementAtCenter=${m.centerIsLabel ? 'label' : 'NOT the label'}`);
}

async function run(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => !!(window as any).__pt?.controller?.getSnapshot().docOpen,
      undefined, { timeout: 20_000 });
    await page.waitForSelector('.stackRow .name', { timeout: 20_000 });

    // Trail row: tools are ✎ (.editName), ⧉ (.dup), ✕ (.x).
    await probeHovered(page, 'trail', '.stackRow');

    // History row: needs >1 entry for the remove ✕ to render; mark one.
    await page.click('#btnMark');
    await page.waitForFunction(
      () => document.querySelectorAll('.histItem').length > 1,
      undefined, { timeout: 15_000 });
    await probeHovered(page, 'history', '.histItem.current');

    // (4) — without hover: the ✕ shows on the current/active row only, and
    // the hover-only tools take no layout space on any row.
    await page.mouse.move(700, 450); // leave the rows
    await page.waitForTimeout(200);
    const idle = await page.evaluate(() => {
      const shown = (el: Element | null) => !!el
        && (el as HTMLElement).getBoundingClientRect().width > 0
        && getComputedStyle(el).display !== 'none'
        && getComputedStyle(el).opacity !== '0';
      const laidOut = (el: Element | null) => !!el
        && (el as HTMLElement).getBoundingClientRect().width > 0;
      const cur = document.querySelector('.histItem.current');
      const other = [...document.querySelectorAll('.histItem')]
        .find((r) => !r.classList.contains('current')) ?? null;
      return {
        trailX: shown(document.querySelector('.stackRow .x')),
        curRm: shown(cur?.querySelector('.rmEntry') ?? null),
        otherRm: shown(other?.querySelector('.rmEntry') ?? null),
        anyHoverToolLaidOut:
          laidOut(document.querySelector('.stackRow .editName'))
          || laidOut(document.querySelector('.stackRow .dup'))
          || laidOut(cur?.querySelector('.editName') ?? null)
          || laidOut(cur?.querySelector('.setPos') ?? null),
      };
    });
    check('unhovered: the active trail row shows its ✕', idle.trailX);
    check('unhovered: the current history row shows its ✕', idle.curRm);
    check('unhovered: a non-current history row hides its ✕', !idle.otherRm);
    check('unhovered: the hover-only tools take no layout space',
      !idle.anyHoverToolLaidOut);

    // Marking dirtied the session; clear it so the harness closes silently.
    await page.evaluate(() => {
      (window as never as { __pt: { session: { dirty: boolean } } }).__pt.session.dirty = false;
    });
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
