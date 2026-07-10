// PDF Tree Reader — application wiring.

import { Viewer } from './viewer.js';
import { NavTree, renderTree } from './navtree.js';
import { SearchController } from './search.js';

const $ = (id) => document.getElementById(id);
const els = {
  toolbar: $('toolbar'),
  btnSidebar: $('btnSidebar'),
  btnOpen: $('btnOpen'),
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
let searchNodeId = null;

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
  onScaleChange: updateZoomLabel,
});

const tree = new NavTree(null);
tree.onChange = () => {
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
  els.btnBack.disabled = !tree.canBack();
  els.btnFwd.disabled = !tree.canForward();
}

function renderHistory() {
  renderTree(tree, els.historyPanel, onTreeNodeClick);
}

function updateCurrentBadge() {
  const badge = els.historyPanel.querySelector('.treeNode.current .pg');
  if (badge && tree.current) badge.textContent = 'p.' + tree.current.pos.page;
}

// Persistence hooks — filled in by the persistence feature.
function scheduleSave() {}
function restoreState() { return false; }

// ---------- navigation semantics ----------

// A deliberate jump: record where we were, go to `pos`, add a tree node.
function jumpVia(pos, label) {
  tree.updateCurrentPos(viewer.currentPosition());
  viewer.scrollTo(pos);
  tree.visit({ label, pos });
}

async function handleLinkClick({ dest, pageRec, linkEl }) {
  const info = await viewer.resolveDest(dest);
  if (!info) { toast('Could not resolve link destination'); return; }
  const label = (await viewer.getLinkLabel(pageRec, linkEl)) || ('p.' + info.page);
  jumpVia(info, label);
}

function goBack() {
  if (!tree.canBack()) return;
  tree.updateCurrentPos(viewer.currentPosition());
  const n = tree.back();
  if (n) viewer.scrollTo(n.pos);
}

function goForward() {
  if (!tree.canForward()) return;
  tree.updateCurrentPos(viewer.currentPosition());
  const n = tree.forward();
  if (n) viewer.scrollTo(n.pos);
}

function onTreeNodeClick(id) {
  if (id === tree.currentId) {
    viewer.scrollTo(tree.current.pos);
    return;
  }
  tree.updateCurrentPos(viewer.currentPosition());
  const n = tree.jump(id);
  if (n) viewer.scrollTo(n.pos);
}

let scrollTimer = 0;
function onViewerScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (!docOpen || viewer.isTrackingSuppressed()) return;
    tree.updateCurrentPos(viewer.currentPosition());
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
  if (searchNodeId != null && searchNodeId === tree.currentId) {
    // Iterating matches: move the existing search node along instead of
    // creating one node per match.
    tree.current.label = label;
    tree.updateCurrentPos(pos);
    viewer.scrollTo(pos);
    renderHistory();
  } else {
    tree.updateCurrentPos(viewer.currentPosition());
    viewer.scrollTo(pos);
    const n = tree.visit({ label, pos });
    searchNodeId = n.id;
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
      div.addEventListener('click', async () => {
        if (!it.dest) return;
        const info = await viewer.resolveDest(it.dest);
        if (info) jumpVia(info, it.title || ('p.' + info.page));
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

async function openData(data, name) {
  toast('Loading \u201c' + name + '\u201d\u2026', 1500);
  try {
    const doc = await viewer.open({ data });
    if (!doc) return;
    docOpen = true;
    currentName = name;
    currentFp = (doc.fingerprints && doc.fingerprints[0]) || null;
    searchNodeId = null;

    els.docTitle.textContent = name;
    document.title = name + ' \u2014 PDF Tree Reader';
    els.pageCount.textContent = '/ ' + viewer.numPages;
    els.pageInput.value = '1';
    els.pageInput.disabled = false;
    els.searchInput.disabled = false;
    els.searchInput.value = '';
    els.searchCount.textContent = '';
    els.welcome.classList.add('hidden');

    search.reset();
    tree.reset();
    updateZoomLabel();
    buildOutline();
    restoreState();
    els.viewerContainer.focus();
  } catch (e) {
    console.error(e);
    toast('Failed to open PDF: ' + (e && e.message ? e.message : e));
  }
}

async function openFile(file) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  await openData(new Uint8Array(buf), file.name);
}

function pickFile() {
  els.fileInput.value = '';
  els.fileInput.click();
}

// ---------- UI events ----------

els.btnOpen.addEventListener('click', pickFile);
els.btnWelcomeOpen.addEventListener('click', pickFile);
els.fileInput.addEventListener('change', () => openFile(els.fileInput.files[0]));

els.btnBack.addEventListener('click', goBack);
els.btnFwd.addEventListener('click', goForward);

els.btnZoomIn.addEventListener('click', () => viewer.setScale(viewer.scale * 1.15));
els.btnZoomOut.addEventListener('click', () => viewer.setScale(viewer.scale / 1.15));
els.btnFit.addEventListener('click', () =>
  viewer.setScale(viewer.computeFitScale(), { fitWidth: true }));

els.btnSidebar.addEventListener('click', () => els.sidebar.classList.toggle('hidden'));

els.btnClearTree.addEventListener('click', () => {
  if (!docOpen) return;
  tree.reset();
  tree.updateCurrentPos(viewer.currentPosition());
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
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.classList.add('hidden');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f);
});

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

const params = new URLSearchParams(location.search);
const fileParam = params.get('file');
if (fileParam) {
  fetch(fileParam)
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    })
    .then((b) => openData(new Uint8Array(b), fileParam.split('/').pop()))
    .catch((e) => toast('Could not load ' + fileParam + ' (' + e.message + ')'));
}

// Expose internals for debugging / automated tests.
window.__ptr = { viewer, tree, search, jumpVia, goBack, goForward };
