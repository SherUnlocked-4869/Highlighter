const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('captureAPI', {
  // P0-1-T2：语言广播（主→渲染；sandbox preload 不能 require 本地文件，故内联）。
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
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
  // 录制/长截图在渲染层是"提前 return"，拿不到动作 meta，所以序号单独作为第二参带回
  // （P0-7-T7 精确接续的补充：这两个出口同样要"落过就推进"）。
  startLongCapture: (selection, serial) => ipcRenderer.invoke('capture:start-long', { selection, ...serial }),
  smartSelectAt: (point) => ipcRenderer.invoke('capture:smart-select', point),
  copy: (imageBuffer, meta) => ipcRenderer.invoke('capture:copy', { imageBuffer, meta }),
  save: (imageBuffer, meta, fast) => ipcRenderer.send('capture:save', { imageBuffer, meta, fast }),
  pin: (imageBuffer, meta) => ipcRenderer.invoke('capture:pin', { imageBuffer, meta }),
  pinAndReannotate: (imageBuffer, meta, action) => ipcRenderer.invoke('capture:pin-reannotate', { imageBuffer, meta, action }),
  openRecognition: (type, imageBuffer, meta) => ipcRenderer.invoke('capture:open-recognition', { type, imageBuffer, meta }),
  ocr: (imageBuffer, options) => ipcRenderer.invoke('capture:ocr', { imageBuffer, ...options }),
  translate: (imageBuffer, options) => ipcRenderer.invoke('capture:translate', { imageBuffer, ...options }),
  startRegionRecording: (selectionBounds, serial) => ipcRenderer.invoke('capture:start-region-recording', { selectionBounds, ...serial }),
  recordHistory: (imageBuffer, meta) => ipcRenderer.invoke('capture:record-history', { imageBuffer, meta }),
  exportPdf: (imageBuffer, meta, mode) => ipcRenderer.invoke('capture:export-pdf', { imageBuffer, meta, mode }),
  saveWatermarkSettings: (watermark) => ipcRenderer.invoke('settings:update', { screenshot: { watermark } }),
  saveAnnotationWidth: (annotationWidth) => ipcRenderer.invoke('settings:update', { screenshot: { annotationWidth } }),
  // A3: the palette colour rides the same settings:update pipe as the width, so
  // no new IPC channel (and no ipc-security.js entry) is needed.
  saveAnnotationColor: (annotationColor) => ipcRenderer.invoke('settings:update', { screenshot: { annotationColor } }),
  // B4: the whole per-tool style map is submitted at once (settings:update deep-merges,
  // so a partial write could otherwise leave one tool's block stale).
  saveAnnotationStyles: (annotationStyles) => ipcRenderer.invoke('settings:update', { screenshot: { annotationStyles } })
})
