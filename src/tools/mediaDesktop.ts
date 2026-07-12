// Records the README media against the WINDOWS DESKTOP APP: the real
// Electron window on the runner's screen, captured with ffmpeg's
// gdigrab and cropped to the window's actual bounds — so the video
// includes the genuine window chrome and the top toolbar, not an
// in-page approximation. A cursor arrow, click pulse and key HUD are
// injected into the page (synthetic input never moves the OS
// pointer). The recording is verified programmatically exactly like
// the web one; after any infrastructure change its frames are also
// reviewed visually before the result is trusted.
//
// Run (CI, Windows): node build-node/tools/mediaDesktop.js

import { _electron, type Page } from 'playwright-core';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'media');
const LINK = '.page[data-page="1"] .annotLayer .pdfLink:not(.external)';

// Same overlay as the web recording: arrow cursor, click pulse, key HUD.
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
    // key HUD: every key press appears as a keycap — held modifiers
    // stay lit, full shortcuts flash momentarily. Bottom-LEFT, so it
    // never covers the app's own toast (bottom-center).
    const hud = document.createElement('div');
    hud.style.cssText =
      'position:fixed;left:24px;bottom:24px;'
      + 'z-index:2147483647;pointer-events:none;padding:10px 22px;'
      + 'border-radius:12px;background:rgba(17,17,20,0.92);color:#fff;'
      + 'font:600 20px "Segoe UI",-apple-system,sans-serif;letter-spacing:.5px;'
      + 'border:1px solid #4f8cff;opacity:0;transition:opacity .15s;';
    document.documentElement.append(hud);
    const MODS = ['Meta', 'Control', 'Alt', 'Shift'];
    const keyLabel = (e: KeyboardEvent) => {
      const parts: string[] = [];
      if (e.metaKey) parts.push('⌘');
      if (e.ctrlKey) parts.push('ctrl');
      if (e.altKey) parts.push('alt');
      if (e.shiftKey) parts.push('shift');
      if (!MODS.includes(e.key)) {
        parts.push(e.key === 'ArrowLeft' ? '←'
          : e.key === 'ArrowRight' ? '→'
            : e.key.length === 1 ? e.key.toUpperCase() : e.key);
      }
      return parts.join(' + ');
    };
    let hideTimer = 0;
    window.addEventListener('keydown', (e) => {
      const text = keyLabel(e);
      if (!text) return;
      hud.textContent = text;
      hud.style.opacity = '1';
      clearTimeout(hideTimer);
      if (!MODS.includes(e.key)) {
        hideTimer = window.setTimeout(() => { hud.style.opacity = '0'; }, 1100);
      }
    }, true);
    window.addEventListener('keyup', (e) => {
      if (MODS.includes(e.key)
        && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        clearTimeout(hideTimer);
        hud.style.opacity = '0';
      }
    }, true);
  };
  if (document.readyState !== 'loading') mk();
  else document.addEventListener('DOMContentLoaded', mk);
};

/** The window region on screen, rounded to even h264-friendly pixels. */
type Rect = { x: number; y: number; w: number; h: number };
const even = (n: number) => 2 * Math.floor(n / 2);

// Crop to the window, then pad to an exact 1080p canvas in the app's
// own background color — no distortion, no taskbar, true 1920x1080.
const filter1080 = (r: Rect) =>
  `crop=${r.w}:${r.h}:${r.x}:${r.y},`
  + 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x2b2d31';

function snapStill(rect: Rect, file: string): void {
  execFileSync('ffmpeg', [
    '-y', '-f', 'gdigrab', '-draw_mouse', '0', '-i', 'desktop',
    '-frames:v', '1',
    '-vf', filter1080(rect),
    file,
  ], { stdio: 'ignore' });
}

async function run(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const pdfAbs = fs.existsSync(path.join(ROOT, 'sample', 'real', 'WStarCats.pdf'))
    ? path.join(ROOT, 'sample', 'real', 'WStarCats.pdf')
    : path.join(ROOT, 'sample', 'WStarCats.pdf');
  console.log('recording the desktop app against', path.relative(ROOT, pdfAbs));

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-media-'));
  // Fill the display: the OS clamps the height to the work area, and
  // the capture pads the remainder to an exact 1080p canvas.
  fs.writeFileSync(path.join(userData, 'window-state.json'),
    JSON.stringify({ x: 0, y: 0, width: 1920, height: 1080 }));

  const eApp = await _electron.launch({
    args: [path.join(ROOT, 'build-node', 'desktop', 'main.js'), pdfAbs],
    cwd: ROOT,
    env: { ...process.env as Record<string, string>, PT_USERDATA: userData },
  });
  let ffmpeg: ChildProcess | null = null;
  try {
    const page: Page = await eApp.firstWindow();
    await page.evaluate(cursorOverlay);
    await page.waitForSelector(LINK, { timeout: 60000 });

    const b = await eApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds());
    const rect: Rect = { x: even(b.x), y: even(b.y), w: even(b.width), h: even(b.height) };

    // The whole desktop is grabbed at 60fps and cropped to the window —
    // chrome, toolbar and all — on a true 1080p canvas. The realtime
    // pass encodes ultrafast; a second, unhurried pass below produces
    // the compact final file. 'q' on stdin finalizes cleanly.
    // MPEG-TS container: playable even when truncated by a crash, so
    // a failed run still leaves a reviewable capture.
    const cap = path.join(OUT, 'capture.ts');
    ffmpeg = spawn('ffmpeg', [
      '-y', '-f', 'gdigrab', '-framerate', '60', '-draw_mouse', '0',
      '-i', 'desktop',
      '-vf', filter1080(rect),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-an',
      cap,
    ], { stdio: ['pipe', 'ignore', 'ignore'] });
    await page.waitForTimeout(1200);

    const glide = async (x: number, y: number, ms = 550) => {
      const steps = Math.max(8, Math.round(ms / 16));
      await page.mouse.move(x, y, { steps });
    };
    const center = (box: { x: number; y: number; width: number; height: number }) =>
      ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

    await page.mouse.move(640, 400);
    await page.waitForTimeout(900);

    const avoidPages: number[] = [];
    const findLinkInView = () => page.evaluate((avoid) => {
      const pt = (window as never as {
        __pt: { hist: { active: { entries: Array<{ pos: { page: number } }> } } };
      }).__pt;
      const visited = new Set([
        ...pt.hist.active.entries.map((e) => e.pos.page),
        ...avoid,
      ]);
      const cont = document.getElementById('viewerContainer')!.getBoundingClientRect();
      const links = [...document.querySelectorAll<HTMLElement>('.pdfLink:not(.external)')];
      for (const el of links) {
        const dest = Number(el.dataset.destPage ?? NaN);
        if (!Number.isFinite(dest) || visited.has(dest)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 14 || r.height < 8) continue;
        if (r.top > cont.top + 90 && r.bottom < cont.bottom - 140
            && r.left > cont.left + 40 && r.right < cont.right - 40) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, dest };
        }
      }
      return null;
    }, avoidPages);
    const visibleLink = async (): Promise<{ x: number; y: number; dest: number } | null> => {
      for (let attempt = 0; attempt < 10; attempt++) {
        for (let tries = 0; tries < 4; tries++) {
          const found = await findLinkInView();
          if (found) return found;
          await page.waitForTimeout(250);
        }
        await page.mouse.wheel(0, 420);
        await page.waitForTimeout(450);
      }
      return null;
    };
    const lastLabelIsFresh = () => page.evaluate(() => {
      const pt = (window as never as {
        __pt: {
          hist: { active: { entries: Array<{ label: string }> } };
          controller: { undoHist(): void };
        };
      }).__pt;
      const labels = pt.hist.active.entries.map((e) => e.label);
      const last = labels[labels.length - 1];
      if (labels.slice(0, -1).includes(last)) {
        pt.controller.undoHist();
        return false;
      }
      return true;
    });

    // 1. hover the first reference -> destination preview appears
    const link = (await page.locator(LINK).nth(3).boundingBox())!;
    await glide(center(link).x, center(link).y, 700);
    await page.waitForTimeout(1700);
    // 2. click it, then keep following real references
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(1300);
    const state = () => page.evaluate(() => {
      const pt = (window as never as {
        __pt: {
          hist: { active: { entries: unknown[] } };
          viewer: { currentPosition(): { page: number } };
        };
      }).__pt;
      return {
        entries: pt.hist.active.entries.length,
        page: pt.viewer.currentPosition().page,
      };
    });
    console.log('after first click:', JSON.stringify(await state()));
    let hops = 0;
    for (let attempts = 0; hops < 3 && attempts < 8; attempts++) {
      await page.mouse.wheel(0, 460);
      await page.waitForTimeout(650);
      const target = await visibleLink();
      if (!target) break;
      await glide(target.x, target.y, 650);
      await page.waitForTimeout(500);
      await page.mouse.down(); await page.mouse.up();
      await page.waitForTimeout(1250);
      if (await lastLabelIsFresh()) {
        hops++;
      } else {
        avoidPages.push(target.dest);
        await page.waitForTimeout(600);
      }
    }
    console.log('after the hops:', hops, JSON.stringify(await state()));
    // 3. pop back one level
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForTimeout(1100);
    // 4. jump back arbitrarily via the history panel
    const s4 = await state();
    if (s4.entries < 2) {
      throw new Error('the demo never navigated: the first reference click '
        + `did not push a history entry (${JSON.stringify(s4)})`);
    }
    const entries = page.locator('#historyPanel .histItem');
    const second = (await entries.nth(1).boundingBox())!;
    await glide(center(second).x, center(second).y, 700);
    await page.waitForTimeout(400);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(1300);
    // 5. branch: ctrl+click a reference (the HUD shows the held key)
    const target2 = await visibleLink();
    if (target2) {
      await glide(target2.x, target2.y, 700);
      await page.waitForTimeout(350);
      await page.keyboard.down('Control');
      await page.waitForTimeout(450);
      await page.mouse.down(); await page.mouse.up();
      await page.waitForTimeout(500);
      await page.keyboard.up('Control');
      await page.waitForTimeout(1400);
    }
    // 6. glide over the inherited deep history of the new trail
    const hist = (await page.locator('#historyPanel').boundingBox())!;
    await glide(hist.x + hist.width / 2, hist.y + 60, 600);
    await glide(hist.x + hist.width / 2, hist.y + Math.min(hist.height - 40, 230), 900);
    await page.waitForTimeout(800);
    // 7. rest on the trails panel showing both trails
    const stacks = (await page.locator('#stacksPanel').boundingBox())!;
    await glide(stacks.x + 60, stacks.y + 40, 500);
    await page.waitForTimeout(1000);

    // ---- programmatic verification, same contract as the web flow ----
    const outcome = await page.evaluate(() => {
      const pt = (window as never as {
        __pt: {
          hist: { stacks: Array<{ entries: Array<{ label: string }> }> };
          session: { dirty: boolean };
        };
      }).__pt;
      pt.session.dirty = false;
      const deepest = [...pt.hist.stacks].sort(
        (a, b) => b.entries.length - a.entries.length,
      )[0];
      return {
        stacks: pt.hist.stacks.length,
        deepestLen: deepest.entries.length,
        distinctLabels: new Set(deepest.entries.map((e) => e.label)).size,
      };
    });
    if (outcome.stacks < 2 || outcome.deepestLen < 5 || outcome.distinctLabels < 5) {
      throw new Error('recording did not demonstrate the features: '
        + JSON.stringify(outcome));
    }
    console.log('recording verified:', JSON.stringify(outcome));

    // Stop the capture, then encode the final file without time
    // pressure: 1080p60, compact and streamable.
    ffmpeg.stdin!.write('q');
    await new Promise((r) => ffmpeg!.on('exit', r));
    ffmpeg = null;
    const mp4 = path.join(OUT, 'demo.mp4');
    execFileSync('ffmpeg', [
      '-y', '-i', cap,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
      mp4,
    ], { stdio: 'ignore' });
    fs.rmSync(cap, { force: true });

    // The stills show NORMAL mathematical content, not the references
    // the demo chain ends in: main.png rests on an early theorem page,
    // preview.png hovers a reference whose destination is mid-paper.
    await page.evaluate(() => {
      (window as never as { __pt: { viewer: { scrollTo(p: unknown): void } } })
        .__pt.viewer.scrollTo({ page: 3, yRatio: 0.1 });
    });
    await page.waitForSelector('.page[data-page="3"] canvas', { timeout: 15000 });
    await page.waitForTimeout(900); // let the page render crisply
    await glide(stacks.x + 60, stacks.y + 40, 300); // park the cursor off the text
    await page.waitForTimeout(300);
    snapStill(rect, path.join(OUT, 'main.png'));

    // preview still: hover a reference that lands on CONTENT (not the
    // bibliography block at the end of the paper).
    await page.evaluate(() => {
      const pt = (window as never as {
        __pt: {
          hist: { jumpTo(i: number): unknown; switchStack(id: number): unknown; stacks: Array<{ id: number }> };
          viewer: { scrollTo(p: unknown): void };
        };
      }).__pt;
      pt.hist.switchStack(pt.hist.stacks[0].id);
      pt.hist.jumpTo(0);
      pt.viewer.scrollTo({ page: 1, yRatio: 0 });
    });
    await page.waitForSelector(LINK, { timeout: 10000 });
    const contentLink = await page.evaluate(() => {
      const pt = (window as never as { __pt: { viewer: { numPages: number } } }).__pt;
      const lastContent = pt.viewer.numPages - 6; // keep clear of the references
      const cont = document.getElementById('viewerContainer')!.getBoundingClientRect();
      for (const el of document.querySelectorAll<HTMLElement>('.pdfLink:not(.external)')) {
        const dest = Number(el.dataset.destPage ?? NaN);
        if (!Number.isFinite(dest) || dest < 2 || dest > lastContent) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 14 || r.height < 8) continue;
        if (r.top > cont.top + 60 && r.bottom < cont.bottom - 60) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    });
    const hoverAt = contentLink
      ?? center((await page.locator(LINK).nth(3).boundingBox())!);
    await glide(hoverAt.x, hoverAt.y, 400);
    await page.waitForSelector('#preview:not(.hidden)', { timeout: 5000 });
    await page.waitForTimeout(500);
    snapStill(rect, path.join(OUT, 'preview.png'));
    await page.evaluate(() => {
      (window as never as { __pt: { session: { dirty: boolean } } })
        .__pt.session.dirty = false;
    });
  } finally {
    if (ffmpeg) {
      try { ffmpeg.stdin!.write('q'); } catch { /* already gone */ }
      await Promise.race([
        new Promise((r) => ffmpeg!.on('exit', r)),
        new Promise((r) => setTimeout(r, 10_000)),
      ]);
    }
    await eApp.close().catch(() => { /* fine */ });
  }

  for (const f of ['demo.mp4', 'main.png', 'preview.png']) {
    const p = path.join(OUT, f);
    console.log('wrote', p, `${Math.round(fs.statSync(p).size / 1024)}KB`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
