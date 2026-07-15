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
$boxCond = New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::CheckBox)
$radCond = New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::RadioButton)
$btnCond = New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$children = [System.Windows.Automation.TreeScope]::Children
$descend = [System.Windows.Automation.TreeScope]::Descendants
$seen = @{}
for ($i = 0; $i -lt 400; $i++) {
  if (-not (Get-Process -Id $InstallerPid -ErrorAction SilentlyContinue)) { Write-Output 'installer-exited'; exit 0 }
  try {
    $all = $root.FindAll($children, [System.Windows.Automation.Condition]::TrueCondition)
    $wins = @()
    foreach ($w in $all) {
      if ($w.Current.ProcessId -eq $InstallerPid) { $wins += $w; continue }
      if ($w.Current.ClassName -eq '#32770' -and $w.Current.Name -like 'Paper Trail*') { $wins += $w }
    }
    if ($wins.Count -eq 0 -and $i % 15 -eq 14) {
      $desc = @()
      foreach ($w in $all) { $desc += ('' + $w.Current.ProcessId + ':' + $w.Current.ClassName + ':' + $w.Current.Name) }
      Write-Output ('probe #' + $i + ' setup window not found; top-level=' + $all.Count + ' [' + (($desc | Select-Object -First 15) -join '; ') + ']')
    }
    foreach ($w in $wins) {
      # keep the default per-user install on the install-mode page
      foreach ($r in $w.FindAll($descend, $radCond)) {
        if ($r.Current.Name -match 'Only for me') {
          $sel = $r.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
          if (-not $sel.Current.IsSelected) { $sel.Select(); Write-Output ('selected: ' + $r.Current.Name) }
        }
      }
      foreach ($b in $w.FindAll($descend, $boxCond)) {
        $n = $b.Current.Name
        if ($n -and -not $seen.ContainsKey($n)) { $seen[$n] = $true; Write-Output ('checkbox: ' + $n) }
        # untick the desktop shortcut (the scenario) and Run-after-finish
        # (so the installed app does not launch and block the uninstall)
        if (($n -match 'desktop shortcut') -or ($n -match '^Run ')) {
          $t = $b.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
          if ($t.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) {
            $t.Toggle(); Write-Output ('unticked: ' + $n)
          }
        }
      }
      $byName = @{}
      foreach ($b in $w.FindAll($descend, $btnCond)) { $byName[$b.Current.Name] = $b }
      foreach ($name in @('Install', 'Next >', 'Finish', 'Close')) {
        if ($byName.ContainsKey($name) -and $byName[$name].Current.IsEnabled) {
          try {
            $byName[$name].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            Write-Output ('clicked: ' + $name)
          } catch { Write-Output ('click-error: ' + $name + ' ' + $_.Exception.Message) }
          break
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
