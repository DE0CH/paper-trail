// Minimal bridge: the web app only learns that it runs inside the desktop
// shell and receives menu actions. No filesystem or Node access is exposed.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ptDesktop', {
  onMenu: (cb: (action: string) => void) => {
    ipcRenderer.on('pt-menu', (_event, action: string) => cb(action));
  },
});
