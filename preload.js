const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Config
  getApiKey: () => ipcRenderer.invoke('config:get-api-key'),
  saveApiKey: (apiKey) => ipcRenderer.invoke('config:save-api-key', apiKey),
  testConnection: (apiKey) => ipcRenderer.invoke('config:test-connection', apiKey),
  onStartHook: (apiKey) => ipcRenderer.send('config:start-hook', apiKey),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // Main app / settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  getShortcutStatuses: () => ipcRenderer.invoke('shortcuts:status'),
  getDataRoot: () => ipcRenderer.invoke('data-root:get'),
  changeDataRoot: () => ipcRenderer.invoke('data-root:change'),
  openDataRoot: () => ipcRenderer.invoke('data-root:open'),
  executeFunction: (name, payload) => ipcRenderer.invoke('app:execute-function', { name, payload }),
  getHistory: (filter) => ipcRenderer.invoke('history:list', filter),
  getHistoryThumbnail: (id) => ipcRenderer.invoke('history:thumbnail', id),
  getHistorySources: () => ipcRenderer.invoke('history:sources'),
  getHistoryStats: () => ipcRenderer.invoke('history:stats'),
  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),
  deleteHistoryMany: (ids) => ipcRenderer.invoke('history:delete-many', ids),
  exportHistory: (ids) => ipcRenderer.invoke('history:export', ids),
  cleanupHistory: () => ipcRenderer.invoke('history:cleanup'),
  copyHistory: (id) => ipcRenderer.invoke('history:copy', id),
  editHistory: (id) => ipcRenderer.invoke('history:edit', id),
  revealHistory: (id) => ipcRenderer.invoke('history:reveal', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  requestAi: (messages, options) => ipcRenderer.invoke('ai:complete', { messages, options }),
  translateText: (text, sourceLanguage, targetLanguage) => ipcRenderer.invoke('ai:translate', { text, sourceLanguage, targetLanguage }),
  chooseDirectory: () => ipcRenderer.invoke('dialog:choose-directory'),
  openDataDirectory: () => ipcRenderer.invoke('app:open-data-directory'),
  openSaveDirectory: () => ipcRenderer.invoke('app:open-save-directory'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getDisplayDiagnostics: () => ipcRenderer.invoke('app:get-display-diagnostics'),
  previewDiagnostics: () => ipcRenderer.invoke('diagnostics:preview'),
  exportDiagnostics: (includeCrashDumps = false) => ipcRenderer.invoke('diagnostics:export', { includeCrashDumps: includeCrashDumps === true }),
  getOcrStatus: () => ipcRenderer.invoke('ocr:status'),
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowClose: () => ipcRenderer.send('window:close'),
  onNavigate: (callback) => {
    const handler = (_event, route) => callback(route)
    ipcRenderer.on('app:navigate', handler)
    return () => ipcRenderer.removeListener('app:navigate', handler)
  },
  onHistoryChanged: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('history:changed', handler)
    return () => ipcRenderer.removeListener('history:changed', handler)
  }
})
