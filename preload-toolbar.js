const { contextBridge, ipcRenderer } = require('electron')

let currentText = ''

ipcRenderer.on('selection:text', (_e, data) => {
  currentText = data.text || ''
  // Send feedback to main so we know text was received
  ipcRenderer.send('debug:text-received', { len: currentText.length })
})

contextBridge.exposeInMainWorld('toolbarAPI', {
  translate: () => {
    // Always send - let main process handle empty text case
    ipcRenderer.send('toolbar:action', { action: 'translate', text: currentText || '' })
  },
  explain: () => {
    ipcRenderer.send('toolbar:action', { action: 'explain', text: currentText || '' })
  }
})
