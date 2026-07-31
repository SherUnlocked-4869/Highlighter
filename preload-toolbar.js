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
  onSelection: (callback) => { selectionListener = callback },
  onAppearance: (callback) => ipcRenderer.on('toolbar:appearance', (_event, appearance) => callback(appearance)),
  action: (action) => ipcRenderer.send('toolbar:action', { action, text: currentText })
})
