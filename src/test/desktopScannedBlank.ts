// Scanned PDFs in the DESKTOP shell: the bug was reported from the mac
// app, where every CCITT-compressed page (the compression scanners
// produce) painted permanently blank because pdf.js's wasm image codecs
// were neither bundled nor pointed to via `wasmUrl`. This suite drives
// the real Electron shell over paper-trail:// with every HTTP(S)
// request cancelled, opens the scanner-structured fixture
// (sample/scanned.pdf — the dev/test protocol serves /sample/*), and
// asserts a CCITT page and a JPEG page each render their own
// machine-encoded content: proof the codecs load offline through the
// app protocol, the same served path the cMaps already use.
//
// Prereq: the app must be built (npm run build) and the fixture
// generated (python src/tools/gen_scanned_fixture.py).
// Usage: node build-node/test/desktopScannedBlank.js

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron, type Page } from 'playwright-core';

const BASE = 'paper-trail://app';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface PageRecLike { rendered: boolean; stale: boolean; el: HTMLElement }
type PtWin = Window & {
  __pt: {
    viewer: { pages: PageRecLike[] };
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const eApp = await _electron.launch({
    executablePath: electronPath,
    args: [path.resolve(__dirname, '..', 'desktop', 'main.js')],
    env: {
      ...process.env as Record<string, string>,
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-scan-')),
      PT_SHOT: '1', // show windows without stealing focus
    },
  });
  try {
    // Cancel and record every HTTP(S) request: the codecs must load
    // through the app protocol, never the network.
    await eApp.evaluate(({ app, session }) => {
      const attempts: string[] = [];
      (globalThis as { __ptNetAttempts?: string[] }).__ptNetAttempts = attempts;
      const hook = (s: Electron.Session) => s.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, cb) => {
          attempts.push(details.url);
          cb({ cancel: true });
        },
      );
      hook(session.defaultSession);
      app.on('web-contents-created', (_event, wc) => hook(wc.session));
    });
    // Native dialogs would hang a scripted run.
    await eApp.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 1) as typeof dialog.showMessageBoxSync;
      dialog.showMessageBox = (async () => ({
        response: 1, checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    });
    const page: Page = await eApp.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    page.on('pageerror', (e) => check('no page errors', false, String(e)));
    page.on('dialog', (d) => d.accept().catch(() => { /* already handled */ }));

    await page.goto(BASE + '/?file=sample/scanned.pdf');
    await page.waitForSelector('.page[data-page="1"] canvas[data-res="full"]',
      { timeout: 30_000 });
    const p1 = await page.evaluate(`(${PROBE_FN})(1)`) as Probe;
    check('the JPEG page renders its own content in the desktop shell',
      p1.anchorInk && p1.whiteOk && p1.decoded === 1, JSON.stringify(p1));

    // Page 2 is CCITT G4 — the compression that went blank without the
    // bundled wasm codecs.
    await page.evaluate(() => {
      const pt = (window as unknown as PtWin).__pt;
      document.getElementById('viewerContainer')!.scrollTop =
        pt.viewer.pages[1].el.offsetTop + 2;
    });
    await page.waitForFunction(() => {
      const rec = (window as unknown as PtWin).__pt.viewer.pages[1];
      const c = rec.el.querySelector('canvas') as HTMLCanvasElement | null;
      return !!c && c.dataset.res === 'full' && !rec.stale;
    }, undefined, { timeout: 30_000 });
    const p2 = await page.evaluate(`(${PROBE_FN})(2)`) as Probe;
    check('a CCITT fax page renders its own content in the desktop shell',
      p2.anchorInk && p2.whiteOk && p2.decoded === 2, JSON.stringify(p2));

    const attempts = await eApp.evaluate(() =>
      (globalThis as { __ptNetAttempts?: string[] }).__ptNetAttempts ?? []);
    check('the codecs loaded fully offline (no network attempts)',
      attempts.length === 0, JSON.stringify(attempts.slice(0, 5)));

    await page.evaluate(() => {
      (window as unknown as PtWin).__pt.session.dirty = false;
    });
  } finally {
    await eApp.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
