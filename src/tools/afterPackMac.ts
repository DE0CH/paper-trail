// electron-builder afterPack hook (macOS only): strip every
// CFBundleTypeIconFile from CFBundleDocumentTypes so LaunchServices
// composes the document icons itself — the app icon superimposed on
// the system page template with an extension label, which is Apple's
// documented default when a document type declares no icon of its
// own. electron-builder always writes the key (substituting the APP
// icon when an association has none — documents dressed as apps), so
// removal has to happen after packing. Runs before signing, so the
// signature covers the edited plist.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface AfterPackContext {
  appOutDir: string;
  electronPlatformName: string;
  packager: { appInfo: { productFilename: string } };
}

export default function afterPack(context: AfterPackContext): void {
  if (context.electronPlatformName !== 'darwin') return;
  const plist = path.join(context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) throw new Error(`afterPackMac: no Info.plist at ${plist}`);
  // plutil addresses array elements by index; probe until they run out.
  for (let i = 0; i < 32; i++) {
    try {
      execFileSync('plutil',
        ['-remove', `CFBundleDocumentTypes.${i}.CFBundleTypeIconFile`, plist],
        { stdio: 'pipe' });
      console.log(`  • document type ${i}: icon stripped, macOS composes it`);
    } catch {
      // this index has no icon key (or no entry at all) — fine
    }
  }
}
