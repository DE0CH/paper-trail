// While a quit-install is replacing the app's files, a reopen must
// not run from the half-replaced install — it flashes closed and
// "looks corrupt" (owner report), and a live instance can even wedge
// the installer's graceful-close check. Called FIRST thing on win32:
// if the updater's pending installer is actively running, the reopen
// is handed to a tiny detached "Updating Paper Trail…" window
// (PowerShell WinForms — a separate process holding no locks on the
// install dir) that starts the app again the moment the installer
// exits; the caller then exits immediately.

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The marquee window: closes itself when the installer process is
// gone, then launches the (now new) app with the original file args.
const PROGRESS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$installer = [IO.Path]::GetFileNameWithoutExtension($env:PT_INSTALLER)
$exe = $env:PT_RELAUNCH_EXE
$fileArgs = @()
if ($env:PT_RELAUNCH_ARGS) { $fileArgs = @(ConvertFrom-Json $env:PT_RELAUNCH_ARGS) }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Paper Trail'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ControlBox = $false
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(380, 92)
$form.TopMost = $true
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Updating Paper Trail...'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(20, 18)
$form.Controls.Add($label)
$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Style = 'Marquee'
$bar.Location = New-Object System.Drawing.Point(20, 48)
$bar.Size = New-Object System.Drawing.Size(340, 20)
$form.Controls.Add($bar)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  if (-not (Get-Process -Name $installer -ErrorAction SilentlyContinue)) {
    $timer.Stop()
    $form.Close()
  }
})
$timer.Start()
[void][System.Windows.Forms.Application]::Run($form)
Start-Sleep -Seconds 1
if ($fileArgs.Count -gt 0) { Start-Process -FilePath $exe -ArgumentList $fileArgs }
else { Start-Process -FilePath $exe }
`;

/**
 * True when a pending update's installer is running right now and the
 * reopen was handed off — the caller must exit immediately (holding
 * our exe open would break the file copy). False in every other case,
 * including dev runs (no app-update.yml next to the executable).
 */
export function handoffWhileUpdating(exePath: string, fileArgs: string[]): boolean {
  try {
    const cfg = fs.readFileSync(
      path.join(path.dirname(exePath), 'resources', 'app-update.yml'), 'utf8');
    const cacheName = /updaterCacheDirName:\s*(\S+)/.exec(cfg)?.[1];
    if (!cacheName) return false;
    const pending = path.join(process.env.LOCALAPPDATA ?? '', cacheName, 'pending');
    if (!fs.existsSync(pending)) return false;
    const installer = fs.readdirSync(pending)
      .find((f) => f.toLowerCase().endsWith('.exe'));
    if (!installer) return false;
    // A reopen right after the quit can land in the gap between the
    // dying app spawning the installer and the process showing up:
    // with a pending installer on disk, look a few times before
    // concluding no install is happening.
    let seen = false;
    for (let attempt = 0; attempt < 3 && !seen; attempt++) {
      if (attempt > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
      const list = execFileSync('tasklist',
        ['/FI', `IMAGENAME eq ${installer}`], { encoding: 'utf8', timeout: 15_000 });
      seen = list.toLowerCase().includes(installer.toLowerCase());
    }
    if (!seen) return false;

    spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand',
        Buffer.from(PROGRESS_SCRIPT, 'utf16le').toString('base64')],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          PT_INSTALLER: installer,
          PT_RELAUNCH_EXE: exePath,
          PT_RELAUNCH_ARGS: JSON.stringify(fileArgs),
        },
      }).unref();
    return true;
  } catch {
    return false; // unreadable state: just start normally
  }
}
