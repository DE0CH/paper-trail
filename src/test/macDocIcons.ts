// Documents opened with the app must not wear the app's own icon (a
// folder of PDFs showing the Paper Trail logo reads as a folder of
// apps). On macOS the right document icon is the one LaunchServices
// composes itself — the app icon superimposed on the system page
// template with an extension label — and that composition happens
// exactly when a document type declares NO CFBundleTypeIconFile.
// electron-builder always writes one (substituting the app icon —
// the original bug), so an afterPack hook strips the key; this test
// pins that contract on the packaged bundle.
// Run (CI, macOS, after packaging): node build-node/test/macDocIcons.js

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function findApp(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (entry.endsWith('.app')) return p;
    if (fs.statSync(p).isDirectory()) {
      const nested = findApp(p);
      if (nested) return nested;
    }
  }
  return null;
}

interface DocType {
  CFBundleTypeExtensions?: string[];
  CFBundleTypeIconFile?: string;
}

function run(): void {
  const app = findApp(path.join(ROOT, 'dist-electron'));
  if (!app) {
    console.error('FAIL  no .app in dist-electron — package the app first');
    process.exit(1);
  }
  console.log('inspecting', app);
  const plist = path.join(app, 'Contents', 'Info.plist');
  const info = JSON.parse(execFileSync('plutil',
    ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
  const docTypes: DocType[] = info.CFBundleDocumentTypes ?? [];
  for (const ext of ['pdf', 'ptl']) {
    const doc = docTypes.find((d) => d.CFBundleTypeExtensions?.includes(ext));
    check(`the bundle declares a document type for .${ext}`, !!doc,
      JSON.stringify(docTypes.map((d) => d.CFBundleTypeExtensions)));
    if (!doc) continue;
    // No icon declared: LaunchServices composes app-icon-on-page with
    // the extension label. A declared icon would be electron-builder's
    // app-icon substitute — a folder of PDFs dressed as apps.
    check(`.${ext} declares no CFBundleTypeIconFile (macOS composes it)`,
      doc.CFBundleTypeIconFile === undefined,
      doc.CFBundleTypeIconFile ?? '(absent)');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run();
