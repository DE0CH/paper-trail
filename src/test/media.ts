// Generates README media: screenshots and a screen recording of a scripted
// interaction. Headless video contains no OS cursor, so a cursor overlay
// (arrow + click pulse) is injected into the page and driven by the
// synthetic mouse events.
//
// Prereq: app built and server running (npm start); ffmpeg on PATH for the
// GIF conversion. Usage: npm run media   → writes docs/media/*

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const OUT = path.resolve(__dirname, '..', '..', 'docs', 'media');
const REC = path.join(OUT, '.rec');
const LINK = '.page[data-page="1"] .annotLayer .pdfLink:not(.external)';

const cursorOverlay = () => {
  const mk = () => {
    if (document.getElementById('__cur')) return;
    const c = document.createElement('div');
    c.id = '__cur';
    c.style.cssText =
      'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:22px;height:22px;';
    c.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24">'
      + '<path d="M4 2 L4 19 L9 15 L12 22 L15 20.5 L12 14 L19 14 Z" '
      + 'fill="white" stroke="black" stroke-width="1.4"/></svg>';
    const ring = document.createElement('div');
    ring.style.cssText =
      'position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;'
      + 'border-radius:50%;border:3px solid #4f8cff;opacity:0;'
      + 'transform:translate(-50%,-50%);transition:opacity .3s;';
    document.documentElement.append(c, ring);
    let lx = 0;
    let ly = 0;
    window.addEventListener('mousemove', (e) => {
      lx = e.clientX;
      ly = e.clientY;
      c.style.transform = `translate(${lx}px,${ly}px)`;
    }, true);
    window.addEventListener('mousedown', () => {
      ring.style.left = `${lx}px`;
      ring.style.top = `${ly}px`;
      ring.style.opacity = '0.9';
      setTimeout(() => { ring.style.opacity = '0'; }, 280);
    }, true);
  };
  if (document.readyState !== 'loading') mk();
  else document.addEventListener('DOMContentLoaded', mk);
};

async function run(): Promise<void> {
  const executablePath = findBrowser();
  fs.mkdirSync(REC, { recursive: true });

  const browser = await chromium.launch({ executablePath, headless: true });

  // ---------- screenshots (crisp, deviceScaleFactor 2, no video) ----------
  {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector(LINK, { timeout: 20000 });
    await page.evaluate(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('psr:doc:'))
        .forEach((k) => localStorage.removeItem(k));
    });
    // build a plausible reading state: a trail + a branch
    await page.locator(LINK).nth(3).click();
    await page.waitForTimeout(700);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    await page.waitForSelector(LINK, { timeout: 10000 });
    await page.locator(LINK).nth(2).click();
    await page.waitForTimeout(700);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    await page.waitForSelector(LINK, { timeout: 10000 });
    await page.locator(LINK).nth(0).click({ modifiers: ['Meta'] });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, 'main.png') });

    // hover preview screenshot
    await page.evaluate(() => {
      const psr = (window as never as {
        __psr: { hist: { jumpTo(i: number): unknown; switchStack(id: number): unknown; stacks: Array<{ id: number }> } };
      }).__psr;
      psr.hist.switchStack(psr.hist.stacks[0].id);
      psr.hist.jumpTo(0);
    });
    await page.evaluate(() => {
      (window as never as { __psr: { viewer: { scrollTo(p: unknown): void } } })
        .__psr.viewer.scrollTo({ page: 1, yRatio: 0 });
    });
    await page.waitForSelector(LINK, { timeout: 10000 });
    await page.locator(LINK).nth(3).hover();
    await page.waitForSelector('#preview:not(.hidden)', { timeout: 5000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'preview.png') });
    await page.evaluate(() => { (window as never as { __psr: { session: { dirty: boolean } } }).__psr.session.dirty = false; });
    await page.close();
  }

  // ---------- screen recording with cursor overlay ----------
  {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      recordVideo: { dir: REC, size: { width: 1280, height: 800 } },
    });
    const page: Page = await ctx.newPage();
    await page.addInitScript(cursorOverlay);
    let cur = { x: 640, y: 400 };
    const glide = async (x: number, y: number, ms = 550) => {
      const steps = Math.max(8, Math.round(ms / 16));
      await page.mouse.move(x, y, { steps });
      cur = { x, y };
      void cur;
    };
    const center = (box: { x: number; y: number; width: number; height: number }) =>
      ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector(LINK, { timeout: 20000 });
    await page.evaluate(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('psr:doc:'))
        .forEach((k) => localStorage.removeItem(k));
    });
    await page.mouse.move(640, 400);
    await page.waitForTimeout(900);

    // 1. hover a reference -> preview
    const link = (await page.locator(LINK).nth(3).boundingBox())!;
    await glide(center(link).x, center(link).y, 700);
    await page.waitForTimeout(1600); // preview appears
    // 2. click it -> jump, trail grows
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(1400);
    // 3. back to where we were
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(1100);
    // 4. branch with cmd+click on another reference
    await page.waitForSelector(LINK, { timeout: 10000 });
    const link2 = (await page.locator(LINK).nth(0).boundingBox())!;
    await glide(center(link2).x, center(link2).y, 650);
    await page.keyboard.down('Meta');
    await page.mouse.down(); await page.mouse.up();
    await page.keyboard.up('Meta');
    await page.waitForTimeout(1500);
    // 5. hop through the history panel
    const entry = (await page.locator('#historyPanel .histItem').first().boundingBox())!;
    await glide(center(entry).x, center(entry).y, 650);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(1100);
    // 6. mark the current spot
    const mark = (await page.locator('#btnMark').boundingBox())!;
    await glide(center(mark).x, center(mark).y, 550);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(1300);
    // 7. rest on the trails panel
    const stacks = (await page.locator('#stacksPanel').boundingBox())!;
    await glide(stacks.x + 60, stacks.y + 40, 500);
    await page.waitForTimeout(900);

    await page.evaluate(() => { (window as never as { __psr: { session: { dirty: boolean } } }).__psr.session.dirty = false; });
    await page.close();
    const video = await ctx.close().then(() => fs.readdirSync(REC).find((f) => f.endsWith('.webm')));
    if (!video) throw new Error('no video produced');

    // webm -> gif (palette pass for quality, modest size)
    const webm = path.join(REC, video);
    const gif = path.join(OUT, 'demo.gif');
    execFileSync('ffmpeg', [
      '-y', '-i', webm,
      '-vf', 'fps=10,scale=880:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4',
      gif,
    ], { stdio: 'ignore' });
    fs.rmSync(REC, { recursive: true, force: true });
    console.log('wrote', gif, `${Math.round(fs.statSync(gif).size / 1024)}KB`);
  }

  await browser.close();
  for (const f of ['main.png', 'preview.png']) {
    console.log('wrote', path.join(OUT, f), `${Math.round(fs.statSync(path.join(OUT, f)).size / 1024)}KB`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
