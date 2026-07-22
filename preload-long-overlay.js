const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('longOverlayAPI', {
  ready: () => ipcRenderer.send('long-overlay:ready'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('long-overlay:init', handler)
    return () => ipcRenderer.removeListener('long-overlay:init', handler)
  },
  onActiveChanged: (callback) => {
    const handler = (_event, active) => callback(active)
    ipcRenderer.on('long-overlay:active', handler)
    return () => ipcRenderer.removeListener('long-overlay:active', handler)
  },
  onEditingChanged: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('long-overlay:editing', handler)
    return () => ipcRenderer.removeListener('long-overlay:editing', handler)
  },
  updateBounds: (bounds) => ipcRenderer.send('long-overlay:bounds-changed', bounds)
})
