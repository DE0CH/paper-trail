// One identity for an opened file, however it arrived. A file reaches the
// app two ways — as a FileSystemFileHandle (browser pickers, Chromium
// drag-drop) or as an on-disk path string (OS opens, native shell dialogs,
// desktop drops) — and a BoundFile is EXACTLY ONE of the two, decided once
// at acquisition time by the from* factories below. From then on reading,
// writing, and permission checks go through this one object, so consumers
// never branch on twin handle/path fields.
//
// Error contract:
// - read()/readText() THROW when the file cannot be read (missing file,
//   revoked permission, IPC failure) — callers own their precise messages.
// - write() returns true only when the bytes actually reached the disk;
//   every failure is false, never a throw — so only a successful write can
//   clear a dirty flag.
// - canWriteSilently()/requestWrite()/requestRead() return booleans and
//   never throw. A path binding needs no permission at all (the desktop
//   shell writes straight to disk); a handle follows the File System
//   Access permission model.

import { isHandle, type FileRef } from './recents';
import { ensureReadPermission } from './store';
import type {} from './types'; // the Window.ptDesktop global augmentation

/**
 * A file the app can read from and (for session files) write back to,
 * identified by exactly one mechanism — a browser handle or an on-disk
 * path.
 */
export interface BoundFile {
  /** Which mechanism identifies the file ('path' exists only on desktop). */
  readonly kind: 'handle' | 'path';
  /** The file name, for display and for naming saved sessions. */
  readonly name: string;
  /** The identity exactly as the recents store keeps it. */
  readonly ref: FileRef;
  /** The file's bytes (a PDF's content). Throws when unreadable. */
  read(): Promise<ArrayBuffer>;
  /** The file's text (a .ptl session's content). Throws when unreadable. */
  readText(): Promise<string>;
  /** Write `text` back to the file. True only when the write happened. */
  write(text: string): Promise<boolean>;
  /**
   * True when write() will not show a permission prompt. This is the
   * auto-save gate: a timer save must never pop a prompt out of nowhere.
   */
  canWriteSilently(): Promise<boolean>;
  /**
   * User-initiated save: the one right moment to prompt for write
   * permission if it is needed. True when writing may proceed.
   */
  requestWrite(): Promise<boolean>;
  /**
   * Prompt for read permission if it is needed (a handle restored from
   * the recents store comes back unpermitted). True when reading may
   * proceed — a false is a declined prompt, distinct from a missing file.
   */
  requestRead(): Promise<boolean>;
}

/** A file identified by a File System Access handle (browser mechanisms). */
export class HandleFile implements BoundFile {
  readonly kind = 'handle' as const;

  constructor(private readonly handle: FileSystemFileHandle) { void this.handle; }

  get name(): string {
    throw new Error('not implemented');
  }

  get ref(): FileRef {
    throw new Error('not implemented');
  }

  async read(): Promise<ArrayBuffer> {
    throw new Error('not implemented');
  }

  async readText(): Promise<string> {
    throw new Error('not implemented');
  }

  async write(_text: string): Promise<boolean> {
    throw new Error('not implemented');
  }

  async canWriteSilently(): Promise<boolean> {
    throw new Error('not implemented');
  }

  async requestWrite(): Promise<boolean> {
    throw new Error('not implemented');
  }

  async requestRead(): Promise<boolean> {
    throw new Error('not implemented');
  }
}

/**
 * A file identified by its on-disk path, reached through the desktop
 * shell's window.ptDesktop bridge — a PathFile cannot exist in a plain
 * browser (the constructor throws there).
 */
export class PathFile implements BoundFile {
  readonly kind = 'path' as const;
  readonly name: string = '';

  constructor(readonly path: string, name?: string) {
    void name;
    throw new Error('not implemented');
  }

  get ref(): FileRef {
    throw new Error('not implemented');
  }

  async read(): Promise<ArrayBuffer> {
    throw new Error('not implemented');
  }

  async readText(): Promise<string> {
    throw new Error('not implemented');
  }

  async write(_text: string): Promise<boolean> {
    throw new Error('not implemented');
  }

  async canWriteSilently(): Promise<boolean> {
    throw new Error('not implemented');
  }

  async requestWrite(): Promise<boolean> {
    throw new Error('not implemented');
  }

  async requestRead(): Promise<boolean> {
    throw new Error('not implemented');
  }
}

// ---- acquisition factories -------------------------------------------------
// One per entry flow, so each acquisition site makes exactly one call and
// the handle-or-path decision lives here, not at the call sites.

/**
 * A handle from showOpenFilePicker / showSaveFilePicker. In the desktop
 * shell the picked File also resolves to an on-disk path, and the path is
 * the stronger binding (silent writes by construction, IPC reads, survives
 * a restart as a plain string) — so pass the File when one is in hand and
 * the path is preferred; without one (the save picker) the handle binds.
 */
export function fromPickerHandle(handle: FileSystemFileHandle, file?: File): BoundFile {
  void handle; void file;
  throw new Error('not implemented');
}

/**
 * A dropped File (also the <input type=file> fallback, which has no
 * DataTransferItem). Desktop: the file's real path binds, exactly like an
 * OS open. Browser: the item's file handle. Neither available → null, an
 * unbound open (the caller reads the File's bytes; there is no save
 * target).
 */
export async function fromDrop(file: File, item?: DataTransferItem): Promise<BoundFile | null> {
  void file; void item;
  throw new Error('not implemented');
}

/**
 * An OS-initiated open (Open With…, a Dock drop, the OS recents): the
 * shell already read the bytes and sent the path along. An empty or
 * missing path stays unbound (null) — never write to a made-up target.
 */
export function fromOsOpen(path: string | null | undefined, name: string): PathFile | null {
  void path; void name;
  throw new Error('not implemented');
}

/**
 * A native shell dialog's result (openSessionDialog, saveSessionFallback):
 * binds the dialog's real path. Cancel or an empty path → null.
 */
export function fromShellDialog(path: string | null | undefined, name?: string): PathFile | null {
  void path; void name;
  throw new Error('not implemented');
}

/** A recents-store identity coming back: rewrap whichever kind it is. */
export function fromRecentRef(ref: FileRef, name?: string): BoundFile {
  void ref; void name; void isHandle; void ensureReadPermission;
  throw new Error('not implemented');
}
