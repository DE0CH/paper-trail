// Alignment/typography audit — the sweep beyond what uiAlignment.ts and
// trailRowLayout.ts already pin. Everything is MEASURED off the rendered
// page (getBoundingClientRect / Range glyph boxes / getComputedStyle),
// never eyeballed, and the numbers are printed so a regression shows the
// exact px that drifted. Pins:
//   1. each panel header's label starts on the same x as its list rows'
//      text (Trails, History) — header aligned with its content;
//   2. the three panel headers (Outline tab, Trails, History) share one
//      label inset from their panel's left edge;
//   3. outline TOP-LEVEL rows sit on the same panel gutter as trail and
//      history rows (the one-list left metric) with symmetric left/right
//      gutters — the root tree carries no phantom indent;
//   4. the welcome screen's "Recent" heading starts on the same x as the
//      recent rows' text;
//   5. the uppercase section-label role ("Recent", shortcut-help group
//      titles) uses ONE type treatment: same size, tracking, transform;
//   6. the find bar's match count uses the toolbar count size (one
//      "count" role, not 12px here and 13px there);
//   7. focusing the page-number input never moves or resizes it, and a
//      zoom-percent change never moves the zoom cluster (no-jank);
//   8. a long trail name ellipsizes inside its row (no growth/overflow).
// Screenshots of each audited region land in audit-shots/ (CI uploads
// them as an artifact; AUDIT_TAG prefixes the files, e.g. red-/green-).
// Run: node build-node/test/uiAlignmentAudit.js   (server on 8377 first)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const EPS = 0.75; // sub-pixel rounding tolerance
const SHOTS = process.env.AUDIT_SHOTS_DIR ?? 'audit-shots';
const TAG = process.env.AUDIT_TAG ?? 'audit';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function shot(page: Page, name: string, sel: string, pad = 6): Promise<void> {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, sel);
  if (!box) { console.log(`(no screenshot: ${sel} not found)`); return; }
  const vp = page.viewportSize() ?? { width: 1400, height: 900 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const clip = {
    x, y,
    width: Math.min(vp.width - x, box.width + 2 * pad),
    height: Math.min(vp.height - y, box.height + 2 * pad),
  };
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${TAG}-${name}.png`), clip });
}

// Browser-side helpers, installed into both pages (document view +
// welcome view) so every measurement shares one definition.
const installHelpers = (): void => {
  (window as never as { __audit: unknown }).__audit = {
    // Left edge of the first rendered glyph inside el (Range box, so it
    // measures ink placement, not the element box).
    glyphLeft(el: Element): number | null {
      const walk = (n: Node): Node | null => {
        if (n.nodeType === 3 && (n.textContent ?? '').trim()) return n;
        for (const c of [...n.childNodes]) { const r = walk(c); if (r) return r; }
        return null;
      };
      const tn = walk(el);
      if (!tn) return null;
      const rg = document.createRange(); rg.selectNodeContents(tn);
      return rg.getBoundingClientRect().left;
    },
    // The panel's content-box left edge (border excluded).
    contentLeft(el: Element): number {
      return el.getBoundingClientRect().left + el.clientLeft;
    },
    // The panel's content-box right edge EXCLUDING a scrollbar, so row
    // gutters measure against the space rows actually occupy.
    contentRight(el: Element): number {
      return el.getBoundingClientRect().left + el.clientLeft + el.clientWidth;
    },
  };
};

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('#toolbar', { timeout: 20_000 });
    await page.waitForSelector('.stackRow .name', { timeout: 20_000 });
    await page.waitForSelector('.histItem .lbl', { timeout: 20_000 });
    await page.waitForSelector('.outlineItem', { timeout: 20_000 });
    await page.evaluate(installHelpers);

    // ---- toolbar: spacing dump + count baselines (coverage print) ------
    const bar = await page.evaluate(() => {
      const el = document.getElementById('toolbar')!;
      const items = [...el.querySelectorAll('button, input, a, span')]
        .map((c) => {
          const r = (c as HTMLElement).getBoundingClientRect();
          return { id: (c as HTMLElement).id || (c.textContent ?? '').trim().slice(0, 12), left: r.left, right: r.right, mid: (r.top + r.bottom) / 2, w: r.width };
        })
        .filter((c) => c.w > 0)
        .sort((a, b) => a.left - b.left);
      const gaps: string[] = [];
      for (let i = 1; i < items.length; i++) {
        const g = items[i].left - items[i - 1].right;
        if (g >= 0) gaps.push(`${items[i - 1].id}→${items[i].id}=${g.toFixed(1)}`);
      }
      return gaps;
    });
    console.log('toolbar gaps: ' + bar.join('  '));

    const counts = await page.evaluate(() => {
      const input = document.getElementById('pageInput')!;
      const count = document.getElementById('pageCount')!;
      const rg = document.createRange();
      rg.selectNodeContents(count.childNodes[0] ?? count);
      const g = rg.getBoundingClientRect();
      const ir = input.getBoundingClientRect();
      return { inputMid: (ir.top + ir.bottom) / 2, countGlyphMid: (g.top + g.bottom) / 2 };
    });
    console.log(`page input box mid=${counts.inputMid.toFixed(2)}  "/ N" glyph mid=${counts.countGlyphMid.toFixed(2)}`);
    check(`the page input and its "/ N" count share one vertical centre (Δ ${Math.abs(counts.inputMid - counts.countGlyphMid).toFixed(2)}px)`,
      Math.abs(counts.inputMid - counts.countGlyphMid) <= EPS);

    // ---- 7a: focusing the page-number input must not move/resize it ----
    const inputBoxes = await (async () => {
      const before = await page.evaluate(() => {
        const r = document.getElementById('pageInput')!.getBoundingClientRect();
        return { left: r.left, top: r.top, w: r.width, h: r.height };
      });
      await page.focus('#pageInput');
      const after = await page.evaluate(() => {
        const r = document.getElementById('pageInput')!.getBoundingClientRect();
        return { left: r.left, top: r.top, w: r.width, h: r.height };
      });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      return { before, after };
    })();
    const inpDrift = Math.max(
      Math.abs(inputBoxes.after.left - inputBoxes.before.left),
      Math.abs(inputBoxes.after.top - inputBoxes.before.top),
      Math.abs(inputBoxes.after.w - inputBoxes.before.w),
      Math.abs(inputBoxes.after.h - inputBoxes.before.h));
    check(`focusing the page-number input moves nothing (worst Δ ${inpDrift.toFixed(2)}px)`, inpDrift <= EPS);

    // ---- 7b: a zoom-% text change never moves the zoom cluster ---------
    const zoomBefore = await page.evaluate(() => ({
      pct: document.getElementById('zoomPct')!.textContent,
      plusLeft: document.getElementById('btnZoomIn')!.getBoundingClientRect().left,
      minusRight: document.getElementById('btnZoomOut')!.getBoundingClientRect().right,
    }));
    await page.click('#btnZoomOut');
    await page.click('#btnZoomOut');
    await page.waitForTimeout(400);
    const zoomAfter = await page.evaluate(() => ({
      pct: document.getElementById('zoomPct')!.textContent,
      plusLeft: document.getElementById('btnZoomIn')!.getBoundingClientRect().left,
      minusRight: document.getElementById('btnZoomOut')!.getBoundingClientRect().right,
    }));
    console.log(`zoom % ${zoomBefore.pct} → ${zoomAfter.pct}`);
    check(`a zoom-percent change moves neither zoom button (Δ+ ${Math.abs(zoomAfter.plusLeft - zoomBefore.plusLeft).toFixed(2)}px, Δ− ${Math.abs(zoomAfter.minusRight - zoomBefore.minusRight).toFixed(2)}px)`,
      Math.abs(zoomAfter.plusLeft - zoomBefore.plusLeft) <= EPS
      && Math.abs(zoomAfter.minusRight - zoomBefore.minusRight) <= EPS);
    await shot(page, 'toolbar', '#toolbar', 0);

    // ---- 8: a long trail name ellipsizes inside its row ---------------
    await page.evaluate(() => {
      const pt = (window as never as {
        __pt: { hist: { activeId: number; renameStack(id: number, n: string): void } };
      }).__pt;
      pt.hist.renameStack(pt.hist.activeId,
        'A deliberately very long trail name that cannot possibly fit the panel width');
    });
    await page.waitForTimeout(200);
    const trunc = await page.evaluate(() => {
      const row = document.querySelector('.stackRow') as HTMLElement;
      const name = row.querySelector('.name') as HTMLElement;
      const cs = getComputedStyle(name);
      return {
        rowH: row.getBoundingClientRect().height,
        overflows: name.scrollWidth > name.clientWidth + 1,
        clipped: cs.overflow === 'hidden' && cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap',
        inside: name.getBoundingClientRect().right <= row.getBoundingClientRect().right,
      };
    });
    check(`a long trail name ellipsizes inside its row (rowH ${trunc.rowH.toFixed(1)}px)`,
      trunc.overflows && trunc.clipped && trunc.inside && Math.abs(trunc.rowH - 24) <= EPS,
      JSON.stringify(trunc));

    // ---- 1+2: header labels vs list text, and across the three panels --
    const insets = await page.evaluate(() => {
      const a = (window as never as {
        __audit: {
          glyphLeft(e: Element): number | null;
          contentLeft(e: Element): number;
          contentRight(e: Element): number;
        };
      }).__audit;
      const headerLabel = (rootId: string, txt: string) =>
        [...document.querySelectorAll(`#${rootId} button, #${rootId} span`)]
          .find((e) => e.textContent?.trim() === txt) ?? null;
      const inset = (el: Element | null, panelId: string) => {
        if (!el) return null;
        const g = a.glyphLeft(el);
        return g == null ? null : g - a.contentLeft(document.getElementById(panelId)!);
      };
      return {
        headOutline: inset(headerLabel('navCol', 'Outline'), 'navCol'),
        headTrails: inset(headerLabel('stacksCol', 'Trails'), 'stacksCol'),
        headHistory: inset(headerLabel('sideCol', 'History'), 'sideCol'),
        rowTrail: inset(document.querySelector('.stackRow .name'), 'stacksCol'),
        rowHist: inset(document.querySelector('.histItem .lbl'), 'sideCol'),
      };
    });
    console.log('label insets from panel left (px): '
      + Object.entries(insets).map(([k, v]) => `${k}=${v?.toFixed(2)}`).join('  '));
    if (insets.headTrails != null && insets.rowTrail != null) {
      check(`the Trails header label starts on its rows' text x (Δ ${Math.abs(insets.headTrails - insets.rowTrail).toFixed(2)}px)`,
        Math.abs(insets.headTrails - insets.rowTrail) <= EPS);
    }
    if (insets.headHistory != null && insets.rowHist != null) {
      check(`the History header label starts on its rows' text x (Δ ${Math.abs(insets.headHistory - insets.rowHist).toFixed(2)}px)`,
        Math.abs(insets.headHistory - insets.rowHist) <= EPS);
    }
    const heads = [insets.headOutline, insets.headTrails, insets.headHistory]
      .filter((v): v is number => v != null);
    if (heads.length === 3) {
      const spread = Math.max(...heads) - Math.min(...heads);
      check(`the three panel header labels share one inset from their panel's left edge (spread ${spread.toFixed(2)}px)`,
        spread <= EPS);
    }

    // ---- 3: outline top-level rows on the shared list gutter ----------
    const gutters = await page.evaluate(() => {
      const a = (window as never as {
        __audit: { contentLeft(e: Element): number; contentRight(e: Element): number };
      }).__audit;
      const probe = (rowSel: string, panelId: string) => {
        const rows = [...document.querySelectorAll(rowSel)] as HTMLElement[];
        if (!rows.length) return null;
        const panel = document.getElementById(panelId)!;
        const min = Math.min(...rows.map((r) => r.getBoundingClientRect().left));
        // outline nesting indents by design: only top-level rows (the
        // minimum left edge) belong to the shared gutter metric.
        const top = rows.filter((r) => r.getBoundingClientRect().left <= min + 0.75);
        const r = top[0].getBoundingClientRect();
        return {
          left: r.left - a.contentLeft(panel),
          right: a.contentRight(panel) - r.right,
        };
      };
      return {
        outline: probe('.outlineItem', 'outlinePanel'),
        trail: probe('.stackRow', 'stacksPanel'),
        hist: probe('.histItem', 'historyPanel'),
      };
    });
    console.log('row gutters (px from panel content edges): '
      + Object.entries(gutters).map(([k, v]) => `${k}=[${v?.left.toFixed(2)}, ${v?.right.toFixed(2)}]`).join('  '));
    for (const [name, g] of Object.entries(gutters)) {
      if (!g) continue;
      check(`${name} rows keep symmetric left/right gutters (${g.left.toFixed(2)} vs ${g.right.toFixed(2)}px)`,
        Math.abs(g.left - g.right) <= EPS);
    }
    if (gutters.outline && gutters.trail) {
      check(`outline top-level rows share the trail rows' left gutter (Δ ${Math.abs(gutters.outline.left - gutters.trail.left).toFixed(2)}px)`,
        Math.abs(gutters.outline.left - gutters.trail.left) <= EPS);
    }
    await shot(page, 'panels', '#sidebar');
    await shot(page, 'outline', '#navCol');

    // ---- 6: the find bar's count uses the toolbar count size ----------
    await page.keyboard.press('Escape'); // make sure nothing else is open
    await page.keyboard.press('Control+f');
    await page.waitForSelector('#searchBar', { timeout: 5_000 });
    const countSizes = await page.evaluate(() => ({
      search: parseFloat(getComputedStyle(document.getElementById('searchCount')!).fontSize),
      page: parseFloat(getComputedStyle(document.getElementById('pageCount')!).fontSize),
    }));
    check(`the find-bar match count uses the toolbar count size (${countSizes.search}px vs ${countSizes.page}px)`,
      Math.abs(countSizes.search - countSizes.page) <= 0.1);
    await shot(page, 'search-bar', '#searchBar');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#searchBar', { state: 'detached', timeout: 5_000 });

    // ---- 5 (first half): shortcut-help group-title treatment ----------
    await page.keyboard.press('Shift+/');
    await page.waitForSelector('#shortcutOverlay', { timeout: 5_000 });
    const helpLabel = await page.evaluate(() => {
      const h = document.querySelector('#shortcutOverlay h3')!;
      const cs = getComputedStyle(h);
      return {
        fontSize: parseFloat(cs.fontSize),
        letterSpacing: parseFloat(cs.letterSpacing) || 0,
        textTransform: cs.textTransform,
      };
    });
    await shot(page, 'help-overlay', '#shortcutOverlay div');
    await page.keyboard.press('Escape');

    // ---- seed one recent entry so the welcome screen shows the list ----
    await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const c = (window as any).__pt.controller;
      const bytes = new Uint8Array(
        await (await fetch('sample/WStarCats.pdf')).arrayBuffer());
      await c.openFile(new File([bytes], 'WStarCats.pdf'), null, '/tmp/pt-audit/WStarCats.pdf');
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    await page.waitForFunction(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const c = (window as any).__pt.controller;
      return c.getSnapshot().recents.length > 0;
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }, undefined, { timeout: 20_000 });
    await page.waitForTimeout(400); // let the IndexedDB write settle
    await page.evaluate(() => {
      (window as never as { __pt: { session: { dirty: boolean } } }).__pt.session.dirty = false;
    });

    // ---- 4+5: the welcome screen's Recent block ------------------------
    const w = await context.newPage();
    w.on('dialog', (d) => void d.accept());
    await w.goto(BASE + '/');
    await w.waitForSelector('#recent .recentItem', { timeout: 20_000 });
    await w.evaluate(installHelpers);
    const recent = await w.evaluate(() => {
      const a = (window as never as {
        __audit: { glyphLeft(e: Element): number | null };
      }).__audit;
      const head = document.querySelector('#recent h3')!;
      const rowText = document.querySelector('#recent .recentItem span')!;
      const cs = getComputedStyle(head);
      return {
        headLeft: a.glyphLeft(head),
        rowLeft: a.glyphLeft(rowText),
        fontSize: parseFloat(cs.fontSize),
        letterSpacing: parseFloat(cs.letterSpacing) || 0,
        textTransform: cs.textTransform,
      };
    });
    if (recent.headLeft != null && recent.rowLeft != null) {
      check(`the "Recent" heading starts on its rows' text x (Δ ${Math.abs(recent.headLeft - recent.rowLeft).toFixed(2)}px)`,
        Math.abs(recent.headLeft - recent.rowLeft) <= EPS);
    }
    console.log(`section-label role: Recent ${recent.fontSize}px/${recent.letterSpacing.toFixed(2)}px/${recent.textTransform}`
      + ` — help ${helpLabel.fontSize}px/${helpLabel.letterSpacing.toFixed(2)}px/${helpLabel.textTransform}`);
    check('the uppercase section-label role uses one type treatment (Recent vs shortcut-help titles)',
      Math.abs(recent.fontSize - helpLabel.fontSize) <= 0.1
      && Math.abs(recent.letterSpacing - helpLabel.letterSpacing) <= 0.1
      && recent.textTransform === helpLabel.textTransform,
      `Recent ${recent.fontSize}px vs help ${helpLabel.fontSize}px`);
    await shot(w, 'welcome-recent', '#recent', 12);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
