// Shared domain types.

/** Scale-independent position inside the document. */
export interface Pos {
  /** 1-based page number. */
  page: number;
  /** Vertical position within the page, 0..1. */
  yRatio: number;
}

export interface HistEntry {
  label: string;
  pos: Pos;
  /**
   * True once the user renamed the entry by hand (a rename that leaves
   * the text unchanged does not count). Re-anchoring keeps hand-written
   * labels but refreshes automatic ones.
   */
  edited?: boolean;
}

export interface HistStack {
  id: number;
  name: string;
  entries: HistEntry[];
  /** Cursor into `entries`. */
  index: number;
}

export interface SerializedStacks {
  v: 3;
  activeId: number;
  nameCounter: number;
  stacks: HistStack[];
}

export interface SerializedState {
  v: 1;
  name: string;
  scale: number;
  fitWidth: boolean;
  hist: SerializedStacks;
  pos: Pos;
  ts: number;
}

export interface ProgressFile {
  type: 'pdf-stack-reader-progress';
  v: 1;
  savedAt: number;
  // Deliberately just the name: the session file must be fully
  // transparent to the user — no hidden identifiers, no paths. PDFs are
  // matched by a simple name comparison, with a visible warning banner
  // when the names differ.
  pdf: { name: string };
  state: SerializedState;
}

export interface OutlineNode {
  title: string;
  dest: unknown;
  children: OutlineNode[];
}

export interface RecentEntry {
  fp: string;
  name: string;
  ts: number;
  handle?: FileSystemFileHandle;
  progressHandle?: FileSystemFileHandle;
}

export type MenuAction =
  | 'open' | 'save' | 'save-from-close' | 'load-session' | 'replace-pdf' | 'back' | 'forward'
  | 'undo' | 'redo' | 'mark' | 'mark-branch' | 'reanchor'
  | 'trail-prev' | 'trail-next' | 'trail-duplicate'
  | 'zoom-in' | 'zoom-out' | 'fit' | 'find' | 'search-selection'
  | 'toggle-sidebar' | 'toggle-nav' | 'clear-history' | 'help'
  | 'updated';

/** What the renderer right-clicked on; the shell shows a native menu for it. */
export type ContextMenuRequest =
  | { type: 'editable' }
  | { type: 'selection'; text: string }
  | { type: 'link' }
  | { type: 'histEntry'; current: boolean }
  | { type: 'stack'; active: boolean; closable: boolean }
  | { type: 'viewer'; canBack: boolean; canForward: boolean };

// ---- global augmentations (File System Access API bits missing from lib.dom,
// and the Electron shell bridge) ----

declare global {
  interface Window {
    showOpenFilePicker?: (options?: {
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
      excludeAcceptAllOption?: boolean;
      startIn?: FileSystemHandle | string;
    }) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle>;
    ptDesktop?: {
      platform: string; // process.platform of the shell ('darwin', 'win32', ...)
      // On-disk path of a File the renderer holds (drop / picker handle /
      // input), so every open method binds the same silent-write target.
      getPathForFile?: (file: File) => string;
      // Native "Load session…" open dialog: returns the picked .ptl's text
      // and real path so the session binds directly. Null on cancel.
      openSessionDialog?: () => Promise<{ name: string; text: string; path: string } | null>;
      onMenu: (cb: (action: MenuAction, payload?: string) => void) => void;
      onOpenFile: (cb: (file: { name: string; data: ArrayBuffer; path?: string }) => void) => void;
      showContextMenu: (ctx: ContextMenuRequest) => Promise<string | null>;
      setDocumentEdited: (edited: boolean) => void;
      saveSessionFallback: (text: string, suggestedName: string) => Promise<string | null>;
      saveSessionToPath?: (path: string, text: string) => Promise<boolean>;
      // Flush on window close: the main process writes the bound path so an
      // autosaved session closes instantly with no prompt. Returns whether
      // the write succeeded; a failed write (unexpected — likely a bug)
      // falls back to the normal "save?" prompt so nothing is lost.
      saveSessionOnClose?: (path: string, text: string) => boolean;
      openInNewWindow: (name: string, data: ArrayBuffer) => void;
    };
    __pt?: unknown;
  }

  interface FileSystemHandle {
    queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  }

  interface DataTransferItem {
    getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
  }
}

export {};
