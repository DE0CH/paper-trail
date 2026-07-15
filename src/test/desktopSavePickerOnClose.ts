// Closing or quitting with a dirty NEVER-SAVED reading session and answering
// "Save…" at the confirm prompt must present the save-as location picker,
// write the .ptl there, and only then let the window/app go — it must never
// tear the window down first (the session would be lost).
//
// Unlike desktopSaveDialogOnClose.ts, this test does NOT stub the confirm
// prompt with an instant-return fake: the reported failure lives in the
// REAL dialog's nested modal event loop (an instant stub removes the nested
// loop, so the buggy synchronous implementation passes too — proven on CI).
// Here the REAL native message box is shown and answered by a native
// auto-clicker (System Events button click on macOS, a foreground ENTER on
// Windows — ENTER hits the default button, which is "Save…"). Only the
// save-as picker itself is stubbed, because whether that picker is ever
// REACHED with a live window is exactly the observable under test.
//
// Modes (PT_SDC_MODE):
//   close — the window-close path (X / Cmd+W): win.close()
//   quit  — the quit path (Cmd+Q / File→Exit): app.quit(). On macOS this
//           exercises before-quit → promptCloseAllWindows (whose per-window
//           grace timer must not abandon the quit while the user is inside a
//           close-flow dialog); the quit is judged by its re-entry after the
//           save. On Windows the quit machinery closes the window through
//           the same renderer flow and the verdict is delivered in will-quit.
//
// Run: npx electron build-node/test/desktopSavePickerOnClose.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-spc-'));
process.env.PT_SHOT = '1';

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog } from 'electron';

const MODE: 'close' | 'quit' = process.env.PT_SDC_MODE === 'quit' ? 'quit' : 'close';
const isMac = process.platform === 'darwin';
const t0 = Date.now();
const log = (msg: string): void => { console.log(`[spc +${Date.now() - t0}ms] ${msg}`); };

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-spc-out-'));
const savePath = path.join(outDir, 'reading.ptl');
// The auto-clicker stops as soon as this flag file exists (dialog answered).
const answeredFlag = path.join(outDir, 'answered.flg');

// ---- native auto-clicker: answers the REAL confirm dialog with "Save…" ----
// Spawned right before the real dialog opens; waits a beat (a user reading
// the prompt — long enough to outlast promptCloseAllWindows' grace timer),
// then presses the default "Save…" until the dialog reports answered.
function spawnClicker(): void {
  fs.rmSync(answeredFlag, { force: true });
  if (isMac) {
    const script = `
      on run argv
        set flagPath to item 1 of argv
        delay 2.5
        repeat 100 times
          try
            do shell script "test -e " & quoted form of flagPath
            return "clicked"
          end try
          try
            tell application "System Events" to tell process "Electron"
              click (first button of sheet 1 of window 1 whose name begins with "Save")
            end tell
          end try
          try
            tell application "System Events" to tell process "Electron"
              click (first button of window 1 whose name begins with "Save")
            end tell
          end try
          delay 0.3
        end repeat
        try
          tell application "System Events" to tell process "Electron"
            set diag to "windows=" & (count of windows)
            try
              set diag to diag & " sheetButtons=" & ((name of every button of sheet 1 of window 1) as string)
            end try
            try
              set diag to diag & " winButtons=" & ((name of every button of window 1) as string)
            end try
          end tell
          log diag
        end try
        return "gave-up"
      end run`;
    spawn('osascript', ['-e', script, answeredFlag], { stdio: 'inherit' });
  } else {
    const ps = `
      Start-Sleep -Milliseconds 2500
      $ws = New-Object -ComObject WScript.Shell
      for ($i = 0; $i -lt 100; $i++) {
        if (Test-Path '${answeredFlag.replace(/\\/g, '\\\\').replace(/'/g, "''")}') { Write-Output 'clicked'; exit 0 }
        $null = $ws.AppActivate(${process.pid})
        Start-Sleep -Milliseconds 150
        $ws.SendKeys('{ENTER}')
        Start-Sleep -Milliseconds 350
      }
      Write-Output 'gave-up'`;
    const psFile = path.join(outDir, 'clicker.ps1');
    fs.writeFileSync(psFile, ps, 'utf8');
    spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { stdio: 'inherit' });
  }
}

// ---- dialog instrumentation (REAL confirm, stubbed location picker) --------
const realMsgSync = dialog.showMessageBoxSync.bind(dialog);
const realMsgAsync = dialog.showMessageBox.bind(dialog);
let confirmShown = 0;
let confirmAnswered = 0;
const saveDialogCalls: { winAlive: boolean }[] = [];

type AnyWin = BrowserWindow | Electron.MessageBoxOptions;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dialog as any).showMessageBoxSync = (win: AnyWin, opts?: Electron.MessageBoxOptions): number => {
  confirmShown += 1;
  log(`confirm dialog OPEN (sync): ${String((opts ?? (win as Electron.MessageBoxOptions))?.message)}`);
  spawnClicker();
  const r = realMsgSync(win as BrowserWindow, opts as Electron.MessageBoxOptions);
  confirmAnswered += 1;
  fs.writeFileSync(answeredFlag, '1');
  log(`confirm dialog ANSWERED (sync): choice=${r}`);
  return r;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dialog as any).showMessageBox = async (win: AnyWin, opts?: Electron.MessageBoxOptions):
Promise<Electron.MessageBoxReturnValue> => {
  confirmShown += 1;
  log(`confirm dialog OPEN (async): ${String((opts ?? (win as Electron.MessageBoxOptions))?.message)}`);
  spawnClicker();
  const r = await realMsgAsync(win as BrowserWindow, opts as Electron.MessageBoxOptions);
  confirmAnswered += 1;
  fs.writeFileSync(answeredFlag, '1');
  log(`confirm dialog ANSWERED (async): response=${r.response}`);
  return r;
};
// The location picker is the OBSERVABLE: reached-or-not (and with a live
// window or not) is what discriminates the data loss, so a deterministic
// stub standing in for "the user picked a location" is faithful here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dialog as any).showSaveDialog = async (win: BrowserWindow):
Promise<{ canceled: boolean; filePath: string }> => {
  const winAlive = !!win && !win.isDestroyed();
  saveDialogCalls.push({ winAlive });
  log(`save-as picker reached: winAlive=${winAlive}`);
  return { canceled: false, filePath: savePath };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const finish = (): void => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Common verdict: the picker was reached with a live window and the .ptl
// landed where the user chose. FAILS on the data-loss bug (window torn down
// after "Save…", picker never reached, nothing written).
function checkSaveHappened(): void {
  check('the confirm prompt was shown', confirmShown >= 1, `confirmShown=${confirmShown}`);
  check('the confirm prompt was answered (auto-clicker worked)',
    confirmAnswered >= 1, `confirmAnswered=${confirmAnswered}`);
  check('choosing Save… reached the save-as location picker',
    saveDialogCalls.length >= 1, `saveDialogCalls=${saveDialogCalls.length}`);
  check('the picker was presented on a live (not torn-down) window',
    saveDialogCalls.length >= 1 && saveDialogCalls.every((c) => c.winAlive),
    JSON.stringify(saveDialogCalls));
  const written = fs.existsSync(savePath);
  check('the session .ptl was written to the chosen location', written, savePath);
  if (written) {
    const text = fs.readFileSync(savePath, 'utf8');
    check('the written session holds the unsaved change',
      text.includes('save-me'), `${text.length} bytes`);
  }
}

// Windows quit path: if the quit machinery gets all the way to will-quit,
// the app IS quitting — at that moment the save must already be on disk.
// (On the data-loss bug the window is torn down unsaved, window-all-closed
// quits, and this fires with nothing written.) On macOS the harness holds
// the quit open instead and judges in run().
let beforeQuitCount = 0;
app.on('before-quit', (e) => {
  beforeQuitCount += 1;
  log(`before-quit #${beforeQuitCount}`);
  // Keep the harness alive to run its assertions — except for the Windows
  // quit verdict, which is delivered in will-quit below.
  if (isMac || MODE !== 'quit') e.preventDefault();
});
if (!isMac && MODE === 'quit') {
  app.on('will-quit', (e) => {
    e.preventDefault(); // judge first; app.exit() below actually leaves
    log('will-quit: the app is quitting — judging now');
    checkSaveHappened();
    finish();
  });
}

const pdfB64 = fs
  .readFileSync(path.resolve(__dirname, '..', '..', 'sample', 'cjk.pdf'))
  .toString('base64');

async function run(): Promise<void> {
  let win: BrowserWindow | undefined;
  for (let i = 0; i < 80 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0];
    if (!win) await sleep(500);
  }
  if (!win) { check('a window opened', false); finish(); return; }
  for (let i = 0; i < 80; i += 1) {
    const ready = await win.webContents
      .executeJavaScript('!!(window.__pt && window.__pt.controller && window.__pt.jumpVia)')
      .catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  const theWin = win;

  // Event trace, so a red run shows exactly how the teardown outran the save.
  theWin.on('close', () => log('window event: close'));
  let fileAtClosed: boolean | null = null;
  theWin.once('closed', () => {
    fileAtClosed = fs.existsSync(savePath);
    log(`window event: closed (ptl on disk at that moment: ${fileAtClosed})`);
  });
  theWin.webContents.on('will-prevent-unload', () => log('webContents: will-prevent-unload'));
  theWin.webContents.on('destroyed', () => log('webContents: destroyed'));
  app.on('window-all-closed', () => log('app event: window-all-closed'));

  // A fresh PDF, made dirty, never saved -> unbound (no path, no handle).
  const state = await theWin.webContents.executeJavaScript(`(async () => {
    const pt = window.__pt;
    const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
    await pt.controller.openFile(new File([bytes], 'cjk.pdf'));
    await new Promise((r) => setTimeout(r, 800));
    pt.jumpVia({ page: 1, yRatio: 0.5 }, 'save-me');
    await new Promise((r) => setTimeout(r, 200));
    return { path: pt.session.path, hasHandle: !!pt.session.handle, dirty: pt.session.dirty };
  })()`) as { path: string | null; hasHandle: boolean; dirty: boolean };
  check('the fresh session is dirty and unbound (no path, no handle)',
    state.path == null && !state.hasHandle && state.dirty, JSON.stringify(state));
  await sleep(500); // let pt-document-edited reach the main process

  log(`driving the ${MODE} path`);
  if (MODE === 'close') theWin.close();
  else app.quit();

  // Wait for the flow to settle: the .ptl written AND the window gone —
  // or a teardrown/stall timeout.
  for (let i = 0; i < 240; i += 1) {
    if (fs.existsSync(savePath) && theWin.isDestroyed()) break;
    if (i % 20 === 19) {
      log(`waiting… winDestroyed=${theWin.isDestroyed()} ptl=${fs.existsSync(savePath)} `
        + `confirm=${confirmShown}/${confirmAnswered} picker=${saveDialogCalls.length}`);
    }
    await sleep(500);
  }

  checkSaveHappened();
  check('the window closed after the save (no lingering window)',
    theWin.isDestroyed(), `destroyed=${theWin.isDestroyed()}`);
  check('the .ptl was already on disk when the window closed',
    fileAtClosed === true, `fileAtClosed=${fileAtClosed}`);

  if (MODE === 'quit' && isMac) {
    // The quit must COMPLETE after the save: before-quit re-enters once every
    // window has agreed (quitApproved). If the per-window grace timer expired
    // while the user sat in a dialog, the quit is silently abandoned and this
    // re-entry never comes.
    for (let i = 0; i < 30 && beforeQuitCount < 2; i += 1) await sleep(500);
    check('the quit went through after the save (before-quit re-entered)',
      beforeQuitCount >= 2, `beforeQuitCount=${beforeQuitCount}`);
  }
  finish();
}

// Belt-and-suspenders: if the flow wedges with no dialog blocking the loop,
// fail with the trace instead of hanging until the job timeout.
setTimeout(() => {
  log('WATCHDOG: the test did not settle in time');
  checkSaveHappened();
  check('the flow settled before the watchdog', false);
  finish();
}, 240_000);

void app.whenReady().then(() => run().catch((e: unknown) => {
  console.error('FAIL  desktopSavePickerOnClose errored', e);
  app.exit(1);
}));
