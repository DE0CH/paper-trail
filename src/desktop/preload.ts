// Minimal bridge: the web app only learns that it runs inside the desktop
// shell, receives menu actions, and receives files the OS asked us to open
// (Open With…, dropping a PDF on the Dock icon, recent documents). No
// filesystem or Node access is exposed.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ptDesktop', {
  platform: process.platform,
  onMenu: (cb: (action: string, payload?: string) => void) => {
    ipcRenderer.on('pt-menu', (_event, action: string, payload?: string) => cb(action, payload));
  },
  onOpenFile: (cb: (file: { name: string; data: ArrayBuffer }) => void) => {
    ipcRenderer.on('pt-open-file', (_event, file: { name: string; data: ArrayBuffer }) => cb(file));
    ipcRenderer.send('pt-open-file-ready');
  },
  // Native right-click menus: the renderer describes what was clicked,
  // the main process shows the menu and returns the chosen action id.
  showContextMenu: (ctx: unknown): Promise<string | null> =>
    ipcRenderer.invoke('pt-context-menu', ctx) as Promise<string | null>,
});
