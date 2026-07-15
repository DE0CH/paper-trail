// Verifies the installer's shortcut choices end to end on a real system:
//   - a SILENT install (/S — the auto-update and CI path) still creates
//     BOTH shortcuts, exactly as before the choice page existed,
//   - the ASSISTED installer shows a Shortcuts page with two checkboxes
//     (desktop and Start Menu, both preselected),
//   - unticking "Create a desktop shortcut" and completing the install
//     leaves NO desktop shortcut while the Start Menu one exists.
// The assisted run drives the real Setup UI through UI Automation
// (windows-latest only: the arm runner's session cannot drive foreground
// installer windows, so the assisted scenario is skipped there).
// Run (CI, Windows, after packaging): node build-node/test/installerShortcutChoices.js

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const PRODUCT = 'Paper Trail';

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

/** Resolve a .lnk file's target via the shell COM object. */
function shortcutTarget(lnk: string): string {
  return ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`);
}

function findDesktopShortcut(): string | null {
  const candidates = [
    path.join(os.homedir(), 'Desktop', `${PRODUCT}.lnk`),
    path.join(os.homedir(), 'OneDrive', 'Desktop', `${PRODUCT}.lnk`),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const startMenuShortcut = path.join(process.env.APPDATA ?? '',
  'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT}.lnk`);

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return cond();
}

/** Silent uninstall via the installed uninstaller; waits for cleanup. */
async function uninstall(): Promise<void> {
  const lnk = fs.existsSync(startMenuShortcut) ? startMenuShortcut : findDesktopShortcut();
  if (!lnk) return;
  const exe = shortcutTarget(lnk);
  if (!exe) return;
  // let stray app processes (a Run-after-finish slip) drain, then make sure
  const image = path.basename(exe);
  await waitFor(() => !spawnSync('tasklist',
    ['/FI', `IMAGENAME eq ${image}`], { encoding: 'utf8' })
    .stdout.includes(image), 30_000);
  spawnSync('taskkill', ['/IM', image, '/F'], { encoding: 'utf8' });
  const uninstaller = path.join(path.dirname(exe), `Uninstall ${PRODUCT}.exe`);
  if (!fs.existsSync(uninstaller)) return;
  spawnSync(uninstaller, ['/S'], { timeout: 300_000 });
  await waitFor(() => !fs.existsSync(exe) && findDesktopShortcut() === null
    && !fs.existsSync(startMenuShortcut), 90_000);
}

// Walks the ASSISTED installer via UI Automation: keeps the per-user
// install mode, records every checkbox it sees, unticks the desktop
// shortcut checkbox and the finish page's Run option, and advances with
// Next/Install/Finish until the installer process exits. The Setup
// window is matched by process id OR by its dialog class + title (the
// savePickerOnClose clicker's lesson: never assume, and log what UIA
// can see so a blind run is distinguishable from a click that missed).
const DRIVER_PS1 = `
param([Parameter(Mandatory=$true)][int]$InstallerPid)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$auto = [System.Windows.Automation.AutomationElement]
$root = $auto::RootElement
$any = [System.Windows.Automation.Condition]::TrueCondition
$children = [System.Windows.Automation.TreeScope]::Children
$descend = [System.Windows.Automation.TreeScope]::Descendants
# NSIS controls surface to (managed) UIA as bare Panes with NO patterns
# (run 29431132327's probes), and posted BM_CLICKs did not advance the
# custom page (run 29432270661), so UIA is only the finder: state is
# read via BM_GETCHECK and every action is a REAL mouse click at the
# control's screen rectangle, exactly what a user does.
Add-Type -Namespace PT -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
'@
$BM_GETCHECK = 0x00F0
function ClickAt([System.Windows.Automation.AutomationElement]$el) {
  $r = $el.Current.BoundingRectangle
  if ($r.Width -le 0 -or $r.Height -le 0) { return $false }
  [PT.Win]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) | Out-Null
  Start-Sleep -Milliseconds 60
  [PT.Win]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [PT.Win]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  return $true
}
$seen = @{}
function Note([string]$line) {
  if (-not $script:seen.ContainsKey($line)) { $script:seen[$line] = $true; Write-Output $line }
}
for ($i = 0; $i -lt 400; $i++) {
  if (-not (Get-Process -Id $InstallerPid -ErrorAction SilentlyContinue)) { Write-Output 'installer-exited'; exit 0 }
  try {
    $all = $root.FindAll($children, $any)
    $wins = @()
    foreach ($w in $all) {
      if ($w.Current.ProcessId -eq $InstallerPid) { $wins += $w; continue }
      if ($w.Current.ClassName -eq '#32770' -and $w.Current.Name -like 'Paper Trail*') { $wins += $w }
    }
    # unconditional probe: what UIA can see must always reach the log,
    # so a blind run is distinguishable from a click that missed
    if ($i % 15 -eq 4) {
      $desc = @()
      foreach ($w in $all) {
        $wn = [string]$w.Current.Name
        $desc += ('' + $w.Current.ProcessId + ':' + $w.Current.ClassName + ':' + $wn.Substring(0, [Math]::Min(30, $wn.Length)))
      }
      Write-Output ('probe #' + $i + ' wins=' + $wins.Count + ' top-level=' + $all.Count + ' [' + (($desc | Select-Object -First 12) -join '; ') + ']')
    }
    foreach ($w in $wins) {
      # controls are matched by NAME, never by control type: the
      # NSIS-to-UIA type mapping is bare Panes and not worth trusting
      [PT.Win]::SetForegroundWindow([IntPtr]$w.Current.NativeWindowHandle) | Out-Null
      $controls = $w.FindAll($descend, $any)
      if ($i % 15 -eq 4) { Write-Output ('  win "' + $w.Current.Name + '" descendants=' + $controls.Count) }
      $clickables = @{}
      $toggled = $false
      foreach ($c in $controls) {
        $n = [string]$c.Current.Name
        if (-not $n) { continue }
        $short = $n.Substring(0, [Math]::Min(40, $n.Length))
        Note ('control: ' + $c.Current.ControlType.ProgrammaticName + ':' + $short)
        $h = [IntPtr]$c.Current.NativeWindowHandle
        if ($h -eq [IntPtr]::Zero) { continue }
        if ($n -match 'desktop shortcut' -or $n -match 'start menu shortcut' -or $n -match '^Run ') {
          Note ('checkbox: ' + $short)
        }
        # untick the desktop shortcut (the scenario) and Run-after-finish
        # (so the installed app does not launch and block the uninstall);
        # a real click, re-verified by BM_GETCHECK on the next poll
        if ($n -match 'desktop shortcut' -or $n -match '^Run ') {
          if ([PT.Win]::SendMessage($h, $BM_GETCHECK, [IntPtr]::Zero, [IntPtr]::Zero) -ne [IntPtr]::Zero) {
            if (ClickAt $c) { Write-Output ('unticked: ' + $short); $toggled = $true }
          }
        }
        # keep the default per-user install on the install-mode page
        if ($n -match 'Only for me') {
          if ([PT.Win]::SendMessage($h, $BM_GETCHECK, [IntPtr]::Zero, [IntPtr]::Zero) -eq [IntPtr]::Zero) {
            if (ClickAt $c) { Write-Output ('selected: ' + $short); $toggled = $true }
          }
        }
        if ($c.Current.IsEnabled) { $clickables[$n] = $c }
      }
      # never advance in the same poll as a toggle: the next poll first
      # re-reads BM_GETCHECK, so the state is verified before moving on
      if (-not $toggled) {
        foreach ($name in @('I Agree', 'Install', 'Next >', 'Finish', 'Close')) {
          if ($clickables.ContainsKey($name)) {
            if (ClickAt $clickables[$name]) { Write-Output ('clicked: ' + $name) }
            break
          }
        }
      }
    }
  } catch { Write-Output ('uia-error: ' + $_.Exception.Message) }
  Start-Sleep -Milliseconds 700
}
Write-Output 'gave-up'
exit 0
`;

async function run(): Promise<void> {
  const distDir = path.join(ROOT, 'dist-electron');
  const setup = fs.readdirSync(distDir).find((f) => /Setup.*\.exe$/i.test(f));
  if (!setup) {
    console.error('FAIL  no Setup exe in dist-electron — package the app first');
    process.exit(1);
  }
  const installer = path.join(distDir, setup);

  // ---- silent install: the defaults must be untouched by the page ----
  console.log('silent install', installer);
  const inst = spawnSync(installer, ['/S'], { timeout: 300_000 });
  check('silent install exits cleanly', inst.status === 0, `exit ${inst.status}`);

  const desktopAfterSilent = (await waitFor(() => findDesktopShortcut() !== null, 90_000))
    ? findDesktopShortcut() : null;
  check('silent install creates the desktop shortcut',
    desktopAfterSilent !== null, desktopAfterSilent ?? 'not found');
  check('silent install creates the Start Menu shortcut',
    fs.existsSync(startMenuShortcut), startMenuShortcut);

  await uninstall();
  check('silent uninstall leaves a clean machine',
    findDesktopShortcut() === null && !fs.existsSync(startMenuShortcut));

  // ---- assisted install: untick the desktop checkbox via the real UI ----
  if (os.arch() !== 'x64') {
    console.log('SKIP  assisted UI scenario — the arm runner\'s session cannot '
      + 'drive foreground installer windows (windows-latest covers it)');
  } else {
    console.log('assisted install', installer);
    const child = spawn(installer, [], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const driver = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-shc-')),
      'drive-setup.ps1');
    fs.writeFileSync(driver, DRIVER_PS1);
    let out = '';
    try {
      out = execFileSync('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driver,
          '-InstallerPid', String(child.pid)],
        { encoding: 'utf8', timeout: 420_000 });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? '');
    }
    console.log(out.trim());

    const boxes = [...out.matchAll(/^checkbox: (.*)$/gm)].map((m) => m[1].trim());
    check('the assisted installer offers a desktop shortcut checkbox',
      boxes.some((b) => /desktop shortcut/i.test(b)), boxes.join(' | ') || '(none seen)');
    check('the assisted installer offers a Start Menu shortcut checkbox',
      boxes.some((b) => /start menu shortcut/i.test(b)), boxes.join(' | ') || '(none seen)');
    check('the driver unticked the desktop checkbox',
      /^unticked: .*desktop shortcut/im.test(out));

    const finished = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 120_000)),
    ]);
    check('the assisted install completes', finished === true);
    if (!finished) {
      // never leave a stuck Setup window behind for the next CI step
      spawnSync('taskkill', ['/PID', String(child.pid), '/F', '/T'],
        { encoding: 'utf8' });
    }

    // shortcut creation can trail the process exit by a moment; give the
    // Start Menu link the same grace the silent path gets, THEN judge
    await waitFor(() => fs.existsSync(startMenuShortcut), 60_000);
    check('unticking leaves NO desktop shortcut',
      findDesktopShortcut() === null, findDesktopShortcut() ?? 'absent');
    check('the Start Menu shortcut (left ticked) exists',
      fs.existsSync(startMenuShortcut), startMenuShortcut);
    if (fs.existsSync(startMenuShortcut)) {
      const t = shortcutTarget(startMenuShortcut);
      check('the Start Menu shortcut points at an exe on disk',
        t !== '' && fs.existsSync(t), t || '(empty target)');
    }

    await uninstall();
    check('uninstall after the assisted run leaves a clean machine',
      findDesktopShortcut() === null && !fs.existsSync(startMenuShortcut));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
