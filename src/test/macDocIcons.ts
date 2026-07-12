// Documents opened with the app must not wear the app's own icon (a
// folder of PDFs showing the Paper Trail logo reads as a folder of
// apps). On macOS the document icon lives in the bundle: every
// CFBundleDocumentTypes entry must name its own CFBundleTypeIconFile,
// that .icns must exist in Resources, and it must not be the app icon.
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
  const resources = path.join(app, 'Contents', 'Resources');
  const appIcns = path.join(resources, String(info.CFBundleIconFile ?? 'icon.icns'));

  const docTypes: DocType[] = info.CFBundleDocumentTypes ?? [];
  for (const ext of ['pdf', 'ptl']) {
    const doc = docTypes.find((d) => d.CFBundleTypeExtensions?.includes(ext));
    check(`the bundle declares a document type for .${ext}`, !!doc,
      JSON.stringify(docTypes.map((d) => d.CFBundleTypeExtensions)));
    if (!doc) continue;
    const iconName = doc.CFBundleTypeIconFile ?? '';
    check(`.${ext} names its own CFBundleTypeIconFile`, iconName !== '',
      iconName || '(none)');
    if (!iconName) continue;
    const icns = path.join(resources,
      iconName.endsWith('.icns') ? iconName : `${iconName}.icns`);
    check(`.${ext} icon exists in Resources`, fs.existsSync(icns), icns);
    check(`.${ext} icon is not the app icon`,
      path.resolve(icns) !== path.resolve(appIcns)
        && fs.existsSync(icns) && fs.existsSync(appIcns)
        && !fs.readFileSync(icns).equals(fs.readFileSync(appIcns)),
      `${path.basename(icns)} vs ${path.basename(appIcns)}`);
  }

  // The two documents must also be told apart FROM EACH OTHER.
  const iconOf = (ext: string): string => {
    const doc = docTypes.find((d) => d.CFBundleTypeExtensions?.includes(ext));
    return doc?.CFBundleTypeIconFile ?? '';
  };
  check('.pdf and .ptl wear different icons',
    iconOf('pdf') !== '' && iconOf('ptl') !== '' && iconOf('pdf') !== iconOf('ptl'),
    JSON.stringify({ pdf: iconOf('pdf'), ptl: iconOf('ptl') }));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run();
