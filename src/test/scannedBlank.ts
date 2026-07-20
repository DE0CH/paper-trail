// Scanned documents (every page one full-page 300dpi image) must not go
// blank while reading through them. pdf.js keeps each decoded page image
// (~35MB of RGBA for an A4 scan) alive on its page proxy until an
// explicit cleanup(); when eviction never issued one, reading a 50-page
// scan pinned >1.5GB of decoded bitmaps in the renderer, and under that
// memory pressure pages started rendering permanently blank on the
// owner's machine (a failed decode resolves render() successfully — the
// page is marked crisp and never retried). This suite reads the
// scanner-structured fixture (sample/scanned.pdf, see
// src/tools/gen_scanned_fixture.py) cover to cover on a retina-like
// display (deviceScaleFactor 2, the report platform) and asserts:
//   - every page, while visible, shows ITS OWN scan content (each page's
//     image machine-encodes the page number; probed from canvas pixels)
//   - decoded scan bitmaps are RELEASED once a page leaves the viewer's
//     keep-alive window (the deterministic core of the regression: on the
//     bug every visited page retains its bitmap forever)
//   - a released page re-renders correctly when scrolled back to
// Run: node build-node/test/scannedBlank.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface PageRecLike {
  rendered: boolean;
  stale: boolean;
  el: HTMLElement;
  canvas: HTMLCanvasElement | null;
  page: {
    objs: Iterable<[string, { dataLen?: number } | null]>;
  };
}
type PtWin = Window & {
  __pt: {
    viewer: {
      pages: PageRecLike[];
      renderLog: { page: number; res: 'low' | 'full' }[];
    };
    session: { dirty: boolean };
  };
};

/** Per-page verdict returned by the in-page pixel probe. */
interface Probe {
  page: number;
  res: string | null;
  anchorInk: boolean;
  whiteOk: boolean;
  decoded: number;
}

// Sample the pattern the fixture generator draws into every page image
// (see gen_scanned_fixture.py): a solid anchor bar at (0.5, 0.10), six
// binary page-number cells at ((248 + 372*i)/2480, 0.25), and an
// always-white control point at (0.5, 0.60).
const PROBE_FN = `(pageNumber) => {
  const el = document.querySelector('.page[data-page="' + pageNumber + '"]');
  const c = el && el.querySelector('canvas');
  if (!c) return { page: pageNumber, res: null, anchorInk: false, whiteOk: false, decoded: -1 };
  const ctx = c.getContext('2d');
  const dark = (fx, fy) => {
    const x = Math.max(0, Math.min(c.width - 5, Math.round(c.width * fx) - 2));
    const y = Math.max(0, Math.min(c.height - 5, Math.round(c.height * fy) - 2));
    const d = ctx.getImageData(x, y, 5, 5).data;
    let lum = 0;
    for (let i = 0; i < d.length; i += 4) lum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return lum / (d.length / 4) < 128;
  };
  let decoded = 0;
  for (let i = 0; i < 6; i++) {
    if (dark((248 + 372 * i) / 2480, 0.25)) decoded |= 1 << i;
  }
  return {
    page: pageNumber,
    res: c.dataset.res ?? null,
    anchorInk: dark(0.5, 0.0999),
    whiteOk: !dark(0.5, 0.6),
    decoded,
  };
}`;

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    // Retina emulation: the bug report is from a 2x display.
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 2,
    });
    page.on('pageerror', (e) => check('no page errors', false, String(e)));
    page.on('dialog', (d) => void d.accept());
    // pdf.js reports decode/render trouble as console warnings only
    // (render() still resolves) — collect them as evidence.
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text());
    });

    await page.goto(BASE + '/?file=sample/scanned.pdf');
    await page.waitForSelector('.page[data-page="1"] canvas[data-res="full"]',
      { timeout: 30_000 });
    const numPages = await page.evaluate(() =>
      (window as unknown as PtWin).__pt.viewer.pages.length);
    check('the scanned fixture opens (52 image-only pages)', numPages === 52,
      `numPages ${numPages}`);

    // ---- read the document cover to cover, verifying every page's
    // content while it is on screen (the owner's reading flow) ----
    const bad: Probe[] = [];
    for (let n = 1; n <= numPages; n++) {
      await page.evaluate((p) => {
        const pt = (window as unknown as PtWin).__pt;
        const container = document.getElementById('viewerContainer')!;
        container.scrollTop = pt.viewer.pages[p - 1].el.offsetTop + 2;
      }, n);
      const crisp = await page.waitForFunction((p) => {
        const rec = (window as unknown as PtWin).__pt.viewer.pages[p - 1];
        const c = rec.el.querySelector('canvas') as HTMLCanvasElement | null;
        return !!c && c.dataset.res === 'full' && !rec.stale;
      }, n, { timeout: 30_000 }).then(() => true).catch(() => false);
      if (!crisp) {
        bad.push({ page: n, res: 'never-crisp', anchorInk: false, whiteOk: false, decoded: -1 });
        continue;
      }
      const probe = await page.evaluate(
        `(${PROBE_FN})(${n})`) as Probe;
      if (!(probe.anchorInk && probe.whiteOk && probe.decoded === n)) bad.push(probe);
    }
    check('every page shows its own scan content while visible (no blank pages)',
      bad.length === 0,
      bad.length ? `bad pages: ${JSON.stringify(bad.slice(0, 8))}${bad.length > 8 ? ` +${bad.length - 8} more` : ''}` : '');

    // ---- the deterministic core: after the sweep, only pages still
    // inside the keep-alive window (viewport + DESTROY_MARGIN of 3200px
    // each way — at fit-width scan-page heights well under 12 pages) may
    // retain their decoded image; on the bug every visited page keeps its
    // ~35MB bitmap forever (52 pages ≈ 1.8GB) ----
    await page.waitForTimeout(1500); // let the final settle + eviction run
    const retention = await page.evaluate(() => {
      const pt = (window as unknown as PtWin).__pt;
      const perPage = pt.viewer.pages.map((p, i) => {
        let bytes = 0;
        for (const [, data] of p.page.objs) bytes += data?.dataLen ?? 0;
        return { page: i + 1, mb: Math.round(bytes / 1048576) };
      });
      const retained = perPage.filter((x) => x.mb > 1);
      return {
        retainedPages: retained.map((x) => x.page),
        totalMB: perPage.reduce((s, x) => s + x.mb, 0),
      };
    });
    console.log(`retained decoded-image memory: ${retention.totalMB}MB on pages `
      + JSON.stringify(retention.retainedPages));
    check('decoded scan bitmaps are released once pages leave the keep-alive window',
      retention.retainedPages.length <= 12,
      `${retention.retainedPages.length} pages retain decoded images`);
    check('total retained decoded-image memory stays bounded',
      retention.totalMB <= 500, `${retention.totalMB}MB retained`);

    // ---- releasing resources must not break revisits: page 1 was
    // evicted long ago; scrolling back re-decodes and re-renders it ----
    await page.evaluate(() => {
      document.getElementById('viewerContainer')!.scrollTop = 0;
    });
    const backCrisp = await page.waitForFunction(() => {
      const rec = (window as unknown as PtWin).__pt.viewer.pages[0];
      const c = rec.el.querySelector('canvas') as HTMLCanvasElement | null;
      return !!c && c.dataset.res === 'full' && !rec.stale;
    }, undefined, { timeout: 30_000 }).then(() => true).catch(() => false);
    const backProbe = backCrisp
      ? await page.evaluate(`(${PROBE_FN})(1)`) as Probe
      : null;
    check('a released page re-renders correctly when revisited',
      !!backProbe && backProbe.anchorInk && backProbe.whiteOk && backProbe.decoded === 1,
      JSON.stringify(backProbe));

    // Evidence for the log: pdf.js/viewer warnings seen during the read.
    const relevant = warnings.filter((w) =>
      /image|render|decode|canvas/i.test(w)).slice(0, 10);
    console.log(`console warnings during sweep: ${warnings.length}`
      + (relevant.length ? `; e.g. ${JSON.stringify(relevant)}` : ''));

    await page.evaluate(() => {
      (window as unknown as PtWin).__pt.session.dirty = false;
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
