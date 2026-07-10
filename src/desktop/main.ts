// Electron desktop shell for Paper Trail.
//
// The built web app (dist-web) is served over a custom `psr://` protocol
// straight from disk. Native application menus send actions over IPC; the
// web app maps them onto its existing functions when it detects the shell
// (window.psrDesktop), and keeps working as a plain web app in any browser
// otherwise.
//
// Run:   npm run desktop
// Smoke: npx electron build-node/desktop/main.js --smoke   (hidden window)

import * as path from 'node:path';
import * as fs from 'node:fs';
import { app, BrowserWindow, Menu, dialog, protocol, shell } from 'electron';
import { MIME } from '../node/server';

const SMOKE = process.argv.includes('--smoke');
// build-node/desktop -> project root
const WEB_ROOT = path.resolve(__dirname, '..', '..', 'dist-web');
const SCHEME = 'psr';

app.setName('Paper Trail');

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
  },
}]);

let win: BrowserWindow | null = null;

function send(action: string): void {
  if (win && !win.isDestroyed()) win.webContents.send('psr-menu', action);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    } satisfies Electron.MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open\u2026', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Save Reading Session', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Load Reading Session\u2026', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('load-session') },
        { type: 'separator' },
        { label: 'Replace PDF (Keep History)\u2026', click: () => send('replace-pdf') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Custom undo/redo: undoes history changes (overwrites, forks,
        // closed stacks, renames); in text fields the web app falls back
        // to normal text-editing undo.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find\u2026', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+0', click: () => send('fit') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('toggle-sidebar') },
        { label: 'Toggle Outline / Pages Panel', accelerator: 'CmdOrCtrl+Shift+B', click: () => send('toggle-nav') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => send('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => send('forward') },
        { type: 'separator' },
        { label: 'Mark This Spot', accelerator: 'CmdOrCtrl+D', click: () => send('mark') },
        { type: 'separator' },
        { label: 'Clear History', click: () => send('clear-history') },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: () => send('help') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerAppProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const filePath = path.normalize(path.join(WEB_ROOT, pathname));
    if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) {
      return new Response('bad path', { status: 400 });
    }
    try {
      const data = await fs.promises.readFile(filePath);
      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

void app.whenReady().then(() => {
  registerAppProtocol();
  buildMenu();

  win = new BrowserWindow({
    width: 1440,
    height: 940,
    show: !SMOKE,
    backgroundColor: '#2b2d31',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // External links (arXiv, DOI, ...) go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The web app's beforeunload fires when there is unsaved reading progress;
  // surface it as a native dialog instead of silently refusing to close.
  win.webContents.on('will-prevent-unload', (event) => {
    if (!win) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Stay', 'Discard and Close'],
      defaultId: 0,
      cancelId: 0,
      message: 'You have unsaved reading progress.',
      detail: 'Save it with Cmd+S first, or discard it and close.',
    });
    if (choice === 1) event.preventDefault(); // allow the unload
  });

  void win.loadURL(`${SCHEME}://app/index.html`);

  if (SMOKE) {
    win.webContents.on('did-finish-load', () => {
      win!.webContents
        .executeJavaScript(
          'JSON.stringify({ title: document.title, shell: !!window.psrDesktop, fsAccess: !!window.showSaveFilePicker, secure: window.isSecureContext })',
        )
        .then((probe: string) => {
          console.log('SMOKE', probe);
          const ok = JSON.parse(probe) as { title: string; shell: boolean };
          app.exit(ok.title.includes('Paper Trail') && ok.shell ? 0 : 1);
        })
        .catch((e: unknown) => {
          console.error('SMOKE FAIL', e);
          app.exit(1);
        });
    });
  }

  win.on('closed', () => {
    win = null;
  });
});

app.on('window-all-closed', () => app.quit());
