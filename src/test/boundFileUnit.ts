// Unit tests for the bound-file abstraction (BoundFile / HandleFile /
// PathFile and the acquisition factories). Pure logic with fake handles
// and a fake window.ptDesktop bridge — no browser, no Electron.
// Run: node --test build-node/test/boundFileUnit.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HandleFile, PathFile,
  fromPickerHandle, fromDrop, fromOsOpen, fromShellDialog, fromRecentRef,
} from '../core/boundFile';

// ---- fakes ---------------------------------------------------------------

type PermState = 'granted' | 'prompt' | 'denied';

interface FakeHandleOpts {
  /** Initial permission state per mode (default 'granted'). */
  read?: PermState;
  write?: PermState;
  /** requestPermission grants (and transitions the state) when true. */
  grantOnRequest?: boolean;
  /** Omit queryPermission/requestPermission entirely (like an e2e fake). */
  noPermissionApi?: boolean;
  /** File content returned by getFile(). */
  text?: string;
  /** createWritable() rejects. */
  failWrite?: boolean;
  /** queryPermission() rejects. */
  queryThrows?: boolean;
}

interface FakeHandle {
  handle: FileSystemFileHandle;
  written: () => string | null;
  closed: () => boolean;
  requested: () => Array<'read' | 'readwrite'>;
}

function fakeHandle(name: string, opts: FakeHandleOpts = {}): FakeHandle {
  const state: Record<'read' | 'readwrite', PermState> = {
    read: opts.read ?? 'granted',
    readwrite: opts.write ?? 'granted',
  };
  let written: string | null = null;
  let closed = false;
  const requested: Array<'read' | 'readwrite'> = [];
  const h: Record<string, unknown> = {
    name,
    kind: 'file',
    isSameEntry: async () => false,
    getFile: async () => new File([opts.text ?? ''], name, { type: 'text/plain' }),
    createWritable: async () => {
      if (opts.failWrite) throw new Error('write failed (fake)');
      return {
        write: async (t: string) => { written = t; },
        close: async () => { closed = true; },
      };
    },
  };
  if (!opts.noPermissionApi) {
    h.queryPermission = async ({ mode }: { mode: 'read' | 'readwrite' }) => {
      if (opts.queryThrows) throw new Error('queryPermission failed (fake)');
      return state[mode];
    };
    h.requestPermission = async ({ mode }: { mode: 'read' | 'readwrite' }) => {
      requested.push(mode);
      if (opts.grantOnRequest) { state[mode] = 'granted'; return 'granted'; }
      state[mode] = 'denied';
      return 'denied';
    };
  }
  return {
    handle: h as unknown as FileSystemFileHandle,
    written: () => written,
    closed: () => closed,
    requested: () => requested,
  };
}

interface FakeDesktopOpts {
  /** getPathForFile result by File name ('' = unresolvable, like Electron). */
  paths?: Record<string, string>;
  /** readFileByPath content by path; missing/null = unreadable. */
  files?: Record<string, string | null>;
  /** saveSessionToPath result (default true); 'throw' rejects. */
  saveResult?: boolean | 'throw';
}

interface FakeDesktop {
  bridge: Record<string, unknown>;
  saves: () => Array<{ path: string; text: string }>;
}

function fakeDesktop(opts: FakeDesktopOpts = {}): FakeDesktop {
  const saves: Array<{ path: string; text: string }> = [];
  const bridge: Record<string, unknown> = {
    platform: 'test',
    getPathForFile: (f: File): string => opts.paths?.[f.name] ?? '',
    readFileByPath: async (p: string): Promise<ArrayBuffer | null> => {
      const c = opts.files?.[p];
      if (c == null) return null;
      const bytes = new TextEncoder().encode(c);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    saveSessionToPath: async (path: string, text: string): Promise<boolean> => {
      if (opts.saveResult === 'throw') throw new Error('save failed (fake)');
      saves.push({ path, text });
      return opts.saveResult ?? true;
    },
  };
  return { bridge, saves: () => saves };
}

/**
 * Run `fn` with a controlled `window`: undefined removes it (plain node),
 * an object installs it as-is (pass {} for a browser without the desktop
 * bridge, { ptDesktop } for the desktop shell). Always restores.
 */
async function withWindow<T>(
  win: { ptDesktop?: unknown } | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  if (win === undefined) delete g.window; else g.window = win;
  try {
    return await fn();
  } finally {
    if (had) g.window = prev; else delete g.window;
  }
}

const noWindow = undefined; // plain node — no window at all
const browserWindow = {};   // a window without the desktop bridge

// ---- HandleFile ----------------------------------------------------------

test('HandleFile: kind, name, and ref reflect the wrapped handle', () => {
  const { handle } = fakeHandle('a.ptl');
  const bf = new HandleFile(handle);
  assert.equal(bf.kind, 'handle');
  assert.equal(bf.name, 'a.ptl');
  assert.equal(bf.ref, handle);
});

test('HandleFile: read() returns the bytes, readText() the text', async () => {
  const { handle } = fakeHandle('a.ptl', { text: 'ptl v1' });
  const bf = new HandleFile(handle);
  assert.equal(new TextDecoder().decode(await bf.read()), 'ptl v1');
  assert.equal(await bf.readText(), 'ptl v1');
});

test('HandleFile: write() writes through createWritable and closes', async () => {
  const fh = fakeHandle('a.ptl');
  const bf = new HandleFile(fh.handle);
  assert.equal(await bf.write('saved text'), true);
  assert.equal(fh.written(), 'saved text');
  assert.equal(fh.closed(), true);
});

test('HandleFile: write() returns false when the write throws', async () => {
  const fh = fakeHandle('a.ptl', { failWrite: true });
  const bf = new HandleFile(fh.handle);
  assert.equal(await bf.write('x'), false);
});

test('HandleFile.canWriteSilently: no permission API means yes', async () => {
  const { handle } = fakeHandle('a.ptl', { noPermissionApi: true });
  await withWindow(browserWindow, async () => {
    assert.equal(await new HandleFile(handle).canWriteSilently(), true);
  });
});

test('HandleFile.canWriteSilently: granted means yes, no request made', async () => {
  const fh = fakeHandle('a.ptl', { write: 'granted' });
  await withWindow(browserWindow, async () => {
    assert.equal(await new HandleFile(fh.handle).canWriteSilently(), true);
  });
  assert.deepEqual(fh.requested(), []);
});

test('HandleFile.canWriteSilently: prompt in the browser means no, and it must NOT ask', async () => {
  const fh = fakeHandle('a.ptl', { write: 'prompt', grantOnRequest: true });
  await withWindow(browserWindow, async () => {
    assert.equal(await new HandleFile(fh.handle).canWriteSilently(), false);
  });
  // The auto-save gate must never pop a permission prompt out of nowhere.
  assert.deepEqual(fh.requested(), []);
});

test('HandleFile.canWriteSilently: the desktop shell asks invisibly and a grant is silent', async () => {
  const fh = fakeHandle('a.ptl', { write: 'prompt', grantOnRequest: true });
  const desk = fakeDesktop();
  await withWindow({ ptDesktop: desk.bridge }, async () => {
    assert.equal(await new HandleFile(fh.handle).canWriteSilently(), true);
  });
  assert.deepEqual(fh.requested(), ['readwrite']);
});

test('HandleFile.canWriteSilently: a desktop-shell denial is not silent', async () => {
  const fh = fakeHandle('a.ptl', { write: 'prompt', grantOnRequest: false });
  const desk = fakeDesktop();
  await withWindow({ ptDesktop: desk.bridge }, async () => {
    assert.equal(await new HandleFile(fh.handle).canWriteSilently(), false);
  });
});

test('HandleFile.canWriteSilently: a throwing query is treated as writable', async () => {
  const { handle } = fakeHandle('a.ptl', { queryThrows: true });
  await withWindow(browserWindow, async () => {
    assert.equal(await new HandleFile(handle).canWriteSilently(), true);
  });
});

test('HandleFile.requestWrite: granted needs no prompt', async () => {
  const fh = fakeHandle('a.ptl', { write: 'granted' });
  await withWindow(browserWindow, async () => {
    assert.equal(await new HandleFile(fh.handle).requestWrite(), true);
  });
  assert.deepEqual(fh.requested(), []);
});

test('HandleFile.requestWrite: prompts and honors the answer (granted)', async () => {
  const fh = fakeHandle('a.ptl', { write: 'prompt', grantOnRequest: true });
  await withWindow(browserWindow, async () => {
    const bf = new HandleFile(fh.handle);
    assert.equal(await bf.requestWrite(), true);
    assert.deepEqual(fh.requested(), ['readwrite']);
    // The grant sticks: silent writes are now allowed.
    assert.equal(await bf.canWriteSilently(), true);
  });
});

test('HandleFile.requestWrite: prompts and honors the answer (denied)', async () => {
  const fh = fakeHandle('a.ptl', { write: 'prompt', grantOnRequest: false });
  await withWindow(browserWindow, async () => {
    assert.equal(await new HandleFile(fh.handle).requestWrite(), false);
  });
  assert.deepEqual(fh.requested(), ['readwrite']);
});

test('HandleFile.requestWrite: no permission API means yes', async () => {
  const { handle } = fakeHandle('a.ptl', { noPermissionApi: true });
  await withWindow(browserWindow, async () => {
    assert.equal(await new HandleFile(handle).requestWrite(), true);
  });
});

test('HandleFile.requestWrite: a throwing query proceeds (write() surfaces real failures)', async () => {
  const { handle } = fakeHandle('a.ptl', { queryThrows: true });
  await withWindow(browserWindow, async () => {
    assert.equal(await new HandleFile(handle).requestWrite(), true);
  });
});

test('HandleFile.requestRead: granted, re-grantable, and denied', async () => {
  const granted = fakeHandle('a.pdf', { read: 'granted' });
  assert.equal(await new HandleFile(granted.handle).requestRead(), true);
  assert.deepEqual(granted.requested(), []);

  const regrant = fakeHandle('a.pdf', { read: 'prompt', grantOnRequest: true });
  assert.equal(await new HandleFile(regrant.handle).requestRead(), true);
  assert.deepEqual(regrant.requested(), ['read']);

  const denied = fakeHandle('a.pdf', { read: 'prompt', grantOnRequest: false });
  assert.equal(await new HandleFile(denied.handle).requestRead(), false);
});

// ---- PathFile --------------------------------------------------------------

test('PathFile: cannot exist without the desktop bridge', async () => {
  await withWindow(noWindow, () => {
    assert.throws(() => new PathFile('/d/a.ptl'), /desktop/i);
  });
  await withWindow(browserWindow, () => {
    assert.throws(() => new PathFile('/d/a.ptl'), /desktop/i);
  });
});

test('PathFile: an empty path is never a binding', async () => {
  const desk = fakeDesktop();
  await withWindow({ ptDesktop: desk.bridge }, () => {
    assert.throws(() => new PathFile(''));
  });
});

test('PathFile: kind, ref, and the name defaulting to the basename', async () => {
  const desk = fakeDesktop();
  await withWindow({ ptDesktop: desk.bridge }, () => {
    const unix = new PathFile('/docs/paper.ptl');
    assert.equal(unix.kind, 'path');
    assert.equal(unix.ref, '/docs/paper.ptl');
    assert.equal(unix.name, 'paper.ptl');
    const win = new PathFile('C:\\docs\\paper.ptl');
    assert.equal(win.name, 'paper.ptl');
    const named = new PathFile('/docs/paper.ptl', 'Display name.ptl');
    assert.equal(named.name, 'Display name.ptl');
  });
});

test('PathFile: read() and readText() go through readFileByPath', async () => {
  const desk = fakeDesktop({ files: { '/d/a.ptl': 'ptl v1' } });
  await withWindow({ ptDesktop: desk.bridge }, async () => {
    const bf = new PathFile('/d/a.ptl');
    assert.equal(new TextDecoder().decode(await bf.read()), 'ptl v1');
    assert.equal(await bf.readText(), 'ptl v1');
  });
});

test('PathFile: an unreadable path throws from read()', async () => {
  const desk = fakeDesktop({ files: {} });
  await withWindow({ ptDesktop: desk.bridge }, async () => {
    await assert.rejects(() => new PathFile('/gone/a.pdf').read());
  });
});

test('PathFile: read() throws when the bridge cannot read paths at all', async () => {
  const desk = fakeDesktop();
  delete desk.bridge.readFileByPath;
  await withWindow({ ptDesktop: desk.bridge }, async () => {
    await assert.rejects(() => new PathFile('/d/a.pdf').read());
  });
});

test('PathFile: write() forwards to saveSessionToPath and reports its result', async () => {
  const ok = fakeDesktop({ saveResult: true });
  await withWindow({ ptDesktop: ok.bridge }, async () => {
    assert.equal(await new PathFile('/d/a.ptl').write('text'), true);
  });
  assert.deepEqual(ok.saves(), [{ path: '/d/a.ptl', text: 'text' }]);

  const fail = fakeDesktop({ saveResult: false });
  await withWindow({ ptDesktop: fail.bridge }, async () => {
    assert.equal(await new PathFile('/d/a.ptl').write('text'), false);
  });
});

test('PathFile: a throwing save is a false, not an exception', async () => {
  const desk = fakeDesktop({ saveResult: 'throw' });
  await withWindow({ ptDesktop: desk.bridge }, async () => {
    assert.equal(await new PathFile('/d/a.ptl').write('text'), false);
  });
});

test('PathFile: a path needs no permission — the whole truth table is yes', async () => {
  const desk = fakeDesktop();
  await withWindow({ ptDesktop: desk.bridge }, async () => {
    const bf = new PathFile('/d/a.ptl');
    assert.equal(await bf.canWriteSilently(), true);
    assert.equal(await bf.requestWrite(), true);
    assert.equal(await bf.requestRead(), true);
  });
});

// ---- acquisition factories -------------------------------------------------

test('fromPickerHandle: desktop shell with a resolvable path binds the path', async () => {
  const { handle } = fakeHandle('a.ptl');
  const desk = fakeDesktop({ paths: { 'a.ptl': '/docs/a.ptl' } });
  await withWindow({ ptDesktop: desk.bridge }, () => {
    const bf = fromPickerHandle(handle, new File(['x'], 'a.ptl'));
    assert.equal(bf.kind, 'path');
    assert.equal(bf.ref, '/docs/a.ptl');
    assert.equal(bf.name, 'a.ptl');
  });
});

test('fromPickerHandle: no File in hand (the save picker) binds the handle', async () => {
  const { handle } = fakeHandle('a.ptl');
  const desk = fakeDesktop({ paths: { 'a.ptl': '/docs/a.ptl' } });
  await withWindow({ ptDesktop: desk.bridge }, () => {
    const bf = fromPickerHandle(handle);
    assert.equal(bf.kind, 'handle');
    assert.equal(bf.ref, handle);
  });
});

test('fromPickerHandle: browser (or unresolvable path) binds the handle', async () => {
  const { handle } = fakeHandle('a.ptl');
  await withWindow(browserWindow, () => {
    assert.equal(fromPickerHandle(handle, new File(['x'], 'a.ptl')).kind, 'handle');
  });
  const desk = fakeDesktop({ paths: {} }); // Electron could not resolve → ''
  await withWindow({ ptDesktop: desk.bridge }, () => {
    assert.equal(fromPickerHandle(handle, new File(['x'], 'a.ptl')).kind, 'handle');
  });
});

test('fromDrop: a desktop drop binds the file path, like an OS open', async () => {
  const desk = fakeDesktop({ paths: { 'a.ptl': '/dropped/a.ptl' } });
  await withWindow({ ptDesktop: desk.bridge }, async () => {
    const bf = await fromDrop(new File(['x'], 'a.ptl'));
    assert.equal(bf?.kind, 'path');
    assert.equal(bf?.ref, '/dropped/a.ptl');
  });
});

test('fromDrop: a browser drop binds the DataTransferItem handle', async () => {
  const { handle } = fakeHandle('a.pdf');
  const item = {
    getAsFileSystemHandle: async () => handle as unknown as FileSystemHandle,
  } as unknown as DataTransferItem;
  await withWindow(browserWindow, async () => {
    const bf = await fromDrop(new File(['x'], 'a.pdf'), item);
    assert.equal(bf?.kind, 'handle');
    assert.equal(bf?.ref, handle);
  });
});

test('fromDrop: no path, no usable handle — unbound (null)', async () => {
  await withWindow(browserWindow, async () => {
    // no item at all (the <input type=file> fallback)
    assert.equal(await fromDrop(new File(['x'], 'a.pdf')), null);
    // item without getAsFileSystemHandle (non-Chromium)
    assert.equal(await fromDrop(new File(['x'], 'a.pdf'), {} as DataTransferItem), null);
    // getAsFileSystemHandle throws
    const throwing = {
      getAsFileSystemHandle: async () => { throw new Error('nope'); },
    } as unknown as DataTransferItem;
    assert.equal(await fromDrop(new File(['x'], 'a.pdf'), throwing), null);
    // a directory handle is not a file
    const dir = {
      getAsFileSystemHandle: async () => ({ kind: 'directory' } as FileSystemHandle),
    } as unknown as DataTransferItem;
    assert.equal(await fromDrop(new File(['x'], 'a.pdf'), dir), null);
  });
});

test('fromOsOpen: binds the shell-provided path; no path stays unbound', async () => {
  const desk = fakeDesktop();
  await withWindow({ ptDesktop: desk.bridge }, () => {
    const bf = fromOsOpen('/os/a.ptl', 'a.ptl');
    assert.equal(bf?.kind, 'path');
    assert.equal(bf?.ref, '/os/a.ptl');
    assert.equal(bf?.name, 'a.ptl');
    assert.equal(fromOsOpen('', 'a.ptl'), null);
    assert.equal(fromOsOpen(undefined, 'a.ptl'), null);
  });
});

test('fromShellDialog: binds the dialog path; cancel/empty stays unbound', async () => {
  const desk = fakeDesktop();
  await withWindow({ ptDesktop: desk.bridge }, () => {
    const bf = fromShellDialog('/picked/b.ptl');
    assert.equal(bf?.kind, 'path');
    assert.equal(bf?.name, 'b.ptl');
    assert.equal(fromShellDialog(''), null);
    assert.equal(fromShellDialog(null), null);
  });
});

test('fromRecentRef: rewraps both stored identities', async () => {
  const { handle } = fakeHandle('a.pdf');
  const h = fromRecentRef(handle);
  assert.equal(h.kind, 'handle');
  assert.equal(h.ref, handle);
  assert.equal(h.name, 'a.pdf');

  const desk = fakeDesktop();
  await withWindow({ ptDesktop: desk.bridge }, () => {
    const p = fromRecentRef('/d/a.pdf');
    assert.equal(p.kind, 'path');
    assert.equal(p.ref, '/d/a.pdf');
    assert.equal(p.name, 'a.pdf');
  });
});
