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
  startLongCapture: (selection, autoStart = false) => ipcRenderer.invoke('capture:start-long', {
    selection,
    autoStart: !!autoStart
  }),
  smartSelectAt: (point) => ipcRenderer.invoke('capture:smart-select', point),
  copy: (imageBuffer, meta) => ipcRenderer.invoke('capture:copy', { imageBuffer, meta }),
  save: (imageBuffer, meta, fast) => ipcRenderer.send('capture:save', { imageBuffer, meta, fast }),
  pin: (imageBuffer, meta) => ipcRenderer.invoke('capture:pin', { imageBuffer, meta }),
  pinAndReannotate: (imageBuffer, meta, action) => ipcRenderer.invoke('capture:pin-reannotate', { imageBuffer, meta, action }),
  openRecognition: (type, imageBuffer, meta) => ipcRenderer.invoke('capture:open-recognition', { type, imageBuffer, meta }),
  ocr: (imageBuffer, options) => ipcRenderer.invoke('capture:ocr', { imageBuffer, ...options }),
  translate: (imageBuffer, options) => ipcRenderer.invoke('capture:translate', { imageBuffer, ...options }),
  startRegionRecording: (selectionBounds) => ipcRenderer.invoke('capture:start-region-recording', { selectionBounds }),
  recordHistory: (imageBuffer, meta) => ipcRenderer.invoke('capture:record-history', { imageBuffer, meta })
})
