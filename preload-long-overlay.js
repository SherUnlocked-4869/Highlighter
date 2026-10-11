const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('longOverlayAPI', {
  // P0-1-T2：语言广播（主→渲染；sandbox preload 不能 require 本地文件，故内联）。
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  ready: () => ipcRenderer.send('long-overlay:ready'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('long-overlay:init', handler)
    return () => ipcRenderer.removeListener('long-overlay:init', handler)
  },
  onActiveChanged: (callback) => {
    const handler = (_event, active) => callback(active)
    ipcRenderer.on('long-overlay:active', handler)
    return () => ipcRenderer.removeListener('long-overlay:active', handler)
  },
  onEditingChanged: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('long-overlay:editing', handler)
    return () => ipcRenderer.removeListener('long-overlay:editing', handler)
  },
  updateBounds: (bounds) => ipcRenderer.send('long-overlay:bounds-changed', bounds)
})
