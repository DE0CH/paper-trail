// Generates app icons from docs/icon.svg:
//   build/icon.icns  (macOS, via sips + iconutil — run on a Mac)
//   build/*.ico      (Windows, multi-resolution via png2icons)
//   public/icon.svg  (favicon, copied into dist-web by Vite)
//   build/ptl.ico / build/pdf.ico  (document icons; Windows only —
//     macOS composes its own, see afterPackMac). The .ptl icon is a
//     page wearing the plated logo; the .pdf icon is the recognisable
//     red "PDF" band with the trail badge in the corner.
//   build/installer.ico  (the installer package icon: a kraft shipping
//     box with the app-icon badge on its front — Windows only)
// The app icon shares the same plated trail on macOS and the web.
// The .ico files are multi-resolution (BMP at 16-48, PNG above — the
// png2icons `forWinExe` mix), so Explorer draws a crisp icon at every
// view size, including the small list/details icons and the icon NSIS
// embeds in the Setup executable.
// NOT generated here: build/uninstaller.ico is NSIS's stock modern-
// uninstall icon (zlib licensed), committed verbatim.
// The .ico generation is pure JS (png2icons + a headless render), so it
// runs on any platform; only the macOS .icns steps need a Mac. The
// generated binaries are committed so CI never needs to regenerate them.
// Usage: npm run icons

import { findBrowser } from '../test/browsers';
import { chromium } from 'playwright-core';
import * as png2icons from 'png2icons';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ROOT = path.resolve(__dirname, '..', '..');
const SVG = path.join(ROOT, 'docs', 'icon.svg');
const BUILD = path.join(ROOT, 'build');

// Document icons follow the OS convention (what macOS auto-generates
// for types without an icon, drawn ourselves because electron-builder
// otherwise substitutes the app icon and Windows has no equivalent):
// the default file icon — a plain white page with a folded corner —
// with the app logo superimposed and the extension as a gray label.
function docSvg(label: string): string {
  // the logo art from docs/icon.svg, plateless, scaled onto the page
  const art = /<g id="art">([\s\S]*?)<\/g>/.exec(fs.readFileSync(SVG, 'utf8'))?.[1];
  if (!art) throw new Error('docs/icon.svg no longer matches the art marker');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#e9eaee"/>
    </linearGradient>
  </defs>
  <path d="M218 62 h414 l230 230 v620 a50 50 0 0 1 -50 50 h-594 a50 50 0 0 1 -50 -50 v-800 a50 50 0 0 1 50 -50 z"
        fill="url(#page)" stroke="#b9bdc7" stroke-width="8"/>
  <path d="M632 62 l230 230 h-180 a50 50 0 0 1 -50 -50 z" fill="#c5c9d3"/>
  <g transform="translate(235 150) scale(0.55)">${art}</g>
  <text x="515" y="840" text-anchor="middle"
        font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
        font-size="130" font-weight="600" fill="#8b909b"
        letter-spacing="10">${label}</text>
</svg>
`;
}

// The Windows installer package icon: a kraft shipping box (drawn) with
// the app-icon badge (the plated trail, pulled from docs/icon.svg's #art)
// superimposed on its front. The box fills the canvas the way a native
// shell icon does — only a shadow's worth of margin — so it stays legible
// down to the small list/details sizes. Windows only; the uninstaller
// keeps NSIS's stock icon.
function installerSvg(): string {
  const art = /<g id="art">([\s\S]*?)<\/g>/.exec(fs.readFileSync(SVG, 'utf8'))?.[1];
  if (!art) throw new Error('docs/icon.svg no longer matches the art marker');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#33363d"/>
      <stop offset="1" stop-color="#1b1c20"/>
    </linearGradient>
    <filter id="sh" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
    <filter id="boxsh" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="28" stdDeviation="24" flood-color="#000000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <g filter="url(#boxsh)">
    <path d="M710,232 L934,82 L934,772 L710,922 Z" fill="#a9793f"/>
    <path d="M90,232 L710,232 L934,82 L314,82 Z" fill="#e6bd83"/>
    <path d="M90,232 H710 V922 H90 Z" fill="#cf9c5c"/>
    <path d="M90,232 H710 V922 H90 Z M710,232 L934,82 M934,82 V772 L710,922 M90,232 L314,82 H934"
          fill="none" stroke="#6e4f27" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M400,232 L624,82" stroke="#8a6636" stroke-width="8" stroke-linecap="round"/>
    <path d="M579,82 L669,82 L445,232 L355,232 Z" fill="#efe6cf" opacity="0.85"/>
    <rect x="355" y="232" width="90" height="690" fill="#efe6cf" opacity="0.8"/>
  </g>
  <rect x="150" y="327" width="500" height="500" rx="130" fill="#f4efe3" filter="url(#sh)"/>
  <svg x="175" y="352" width="450" height="450" viewBox="0 0 1024 1024">
    <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
    ${art}
  </svg>
</svg>
`;
}

// The Windows PDF document icon: a variation of the .ptl icon — the same
// page, the same bare trail art in the same spot, and the label in the
// same spot — turned into a PDF at a glance by a red "PDF" banner behind
// the label, striped across the page. Keeping the art and the label
// aligned with .ptl (see docSvg) means a folder of both reads as one
// consistent set. The banner protrudes past both edges and folds down at
// the tips, the way a common PDF file icon wears its ribbon. Windows
// only; macOS lets LaunchServices compose it.
function pdfSvg(): string {
  const art = /<g id="art">([\s\S]*?)<\/g>/.exec(fs.readFileSync(SVG, 'utf8'))?.[1];
  if (!art) throw new Error('docs/icon.svg no longer matches the art marker');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#e9eaee"/>
    </linearGradient>
    <linearGradient id="pdfred" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e5463b"/>
      <stop offset="1" stop-color="#c9302c"/>
    </linearGradient>
    <filter id="bandsh" x="-20%" y="-40%" width="140%" height="200%">
      <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <path d="M218 62 h414 l230 230 v620 a50 50 0 0 1 -50 50 h-594 a50 50 0 0 1 -50 -50 v-800 a50 50 0 0 1 50 -50 z"
        fill="url(#page)" stroke="#b9bdc7" stroke-width="8"/>
  <path d="M632 62 l230 230 h-180 a50 50 0 0 1 -50 -50 z" fill="#c5c9d3"/>
  <g transform="translate(235 150) scale(0.55)">${art}</g>
  <g filter="url(#bandsh)">
    <path d="M138,853 L168,853 L153,885 Z" fill="#a5231f"/>
    <path d="M892,853 L862,853 L877,885 Z" fill="#a5231f"/>
    <rect x="138" y="707" width="754" height="146" fill="url(#pdfred)"/>
  </g>
  <text x="515" y="840" text-anchor="middle"
        font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
        font-size="168" font-weight="800" fill="#ffffff"
        letter-spacing="8">PDF</text>
</svg>
`;
}

function makeIcns(master: string, out: string, tmp: string): void {
  const iconset = path.join(tmp, `${path.basename(out, '.icns')}.iconset`);
  fs.mkdirSync(iconset);
  const sizes: Array<[number, string]> = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of sizes) {
    execFileSync('sips', ['-z', String(size), String(size), master,
      '--out', path.join(iconset, name)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out]);
}

async function run(): Promise<void> {
  fs.mkdirSync(BUILD, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-icons-'));
  const master = path.join(tmp, 'icon-1024.png');
  const docFile = path.join(tmp, 'icon-doc.svg');
  const docPng = path.join(tmp, 'icon-doc-1024.png');
  const pdfFile = path.join(tmp, 'icon-pdf.svg');
  const pdfPng = path.join(tmp, 'icon-pdf-1024.png');
  const installerFile = path.join(tmp, 'icon-installer.svg');
  const installerPng = path.join(tmp, 'icon-installer-1024.png');
  fs.writeFileSync(docFile, docSvg('PTL'));
  fs.writeFileSync(pdfFile, pdfSvg());
  fs.writeFileSync(installerFile, installerSvg());

  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  for (const [svg, png] of [[SVG, master], [docFile, docPng], [pdfFile, pdfPng], [installerFile, installerPng]] as const) {
    await page.goto('file://' + svg);
    await page.evaluate(() => {
      document.documentElement.style.background = 'transparent';
    });
    await page.screenshot({ path: png, omitBackground: true });
  }
  await browser.close();

  // Windows .ico: multi-resolution, BMP at 16-48 and PNG above (the
  // png2icons forWinExe mix) so Explorer draws every view size crisply,
  // including the icon NSIS embeds in the Setup executable.
  const toIco = (png: string): Buffer => {
    const ico = png2icons.createICO(fs.readFileSync(png), png2icons.BICUBIC2, 0, false, true);
    if (!ico) throw new Error(`png2icons failed to build an ICO from ${png}`);
    return ico;
  };
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), toIco(master));
  fs.writeFileSync(path.join(BUILD, 'ptl.ico'), toIco(docPng));
  fs.writeFileSync(path.join(BUILD, 'pdf.ico'), toIco(pdfPng));
  fs.writeFileSync(path.join(BUILD, 'installer.ico'), toIco(installerPng));

  // favicon: the plated icon, verbatim
  fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
  fs.copyFileSync(SVG, path.join(ROOT, 'public', 'icon.svg'));

  const written = ['build/icon.ico', 'build/ptl.ico', 'build/pdf.ico',
    'build/installer.ico', 'public/icon.svg'];

  // macOS .icns (app + document icons): needs sips/iconutil, so it only
  // runs on a Mac. The .ico deliverables above are enough for a Windows
  // CI regeneration; the committed .icns are refreshed from a Mac.
  if (process.platform === 'darwin') {
    makeIcns(master, path.join(BUILD, 'icon.icns'), tmp);
    makeIcns(docPng, path.join(BUILD, 'ptl.icns'), tmp);
    makeIcns(pdfPng, path.join(BUILD, 'pdf.icns'), tmp);
    written.unshift('build/icon.icns', 'build/ptl.icns', 'build/pdf.icns');
  } else {
    console.log('skipping .icns (macOS only — run `npm run icons` on a Mac to refresh them)');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of written) {
    console.log('wrote', f, `${Math.round(fs.statSync(path.join(ROOT, f)).size / 1024)}KB`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
