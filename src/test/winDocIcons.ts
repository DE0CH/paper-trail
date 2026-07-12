// Documents opened with the app must not wear the app's own icon: a
// folder of PDFs all showing the Paper Trail logo reads as a folder of
// Paper Trail apps. After a real install, the file associations the
// installer registered must point each extension at its own document
// icon file — never at the application executable's icon.
// Run (CI, Windows, after packaging): node build-node/test/winDocIcons.js

import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
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
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', cmd],
    { encoding: 'utf8' }).trim();
  return out;
}

/** The ProgID an extension resolves to, per-user or machine-wide. */
function progIdOf(ext: string): string {
  return ps(`(Get-ItemProperty -Path 'Registry::HKEY_CLASSES_ROOT\\${ext}' -ErrorAction SilentlyContinue).'(default)'`);
}

/** The DefaultIcon a ProgID declares. */
function defaultIconOf(progId: string): string {
  return ps(`(Get-ItemProperty -Path 'Registry::HKEY_CLASSES_ROOT\\${progId}\\DefaultIcon' -ErrorAction SilentlyContinue).'(default)'`);
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
  await waitFor(() => progIdOf('.pdf') !== '', 90_000);

  // Each extension the app registers must carry its OWN icon: a real
  // .ico file that exists on disk and is not the executable (whose
  // embedded icon is the app logo).
  for (const ext of ['.pdf', '.ptl']) {
    const progId = progIdOf(ext);
    check(`${ext} resolves to an app ProgID`, progId !== '', progId || '(none)');
    if (!progId) continue;
    const icon = defaultIconOf(progId);
    check(`${ext} declares a DefaultIcon`, icon !== '', icon || '(none)');
    const iconPath = icon.replace(/,-?\d+$/, '').replace(/^"|"$/g, '');
    check(`${ext} icon is not the application executable`,
      icon !== '' && !/\.exe$/i.test(iconPath), icon);
    check(`${ext} icon file exists on disk`,
      iconPath !== '' && fs.existsSync(iconPath), iconPath);
  }

  // The two documents must also be told apart FROM EACH OTHER.
  const pdfIcon = defaultIconOf(progIdOf('.pdf'));
  const ptlIcon = defaultIconOf(progIdOf('.ptl'));
  check('.pdf and .ptl wear different icons',
    pdfIcon !== '' && ptlIcon !== '' && pdfIcon !== ptlIcon,
    JSON.stringify({ pdfIcon, ptlIcon }));

  // Leave the machine as we found it. The install dir comes from the
  // association's own open command, not a guessed path.
  const openCmd = ps(`(Get-ItemProperty -Path 'Registry::HKEY_CLASSES_ROOT\\${progIdOf('.pdf')}\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)'`);
  const exeMatch = /"([^"]+\.exe)"/i.exec(openCmd);
  const installDir = exeMatch ? path.dirname(exeMatch[1]) : '';
  const uninstaller = path.join(installDir, `Uninstall ${PRODUCT}.exe`);
  if (installDir && fs.existsSync(uninstaller)) {
    spawnSync(uninstaller, ['/S'], { timeout: 300_000 });
    await waitFor(() => !fs.existsSync(uninstaller), 90_000);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

void run();
