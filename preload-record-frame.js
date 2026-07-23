const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recordFrameAPI', {
  onState: (callback) => {
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('record-frame:state', handler)
    return () => ipcRenderer.removeListener('record-frame:state', handler)
  }
})
