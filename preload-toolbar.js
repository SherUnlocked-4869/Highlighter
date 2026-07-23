const { contextBridge, ipcRenderer } = require('electron')

let currentText = ''
let selectionListener = null

ipcRenderer.on('selection:text', (_event, data) => {
  currentText = data.text || ''
  selectionListener?.({
    actions: Array.isArray(data.actions) ? data.actions : []
  })
})

contextBridge.exposeInMainWorld('toolbarAPI', {
  onSelection: (callback) => { selectionListener = callback },
  action: (action) => ipcRenderer.send('toolbar:action', { action, text: currentText })
})
