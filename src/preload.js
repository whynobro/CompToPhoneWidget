const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, v) => cb(v));

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  send: (paths) => ipcRenderer.invoke('send', paths),
  pick: () => ipcRenderer.invoke('pick'),
  pathFor: (file) => webUtils.getPathForFile(file),
  menu: () => ipcRenderer.send('menu'),
  openSettings: () => ipcRenderer.send('open-settings'),
  onGeometry: on('geometry'),
  onWallpaper: on('wallpaper'),
  onConfigured: on('configured'),
  onExternalSend: on('external-send'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  testSettings: (s) => ipcRenderer.invoke('settings:test', s),
  ntfyQr: (n) => ipcRenderer.invoke('settings:qr', n),
  connectDrive: () => ipcRenderer.invoke('settings:drive-connect'),

  sendNote: (text) => ipcRenderer.invoke('note:send', text),
  noteInit: () => ipcRenderer.invoke('note:init'),
  closeNote: () => ipcRenderer.send('note:close'),
  openNote: () => ipcRenderer.send('note:open'),
  onNoteSent: on('note-sent'),
  onProgress: on('progress'),
  openUrl: (url) => ipcRenderer.send('open-url', url),
});
