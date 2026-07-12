// Bridge for the Software Update window: it only receives state pushes
// from the main process (which owns the updater) and sends back plain
// button actions. No filesystem or Node access is exposed.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ptUpdate', {
  onState: (cb: (state: unknown) => void) => {
    ipcRenderer.on('pt-update-state', (_event, state: unknown) => cb(state));
    // Ask for the current state once the page is listening.
    ipcRenderer.send('pt-update-ready');
  },
  action: (action: string) => {
    ipcRenderer.send('pt-update-action', action);
  },
});
