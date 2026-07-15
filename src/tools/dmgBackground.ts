// Generates the macOS dmg installer-window background from
// build/background.svg:
//   build/background.png     (540x380 — the window size in build.dmg)
//   build/background@2x.png  (1080x760, the Retina pair)
// electron-builder combines the pair into a HiDPI tiff at package time
// (tiffutil -cathidpicheck), and the Finder window takes its size from
// the 1x image, so the PNG dimensions ARE the window dimensions. The
// PNGs are committed alongside the source, so packaging never needs to
// regenerate them (the same policy as the icons). Render on a macOS
// runner: the instruction line resolves system-ui to the system font.
// With PT_DMG_RENDERS set, also writes dmg-preview.png there — the
// background composited with mock Finder icons and labels at the
// positions configured in package.json build.dmg — so the window
// layout can be reviewed without mounting anything.
// Usage: npm run dmg:background

import { findBrowser } from '../test/browsers';
import { chromium } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const BUILD = path.join(ROOT, 'build');
const SVG = path.join(BUILD, 'background.svg');
const WIDTH = 540;
const HEIGHT = 380;

interface DmgContent { x: number; y: number; type: string; path?: string }

// The preview mocks what Finder will draw on top of the background:
// the app icon and an Applications folder at the configured contents
// positions (icon coordinates are centers), with their labels below.
function previewHtml(iconSize: number, contents: DmgContent[]): string {
  const app = contents.find((c) => c.type === 'file');
  const link = contents.find((c) => c.type === 'link');
  if (!app || !link) throw new Error('build.dmg.contents must have a file and a link entry');
  const half = iconSize / 2;
  const box = (c: DmgContent): string =>
    `left:${c.x - half}px;top:${c.y - half}px;width:${iconSize}px;height:${iconSize}px`;
  const label = (c: DmgContent): string => `left:${c.x - 80}px;top:${c.y + half + 6}px`;
  return `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; position: relative; overflow: hidden;
         font-family: system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif; }
  img.bg { position: absolute; left: 0; top: 0; }
  .icon { position: absolute; }
  .label { position: absolute; width: 160px; text-align: center;
           font-size: 12px; color: #3e4249; }
</style>
<img class="bg" src="background.png" width="${WIDTH}" height="${HEIGHT}">
<img class="icon" src="icon.svg" style="${box(app)}">
<svg class="icon" style="${box(link)}" viewBox="0 0 128 128">
  <!-- a rough macOS 15 folder stand-in (soft sky-blue gradient, tab
       peeking behind the front panel) — preview only, never shipped -->
  <defs>
    <linearGradient id="folder-front" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6fb6f8"/>
      <stop offset="1" stop-color="#3e8ee6"/>
    </linearGradient>
  </defs>
  <path d="M10 32 a8 8 0 0 1 8 -8 h29 a8 8 0 0 1 6 2.6 l6 6.4 h51 a8 8 0 0 1 8 8 v4 h-108 z" fill="#3d84d6"/>
  <rect x="10" y="38" width="108" height="68" rx="9" fill="url(#folder-front)"/>
</svg>
<div class="label" style="${label(app)}">Paper Trail</div>
<div class="label" style="${label(link)}">Applications</div>
`;
}

async function run(): Promise<void> {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    build: { dmg: { iconSize: number; contents: DmgContent[] } };
  };
  const onePx = path.join(BUILD, 'background.png');
  const twoPx = path.join(BUILD, 'background@2x.png');

  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  for (const [scale, out] of [[1, onePx], [2, twoPx]] as const) {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: scale,
    });
    await page.goto('file://' + SVG);
    await page.screenshot({ path: out });
    await page.close();
  }

  const renders = process.env.PT_DMG_RENDERS;
  if (renders) {
    fs.mkdirSync(renders, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dmg-bg-'));
    fs.copyFileSync(onePx, path.join(tmp, 'background.png'));
    fs.copyFileSync(path.join(ROOT, 'docs', 'icon.svg'), path.join(tmp, 'icon.svg'));
    const html = path.join(tmp, 'preview.html');
    fs.writeFileSync(html, previewHtml(pkg.build.dmg.iconSize, pkg.build.dmg.contents));
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 2,
    });
    await page.goto('file://' + html);
    await page.screenshot({ path: path.join(renders, 'dmg-preview.png') });
    await page.close();
    fs.copyFileSync(onePx, path.join(renders, 'background.png'));
    fs.copyFileSync(twoPx, path.join(renders, 'background@2x.png'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await browser.close();

  for (const f of [onePx, twoPx]) {
    console.log('wrote', path.relative(ROOT, f), `${Math.round(fs.statSync(f).size / 1024)}KB`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
