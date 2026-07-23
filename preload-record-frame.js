const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recordFrameAPI', {
  ready: () => ipcRenderer.send('record-frame:ready'),
  onState: (callback) => {
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('record-frame:state', handler)
    return () => ipcRenderer.removeListener('record-frame:state', handler)
  },
  onCommand: (callback) => {
    const handler = (_event, command) => callback(command)
    ipcRenderer.on('record-frame:command', handler)
    return () => ipcRenderer.removeListener('record-frame:command', handler)
  },
  submitSnapshot: (snapshot) => ipcRenderer.send('record-frame:snapshot', snapshot)
})
