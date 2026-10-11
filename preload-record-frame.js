const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recordFrameAPI', {
  // P0-1-T2：语言广播（主→渲染；sandbox preload 不能 require 本地文件，故内联）。
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  ready: () => ipcRenderer.send('record-frame:ready'),
  onState: (callback) => {
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('record-frame:state', handler)
    return () => ipcRenderer.removeListener('record-frame:state', handler)
  },
  onCommand: (callback) => {
    const handler = (_event, command) => callback(command)
    ipcRenderer.on('record-frame:command', handler)
    return () => ipcRenderer.removeListener('record-frame:command', handler)
  },
  submitSnapshot: (snapshot) => ipcRenderer.send('record-frame:snapshot', snapshot)
})
