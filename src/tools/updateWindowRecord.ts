// Full-display screen recording of the Sparkle-style Software Update
// WINDOW for owner review, driving the REAL signed packaged app through
// a REAL update. Two modes (argv[2]):
//   finished — Check for Updates… → "A new version… available" →
//     Update Now → progress bar → "Ready to update" → Restart to Update.
//   canceled — … Update Now → progress starts → Cancel actually stops
//     the download → the window returns to the offer.
// Capture is ffmpeg avfoundation (screencapture -v yields empty clips on
// the runner). The window is a BrowserWindow (update.html) driven via
// Playwright locators (#pt-update-primary / -secondary), with the real
// cursor glided to each button's screen position by cliclick so the
// video shows a natural pointer. The feed serves a REAL next-version
// SIGNED zip (a fake one errors Squirrel) and stays dark until the app
// is on camera, so the OFFER really appears rather than pre-downloading.
// Run (CI, macos-14): node build-node/tools/updateWindowRecord.js <finished|canceled>

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

const ROOT = path.resolve(__dirname, '..', '..');
const FEED = path.join(ROOT, 'dist-update-feed');
const PRODUCT = 'Paper Trail';
const PORT = 8779;
const MODE: 'finished' | 'canceled' = process.argv[2] === 'canceled' ? 'canceled' : 'finished';
const OUT = path.join(ROOT, `update-window-${MODE}.mov`);

function osa(script: string): string {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 20_000 }).trim();
}
function cliclick(...cmds: string[]): void {
  execFileSync('cliclick', cmds, { encoding: 'utf8', timeout: 30_000 });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cursor = { x: 220, y: 220 };
function glideTo(to: { x: number; y: number }): void {
  const steps = 28;
  const cmds: string[] = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    cmds.push(`m:${Math.round(cursor.x + (to.x - cursor.x) * e)},${Math.round(cursor.y + (to.y - cursor.y) * e)}`);
    cmds.push('w:16');
  }
  cliclick(...cmds);
  cursor = to;
}

/** Screen center of a native AX element (used for the menu). */
function axCenter(axPath: string): { x: number; y: number } {
  const pos = osa(`tell application "System Events" to tell process "${PRODUCT}" to get position of ${axPath}`);
  const size = osa(`tell application "System Events" to tell process "${PRODUCT}" to get size of ${axPath}`);
  const [x, y] = pos.split(',').map((v) => Number(v.trim()));
  const [w, h] = size.split(',').map((v) => Number(v.trim()));
  return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
}

/** Screen center of an update-window button: the window's content
 * origin (main process) + the element's box within the page. */
async function buttonCenter(eApp: ElectronApplication, page: Page, sel: string):
  Promise<{ x: number; y: number } | null> {
  const box = await page.locator(sel).boundingBox();
  const origin = await eApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()
      .find((b) => !b.isDestroyed() && b.webContents.getURL().includes('update.html'));
    if (!w) return null;
    const b = w.getContentBounds();
    return { x: b.x, y: b.y };
  });
  if (!box || !origin) return null;
  return { x: Math.round(origin.x + box.x + box.width / 2), y: Math.round(origin.y + box.y + box.height / 2) };
}

// ---- the feed: a real signed next-version zip, dark until live, and
// dripped so the progress bar visibly fills. ----
let feedLive = false;
function serveFeed(): { server: http.Server; newVersion: string } {
  const ymlName = fs.readdirSync(FEED).find((f) => /^latest.*\.yml$/.test(f));
  const zipName = fs.readdirSync(FEED).find((f) => f.endsWith('.zip'));
  if (!ymlName || !zipName) throw new Error('need dist-update-feed with a next-version mac zip + yml');
  const yml = fs.readFileSync(path.join(FEED, ymlName), 'utf8');
  const newVersion = /version:\s*(\S+)/.exec(yml)?.[1] ?? '';
  const zip = fs.readFileSync(path.join(FEED, zipName));
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '');
    if (!feedLive || !name) { res.writeHead(404); res.end('nope'); return; }
    if (name.startsWith('latest')) {
      res.writeHead(200, { 'content-type': 'text/yaml' }); res.end(yml); return;
    }
    if (name.endsWith('.zip')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(zip.length) });
      // ~14s drip: long enough for the progress bar to read as a real
      // download and for the canceled run to click Cancel mid-flight.
      const chunk = Math.ceil(zip.length / 28);
      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= zip.length || res.destroyed) { clearInterval(timer); res.end(); return; }
        res.write(zip.subarray(sent, sent + chunk)); sent += chunk;
      }, 500);
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  server.listen(PORT, '127.0.0.1');
  return { server, newVersion };
}

function findApp(): string | null {
  const dist = path.join(ROOT, 'dist-electron');
  for (const dir of fs.readdirSync(dist)) {
    const app = path.join(dist, dir, `${PRODUCT}.app`);
    if (dir.startsWith('mac') && fs.existsSync(app)) return app;
  }
  return null;
}

async function pageState(page: Page): Promise<string> {
  return await page.locator('#pt-update-root').getAttribute('data-state') ?? '';
}
async function waitState(page: Page, want: (s: string) => boolean, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  let s = await pageState(page);
  while (!want(s) && Date.now() < deadline) { await sleep(200); s = await pageState(page); }
  return s;
}

async function run(): Promise<void> {
  const packaged = findApp();
  if (!packaged) { console.error('FAIL  no packaged Paper Trail.app'); process.exit(1); }
  // Run a ditto copy so a real Restart-into-Squirrel can't disturb the
  // packaged original between the two recordings.
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), `pt-rec-${MODE}-`));
  const app = path.join(appDir, `${PRODUCT}.app`);
  execFileSync('ditto', [packaged!, app]);
  const bin = path.join(app, 'Contents', 'MacOS', PRODUCT);

  const { server, newVersion } = serveFeed();
  console.log(`recording [${MODE}] -> ${newVersion}`);

  const eApp: ElectronApplication = await _electron.launch({
    executablePath: bin,
    args: [],
    env: {
      ...process.env as Record<string, string>,
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-recud-')),
      PT_UPDATE_URL: `http://127.0.0.1:${PORT}`,
    },
  });

  let recorder: ChildProcess | null = null;
  const ffLog = fs.openSync(path.join(ROOT, `ff-${MODE}.log`), 'w');
  try {
    await eApp.firstWindow();
    await sleep(4000); // let the app settle on screen

    fs.rmSync(OUT, { force: true });
    recorder = spawn('ffmpeg', [
      '-y', '-f', 'avfoundation', '-capture_cursor', '1',
      '-framerate', '30', '-i', 'Capture screen 0',
      '-pix_fmt', 'yuv420p', OUT,
    ], { stdio: ['pipe', ffLog, ffLog] });
    await sleep(2500);

    feedLive = true; // now the interactive check finds a fresh update

    // 1 — the app menu → Check for Updates…
    glideTo(axCenter(`menu bar item "${PRODUCT}" of menu bar 1`));
    cliclick(`c:${cursor.x},${cursor.y}`); await sleep(700);
    const item = axCenter(`menu item "Check for Updates…" of menu 1 of menu bar item "${PRODUCT}" of menu bar 1`);
    glideTo(item); cliclick(`c:${item.x},${item.y}`);

    // 2 — the update window opens
    let page: Page | undefined;
    const deadline = Date.now() + 30_000;
    while (!page && Date.now() < deadline) {
      page = eApp.windows().find((p) => p.url().includes('update.html'));
      if (!page) await sleep(400);
    }
    if (!page) throw new Error('SELF-VERIFY: the update window never opened');

    const offer = await waitState(page, (s) => s === 'available' || s === 'downloaded', 60_000);
    if (offer !== 'available') throw new Error(`SELF-VERIFY: expected the offer, got '${offer}' (pre-downloaded?)`);
    await sleep(1800); // reading the offer

    // 3 — Update Now
    const primary = await buttonCenter(eApp, page, '#pt-update-primary');
    if (primary) { glideTo(primary); await sleep(300); }
    await page.locator('#pt-update-primary').click();

    if (MODE === 'finished') {
      const done = await waitState(page, (s) => s === 'downloaded', 120_000);
      if (done !== 'downloaded') throw new Error(`SELF-VERIFY: never reached Ready, state='${done}'`);
      await sleep(1800); // read "Ready to update"
      const restart = await buttonCenter(eApp, page, '#pt-update-primary');
      if (restart) { glideTo(restart); await sleep(300); }
      await page.locator('#pt-update-primary').click(); // Restart to Update
      await sleep(3500); // the app quits into the updater, on camera
      console.log('PASS  finished: checking → offer → download → Ready → Restart');
    } else {
      const dl = await waitState(page, (s) => s === 'downloading', 30_000);
      if (dl !== 'downloading') throw new Error(`SELF-VERIFY: download never started, state='${dl}'`);
      await sleep(3200); // let the progress bar visibly advance
      const cancel = await buttonCenter(eApp, page, '#pt-update-secondary');
      if (cancel) { glideTo(cancel); await sleep(300); }
      await page.locator('#pt-update-secondary').click(); // Cancel
      const back = await waitState(page, (s) => s === 'available', 30_000);
      if (back !== 'available') throw new Error(`SELF-VERIFY: Cancel did not return to the offer, state='${back}'`);
      await sleep(2500); // dwell on the returned offer
      console.log('PASS  canceled: offer → Update Now → download → Cancel → back to offer');
    }
  } finally {
    if (recorder) {
      try { recorder.stdin?.write('q\n'); } catch { recorder.kill('SIGINT'); }
      await sleep(4000); // flush the moov atom
      recorder.kill('SIGINT');
    }
    await eApp.close().catch(() => { /* may have quit into the updater */ });
    server.close();
    spawnSync('pkill', ['-f', bin], { timeout: 20_000 });
  }

  try {
    const tail = fs.readFileSync(path.join(ROOT, `ff-${MODE}.log`), 'utf8').split('\n').slice(-12).join('\n');
    console.log('----- ffmpeg tail -----\n' + tail + '\n-----------------------');
  } catch { /* fine */ }
  if (!fs.existsSync(OUT) || fs.statSync(OUT).size < 120_000) {
    console.error(`FAIL  ${OUT} missing or implausibly small`); process.exit(1);
  }
  console.log(`PASS  ${path.basename(OUT)} recorded (${fs.statSync(OUT).size} bytes)`);
  process.exit(0);
}

run().catch((e) => { console.error(String(e)); process.exit(1); });
