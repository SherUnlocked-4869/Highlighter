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
  // serialNumber 只在本次截图落过序号时才有值（0 = 没落过），用于主进程精确接续序号（P0-7-T7）。
  close: (serialNumber) => ipcRenderer.send('capture:close', { serialNumber }),
  startLongCapture: (selection) => ipcRenderer.invoke('capture:start-long', { selection }),
  smartSelectAt: (point) => ipcRenderer.invoke('capture:smart-select', point),
  copy: (imageBuffer, meta) => ipcRenderer.invoke('capture:copy', { imageBuffer, meta }),
  save: (imageBuffer, meta, fast) => ipcRenderer.send('capture:save', { imageBuffer, meta, fast }),
  pin: (imageBuffer, meta) => ipcRenderer.invoke('capture:pin', { imageBuffer, meta }),
  pinAndReannotate: (imageBuffer, meta, action) => ipcRenderer.invoke('capture:pin-reannotate', { imageBuffer, meta, action }),
  openRecognition: (type, imageBuffer, meta) => ipcRenderer.invoke('capture:open-recognition', { type, imageBuffer, meta }),
  ocr: (imageBuffer, options) => ipcRenderer.invoke('capture:ocr', { imageBuffer, ...options }),
  translate: (imageBuffer, options) => ipcRenderer.invoke('capture:translate', { imageBuffer, ...options }),
  startRegionRecording: (selectionBounds) => ipcRenderer.invoke('capture:start-region-recording', { selectionBounds }),
  recordHistory: (imageBuffer, meta) => ipcRenderer.invoke('capture:record-history', { imageBuffer, meta }),
  exportPdf: (imageBuffer, meta, mode) => ipcRenderer.invoke('capture:export-pdf', { imageBuffer, meta, mode }),
  saveWatermarkSettings: (watermark) => ipcRenderer.invoke('settings:update', { screenshot: { watermark } }),
  saveAnnotationWidth: (annotationWidth) => ipcRenderer.invoke('settings:update', { screenshot: { annotationWidth } })
})
