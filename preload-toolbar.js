const { contextBridge, ipcRenderer } = require('electron')

let currentText = ''
let selectionListener = null

ipcRenderer.on('selection:text', (_event, data) => {
  currentText = data.text || ''
  selectionListener?.({
    actions: Array.isArray(data.actions) ? data.actions : [],
    appearance: data.appearance || {}
  })
})

contextBridge.exposeInMainWorld('toolbarAPI', {
  // P0-1-T2：语言广播（主→渲染；sandbox preload 不能 require 本地文件，故内联）。
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  onSelection: (callback) => { selectionListener = callback },
  onAppearance: (callback) => ipcRenderer.on('toolbar:appearance', (_event, appearance) => callback(appearance)),
  action: (action) => ipcRenderer.send('toolbar:action', { action, text: currentText })
})
