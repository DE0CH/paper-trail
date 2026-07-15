// Regression (data loss): writeProgress cleared `dirty` unconditionally when
// the write it STARTED succeeded. An edit landing while that async write was
// in flight was then treated as saved — closeAndSave saw !dirty and closed,
// discarding it, and a failed retry left the UI showing "saved". Only a write
// whose serialized text covered the newest edit may clear dirty.
//
// Run: node build-node/test/writeGenerationDirty.js   (server on 8377 first)

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
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // A fake session handle whose first write blocks on a gate, so an
      // edit can be injected while the write is verifiably in flight.
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      const writes: string[] = [];
      c.session.handle = {
        kind: 'file', name: 's.ptl',
        createWritable: async () => ({
          write: async (t: string) => { writes.push(t); await gate; },
          close: async () => { /* sink */ },
        }),
      };
      c.session.dirty = true;

      const inflight = c.writeProgress();
      await sleep(100); // the write is now started and parked on the gate
      pt.jumpVia({ page: 2, yRatio: 0 }, 'edit during save'); // marks dirty
      release();
      await inflight;
      const dirtyAfterRacedWrite = c.session.dirty;

      // Control: with no mid-write edit, a successful write clears dirty.
      await c.writeProgress();
      const dirtyAfterCleanWrite = c.session.dirty;

      c.session.handle = null; c.session.dirty = false; // leave the page quiet
      return { dirtyAfterRacedWrite, dirtyAfterCleanWrite, writes: writes.length };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    check('an edit during an in-flight write leaves the session dirty',
      out.dirtyAfterRacedWrite === true, `dirty=${out.dirtyAfterRacedWrite}`);
    check('a write with no concurrent edit still clears dirty',
      out.dirtyAfterCleanWrite === false, `dirty=${out.dirtyAfterCleanWrite}`);
    check('both writes actually ran', out.writes === 2, `writes=${out.writes}`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
