'use strict'

// H05 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 2.5): every IPC
// channel registration is aggregated here.
//
// main.js used to carry ~190 lines of registration bodies plus ~15 imports that only that
// block used. Together with the hard line ceiling that is what produced the 300+ character
// lines the review flagged. This module owns the "which channels exist" inventory; main.js
// only hands over the live collaborators.
//
// Two rules keep registration order-independent:
//   * anything created during startApplication (the settings service, the history service,
//     the export-result registry) is passed as a resolver, never as a value;
//   * domain controllers are built here from the domains main.js assembled, because that is
//     all this layer does.

const regionPresets = require('../../shared/region-presets')
const { registerSettingsIpc } = require('./settings-ipc')
const { createHistoryOcrIndexer } = require('../services/history-ocr-indexer')
const { createCodingPlanIpcController, registerCodingPlanIpc } = require('./coding-plan-ipc')
const { registerHistoryIpc } = require('./history-ipc')
const { registerShortcutIpc } = require('./shortcut-ipc')
const { registerAppIpc } = require('./app-ipc')
const { createDiagnosticsIpcController, registerDiagnosticsIpc } = require('./diagnostics-ipc')
const { registerUpdateIpc, createUpdateIpcController } = require('./update-ipc')
const { registerDataRootIpc } = require('./data-root-ipc')
const { registerCaptureIpc } = require('./capture-ipc')
const { registerOcrIpc } = require('./ocr-ipc')
const { registerSearchIpc } = require('./search-ipc')
const { registerRecordingIpc } = require('./recording-ipc')
const { registerRecordingWorkbenchIpc, registerRecordingEditorIpc } = require('./recording-workbench-ipc')
const { registerSelectionIpc } = require('./selection-ipc')
const {
  registerExportFeatureIpc,
  registerRecordingExportFeatureIpc,
  registerRegionFeatureIpc
} = require('../services/feature-services-bootstrap')
const usageFeature = require('../services/usage-feature')

function createSettingsFacade(getSettingsService) {
  return {
    getSettings: () => getSettingsService().getSettings(),
    getPublicSettings: (settings) => getSettingsService().getPublicSettings(settings),
    updateSettings: (patch) => getSettingsService().updateSettings(patch),
    resetSettings: () => getSettingsService().resetSettings(),
    prepareProviderConnection: (provider) => getSettingsService().prepareProviderConnection(provider)
  }
}

function createHistoryFacade({ getHistoryService: resolveHistoryService, performanceMonitor, ocrIndexer = null, fs = require('node:fs') }) {
  // N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §5.2): the history
  // service is created inside initializeStore(), which runs long after this module has handed
  // its registrations to main.js. The background OCR indexer therefore attaches itself on the
  // first facade call instead of at construction: from then on a delete can cancel a pending
  // OCR write (HistoryService.attachOcrIndexer). The local name keeps every entry point below
  // reading `getHistoryService().method(...)` exactly as before.
  function getHistoryService() {
    const service = resolveHistoryService()
    if (service && ocrIndexer && typeof service.attachOcrIndexer === 'function') {
      service.attachOcrIndexer(ocrIndexer)
    }
    return service
  }

  return {
    list: (filter) => performanceMonitor.measure('history.list', () => getHistoryService().list(filter), {
      limit: Math.max(0, Number(filter?.limit) || 0),
      filtered: !!(filter?.query || filter?.source || filter?.tag)
    }),
    getThumbnail: (id) => getHistoryService().getThumbnail(id),
    listSources: () => performanceMonitor.measure('history.sources', () => getHistoryService().listSources()),
    stats: () => performanceMonitor.measure('history.stats', () => getHistoryService().stats()),
    getItem: (id) => getHistoryService().getItem(id),
    // N02: the tag editor's write path (routed from the history:list command envelope in
    // history-ipc.js, because the main-role IPC inventory is frozen).
    updateTags: (id, tags) => getHistoryService().updateTags(id, tags),
    // N02 follow-up: the tag dropdown's read (distinct tags with counts).
    listTags: () => getHistoryService().listTags(),
    // N02 follow-up: aggregate status read for the page-level OCR bar. The summary comes from the
    // memory index (no per-record disk probe); the queue snapshot is the indexer's own state, so
    // "queued vs running vs idle" is reported as the worker sees it.
    ocrState: () => performanceMonitor.measure('history.ocr-state', () => ({
      summary: getHistoryService().ocrSummary(),
      queue: ocrIndexer && typeof ocrIndexer.state === 'function' ? ocrIndexer.state() : null,
      enabled: !!(ocrIndexer && typeof ocrIndexer.enabled === 'function' && ocrIndexer.enabled())
    })),
    // N02 follow-up: explicit (re)index request from the history page. `ids` is the card-level
    // retry, `all` is the page-level "index the captures that have no text index yet" action.
    // Both are user-triggered, so the queue cap is intentionally bypassed; OCR itself stays
    // serial. Accepting a job does not write the store (pending is derived from the indexer's
    // in-memory job set), and the whole batch emits one history:changed notification.
    indexOcr: (options = {}) => {
      const service = getHistoryService()
      if (!ocrIndexer || typeof ocrIndexer.enqueue !== 'function') {
        return { accepted: 0, skipped: 0, disabled: true }
      }
      if (typeof ocrIndexer.enabled === 'function' && !ocrIndexer.enabled()) {
        return { accepted: 0, skipped: 0, disabled: true }
      }
      const requestedIds = Array.isArray(options?.ids) ? options.ids.slice(0, 500) : null
      const items = requestedIds
        ? requestedIds.map((id) => service.getItem(id)).filter(Boolean)
        : service.readHistory()
      const acceptedIds = []
      let skipped = 0
      for (const item of items) {
        if (!item || typeof item !== 'object' || !item.filePath || !fs.existsSync(item.filePath)) {
          skipped += 1
          continue
        }
        // The page action only targets captures that still have no text index. `empty` is a real
        // result (recognized, nothing to find), so it is not re-queued; failed/skipped records
        // are retryable, and a stale pending from a previous run reads as unindexed and is picked
        // up again. An explicit id request keeps the old behaviour of retrying what was asked.
        const status = typeof service.ocrStatusOf === 'function' ? service.ocrStatusOf(item) : ''
        const needsIndex = requestedIds !== null || status === '' || status === 'failed' || status === 'skipped'
        if (!needsIndex) {
          skipped += 1
          continue
        }
        const force = requestedIds !== null || status === 'failed' || status === 'skipped'
        if (ocrIndexer.enqueue(item, { force, allowOverflow: true, deferNotify: true })) acceptedIds.push(String(item.id))
        else skipped += 1
      }
      // One push for the batch: the renderer re-reads the list projection, where every accepted
      // id now reads as pending through the indexer's in-memory job set.
      if (acceptedIds.length && typeof service.notifyOcrQueue === 'function') service.notifyOcrQueue()
      return { accepted: acceptedIds.length, skipped, disabled: false }
    },
    delete: (id) => getHistoryService().delete(id),
    deleteMany: (ids) => getHistoryService().deleteMany(ids),
    exportMany: (ids, directory) => getHistoryService().exportMany(ids, directory),
    cleanup: () => getHistoryService().cleanup(),
    clear: () => getHistoryService().clear()
  }
}

function registerAllIpc({
  ipcMain,
  app,
  path,
  fs,
  shell,
  clipboard,
  nativeImage,
  dialog,
  BrowserWindow,
  log,
  performanceMonitor,
  windowActions,
  getSettings,
  getSettingsService,
  getHistoryService,
  getDiagnosticsService,
  getMainWindow,
  getPaths,
  getExportResultService,
  getRegionPreferences,
  getProxyBridge,
  getInstallType,
  resolveAiAssignment,
  aiClient,
  settingsEffects,
  preparePatch,
  assertWritable,
  shortcutService,
  dataRootDomain,
  captureDomain,
  longCaptureDomain,
  recognitionDomain,
  recordDomain,
  searchDomain,
  selectionDomain,
  ocrController,
  functionRouter,
  resolveUpdateService,
  // Injectable only so the registration test can keep the usage feature (worker, SQLite) out of
  // the process; production always uses the real installer.
  installUsageFeature = (deps) => usageFeature.install(deps)
}) {
  const settingsService = createSettingsFacade(getSettingsService)

  // N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §5.2): the single
  // background OCR indexer for screenshot history. It is built here because this is the first
  // assembly point that already owns all three collaborators: the settings resolver, the OCR
  // controller and the history-service resolver. Creating it does nothing until a capture is
  // saved; the capture domain receives it for the save path, and the history facade attaches it
  // to the service on first use (see createHistoryFacade).
  //
  // The controller is adapted to the indexer's narrow `recognize(buffer, options)` dependency
  // so the indexer module never imports Electron or the IPC layer.
  const historyOcrIndexer = createHistoryOcrIndexer({
    getSettings,
    getOcrService: () => ({
      recognize: (imageBuffer, options = {}) => {
        if (!ocrController || typeof ocrController.ocr !== 'function') throw new Error('OCR controller unavailable')
        return ocrController.ocr(null, { imageBuffer, ...options })
      }
    }),
    getHistoryService,
    nativeImage,
    log
  })
  if (captureDomain && typeof captureDomain.attachHistoryOcrIndexer === 'function') {
    captureDomain.attachHistoryOcrIndexer(historyOcrIndexer)
  }
  // N02: the app has no other quit hook for this queue (main.js is frozen by H05). 'will-quit'
  // is emitted before the OCR sidecar is stopped, and dispose() makes the queue and any
  // not-yet-started job bail out, so shutdown can never start a fresh sidecar or write a record.
  if (app && typeof app.once === 'function') {
    app.once('will-quit', () => historyOcrIndexer.dispose())
  }

  registerSettingsIpc({
    ipcMain,
    settingsService,
    assertWritable,
    // A03: trial-register a shortcut change before it is persisted.
    preparePatch: (patch) => preparePatch(patch),
    onSettingsUpdated: (patch, settings) => settingsEffects.applyUpdate(patch, settings),
    onSettingsReset: (settings) => settingsEffects.applyReset(settings),
    validateApiKey: async (input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return aiClient.validateApiKey(input)
      const provider = input.provider || input
      if (input.fetchModels === true) return aiClient.discoverProviderModels(provider)
      return aiClient.testProviderConnection(provider)
    },
    log
  })

  registerCodingPlanIpc({
    ipcMain,
    controller: createCodingPlanIpcController({
      settingsService,
      assertWritable,
      testProviderConnection: (provider, options) => aiClient.testProviderConnection(provider, options),
      appVersion: app.getVersion()
    })
  })

  registerShortcutIpc({
    ipcMain,
    shortcutService
  })

  registerAppIpc({
    ipcMain,
    controller: {
      openExternal: (value) => windowActions.openExternal(value),
      executeFunction: (name, payload) => functionRouter.executeFunction(name, payload),
      getInfo: () => ({
        version: app.getVersion(),
        platform: process.platform,
        installType: getInstallType(),
        dataDirectory: getPaths()?.root || app.getPath('userData')
      }),
      getDisplayDiagnostics: windowActions.getDisplayDiagnostics,
      chooseDirectory: windowActions.chooseDirectory,
      openDataDirectory: windowActions.openDataDirectory,
      openSaveDirectory: windowActions.openSaveDirectory,
      getProxyStatus: () => getProxyBridge().getStatus(),
      completeAi: (messages, options) => {
        const settings = getSettings()
        return aiClient.completeChat(
          resolveAiAssignment(settings, 'chat'),
          messages,
          { maxTokens: settings.ai.maxTokens, temperature: settings.ai.temperature, ...(options || {}) }
        )
      },
      translateText: (text, sourceLanguage, targetLanguage) => {
        const settings = getSettings()
        return aiClient.translateText(
          resolveAiAssignment(settings, 'translation'),
          text,
          sourceLanguage,
          targetLanguage || settings.ai.targetLanguage
        )
      }
    }
  })

  registerDiagnosticsIpc({
    ipcMain,
    controller: createDiagnosticsIpcController({
      getDiagnosticsService: () => getDiagnosticsService(),
      getMainWindow: () => getMainWindow(),
      dialog,
      app,
      path
    })
  })

  registerUpdateIpc({
    ipcMain,
    updateService: createUpdateIpcController({
      getUpdateService: () => resolveUpdateService()
    })
  })

  registerDataRootIpc({
    ipcMain,
    controller: dataRootDomain.createController()
  })

  registerHistoryIpc({
    ipcMain,
    historyService: createHistoryFacade({ getHistoryService, performanceMonitor, ocrIndexer: historyOcrIndexer }),
    copyItem: (item) => {
      if (!fs.existsSync(item.filePath)) return false
      const width = Number(item.width) || 0
      const height = Number(item.height) || 0
      if (Math.max(width, height) > 65535 || width * height > 80000000) return false
      clipboard.writeImage(nativeImage.createFromPath(item.filePath))
      return true
    },
    editItem: (item) => captureDomain.editHistoryDocument(item),
    openItem: async (item) => {
      if (!fs.existsSync(item.filePath)) return false
      const error = await shell.openPath(item.filePath)
      if (error) throw new Error(`无法使用默认应用打开截图：${error}`)
      return true
    },
    copyPathItem: (item) => {
      if (!fs.existsSync(item.filePath)) return false
      clipboard.writeText(path.resolve(item.filePath))
      return true
    },
    chooseExportDirectory: () => windowActions.pickDirectory({ title: '选择截图导出目录' }),
    BrowserWindow
  })

  registerCaptureIpc({
    ipcMain,
    controller: {
      ...captureDomain.createCaptureController(),
      ...longCaptureDomain.createLongCaptureController(),
      ...recognitionDomain.createRecognitionController()
    }
  })

  // Feature A/B IPC (plan §4.2/A2, §5.2/B2). Both wiring bodies live in
  // main/services/feature-services-bootstrap.js: this is assembly-only code (the ownership
  // rules and the display mapping are in the modules themselves).
  registerExportFeatureIpc({
    ipcMain,
    getExportResultService: () => getExportResultService(),
    BrowserWindow,
    log
  })
  registerRegionFeatureIpc({
    ipcMain,
    getRegionPreferences: () => getRegionPreferences(),
    limits: regionPresets.LIMITS,
    log
  })

  registerOcrIpc({
    ipcMain,
    controller: ocrController
  })

  registerSearchIpc({
    ipcMain,
    controller: searchDomain.createSearchController()
  })

  const recordController = recordDomain.createRecordingController()
  registerRecordingIpc({ ipcMain, controller: recordController })
  registerRecordingExportFeatureIpc({ ipcMain, controller: recordController })
  registerRecordingWorkbenchIpc({ ipcMain, controller: recordController })
  registerRecordingEditorIpc({ ipcMain, controller: recordController })

  registerSelectionIpc({
    ipcMain,
    controller: selectionDomain.createIpcController()
  })

  installUsageFeature({
    ipcMain,
    app,
    getPaths: () => getPaths(),
    getMainWindow: () => getMainWindow(),
    getSettings,
    log
  })

  // The tray/selection-toolbar window listeners stay in main.js by design (D26): they are the
  // only channels the main page's preload owns directly and they need the reclaimer's arm().
  return { recordController }
}

module.exports = { registerAllIpc, createHistoryFacade, createSettingsFacade }
