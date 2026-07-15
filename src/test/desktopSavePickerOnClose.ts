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
// Windows — ENTER hits the default button, which is "Save…") after the ~2.5s
// a real user takes to read the prompt. Only the save-as picker itself is
// stubbed, and FAITHFULLY: it "picks" the location after the ~1s a user
// needs, and a picker whose parent window has been torn down cannot deliver
// a choice — it cancels, exactly like the real one. Whether the picker is
// reached, survives, and delivers is the observable under test.
//
// Modes (PT_SDC_MODE):
//   close        — the window-close path (X / Cmd+W): win.close(), plus a
//                  second close mid-prompt (must not stack a second prompt).
//   quit         — the quit path (Cmd+Q / File→Exit): app.quit(). On macOS
//                  this exercises before-quit → promptCloseAllWindows (which
//                  must not abandon the quit while the user sits in a
//                  close-flow dialog); the quit is judged by its re-entry
//                  after the save. On Windows the quit machinery closes the
//                  window through the same renderer flow and the verdict is
//                  delivered in will-quit.
//   save-fails   — the bound handle's write throws: choosing "Save…" must
//                  surface a failure toast and KEEP the window (no unhandled
//                  rejection, no teardown, session still dirty).
//   stale-edited — (macOS) a dirty window closed via the don't-save path
//                  must not leave a stale edited-window entry that makes a
//                  later quit with zero windows run a phantom close cycle.
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

type Mode = 'close' | 'quit' | 'save-fails' | 'stale-edited';
const MODE: Mode = (['close', 'quit', 'save-fails', 'stale-edited'] as const)
  .find((m) => m === process.env.PT_SDC_MODE) ?? 'close';
const isMac = process.platform === 'darwin';
const t0 = Date.now();
const log = (msg: string): void => { console.log(`[spc +${Date.now() - t0}ms] ${msg}`); };

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-spc-out-'));
const savePath = path.join(outDir, 'reading.ptl');
// The auto-clicker stops as soon as this flag file exists (dialog answered).
const answeredFlag = path.join(outDir, 'answered.flg');

// ---- native auto-clicker: answers the REAL confirm dialog with "Save…" ----
// Spawned right before the real dialog opens; waits the ~2.5s a real user
// takes to read the prompt, then presses the default "Save…" until the
// dialog reports answered.
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
    // The dialog is Electron's native TaskDialog. A foreground ENTER
    // (AppActivate + SendKeys) needs the dialog to actually HOLD the
    // foreground, which the windows-11-arm runner's session never grants
    // to the showInactive()-launched test app — 100 ENTERs landed nowhere
    // and the prompt sat unanswered. UI Automation invokes the "Save…"
    // button directly, no foreground required; the ENTER stays as a
    // fallback and the loop logs what it can see, so a run where the
    // dialog never materializes is distinguishable from a click that
    // cannot land.
    const ps = `
      Start-Sleep -Milliseconds 2500
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $ws = New-Object -ComObject WScript.Shell
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $pidCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${process.pid})
      $btnCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
      for ($i = 0; $i -lt 100; $i++) {
        if (Test-Path '${answeredFlag.replace(/\\/g, '\\\\').replace(/'/g, "''")}') { Write-Output 'clicked'; exit 0 }
        $seen = @()
        try {
          # Any window class (TaskDialog is #32770, but never assume): the
          # confirm prompt is identified by its BUTTON SET — it is the only
          # window holding both a "Save…" and a "Don't Save" button. That
          # also keeps the renderer's own toolbar "Save" button (reachable
          # through the app window's accessibility tree) untouchable.
          $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond)
          foreach ($w in $wins) {
            $btns = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
            $names = @(); foreach ($b in $btns) { $names += $b.Current.Name }
            $seen += $names
            $isConfirm = ($names -like 'Save*').Count -ge 1 -and ($names -like 'Don*').Count -ge 1
            if ($isConfirm) {
              foreach ($b in $btns) {
                if ($b.Current.Name -like 'Save*') {
                  $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                  Write-Output ('uia-invoked: ' + $b.Current.Name + ' in ' + $w.Current.ClassName)
                  Start-Sleep -Milliseconds 500
                  break
                }
              }
            }
          }
        } catch { Write-Output ('uia-error: ' + $_.Exception.Message) }
        if (Test-Path '${answeredFlag.replace(/\\/g, '\\\\').replace(/'/g, "''")}') { Write-Output 'clicked'; exit 0 }
        # Fallbacks: activate the DIALOG by its bare title ('Paper Trail';
        # the app window is '<file> - Paper Trail'), else the process, then
        # ENTER (the default button is "Save…").
        $act = $ws.AppActivate('Paper Trail')
        if (-not $act) { $act = $ws.AppActivate(${process.pid}) }
        Start-Sleep -Milliseconds 150
        try { $ws.SendKeys('{ENTER}') } catch {}
        if ($i % 10 -eq 9) {
          $head = @($seen | Select-Object -First 12)
          Write-Output ('clicker probe #' + $i + ' appActivate=' + $act + ' buttons(' + $seen.Count + ')=[' + ($head -join '; ') + ']')
          # Diagnosis: what top-level windows does this PROCESS have (any
          # class), and can UIA see the desktop at all? Distinguishes a
          # dialog under another class / a dialog never created / a blind
          # UIA session.
          try {
            $mine = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond)
            $desc = @()
            foreach ($w in $mine) { $desc += ($w.Current.ClassName + ':' + $w.Current.Name) }
            Write-Output ('  process windows=[' + ($desc -join '; ') + ']')
            $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
              [System.Windows.Automation.Condition]::TrueCondition)
            Write-Output ('  desktop top-level windows=' + $all.Count)
          } catch { Write-Output ('  diag-error: ' + $_.Exception.Message) }
        }
        Start-Sleep -Milliseconds 350
      }
      Write-Output 'gave-up'`;
    const psFile = path.join(outDir, 'clicker.ps1');
    fs.writeFileSync(psFile, ps, 'utf8');
    spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { stdio: 'inherit' });
  }
}

// ---- dialog instrumentation (REAL confirm, faithful location picker) ------
const realMsgSync = dialog.showMessageBoxSync.bind(dialog);
const realMsgAsync = dialog.showMessageBox.bind(dialog);
let confirmShown = 0;
let confirmAnswered = 0;
const saveDialogCalls: { aliveAtCall: boolean; aliveAtPick: boolean; delivered: boolean }[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
// The location picker is the OBSERVABLE, stubbed but FAITHFUL: a user needs
// about a second to pick a location, and a picker whose parent window has
// been destroyed in the meantime can never deliver a choice — it cancels,
// exactly like the real sheet/dialog would. (An instant-return stub here
// would hide the teardown race the same way the old test's stubs did.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dialog as any).showSaveDialog = async (win: BrowserWindow):
Promise<{ canceled: boolean; filePath: string }> => {
  const aliveAtCall = !!win && !win.isDestroyed();
  log(`save-as picker reached: winAlive=${aliveAtCall}`);
  await sleep(1000); // the user picking a location
  const aliveAtPick = !!win && !win.isDestroyed();
  const delivered = aliveAtCall && aliveAtPick;
  saveDialogCalls.push({ aliveAtCall, aliveAtPick, delivered });
  log(`save-as picker ${delivered ? 'delivered a location' : 'CANCELED (window gone)'}: `
    + `aliveAtCall=${aliveAtCall} aliveAtPick=${aliveAtPick}`);
  if (!delivered) return { canceled: true, filePath: '' };
  return { canceled: false, filePath: savePath };
};

// ---- environment canary ----------------------------------------------
// The windows-11-arm runner never CREATES a native message-box window at
// all: UIA showed the process keeping exactly one top-level window for
// the whole life of a pending showMessageBox promise (probe runs
// 29411888604 / 29412677536), so no clicker of any kind can answer it.
// Before judging the save flow, prove the environment can display and
// answer a native dialog: show a parentless canary and auto-answer it.
// No dialog window in 10s ⇒ the runner cannot display native dialogs
// (the Depot-mac assistive-access analog) and the mode SELF-SKIPS with
// an explicit reason. If the canary works, a later unanswered real
// dialog is a genuine defect and the assertions stand.
const canaryFlag = path.join(outDir, 'canary.flg');
function spawnCanaryClicker(): void {
  if (isMac) return;
  const ps = `
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $pidCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${process.pid})
    $btnCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button)
    $ws = New-Object -ComObject WScript.Shell
    for ($i = 0; $i -lt 25; $i++) {
      if (Test-Path '${canaryFlag.replace(/\\/g, '\\\\').replace(/'/g, "''")}') { Write-Output 'canary-clicked'; exit 0 }
      try {
        $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond)
        foreach ($w in $wins) {
          # The canary is the process's only native (#32770) window; any
          # button inside it is the canary button — invoke whatever is there
          # and LOG the names, so a mismatch is visible in the transcript.
          if ($w.Current.ClassName -ne '#32770') { continue }
          $btns = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
          $names = @(); foreach ($b in $btns) { $names += $b.Current.Name }
          Write-Output ('canary dialog buttons=[' + ($names -join '; ') + ']')
          foreach ($b in $btns) {
            try {
              $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
              Write-Output ('canary-invoked: ' + $b.Current.Name)
            } catch { Write-Output ('canary-invoke-error: ' + $_.Exception.Message) }
          }
          # Foreground fallback aimed at the DIALOG title (the main window
          # is 'cjk.pdf - Paper Trail'; the dialog is plain 'Paper Trail').
          if ($btns.Count -eq 0) {
            $null = $ws.AppActivate('Paper Trail')
            Start-Sleep -Milliseconds 100
            try { $ws.SendKeys('{ENTER}') } catch {}
          }
        }
      } catch { Write-Output ('canary-uia-error: ' + $_.Exception.Message) }
      if ($i -eq 12) {
        $desc = @()
        try {
          $mine = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond)
          foreach ($w in $mine) { $desc += ($w.Current.ClassName + ':' + $w.Current.Name) }
        } catch {}
        Write-Output ('canary probe: process windows=[' + ($desc -join '; ') + ']')
      }
      Start-Sleep -Milliseconds 400
    }
    Write-Output 'canary-gave-up'`;
  const psFile = path.join(outDir, 'canary.ps1');
  fs.writeFileSync(psFile, ps, 'utf8');
  spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
    { stdio: 'inherit' });
}
async function dialogEnvCanary(): Promise<boolean> {
  if (isMac) return true; // mac legs answer real dialogs via System Events
  fs.rmSync(canaryFlag, { force: true });
  spawnCanaryClicker();
  const shown = (realMsgAsync as unknown as
    (o: Electron.MessageBoxOptions) => Promise<Electron.MessageBoxReturnValue>)({
      type: 'info', buttons: ['CanaryOK'], message: 'Paper Trail dialog canary',
    }).then(() => true as const, () => true as const);
  const ok = await Promise.race([shown, sleep(10_000).then(() => false as const)]);
  fs.writeFileSync(canaryFlag, '1');
  log(`dialog canary: ${ok
    ? 'answered — this environment displays native dialogs'
    : 'NO dialog window materialized in 10s — native dialogs unavailable here'}`);
  return ok;
}

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

// Written-and-complete: the .ptl exists AND holds the unsaved change.
const ptlComplete = (): boolean => {
  try { return fs.readFileSync(savePath, 'utf8').includes('save-me'); } catch { return false; }
};

// Common verdict for the save paths: the picker was reached on a live window,
// stayed live long enough for the user to pick, and the .ptl landed BEFORE
// the window went. FAILS on the data-loss bug (teardown outruns the picker).
function checkSaveHappened(): void {
  check('the confirm prompt was shown (exactly once — no stacked prompts)',
    confirmShown === 1, `confirmShown=${confirmShown}`);
  check('the confirm prompt was answered (auto-clicker worked)',
    confirmAnswered >= 1, `confirmAnswered=${confirmAnswered}`);
  check('choosing Save… reached the save-as location picker',
    saveDialogCalls.length >= 1, `saveDialogCalls=${saveDialogCalls.length}`);
  check('the window survived the picker and the pick was delivered',
    saveDialogCalls.length >= 1 && saveDialogCalls.every((c) => c.delivered),
    JSON.stringify(saveDialogCalls));
  check('the session .ptl was written to the chosen location, complete',
    ptlComplete(), savePath);
}

// Windows quit path: if the quit machinery gets all the way to will-quit,
// the app IS quitting — at that moment the save must already be complete on
// disk. (On the data-loss bug the window is torn down unsaved, the picker
// never delivers, and this fires with nothing written.) On macOS the harness
// holds the quit open instead and judges in run().
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

async function openDirtyUnsaved(win: BrowserWindow): Promise<void> {
  const state = await win.webContents.executeJavaScript(`(async () => {
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
}

async function waitFor(cond: () => boolean, halfSeconds: number, label: string): Promise<void> {
  for (let i = 0; i < halfSeconds; i += 1) {
    if (cond()) return;
    if (i % 20 === 19) log(`waiting on ${label}…`);
    await sleep(500);
  }
}

async function run(): Promise<void> {
  if (MODE === 'stale-edited' && !isMac) {
    check('stale-edited mode is macOS-only (skipped)', true);
    finish();
    return;
  }

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
  let ptlCompleteAtClosed: boolean | null = null;
  theWin.once('closed', () => {
    ptlCompleteAtClosed = ptlComplete();
    log(`window event: closed (complete .ptl on disk at that moment: ${ptlCompleteAtClosed})`);
  });
  theWin.webContents.on('will-prevent-unload', () => log('webContents: will-prevent-unload'));
  theWin.webContents.on('destroyed', () => log('webContents: destroyed'));
  app.on('window-all-closed', () => log('app event: window-all-closed'));

  // close / quit / save-fails all hinge on answering the REAL confirm
  // dialog; prove the environment can show one first (see dialogEnvCanary).
  // PT_SPC_NO_SKIP: diagnostic override — log the canary verdict but run
  // the real flow anyway (used to probe the parented-dialog behavior).
  if (MODE !== 'stale-edited' && !(await dialogEnvCanary())
      && !process.env.PT_SPC_NO_SKIP) {
    check('SKIPPED: this runner cannot display native dialogs '
      + '(no window materialized for a parentless canary)', true);
    finish();
    return;
  }

  if (MODE === 'save-fails') { await runSaveFails(theWin); return; }
  if (MODE === 'stale-edited') { await runStaleEdited(theWin); return; }

  await openDirtyUnsaved(theWin);

  log(`driving the ${MODE} path`);
  if (MODE === 'close') {
    theWin.close();
    // A second close mid-prompt (the user hits Cmd+W again while the dialog
    // is up) must not stack a second confirm prompt. Drive it from the
    // RENDERER (window.close → beforeunload), the way a real second close
    // arrives — a second main-process win.close() would instead cancel the
    // macOS window-modal sheet, which is a harness artifact, not the flow.
    setTimeout(() => {
      if (!theWin.isDestroyed()) {
        log('second close mid-prompt (renderer window.close)');
        theWin.webContents.executeJavaScript('window.close()').catch(() => { /* closing */ });
      }
    }, 700);
  } else {
    app.quit();
  }

  // Let the flow settle: a complete .ptl AND the window gone.
  await waitFor(() => ptlComplete() && theWin.isDestroyed(), 240,
    `settle (winDestroyed=${theWin.isDestroyed()} ptl=${ptlComplete()})`);

  checkSaveHappened();
  check('the window closed after the save (no lingering window)',
    theWin.isDestroyed(), `destroyed=${theWin.isDestroyed()}`);
  check('the complete .ptl was already on disk when the window closed',
    ptlCompleteAtClosed === true, `ptlCompleteAtClosed=${ptlCompleteAtClosed}`);

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

// "Save…" on a session whose bound handle write THROWS: the failure must be
// caught and surfaced (toast), the window must stay open, and nothing may
// escape as an unhandled rejection. (The write failing is exactly how the
// confirm dialog got shown in the first place.)
async function runSaveFails(theWin: BrowserWindow): Promise<void> {
  const state = await theWin.webContents.executeJavaScript(`(async () => {
    const pt = window.__pt;
    const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
    await pt.controller.openFile(new File([bytes], 'cjk.pdf'));
    await new Promise((r) => setTimeout(r, 800));
    // A bound handle whose write always fails (e.g. disk full / gone volume).
    pt.session.handle = {
      name: 'boom.ptl',
      queryPermission: async () => 'granted',
      createWritable: async () => { throw new Error('disk full (test)'); },
    };
    pt.session.path = null;
    pt.jumpVia({ page: 1, yRatio: 0.5 }, 'save-me');
    // Observe what the close flow does with the failure.
    window.__spcUnhandled = 0;
    window.addEventListener('unhandledrejection', () => { window.__spcUnhandled += 1; });
    window.__spcToasts = [];
    const orig = pt.controller.showToast.bind(pt.controller);
    pt.controller.showToast = (msg, ms) => { window.__spcToasts.push(String(msg)); orig(msg, ms); };
    await new Promise((r) => setTimeout(r, 200));
    return { dirty: pt.session.dirty, hasHandle: !!pt.session.handle };
  })()`) as { dirty: boolean; hasHandle: boolean };
  check('the session is dirty and handle-bound (write will throw)',
    state.dirty && state.hasHandle, JSON.stringify(state));
  await sleep(500);

  log('driving the close path (failing save)');
  theWin.close();

  // The confirm prompt fires (silent save failed), the clicker answers
  // "Save…", the handle write throws again. Give the flow time to settle.
  await waitFor(() => confirmAnswered >= 1, 60, 'the confirm prompt');
  await sleep(3000);

  check('the confirm prompt was shown and answered',
    confirmShown >= 1 && confirmAnswered >= 1,
    `shown=${confirmShown} answered=${confirmAnswered}`);
  check('a failed Save… keeps the window open (no teardown, no silent loss)',
    !theWin.isDestroyed(), `destroyed=${theWin.isDestroyed()}`);
  if (theWin.isDestroyed()) { finish(); return; }
  const after = await theWin.webContents.executeJavaScript(`({
    unhandled: window.__spcUnhandled,
    toasts: window.__spcToasts,
    dirty: window.__pt.session.dirty,
  })`) as { unhandled: number; toasts: string[]; dirty: boolean };
  check('the failure did not escape as an unhandled rejection',
    after.unhandled === 0, `unhandled=${after.unhandled}`);
  check('the failure was surfaced to the user (a save-failed toast)',
    after.toasts.some((tst) => /save failed/i.test(tst)), JSON.stringify(after.toasts));
  check('the session stayed dirty (nothing pretended to save)',
    after.dirty === true, `dirty=${after.dirty}`);
  finish();
}

// macOS: a dirty window closed via the don't-save path (forceClose) must be
// PRUNED from the edited-windows set — a later quit with no windows left must
// take the nothing-unsaved fast path, not run a phantom close-all cycle.
async function runStaleEdited(theWin: BrowserWindow): Promise<void> {
  await openDirtyUnsaved(theWin);
  log('closing via the don’t-save path (forceClose)');
  await theWin.webContents.executeJavaScript(
    '(() => { window.__pt.controller.forceClose = true; window.close(); })()');
  await waitFor(() => theWin.isDestroyed(), 40, 'the window to close');
  check('the window closed without a prompt', theWin.isDestroyed() && confirmShown === 0,
    `destroyed=${theWin.isDestroyed()} confirmShown=${confirmShown}`);

  log('quitting with no windows left');
  app.quit();
  await sleep(4000);
  // With a stale edited-window entry, before-quit runs the close-all cycle
  // over zero windows and re-enters (count 2). Pruned correctly, the
  // nothing-unsaved fast path quits directly (a single before-quit, held
  // open only by this harness).
  check('quit with no windows takes the nothing-unsaved fast path',
    beforeQuitCount === 1, `beforeQuitCount=${beforeQuitCount}`);
  finish();
}

// Belt-and-suspenders: if the flow wedges with no dialog blocking the loop,
// fail with the trace instead of hanging until the job timeout.
setTimeout(() => {
  log('WATCHDOG: the test did not settle in time');
  check('the flow settled before the watchdog', false);
  finish();
}, 240_000);

void app.whenReady().then(() => run().catch((e: unknown) => {
  console.error('FAIL  desktopSavePickerOnClose errored', e);
  app.exit(1);
}));
