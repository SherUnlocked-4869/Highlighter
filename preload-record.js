const { contextBridge, ipcRenderer } = require('electron')

// The record role's IPC surface (contract §9.2). Every channel here is
// registered by the main process for the control-bar window only; the renderer
// never receives a source path, a target path or arbitrary ffmpeg arguments.
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('recordAPI', {
  // P0-1-T2: language broadcast (main -> renderer; the sandboxed preload cannot
  // require local files, so the payload is inlined).
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  ready: () => ipcRenderer.send('record:ready'),
  onInit: (callback) => subscribe('record:init', callback),
  // R2 command arbitration (contract §9.2): tray / shortcut commands arrive here
  // and must land on exactly the same applyCommand path the buttons use.
  onCommand: (callback) => subscribe('record:command', callback),
  reportState: (state) => ipcRenderer.send('record:state', state),
  reportCommandResult: (result) => ipcRenderer.send('record:command-result', result),
  // R2 state reconciliation (contract §9.2): the pull fallback for a lost push, and the
  // post-command echo main broadcasts so a lost command cannot leave the bar stale.
  getState: () => ipcRenderer.invoke('record:get-state', {}),
  onStateChanged: (callback) => subscribe('record:state-changed', callback),
  // R4 window mode (contract §2.2): main polls the bound window source while the control
  // bar is alive and pushes this once when it disappears (closed). Payload: { reason }.
  onSourceLost: (callback) => subscribe('record:source-lost', callback),
  startSession: () => ipcRenderer.invoke('record:start-session'),
  // `sequence` starts at 1 and is strictly increasing; `bytes` is the Blob size the
  // ACK is checked against. Duplicate/old sequences are idempotent in the main process.
  appendChunk: (sessionId, arrayBuffer, sequence, bytes) => ipcRenderer.invoke('record:append-chunk', {
    sessionId,
    arrayBuffer,
    sequence,
    bytes
  }),
  finishSession: (sessionId) => ipcRenderer.invoke('record:finish-session', { sessionId }),
  cancelSession: (sessionId) => ipcRenderer.invoke('record:cancel-session', { sessionId }),
  // Retained legacy channels (contract §9.2: kept so old callers do not break; the
  // control bar itself has no UI entry for them any more).
  saveMp4: (sessionId, durationMs) => ipcRenderer.invoke('record:save-mp4', { sessionId, durationMs }),
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
  onSaveProgress: (callback) => subscribe('record:save-progress', callback),
  onAnnotationSnapshot: (callback) => subscribe('record:annotation-snapshot', callback),
  reportPerformance: (details) => ipcRenderer.send('record:performance', details),
  close: () => ipcRenderer.send('record:close')
})
