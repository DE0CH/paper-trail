// The installer must never force-close a running Paper Trail. When it
// asks the app to close, the request has to go through the app's
// normal close path — including the unsaved-session prompt — and the
// user's answer must win:
//   - Cancel keeps the app (and the unsaved session) alive, and the
//     installer errors out instead of killing it;
//   - Don't Save lets the app close and the install succeed.
// The prompt is stubbed, so nothing native appears on screen.
// Run (CI, Windows): node build-node/test/installerCloseUnsaved.js

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron, ElectronApplication } from 'playwright-core';

const ROOT = path.resolve(__dirname, '..', '..');
const PRODUCT = 'Paper Trail';
const SAVE_PROMPT = 'Do you want to save your reading session?';

// The shell answers the beforeunload dialog itself (the stubbed native
// prompt); playwright's automatic dialog dismissal races it and its
// ProtocolError ("No dialog is showing") must not kill the test.
process.on('unhandledRejection', (e) => {
  console.error('(unhandled rejection, continuing)', e);
});

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function ps(cmd: string): string {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', cmd],
    { encoding: 'utf8' }).trim();
}

function shortcutTarget(lnk: string): string {
  return ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`);
}

function findShortcut(): string | null {
  const candidates = [
    path.join(os.homedir(), 'Desktop', `${PRODUCT}.lnk`),
    path.join(os.homedir(), 'OneDrive', 'Desktop', `${PRODUCT}.lnk`),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * The installer must run WITHOUT blocking this process: the launched
 * app is debugger-attached, and its close path waits on playwright's
 * dialog handling — a spawnSync here would freeze that and stall the
 * very close the installer is waiting for.
 */
function runInstaller(installer: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(installer, ['/S'], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 300_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return cond();
}

/**
 * Launch the installed app with an open PDF, dirty the session, and
 * stub the synchronous unsaved-session prompt to the given answer
 * (2 = Cancel, 1 = Don't Save). Returns the app and the prompt log.
 */
async function launchDirty(exe: string, answer: number): Promise<ElectronApplication> {
  const eApp = await _electron.launch({
    executablePath: exe,
    args: [path.resolve(ROOT, 'sample', 'WStarCats.pdf')],
    env: {
      ...process.env as Record<string, string>,
      PT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-instcl-')),
      PT_SHOT: '1',
    },
  });
  await eApp.evaluate(({ dialog }, ans) => {
    const seen: string[] = [];
    (globalThis as { __ptSyncPrompts?: string[] }).__ptSyncPrompts = seen;
    (dialog as { showMessageBoxSync: unknown }).showMessageBoxSync =
      (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { message: string };
        seen.push(opts.message);
        return ans;
      };
  }, answer);
  const page = await eApp.firstWindow();
  // With a listener registered, playwright leaves dialogs alone. The
  // shell's stubbed native prompt is the real answerer, but this
  // response can land first, so it must agree with the phase: Cancel
  // keeps the page (dismiss), Don't Save lets the unload proceed
  // (accept).
  page.on('dialog', (d) => {
    (answer === 2 ? d.dismiss() : d.accept())
      .catch(() => { /* the shell answered first */ });
  });
  await page.waitForFunction(
    () => !!(window as { __pt?: unknown }).__pt, undefined, { timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 5000)); // let the PDF settle
  await page.evaluate(
    `window.__pt.jumpVia({ page: 2, yRatio: 0 }, 'installer-close-repro')`);
  await new Promise((r) => setTimeout(r, 1000));
  return eApp;
}

async function run(): Promise<void> {
  const distDir = path.join(ROOT, 'dist-electron');
  const setup = fs.readdirSync(distDir).find((f) => /Setup.*\.exe$/i.test(f));
  if (!setup) {
    console.error('FAIL  no Setup exe in dist-electron — package the app first');
    process.exit(1);
  }
  const installer = path.join(distDir, setup);

  spawnSync(installer, ['/S'], { timeout: 300_000 });
  const lnk = (await waitFor(() => findShortcut() !== null, 90_000))
    ? findShortcut() : null;
  const exe = lnk ? shortcutTarget(lnk) : '';
  if (!exe || !fs.existsSync(exe)) {
    console.error('FAIL  the app did not install');
    process.exit(1);
  }

  // Phase 1 — Cancel at the save prompt: the app must survive and the
  // installer must error out.
  const cancelApp = await launchDirty(exe, 2);
  const inst = await runInstaller(installer);
  check('the installer errors out when the app refuses to close',
    inst !== 0, `exit ${inst}`);
  let alive = true;
  let prompts: string[] = [];
  try {
    alive = await cancelApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length) >= 1;
    prompts = await cancelApp.evaluate(() =>
      (globalThis as { __ptSyncPrompts?: string[] }).__ptSyncPrompts ?? []);
  } catch {
    alive = false;
  }
  check('the running app was not force-closed', alive);
  check('the close request went through the unsaved-session prompt',
    prompts.some((m) => m === SAVE_PROMPT), prompts.join(' | ') || '(none)');

  // Clean shutdown for phase 2: answer Don't Save from now on — on
  // both answerers (the shell stub and the page dialog listener).
  if (alive) {
    await cancelApp.evaluate(({ dialog }) => {
      (dialog as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1;
    });
    const page1 = await cancelApp.firstWindow().catch(() => null);
    if (page1) {
      page1.removeAllListeners('dialog');
      page1.on('dialog', (d) => {
        d.accept().catch(() => { /* the shell answered first */ });
      });
    }
    await cancelApp.close().catch(() => { /* closing is the point */ });
    await waitFor(() =>
      spawnSync('tasklist', ['/FI', `IMAGENAME eq ${path.basename(exe)}`],
        { encoding: 'utf8' }).stdout.includes(path.basename(exe)) === false, 30_000);
  }

  // Phase 2 — Don't Save: the graceful close is accepted and the
  // install succeeds.
  await launchDirty(exe, 1);
  const inst2 = await runInstaller(installer);
  check('the installer succeeds when the close is accepted',
    inst2 === 0, `exit ${inst2}`);
  const gone = await waitFor(() =>
    !spawnSync('tasklist', ['/FI', `IMAGENAME eq ${path.basename(exe)}`],
      { encoding: 'utf8' }).stdout.includes(path.basename(exe)), 60_000);
  check('the app closed through the accepted prompt', gone);

  // Cleanup.
  const uninstaller = path.join(path.dirname(exe), `Uninstall ${PRODUCT}.exe`);
  if (fs.existsSync(uninstaller)) {
    spawnSync(uninstaller, ['/S'], { timeout: 300_000 });
    await waitFor(() => !fs.existsSync(exe), 90_000);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
