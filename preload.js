const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getClipboardStatus: () => ipcRenderer.invoke('clipboard:status'),
  prepareClipboardClear: (scope) => ipcRenderer.invoke('clipboard:prepare-clear', { scope }),
  commitClipboardClear: (token, operationId) => ipcRenderer.invoke('clipboard:commit-clear', { token, operationId }),
  // P0-1-T2：语言广播（主→渲染；sandbox preload 不能 require 本地文件，故内联）。
  onInterfaceLanguage: (callback) => {
    const handler = (_event, language) => callback(typeof language === 'string' && language.length <= 16 ? language : '')
    ipcRenderer.on('i18n:language', handler)
    return () => ipcRenderer.removeListener('i18n:language', handler)
  },
  // Config
  testConnection: (apiKey) => ipcRenderer.invoke('config:test-connection', apiKey),
  fetchProviderModels: (provider) => ipcRenderer.invoke('config:test-connection', { provider, fetchModels: true }),
  createCodingPlanProvider: (input) => ipcRenderer.invoke('coding-plan:create-provider', input),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // Main app / settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  getShortcutStatuses: () => ipcRenderer.invoke('shortcuts:status'),
  getDataRoot: () => ipcRenderer.invoke('data-root:get'),
  changeDataRoot: () => ipcRenderer.invoke('data-root:change'),
  openDataRoot: () => ipcRenderer.invoke('data-root:open'),
  // D04: module-scoped local backups (backup -> inspect -> restore/delete).
  backupCreate: (options) => ipcRenderer.invoke('data-root:backup-create', options),
  backupInspect: (directory) => ipcRenderer.invoke('data-root:backup-inspect', directory),
  backupRestore: (options) => ipcRenderer.invoke('data-root:backup-restore', options),
  backupDelete: (directory) => ipcRenderer.invoke('data-root:backup-delete', directory),
  // N06: single-file `.hlbackup.zip` archives. The renderer submits only the
  // selected module ids plus an in-memory password; both native file dialogs run
  // in the main process, so no filesystem path crosses this bridge. The password
  // is cleared from the page input after the call returns.
  backupExportArchive: (options) => {
    const source = options && typeof options === 'object' ? options : {}
    const modules = Array.isArray(source.modules)
      ? source.modules.filter((id) => typeof id === 'string' && id.length <= 32).slice(0, 16)
      : []
    const password = typeof source.password === 'string' ? source.password : ''
    return ipcRenderer.invoke('data-root:backup-export-archive', { modules, password })
  },
  backupImportArchive: (options) => {
    const source = options && typeof options === 'object' ? options : {}
    const password = typeof source.password === 'string' ? source.password : ''
    return ipcRenderer.invoke('data-root:backup-import-archive', { password })
  },
  executeFunction: (name, payload) => ipcRenderer.invoke('app:execute-function', { name, payload }),
  getHistory: (filter) => ipcRenderer.invoke('history:list', filter),
  getHistoryThumbnail: (id) => ipcRenderer.invoke('history:thumbnail', id),
  getHistorySources: () => ipcRenderer.invoke('history:sources'),
  getHistoryStats: () => ipcRenderer.invoke('history:stats'),
  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),
  deleteHistoryMany: (ids) => ipcRenderer.invoke('history:delete-many', ids),
  exportHistory: (ids) => ipcRenderer.invoke('history:export', ids),
  // Multi-page PDF batch export (one PDF page per selected capture).
  exportHistoryPdf: (ids) => ipcRenderer.invoke('history:export-pdf', ids),
  cleanupHistory: () => ipcRenderer.invoke('history:cleanup'),
  copyHistory: (id) => ipcRenderer.invoke('history:copy', id),
  editHistory: (id) => ipcRenderer.invoke('history:edit', id),
  openHistory: (id) => ipcRenderer.invoke('history:open', id),
  copyHistoryPath: (id) => ipcRenderer.invoke('history:copy-path', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  // N02 (review section 5.2): add/remove/replace the tags of one history record. The write
  // travels as a command envelope on the existing history:list channel (see
  // main/ipc/history-ipc.js: the main-role IPC inventory is frozen, so a dedicated
  // history:update-tags channel cannot be added here without a matching sender policy).
  // Values are normalized again in HistoryService; this only keeps the payload well-typed.
  updateHistoryTags: (id, tags) => ipcRenderer.invoke('history:list', {
    op: 'update-tags',
    id: typeof id === 'string' ? id.slice(0, 128) : '',
    tags: Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string').slice(0, 16) : []
  }),
  // N02 follow-up (real-device verification, 2026-11-27): the tag filter dropdown and the OCR
  // status UI. All three ride the same 'history:list' command envelope as the tag write, for
  // the same frozen main-role IPC inventory reason documented in main/ipc/history-ipc.js.
  getHistoryTags: () => ipcRenderer.invoke('history:list', { op: 'list-tags' }),
  getHistoryOcrState: () => ipcRenderer.invoke('history:list', { op: 'ocr-state' }),
  // `ids` retries one card; `all` asks the main process to index every capture that has no
  // text index yet. The renderer never passes file paths or OCR text; only ids and the flag.
  indexHistoryOcr: (options) => {
    const source = options && typeof options === 'object' ? options : {}
    const payload = { op: 'index-ocr', all: source.all === true }
    if (Array.isArray(source.ids)) {
      payload.ids = source.ids.filter((id) => typeof id === 'string').slice(0, 500)
    }
    return ipcRenderer.invoke('history:list', payload)
  },
  requestAi: (messages, options) => ipcRenderer.invoke('ai:complete', { messages, options }),
  translateText: (text, sourceLanguage, targetLanguage) => ipcRenderer.invoke('ai:translate', { text, sourceLanguage, targetLanguage }),
  chooseDirectory: () => ipcRenderer.invoke('dialog:choose-directory'),
  openDataDirectory: () => ipcRenderer.invoke('app:open-data-directory'),
  openSaveDirectory: () => ipcRenderer.invoke('app:open-save-directory'),
  // Recording workbench (W4): the frozen §9.1 `main`-role channels. The renderer
  // may list/start/focus and manage recording records only; it never sends a
  // source or output path, and the main process re-validates every field anyway.
  // Project summaries returned through these channels are path-free by contract.
  workbenchState: () => ipcRenderer.invoke('record:workbench-state'),
  // R4 (docs/plans/2026-11-03-recording-r4-contracts.md §2.1): the recordable-window list. The
  // answer carries opaque single-use tokens only; a desktopCapturer source id never reaches a page.
  workbenchWindows: () => ipcRenderer.invoke('record:workbench-windows'),
  workbenchStart: (request) => {
    const source = request && typeof request === 'object' ? request : {}
    const mode = source.mode === 'region' ? 'region' : (source.mode === 'window' ? 'window' : 'display')
    const displayId = typeof source.displayId === 'string' ? source.displayId : ''
    // R4 §2.1: the opaque token is echoed verbatim; the main process resolves it (and re-validates).
    const windowToken = typeof source.windowToken === 'string' ? source.windowToken : ''
    const config = source.config && typeof source.config === 'object' ? source.config : {}
    const text = (value) => (typeof value === 'string' ? value : '')
    return ipcRenderer.invoke('record:workbench-start', {
      mode,
      ...(displayId ? { displayId } : {}),
      ...(windowToken ? { windowToken } : {}),
      config: {
        mode,
        displayId,
        frameRate: Number(config.frameRate) || 0,
        quality: text(config.quality),
        countdown: Number(config.countdown) || 0,
        audioSystem: config.audioSystem === true,
        audioMicrophone: config.audioMicrophone === true,
        audioMicrophoneDeviceId: text(config.audioMicrophoneDeviceId),
        saveDirectory: text(config.saveDirectory),
        // R5 §5: the presenter-enhancement opt-in is a per-recording boolean; the
        // main process starts the pointer track only when it is true and the mode
        // is display/region. Whitelisting it here keeps this payload sanitizer from
        // silently dropping the field.
        demoEnhance: config.demoEnhance === true
      }
    })
  },
  workbenchFocus: () => ipcRenderer.invoke('record:workbench-focus'),
  projectList: (query) => {
    const source = query && typeof query === 'object' ? query : {}
    const offset = Math.max(0, Math.trunc(Number(source.offset) || 0))
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(source.limit) || 20)))
    return ipcRenderer.invoke('record:project-list', { offset, limit })
  },
  projectOpen: (projectId) => ipcRenderer.invoke('record:project-open', {
    projectId: typeof projectId === 'string' ? projectId : ''
  }),
  projectRename: (projectId, name) => ipcRenderer.invoke('record:project-rename', {
    projectId: typeof projectId === 'string' ? projectId : '',
    name: typeof name === 'string' ? name : ''
  }),
  projectDelete: (projectId) => ipcRenderer.invoke('record:project-delete', {
    projectId: typeof projectId === 'string' ? projectId : ''
  }),
  projectReveal: (projectId) => ipcRenderer.invoke('record:project-reveal', {
    projectId: typeof projectId === 'string' ? projectId : ''
  }),
  // D03: salvage the decodable part of a damaged recording. The bridge takes a project id only;
  // the main process owns the source path, the temp copy and the recovered asset.
  projectSalvage: (projectId) => ipcRenderer.invoke('record:project-salvage', {
    projectId: typeof projectId === 'string' ? projectId : ''
  }),
  cancelProjectSalvage: (projectId) => ipcRenderer.invoke('record:project-salvage-cancel', {
    projectId: typeof projectId === 'string' ? projectId : ''
  }),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getProxyStatus: () => ipcRenderer.invoke('app:get-proxy-status'),
  getDisplayDiagnostics: (includeThumbnails = false) => ipcRenderer.invoke('app:get-display-diagnostics', includeThumbnails === true),
  previewDiagnostics: () => ipcRenderer.invoke('diagnostics:preview'),
  exportDiagnostics: (includeCrashDumps = false) => ipcRenderer.invoke('diagnostics:export', { includeCrashDumps: includeCrashDumps === true }),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openUpdateDownloadPage: () => ipcRenderer.invoke('update:open-download-page'),
  getOcrStatus: () => ipcRenderer.invoke('ocr:status'),
  getSearchStatus: () => ipcRenderer.invoke('search:status'),
  // Local AI CLI usage statistics (read-only; settings window -> main).
  usageStatus: () => ipcRenderer.invoke('usage:status'),
  usageRefresh: (payload) => ipcRenderer.invoke('usage:refresh', payload || {}),
  usageSummary: (query) => ipcRenderer.invoke('usage:summary', query),
  usageDaily: (query) => ipcRenderer.invoke('usage:daily', query),
  usageHourly: (query) => ipcRenderer.invoke('usage:hourly', query),
  usageBreakdown: (query) => ipcRenderer.invoke('usage:breakdown', query),
  usageHeatmap: (query) => ipcRenderer.invoke('usage:heatmap', query),
  usageClear: () => ipcRenderer.invoke('usage:clear'),
  // B07: report exchange. Export takes the same period/filter shape as the read
  // channels plus { format, save }; import takes { mode, payload } where payload
  // is the report JSON. Both answer plain data - no file path is accepted from
  // the renderer, a save dialog resolves the export target in main.
  usageExport: (query) => ipcRenderer.invoke('usage:export', query),
  usageImport: (payload) => ipcRenderer.invoke('usage:import', payload),
  getDeviceBatterySnapshot: () => ipcRenderer.invoke('device-battery:snapshot'),
  refreshDeviceBattery: () => ipcRenderer.invoke('device-battery:refresh'),
  onDeviceBatterySnapshot: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('device-battery:changed', handler)
    return () => ipcRenderer.removeListener('device-battery:changed', handler)
  },
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowClose: () => ipcRenderer.send('window:close'),
  // M2/W6b: one-way report so the main process can reclaim a hidden, clean main
  // window; the payload is re-validated there (route whitelist + boolean dirty).
  reportWindowState: (state) => {
    const source = state && typeof state === 'object' ? state : {}
    ipcRenderer.send('window:renderer-state', {
      route: source.route,
      dirty: source.dirty === true,
      dirtyReason: typeof source.dirtyReason === 'string' ? source.dirtyReason : ''
    })
  },
  onNavigate: (callback) => {
    const handler = (_event, route) => callback(route)
    ipcRenderer.on('app:navigate', handler)
    return () => ipcRenderer.removeListener('app:navigate', handler)
  },
  onGameModeChanged: (callback) => {
    const handler = (_event, enabled) => callback(enabled === true)
    ipcRenderer.on('app:game-mode-changed', handler)
    return () => ipcRenderer.removeListener('app:game-mode-changed', handler)
  },
  onHistoryChanged: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('history:changed', handler)
    return () => ipcRenderer.removeListener('history:changed', handler)
  },
  onUpdateStatus: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('update:status', handler)
    return () => ipcRenderer.removeListener('update:status', handler)
  },
  // Main -> renderer push so an open translation-service card follows a tray
  // toggle. The payload is a plain status object, never renderer input.
  onProxyStatus: (callback) => {
    const handler = (_event, status) => callback(status && typeof status === 'object' ? status : null)
    ipcRenderer.on('proxy:status', handler)
    return () => ipcRenderer.removeListener('proxy:status', handler)
  },
  // Local AI CLI scan progress (main -> renderer broadcast; renderer only listens,
  // so the channel is intentionally absent from IPC_SURFACES).
  onUsageScanProgress: (callback) => {
    const handler = (_event, progress) => callback(progress && typeof progress === 'object' ? progress : null)
    ipcRenderer.on('usage:scan-progress', handler)
    return () => ipcRenderer.removeListener('usage:scan-progress', handler)
  }
})
