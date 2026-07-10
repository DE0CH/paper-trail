// Application controller: owns the viewer, history stacks, search, hover
// preview, persistence, and reading-progress sessions. Framework-agnostic;
// the React UI subscribes to an immutable snapshot and calls methods.

import { Viewer, type LinkInfo } from './viewer';
import { NavStacks } from './history';
import { SearchController } from './search';
import { Preview } from './preview';
import {
  Store, putRecent, getRecent, getRecents, ensureReadPermission,
} from './store';
import { parseProgress, serializeProgress, PROGRESS_EXT } from './progressFormat';
import type {
  HistStack, OutlineNode, Pos, ProgressFile, RecentEntry, SerializedState,
} from './types';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved';

export interface Snapshot {
  docOpen: boolean;
  docTitle: string;
  numPages: number;
  currentPage: number;
  zoomPercent: number;
  canBack: boolean;
  canForward: boolean;
  canUndo: boolean;
  canRedo: boolean;
  stacks: HistStack[];
  activeStackId: number;
  activeIndex: number;
  outline: OutlineNode[];
  recents: RecentEntry[];
  searchCount: string;
  save: SaveState;
  saveBound: boolean;
  toast: { id: number; msg: string } | null;
  /** A session file was opened first; waiting for the user to open its PDF. */
  pendingPdfName: string | null;
  /** A session load needs confirmation (it replaces current reading state). */
  confirmPdfName: string | null;
  /** The open PDF doesn't match the one the session was saved with. */
  mismatch: { savedName: string; openName: string } | null;
}

interface Session {
  handle: FileSystemFileHandle | null;
  dirty: boolean;
  saving: boolean;
}

export class Controller {
  viewer!: Viewer;
  hist = new NavStacks(null);
  search!: SearchController;
  preview: Preview | null = null;
  session: Session = { handle: null, dirty: false, saving: false };

  private docOpen = false;
  private currentName = '';
  private currentFp: string | null = null;
  private currentSize = 0;
  private searchEntry: ReturnType<NavStacks['visit']> | null = null;
  private outline: OutlineNode[] = [];
  private recents: RecentEntry[] = [];
  private toast_: { id: number; msg: string } | null = null;
  private toastSeq = 0;
  private currentPage = 1;
  private restoring = false;
  private pendingProgress: { json: ProgressFile } | null = null;
  private confirmSession: {
    json: ProgressFile;
    progressHandle: FileSystemFileHandle | null;
  } | null = null;
  private mismatch_: { savedName: string; openName: string } | null = null;

  private saveTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private fileSaveTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private scrollTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private toastTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private pinchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private pinchTarget: number | null = null;
  private pinchAnchor: { x: number; y: number } | null = null;

  private listeners = new Set<() => void>();
  private snapshot: Snapshot | null = null;
  private fileInput: HTMLInputElement | null = null;

  // ---------- lifecycle ----------

  attach(container: HTMLElement, viewerEl: HTMLElement, previewEl: HTMLElement): void {
    this.viewer = new Viewer(container, viewerEl, {
      onLinkClick: (info) => void this.handleLinkClick(info),
      onLinkHover: (info, entering) => {
        if (!this.preview) return;
        if (entering) this.preview.scheduleShow(info.dest, info.linkEl);
        else this.preview.scheduleHide(); // entering the popup cancels this
      },
      onPageChange: (n) => {
        this.currentPage = n;
        this.notify();
      },
      onScroll: () => this.onViewerScroll(),
      onPageRendered: (p, n) => {
        if (this.search.query) void this.search.highlightPage(p, n);
      },
      onScaleChange: () => {
        this.scheduleSave();
        this.notify();
      },
    });
    this.search = new SearchController(this.viewer);
    this.preview = new Preview(this.viewer, previewEl);
    this.hist.onChange = () => {
      this.scheduleSave();
      this.notify();
    };

    // Trackpad pinch (and ctrl+wheel) zooms the document by re-rendering at
    // the new scale, anchored at the cursor — instead of the browser's
    // pixel-magnifying visual zoom.
    container.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (!this.docOpen) return;
      const base = this.pinchTarget ?? this.viewer.scale;
      this.pinchTarget = Math.min(Math.max(base * Math.exp(-e.deltaY * 0.01), 0.25), 5);
      this.pinchAnchor = { x: e.clientX, y: e.clientY };
      if (!this.pinchTimer) {
        this.pinchTimer = setTimeout(() => {
          this.pinchTimer = 0;
          if (this.pinchTarget == null || !this.pinchAnchor) return;
          this.viewer.setScale(this.pinchTarget, { anchor: this.pinchAnchor });
          this.pinchTarget = null;
        }, 120);
      }
    }, { passive: false });

    window.addEventListener('beforeunload', (e) => {
      // Warn about unsaved reading progress. When bound to a progress file
      // this only triggers if an auto-save hasn't landed yet.
      if (this.docOpen && this.session.dirty) {
        e.preventDefault();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.docOpen) {
        if (this.currentFp) Store.saveDoc(this.currentFp, this.serializeState());
        if (this.session.handle && this.session.dirty) {
          this.writeProgress().catch(() => { /* dirty flag stays honest */ });
        }
      }
    });

    void this.refreshRecents();
    void this.bootFromQuery();

    // Test / debugging hooks.
    window.__psr = {
      controller: this,
      viewer: this.viewer,
      hist: this.hist,
      search: this.search,
      session: this.session,
      jumpVia: (pos: Pos, label: string, fork?: boolean) => this.jumpVia(pos, label, fork),
      goBack: () => this.goBack(),
      goForward: () => this.goForward(),
      writeProgress: () => this.writeProgress(),
      progressFileObject: () => this.progressFileObject(),
      // format-level hooks for tests
      progressText: () => serializeProgress(this.progressFileObject()),
      parseProgressText: (t: string) => parseProgress(t),
    };
  }

  // ---------- snapshot for the UI ----------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => {
    if (!this.snapshot) {
      this.snapshot = {
        docOpen: this.docOpen,
        docTitle: this.currentName,
        numPages: this.viewer ? this.viewer.numPages : 0,
        currentPage: this.currentPage,
        zoomPercent: this.viewer ? Math.round(this.viewer.scale * 100) : 100,
        canBack: this.hist.canBack(),
        canForward: this.hist.canForward(),
        canUndo: this.hist.canUndo(),
        canRedo: this.hist.canRedo(),
        stacks: this.hist.stacks.map((s) => ({
          ...s,
          entries: s.entries.map((e) => ({ label: e.label, pos: { ...e.pos } })),
        })),
        activeStackId: this.hist.activeId,
        activeIndex: this.hist.active.index,
        outline: this.outline,
        recents: this.recents,
        searchCount: this.search ? this.search.countLabel() : '',
        save: this.session.saving
          ? 'saving'
          : this.session.dirty
            ? 'dirty'
            : this.session.handle
              ? 'saved'
              : 'idle',
        saveBound: !!this.session.handle,
        toast: this.toast_,
        pendingPdfName: this.pendingProgress?.json.pdf.name ?? null,
        confirmPdfName: this.confirmSession?.json.pdf.name ?? null,
        mismatch: this.mismatch_,
      };
    }
    return this.snapshot;
  };

  private notify(): void {
    this.snapshot = null;
    for (const fn of this.listeners) fn();
  }

  showToast(msg: string, ms = 2600): void {
    this.toast_ = { id: ++this.toastSeq, msg };
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast_ = null;
      this.notify();
    }, ms);
    this.notify();
  }

  // ---------- persistence ----------

  private serializeState(): SerializedState {
    return {
      v: 1,
      name: this.currentName,
      scale: this.viewer.scale,
      fitWidth: this.viewer.fitWidth,
      hist: this.hist.serialize(),
      pos: this.viewer.currentPosition(),
      ts: Date.now(),
    };
  }

  private scheduleSave(): void {
    if (!this.docOpen) return;
    this.markDirty();
    if (!this.currentFp) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.currentFp) Store.saveDoc(this.currentFp, this.serializeState());
    }, 800);
  }

  private markDirty(): void {
    if (this.restoring || !this.docOpen) return;
    if (!this.session.dirty) {
      this.session.dirty = true;
      this.notify();
    }
    if (this.session.handle) {
      // Bound to a progress file: auto-save continuously (debounced).
      clearTimeout(this.fileSaveTimer);
      this.fileSaveTimer = setTimeout(() => {
        this.writeProgress().catch((e) => console.warn('auto-save failed', e));
      }, 1500);
    }
  }

  private restoreStateFrom(d: SerializedState | null): boolean {
    if (!d || d.v !== 1) return false;
    if (typeof d.scale === 'number') {
      this.viewer.setScale(d.scale, { fitWidth: !!d.fitWidth });
    }
    if (d.hist) this.hist.load(d.hist);
    // The saved view position is where the user actually was (entries keep
    // their own anchored positions and don't follow scrolling).
    const pos = d.pos ?? this.hist.current?.pos;
    if (pos) this.viewer.scrollTo(pos);
    return true;
  }

  private restoreState(): boolean {
    return this.currentFp
      ? this.restoreStateFrom(Store.loadDoc(this.currentFp))
      : false;
  }

  private async refreshRecents(): Promise<void> {
    this.recents = await getRecents();
    this.notify();
  }

  // ---------- reading-progress session files ----------

  progressFileObject(): ProgressFile {
    return {
      type: 'pdf-stack-reader-progress',
      v: 1,
      savedAt: Date.now(),
      pdf: {
        name: this.currentName,
        // Path of the PDF relative to the progress file. The browser cannot
        // see real paths, so this assumes the two files live side by side
        // (which also makes the pair portable as a unit).
        relPath: this.currentName,
        fingerprint: this.currentFp,
        size: this.currentSize,
      },
      state: this.serializeState(),
    };
  }

  async writeProgress(): Promise<void> {
    if (!this.session.handle || this.session.saving || !this.docOpen) return;
    this.session.saving = true;
    this.notify();
    try {
      const w = await this.session.handle.createWritable();
      // Line-oriented plain-text format: small, clear git diffs.
      await w.write(serializeProgress(this.progressFileObject()));
      await w.close();
      this.session.dirty = false;
    } finally {
      this.session.saving = false;
      this.notify();
    }
  }

  async saveProgress(): Promise<void> {
    if (!this.docOpen) return;
    if (!this.session.handle) {
      if (!window.showSaveFilePicker) {
        this.showToast('Saving progress files requires a Chromium-based browser');
        return;
      }
      let handle: FileSystemFileHandle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: this.currentName.replace(/\.pdf$/i, '') + PROGRESS_EXT,
          types: [{
            description: 'Reading progress',
            accept: { 'text/plain': [PROGRESS_EXT] },
          }],
        });
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        throw e;
      }
      this.session.handle = handle;
      if (this.currentFp) {
        void putRecent({
          fp: this.currentFp,
          name: this.currentName,
          ts: Date.now(),
          progressHandle: handle,
        });
      }
    }
    await this.writeProgress();
    this.showToast('Progress saved');
  }

  saveProgressSafe(): void {
    this.saveProgress().catch((e) =>
      this.showToast('Save failed: ' + ((e as Error)?.message ?? String(e))));
  }

  // ---------- navigation ----------

  /**
   * A deliberate jump: record where we were, go to `pos`, push a history
   * entry — or, when forking (cmd/ctrl/middle-click), copy the whole
   * history into a new stack first.
   */
  jumpVia(pos: Pos, label: string, fork = false): void {
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    this.viewer.scrollTo(pos);
    if (fork) {
      this.hist.fork({ label, pos });
      this.showToast('Forked into a new stack');
    } else {
      this.hist.visit({ label, pos });
    }
  }

  private async handleLinkClick(info: LinkInfo): Promise<void> {
    const pos = await this.viewer.resolveDest(info.dest);
    if (!pos) {
      this.showToast('Could not resolve link destination');
      return;
    }
    const label = (await this.viewer.getLinkLabel(info.pageRec, info.linkEl)) ?? `p.${pos.page}`;
    this.jumpVia(pos, label, !!info.fork);
  }

  goBack(): void {
    if (!this.hist.canBack()) return;
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.back();
    if (n) this.viewer.scrollTo(n.pos);
  }

  goForward(): void {
    if (!this.hist.canForward()) return;
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.forward();
    if (n) this.viewer.scrollTo(n.pos);
  }

  histEntryClick(i: number): void {
    if (i === this.hist.active.index) {
      this.viewer.scrollTo(this.hist.current.pos);
      return;
    }
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.jumpTo(i);
    if (n) this.viewer.scrollTo(n.pos);
  }

  stackSwitch(id: number): void {
    if (id === this.hist.activeId) return;
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.switchStack(id);
    if (n) this.viewer.scrollTo(n.pos);
  }

  stackClose(id: number): void {
    const wasActive = this.hist.closeStack(id);
    if (wasActive && this.hist.current) this.viewer.scrollTo(this.hist.current.pos);
  }

  stackRename(id: number, name: string): void {
    this.hist.renameStack(id, name);
    this.notify(); // restore the row even if the name was rejected
  }

  entryRename(i: number, label: string): void {
    this.hist.renameEntry(i, label);
    this.notify();
  }

  clearHistory(): void {
    if (!this.docOpen) return;
    this.hist.clearAll();
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    this.notify();
  }

  /** Undo the last history mutation (overwrite, fork, close, rename, clear). */
  undoHist(): void {
    if (!this.hist.undo()) return;
    if (this.hist.current) this.viewer.scrollTo(this.hist.current.pos);
  }

  redoHist(): void {
    if (!this.hist.redo()) return;
    if (this.hist.current) this.viewer.scrollTo(this.hist.current.pos);
  }

  gotoPage(n: number): void {
    if (!Number.isFinite(n) || n < 1 || n > this.viewer.numPages) return;
    this.jumpVia({ page: n, yRatio: 0 }, `p. ${n}`);
  }

  zoomIn(): void { this.viewer.setScale(this.viewer.scale * 1.15); }
  zoomOut(): void { this.viewer.setScale(this.viewer.scale / 1.15); }
  fitWidth(): void { this.viewer.setScale(this.viewer.computeFitScale(), { fitWidth: true }); }

  refitIfNeeded(): void {
    if (this.docOpen && this.viewer.fitWidth) this.fitWidth();
  }

  private onViewerScroll(): void {
    this.preview?.hide(); // don't leave a stale popup while scrolling
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      if (!this.docOpen || this.viewer.isTrackingSuppressed()) return;
      // Note: scrolling never moves history entries — their positions only
      // change through explicit actions (following a link, back/forward,
      // or the re-anchor button). Only the session's view position updates.
      this.scheduleSave();
      this.notify();
    }, 500);
  }

  // ---------- search ----------

  async runSearch(q: string, { jump = true } = {}): Promise<void> {
    await this.search.setQuery(q);
    this.notify();
    await this.search.refreshHighlights();
    if (jump && q && this.search.matches.length) await this.gotoMatch(1);
  }

  async gotoMatch(dir: 1 | -1): Promise<void> {
    const m = this.search.step(dir);
    this.notify();
    if (!m) return;
    const yr = await this.search.matchYRatio(m);
    const pos: Pos = { page: m.page, yRatio: Math.max(0, yr - 0.05) };
    const label = `\u201c${this.search.query}\u201d`;
    if (this.searchEntry && this.hist.current === this.searchEntry) {
      // Iterating matches: move the existing search entry along instead of
      // pushing one entry per match.
      this.searchEntry.label = label;
      this.hist.updateCurrentPos(pos);
      this.viewer.scrollTo(pos);
      this.notify();
    } else {
      this.hist.updateCurrentPos(this.viewer.currentPosition());
      this.viewer.scrollTo(pos);
      this.searchEntry = this.hist.visit({ label, pos });
    }
    await this.search.refreshHighlights();
  }

  // ---------- outline ----------

  private async buildOutline(): Promise<void> {
    this.outline = [];
    try {
      const raw = await this.viewer.doc?.getOutline();
      const map = (items: Array<{ title?: string; dest?: unknown; items?: unknown[] }>): OutlineNode[] =>
        (items ?? []).map((it) => ({
          title: it.title ?? '\u2014',
          dest: it.dest,
          children: map((it.items ?? []) as Array<{ title?: string; dest?: unknown; items?: unknown[] }>),
        }));
      this.outline = map((raw ?? []) as Array<{ title?: string; dest?: unknown; items?: unknown[] }>);
    } catch { /* no outline */ }
    this.notify();
  }

  async outlineJump(node: OutlineNode, fork = false): Promise<void> {
    if (!node.dest) return;
    const pos = await this.viewer.resolveDest(node.dest as string | unknown[]);
    if (pos) this.jumpVia(pos, node.title || `p.${pos.page}`, fork);
  }

  // ---------- opening documents ----------

  async openData(
    data: Uint8Array,
    name: string,
    opts: {
      handle?: FileSystemFileHandle | null;
      progress?: ProgressFile | null;
      progressHandle?: FileSystemFileHandle | null;
    } = {},
  ): Promise<void> {
    const { handle = null, progress = null, progressHandle = null } = opts;
    this.showToast(`Loading \u201c${name}\u201d\u2026`, 1500);
    // Read the size before pdf.js transfers (detaches) the buffer.
    const size = data.byteLength || 0;
    try {
      const doc = await this.viewer.open({ data });
      if (!doc) return;
      this.docOpen = true;
      this.currentName = name;
      this.currentFp = doc.fingerprints?.[0] ?? null;
      this.currentSize = size;
      this.searchEntry = null;
      this.currentPage = 1;
      document.title = `${name} \u2014 PDF Stack Reader`;

      this.preview?.clear();
      this.restoring = true;
      try {
        this.search.reset();
        this.hist.reset();
        void this.buildOutline();
        if (progress?.state) {
          this.restoreStateFrom(progress.state);
        } else {
          this.restoreState();
        }
      } finally {
        this.restoring = false;
      }

      this.session.handle = progressHandle;
      this.session.dirty = false;
      this.session.saving = false;
      clearTimeout(this.fileSaveTimer);
      this.mismatch_ = (progress?.pdf?.fingerprint && this.currentFp
          && progress.pdf.fingerprint !== this.currentFp)
        ? { savedName: progress.pdf.name, openName: name }
        : null;
      if (this.currentFp) {
        void putRecent({
          fp: this.currentFp,
          name,
          ts: Date.now(),
          handle: handle ?? undefined,
          progressHandle: progressHandle ?? undefined,
        });
        void this.refreshRecents();
      }
      this.currentPage = this.viewer.currentPosition().page;
      this.notify();
    } catch (e) {
      console.error(e);
      this.showToast('Failed to open PDF: ' + ((e as Error)?.message ?? String(e)));
    }
  }

  private isProgressName(name: string): boolean {
    return /\.psr$/i.test(name || '');
  }

  async openFile(file: File, handle: FileSystemFileHandle | null = null): Promise<void> {
    if (!file) return;
    if (this.isProgressName(file.name)) {
      await this.openProgressFile(file, handle);
      return;
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    if (this.pendingProgress) {
      // A session file was opened first; the user is now supplying its
      // PDF — restore that session (and bind its file for auto-save).
      const pp = this.pendingProgress;
      const ph = this.pendingProgressHandle;
      this.pendingProgress = null;
      this.pendingProgressHandle = null;
      await this.openData(buf, file.name, {
        handle,
        progress: pp.json,
        progressHandle: ph,
      });
      return;
    }
    await this.openData(buf, file.name, { handle });
  }

  /** Discard a session that is waiting for its PDF. */
  discardPendingSession(): void {
    this.pendingProgress = null;
    this.pendingProgressHandle = null;
    this.notify();
  }

  private pendingProgressHandle: FileSystemFileHandle | null = null;

  /**
   * Open a reading-session file. If a PDF is already open, the session is
   * applied to it (after confirmation, since it replaces the current
   * reading history). Otherwise the PDF is resolved via a remembered
   * handle when possible; else the app shows a prompt asking for the PDF.
   */
  private async openProgressFile(
    file: File,
    progressHandle: FileSystemFileHandle | null = null,
  ): Promise<void> {
    const json = parseProgress(await file.text());
    if (!json) {
      this.showToast('Not a reading-session file');
      return;
    }

    if (this.docOpen) {
      // Loading a session into the currently open PDF.
      const trivial = this.hist.stacks.length === 1
        && this.hist.stacks[0].entries.length <= 1
        && !this.session.dirty;
      this.confirmSession = { json, progressHandle };
      if (trivial) {
        this.applyConfirmedSession();
      } else {
        this.notify(); // the UI shows a replace-confirmation dialog
      }
      return;
    }

    // Session first: try the remembered PDF silently, else prompt for it.
    const rec = json.pdf.fingerprint ? await getRecent(json.pdf.fingerprint) : null;
    if (rec?.handle && await ensureReadPermission(rec.handle)) {
      try {
        const pdfFile = await rec.handle.getFile();
        const buf = new Uint8Array(await pdfFile.arrayBuffer());
        await this.openData(buf, pdfFile.name, {
          handle: rec.handle,
          progress: json,
          progressHandle,
        });
        return;
      } catch (e) {
        console.warn('stored PDF handle no longer valid', e);
      }
    }
    this.pendingProgress = { json };
    this.pendingProgressHandle = progressHandle;
    this.notify();
  }

  /** Apply a session to the currently open PDF (confirmed by the user). */
  applyConfirmedSession(): void {
    const cs = this.confirmSession;
    if (!cs || !this.docOpen) return;
    this.confirmSession = null;
    this.restoring = true;
    try {
      this.searchEntry = null;
      this.restoreStateFrom(cs.json.state);
    } finally {
      this.restoring = false;
    }
    this.session.handle = cs.progressHandle;
    this.session.dirty = false;
    this.session.saving = false;
    clearTimeout(this.fileSaveTimer);
    this.mismatch_ = (cs.json.pdf.fingerprint && this.currentFp
        && cs.json.pdf.fingerprint !== this.currentFp)
      ? { savedName: cs.json.pdf.name, openName: this.currentName }
      : null;
    if (this.currentFp && cs.progressHandle) {
      void putRecent({
        fp: this.currentFp,
        name: this.currentName,
        ts: Date.now(),
        progressHandle: cs.progressHandle,
      });
    }
    this.notify();
  }

  cancelSessionLoad(): void {
    this.confirmSession = null;
    this.notify();
  }

  /** Banner: hide the mismatch warning (until the next mismatching load). */
  dismissMismatch(): void {
    this.mismatch_ = null;
    this.notify();
  }

  /**
   * Banner: make the currently open PDF the session's PDF — its name,
   * fingerprint, and size are written to the session file on the next
   * (auto-)save.
   */
  adoptCurrentPdf(): void {
    this.mismatch_ = null;
    // progressFileObject() always serializes the currently open PDF's
    // identity, so marking the session dirty is enough to persist it.
    this.scheduleSave();
    if (this.session.handle) {
      this.writeProgress().catch((e) => console.warn('adopt save failed', e));
    }
    this.notify();
  }

  /** Re-anchor a history entry to the current reading position. */
  entrySetPos(i: number): void {
    this.hist.setEntryPos(i, this.viewer.currentPosition());
  }

  /**
   * Replace the open PDF with another file while keeping the whole reading
   * state (all trails, cursor, zoom, session binding). Used e.g. when a
   * paper gets a revised version. The new PDF's identity is adopted into
   * the session, since the swap is deliberate.
   */
  async requestReplacePdf(): Promise<void> {
    if (!this.docOpen) {
      await this.pickFile();
      return;
    }
    if (!window.showOpenFilePicker) {
      this.replaceNext = true;
      this.pickViaInput();
      return;
    }
    try {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: 'PDF documents', accept: { 'application/pdf': ['.pdf'] } }],
      });
      await this.replaceWithFile(await h.getFile(), h);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') console.warn(e);
    }
  }

  private replaceNext = false;

  async replaceWithFile(file: File, handle: FileSystemFileHandle | null = null): Promise<void> {
    if (!this.docOpen) {
      await this.openFile(file, handle);
      return;
    }
    const progress = this.progressFileObject(); // carries the current state
    const progressHandle = this.session.handle;
    const buf = new Uint8Array(await file.arrayBuffer());
    await this.openData(buf, file.name, { handle, progress, progressHandle });
    // Deliberate swap: adopt the new PDF into the session, no banner.
    this.adoptCurrentPdf();
  }

  /** Toolbar / menu entry point: pick a reading-session file. */
  async requestLoadSession(): Promise<void> {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'Reading session',
            accept: { 'text/plain': [PROGRESS_EXT] },
          }],
        });
        if (handle) await this.openProgressFile(await handle.getFile(), handle);
        return;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        console.warn('showOpenFilePicker failed, falling back', e);
      }
    }
    this.pickViaInput();
  }

  async pickFile(): Promise<void> {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'PDF or reading progress',
            accept: {
              'application/pdf': ['.pdf'],
              'text/plain': [PROGRESS_EXT],
            },
          }],
          excludeAcceptAllOption: false,
        });
        if (handle) await this.openFile(await handle.getFile(), handle);
        return;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return; // user cancelled
        console.warn('showOpenFilePicker failed, falling back', e);
      }
    }
    this.pickViaInput();
  }

  private pickViaInput(): void {
    if (!this.fileInput) {
      this.fileInput = document.createElement('input');
      this.fileInput.type = 'file';
      this.fileInput.accept = 'application/pdf,.pdf,.psr';
      this.fileInput.hidden = true;
      document.body.appendChild(this.fileInput);
      this.fileInput.addEventListener('change', () => {
        const f = this.fileInput!.files?.[0];
        if (!f) return;
        if (this.replaceNext) {
          this.replaceNext = false;
          void this.replaceWithFile(f);
          return;
        }
        void this.openFile(f); // openFile applies any pending session
      });
    }
    this.fileInput.value = '';
    this.fileInput.click();
  }

  async openDropped(dt: DataTransfer): Promise<void> {
    const item = dt.items?.[0];
    const f = dt.files?.[0];
    if (!f) return;
    let handle: FileSystemFileHandle | null = null;
    try {
      if (item?.getAsFileSystemHandle) {
        handle = (await item.getAsFileSystemHandle()) as FileSystemFileHandle | null;
      }
    } catch { /* handle stays null */ }
    void this.openFile(f, handle);
  }

  async openRecent(entry: RecentEntry): Promise<void> {
    if (entry.handle && await ensureReadPermission(entry.handle)) {
      try {
        const file = await entry.handle.getFile();
        await this.openFile(file, entry.handle);
        return;
      } catch (e) {
        console.warn('reopen via handle failed', e);
      }
    }
    this.showToast(`Please locate \u201c${entry.name}\u201d again`);
    await this.pickFile();
  }

  private async bootFromQuery(): Promise<void> {
    const fileParam = new URLSearchParams(location.search).get('file');
    if (!fileParam) return;
    try {
      const r = await fetch(fileParam);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (this.isProgressName(fileParam)) {
        // Progress file served over HTTP: resolve the PDF via its relative
        // path next to the progress file.
        const json = parseProgress(await r.text());
        if (!json) throw new Error('not a progress file');
        const pdfUrl = new URL(
          json.pdf.relPath || json.pdf.name,
          new URL(fileParam, location.href),
        );
        const pr = await fetch(pdfUrl);
        if (!pr.ok) {
          // Degrade gracefully: keep the session and ask for the PDF.
          this.pendingProgress = { json };
          this.showToast(
            `Couldn't find the PDF (${json.pdf.relPath}) next to the progress file `
            + '\u2014 open the PDF manually to restore the session',
            7000,
          );
          return;
        }
        const buf = new Uint8Array(await pr.arrayBuffer());
        // No writable handle over HTTP: session stays unbound (dirty flow).
        await this.openData(buf, decodeURIComponent(pdfUrl.pathname.split('/').pop()!), {
          progress: json,
        });
      } else {
        const buf = new Uint8Array(await r.arrayBuffer());
        await this.openData(buf, decodeURIComponent(fileParam.split('/').pop()!));
      }
    } catch (e) {
      this.showToast(`Could not load ${fileParam} (${(e as Error).message})`);
    }
  }
}

export const controller = new Controller();
