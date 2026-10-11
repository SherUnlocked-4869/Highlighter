const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recognitionAPI', {
  // P0-1-T2：语言广播（主→渲染；sandbox preload 不能 require 本地文件，故内联）。
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  ready: () => ipcRenderer.send('recognition:ready'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('recognition:init', handler)
    return () => ipcRenderer.removeListener('recognition:init', handler)
  },
  recognizeTable: (dataUrl, scaleFactor) => ipcRenderer.invoke('recognition:table', { dataUrl, scaleFactor }),
  copyText: (text) => ipcRenderer.invoke('recognition:copy', text),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  close: () => ipcRenderer.send('recognition:close')
})
