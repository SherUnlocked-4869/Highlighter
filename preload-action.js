const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onActionStart: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('action:start', handler)
    return () => ipcRenderer.removeListener('action:start', handler)
  },
  onActionAppearance: (callback) => {
    const handler = (_event, appearance) => callback(appearance)
    ipcRenderer.on('action:appearance', handler)
    return () => ipcRenderer.removeListener('action:appearance', handler)
  },
  onStreamData: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('stream:data', handler)
    return () => ipcRenderer.removeListener('stream:data', handler)
  },
  onStreamReasoning: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('stream:reasoning', handler)
    return () => ipcRenderer.removeListener('stream:reasoning', handler)
  },
  onStreamDone: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('stream:done', handler)
    return () => ipcRenderer.removeListener('stream:done', handler)
  },
  onStreamError: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('stream:error', handler)
    return () => ipcRenderer.removeListener('stream:error', handler)
  },
  cancelStream: () => ipcRenderer.send('stream:cancel'),
  finishStream: () => ipcRenderer.send('stream:finish'),
  togglePin: (pinned) => ipcRenderer.send('window:toggle-pin', pinned),
  onPinDenied: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('window:pin-denied', handler)
    return () => ipcRenderer.removeListener('window:pin-denied', handler)
  }
})
