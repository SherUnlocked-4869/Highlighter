const { contextBridge, ipcRenderer } = require('electron')
const on = (channel, callback) => {
  const handler = (_event, value) => callback(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
contextBridge.exposeInMainWorld('clipboardAPI', {
  ready: () => ipcRenderer.send('clipboard:ready'),
  interactive: (generation) => ipcRenderer.send('clipboard:interactive', generation),
  close: () => ipcRenderer.send('clipboard:close'),
  list: (args) => ipcRenderer.invoke('clipboard:list', args),
  detail: (id) => ipcRenderer.invoke('clipboard:detail', { id }),
  preview: (id) => ipcRenderer.invoke('clipboard:preview', { id }),
  copy: (id, operationId) => ipcRenderer.invoke('clipboard:copy', { id, operationId }),
  paste: (id, operationId) => ipcRenderer.invoke('clipboard:paste', { id, operationId }),
  setPinned: (id, pinned, operationId) => ipcRenderer.invoke('clipboard:set-pinned', { id, pinned, operationId }),
  delete: (ids, operationId) => ipcRenderer.invoke('clipboard:delete', { ids, operationId }),
  prepareClear: (scope) => ipcRenderer.invoke('clipboard:prepare-clear', { scope }),
  commitClear: (token, operationId) => ipcRenderer.invoke('clipboard:commit-clear', { token, operationId }),
  status: () => ipcRenderer.invoke('clipboard:status'),
  setPaused: (paused) => ipcRenderer.invoke('clipboard:set-paused', { paused }),
  onInit: (callback) => on('clipboard:init', callback),
  onStatus: (callback) => on('clipboard:status-changed', callback),
  onHistory: (callback) => on('clipboard:history-changed', callback),
  onHidden: (callback) => on('clipboard:hidden', callback),
  onLanguage: (callback) => on('i18n:language', callback)
})
