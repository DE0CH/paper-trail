// The Windows installer must declare itself DPI-aware in its embedded
// manifest. Without the declaration Windows renders it at 96 dpi and
// bitmap-stretches the result, so the whole installer UI comes out
// pixelated on HiDPI screens. The manifest is stored uncompressed in
// the Setup exe, so the declaration is directly visible in its bytes;
// the uninstaller is extracted from the same NSIS build and inherits
// it.
// Run (CI, Windows): node build-node/test/installerDpiAware.js

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function run(): void {
  const distDir = path.join(ROOT, 'dist-electron');
  const setup = fs.readdirSync(distDir).find((f) => /Setup.*\.exe$/i.test(f));
  if (!setup) {
    console.error('FAIL  no Setup exe in dist-electron — package the app first');
    process.exit(1);
  }
  const bytes = fs.readFileSync(path.join(distDir, setup)).toString('latin1');

  const manifested = /<dpiAware[^>]*>\s*true/i.test(bytes);
  check('the installer manifest declares DPI awareness', manifested, setup);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run();
