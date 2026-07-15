// The Windows "Installed apps" / Add-Remove-Programs entry shows the
// icon named by the uninstall registry key's DisplayIcon value. With
// `uninstallerIcon` configured, electron-builder's template points
// DisplayIcon at the copied uninstallerIcon.ico — NSIS's stock
// no-entry uninstall symbol — so the installed app wore a "remove me"
// icon in Settings. The customInstall macro in build/installer.nsh
// re-anchors DisplayIcon to the installed app exe.
// This test installs the packaged Setup exe for real and asserts what
// a user sees in the list: DisplayIcon is set, resolves to a file on
// disk, and the icon it yields (extracted the way the shell extracts
// it, ExtractIconEx with the value's icon index) is pixel-for-pixel
// the app icon — and NOT the stock uninstaller icon.
// Run (CI, Windows, after packaging): node build-node/test/installerDisplayIcon.js

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const PRODUCT = 'Paper Trail';
const SIZE = 32; // classic SM_CXICON, the size ARP-style lists render

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

// Renders the icon a DisplayIcon-style source ("path" or "path,index")
// resolves to, the way the shell does (ExtractIconEx honors the index
// for exe/dll/ico alike), and prints the SIZE×SIZE ARGB pixels as hex.
const RENDER_PS1 = `
param([Parameter(Mandatory=$true)][string]$Source, [int]$Size = ${SIZE})
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace PT -Name Native -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
public static extern uint ExtractIconEx(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);
'@
$icoPath = $Source.Trim('"')
$index = 0
if ($icoPath -match '^(.*),(-?\\d+)$') { $icoPath = $Matches[1]; $index = [int]$Matches[2] }
$icoPath = $icoPath.Trim('"')
if (-not (Test-Path -LiteralPath $icoPath)) { Write-Output "MISSING $icoPath"; exit 0 }
$large = New-Object IntPtr[] 1
$got = [PT.Native]::ExtractIconEx($icoPath, $index, $large, $null, 1)
if ($got -lt 1 -or $large[0] -eq [IntPtr]::Zero) { Write-Output "NOICON $icoPath index $index"; exit 0 }
$icon = [System.Drawing.Icon]::FromHandle($large[0])
$bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawIcon($icon, (New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)))
$g.Dispose()
$sb = New-Object System.Text.StringBuilder
for ($y = 0; $y -lt $Size; $y++) {
  for ($x = 0; $x -lt $Size; $x++) {
    [void]$sb.Append($bmp.GetPixel($x, $y).ToArgb().ToString('x8'))
  }
}
Write-Output ("PIXELS " + $sb.ToString())
`;

let renderScript = '';
/** "PIXELS <hex>" | "MISSING <path>" | "NOICON <path> index <n>" */
function renderIcon(source: string): string {
  if (!renderScript) {
    renderScript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-arp-')),
      'render-icon.ps1');
    fs.writeFileSync(renderScript, RENDER_PS1);
  }
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', renderScript, '-Source', source],
    { encoding: 'utf8' }).trim();
}

/** Fraction of pixels that differ between two PIXELS renders. */
function diffFraction(a: string, b: string): number {
  const pa = a.replace(/^PIXELS /, '');
  const pb = b.replace(/^PIXELS /, '');
  const n = Math.min(pa.length, pb.length) / 8;
  let differ = 0;
  for (let i = 0; i < n; i++) {
    const va = parseInt(pa.slice(i * 8, i * 8 + 8), 16) >>> 0;
    const vb = parseInt(pb.slice(i * 8, i * 8 + 8), 16) >>> 0;
    if (va === vb) continue;
    const aa = va >>> 24, ab = vb >>> 24;
    if (aa < 16 && ab < 16) continue; // both effectively transparent
    // tolerate tiny per-channel rendering noise
    const close = [24, 16, 8, 0].every((s) =>
      Math.abs(((va >>> s) & 0xff) - ((vb >>> s) & 0xff)) <= 16);
    if (!close) differ++;
  }
  return n === 0 ? 1 : differ / n;
}

interface ArpEntry {
  DisplayName?: string; DisplayIcon?: string;
  InstallLocation?: string; UninstallString?: string;
}

/** The app's uninstall entry, wherever the installer put it. */
function arpEntry(): ArpEntry | null {
  const out = ps(`
    $roots = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
             'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
             'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    $hits = foreach ($r in $roots) {
      Get-ChildItem $r -ErrorAction SilentlyContinue | Get-ItemProperty |
        Where-Object { $_.DisplayName -like '${PRODUCT}*' }
    }
    @($hits | Select-Object DisplayName, DisplayIcon, InstallLocation, UninstallString) |
      ConvertTo-Json -Compress
  `);
  if (!out) return null;
  const parsed = JSON.parse(out) as ArpEntry[] | ArpEntry;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list[0] ?? null;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return cond();
}

async function run(): Promise<void> {
  const distDir = path.join(ROOT, 'dist-electron');
  const setup = fs.readdirSync(distDir).find((f) => /Setup.*\.exe$/i.test(f));
  if (!setup) {
    console.error('FAIL  no Setup exe in dist-electron — package the app first');
    process.exit(1);
  }
  const installer = path.join(distDir, setup);
  console.log('installing', installer);
  const inst = spawnSync(installer, ['/S'], { timeout: 300_000 });
  check('silent install exits cleanly', inst.status === 0, `exit ${inst.status}`);

  await waitFor(() => arpEntry() !== null, 90_000);
  const entry = arpEntry();
  check('the app has an Installed-apps (uninstall) entry', entry !== null,
    entry?.DisplayName ?? '(none)');

  const displayIcon = entry?.DisplayIcon ?? '';
  check('the entry sets DisplayIcon', displayIcon !== '', displayIcon || '(unset)');

  if (displayIcon) {
    const iconPath = displayIcon.replace(/,-?\d+$/, '').replace(/^"|"$/g, '');
    check('DisplayIcon points at a file that exists on disk',
      fs.existsSync(iconPath), iconPath);

    // Extract the icon the list actually renders and compare it against
    // what we ship: it must BE the app icon, and must NOT be the stock
    // uninstaller icon the electron-builder template points at.
    const shown = renderIcon(displayIcon);
    check('the DisplayIcon target yields an icon',
      shown.startsWith('PIXELS'), shown.startsWith('PIXELS') ? '' : shown);
    if (shown.startsWith('PIXELS')) {
      const appIcon = renderIcon(path.join(ROOT, 'build', 'icon.ico'));
      const uninstIcon = renderIcon(path.join(ROOT, 'build', 'uninstaller.ico'));
      const dApp = diffFraction(shown, appIcon);
      const dUninst = diffFraction(shown, uninstIcon);
      check('the Installed-apps icon is the app icon',
        dApp <= 0.05, `${(dApp * 100).toFixed(1)}% of pixels differ from build/icon.ico`);
      check('the Installed-apps icon is not the stock uninstaller icon',
        dUninst >= 0.10, `${(dUninst * 100).toFixed(1)}% of pixels differ from build/uninstaller.ico`);
    }
  }

  // Leave the machine as we found it.
  const installDir = entry?.InstallLocation ?? '';
  const uninstaller = path.join(installDir, `Uninstall ${PRODUCT}.exe`);
  if (installDir && fs.existsSync(uninstaller)) {
    spawnSync(uninstaller, ['/S'], { timeout: 300_000 });
    await waitFor(() => !fs.existsSync(uninstaller) && arpEntry() === null, 90_000);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
