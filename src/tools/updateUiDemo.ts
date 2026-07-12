// Records the Software Update window walking through its states for
// owner review: checking → available → downloading (moving progress)
// → ready to restart → up to date → error. The window is the REAL
// update UI (dist-web/update.html + updatePreload); this driver only
// plays the main process's role, pushing pt-update-state with natural
// pacing. Two captures: capturePage frames (permission-proof; the
// review video is assembled from these) and a best-effort native
// screencapture movie for the window chrome.
// Run (CI, macOS): npx electron build-node/tools/updateUiDemo.js
//   (web server on 8377 first; frames land in update-ui-frames/)

import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';
const OUT = path.resolve('update-ui-frames');
const APP_VERSION = '0.5.11';
const NEW_VERSION = '0.6.0';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 540,
    height: 190,
    useContentSize: true,
    resizable: false,
    title: 'Software Update',
    show: true,
    webPreferences: {
      preload: path.resolve(__dirname, '..', 'desktop', 'updatePreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  let state: Record<string, unknown> = { state: 'checking', appVersion: APP_VERSION };
  ipcMain.on('pt-update-ready', (e) => e.sender.send('pt-update-state', state));
  ipcMain.on('pt-update-action', () => { /* demo: buttons are inert */ });
  await win.loadURL(`${BASE}/update.html`);
  win.center();

  // frame pump: ~8 fps of the window's contents
  let frame = 0;
  let pumping = true;
  const pump = (async () => {
    while (pumping && !win.isDestroyed()) {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(
        path.join(OUT, `frame${String(frame++).padStart(4, '0')}.png`),
        img.toPNG());
      await sleep(125);
    }
  })();

  // best-effort native movie with the real window chrome
  let rec: ChildProcess | null = null;
  try {
    rec = spawn('screencapture', ['-v', '-V', '22', 'update-ui.mov'],
      { stdio: 'ignore' });
  } catch { /* recording is a bonus */ }

  const send = (s: Record<string, unknown>) => {
    state = { appVersion: APP_VERSION, ...s };
    if (!win.isDestroyed()) win.webContents.send('pt-update-state', state);
  };

  await sleep(1600);                                   // checking…
  send({ state: 'available', version: NEW_VERSION });
  await sleep(2800);
  for (let p = 0; p <= 100; p += 3) {                  // downloading
    send({ state: 'downloading', version: NEW_VERSION, percent: p });
    await sleep(130);
  }
  await sleep(400);
  send({ state: 'downloaded', version: NEW_VERSION }); // restart to update
  await sleep(3000);
  send({ state: 'none' });                             // up to date
  await sleep(2400);
  send({ state: 'error', detail: 'The update server could not be reached.' });
  await sleep(2600);

  pumping = false;
  await pump;
  if (rec) await new Promise((r) => { rec!.on('exit', r); setTimeout(r, 25_000); });
  console.log(`wrote ${frame} frames to ${OUT}`);
  app.exit(0);
}

void app.whenReady().then(() => run().catch((e) => {
  console.error(e);
  app.exit(1);
}));
