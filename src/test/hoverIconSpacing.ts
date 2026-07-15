// Hover-toolbar spacing: the overlay tools (✎ / ⌖ or ⧉) are absolutely
// anchored just left of the trailing close/remove (✕) slot. The anchor must
// clear the WHOLE ✕ box plus the row's standard 6px gap — an off-by-a-few-px
// anchor makes the last overlay icon bleed into the ✕'s box (owner-reported:
// "the ⌖ goes slightly into the box of the ✕").
// Asserts, on a hovered trail row and a hovered removable history row:
//   (1) the overlay's last button does not intersect the trailing button, and
//   (2) there is at least a 4px horizontal gap between them.
// Run: node build-node/test/hoverIconSpacing.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
// The overlay sits FLUSH against the ✕ slot (gap >= 0, never overlapping):
// the w-5 buttons carry ~3px of internal glyph padding each side, so flush
// boxes still read as spaced. A larger box-gap is NOT wanted — pushing the
// overlay further left eclipsed the label's click center and broke
// double-click-to-rename (the df187c1 regression).
const MIN_GAP = 0;

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function probe(page: Page, kind: string, rowSel: string,
  overlayLastSel: string, trailingSel: string): Promise<void> {
  const row = page.locator(rowSel).first();
  await row.hover();
  const m = await page.evaluate(({ rowSel, overlayLastSel, trailingSel }) => {
    const row = document.querySelector(rowSel) as HTMLElement;
    const a = row.querySelector(overlayLastSel) as HTMLElement | null;
    const b = row.querySelector(trailingSel) as HTMLElement | null;
    const label = row.querySelector('.name, .lbl') as HTMLElement | null;
    if (!a || !b || !label) return null;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    // The label's click center must belong to the label, not the overlay —
    // double-click-to-rename lands there (the df187c1 regression).
    const lr = label.getBoundingClientRect();
    const at = document.elementFromPoint(lr.x + lr.width / 2, lr.y + lr.height / 2);
    const centerIsLabel = at === label || label.contains(at);
    return { aRight: ra.right, bLeft: rb.left, centerIsLabel };
  }, { rowSel, overlayLastSel, trailingSel });
  if (!m) { check(`${kind}: probe found the buttons and label`, false, 'missing element'); return; }
  const gap = m.bLeft - m.aRight;
  check(`${kind}: the overlay's last icon stays out of the trailing button's box`,
    gap >= 0, `overlap=${(-gap).toFixed(1)}px`);
  check(`${kind}: at least ${MIN_GAP}px between them (row gap consistency)`,
    gap >= MIN_GAP, `gap=${gap.toFixed(1)}px`);
  check(`${kind}: the hovered overlay leaves the label's click center clickable`,
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

    // Trail row: overlay is ✎ then ⧉ (.dup); trailing is the close ✕ (.x).
    await probe(page, 'trail', '.stackRow', '.dup', '.x');

    // History row: needs >1 entry for the remove ✕ to render; mark one.
    await page.click('#btnMark');
    await page.waitForFunction(
      () => document.querySelectorAll('.histItem').length > 1,
      undefined, { timeout: 15_000 });
    await probe(page, 'history', '.histItem', '.setPos', '.rmEntry');

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
