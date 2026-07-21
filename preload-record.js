const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recordAPI', {
  ready: () => ipcRenderer.send('record:ready'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('record:init', handler)
    return () => ipcRenderer.removeListener('record:init', handler)
  },
  save: (arrayBuffer, mimeType) => ipcRenderer.invoke('record:save', { arrayBuffer, mimeType }),
  close: () => ipcRenderer.send('record:close')
})
