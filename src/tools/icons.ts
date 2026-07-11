// Generates app icons from docs/icon.svg:
//   build/icon.icns  (macOS, via sips + iconutil — run on a Mac)
//   build/icon.ico   (Windows, via ffmpeg)
//   public/icon.svg  (favicon, copied into dist-web by Vite)
// macOS keeps the squircle plate (apps draw their own on that
// platform); Windows and the web get only the paper-and-trail artwork,
// scaled up to fill the canvas, since icons there aren't plated.
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

// The flat variant: no squircle plate, artwork scaled up to fill the
// 1024 canvas (the art's bounding box is ~524x698 centered at 520,541).
function flatSvg(): string {
  const src = fs.readFileSync(SVG, 'utf8');
  const flat = src
    .replace(/^\s*<rect id="plate"[^\n]*\n/m, '')
    .replace('<g id="art">', '<g id="art" transform="translate(-174 -202) scale(1.32)">');
  if (flat === src || flat.includes('id="plate"')) {
    throw new Error('docs/icon.svg no longer matches the flat-variant markers');
  }
  return flat;
}

async function run(): Promise<void> {
  fs.mkdirSync(BUILD, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-icons-'));
  const master = path.join(tmp, 'icon-1024.png');
  const flatFile = path.join(tmp, 'icon-flat.svg');
  const flatPng = path.join(tmp, 'icon-flat-1024.png');
  fs.writeFileSync(flatFile, flatSvg());

  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  for (const [svg, png] of [[SVG, master], [flatFile, flatPng]] as const) {
    await page.goto('file://' + svg);
    await page.evaluate(() => {
      document.documentElement.style.background = 'transparent';
    });
    await page.screenshot({ path: png, omitBackground: true });
  }
  await browser.close();

  // macOS .icns
  const iconset = path.join(tmp, 'icon.iconset');
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
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);

  // Windows .ico (256px, flat artwork)
  execFileSync('ffmpeg', ['-y', '-i', flatPng, '-vf', 'scale=256:256',
    path.join(BUILD, 'icon.ico')], { stdio: 'ignore' });

  // favicon (flat artwork)
  fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'public', 'icon.svg'), flatSvg());

  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of ['build/icon.icns', 'build/icon.ico', 'public/icon.svg']) {
    console.log('wrote', f, `${Math.round(fs.statSync(path.join(ROOT, f)).size / 1024)}KB`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
