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

/** The desktop shell's preload bridge, or null in a plain browser / node. */
function desktopBridge(): NonNullable<Window['ptDesktop']> | null {
  return typeof window === 'undefined' ? null : window.ptDesktop ?? null;
}

/** Filename portion of an on-disk path (either separator). */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? '';
}

/** A file identified by a File System Access handle (browser mechanisms). */
export class HandleFile implements BoundFile {
  readonly kind = 'handle' as const;

  constructor(private readonly handle: FileSystemFileHandle) {}

  get name(): string {
    return this.handle.name;
  }

  get ref(): FileRef {
    return this.handle;
  }

  async read(): Promise<ArrayBuffer> {
    return (await this.handle.getFile()).arrayBuffer();
  }

  async readText(): Promise<string> {
    return (await this.handle.getFile()).text();
  }

  async write(text: string): Promise<boolean> {
    try {
      const w = await this.handle.createWritable();
      await w.write(text);
      await w.close();
      return true;
    } catch (e) {
      console.warn('BoundFile: handle write failed', e);
      return false;
    }
  }

  /**
   * The permission API is Chromium-only and absent on test fakes — no API
   * means nothing can prompt, so the write counts as silent. The desktop
   * shell has no permission UI at all — requests are granted invisibly
   * (handles restored from the recents store always come back in the
   * 'prompt' state) — so there this simply asks. A throwing query is
   * treated as writable: write() surfaces the real failure.
   */
  async canWriteSilently(): Promise<boolean> {
    const h = this.handle;
    if (!h.queryPermission) return true;
    try {
      if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
      if (desktopBridge() && h.requestPermission) {
        return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
      }
      return false;
    } catch {
      return true;
    }
  }

  async requestWrite(): Promise<boolean> {
    const h = this.handle;
    if (!h.queryPermission) return true;
    try {
      if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
      return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
    } catch {
      return true; // proceed: write() surfaces real failures
    }
  }

  async requestRead(): Promise<boolean> {
    return ensureReadPermission(this.handle);
  }
}

/**
 * A file identified by its on-disk path, reached through the desktop
 * shell's window.ptDesktop bridge — a PathFile cannot exist in a plain
 * browser (the constructor throws there). Paths never involve permission
 * UI: the shell reads and writes straight to disk over IPC.
 */
export class PathFile implements BoundFile {
  readonly kind = 'path' as const;
  readonly name: string;

  constructor(readonly path: string, name?: string) {
    if (!path) {
      // An empty path is treated as unbound by every factory — reaching
      // here is a caller bug, never write to a made-up target.
      throw new Error('PathFile: an empty path is not a file');
    }
    if (!desktopBridge()) {
      throw new Error(
        'PathFile needs the desktop shell (window.ptDesktop): '
        + 'a browser cannot reach a file by on-disk path',
      );
    }
    this.name = name || baseName(path);
  }

  get ref(): FileRef {
    return this.path;
  }

  async read(): Promise<ArrayBuffer> {
    const buf = await desktopBridge()?.readFileByPath?.(this.path);
    if (!buf) throw new Error(`unreadable: ${this.path}`);
    return buf;
  }

  async readText(): Promise<string> {
    return new TextDecoder().decode(await this.read());
  }

  async write(text: string): Promise<boolean> {
    try {
      return (await desktopBridge()?.saveSessionToPath?.(this.path, text)) === true;
    } catch (e) {
      console.warn('BoundFile: path write failed', e);
      return false;
    }
  }

  async canWriteSilently(): Promise<boolean> {
    return true;
  }

  async requestWrite(): Promise<boolean> {
    return true;
  }

  async requestRead(): Promise<boolean> {
    return true;
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
  const path = file ? desktopBridge()?.getPathForFile?.(file) : undefined;
  return path ? new PathFile(path, file?.name) : new HandleFile(handle);
}

/**
 * A dropped File (also the <input type=file> fallback, which has no
 * DataTransferItem). Desktop: the file's real path binds, exactly like an
 * OS open. Browser: the item's file handle. Neither available → null, an
 * unbound open (the caller reads the File's bytes; there is no save
 * target).
 */
export async function fromDrop(file: File, item?: DataTransferItem): Promise<BoundFile | null> {
  const path = desktopBridge()?.getPathForFile?.(file);
  if (path) return new PathFile(path, file.name);
  try {
    if (item?.getAsFileSystemHandle) {
      const h = await item.getAsFileSystemHandle();
      if (h?.kind === 'file') return new HandleFile(h as FileSystemFileHandle);
    }
  } catch { /* no usable handle — fall through to unbound */ }
  return null;
}

/**
 * An OS-initiated open (Open With…, a Dock drop, the OS recents): the
 * shell already read the bytes and sent the path along. An empty or
 * missing path stays unbound (null) — never write to a made-up target.
 */
export function fromOsOpen(path: string | null | undefined, name: string): PathFile | null {
  return path ? new PathFile(path, name) : null;
}

/**
 * A native shell dialog's result (openSessionDialog, saveSessionFallback):
 * binds the dialog's real path. Cancel or an empty path → null.
 */
export function fromShellDialog(path: string | null | undefined, name?: string): PathFile | null {
  return path ? new PathFile(path, name) : null;
}

/** A recents-store identity coming back: rewrap whichever kind it is. */
export function fromRecentRef(ref: FileRef, name?: string): BoundFile {
  return isHandle(ref) ? new HandleFile(ref) : new PathFile(ref, name);
}
