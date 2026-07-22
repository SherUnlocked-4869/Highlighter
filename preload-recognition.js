const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recognitionAPI', {
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
