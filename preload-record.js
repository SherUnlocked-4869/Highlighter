const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recordAPI', {
  ready: () => ipcRenderer.send('record:ready'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('record:init', handler)
    return () => ipcRenderer.removeListener('record:init', handler)
  },
  startSession: () => ipcRenderer.invoke('record:start-session'),
  appendChunk: (sessionId, arrayBuffer) => ipcRenderer.invoke('record:append-chunk', { sessionId, arrayBuffer }),
  finishSession: (sessionId) => ipcRenderer.invoke('record:finish-session', { sessionId }),
  saveMp4: (sessionId, durationMs) => ipcRenderer.invoke('record:save-mp4', { sessionId, durationMs }),
  cancelSession: (sessionId) => ipcRenderer.invoke('record:cancel-session', { sessionId }),
  setFrameState: (state) => ipcRenderer.invoke('record:set-frame-state', state),
  resizePreview: () => ipcRenderer.invoke('record:resize-preview'),
  restart: (sessionId) => ipcRenderer.invoke('record:restart', { sessionId }),
  onSaveProgress: (callback) => {
    const handler = (_event, percent) => callback(percent)
    ipcRenderer.on('record:save-progress', handler)
    return () => ipcRenderer.removeListener('record:save-progress', handler)
  },
  close: () => ipcRenderer.send('record:close')
})
