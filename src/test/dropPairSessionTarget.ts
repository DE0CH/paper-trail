// Regression (data loss): dropping a PDF + .ptl PAIR onto an open document
// with the PDF listed first bound the PDF's file handle as the session's
// write target — openDropped chose the FILE by extension (the .ptl) but took
// the HANDLE blindly from dt.items[0]. The next save then ran createWritable
// on the PDF and overwrote it with session text. The handle must come from
// the DataTransfer item at the SAME index as the chosen file.
//
// Run: node build-node/test/dropPairSessionTarget.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function run(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => !!(window as any).__pt?.controller?.getSnapshot().docOpen,
      undefined, { timeout: 20_000 });

    const out = await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const ptlText: string = pt.progressText(); // a valid .ptl for this doc

      const pdfBytes = new Uint8Array(
        await (await fetch('sample/WStarCats.pdf')).arrayBuffer());
      const pdfFile = new File([pdfBytes], 'other.pdf', { type: 'application/pdf' });
      const ptlFile = new File([ptlText], 'reading.ptl', { type: 'text/plain' });

      // Fake handles tagged so the binding is attributable. Writing to the
      // PDF's handle is the data-loss case, so it throws loudly.
      const mkHandle = (name: string, tag: string) => ({
        kind: 'file', name, __tag: tag,
        createWritable: async () => { throw new Error('write attempted on ' + tag); },
      });
      const pdfHandle = mkHandle('other.pdf', 'pdf');
      const ptlHandle = mkHandle('reading.ptl', 'ptl');

      // A two-file drop, PDF FIRST — files and items in the same order, as
      // the DataTransfer spec guarantees for kind === 'file' items.
      const dt = {
        files: [pdfFile, ptlFile],
        items: [
          { kind: 'file', getAsFileSystemHandle: async () => pdfHandle },
          { kind: 'file', getAsFileSystemHandle: async () => ptlHandle },
        ],
      };
      await c.openDropped(dt);

      // openDropped hands off to openFile without awaiting; poll the binding.
      for (let i = 0; i < 100 && !c.session.handle; i++) {
        if (c.confirmSession) c.applyConfirmedSession();
        await new Promise((r) => setTimeout(r, 50));
      }
      return { boundTag: (c.session.handle && c.session.handle.__tag) ?? null };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    check('the dropped pair binds the .ptl handle as the save target (never the PDF)',
      out.boundTag === 'ptl', `bound handle tag=${JSON.stringify(out.boundTag)}`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
