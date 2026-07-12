// Verifies the packaged Windows installer end to end on a real system,
// checking exactly what a user experiences after running Setup:
//   - the silent install completes,
//   - Desktop and Start Menu shortcuts exist and resolve to an
//     executable that is actually on disk (regression: the shortcut
//     pointed at nothing and the app was nowhere to be found),
//   - the installed executable matches the machine's architecture,
//   - the installed app passes the --smoke probe,
//   - the uninstaller removes the app and its shortcuts again.
// Run (CI, Windows): node build-node/test/installerWin.js

import { execFileSync, spawnSync } from 'node:child_process';
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

/** Machine type from the PE header: which CPU the exe was built for. */
function peMachine(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(0x40);
    fs.readSync(fd, head, 0, 0x40, 0);
    const peOffset = head.readUInt32LE(0x3c);
    const coff = Buffer.alloc(6);
    fs.readSync(fd, coff, 0, 6, peOffset);
    const machine = coff.readUInt16LE(4);
    if (machine === 0x8664) return 'x64';
    if (machine === 0xaa64) return 'arm64';
    return `0x${machine.toString(16)}`;
  } finally {
    fs.closeSync(fd);
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return cond();
}

function findShortcut(): string | null {
  const candidates = [
    path.join(os.homedir(), 'Desktop', `${PRODUCT}.lnk`),
    path.join(os.homedir(), 'OneDrive', 'Desktop', `${PRODUCT}.lnk`),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function run(): Promise<void> {
  const distDir = path.join(ROOT, 'dist-electron');
  const setup = fs.readdirSync(distDir).find((f) => /Setup.*\.exe$/i.test(f));
  if (!setup) {
    console.error('FAIL  no Setup exe in dist-electron — package the app first');
    process.exit(1);
  }
  const installer = path.join(distDir, setup);
  console.log('installing', installer, `(${os.arch()} machine)`);

  const inst = spawnSync(installer, ['/S'], { timeout: 300_000 });
  check('silent install exits cleanly', inst.status === 0, `exit ${inst.status}`);

  // the installer may hand off to a child process; wait for the shortcut
  const desktopLnk = (await waitFor(() => findShortcut() !== null, 90_000))
    ? findShortcut() : null;
  check('desktop shortcut exists', desktopLnk !== null, desktopLnk ?? 'not found');

  const startLnk = path.join(process.env.APPDATA ?? '',
    'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT}.lnk`);
  check('start menu shortcut exists', fs.existsSync(startLnk), startLnk);

  let exe = '';
  if (desktopLnk) {
    exe = shortcutTarget(desktopLnk);
    // THE regression: a shortcut that points at nothing
    check('desktop shortcut target exists on disk',
      exe !== '' && fs.existsSync(exe), exe || '(empty target)');
    if (exe && !fs.existsSync(exe)) {
      const dir = path.dirname(exe);
      console.log('install dir contents:', fs.existsSync(dir)
        ? fs.readdirSync(dir).join(', ') || '(empty)'
        : '(directory does not exist)');
    }
  }
  if (fs.existsSync(startLnk)) {
    const t = shortcutTarget(startLnk);
    check('start menu shortcut target exists on disk',
      t !== '' && fs.existsSync(t), t || '(empty target)');
    if (!exe) exe = t;
  }

  if (exe && fs.existsSync(exe)) {
    const machine = peMachine(exe);
    check('installed app matches the machine architecture',
      machine === os.arch(), `exe is ${machine}, machine is ${os.arch()}`);

    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-inst-'));
    const smoke = spawnSync(exe, ['--smoke'], {
      timeout: 180_000,
      env: { ...process.env, PT_USERDATA: userData },
      encoding: 'utf8',
    });
    check('installed app passes the smoke probe', smoke.status === 0,
      `exit ${smoke.status}${smoke.stdout ? ' ' + smoke.stdout.trim().slice(0, 200) : ''}`);

    // The smoke probe's Electron children (GPU, crashpad) can outlive
    // its exit by a moment; uninstalling while one still holds the exe
    // leaves the app dir half-deleted (the intermittent arm failure on
    // run 29206505841). A real user uninstalls a CLOSED app — wait for
    // the processes to drain, an exit condition instead of a timing bet.
    const image = path.basename(exe);
    const drained = await waitFor(() => !spawnSync('tasklist',
      ['/FI', `IMAGENAME eq ${image}`], { encoding: 'utf8' })
      .stdout.includes(image), 60_000);
    check('the app’s processes drain before the uninstall', drained);

    const uninstaller = path.join(path.dirname(exe), `Uninstall ${PRODUCT}.exe`);
    check('uninstaller exists', fs.existsSync(uninstaller), uninstaller);
    if (fs.existsSync(uninstaller)) {
      spawnSync(uninstaller, ['/S'], { timeout: 300_000 });
      const gone = await waitFor(
        () => !fs.existsSync(exe) && findShortcut() === null, 90_000);
      check('uninstall removes the app and its shortcuts', gone,
        JSON.stringify({ exe: fs.existsSync(exe), shortcut: findShortcut() }));
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
