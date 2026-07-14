// Blocking an OS shutdown/logout on Windows. When a window still has an
// unsaved reading session, the query-session-end veto (main.ts) returns
// FALSE to WM_QUERYENDSESSION so the session is withheld; this file supplies
// the reason string Windows shows on its shutdown screen while it waits.
//
// ShutdownBlockReasonCreate/Destroy live in user32.dll, reached through
// koffi's prebuilt FFI exactly like the native context menus in winMenu.ts.
// Everything here is a no-op off Windows (koffi/user32 only load there), so
// callers need no platform guard of their own.

import type { BrowserWindow } from 'electron';

type Fn = (...args: unknown[]) => unknown;
let api: Record<'ShutdownBlockReasonCreate' | 'ShutdownBlockReasonDestroy', Fn> | null = null;

function user32() {
  if (!api) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as { load(lib: string): { func(sig: string): Fn } };
    const lib = koffi.load('user32.dll');
    api = {
      // BOOL ShutdownBlockReasonCreate(HWND, LPCWSTR); BOOL ...Destroy(HWND);
      ShutdownBlockReasonCreate: lib.func('bool ShutdownBlockReasonCreate(uint64, str16)'),
      ShutdownBlockReasonDestroy: lib.func('bool ShutdownBlockReasonDestroy(uint64)'),
    };
  }
  return api;
}

function hwndOf(win: BrowserWindow): bigint {
  return win.getNativeWindowHandle().readBigUInt64LE(0);
}

/**
 * Register (or refresh) the reason Windows displays on its shutdown screen
 * while this window blocks the shutdown. Idempotent: Windows replaces the
 * existing reason if one is already set for the window.
 */
export function blockShutdown(win: BrowserWindow, reason: string): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  try {
    user32().ShutdownBlockReasonCreate(hwndOf(win), reason);
  } catch (e) {
    console.warn('ShutdownBlockReasonCreate failed', e);
  }
}

/** Clear the block so a later shutdown proceeds. Safe to call when none is set. */
export function unblockShutdown(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  try {
    user32().ShutdownBlockReasonDestroy(hwndOf(win));
  } catch (e) {
    console.warn('ShutdownBlockReasonDestroy failed', e);
  }
}
