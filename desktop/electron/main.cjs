// Electron desktop shell for PDF Stack Reader.
//
// Serves the unchanged web app from an in-process instance of server.js on
// an ephemeral localhost port and adds native application menus. Menu items
// send actions over IPC; the web app maps them onto its existing functions
// when it detects the shell (window.psrDesktop), and keeps working as a
// plain web app in any browser otherwise.
//
// Run:   npm run desktop
// Smoke: npx electron desktop/electron/main.cjs --smoke   (hidden window)

'use strict';

const path = require('path');
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { start } = require(path.join(__dirname, '..', '..', 'server.js'));

const SMOKE = process.argv.includes('--smoke');

app.setName('PDF Stack Reader');

let win = null;

function send(action) {
  if (win && !win.isDestroyed()) win.webContents.send('psr-menu', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
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
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open PDF or Progress\u2026', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Save Reading Progress', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
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

app.whenReady().then(() => {
  const server = start(0);
  server.on('listening', () => {
    const port = server.address().port;
    buildMenu();
    win = new BrowserWindow({
      width: 1440,
      height: 940,
      show: !SMOKE,
      backgroundColor: '#2b2d31',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // External links (arXiv, DOI, ...) go to the system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    // The web app's beforeunload fires when there is unsaved reading
    // progress; surface it as a native dialog instead of silently
    // refusing to close.
    win.webContents.on('will-prevent-unload', (event) => {
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

    win.loadURL(`http://127.0.0.1:${port}/`);

    if (SMOKE) {
      win.webContents.on('did-finish-load', async () => {
        try {
          const probe = await win.webContents.executeJavaScript(
            'JSON.stringify({ title: document.title, shell: !!window.psrDesktop, fsAccess: !!window.showSaveFilePicker })',
          );
          console.log('SMOKE', probe);
          const ok = JSON.parse(probe);
          app.exit(ok.title.includes('PDF Stack Reader') && ok.shell ? 0 : 1);
        } catch (e) {
          console.error('SMOKE FAIL', e);
          app.exit(1);
        }
      });
    }

    win.on('closed', () => { win = null; });
  });
});

app.on('window-all-closed', () => app.quit());
