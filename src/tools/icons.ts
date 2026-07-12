// Generates app icons from docs/icon.svg:
//   build/icon.icns  (macOS, via sips + iconutil — run on a Mac)
//   build/icon.ico   (Windows, via ffmpeg)
//   public/icon.svg  (favicon, copied into dist-web by Vite)
//   build/ptl.* / build/pdf.*  (document icons: the default page with
//     the logo superimposed and an extension label; Windows only —
//     macOS composes its own, see afterPackMac)
//   build/installer.ico  (the plated icon with a download badge)
// Every surface shares the same plated icon: the trail on the dark
// squircle, identical on macOS, Windows, and the web.
// The generated binaries are committed so CI never needs macOS tooling.
// Usage: npm run icons

import { findBrowser } from '../test/browsers';
import { chromium } from 'playwright-core';
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
  <text x="515" y="905" text-anchor="middle"
        font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
        font-size="130" font-weight="600" fill="#8b909b"
        letter-spacing="10">${label}</text>
</svg>
`;
}

// The Windows installer icon: the plated app icon wearing a green
// download-arrow badge — visibly FOR the app without BEING the app.
function installerSvg(): string {
  const badge = `
  <g id="installer-badge">
    <circle cx="788" cy="788" r="150" fill="#2ea043" stroke="#0f1115" stroke-width="16"/>
    <path d="M 788 700 v 106 M 726 752 l 62 64 62 -64"
          fill="none" stroke="#ffffff" stroke-width="42"
          stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
  return fs.readFileSync(SVG, 'utf8').replace('</svg>', badge);
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
  const instFile = path.join(tmp, 'icon-installer.svg');
  const instPng = path.join(tmp, 'icon-installer-1024.png');
  fs.writeFileSync(docFile, docSvg('PTL'));
  fs.writeFileSync(pdfFile, docSvg('PDF'));
  fs.writeFileSync(instFile, installerSvg());

  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  for (const [svg, png] of [[SVG, master], [docFile, docPng], [pdfFile, pdfPng], [instFile, instPng]] as const) {
    await page.goto('file://' + svg);
    await page.evaluate(() => {
      document.documentElement.style.background = 'transparent';
    });
    await page.screenshot({ path: png, omitBackground: true });
  }
  await browser.close();

  // macOS .icns: the app icon and the two document icons
  makeIcns(master, path.join(BUILD, 'icon.icns'), tmp);
  makeIcns(docPng, path.join(BUILD, 'ptl.icns'), tmp);
  makeIcns(pdfPng, path.join(BUILD, 'pdf.icns'), tmp);

  // Windows .ico (256px): the same plated icon as macOS and the web
  execFileSync('ffmpeg', ['-y', '-i', master, '-vf', 'scale=256:256',
    path.join(BUILD, 'icon.ico')], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-i', docPng, '-vf', 'scale=256:256',
    path.join(BUILD, 'ptl.ico')], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-i', pdfPng, '-vf', 'scale=256:256',
    path.join(BUILD, 'pdf.ico')], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-i', instPng, '-vf', 'scale=256:256',
    path.join(BUILD, 'installer.ico')], { stdio: 'ignore' });

  // favicon: the plated icon, verbatim
  fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
  fs.copyFileSync(SVG, path.join(ROOT, 'public', 'icon.svg'));

  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of ['build/icon.icns', 'build/icon.ico', 'build/ptl.icns',
    'build/ptl.ico', 'build/pdf.icns', 'build/pdf.ico',
    'build/installer.ico', 'public/icon.svg']) {
    console.log('wrote', f, `${Math.round(fs.statSync(path.join(ROOT, f)).size / 1024)}KB`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
