// Measurement-driven alignment guard (the app's no-jank / native-feel
// rule). It measures the RENDERED geometry — not the source — and asserts:
//   1. every interactive control in the toolbar shares one height and is
//      vertically centred in the bar (the hover pills line up), and
//   2. the trail / history / outline rows all render at the same 22px
//      height with the same left edge (one list metric across panels).
// Prints the numbers so a regression shows the exact px that drifted.
// Run: node build-node/test/uiAlignment.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const EPS = 0.75; // sub-pixel rounding tolerance

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface Box { tag: string; label: string; h: number; top: number; bottom: number }

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('#toolbar', { timeout: 20_000 });
    await page.waitForSelector('.stackRow', { timeout: 20_000 });
    await page.waitForSelector('.histItem', { timeout: 20_000 });

    // ---- toolbar: one height, optically centred -------------------------
    const bar = await page.evaluate(() => {
      const el = document.getElementById('toolbar')!;
      const r = el.getBoundingClientRect();
      const controls = [...el.querySelectorAll('button, input, a')] as HTMLElement[];
      return {
        barTop: r.top, barBottom: r.bottom, barH: r.height,
        items: controls.map((c) => {
          const cr = c.getBoundingClientRect();
          return {
            tag: c.tagName.toLowerCase(),
            label: (c.id || c.textContent || c.title || '').trim().slice(0, 16),
            h: cr.height, top: cr.top, bottom: cr.bottom,
          };
        }).filter((c) => c.h > 0),
      };
    });
    console.log(`\n#toolbar height ${bar.barH.toFixed(1)}px — ${bar.items.length} controls:`);
    for (const it of bar.items) {
      console.log(`  ${(it.tag + ' ' + it.label).padEnd(22)} h=${it.h.toFixed(1)}`
        + `  gapTop=${(it.top - bar.barTop).toFixed(1)} gapBot=${(bar.barBottom - it.bottom).toFixed(1)}`);
    }
    const hs = bar.items.map((i: Box) => i.h);
    const hSpread = Math.max(...hs) - Math.min(...hs);
    check(`toolbar controls all share one height (spread ${hSpread.toFixed(2)}px)`,
      hSpread <= EPS, `heights ${hs.map((h) => h.toFixed(1)).join(', ')}`);
    const worstCenter = Math.max(...bar.items.map((i: Box) =>
      Math.abs((i.top - bar.barTop) - (bar.barBottom - i.bottom))));
    check(`toolbar controls are vertically centred (worst top/bottom gap diff ${worstCenter.toFixed(2)}px)`,
      worstCenter <= EPS);

    // ---- panels: one row metric across trails / history / outline -------
    const rows = await page.evaluate(() => {
      const grab = (sel: string) => ([...document.querySelectorAll(sel)] as HTMLElement[])
        .map((e) => { const r = e.getBoundingClientRect(); return { h: r.height, left: r.left }; });
      return { trail: grab('.stackRow'), hist: grab('.histItem'), outline: grab('.outlineItem') };
    });
    const allRows = [...rows.trail, ...rows.hist, ...rows.outline];
    console.log(`\nrows: trails=${rows.trail.length} history=${rows.hist.length} outline=${rows.outline.length}`);
    const rowHs = allRows.map((r) => r.h);
    const rowSpread = Math.max(...rowHs) - Math.min(...rowHs);
    check(`trail/history/outline rows share one height (~22px; spread ${rowSpread.toFixed(2)}px)`,
      rowSpread <= EPS && Math.abs(rowHs[0] - 22) <= EPS,
      `heights ${[...new Set(rowHs.map((h) => h.toFixed(1)))].join(', ')}`);

    // left edge is consistent within each panel (rows don't stagger)
    for (const [name, list] of Object.entries(rows) as [string, { left: number }[]][]) {
      if (list.length < 2) continue;
      const lefts = list.map((r) => r.left);
      const leftSpread = Math.max(...lefts) - Math.min(...lefts);
      check(`${name} rows share one left edge (spread ${leftSpread.toFixed(2)}px)`, leftSpread <= EPS);
    }

    // ---- panel headers share one vertical text position ---------------
    const headTop = () => page.evaluate(() => {
      const textTop = (el?: Element | null): number | null => {
        if (!el) return null;
        const rg = document.createRange(); rg.selectNodeContents(el);
        return rg.getBoundingClientRect().top; // the glyph box, not the container
      };
      const label = (root: string, txt: string) =>
        [...document.querySelectorAll(`${root} button, ${root} span`)]
          .find((e) => e.textContent?.trim() === txt);
      return {
        outline: textTop(label('#navCol', 'Outline')),
        trails: textTop(label('#stacksCol', 'Trails')),
        history: textTop(label('#sideCol', 'History')),
      };
    });
    const h1 = await headTop();
    console.log(`\nheader label text-top: Outline=${h1.outline?.toFixed(2)} `
      + `Trails=${h1.trails?.toFixed(2)} History=${h1.history?.toFixed(2)}`);
    const tops = [h1.outline, h1.trails, h1.history].filter((v): v is number => v != null);
    if (tops.length === 3) {
      const spread = Math.max(...tops) - Math.min(...tops);
      check(`the three panel header labels share one vertical text position (spread ${spread.toFixed(2)}px)`,
        spread <= EPS, `Outline ${h1.outline!.toFixed(1)} / Trails ${h1.trails!.toFixed(1)} / History ${h1.history!.toFixed(1)}`);
    }
    // the active-tab underline must not move the label when it goes inactive
    await page.locator('#navCol button', { hasText: 'Pages' }).first().click().catch(() => { /* fine */ });
    const h2 = await headTop();
    if (h1.outline != null && h2.outline != null) {
      check(`the Outline label doesn't move when its tab goes inactive (${Math.abs(h2.outline - h1.outline).toFixed(2)}px)`,
        Math.abs(h2.outline - h1.outline) <= EPS);
    }

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
