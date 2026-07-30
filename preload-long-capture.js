const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('longCaptureAPI', {
  ready: () => ipcRenderer.send('long-capture:ready'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('long-capture:init', handler)
    return () => ipcRenderer.removeListener('long-capture:init', handler)
  },
  addStrip: (arrayBuffer, metadata) => ipcRenderer.invoke('long-capture:add-strip', { arrayBuffer, metadata }),
  setTrim: (start, end) => ipcRenderer.invoke('long-capture:set-trim', { start, end }),
  setSelectionEditing: (enabled, axis, hasContent) => ipcRenderer.invoke('long-capture:set-selection-editing', { enabled, axis, hasContent }),
  onSelectionUpdated: (callback) => {
    const handler = (_event, bounds) => callback(bounds)
    ipcRenderer.on('long-capture:selection-updated', handler)
    return () => ipcRenderer.removeListener('long-capture:selection-updated', handler)
  },
  finish: (action, fast) => ipcRenderer.invoke('long-capture:finish', { action, fast: !!fast }),
  setOverlayActive: (active) => ipcRenderer.send('long-capture:overlay-active', !!active),
  close: () => ipcRenderer.send('long-capture:close')
})
