// Electron desktop shell for Paper Trail.
//
// The built web app (dist-web) is served over a custom `paper-trail://` protocol
// straight from disk. Native application menus send actions over IPC; the
// web app maps them onto its existing functions when it detects the shell
// (window.ptDesktop), and keeps working as a plain web app in any browser
// otherwise.
//
// Desktop niceties: multiple windows (Cmd/Ctrl+N), Open… in a new window,
// OS-level file opens (Open With…, dragging a PDF onto the Dock icon,
// double-clicking a .ptl session), recent documents, remembered window
// bounds, and inset traffic lights on macOS.
//
// Run:   npm run desktop
// Smoke: npx electron build-node/desktop/main.js --smoke   (hidden window)

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } from 'electron';
import contextMenu from 'electron-context-menu';
import { MIME } from '../node/server';

const SMOKE = process.argv.includes('--smoke');
// build-node/desktop -> project root
const WEB_ROOT = path.resolve(__dirname, '..', '..', 'dist-web');
const SCHEME = 'paper-trail';
const isMac = process.platform === 'darwin';
const dbg = (...a: unknown[]): void => {
  if (process.env.PT_DEBUG) console.log('[pt]', ...a);
};

app.setName('Paper Trail');

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
  },
}]);

// Dev affordance: run side-by-side with an installed copy (separate
// profile => separate single-instance lock).
if (process.env.PT_USERDATA) {
  app.setPath('userData', process.env.PT_USERDATA);
}
// Smoke tests must not fight the user's running copy over the profile
// directory or the single-instance lock.
if (SMOKE) {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pt-smoke-')));
} else if (!app.requestSingleInstanceLock()) {
  // OS file opens on Windows arrive as a second process; forward
  // them to the running instance (see 'second-instance').
  app.quit();
}

// ---- remembered window bounds ----

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadBounds(): { width: number; height: number; x?: number; y?: number } {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as {
      width: number; height: number; x?: number; y?: number;
    };
    if (s.width > 300 && s.height > 200) return s;
  } catch { /* first launch */ }
  return { width: 1440, height: 940 };
}

function saveBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(win.getNormalBounds()));
  } catch { /* not fatal */ }
}

// ---- windows ----

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function send(action: string): void {
  const win = focusedWindow();
  if (win && !win.isDestroyed()) win.webContents.send('pt-menu', action);
}

function createWindow(): BrowserWindow {
  const bounds = loadBounds();
  // Additional windows cascade instead of stacking exactly.
  const offset = BrowserWindow.getAllWindows().length * 26;

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x !== undefined ? bounds.x + offset : undefined,
    y: bounds.y !== undefined ? bounds.y + offset : undefined,
    show: !SMOKE && !process.env.PT_SHOT,
    backgroundColor: '#2b2d31',
    // The toolbar follows the native unified-toolbar metrics (52 px, see
    // globals.css body.desktopMac) and per the HIG the traffic lights sit
    // vertically centered in it with the standard leading inset. The y
    // value is calibrated by measuring rendered pixels — do not derive it
    // arithmetically; macOS applies its own offsets.
    ...(isMac ? {
      titleBarStyle: 'hiddenInset' as const,
    } : {}),
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
    if (win.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save\u2026', 'Don\u2019t Save', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Do you want to save your reading session?',
      detail: 'Your changes will be lost if you don\u2019t save them.',
    });
    if (choice === 0) win.webContents.send('pt-menu', 'save'); // window stays open
    else if (choice === 1) event.preventDefault(); // Don't Save: allow the close
    // Cancel: keep the window open
  });

  // Native right-click menus for text fields and selections come from
  // electron-context-menu (spell-check suggestions, Look Up, the full
  // edit menu with proper disabled states). App-specific targets (links,
  // trail/history rows, the viewer) preventDefault() in the renderer and
  // go through the pt-context-menu IPC instead.
  contextMenu({
    window: win,
    showSearchWithGoogle: false,
    showSaveImageAs: false,
    showCopyImage: false,
    showSelectAll: true,
    showLookUpSelection: true,
    showLearnSpelling: true,
    showInspectElement: false,
    prepend: (_defaults, params) => (
      params.selectionText.trim() && !params.isEditable
        ? [{
          label: `Search Document for \u201c${params.selectionText.trim().slice(0, 24)}\u201d`,
          click: () => win.webContents.send('pt-menu', 'search-selection', params.selectionText.trim()),
        }]
        : []
    ),
  });

  // Screenshot tooling: show the window WITHOUT activating it (no focus
  // steal, may stay buried); it is then captured by window id.
  if (process.env.PT_SHOT) win.showInactive();

  win.on('close', () => saveBounds(win));

  void win.loadURL(`${SCHEME}://app/index.html`);
  return win;
}

// ---- opening OS files ----

const pendingPaths: string[] = [];
const readyWindows = new Set<number>();          // renderer listener registered
const queuedFiles = new Map<number, string[]>(); // files waiting for that

function sendFileTo(win: BrowserWindow, filePath: string): void {
  dbg('sendFileTo', filePath, 'ready:', readyWindows.has(win.webContents.id));
  if (!readyWindows.has(win.webContents.id)) {
    const q = queuedFiles.get(win.webContents.id) ?? [];
    q.push(filePath);
    queuedFiles.set(win.webContents.id, q);
    return;
  }
  const name = path.basename(filePath);
  fs.promises.readFile(filePath).then((buf) => {
    if (win.isDestroyed()) return;
    dbg('ipc pt-open-file ->', win.webContents.id, name, buf.byteLength);
    win.webContents.send('pt-open-file', {
      name,
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    });
    app.addRecentDocument(filePath);
  }).catch((e) => {
    console.warn('could not read', filePath, e);
  });
}

/** Open an OS-provided file: into `target`, a still-empty window, or a new one. */
function openPath(filePath: string, target?: BrowserWindow): void {
  if (!app.isReady()) {
    pendingPaths.push(filePath);
    return;
  }
  let win = target && !target.isDestroyed() ? target : null;
  if (!win) {
    const focused = focusedWindow();
    // A window that still shows the welcome screen keeps the bare app
    // title; one that is still loading has nothing in it either.
    if (focused && !focused.isDestroyed()
      && (focused.webContents.isLoading() || focused.getTitle() === 'Paper Trail')) {
      win = focused;
    }
  }
  sendFileTo(win ?? createWindow(), filePath);
}

// macOS: Open With…, drag onto the Dock icon, recent documents.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openPath(filePath);
});

// Windows: the file path arrives in a second process's argv.
app.on('second-instance', (_event, argv) => {
  const files = argv.filter((a) => /\.(pdf|ptl)$/i.test(a) && fs.existsSync(a));
  if (files.length) files.forEach((f) => openPath(f));
  else {
    const win = focusedWindow();
    if (win) { win.show(); win.focus(); }
  }
});

function openDialog(): void {
  void dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'PDF or reading session', extensions: ['pdf', 'ptl'] },
    ],
  }).then(({ canceled, filePaths }) => {
    if (canceled) return;
    filePaths.forEach((f) => openPath(f));
  });
}

// ---- menu ----

function buildMenu(): void {
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
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => void createWindow() },
        { type: 'separator' },
        // Opens in a new window (unless the current one is still empty).
        { label: 'Open\u2026', accelerator: 'CmdOrCtrl+O', click: () => openDialog() },
        ...(isMac ? [{
          label: 'Open Recent',
          role: 'recentDocuments' as const,
          submenu: [{ role: 'clearRecentDocuments' as const }],
        }] : []),
        { type: 'separator' },
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
        { label: 'Previous Trail', accelerator: 'Alt+[', click: () => send('trail-prev') },
        { label: 'Next Trail', accelerator: 'Alt+]', click: () => send('trail-next') },
        { type: 'separator' },
        { label: 'Mark This Spot', accelerator: 'CmdOrCtrl+D', click: () => send('mark') },
        { label: 'Mark in a New Trail', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('mark-branch') },
        { label: 'Set Current Entry to This Position', accelerator: 'CmdOrCtrl+E', click: () => send('reanchor') },
        { type: 'separator' },
        { label: 'Clear History', click: () => send('clear-history') },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'Shift+/', click: () => send('help') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- app protocol ----

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

// ---- lifecycle ----

// App-specific right-click menus (links, trail/history rows, the viewer):
// the renderer says what was clicked; the chosen action id goes back.
ipcMain.handle('pt-context-menu', async (event, ctx: {
  type: string; text?: string; current?: boolean; active?: boolean;
  closable?: boolean; canBack?: boolean; canForward?: boolean;
}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  return await new Promise<string | null>((resolve) => {
    let choice: string | null = null;
    const item = (id: string, label: string, enabled = true): Electron.MenuItemConstructorOptions =>
      ({ label, enabled, click: () => { choice = id; } });
    const sep: Electron.MenuItemConstructorOptions = { type: 'separator' };
    let tpl: Electron.MenuItemConstructorOptions[] = [];
    switch (ctx.type) {
      case 'link':
        tpl = [
          item('follow', 'Follow Link'),
          item('branch', 'Branch into a New Trail'),
        ];
        break;
      case 'histEntry':
        tpl = [
          item('jump', 'Jump to This Entry', !ctx.current),
          sep,
          item('rename', 'Rename\u2026'),
          item('reanchor', 'Set to Current Position'),
        ];
        break;
      case 'stack':
        tpl = [
          item('switch', 'Switch to This Trail', !ctx.active),
          sep,
          item('rename', 'Rename\u2026'),
          item('duplicate', 'Duplicate'),
          sep,
          item('close', 'Close Trail', !!ctx.closable),
        ];
        break;
      case 'viewer':
        tpl = [
          item('back', 'Back', !!ctx.canBack),
          item('forward', 'Forward', !!ctx.canForward),
          sep,
          item('mark', 'Mark This Spot'),
          sep,
          item('zoom-in', 'Zoom In'),
          item('zoom-out', 'Zoom Out'),
          item('fit', 'Fit Width'),
        ];
        break;
      default:
        resolve(null);
        return;
    }
    const menu = Menu.buildFromTemplate(tpl);
    menu.popup({
      window: win,
      // give the click handler a beat to run before the close callback
      callback: () => setTimeout(() => resolve(choice), 20),
    });
  });
});

ipcMain.on('pt-open-file-ready', (event) => {
  dbg('renderer ready', event.sender.id);
  readyWindows.add(event.sender.id);
  const win = BrowserWindow.fromWebContents(event.sender);
  const queued = queuedFiles.get(event.sender.id);
  queuedFiles.delete(event.sender.id);
  if (win) queued?.forEach((f) => sendFileTo(win, f));
});

void app.whenReady().then(() => {
  registerAppProtocol();
  buildMenu();

  const win = createWindow();

  // Files double-clicked before the app finished launching, and (on
  // Windows / dev runs) file arguments on the command line.
  pendingPaths.splice(0).forEach((f) => openPath(f, win));
  process.argv.slice(1)
    .filter((a) => /\.(pdf|ptl)$/i.test(a) && fs.existsSync(a))
    .forEach((f) => openPath(f, win));

  if (SMOKE) {
    // With a file argument the smoke test also proves the OS-open path
    // (the same code Open With… / Dock drops / File > Open go through).
    const fileArg = process.argv.slice(1).find((a) => /\.(pdf|ptl)$/i.test(a));
    const deadline = Date.now() + (fileArg ? 20_000 : 0);
    win.webContents.on('did-finish-load', () => {
      const probe = (): void => {
        win.webContents
          .executeJavaScript(
            'JSON.stringify({ title: document.title, shell: !!window.ptDesktop, fsAccess: !!window.showSaveFilePicker, secure: window.isSecureContext })',
          )
          .then((json: string) => {
            const ok = JSON.parse(json) as { title: string; shell: boolean };
            const docLoaded = !fileArg || ok.title.includes(path.basename(fileArg));
            if (ok.title.includes('Paper Trail') && ok.shell && docLoaded) {
              console.log('SMOKE', json);
              app.exit(0);
            } else if (Date.now() < deadline) {
              setTimeout(probe, 300);
            } else {
              console.error('SMOKE FAIL', json);
              app.exit(1);
            }
          })
          .catch((e: unknown) => {
            console.error('SMOKE FAIL', e);
            app.exit(1);
          });
      };
      probe();
    });
  }
});

app.on('activate', () => {
  // macOS: clicking the Dock icon with no windows open makes a new one.
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (!isMac || SMOKE) app.quit();
});
