// REAL Win32 popup menus. Electron's Menu renders a Chromium-drawn
// widget on Windows that looks and animates nothing like the OS menus
// a native app is expected to have, so Windows context menus go
// through user32 directly (via koffi's prebuilt FFI): CreatePopupMenu
// + TrackPopupMenuEx with TPM_RETURNCMD blocks like a native menu and
// returns the chosen command.

import type { BrowserWindow } from 'electron';
import { screen } from 'electron';

export type WinMenuItem =
  | { id: string; label: string; enabled?: boolean }
  | { type: 'separator' };

const MF_STRING = 0x0000;
const MF_GRAYED = 0x0001;
const MF_SEPARATOR = 0x0800;
const TPM_RIGHTBUTTON = 0x0002;
const TPM_RETURNCMD = 0x0100;

type Fn = (...args: unknown[]) => unknown;
let api: Record<'CreatePopupMenu' | 'AppendMenuW' | 'TrackPopupMenuEx'
  | 'DestroyMenu' | 'SetForegroundWindow', Fn> | null = null;

function user32() {
  if (!api) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as { load(lib: string): { func(sig: string): Fn } };
    const lib = koffi.load('user32.dll');
    api = {
      CreatePopupMenu: lib.func('uint64 CreatePopupMenu()'),
      AppendMenuW: lib.func('bool AppendMenuW(uint64, uint, uint64, str16)'),
      TrackPopupMenuEx: lib.func('uint TrackPopupMenuEx(uint64, uint, int, int, uint64, void*)'),
      DestroyMenu: lib.func('bool DestroyMenu(uint64)'),
      SetForegroundWindow: lib.func('bool SetForegroundWindow(uint64)'),
    };
  }
  return api;
}

/**
 * Show a native Win32 context menu at the cursor and return the chosen
 * item's id (null when dismissed). Blocks the main process while open,
 * exactly like any native menu's modal message loop.
 */
export function popupWin32(win: BrowserWindow, items: WinMenuItem[]): string | null {
  const u = user32();
  const menu = u.CreatePopupMenu() as bigint;
  const ids: string[] = [];
  for (const it of items) {
    if ('type' in it) {
      u.AppendMenuW(menu, MF_SEPARATOR, 0, null);
    } else {
      ids.push(it.id);
      u.AppendMenuW(menu,
        MF_STRING | (it.enabled === false ? MF_GRAYED : 0), ids.length, it.label);
    }
  }
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
  // TrackPopupMenu wants physical pixels; Electron reports DIPs.
  const px = screen.dipToScreenPoint(screen.getCursorScreenPoint());
  u.SetForegroundWindow(hwnd);
  const cmd = Number(u.TrackPopupMenuEx(
    menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, px.x, px.y, hwnd, null));
  u.DestroyMenu(menu);
  return cmd > 0 ? ids[cmd - 1] ?? null : null;
}
