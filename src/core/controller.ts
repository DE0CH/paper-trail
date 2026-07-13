// Application controller: owns the viewer, history stacks, search, hover
// preview, persistence, and reading-progress sessions. Framework-agnostic;
// the React UI subscribes to an immutable snapshot and calls methods.

import { MOD } from './platform';
import { Viewer, type LinkInfo } from './viewer';
import { NavStacks } from './history';
import { SearchController } from './search';
import { Preview } from './preview';
import {
  putRecent, getRecents, removeRecent, ensureReadPermission,
} from './store';
import {
  parseProgress, serializeProgress, progressVersion, PROGRESS_EXT, PROGRESS_VERSION,
} from './progressFormat';
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
  /** Desktop shell only: the bound .ptl's on-disk path (no handle exists
   * for OS-opened files). Auto-save and Save write straight back to it. */
  path: string | null;
  dirty: boolean;
  saving: boolean;
}

type PdfSource = File | FileSystemFileHandle | string;

interface ReplaceSlot {
  source: PdfSource;
  state: SerializedState;
}

export class Controller {
  viewer!: Viewer;
  hist = new NavStacks(null);
  search!: SearchController;
  preview: Preview | null = null;
  session: Session = { handle: null, path: null, dirty: false, saving: false };

  private docOpen = false;
  private currentName = '';
  private currentFp: string | null = null;
  private searchEntry: ReturnType<NavStacks['visit']> | null = null;
  private outline: OutlineNode[] = [];
  private recents: RecentEntry[] = [];
  private toast_: { id: number; msg: string } | null = null;
  private toastSeq = 0;
  private currentPage = 1;
  private restoring = false;
  private pendingProgress: { json: ProgressFile } | null = null;
  private pendingProgressPath: string | null = null;
  private confirmSession: {
    json: ProgressFile;
    progressHandle: FileSystemFileHandle | null;
    progressPath: string | null;
  } | null = null;
  private mismatch_: { savedName: string; openName: string } | null = null;

  private fileSaveTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private scrollTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private toastTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private pinchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private pinchStartScale: number | null = null;
  private pinchFactor = 1;
  private pinchAnchor: { x: number; y: number } | null = null;

  // Undoable PDF replacement: single-slot document-level undo/redo. The
  // source is a File / handle / URL (a cheap disk reference, not bytes).
  private currentSource: PdfSource | null = null;
  private replaceUndoSlot: ReplaceSlot | null = null;
  private replaceRedoSlot: ReplaceSlot | null = null;
  private lastReplaceAction: 'none' | 'undoable' | 'redoable' = 'none';

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
        this.markDirty();
        this.notify();
      },
    });
    this.search = new SearchController(this.viewer);
    this.preview = new Preview(this.viewer, previewEl);
    this.hist.onChange = () => {
      this.markDirty();
      this.notify();
    };
    // Any history mutation supersedes a pending replace-undo/redo.
    this.hist.onMutate = () => {
      this.lastReplaceAction = 'none';
    };

    // Trackpad pinch (and ctrl+wheel) zooms the document smoothly: every
    // event updates a cheap CSS transform on the already-rendered pages
    // (instant feedback, anchored at the cursor); when the gesture pauses,
    // the target scale is re-rendered crisply — with the old canvases kept
    // as stretched placeholders, so nothing ever flashes blank.
    container.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (!this.docOpen) return;
      this.pinchAnchor = { x: e.clientX, y: e.clientY };
      if (this.pinchStartScale == null) {
        this.pinchStartScale = this.viewer.scale;
        this.pinchFactor = 1;
        this.viewer.beginVisualZoom();
      }
      const start = this.pinchStartScale;
      this.pinchFactor = Math.min(
        Math.max(this.pinchFactor * Math.exp(-e.deltaY * 0.01), 0.25 / start),
        5 / start,
      );
      this.viewer.applyVisualZoom(this.pinchFactor, this.pinchAnchor);
      clearTimeout(this.pinchTimer);
      this.pinchTimer = setTimeout(() => {
        this.pinchTimer = 0;
        if (this.pinchStartScale == null || !this.pinchAnchor) return;
        const target = this.pinchStartScale * this.pinchFactor;
        this.pinchStartScale = null;
        this.viewer.commitVisualZoom(target, this.pinchAnchor);
      }, 180);
    }, { passive: false });

    window.addEventListener('beforeunload', (e) => {
      if (!this.docOpen || !this.session.dirty) return;
      // Autosave target on disk (a bound .ptl path): don't nag — flush the
      // change and close AT ONCE. The write is a synchronous round-trip to
      // the main process (a tiny .ptl writes in well under a millisecond,
      // so the close still feels instant); on success the window closes, on
      // a failed write we fall through to the normal save prompt below.
      // beforeunload can't await, but a path binding is silent-writable
      // synchronously (canWriteSilently short-circuits on session.path).
      if (this.session.path && window.ptDesktop?.saveSessionOnClose) {
        const ok = window.ptDesktop.saveSessionOnClose(
          this.session.path, serializeProgress(this.progressFileObject()));
        if (ok) { this.session.dirty = false; return; } // saved silently — close now
        // The background write FAILED (unexpected — probably a bug). Never
        // lose the change: fall through to the normal save prompt so the
        // user resolves it with Save / Don't Save as usual.
      }
      // No silent target (or a failed silent write): warn before closing.
      e.preventDefault();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.docOpen) {
        if ((this.session.handle || this.session.path) && this.session.dirty) {
          this.writeProgressAuto().catch(() => { /* dirty flag stays honest */ });
        }
      }
    });

    void this.refreshRecents();
    void this.bootFromQuery();
    this.initTabHandoff();

    // Test / debugging hooks.
    window.__pt = {
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
      // in-memory search-commit state: true = uncommitted (the next
      // find-next overwrites this entry); false = committed/none.
      searchUncommitted: () => this.searchEntry !== null,
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
        canUndo: this.hist.canUndo() || this.lastReplaceAction === 'undoable',
        canRedo: this.hist.canRedo() || this.lastReplaceAction === 'redoable',
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
            : (this.session.handle || this.session.path)
              ? 'saved'
              : 'idle',
        saveBound: !!this.session.handle || !!this.session.path,
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


  private markDirty(): void {
    if (this.restoring || !this.docOpen) return;
    if (!this.session.dirty) {
      this.session.dirty = true;
      this.notify();
    }
    if (this.session.handle || this.session.path) {
      // Bound to a progress file (handle in the browser, path in the
      // desktop shell): auto-save continuously (debounced).
      clearTimeout(this.fileSaveTimer);
      this.fileSaveTimer = setTimeout(() => {
        this.writeProgressAuto().catch((e) => console.warn('auto-save failed', e));
      }, 1500);
    }
  }

  /**
   * True when writing won't trigger a browser permission prompt. Timer
   * saves must never pop a prompt out of nowhere; if permission needs
   * asking, it waits for the next user-initiated save. The desktop
   * shell has no permission UI at all — requests are granted invisibly
   * — so there it simply asks (handles restored from the Recents store
   * always come back in the 'prompt' state).
   */
  private async canWriteSilently(): Promise<boolean> {
    // A desktop path binding writes straight to disk (no permission UI),
    // so it is always silent.
    if (this.session.path) return true;
    const h = this.session.handle;
    if (!h) return false;
    if (!h.queryPermission) return true; // API absent (tests fake)
    try {
      if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
      if (window.ptDesktop && h.requestPermission) {
        return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
      }
      return false;
    } catch {
      return true;
    }
  }

  /** Auto-save path: write only when it can happen without a prompt. */
  private async writeProgressAuto(): Promise<void> {
    if (!(await this.canWriteSilently())) return; // stays dirty; saved on next explicit save
    await this.writeProgress();
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

  private async refreshRecents(): Promise<void> {
    this.recents = await getRecents();
    this.notify();
  }

  /** Remove one entry from the welcome screen's Recent list. */
  async removeRecent(fp: string): Promise<void> {
    await removeRecent(fp);
    await this.refreshRecents();
  }

  // ---------- reading-progress session files ----------

  progressFileObject(): ProgressFile {
    return {
      type: 'pdf-stack-reader-progress',
      v: 1,
      savedAt: Date.now(),
      // Only the name: session files are fully transparent (no hidden
      // identifiers); PDFs are matched by name with a visible warning.
      pdf: { name: this.currentName },
      state: this.serializeState(),
    };
  }

  async writeProgress(): Promise<void> {
    if (this.session.saving || !this.docOpen) return;
    if (!this.session.handle && !this.session.path) return;
    this.session.saving = true;
    this.notify();
    try {
      // Line-oriented plain-text format: small, clear git diffs.
      const text = serializeProgress(this.progressFileObject());
      let ok = false;
      if (this.session.path && window.ptDesktop?.saveSessionToPath) {
        // Desktop: write straight back to the bound file path (no handle
        // exists for an OS-opened .ptl).
        ok = await window.ptDesktop.saveSessionToPath(this.session.path, text);
      } else if (this.session.handle) {
        const w = await this.session.handle.createWritable();
        await w.write(text);
        await w.close();
        ok = true;
      }
      // Only a SUCCESSFUL write clears dirty. A failed write — the path
      // handler returned false, or a handle write threw (skips this line) —
      // leaves the change dirty so it's never silently lost; the next
      // auto-save / manual save / close-flush retries it.
      if (ok) this.session.dirty = false;
    } finally {
      this.session.saving = false;
      this.notify();
    }
  }

  async saveProgress({ viaShellDialog = false } = {}): Promise<void> {
    if (!this.docOpen) return;
    this.commitSearch(); // explicit Save commits; auto-save (writeProgress) must NOT
    // Desktop: a session bound to an on-disk path (an OS-opened .ptl, or
    // one already saved through the shell) writes straight back to it —
    // no dialog.
    if (this.session.path && window.ptDesktop?.saveSessionToPath) {
      const ok = await window.ptDesktop.saveSessionToPath(
        this.session.path, serializeProgress(this.progressFileObject()));
      if (ok) {
        this.session.dirty = false;
        this.showToast('Session saved');
        this.notify();
      }
      return;
    }
    if (this.session.handle) {
      // User-initiated save: the right moment for a permission prompt if
      // one is needed (auto-save never prompts).
      try {
        if (this.session.handle.queryPermission
            && (await this.session.handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          const r = await this.session.handle.requestPermission?.({ mode: 'readwrite' });
          if (r !== 'granted') {
            this.showToast('Write permission denied \u2014 session not saved');
            return;
          }
        }
      } catch { /* proceed; writeProgress surfaces real failures */ }
    }
    if (!this.session.handle) {
      const suggestedName = this.currentName.replace(/\.pdf$/i, '') + PROGRESS_EXT;
      // The unsaved-close prompt's Save must not touch the file picker:
      // right after a canceled unload, showSaveFilePicker never settles
      // (it neither resolves nor rejects), so the save would silently
      // vanish. The shell dialog is the only picker that works there.
      if (viaShellDialog && window.ptDesktop?.saveSessionFallback) {
        const saved = await window.ptDesktop.saveSessionFallback(
          serializeProgress(this.progressFileObject()), suggestedName);
        if (saved) {
          // Bind the chosen path so auto-save and later saves write back
          // to it silently (the shell dialog gives no handle).
          this.session.path = saved;
          this.session.dirty = false;
          this.showToast('Session saved');
          this.notify();
        }
        return;
      }
      if (!window.showSaveFilePicker) {
        this.showToast('Saving progress files requires a Chromium-based browser');
        return;
      }
      let handle: FileSystemFileHandle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{
            description: 'Reading progress',
            accept: { 'text/plain': [PROGRESS_EXT] },
          }],
        });
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        // Menu items carry no user activation, so the picker throws in
        // the desktop shell; let the shell save the file instead — and
        // bind the chosen path so auto-save arms from here on.
        if ((e as Error)?.name === 'SecurityError' && window.ptDesktop?.saveSessionFallback) {
          const saved = await window.ptDesktop.saveSessionFallback(
            serializeProgress(this.progressFileObject()), suggestedName);
          if (saved) {
            this.session.path = saved;
            this.session.dirty = false;
            this.showToast('Session saved');
            this.notify();
          }
          return;
        }
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

  saveProgressSafe(opts?: { viaShellDialog?: boolean }): void {
    this.saveProgress(opts).catch((e) =>
      this.showToast('Save failed: ' + ((e as Error)?.message ?? String(e))));
  }

  // ---------- navigation ----------

  /**
   * A deliberate jump: record where we were, go to `pos`, push a history
   * entry — or, when forking (cmd/ctrl/middle-click), copy the whole
   * history into a new stack first.
   */
  jumpVia(pos: Pos, label: string, fork = false, { captureLeave = true } = {}): void {
    this.commitSearch(); // followed a link/outline/page-jump/mark: found it, moved on
    // Real jumps pin the position you left onto the entry you were on,
    // so Back returns exactly there. Marking is not a jump — you're
    // already at `pos` — and must not rewrite the previous anchor.
    if (captureLeave) this.hist.updateCurrentPos(this.viewer.currentPosition());
    this.viewer.scrollTo(pos);
    if (fork) {
      this.hist.fork({ label, pos });
      this.showToast('Continued in a new trail');
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
    if (!this.docOpen || !this.hist.canBack()) return;
    this.commitSearch();
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.back();
    if (n) this.viewer.scrollTo(n.pos);
  }

  goForward(): void {
    if (!this.docOpen || !this.hist.canForward()) return;
    this.commitSearch();
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.forward();
    if (n) this.viewer.scrollTo(n.pos);
  }

  histEntryClick(i: number): void {
    if (!this.docOpen) return; // read-only preview while a session waits for its PDF
    this.commitSearch();
    if (i === this.hist.active.index) {
      this.viewer.scrollTo(this.hist.current.pos);
      return;
    }
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.jumpTo(i);
    if (n) this.viewer.scrollTo(n.pos);
  }

  /** Switch to the previous/next trail in the list (keyboard: [ and ]). */
  stackCycle(delta: number): void {
    const ids = this.hist.stacks.map((s) => s.id);
    if (ids.length < 2) return;
    const i = ids.indexOf(this.hist.activeId);
    this.stackSwitch(ids[(i + delta + ids.length) % ids.length]);
  }

  stackSwitch(id: number): void {
    if (id === this.hist.activeId) return;
    this.commitSearch();
    if (!this.docOpen) {
      // preview mode: allow browsing trails, but never touch positions
      this.hist.switchStack(id);
      return;
    }
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.switchStack(id);
    if (n) this.viewer.scrollTo(n.pos);
  }

  stackClose(id: number): void {
    if (!this.docOpen) return;
    this.commitSearch();
    const wasActive = this.hist.closeStack(id);
    if (wasActive && this.hist.current) this.viewer.scrollTo(this.hist.current.pos);
  }

  stackRename(id: number, name: string): void {
    if (!this.docOpen) return;
    this.commitSearch();
    this.hist.renameStack(id, name);
    this.notify(); // restore the row even if the name was rejected
  }

  entryRename(i: number, label: string): void {
    if (!this.docOpen) return;
    this.commitSearch(); // naming an entry = deciding to keep it, i.e. moved on
    this.hist.renameEntry(i, label);
    this.notify();
  }

  /** Trails-panel +: start a fresh trail at the current position. */
  stackNew(): void {
    if (!this.docOpen) return;
    this.commitSearch();
    this.hist.newStack(this.viewer.currentPosition());
    this.notify();
  }

  /** Duplicate a trail; the copy becomes the active one. */
  stackDuplicate(id: number): void {
    if (!this.docOpen) return;
    this.commitSearch();
    this.hist.duplicateStack(id);
    this.notify();
  }

  /** Keyboard entry point: duplicate the active trail (Alt+Shift+D). */
  stackDuplicateActive(): void {
    this.stackDuplicate(this.hist.activeId);
  }

  clearHistory(): void {
    if (!this.docOpen) return;
    this.commitSearch(); // history is being replaced — drop the dangling pointer
    this.hist.clearAll();
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    this.notify();
  }


  /**
   * Undo the last history mutation (overwrite, fork, close, rename, clear)
   * — or, when the most recent action was a PDF replacement, undo that.
   */
  undoHist(): void {
    if (!this.docOpen) return;
    this.commitSearch(); // undo replaces the history snapshot the entry lives in
    if (this.lastReplaceAction === 'undoable' && this.replaceUndoSlot) {
      void this.applyReplaceSlot(this.replaceUndoSlot, 'redoable');
      return;
    }
    if (!this.hist.undo()) return;
    if (this.hist.current) this.viewer.scrollTo(this.hist.current.pos);
  }

  redoHist(): void {
    if (!this.docOpen) return;
    this.commitSearch();
    if (this.lastReplaceAction === 'redoable' && this.replaceRedoSlot) {
      void this.applyReplaceSlot(this.replaceRedoSlot, 'undoable');
      return;
    }
    if (!this.hist.redo()) return;
    if (this.hist.current) this.viewer.scrollTo(this.hist.current.pos);
  }

  private async readSource(
    src: PdfSource,
  ): Promise<{ bytes: Uint8Array; name: string; handle: FileSystemFileHandle | null } | null> {
    try {
      if (typeof src === 'string') {
        const r = await fetch(src);
        if (!r.ok) return null;
        return {
          bytes: new Uint8Array(await r.arrayBuffer()),
          name: decodeURIComponent(src.split('/').pop() ?? 'document.pdf'),
          handle: null,
        };
      }
      if (src instanceof File) {
        return { bytes: new Uint8Array(await src.arrayBuffer()), name: src.name, handle: null };
      }
      const f = await src.getFile();
      return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, handle: src };
    } catch (e) {
      console.warn('readSource failed', e);
      return null;
    }
  }

  private async applyReplaceSlot(
    slot: ReplaceSlot,
    next: 'undoable' | 'redoable',
  ): Promise<void> {
    const got = await this.readSource(slot.source);
    if (!got) {
      this.showToast('Could not reopen the other PDF');
      this.lastReplaceAction = 'none';
      this.notify();
      return;
    }
    const progress: ProgressFile = { ...this.progressFileObject(), state: slot.state };
    await this.openData(got.bytes, got.name, {
      handle: got.handle,
      source: slot.source,
      progress,
      progressHandle: this.session.handle,
      progressPath: this.session.path,
    });
    this.adoptCurrentPdf();
    this.lastReplaceAction = next;
    this.showToast(next === 'redoable'
      ? `Replacement undone \u2014 back to ${got.name}`
      : `Replaced with ${got.name} again`);
    this.notify();
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
      this.markDirty();
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

  /**
   * Commit the current (uncommitted) search entry: freeze it in history
   * and drop the pointer, so the NEXT search adds a fresh entry instead of
   * moving this one. Called from an explicit, enumerated list of committing
   * actions (see the call sites) \u2014 deliberately NOT from find-next, the
   * search itself, scrolling, zooming, or AUTO-SAVE, which all leave the
   * entry uncommitted so repeated find-next keeps overwriting it.
   */
  commitSearch(): void {
    this.searchEntry = null;
  }

  async gotoMatch(dir: 1 | -1): Promise<void> {
    const m = this.search.step(dir);
    this.notify();
    if (!m) return;
    const yr = await this.search.matchYRatio(m);
    const pos: Pos = { page: m.page, yRatio: Math.max(0, yr - 0.05) };
    const label = `\u201c${this.search.query}\u201d`;
    // Uncommitted \u21d2 move the existing entry to this match; committed
    // (searchEntry null, after a committing action) \u21d2 push a fresh one.
    // The identity check is belt-and-suspenders: should some future
    // cursor-moving action ever forget its commitSearch() hook, this
    // falls to the else branch (a clean fresh entry) instead of writing
    // the label onto searchEntry while the position lands on a different
    // current entry.
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
      /** Desktop shell: the bound .ptl's on-disk path (auto-save target). */
      progressPath?: string | null;
      /** Re-readable reference to where the bytes came from (for undoable replace). */
      source?: PdfSource | null;
    } = {},
  ): Promise<void> {
    const {
      handle = null, progress = null, progressHandle = null,
      progressPath = null, source = null,
    } = opts;
    this.showToast(`Loading \u201c${name}\u201d\u2026`, 1500);
    try {
      const doc = await this.viewer.open({ data });
      if (!doc) return;
      this.docOpen = true;
      this.currentName = name;
      this.currentFp = doc.fingerprints?.[0] ?? null;
      this.currentSource = source ?? handle ?? null;
      this.searchEntry = null;
      this.currentPage = 1;
      document.title = `${name} \u2014 Paper Trail`;

      this.preview?.clear();
      this.restoring = true;
      try {
        this.search.reset();
        this.hist.reset();
        void this.buildOutline();
        if (progress?.state) {
          this.restoreStateFrom(progress.state);
        }
        // No automatic restore for a plain PDF: opening a PDF starts
        // fresh; state only comes from an explicit session file.
      } finally {
        this.restoring = false;
      }

      this.session.handle = progressHandle;
      this.session.path = progressPath;
      this.session.dirty = false;
      this.session.saving = false;
      clearTimeout(this.fileSaveTimer);
      this.mismatch_ = (progress && progress.pdf.name && progress.pdf.name !== name)
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
    return /\.ptl$/i.test(name || '');
  }

  async openFile(
    file: File,
    handle: FileSystemFileHandle | null = null,
    path: string | null = null,
  ): Promise<void> {
    if (!file) return;
    if (this.isProgressName(file.name)) {
      await this.openProgressFile(file, handle, path);
      return;
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const source: PdfSource = handle ?? file;
    if (this.pendingProgress) {
      // A session file was opened first; the user is now supplying its
      // PDF — restore that session (and bind its file for auto-save).
      const pp = this.pendingProgress;
      const ph = this.pendingProgressHandle;
      const ppath = this.pendingProgressPath;
      this.pendingProgress = null;
      this.pendingProgressHandle = null;
      this.pendingProgressPath = null;
      await this.openData(buf, file.name, {
        handle,
        source,
        progress: pp.json,
        progressHandle: ph,
        progressPath: ppath,
      });
      return;
    }
    if (this.docOpen) {
      // A document is already open here: another PDF belongs in its own
      // window (desktop) or tab (web), never on top of this one.
      this.openPdfElsewhere(file);
      return;
    }
    await this.openData(buf, file.name, { handle, source });
  }

  /** Open a PDF in a fresh window/tab because this one is occupied. */
  private openPdfElsewhere(file: File): void {
    if (window.ptDesktop?.openInNewWindow) {
      void file.arrayBuffer().then((data) => {
        window.ptDesktop!.openInNewWindow(file.name, data);
      });
      return;
    }
    // Web: hand the picked File to a fresh tab of the app over a
    // same-origin handshake (Files are structured-cloneable).
    const child = window.open(location.origin + location.pathname);
    if (!child) {
      this.showToast('Popup blocked \u2014 allow popups to open PDFs in a new tab');
      return;
    }
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin === location.origin && ev.source === child && ev.data === 'pt-child-ready') {
        child.postMessage({ type: 'pt-open-file', file }, location.origin);
        window.removeEventListener('message', onMsg);
      }
    };
    window.addEventListener('message', onMsg);
  }

  /** Child-tab side of openPdfElsewhere: announce readiness, accept the file. */
  initTabHandoff(): void {
    if (!window.opener || window.ptDesktop) return;
    window.addEventListener('message', (ev: MessageEvent) => {
      if (ev.origin !== location.origin) return;
      const d = ev.data as { type?: string; file?: File };
      if (d?.type === 'pt-open-file' && d.file instanceof File) {
        void this.openFile(d.file);
      }
    });
    (window.opener as Window).postMessage('pt-child-ready', location.origin);
  }

  /** Discard a session that is waiting for its PDF. */
  discardPendingSession(): void {
    this.pendingProgress = null;
    this.pendingProgressHandle = null;
    this.pendingProgressPath = null;
    this.hist.reset(); // clear the sidebar preview
    this.notify();
  }

  private pendingProgressHandle: FileSystemFileHandle | null = null;

  /**
   * Open a reading-session file. If a PDF is already open, the session is
   * applied to it (after confirmation, since it replaces the current
   * reading history). Otherwise the app shows a prompt asking for the
   * PDF: opening a session is deliberately two explicit steps — the app
   * never fetches a PDF on its own behind the user's back.
   */
  private async openProgressFile(
    file: File,
    progressHandle: FileSystemFileHandle | null = null,
    progressPath: string | null = null,
  ): Promise<void> {
    const text = await file.text();
    const json = parseProgress(text);
    if (!json) {
      const v = progressVersion(text);
      this.showToast(v !== null && v > PROGRESS_VERSION
        ? 'This session file was saved by a newer version of Paper Trail \u2014 update the app to open it'
        : 'Not a reading-session file');
      return;
    }

    if (this.docOpen) {
      // Loading a session into the currently open PDF.
      const trivial = this.hist.stacks.length === 1
        && this.hist.stacks[0].entries.length <= 1
        && !this.session.dirty;
      this.confirmSession = { json, progressHandle, progressPath };
      if (trivial) {
        this.applyConfirmedSession();
      } else {
        this.notify(); // the UI shows a replace-confirmation dialog
      }
      return;
    }

    // Session first: show the preview and ask the user for the PDF.
    this.enterPendingState(json, progressHandle, progressPath);
  }

  /**
   * Session-first waiting state: show the session's trails and history in
   * the sidebar right away (read-only preview — no document to navigate),
   * so the user sees the file has loaded.
   */
  private enterPendingState(
    json: ProgressFile,
    progressHandle: FileSystemFileHandle | null,
    progressPath: string | null = null,
  ): void {
    this.pendingProgress = { json };
    this.pendingProgressHandle = progressHandle;
    this.pendingProgressPath = progressPath;
    this.hist.load(json.state.hist);
    // Set an explicit, non-bare title so the desktop shell reveals this
    // window right away. A document-opening window stays hidden until its
    // title leaves the app name (createWindow's showWhenLoaded reveal);
    // an OS-opened .ptl has no PDF to load and so never set a title,
    // leaving the window hidden until the 4s safety timer fired.
    document.title = `${json.pdf.name || 'Reading session'} — Paper Trail`;
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
    this.session.path = cs.progressPath;
    this.session.dirty = false;
    this.session.saving = false;
    clearTimeout(this.fileSaveTimer);
    this.mismatch_ = (cs.json.pdf.name && cs.json.pdf.name !== this.currentName)
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
   * Banner: make the currently open PDF the session's PDF — its name is
   * written to the session file on the next (auto-)save.
   */
  adoptCurrentPdf(): void {
    this.mismatch_ = null;
    // progressFileObject() always serializes the currently open PDF's
    // identity, so marking the session dirty is enough to persist it.
    this.markDirty();
    if (this.session.handle) {
      this.writeProgress().catch((e) => console.warn('adopt save failed', e));
    }
    this.notify();
  }

  /**
   * Manually push the current reading position onto the trail, exactly as
   * if a link had been followed here ("mark this spot"). Cmd/Ctrl branches
   * into a new trail, like cmd+clicking a link.
   */
  markPosition(fork = false): void {
    if (!this.docOpen) return;
    const pos = this.viewer.currentPosition();
    this.jumpVia(pos, `Marked p.${pos.page}`, fork, { captureLeave: false });
  }

  /** Re-anchor a history entry to the current reading position. */
  entrySetPos(i: number): void {
    if (!this.docOpen) return;
    this.commitSearch(); // re-anchoring mutates the history the entry lives in
    this.hist.setEntryPos(i, this.viewer.currentPosition());
  }

  /** Remove one entry from the active trail (its × button). */
  entryRemove(i: number): void {
    if (!this.docOpen) return;
    this.commitSearch(); // mutating the history the entry lives in
    this.hist.removeEntry(i);
    this.notify();
  }

  /** Re-anchor the CURRENT entry to the reading position (keyboard: r). */
  reanchorCurrent(): void {
    if (!this.docOpen) return;
    this.entrySetPos(this.hist.active.index);
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
    this.commitSearch(); // replacing the document: the search is done
    const prevSlot: ReplaceSlot | null = this.currentSource
      ? { source: this.currentSource, state: this.serializeState() }
      : null;
    const progress = this.progressFileObject(); // carries the current state
    const progressHandle = this.session.handle;
    const progressPath = this.session.path; // keep the desktop file binding
    const buf = new Uint8Array(await file.arrayBuffer());
    const source: PdfSource = handle ?? file;
    await this.openData(buf, file.name, { handle, source, progress, progressHandle, progressPath });
    // Deliberate swap: adopt the new PDF into the session, no banner.
    this.adoptCurrentPdf();
    if (prevSlot) {
      this.replaceUndoSlot = prevSlot;
      this.replaceRedoSlot = { source, state: this.serializeState() };
      this.lastReplaceAction = 'undoable';
      this.showToast(`PDF replaced \u2014 ${MOD}+Z to undo`);
      this.notify();
    }
  }

  /** Toolbar / menu entry point: pick a reading-session file. */
  async requestLoadSession(): Promise<void> {
    // Desktop: a NATIVE open dialog returns the file's real path, so the
    // session binds a silent-write target directly (auto-save arms, the
    // window closes with no prompt) — no dependency on resolving a File
    // System Access handle's path. The browser (no shell) keeps the
    // Chromium picker below and binds via the handle.
    if (window.ptDesktop?.openSessionDialog) {
      const picked = await window.ptDesktop.openSessionDialog();
      if (picked) {
        const file = new File([picked.text], picked.name, { type: 'text/plain' });
        // An empty path is treated as unbound — never write to a bad target.
        await this.openProgressFile(file, null, picked.path || null);
      }
      return;
    }
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

  /**
   * Pick a PDF. Sessions are loaded through the separate Load Session
   * action — deliberately two distinct pickers. (A .ptl chosen through
   * the "all files" escape hatch still routes correctly via openFile.)
   */
  async pickFile(): Promise<void> {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'PDF document',
            accept: { 'application/pdf': ['.pdf'] },
          }],
          excludeAcceptAllOption: false,
        });
        if (handle) {
          const file = await handle.getFile();
          await this.openFile(file, handle, this.desktopPathFor(file));
        }
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
      this.fileInput.accept = 'application/pdf,.pdf';
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

  /**
   * Desktop only: the on-disk path for a File the renderer already holds
   * (a drop, a picker handle's getFile()). Binding it as session.path makes
   * auto-save arm and the close-flush write synchronously — the very same
   * silent target an OS-opened .ptl gets — no matter HOW the file was
   * opened. Null off the desktop shell, or when Electron can't resolve one.
   */
  private desktopPathFor(file: File): string | null {
    return window.ptDesktop?.getPathForFile?.(file) || null;
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
    // A dropped file carries its real path in the desktop shell, so a
    // dropped .ptl binds exactly like an OS-opened one (auto-save + silent
    // close), not as an unbound "where do I save?" session.
    void this.openFile(f, handle, this.desktopPathFor(f));
  }

  /**
   * A Recent row remembers a PDF and (when one was saved) its session
   * file, and reopens them as a pair — all or nothing. If either file is
   * gone or unreadable, NEITHER loads: no partial state, no picker, just
   * a clear message with everything left as it was.
   */
  async openRecent(entry: RecentEntry): Promise<void> {
    const fail = (what: string) =>
      this.showToast(`Couldn\u2019t reopen \u201c${entry.name}\u201d \u2014 ${what}.`, 6000);

    // Read BOTH files completely before touching any state.
    let pdfFile: File;
    let pdfBytes: Uint8Array;
    try {
      if (!entry.handle || !(await ensureReadPermission(entry.handle))) {
        throw new Error('PDF handle unavailable');
      }
      pdfFile = await entry.handle.getFile();
      pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
    } catch (e) {
      console.warn('openRecent: PDF unreadable', e);
      fail('the PDF is missing');
      return;
    }
    let progress: ProgressFile | null = null;
    if (entry.progressHandle) {
      let sessionText: string;
      try {
        if (!(await ensureReadPermission(entry.progressHandle))) {
          throw new Error('session handle unavailable');
        }
        sessionText = await (await entry.progressHandle.getFile()).text();
      } catch (e) {
        console.warn('openRecent: session unreadable', e);
        fail('its saved session file is missing');
        return;
      }
      progress = parseProgress(sessionText);
      if (!progress) {
        fail('its saved session file is unreadable');
        return;
      }
    }
    await this.openData(pdfBytes, pdfFile.name, {
      handle: entry.handle,
      source: entry.handle,
      progress,
      progressHandle: progress ? entry.progressHandle ?? null : null,
    });
  }

  private async bootFromQuery(): Promise<void> {
    const fileParam = new URLSearchParams(location.search).get('file');
    if (!fileParam) return;
    try {
      const r = await fetch(fileParam);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (this.isProgressName(fileParam)) {
        // Sessions never fetch their PDF automatically — the same two-step
        // flow as local files: preview the session, ask for the PDF.
        const json = parseProgress(await r.text());
        if (!json) throw new Error('not a progress file');
        this.enterPendingState(json, null);
        this.showToast(
          `Reading session loaded \u2014 open the PDF manually (${json.pdf.name}) to continue`,
          7000,
        );
      } else {
        const buf = new Uint8Array(await r.arrayBuffer());
        await this.openData(buf, decodeURIComponent(fileParam.split('/').pop()!), {
          source: fileParam,
        });
      }
    } catch (e) {
      this.showToast(`Could not load ${fileParam} (${(e as Error).message})`);
    }
  }
}

export const controller = new Controller();
