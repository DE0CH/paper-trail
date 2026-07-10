// PDF Stack Reader — application wiring.

import { Viewer } from './viewer.js';
import { NavStacks, renderStacksPanel, renderStackEntries } from './history.js';
import { SearchController } from './search.js';
import { Store, putRecent, getRecent, getRecents, ensureReadPermission } from './store.js';

const $ = (id) => document.getElementById(id);
const els = {
  toolbar: $('toolbar'),
  btnSidebar: $('btnSidebar'),
  btnOpen: $('btnOpen'),
  btnSave: $('btnSave'),
  docTitle: $('docTitle'),
  btnBack: $('btnBack'),
  btnFwd: $('btnFwd'),
  pageInput: $('pageInput'),
  pageCount: $('pageCount'),
  btnZoomOut: $('btnZoomOut'),
  btnZoomIn: $('btnZoomIn'),
  btnFit: $('btnFit'),
  zoomLevel: $('zoomLevel'),
  searchInput: $('searchInput'),
  searchCount: $('searchCount'),
  btnSearchPrev: $('btnSearchPrev'),
  btnSearchNext: $('btnSearchNext'),
  sidebar: $('sidebar'),
  sideTabs: $('sideTabs'),
  stacksCol: $('stacksCol'),
  stacksPanel: $('stacksPanel'),
  resizeStacks: $('resizeStacks'),
  resizeSidebar: $('resizeSidebar'),
  historyPanel: $('historyPanel'),
  outlinePanel: $('outlinePanel'),
  btnClearTree: $('btnClearTree'),
  viewerContainer: $('viewerContainer'),
  viewer: $('viewer'),
  welcome: $('welcome'),
  btnWelcomeOpen: $('btnWelcomeOpen'),
  recent: $('recent'),
  fileInput: $('fileInput'),
  dropOverlay: $('dropOverlay'),
  preview: $('preview'),
};

let docOpen = false;
let currentName = '';
let currentFp = null;
let currentSize = 0;
let searchEntry = null; // history entry reused while stepping through matches

// Reading-progress session: bound file handle + dirty tracking.
const session = { handle: null, dirty: false, saving: false };
let fileSaveTimer = 0;
let restoring = false; // suppress dirty-marking while restoring state

// ---------- core objects ----------

const viewer = new Viewer(els.viewerContainer, els.viewer, {
  onLinkClick: handleLinkClick,
  onLinkHover: () => {},
  onPageChange: (n) => {
    if (document.activeElement !== els.pageInput) els.pageInput.value = String(n);
  },
  onScroll: onViewerScroll,
  onPageRendered: (p, n) => {
    if (search.query) search.highlightPage(p, n);
  },
  onScaleChange: () => {
    updateZoomLabel();
    scheduleSave();
  },
});

const hist = new NavStacks(null);
hist.onChange = () => {
  renderHistory();
  updateNavButtons();
  scheduleSave();
};

const search = new SearchController(viewer);

// ---------- helpers ----------

function toast(msg, ms = 2600) {
  document.querySelectorAll('#toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.id = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function updateZoomLabel() {
  els.zoomLevel.textContent = Math.round(viewer.scale * 100) + '%';
}

function updateNavButtons() {
  els.btnBack.disabled = !hist.canBack();
  els.btnFwd.disabled = !hist.canForward();
}

function renderHistory() {
  renderStacksPanel(hist, els.stacksPanel, {
    onStackClick: onStackSwitch,
    onStackClose: onStackClose,
    onStackRename: (id, name) => {
      hist.renameStack(id, name);
      renderHistory(); // restore the row even if the name was rejected
    },
  });
  renderStackEntries(hist, els.historyPanel, {
    onEntryClick: onHistEntryClick,
  });
}

function updateCurrentBadge() {
  const badge = els.historyPanel.querySelector('.histItem.current .pg');
  if (badge && hist.current) badge.textContent = 'p.' + hist.current.pos.page;
}

// ---------- persistence ----------

let saveTimer = 0;

function serializeState() {
  return {
    v: 1,
    name: currentName,
    scale: viewer.scale,
    fitWidth: viewer.fitWidth,
    hist: hist.serialize(),
    pos: viewer.currentPosition(),
    ts: Date.now(),
  };
}

function scheduleSave() {
  if (!docOpen) return;
  markDirty();
  if (!currentFp) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    Store.saveDoc(currentFp, serializeState());
  }, 800);
}

// ---------- reading-progress session files ----------

function markDirty() {
  if (restoring || !docOpen) return;
  if (!session.dirty) {
    session.dirty = true;
    updateSaveUI();
  }
  if (session.handle) {
    // Bound to a progress file: auto-save continuously (debounced).
    clearTimeout(fileSaveTimer);
    fileSaveTimer = setTimeout(() => {
      writeProgress().catch((e) => console.warn('auto-save failed', e));
    }, 1500);
  }
}

function updateSaveUI() {
  const b = els.btnSave;
  if (!docOpen) {
    b.disabled = true;
    b.textContent = 'Save';
    return;
  }
  b.disabled = false;
  b.textContent = session.saving
    ? 'Saving\u2026'
    : session.dirty
      ? 'Save \u2022'
      : (session.handle ? 'Saved' : 'Save');
  b.title = session.handle
    ? 'Reading progress auto-saves to ' + (session.handle.name || 'file') + ' (Cmd/Ctrl+S to save now)'
    : 'Save reading progress to a file (Cmd/Ctrl+S)';
}

const PROGRESS_TYPE = 'pdf-stack-reader-progress';

function progressFileObject() {
  return {
    type: PROGRESS_TYPE,
    v: 1,
    savedAt: Date.now(),
    pdf: {
      name: currentName,
      // Path of the PDF relative to the progress file. The browser cannot
      // see real paths, so this assumes the two files live side by side
      // (which also makes the pair portable as a unit).
      relPath: currentName,
      fingerprint: currentFp,
      size: currentSize,
    },
    state: serializeState(),
  };
}

async function writeProgress() {
  if (!session.handle || session.saving || !docOpen) return;
  session.saving = true;
  updateSaveUI();
  try {
    const w = await session.handle.createWritable();
    await w.write(JSON.stringify(progressFileObject(), null, 1));
    await w.close();
    session.dirty = false;
  } finally {
    session.saving = false;
    updateSaveUI();
  }
}

async function saveProgress() {
  if (!docOpen) return;
  if (!session.handle) {
    if (!window.showSaveFilePicker) {
      toast('Saving progress files requires a Chromium-based browser');
      return;
    }
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: currentName.replace(/\.pdf$/i, '') + '.psr.json',
        types: [{
          description: 'Reading progress',
          accept: { 'application/json': ['.json'] },
        }],
      });
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      throw e;
    }
    session.handle = handle;
    if (currentFp) {
      putRecent({ fp: currentFp, name: currentName, ts: Date.now(), progressHandle: handle });
    }
  }
  await writeProgress();
  toast('Progress saved');
}

// Warn about unsaved reading progress when closing the tab. When bound to
// a progress file this only triggers if an auto-save hasn't landed yet.
window.addEventListener('beforeunload', (e) => {
  if (docOpen && session.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Flush state when the tab is hidden or closing.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && docOpen) {
    if (currentFp) Store.saveDoc(currentFp, serializeState());
    if (session.handle && session.dirty) {
      writeProgress().catch(() => { /* dirty flag stays honest */ });
    }
  }
});

function restoreStateFrom(d) {
  if (!d || d.v !== 1) return false;
  if (typeof d.scale === 'number') {
    viewer.setScale(d.scale, { fitWidth: !!d.fitWidth });
  }
  if (d.hist) hist.load(d.hist);
  const pos = (hist.current && hist.current.pos) || d.pos;
  if (pos) viewer.scrollTo(pos);
  return true;
}

function restoreState() {
  return currentFp ? restoreStateFrom(Store.loadDoc(currentFp)) : false;
}

// ---------- recent files ----------

async function renderRecents() {
  const entries = await getRecents();
  els.recent.replaceChildren();
  if (!entries.length) return;
  const h = document.createElement('h3');
  h.textContent = 'Recent';
  els.recent.appendChild(h);
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'recentItem';
    row.textContent = entry.name;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(entry.ts).toLocaleDateString();
    row.appendChild(when);
    row.addEventListener('click', async () => {
      if (entry.handle) {
        if (await ensureReadPermission(entry.handle)) {
          try {
            const file = await entry.handle.getFile();
            await openFile(file, entry.handle);
            return;
          } catch (e) {
            console.warn('reopen via handle failed', e);
          }
        }
      }
      toast('Please locate \u201c' + entry.name + '\u201d again');
      pickFile();
    });
    els.recent.appendChild(row);
  }
}

// ---------- navigation semantics ----------

// A deliberate jump: record where we were, go to `pos`, push a history
// entry — or, when forking (cmd/ctrl/middle-click), copy the whole history
// into a new stack first.
function jumpVia(pos, label, fork = false) {
  hist.updateCurrentPos(viewer.currentPosition());
  viewer.scrollTo(pos);
  if (fork) {
    hist.fork({ label, pos });
    toast('Forked into a new stack');
  } else {
    hist.visit({ label, pos });
  }
}

async function handleLinkClick({ dest, pageRec, linkEl, fork }) {
  const info = await viewer.resolveDest(dest);
  if (!info) { toast('Could not resolve link destination'); return; }
  const label = (await viewer.getLinkLabel(pageRec, linkEl)) || ('p.' + info.page);
  jumpVia(info, label, !!fork);
}

function goBack() {
  if (!hist.canBack()) return;
  hist.updateCurrentPos(viewer.currentPosition());
  const n = hist.back();
  if (n) viewer.scrollTo(n.pos);
}

function goForward() {
  if (!hist.canForward()) return;
  hist.updateCurrentPos(viewer.currentPosition());
  const n = hist.forward();
  if (n) viewer.scrollTo(n.pos);
}

function onHistEntryClick(i) {
  if (i === hist.active.index) {
    viewer.scrollTo(hist.current.pos);
    return;
  }
  hist.updateCurrentPos(viewer.currentPosition());
  const n = hist.jumpTo(i);
  if (n) viewer.scrollTo(n.pos);
}

function onStackSwitch(id) {
  if (id === hist.activeId) return;
  hist.updateCurrentPos(viewer.currentPosition());
  const n = hist.switchStack(id);
  if (n) viewer.scrollTo(n.pos);
}

function onStackClose(id) {
  const wasActive = hist.closeStack(id);
  if (wasActive && hist.current) viewer.scrollTo(hist.current.pos);
}

let scrollTimer = 0;
function onViewerScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (!docOpen || viewer.isTrackingSuppressed()) return;
    hist.updateCurrentPos(viewer.currentPosition());
    updateCurrentBadge();
    scheduleSave();
  }, 500);
}

// ---------- search ----------

let searchDebounce = 0;

async function runSearch(q, { jump } = { jump: true }) {
  await search.setQuery(q);
  els.searchCount.textContent = search.countLabel();
  await search.refreshHighlights();
  if (jump && q && search.matches.length) await gotoMatch(1);
}

async function gotoMatch(dir) {
  const m = search.step(dir);
  els.searchCount.textContent = search.countLabel();
  if (!m) return;
  const yr = await search.matchYRatio(m);
  const pos = { page: m.page, yRatio: Math.max(0, yr - 0.05) };
  const label = '\u201c' + search.query + '\u201d';
  if (searchEntry && hist.current === searchEntry) {
    // Iterating matches: move the existing search entry along instead of
    // pushing one entry per match.
    searchEntry.label = label;
    hist.updateCurrentPos(pos);
    viewer.scrollTo(pos);
    renderHistory();
  } else {
    hist.updateCurrentPos(viewer.currentPosition());
    viewer.scrollTo(pos);
    searchEntry = hist.visit({ label, pos });
  }
  await search.refreshHighlights();
}

// ---------- outline ----------

async function buildOutline() {
  els.outlinePanel.replaceChildren();
  let outline = null;
  try { outline = await viewer.doc.getOutline(); } catch { /* ignore */ }
  if (!outline || !outline.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'No outline in this document';
    els.outlinePanel.appendChild(d);
    return;
  }
  const rootUl = document.createElement('ul');
  rootUl.className = 'outline';
  const add = (items, parent) => {
    for (const it of items) {
      const li = document.createElement('li');
      const div = document.createElement('div');
      div.className = 'outlineItem';
      div.textContent = it.title || '\u2014';
      div.title = it.title || '';
      div.addEventListener('click', async (ev) => {
        if (!it.dest) return;
        const info = await viewer.resolveDest(it.dest);
        if (info) {
          jumpVia(info, it.title || ('p.' + info.page), ev.metaKey || ev.ctrlKey);
        }
      });
      li.appendChild(div);
      if (it.items && it.items.length) {
        const sub = document.createElement('ul');
        add(it.items, sub);
        li.appendChild(sub);
      }
      parent.appendChild(li);
    }
  };
  add(outline, rootUl);
  els.outlinePanel.appendChild(rootUl);
}

// ---------- opening documents ----------

async function openData(data, name, { handle = null, progress = null, progressHandle = null } = {}) {
  toast('Loading \u201c' + name + '\u201d\u2026', 1500);
  // Read the size before pdf.js transfers (detaches) the buffer to its worker.
  const size = (data && data.byteLength) || 0;
  try {
    const doc = await viewer.open({ data });
    if (!doc) return;
    docOpen = true;
    currentName = name;
    currentFp = (doc.fingerprints && doc.fingerprints[0]) || null;
    currentSize = size;
    searchEntry = null;

    els.docTitle.textContent = name;
    document.title = name + ' \u2014 PDF Stack Reader';
    els.pageCount.textContent = '/ ' + viewer.numPages;
    els.pageInput.value = '1';
    els.pageInput.disabled = false;
    els.searchInput.disabled = false;
    els.searchInput.value = '';
    els.searchCount.textContent = '';
    els.welcome.classList.add('hidden');

    restoring = true;
    try {
      search.reset();
      hist.reset();
      updateZoomLabel();
      buildOutline();
      if (progress && progress.state) {
        restoreStateFrom(progress.state);
      } else {
        restoreState();
      }
    } finally {
      restoring = false;
    }

    session.handle = progressHandle || null;
    session.dirty = false;
    session.saving = false;
    clearTimeout(fileSaveTimer);
    updateSaveUI();
    if (progress && progress.pdf && progress.pdf.fingerprint
        && currentFp && progress.pdf.fingerprint !== currentFp) {
      toast('Note: this PDF differs from the one the progress file was saved with', 4500);
    }

    els.viewerContainer.focus();
    if (currentFp) {
      putRecent({
        fp: currentFp, name, ts: Date.now(),
        handle: handle || undefined,
        progressHandle: progressHandle || undefined,
      });
    }
  } catch (e) {
    console.error(e);
    toast('Failed to open PDF: ' + (e && e.message ? e.message : e));
  }
}

function isProgressName(name) {
  return /\.(json|psr)$/i.test(name || '');
}

function validProgress(json) {
  return json && json.type === PROGRESS_TYPE && json.pdf && json.state;
}

async function openFile(file, handle = null) {
  if (!file) return;
  if (isProgressName(file.name)) {
    await openProgressFile(file, handle);
    return;
  }
  const buf = await file.arrayBuffer();
  await openData(new Uint8Array(buf), file.name, { handle });
}

// Open a reading-progress file: locate its PDF (stored handle from a
// previous session, else ask), restore the saved state, and bind the
// progress handle for continuous auto-save.
async function openProgressFile(file, progressHandle = null) {
  let json = null;
  try { json = JSON.parse(await file.text()); } catch { /* fallthrough */ }
  if (!validProgress(json)) {
    toast('Not a PDF Stack Reader progress file');
    return;
  }
  let pdfFile = null;
  let pdfHandle = null;
  const rec = json.pdf.fingerprint ? await getRecent(json.pdf.fingerprint) : null;
  if (rec && rec.handle && await ensureReadPermission(rec.handle)) {
    try {
      pdfFile = await rec.handle.getFile();
      pdfHandle = rec.handle;
    } catch (e) {
      console.warn('stored PDF handle no longer valid', e);
    }
  }
  if (!pdfFile) {
    toast('Select the PDF: ' + json.pdf.name, 4000);
    if (!window.showOpenFilePicker) {
      pendingProgress = { json, progressHandle };
      els.fileInput.value = '';
      els.fileInput.click();
      return;
    }
    try {
      const opts = {
        types: [{ description: 'PDF documents', accept: { 'application/pdf': ['.pdf'] } }],
      };
      if (progressHandle) opts.startIn = progressHandle; // open in the same folder
      const [h] = await window.showOpenFilePicker(opts);
      pdfFile = await h.getFile();
      pdfHandle = h;
    } catch (e) {
      if (e && e.name !== 'AbortError') console.warn(e);
      return;
    }
  }
  const buf = new Uint8Array(await pdfFile.arrayBuffer());
  await openData(buf, pdfFile.name, { handle: pdfHandle, progress: json, progressHandle });
}

let pendingProgress = null; // progress json waiting for a PDF via <input> fallback

async function pickFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'PDF or reading progress',
          accept: {
            'application/pdf': ['.pdf'],
            'application/json': ['.json'],
          },
        }],
        excludeAcceptAllOption: false,
      });
      if (handle) await openFile(await handle.getFile(), handle);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user cancelled
      console.warn('showOpenFilePicker failed, falling back', e);
    }
  }
  els.fileInput.value = '';
  els.fileInput.click();
}

// ---------- UI events ----------

els.btnOpen.addEventListener('click', pickFile);
els.btnWelcomeOpen.addEventListener('click', pickFile);
els.btnSave.addEventListener('click', () => {
  saveProgress().catch((e) => toast('Save failed: ' + (e && e.message ? e.message : e)));
});
els.fileInput.addEventListener('change', async () => {
  const f = els.fileInput.files[0];
  if (!f) return;
  if (pendingProgress && /\.pdf$/i.test(f.name)) {
    const pp = pendingProgress;
    pendingProgress = null;
    const buf = new Uint8Array(await f.arrayBuffer());
    await openData(buf, f.name, { progress: pp.json, progressHandle: pp.progressHandle });
    return;
  }
  pendingProgress = null;
  openFile(f);
});

els.btnBack.addEventListener('click', goBack);
els.btnFwd.addEventListener('click', goForward);

els.btnZoomIn.addEventListener('click', () => viewer.setScale(viewer.scale * 1.15));
els.btnZoomOut.addEventListener('click', () => viewer.setScale(viewer.scale / 1.15));
els.btnFit.addEventListener('click', () =>
  viewer.setScale(viewer.computeFitScale(), { fitWidth: true }));

els.btnSidebar.addEventListener('click', () => els.sidebar.classList.toggle('hidden'));

els.btnClearTree.addEventListener('click', () => {
  if (!docOpen) return;
  hist.reset();
  hist.updateCurrentPos(viewer.currentPosition());
  renderHistory();
});

els.sideTabs.querySelectorAll('button[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    els.sideTabs.querySelectorAll('button[data-tab]').forEach((b) =>
      b.classList.toggle('active', b === btn));
    els.historyPanel.classList.toggle('hidden', btn.dataset.tab !== 'history');
    els.outlinePanel.classList.toggle('hidden', btn.dataset.tab !== 'outline');
  });
});

els.pageInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const n = parseInt(els.pageInput.value, 10);
  if (Number.isFinite(n) && n >= 1 && n <= viewer.numPages) {
    jumpVia({ page: n, yRatio: 0 }, 'p. ' + n);
    els.pageInput.blur();
  }
});

els.searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = els.searchInput.value.trim();
  searchDebounce = setTimeout(() => runSearch(q), 350);
});
els.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    gotoMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    els.searchInput.value = '';
    runSearch('', { jump: false });
    els.searchInput.blur();
    els.viewerContainer.focus();
  }
});
els.btnSearchNext.addEventListener('click', () => gotoMatch(1));
els.btnSearchPrev.addEventListener('click', () => gotoMatch(-1));

// global keyboard
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveProgress().catch((err) => toast('Save failed: ' + (err && err.message ? err.message : err)));
    return;
  }
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey) return;

  switch (e.key) {
    case 'Backspace':
      e.preventDefault();
      if (e.shiftKey) goForward(); else goBack();
      break;
    case 'ArrowLeft':
      if (e.altKey) { e.preventDefault(); goBack(); }
      break;
    case 'ArrowRight':
      if (e.altKey) { e.preventDefault(); goForward(); }
      break;
    case '/':
      e.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      break;
    case '+':
    case '=':
      viewer.setScale(viewer.scale * 1.15);
      break;
    case '-':
      viewer.setScale(viewer.scale / 1.15);
      break;
    case '0':
      viewer.setScale(viewer.computeFitScale(), { fitWidth: true });
      break;
    case 't':
      els.sidebar.classList.toggle('hidden');
      break;
    case 'o':
      pickFile();
      break;
    default:
      break;
  }
});

// drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  els.dropOverlay.classList.remove('hidden');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.dropOverlay.classList.add('hidden');
  }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.classList.add('hidden');
  if (!e.dataTransfer) return;
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  let handle = null;
  try {
    if (item && item.getAsFileSystemHandle) handle = await item.getAsFileSystemHandle();
  } catch { /* handle stays null */ }
  openFile(f, handle);
});

// ---------- panel resizing ----------

const UI_KEY = 'psr:ui';
function loadUI() {
  try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { return {}; }
}
function saveUI(patch) {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ ...loadUI(), ...patch })); } catch { /* ignore */ }
}

function setPanelWidth(el, w) {
  el.style.width = w + 'px';
  el.style.minWidth = w + 'px';
}

function setupResizer(handleEl, targetEl, key, min, max) {
  handleEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handleEl.setPointerCapture(e.pointerId);
    handleEl.classList.add('dragging');
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const startW = targetEl.getBoundingClientRect().width;
    const move = (ev) => {
      setPanelWidth(targetEl, Math.min(max, Math.max(min, startW + ev.clientX - startX)));
    };
    const up = () => {
      handleEl.removeEventListener('pointermove', move);
      handleEl.removeEventListener('pointerup', up);
      handleEl.classList.remove('dragging');
      document.body.classList.remove('resizing');
      saveUI({ [key]: Math.round(targetEl.getBoundingClientRect().width) });
      if (docOpen && viewer.fitWidth) {
        viewer.setScale(viewer.computeFitScale(), { fitWidth: true });
      }
    };
    handleEl.addEventListener('pointermove', move);
    handleEl.addEventListener('pointerup', up);
  });
}

setupResizer(els.resizeStacks, els.stacksCol, 'stacksW', 90, 400);
setupResizer(els.resizeSidebar, els.sidebar, 'sidebarW', 220, 800);
{
  const ui = loadUI();
  if (ui.stacksW) setPanelWidth(els.stacksCol, ui.stacksW);
  if (ui.sidebarW) setPanelWidth(els.sidebar, ui.sidebarW);
}

// refit on window resize
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (docOpen && viewer.fitWidth) {
      viewer.setScale(viewer.computeFitScale(), { fitWidth: true });
    }
  }, 200);
});

// ---------- boot ----------

renderHistory();
updateNavButtons();
renderRecents();

const params = new URLSearchParams(location.search);
const fileParam = params.get('file');
if (fileParam) {
  (async () => {
    try {
      const r = await fetch(fileParam);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (isProgressName(fileParam)) {
        // Progress file served over HTTP: resolve the PDF via its relative
        // path next to the progress file.
        const json = await r.json();
        if (!validProgress(json)) throw new Error('not a progress file');
        const pdfUrl = new URL(
          json.pdf.relPath || json.pdf.name,
          new URL(fileParam, location.href),
        );
        const pr = await fetch(pdfUrl);
        if (!pr.ok) throw new Error('PDF not found at ' + pdfUrl.pathname);
        const buf = new Uint8Array(await pr.arrayBuffer());
        // No writable handle over HTTP: session stays unbound (dirty flow).
        await openData(buf, decodeURIComponent(pdfUrl.pathname.split('/').pop()), { progress: json });
      } else {
        const buf = new Uint8Array(await r.arrayBuffer());
        await openData(buf, decodeURIComponent(fileParam.split('/').pop()));
      }
    } catch (e) {
      toast('Could not load ' + fileParam + ' (' + e.message + ')');
    }
  })();
}

// Expose internals for debugging / automated tests.
window.__psr = {
  viewer, hist, search, jumpVia, goBack, goForward,
  session, saveProgress, writeProgress, progressFileObject,
};
