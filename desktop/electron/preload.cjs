// Minimal bridge: the web app only learns that it runs inside the desktop
// shell and receives menu actions. No filesystem or Node access is exposed.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('psrDesktop', {
  onMenu: (cb) => ipcRenderer.on('psr-menu', (_event, action) => cb(action)),
});
