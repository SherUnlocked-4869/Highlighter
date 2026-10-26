const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recordAPI', {
  // P0-1-T2：语言广播（主→渲染；sandbox preload 不能 require 本地文件，故内联）。
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  ready: () => ipcRenderer.send('record:ready'),
  onInit: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('record:init', handler)
    return () => ipcRenderer.removeListener('record:init', handler)
  },
  startSession: () => ipcRenderer.invoke('record:start-session'),
  appendChunk: (sessionId, arrayBuffer) => ipcRenderer.invoke('record:append-chunk', { sessionId, arrayBuffer }),
  finishSession: (sessionId) => ipcRenderer.invoke('record:finish-session', { sessionId }),
  saveMp4: (sessionId, durationMs) => ipcRenderer.invoke('record:save-mp4', { sessionId, durationMs }),
  cancelSession: (sessionId) => ipcRenderer.invoke('record:cancel-session', { sessionId }),
  // Feature E (plan §8.3): trim + MP4/GIF export. `request` is `{ range, format, gif? }` —
  // never a path. The main process owns the save dialog and freezes the target.
  probeSession: (sessionId, durationMs) => ipcRenderer.invoke('record:probe-session', { sessionId, durationMs }),
  exportRecording: (sessionId, requestId, request) => ipcRenderer.invoke('record:export', { sessionId, requestId, request }),
  exportStatus: (query) => ipcRenderer.invoke('record:export-status', query),
  cancelExport: (query) => ipcRenderer.invoke('record:cancel-export', query),
  closePreview: (sessionId) => ipcRenderer.invoke('record:close-preview', { sessionId }),
  onExportProgress: (callback) => {
    const handler = (_event, task) => callback(task)
    ipcRenderer.on('record:export-progress', handler)
    return () => ipcRenderer.removeListener('record:export-progress', handler)
  },
  // Feature A (plan §4.2): the exported file is addressed by resultId only.
  exportAction: (resultId, action) => ipcRenderer.invoke('export:perform-action', { resultId, action }),
  setFrameState: (state) => ipcRenderer.invoke('record:set-frame-state', state),
  setAnnotationCommand: (command) => ipcRenderer.invoke('record:set-annotation-command', command),
  resizePreview: () => ipcRenderer.invoke('record:resize-preview'),
  restart: (sessionId) => ipcRenderer.invoke('record:restart', { sessionId }),
  onSaveProgress: (callback) => {
    const handler = (_event, percent) => callback(percent)
    ipcRenderer.on('record:save-progress', handler)
    return () => ipcRenderer.removeListener('record:save-progress', handler)
  },
  onAnnotationSnapshot: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('record:annotation-snapshot', handler)
    return () => ipcRenderer.removeListener('record:annotation-snapshot', handler)
  },
  reportPerformance: (details) => ipcRenderer.send('record:performance', details),
  close: () => ipcRenderer.send('record:close')
})
