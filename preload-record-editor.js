// Preload for the standalone recording editor window (R3, docs/plans/2026-11-03-recording-r1-r3-contracts.md §8/§9.3).
//
// The editor never names a path: the main process derives `sourceUrl` from the project source file
// and owns the export target (save dialog). Every channel below is sender-policy checked in
// main/services/ipc-security.js against the `record-editor` role, which only accepts THIS window.
//
// Two shapes matter to record/editor.js:
//   * `record-editor:init` / `record-editor:reload` -> { project, sourceUrl, metadata, recovery };
//   * `record:export-progress` -> the public export task (same shape the legacy recorder uses).
//
// Listener registrations are written out per channel (no shared helper): the channel literals are
// part of the frozen contract, and an editor window that silently subscribed to the wrong name
// would hang on "loading the project" with no error anywhere.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recordEditorAPI', {
  // i18n broadcast (main -> renderer). Returns an unsubscribe function; the page unsubscribes on
  // teardown so a language flip cannot call into a torn-down view.
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  ready: () => ipcRenderer.send('record-editor:ready'),
  onInit: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('record-editor:init', handler)
    return () => ipcRenderer.removeListener('record-editor:init', handler)
  },
  saveDraft: (projectId, expectedRevision, edit) => ipcRenderer.invoke('record-editor:save-draft', { projectId, expectedRevision, edit }),
  exportProject: (projectId, requestId, request) => ipcRenderer.invoke('record-editor:export', { projectId, requestId, request }),
  exportStatus: (query) => ipcRenderer.invoke('record-editor:export-status', query),
  cancelExport: (query) => ipcRenderer.invoke('record-editor:cancel-export', query),
  renameProject: (projectId, name) => ipcRenderer.invoke('record-editor:rename', { projectId, name }),
  rerecord: (projectId) => ipcRenderer.invoke('record-editor:rerecord', { projectId }),
  reveal: (projectId) => ipcRenderer.invoke('record-editor:reveal', { projectId }),
  // Re-derives project/sourceUrl/metadata from disk: recovery-banner retry and conflict reload.
  reload: (projectId) => ipcRenderer.invoke('record-editor:reload', { projectId }),
  back: () => ipcRenderer.invoke('record-editor:back'),
  closeWindow: () => ipcRenderer.send('record-editor:close'),
  windowAction: (action) => ipcRenderer.send('record-editor:window', { action }),
  exportAction: (resultId, action) => ipcRenderer.invoke('export:perform-action', { resultId, action }),
  onExportProgress: (callback) => {
    const handler = (_event, task) => callback(task)
    ipcRenderer.on('record:export-progress', handler)
    return () => ipcRenderer.removeListener('record:export-progress', handler)
  }
})
