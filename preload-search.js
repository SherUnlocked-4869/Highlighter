const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('searchAPI', {
  // P0-1-T2：语言广播（主→渲染；sandbox preload 不能 require 本地文件，故内联）。
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  ready: () => ipcRenderer.send('search:ready'),
  close: () => ipcRenderer.send('search:close'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('search:init', handler)
    return () => ipcRenderer.removeListener('search:init', handler)
  },
  onStatusChanged: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('search:status-changed', handler)
    return () => ipcRenderer.removeListener('search:status-changed', handler)
  },
  onSettingsChanged: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('search:settings-changed', handler)
    return () => ipcRenderer.removeListener('search:settings-changed', handler)
  },
  query: (payload) => ipcRenderer.invoke('search:query', payload),
  getStatus: () => ipcRenderer.invoke('search:status'),
  ensureReady: () => ipcRenderer.invoke('search:ensure-ready'),
  openPath: (path) => ipcRenderer.invoke('search:open-path', { path }),
  revealPath: (path) => ipcRenderer.invoke('search:reveal-path', { path }),
  copyPath: (path) => ipcRenderer.invoke('search:copy-path', { path }),
  getFileIcon: (path) => ipcRenderer.invoke('search:file-icon', { path }),
  savePrefs: (patch) => ipcRenderer.invoke('settings:update', patch)
})
