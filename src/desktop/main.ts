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
import { autoUpdater, CancellationToken } from 'electron-updater';
import { MIME } from '../node/server';
import { popupWin32, type WinMenuItem } from './winMenu';
import { cancelUpdateOnReopen } from './updateGuard';

// Apps launched by Finder/LaunchServices can get stdio pipes whose
// other end is already closed; a console write (electron-updater logs
// during its startup check) then raises EPIPE, which Electron's default
// handler turns into a crash dialog. Logging must never crash the app.
process.stdout.on('error', () => { /* swallow EPIPE */ });
process.stderr.on('error', () => { /* swallow EPIPE */ });

const SMOKE = process.argv.includes('--smoke');

// A reopen while a quit-install is replacing our files must not run from
// the half-replaced install (it flashes closed and looks corrupt). Owner
// decision: such a reopen CANCELS the update and brings up the OLD
// version silently — stop the installer before it replaces our files,
// then fall through to a normal start (which opens the file args). The
// downloaded update stays cached and re-applies on the next clean quit.
if (process.platform === 'win32' && !SMOKE) {
  cancelUpdateOnReopen(process.execPath);
}

// build-node/desktop -> project root
const WEB_ROOT = path.resolve(__dirname, '..', '..', 'dist-web');
const SCHEME = 'paper-trail';
const isMac = process.platform === 'darwin';
const dbg = (...a: unknown[]): void => {
  if (process.env.PT_DEBUG) console.log('[pt]', ...a);
};

app.setName('Paper Trail');
// Windows attaches Jump Lists (and groups taskbar buttons) by
// AppUserModelID; it must be the appId the installer stamps on the
// shortcuts, or the Jump List's New Window task never shows.
if (process.platform === 'win32') app.setAppUserModelId('local.paper-trail');

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

function createWindow({ showWhenLoaded = false } = {}): BrowserWindow {
  const bounds = loadBounds();
  // Additional windows cascade instead of stacking exactly.
  const offset = BrowserWindow.getAllWindows().length * 26;

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x !== undefined ? bounds.x + offset : undefined,
    y: bounds.y !== undefined ? bounds.y + offset : undefined,
    show: !SMOKE && !process.env.PT_SHOT && !showWhenLoaded,
    backgroundColor: '#2b2d31',
    // The window chrome integrates with the app's own toolbar row on
    // both platforms. macOS: the traffic lights are at an OS-fixed
    // position (measured: centers 18.75px below the window top), and the
    // 38px toolbar in globals.css centers on them. Windows: the native
    // min/max/close buttons overlay the same 38px row.
    ...(isMac ? {
      titleBarStyle: 'hiddenInset' as const,
    } : {
      titleBarStyle: 'hidden' as const,
      // 48px total follows Fluent's guidance for title bars with
      // interactive content (what Outlook/Teams/Edge use); the bare 32px
      // caption is cramped for a toolbar. The overlay is one pixel short
      // of that so the toolbar's bottom border shows through underneath
      // the window buttons instead of stopping where they start; the
      // renderer sizes the toolbar from the titlebar-area-* CSS env vars
      // plus that pixel, so the two always agree.
      titleBarOverlay: {
        color: '#1e1f22',
        symbolColor: '#9a9aa2',
        height: 47,
      },
    }),
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

  // Windows has no menu bar, so New Window is handled here.
  if (!isMac) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.control && !input.shift
        && input.key.toLowerCase() === 'n') {
        createWindow();
      }
    });
  }

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
    // Not plain 'save': right after a canceled unload the renderer's
    // file picker never settles, so this save must use the shell dialog.
    if (choice === 0) win.webContents.send('pt-menu', 'save-from-close'); // window stays open
    else if (choice === 1) event.preventDefault(); // Don't Save: allow the close
    // Cancel: keep the window open
  });

  // Native right-click menus for text fields and selections. On mac
  // they come from electron-context-menu (spell-check suggestions, Look
  // Up, the full edit menu with proper disabled states \u2014 all native
  // there); on Windows Electron's menus are Chromium-drawn, so the same
  // items are shown through a REAL Win32 menu instead. App-specific
  // targets (links, trail/history rows, the viewer) preventDefault() in
  // the renderer and go through the pt-context-menu IPC.
  if (process.platform === 'win32') {
    win.webContents.on('context-menu', (_event, params) => {
      const wc = win.webContents;
      const selection = params.selectionText.trim();
      const items: WinMenuItem[] = [];
      const acts = new Map<string, () => void>();
      const add = (id: string, label: string, enabled: boolean, act: () => void) => {
        items.push({ id, label, enabled });
        acts.set(id, act);
      };
      for (const [i, s] of params.dictionarySuggestions.entries()) {
        add(`sugg-${i}`, s, true, () => wc.replaceMisspelling(s));
      }
      if (params.misspelledWord) {
        add('learn', 'Add to Dictionary', true,
          () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord));
        items.push({ type: 'separator' });
      }
      if (selection && !params.isEditable) {
        add('search', `Search Document for \u201c${selection.slice(0, 24)}\u201d`, true,
          () => wc.send('pt-menu', 'search-selection', selection));
        items.push({ type: 'separator' });
      }
      if (params.isEditable) {
        add('cut', 'Cut', params.editFlags.canCut, () => wc.cut());
        add('copy', 'Copy', params.editFlags.canCopy, () => wc.copy());
        add('paste', 'Paste', params.editFlags.canPaste, () => wc.paste());
        items.push({ type: 'separator' });
        add('select-all', 'Select All', params.editFlags.canSelectAll, () => wc.selectAll());
      } else if (selection) {
        add('copy', 'Copy', params.editFlags.canCopy, () => wc.copy());
      }
      if (!items.length) return;
      const choice = popupWin32(win, items);
      if (choice) acts.get(choice)?.();
    });
  } else {
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
  }

  // Screenshot tooling: show the window WITHOUT activating it (no focus
  // steal, may stay buried); it is then captured by window id.
  if (process.env.PT_SHOT) win.showInactive();

  // A window created to receive a document stays hidden until that
  // document is showing (the title leaves the bare app name): no flash
  // of an empty window. The timer is the safety net — a window must
  // never stay invisible because a file failed to load.
  if (showWhenLoaded && !SMOKE && !process.env.PT_SHOT) {
    const reveal = () => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    };
    // Only explicitly-set titles count: during navigation Electron also
    // reports titles DERIVED from the URL (explicitSet false), which
    // arrive before the document and would reveal an empty window.
    win.webContents.on('page-title-updated', (_event, title, explicitSet) => {
      if (explicitSet && title !== 'Paper Trail') reveal();
    });
    // Patient enough that a slow cold start (pdf.js on a weak machine)
    // does not fall through to an empty reveal.
    setTimeout(reveal, 4000);
  }

  win.on('close', () => saveBounds(win));
  win.on('closed', () => editedWindows.delete(win.id));

  void win.loadURL(`${SCHEME}://app/index.html`);
  return win;
}

// ---- opening OS files ----

const pendingPaths: string[] = [];
const readyWindows = new Set<number>();  // renderer listener registered
/** A file to deliver: a path on disk, or bytes handed over from a renderer. */
type QueuedFile = string | { name: string; data: ArrayBuffer };
const queuedFiles = new Map<number, QueuedFile[]>();

function sendFileTo(win: BrowserWindow, item: QueuedFile): void {
  dbg('sendFileTo', typeof item === 'string' ? item : item.name,
    'ready:', readyWindows.has(win.webContents.id));
  if (!readyWindows.has(win.webContents.id)) {
    const q = queuedFiles.get(win.webContents.id) ?? [];
    q.push(item);
    queuedFiles.set(win.webContents.id, q);
    return;
  }
  if (typeof item !== 'string') {
    win.webContents.send('pt-open-file', item);
    return;
  }
  const filePath = item;
  const name = path.basename(filePath);
  fs.promises.readFile(filePath).then((buf) => {
    if (win.isDestroyed()) return;
    dbg('ipc pt-open-file ->', win.webContents.id, name, buf.byteLength);
    win.webContents.send('pt-open-file', {
      name,
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      // The real on-disk path: an OS-opened .ptl binds to it so the
      // session auto-saves back silently (there is no
      // FileSystemFileHandle for a file the shell handed us).
      path: filePath,
    });
    app.addRecentDocument(filePath);
    // macOS: title-bar proxy for the real file behind this window.
    if (isMac && /\.pdf$/i.test(filePath)) win.setRepresentedFilename(filePath);
  }).catch((e) => {
    console.warn('could not read', filePath, e);
  });
}

/**
 * Open an OS-provided file (Open With…, Dock drops, Open dialog). A
 * window that already shows a document never gets a second one: the
 * file goes into the invoking/focused window only while it is still
 * empty (its title is the bare app name), and into a new window
 * otherwise. At launch the file goes into the first window (`target`).
 */
function openPath(filePath: string, target?: BrowserWindow): void {
  if (!app.isReady()) {
    pendingPaths.push(filePath);
    return;
  }
  const empty = (w: BrowserWindow | null): boolean => {
    if (!w || w.isDestroyed() || w === updateWin) return false;
    const t = w.getTitle();
    return w.webContents.isLoading() || t === 'Paper Trail' || t === '';
  };
  let win = target && !target.isDestroyed() ? target : null;
  // ANY empty window takes the file — focused first, but an idle empty
  // window elsewhere beats spawning an offset new one.
  if (!win) {
    const focused = focusedWindow();
    if (empty(focused)) win = focused;
    else win = BrowserWindow.getAllWindows().find(empty) ?? null;
  }
  // A brand-new window stays hidden until the document is showing: no
  // flash of an empty window on OS opens.
  sendFileTo(win ?? createWindow({ showWhenLoaded: true }), filePath);
}

// macOS: Open With…, drag onto the Dock icon, recent documents.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openPath(filePath);
});

// Windows: the file path arrives in a second process's argv. The
// taskbar Jump List's "New Window" task arrives the same way, as a
// second process launched with --new-window.
app.on('second-instance', (_event, argv) => {
  const files = argv.filter((a) => /\.(pdf|ptl)$/i.test(a) && fs.existsSync(a));
  if (files.length) files.forEach((f) => openPath(f));
  else if (argv.includes('--new-window')) createWindow();
  else {
    const win = focusedWindow();
    if (win) { win.show(); win.focus(); }
  }
});

function openDialog(): void {
  // PDFs only: sessions load through the separate Load Session action.
  void dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'PDF document', extensions: ['pdf'] },
    ],
  }).then(({ canceled, filePaths }) => {
    if (canceled) return;
    filePaths.forEach((f) => openPath(f));
  });
}

/**
 * Menu items carry no user activation, so the renderer's file pickers
 * throw SecurityError there; session loading from the menu therefore
 * uses this main-process dialog and feeds the file into the invoking
 * window's normal (two-step) session flow.
 */
function loadSessionDialog(): void {
  const win = focusedWindow();
  void dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Reading session', extensions: ['ptl'] }],
  }).then(({ canceled, filePaths }) => {
    if (canceled || !filePaths[0]) return;
    openPath(filePaths[0], win ?? undefined);
  });
}

// ---- automatic updates (GitHub Releases feed) ----

let downloadedVersion: string | null = null;

// ---- the Software Update window ----
// The standard fixed-size update window: checking → available →
// downloading (progress bar) → "Restart to Update", driven entirely by
// the main process. The window is a passive view: it renders the last
// pushed state and sends back button actions.

type UpdateUiState =
  | { state: 'checking' }
  | { state: 'none' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; detail: string };

let updateWin: BrowserWindow | null = null;
let updateUi: UpdateUiState = { state: 'checking' };
let availableVersion: string | null = null;
// The token for the download currently in flight (background or the one
// the user asked for), so a Cancel can actually STOP it rather than just
// hide the window. Cleared when the download finishes or is cancelled.
let currentDownload: CancellationToken | null = null;

function setUpdateUi(s: UpdateUiState): void {
  updateUi = s;
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.webContents.send('pt-update-state',
      { ...s, appVersion: app.getVersion() });
  }
}

function openUpdateWindow(): void {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.focus();
    return;
  }
  updateWin = new BrowserWindow({
    width: 540,
    height: 190,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Software Update',
    // A light system window (the Sparkle-style updater look), not the
    // app's dark chrome; the page adapts to the system appearance.
    backgroundColor: '#ececec',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'updatePreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  updateWin.once('ready-to-show', () => {
    if (!updateWin || updateWin.isDestroyed()) return;
    if (process.env.PT_SHOT) updateWin.showInactive();
    else updateWin.show();
  });
  updateWin.on('closed', () => { updateWin = null; });
  void updateWin.loadURL(`${SCHEME}://app/update.html`);
}

ipcMain.on('pt-update-ready', (event) => {
  if (updateWin && !updateWin.isDestroyed()
    && event.sender === updateWin.webContents) {
    event.sender.send('pt-update-state',
      { ...updateUi, appVersion: app.getVersion() });
  }
});

ipcMain.on('pt-update-action', (event, action: string) => {
  if (!updateWin || updateWin.isDestroyed()
    || event.sender !== updateWin.webContents) return;
  if (action === 'later') updateWin.close();
  else if (action === 'download') startInteractiveDownload();
  else if (action === 'cancel') cancelDownload();
  else if (action === 'restart') void restartToUpdate();
});

function startInteractiveDownload(): void {
  const version = availableVersion;
  if (!version) return;
  if (downloadedVersion === version) {
    setUpdateUi({ state: 'downloaded', version });
    return;
  }
  setUpdateUi({ state: 'downloading', version, percent: 0 });
  // autoDownload is on, so the check that found this update already has
  // the transfer in flight and currentDownload holds ITS token — reuse
  // it (Cancel must cancel that exact download, not a token from a fresh
  // checkForUpdates, which does not control the one already running).
  // Only (re)start a check when nothing is downloading, e.g. after a
  // Cancel. We avoid an explicit downloadUpdate() on purpose: it makes
  // the mac updater verify the running app's code signature, which an
  // unsigned dev Electron on Intel lacks (real signed apps are fine, but
  // it broke the dev update-window tests on macos-15-intel).
  if (!currentDownload) {
    autoUpdater.checkForUpdates()
      .then(rememberDownloadToken)
      .catch(() => { /* the event reports it */ });
  }
}

// The cancellation token belongs to the check that STARTED the download;
// a later check returns a token that does not control it. Keep the first
// one until the download finishes or is cancelled.
function rememberDownloadToken(r: { cancellationToken?: CancellationToken } | null): void {
  if (r?.cancellationToken && !currentDownload) currentDownload = r.cancellationToken;
}

/**
 * Cancel a download in progress and drop back to the offer so the user
 * can start it again. Actually stops the transfer (the download does not
 * keep running in the background) and leaves the updater ready for the
 * next check — no wedged half-state.
 */
function cancelDownload(): void {
  if (currentDownload) {
    currentDownload.cancel();
    currentDownload = null;
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w !== updateWin) w.setProgressBar(-1);
  }
  if (availableVersion) setUpdateUi({ state: 'available', version: availableVersion });
}

/**
 * Updates download in the background and install when the app quits.
 * A toast in the renderer announces a downloaded update; the macOS menu
 * also offers an explicit check with a full download-and-restart flow.
 * Dev/test builds never update; the update tests point the updater at
 * a local feed with PT_UPDATE_URL and observe it via PT_UPDATE_TEST.
 */
function setupAutoUpdates(): void {
  // autoDownload on: a found update downloads in the background and
  // installs on the next quit (the silent path). The check result hands
  // back a cancellation token so the window's Cancel can stop the very
  // same transfer, without the explicit downloadUpdate() that trips the
  // mac updater's code-signature check on unsigned dev builds.
  autoUpdater.autoDownload = true;
  if (process.env.PT_UPDATE_URL) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.PT_UPDATE_URL });
  } else if (SMOKE || !app.isPackaged) {
    return;
  }
  autoUpdater.autoInstallOnAppQuit = true;
  // Background downloads are completely silent: no Dock/taskbar
  // progress, no toast nagging to restart — the update installs on the
  // next normal quit and the next start announces it (see
  // announceUpdateOnFirstRun). Only a download the user asked for in
  // the update window shows progress on the app icon.
  autoUpdater.on('download-progress', (p) => {
    if (updateUi.state === 'downloading') {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w !== updateWin) w.setProgressBar(p.percent / 100);
      }
      setUpdateUi({ ...updateUi, percent: p.percent });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version;
    currentDownload = null;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w !== updateWin) w.setProgressBar(-1);
    }
    if (updateUi.state === 'downloading') {
      setUpdateUi({ state: 'downloaded', version: info.version });
    }
    if (process.env.PT_UPDATE_TEST === 'download') {
      console.log(`PT_UPDATE_DOWNLOADED ${info.version}`);
      app.exit(0);
    } else if (process.env.PT_UPDATE_TEST === 'install') {
      autoUpdater.quitAndInstall(true, false);
    }
  });
  autoUpdater.on('error', (e) => {
    // Cancelling a download rejects with a cancellation error — that is
    // the user's own doing, not a failure to surface (cancelDownload has
    // already dropped back to the offer).
    if (/cancell?ed/i.test(String(e))) { currentDownload = null; dbg('download cancelled'); return; }
    dbg('auto-update error', e);
    // Only states the window is actively waiting on turn into an error
    // view; a failed background re-check never hijacks a settled one.
    if (updateUi.state === 'checking' || updateUi.state === 'downloading') {
      setUpdateUi({ state: 'error', detail: String(e) });
    }
    if (process.env.PT_UPDATE_TEST) {
      console.error('PT_UPDATE_ERROR', String(e));
      app.exit(1);
    }
  });
  const check = () => {
    // autoDownload starts the background transfer; keep its token so a
    // Cancel can stop even a download that began before the window opened.
    autoUpdater.checkForUpdates()
      .then(rememberDownloadToken)
      .catch((e) => dbg('update check failed', e));
  };
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

/**
 * Restart into the new version. Document windows close one by one
 * first, so the standard unsaved-session prompt protects every window;
 * if the user keeps any window open (Save… or Cancel), the restart is
 * abandoned and the update window returns to its ready state — the
 * update still installs on the next normal quit.
 */
const editedWindows = new Set<number>();

async function restartToUpdate(): Promise<void> {
  const all = [...BrowserWindow.getAllWindows()]
    .filter((w) => !w.isDestroyed() && w !== updateWin);
  // Windows with unsaved sessions hold the veto, so they are asked
  // FIRST; clean windows only close once every unsaved session has
  // agreed. (getAllWindows has no useful order — without this, a
  // Cancel could leave a half-closed workspace.)
  const ordered = [
    ...all.filter((w) => editedWindows.has(w.id)),
    ...all.filter((w) => !editedWindows.has(w.id)),
  ];
  for (const w of ordered) {
    if (w.isDestroyed()) continue;
    const closed = new Promise<boolean>((resolve) => {
      w.once('closed', () => resolve(true));
      // Counts only unblocked time: the close prompt is a synchronous
      // dialog that halts the main process until answered.
      setTimeout(() => resolve(false), 1500);
    });
    w.close();
    if (!(await closed)) {
      // A window stayed open (Save or Cancel): the restart is
      // abandoned; the update window returns to its ready state.
      if (downloadedVersion) {
        setUpdateUi({ state: 'downloaded', version: downloadedVersion });
      }
      return;
    }
  }
  autoUpdater.quitAndInstall();
}

async function checkForUpdatesInteractive(): Promise<void> {
  if (!app.isPackaged && !process.env.PT_UPDATE_URL) {
    await dialog.showMessageBox({ message: 'Updates apply to the installed app only.' });
    return;
  }
  openUpdateWindow();
  const before = updateUi;
  setUpdateUi({ state: 'checking' });
  try {
    const r = await autoUpdater.checkForUpdates();
    // autoDownload started the transfer here; hold its token so Cancel
    // can stop it even before the user pressed Update Now.
    rememberDownloadToken(r);
    const latest = r?.updateInfo.version;
    if (!latest || latest === app.getVersion()) {
      setUpdateUi({ state: 'none' });
      return;
    }
    availableVersion = latest;
    if (downloadedVersion === latest) {
      setUpdateUi({ state: 'downloaded', version: latest });
    } else if (before.state === 'downloading' && before.version === latest) {
      // Checking again mid-download (the window was closed and
      // reopened) resumes the progress view instead of re-offering
      // the update; the next progress event refreshes the percent.
      setUpdateUi(before);
    } else {
      setUpdateUi({ state: 'available', version: latest });
    }
  } catch (e) {
    setUpdateUi({ state: 'error', detail: String(e) });
  }
}

// ---- menu ----

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          id: 'check-updates',
          label: 'Check for Updates\u2026',
          click: () => void checkForUpdatesInteractive(),
        },
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
        { label: 'Load Reading Session\u2026', accelerator: 'CmdOrCtrl+Shift+O', click: () => loadSessionDialog() },
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
        { label: 'Duplicate Trail', accelerator: 'Alt+Shift+D', click: () => send('trail-duplicate') },
        { type: 'separator' },
        { label: 'Mark This Spot', accelerator: 'CmdOrCtrl+D', click: () => send('mark') },
        { label: 'Mark in a New Trail', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('mark-branch') },
        { label: 'Set Current Entry to This Position', accelerator: 'CmdOrCtrl+G', click: () => send('reanchor') },
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
    // Dev/test builds also serve /sample/* from the project root, like
    // the node server does, so the desktop e2e suite can load its
    // fixtures over the app protocol. Packaged apps have no sample dir.
    const root = (!app.isPackaged && pathname.startsWith('/sample/'))
      ? path.resolve(WEB_ROOT, '..')
      : WEB_ROOT;
    const filePath = path.normalize(path.join(root, pathname));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
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
  const item = (id: string, label: string, enabled = true): WinMenuItem =>
    ({ id, label, enabled });
  const sep: WinMenuItem = { type: 'separator' };
  let tpl: WinMenuItem[] = [];
  {
    switch (ctx.type) {
      case 'link':
        tpl = [
          item('follow', 'Follow Link'),
          item('branch', 'Follow Link in a New Trail'),
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
        return null;
    }
  }
  // Windows gets a REAL OS menu (Electron's is a Chromium-drawn widget
  // there); the mac popup is already native.
  if (process.platform === 'win32') return popupWin32(win, tpl);
  return await new Promise<string | null>((resolve) => {
    let choice: string | null = null;
    const menu = Menu.buildFromTemplate(tpl.map((e) => ('type' in e
      ? { type: 'separator' as const }
      : { label: e.label, enabled: e.enabled, click: () => { choice = e.id; } })));
    menu.popup({
      window: win,
      // give the click handler a beat to run before the close callback
      callback: () => setTimeout(() => resolve(choice), 20),
    });
  });
});

// Menu-triggered saves have no user activation either: the renderer
// delegates here, and the file is written by the main process.
ipcMain.handle('pt-save-session', async (event, req: { text: string; suggestedName: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    defaultPath: req.suggestedName,
    filters: [{ name: 'Reading session', extensions: ['ptl'] }],
  });
  if (canceled || !filePath) return null;
  await fs.promises.writeFile(filePath, req.text, 'utf8');
  app.addRecentDocument(filePath);
  return filePath;
});

// Silent write-back for a session bound to an on-disk path (an
// OS-opened .ptl, or one just saved through the shell dialog): auto-save
// and in-app Save target it directly, no dialog. Returns whether it wrote.
ipcMain.handle('pt-save-session-to-path', async (
  _event, req: { path: string; text: string }) => {
  try {
    await fs.promises.writeFile(req.path, req.text, 'utf8');
    return true;
  } catch (e) {
    console.warn('could not write session to', req.path, e);
    return false;
  }
});

// The dot in the macOS close button mirrors unsaved session changes.
ipcMain.on('pt-document-edited', (event, edited: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.setDocumentEdited(!!edited);
  // restartToUpdate asks windows with unsaved sessions first.
  if (edited) editedWindows.add(win.id);
  else editedWindows.delete(win.id);
});

// A PDF picked in an occupied window opens in a window of its own.
ipcMain.on('pt-open-new-window', (_event, file: { name: string; data: ArrayBuffer }) => {
  sendFileTo(createWindow(), file);
});

ipcMain.on('pt-open-file-ready', (event) => {
  dbg('renderer ready', event.sender.id);
  readyWindows.add(event.sender.id);
  const win = BrowserWindow.fromWebContents(event.sender);
  const queued = queuedFiles.get(event.sender.id);
  queuedFiles.delete(event.sender.id);
  if (win) queued?.forEach((f) => sendFileTo(win, f));
  // Background updates install silently on quit; the first window of
  // the next start carries the only announcement the user gets.
  if (announceVersion) {
    event.sender.send('pt-menu', 'updated', announceVersion);
    announceVersion = null;
  }
});

/**
 * A quit-installed update is announced once on the next start. The
 * previous version lives in a userData marker; the very first run just
 * writes it and stays quiet.
 */
let announceVersion: string | null = null;
function detectQuitInstalledUpdate(): string | null {
  const marker = path.join(app.getPath('userData'), 'last-version.txt');
  let prev = '';
  try { prev = fs.readFileSync(marker, 'utf8').trim(); } catch { /* first run */ }
  const cur = app.getVersion();
  if (prev === cur) return null;
  try { fs.writeFileSync(marker, `${cur}\n`); } catch (e) { dbg('version marker write failed', e); }
  return prev ? cur : null;
}

void app.whenReady().then(() => {
  registerAppProtocol();
  announceVersion = detectQuitInstalledUpdate();
  setupAutoUpdates();
  // macOS gets the full native menu bar; Windows has none (its window
  // chrome integrates with the toolbar, and shortcuts live in the app).
  if (isMac) buildMenu();
  else Menu.setApplicationMenu(null);

  // A double-clicked document launches the app with the file already
  // known: the first window then waits for the document before it
  // shows, instead of flashing empty.
  const startsWithFile = pendingPaths.length > 0
    || process.argv.slice(1).some((a) => /\.(pdf|ptl)$/i.test(a) && fs.existsSync(a));
  const win = createWindow({ showWhenLoaded: startsWithFile });

  // Standard app-level niceties.
  app.setAboutPanelOptions({
    applicationName: 'Paper Trail',
    applicationVersion: app.getVersion(),
    copyright: 'MIT licensed \u2014 github.com/DE0CH/paper-trail',
  });
  if (isMac) {
    app.dock?.setMenu(Menu.buildFromTemplate([
      { label: 'New Window', click: () => void createWindow() },
    ]));
  } else {
    // Windows taskbar Jump List: a New Window task (the counterpart of
    // the macOS Dock menu) plus recent documents (uses the installer's
    // file associations). The task launches a second process whose
    // --new-window flag reaches the running instance via
    // 'second-instance'.
    app.setJumpList([
      {
        type: 'tasks',
        items: [{
          type: 'task',
          title: 'New Window',
          description: 'Open a new Paper Trail window',
          program: process.execPath,
          args: '--new-window',
          iconPath: process.execPath,
          iconIndex: 0,
        }],
      },
      { type: 'recent' },
    ]);
  }

  // Files double-clicked before the app finished launching, and (on
  // Windows / dev runs) file arguments on the command line.
  pendingPaths.splice(0).forEach((f) => openPath(f, win));
  process.argv.slice(1)
    .filter((a) => /\.(pdf|ptl)$/i.test(a) && fs.existsSync(a))
    .forEach((f) => openPath(f, win));

  if (SMOKE) {
    // With a file argument the smoke test also proves the OS-open path
    // (the same pipeline Open With…, Dock drops, File > Open, and the
    // menu's Load Reading Session dialog go through). A .pdf must end up
    // in the window title; a .ptl must land in the pending-session
    // prompt (sessions never auto-open their PDF).
    const fileArg = process.argv.slice(1).find((a) => /\.(pdf|ptl)$/i.test(a));
    const wantSession = !!fileArg && /\.ptl$/i.test(fileArg);
    const deadline = Date.now() + (fileArg ? 20_000 : 0);
    win.webContents.on('did-finish-load', () => {
      const probe = (): void => {
        win.webContents
          .executeJavaScript(
            'JSON.stringify({ title: document.title, shell: !!window.ptDesktop, fsAccess: !!window.showSaveFilePicker, secure: window.isSecureContext, pendingSession: !!document.getElementById(\'sessionPrompt\') })',
          )
          .then((json: string) => {
            const ok = JSON.parse(json) as { title: string; shell: boolean; pendingSession: boolean };
            const docLoaded = !fileArg
              || (wantSession ? ok.pendingSession : ok.title.includes(path.basename(fileArg)));
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
