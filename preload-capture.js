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
  startLongCapture: (selection) => ipcRenderer.invoke('capture:start-long', { selection }),
  smartSelectAt: (point) => ipcRenderer.invoke('capture:smart-select', point),
  copy: (dataUrl, meta) => ipcRenderer.invoke('capture:copy', { dataUrl, meta }),
  save: (dataUrl, meta, fast) => ipcRenderer.send('capture:save', { dataUrl, meta, fast }),
  pin: (dataUrl, meta) => ipcRenderer.invoke('capture:pin', { dataUrl, meta }),
  pinAndReannotate: (dataUrl, meta, action) => ipcRenderer.invoke('capture:pin-reannotate', { dataUrl, meta, action }),
  openRecognition: (type, dataUrl, meta) => ipcRenderer.invoke('capture:open-recognition', { type, dataUrl, meta }),
  ocr: (dataUrl, options) => ipcRenderer.invoke('capture:ocr', { dataUrl, ...options }),
  translate: (dataUrl, options) => ipcRenderer.invoke('capture:translate', { dataUrl, ...options }),
  recordHistory: (dataUrl, meta) => ipcRenderer.invoke('capture:record-history', { dataUrl, meta })
})
