const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('captureAPI', {
  ready: () => ipcRenderer.send('capture:ready'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('capture:init', handler)
    return () => ipcRenderer.removeListener('capture:init', handler)
  },
  renderReady: () => ipcRenderer.send('capture:render-ready'),
  renderError: (message) => ipcRenderer.send('capture:render-error', message),
  close: () => ipcRenderer.send('capture:close'),
  smartSelectAt: (point) => ipcRenderer.invoke('capture:smart-select', point),
  copy: (dataUrl, meta) => ipcRenderer.invoke('capture:copy', { dataUrl, meta }),
  save: (dataUrl, meta, fast) => ipcRenderer.invoke('capture:save', { dataUrl, meta, fast }),
  pin: (dataUrl, meta) => ipcRenderer.invoke('capture:pin', { dataUrl, meta }),
  ocr: (dataUrl) => ipcRenderer.invoke('capture:ocr', dataUrl),
  translate: (dataUrl) => ipcRenderer.invoke('capture:translate', dataUrl),
  recordHistory: (dataUrl, meta) => ipcRenderer.invoke('capture:record-history', { dataUrl, meta })
})
