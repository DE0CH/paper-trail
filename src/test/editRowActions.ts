// Bug A regression: renaming a trail or a history entry must give the
// rename <input> the FULL row width — no action icon may crowd or sit over
// it. The hover overlay (✎ rename / ⌖ re-anchor / ⧉ duplicate) is already
// suppressed in edit mode, but the trailing close/remove (✕) button kept
// its permanent flex slot, so it stayed rendered against the input's right
// edge while renaming. This measures the RENDERED geometry: with a row in
// rename mode it asserts (1) no action button is visible in that row and
// (2) the input reaches the row's right content edge.
// Run: node build-node/test/editRowActions.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const EPS = 1.0; // sub-pixel rounding tolerance

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface Probe {
  inputRight: number;
  rowRight: number;
  buttons: { sel: string; visible: boolean; intersects: boolean }[];
}

// Enter rename on the first matching row, measure the input and each of the
// row's action buttons, then cancel the edit (Escape).
async function renameProbe(
  page: Page, rowSel: string, labelSel: string, actionSels: string[],
): Promise<Probe> {
  const span = page.locator(`${rowSel} ${labelSel}`).first();
  await span.waitFor({ state: 'visible', timeout: 15_000 });
  await span.dblclick();
  const input = page.locator(`${rowSel} input.rename`).first();
  await input.waitFor({ state: 'visible', timeout: 5_000 });
  const data = await page.evaluate(({ rowSel, actionSels }) => {
    const row = document.querySelector(rowSel) as HTMLElement;
    const inp = row.querySelector('input.rename') as HTMLElement;
    const ir = inp.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const padR = parseFloat(getComputedStyle(row).paddingRight) || 0;
    const buttons = actionSels.map((sel) => {
      const el = row.querySelector(sel) as HTMLElement | null;
      if (!el) return { sel, visible: false, intersects: false };
      const st = getComputedStyle(el);
      const br = el.getBoundingClientRect();
      const visible = br.width > 0 && br.height > 0
        && parseFloat(st.opacity) > 0.01
        && st.visibility !== 'hidden' && st.display !== 'none';
      const intersects = br.left < ir.right && br.right > ir.left
        && br.top < ir.bottom && br.bottom > ir.top;
      return { sel, visible, intersects };
    });
    return { inputRight: ir.right, rowRight: rr.right - padR, buttons };
  }, { rowSel, actionSels });
  await page.keyboard.press('Escape');
  // HARD precondition, not best-effort: the next step clicks a toolbar
  // button, and on slow runners that click raced a still-mounted editor
  // (the mark landed in the editor's blur/re-render and no row appeared).
  await input.waitFor({ state: 'detached', timeout: 15_000 });
  return data;
}

function assertRow(kind: string, p: Probe): void {
  const vis = p.buttons.filter((b) => b.visible).map((b) => b.sel);
  const hit = p.buttons.filter((b) => b.intersects).map((b) => b.sel);
  console.log(`  ${kind}: inputRight=${p.inputRight.toFixed(1)} rowRight=${p.rowRight.toFixed(1)}`
    + `  visible=[${vis.join(', ')}] intersecting=[${hit.join(', ')}]`);
  check(`${kind} rename: no action icon stays visible over the input`,
    vis.length === 0, `visible: ${vis.join(', ') || 'none'}`);
  check(`${kind} rename: no action icon intersects the input rect`,
    hit.length === 0, `intersecting: ${hit.join(', ') || 'none'}`);
  check(`${kind} rename: the input reaches the row's right edge (short by `
    + `${(p.rowRight - p.inputRight).toFixed(1)}px)`,
    p.inputRight >= p.rowRight - EPS);
}

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    // Readiness must be the DOCUMENT, not the rows: trail/history rows
    // render before the PDF finishes opening (browsing trails pre-open is
    // a feature), but #btnMark's markPosition is docOpen-gated — a mark
    // clicked in that pre-open window is a designed no-op, so no second
    // row could ever appear. On slow runners the whole rename prelude fit
    // inside that window (proven by instrumentation: markPosition ran with
    // docOpen=false), which is exactly how this test starved for 15s.
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => !!(window as any).__pt?.controller?.getSnapshot().docOpen,
      undefined, { timeout: 20_000 });
    await page.waitForSelector('.stackRow .name', { timeout: 20_000 });
    await page.waitForSelector('.histItem .lbl', { timeout: 20_000 });

    console.log('\nrename-mode row geometry:');
    // Trail row: its close (✕) button is always rendered.
    const trail = await renameProbe(page, '.stackRow', '.name',
      ['.editName', '.dup', '.x']);
    assertRow('trail', trail);

    // History row: the remove (✕) button only renders with >1 entry, so add
    // a second entry (Mark this spot) to make the row removable first.
    await page.click('#btnMark');
    // waitForFunction(fn, ARG, options) — the options object must be the
    // THIRD argument (a prior version passed it second, where Playwright
    // reads it as the function's arg and applies the 30s default timeout).
    await page.waitForFunction(
      () => document.querySelectorAll('.histItem').length > 1,
      undefined, { timeout: 15_000 });
    const hist = await renameProbe(page, '.histItem', '.lbl',
      ['.editName', '.setPos', '.rmEntry']);
    assertRow('history', hist);

    // Marking dirtied the session; clear it so the harness sees no prompt.
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
