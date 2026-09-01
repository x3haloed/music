const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('music', {
  getSnapshot: () => ipcRenderer.invoke('music:getSnapshot'),
  send: message => ipcRenderer.invoke('music:send', { message }),
  onSnapshot(callback) {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('music:snapshot', listener);
    return () => ipcRenderer.off('music:snapshot', listener);
  },
});
