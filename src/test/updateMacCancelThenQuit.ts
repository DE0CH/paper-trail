// Restart to Update → Cancel → a plain quit, macOS (signed builds —
// Squirrel.Mac refuses unsigned updates): abandoning the restart must
// not change what a normal quit does. The update installs on the way
// out like any automatic upgrade, the app STAYS CLOSED (no
// self-relaunch — that only belongs to the explicit Restart button),
// and the next manual open is simply the new version. The unsaved
// prompt is stubbed: Cancel at the restart, Don't Save at the quit.
// Run (CI, macOS, signed builds): node build-node/test/updateMacCancelThenQuit.js

import { execFileSync, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron, Page } from 'playwright-core';

const ROOT = path.resolve(__dirname, '..', '..');
const FEED = path.join(ROOT, 'dist-update-feed');
const SAVE_PROMPT = 'Do you want to save your reading session?';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function serveFeed(): http.Server {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(
      new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '');
    const onDisk = fs.readdirSync(FEED)
      .find((f) => f === name || f.replace(/ /g, '-') === name);
    const file = path.join(FEED, onDisk ?? name);
    if (!name || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(8777, '127.0.0.1');
  return server;
}

function findApp(): string | null {
  const dist = path.join(ROOT, 'dist-electron');
  for (const dir of fs.readdirSync(dist)) {
    const app = path.join(dist, dir, 'Paper Trail.app');
    if (dir.startsWith('mac') && fs.existsSync(app)) return app;
  }
  return null;
}

function bundleVersion(app: string): string {
  try {
    return execFileSync('defaults',
      ['read', path.join(app, 'Contents', 'Info'), 'CFBundleShortVersionString'],
      { encoding: 'utf8' }).trim();
  } catch {
    return ''; // mid-replacement
  }
}

function appRunning(bin: string): boolean {
  return spawnSync('pgrep', ['-f', bin]).status === 0;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return cond();
}

async function run(): Promise<void> {
  const newVersion = /version:\s*(\S+)/.exec(
    fs.readFileSync(path.join(FEED, 'latest-mac.yml'), 'utf8'))?.[1] ?? '';
  const packaged = findApp();
  if (!packaged) {
    console.error('FAIL  no packaged Paper Trail.app in dist-electron');
    process.exit(1);
  }
  // Run against a COPY: Squirrel replaces the bundle it updates, and
  // the packaged original must stay pristine for the other tests
  // (ditto preserves the code signature; cp can drop xattrs).
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updcq-app-')),
    'Paper Trail.app');
  execFileSync('ditto', [packaged, app]);
  const bin = path.join(app, 'Contents', 'MacOS', 'Paper Trail');
  console.log(`cancel then quit: ${bundleVersion(app)} -> ${newVersion} (${os.arch()})`);

  const server = serveFeed();
  const eApp = await _electron.launch({
    executablePath: bin,
    args: [path.resolve(ROOT, 'sample', 'WStarCats.pdf')],
    env: {
      ...process.env as Record<string, string>,
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updcq-')),
      PT_SHOT: '1',
      PT_UPDATE_URL: 'http://127.0.0.1:8777',
    },
  });
  try {
    // Stub the unsaved-session prompt; the answer switches per phase.
    await eApp.evaluate(({ dialog }) => {
      (globalThis as { __ptChoice?: number }).__ptChoice = 2; // Cancel
      const seen: string[] = [];
      (globalThis as { __ptPrompts?: string[] }).__ptPrompts = seen;
      (dialog as { showMessageBoxSync: unknown }).showMessageBoxSync =
        (...args: unknown[]) => {
          const opts = (args.length > 1 ? args[1] : args[0]) as { message: string };
          seen.push(opts.message);
          return (globalThis as { __ptChoice?: number }).__ptChoice ?? 2;
        };
    });
    const docPage = await eApp.firstWindow();
    docPage.on('dialog', (d) => { d.dismiss().catch(() => { /* shell got it */ }); });
    await docPage.waitForFunction(
      () => !!(window as { __pt?: unknown }).__pt, undefined, { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 5000)); // let the PDF settle
    await docPage.evaluate(
      `window.__pt.jumpVia({ page: 2, yRatio: 0 }, 'cancel-quit-repro')`);

    // Through the window to the ready state.
    await eApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click();
    });
    let updatePage: Page | undefined;
    await waitFor(() => {
      updatePage = eApp.windows().find((p) => p.url().includes('update.html'));
      return !!updatePage;
    }, 30_000);
    if (!updatePage) {
      console.error('FAIL  the Software Update window never opened');
      process.exit(1);
    }
    await updatePage.waitForFunction(() => {
      const s = document.getElementById('pt-update-root')?.dataset.state;
      return s === 'available' || s === 'downloaded';
    }, undefined, { timeout: 120_000 });
    if (await updatePage.locator('#pt-update-root').getAttribute('data-state') === 'available') {
      await updatePage.locator('#pt-update-primary').click();
    }
    await updatePage.waitForFunction(
      () => document.getElementById('pt-update-root')?.dataset.state === 'downloaded',
      undefined, { timeout: 300_000 });

    // Restart → Cancel: abandoned.
    await updatePage.locator('#pt-update-primary').click();
    await new Promise((r) => setTimeout(r, 4000));
    const prompts = await eApp.evaluate(() =>
      (globalThis as { __ptPrompts?: string[] }).__ptPrompts ?? []);
    check('Cancel: the restart raised the save prompt and was abandoned',
      prompts.some((m) => m === SAVE_PROMPT)
        && await updatePage.locator('#pt-update-root').getAttribute('data-state') === 'downloaded');

    // Squirrel stages the update in the background; give it a moment
    // before quitting so the quit-install has something staged.
    await new Promise((r) => setTimeout(r, 45_000));

    // A PLAIN quit (Don't Save at the prompt) — not the Restart button.
    await eApp.evaluate(({ app: theApp }) => {
      (globalThis as { __ptChoice?: number }).__ptChoice = 1; // Don't Save
      theApp.quit();
    });
    const exited = await waitFor(() => !appRunning(bin), 60_000);
    check('the plain quit exits the app', exited);

    // It must stay closed: no self-relaunch while the update applies.
    let relaunched = false;
    for (let i = 0; i < 15 && !relaunched; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      relaunched = appRunning(bin);
    }
    check('the app stays closed (no self-relaunch)', !relaunched);
    if (relaunched) spawnSync('pkill', ['-f', bin]);

    // ...while the staged update applies on the way out.
    const updated = await waitFor(() => bundleVersion(app) === newVersion, 480_000);
    check('the update completes while the app is closed',
      updated, `bundle now ${bundleVersion(app) || '(unreadable)'}`);

    // Opening it again is just the new version.
    if (updated) {
      const smoke = spawnSync(bin, ['--smoke'], {
        timeout: 180_000,
        env: { ...process.env, PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-updcq2-')) },
      });
      check('the next open runs the new version cleanly', smoke.status === 0,
        `exit ${smoke.status}`);
    }
  } finally {
    await eApp.close().catch(() => { /* the app quit on its own */ });
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
