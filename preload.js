const { contextBridge, ipcRenderer } = require('electron')

let mdConverter = null
try {
  const showdown = require('showdown')
  mdConverter = new showdown.Converter({
    tables: true, strikethrough: true, tasklists: true,
    simpleLineBreaks: true, openLinksInNewWindow: true
  })
} catch {
  mdConverter = null
}

function renderMd(text) {
  if (mdConverter) {
    try { return mdConverter.makeHtml(text) } catch { /* fallback */ }
  }
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Config
  getApiKey: () => ipcRenderer.invoke('config:get-api-key'),
  saveApiKey: (apiKey) => ipcRenderer.invoke('config:save-api-key', apiKey),
  testConnection: (apiKey) => ipcRenderer.invoke('config:test-connection', apiKey),
  onStartHook: (apiKey) => ipcRenderer.send('config:start-hook', apiKey),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // Toolbar
  onSelectionText: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('selection:text', handler)
    return () => ipcRenderer.removeListener('selection:text', handler)
  },
  toolbarAction: (action, text) => ipcRenderer.send('toolbar:action', { action, text }),
  toolbarClose: () => ipcRenderer.send('toolbar:close'),

  // Action - Start
  onActionStart: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('action:start', handler)
    return () => ipcRenderer.removeListener('action:start', handler)
  },

  // Action - Stream
  onStreamData: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('stream:data', handler)
    return () => ipcRenderer.removeListener('stream:data', handler)
  },
  onStreamReasoning: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('stream:reasoning', handler)
    return () => ipcRenderer.removeListener('stream:reasoning', handler)
  },
  onStreamDone: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('stream:done', handler)
    return () => ipcRenderer.removeListener('stream:done', handler)
  },
  onStreamError: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('stream:error', handler)
    return () => ipcRenderer.removeListener('stream:error', handler)
  },
  cancelStream: () => ipcRenderer.send('stream:cancel'),
  finishStream: () => ipcRenderer.send('stream:finish'),
  togglePin: (pinned) => ipcRenderer.send('window:toggle-pin', pinned),
  onPinDenied: (callback) => {
    const handler = (_e, data) => callback(data)
    ipcRenderer.on('window:pin-denied', handler)
    return () => ipcRenderer.removeListener('window:pin-denied', handler)
  },

  renderMarkdown: (text) => renderMd(text)
})
