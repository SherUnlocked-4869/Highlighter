const { performance } = require('node:perf_hooks')
const mainModuleStartedAt = performance.now()
const {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  Tray,
  utilityProcess
} = require('electron')
const fs = require('fs')
const path = require('path')
const { prepareDataRoot, removeProvisionalRoot } = require('./main/services/data-root-bootstrap')
const { configureE2eEnvironment } = require('./main/services/e2e-bootstrap')
const { createDataPaths, ensureDataLayout, validateDataRoot, writeLocator } = require('./main/services/data-root')
const { relaunchApplication } = require('./main/services/relaunch-application')
const {
  createLegacySourcePaths,
  createManagedSourcePaths,
  migrateDataRoot,
  rollbackPendingMigration,
  verifyAndFinalizeMigration
} = require('./main/services/data-root-migration')
const { ManagedWriterCoordinator, quiesceAndMigrate } = require('./main/services/managed-writer-coordinator')
const { createAppLogger } = require('./main/services/app-logger')
const { PerformanceMonitor } = require('./main/services/performance-monitor')
const { DiagnosticsService } = require('./main/services/diagnostics-service')
const { SettingsService } = require('./main/services/settings-service')
const { registerSettingsIpc } = require('./main/ipc/settings-ipc')
const { HistoryService } = require('./main/services/history-service')
const { ensureDirectory: ensureDirectorySync } = require('./main/services/fs-utils')
const imageBufferUtils = require('./main/services/image-buffer')
const captureNaming = require('./main/services/capture-naming')
const { CAPTURE_PREFIX } = captureNaming
const { DEFAULT_CATEGORIES: SEARCH_DEFAULT_CATEGORIES } = require('./search/search-utils')
const { registerHistoryIpc } = require('./main/ipc/history-ipc')
const { ShortcutService } = require('./main/services/shortcut-service')
const { buildTrayMenuTemplate } = require('./main/services/tray-menu')
const { registerShortcutIpc } = require('./main/ipc/shortcut-ipc')
const { registerAppIpc } = require('./main/ipc/app-ipc')
const { registerDiagnosticsIpc } = require('./main/ipc/diagnostics-ipc')
const { registerUpdateIpc } = require('./main/ipc/update-ipc')
const { registerDataRootIpc } = require('./main/ipc/data-root-ipc')
const { registerCaptureIpc } = require('./main/ipc/capture-ipc')
const { registerRecordingIpc } = require('./main/ipc/recording-ipc')
const { registerSearchIpc } = require('./main/ipc/search-ipc')
const { SelectionHookService } = require('./main/services/selection-hook-service')
const { SelectionWindowManager } = require('./main/services/selection-window-manager')
const { ToolbarStreamSession } = require('./main/services/toolbar-stream-session')
const { UpdateService } = require('./main/services/update-service')
const { createSecureIpcMain } = require('./main/services/ipc-security')
const { createSecureWindow, isSafeExternalUrl } = require('./main/services/window-security')
const { name: applicationName } = require('./package.json')

const e2eContext = configureE2eEnvironment({ app })
const dataRootContext = prepareDataRoot({ app, applicationName })
const activePaths = dataRootContext.paths
const { execFile, spawn } = require('child_process')
const crypto = require('node:crypto')
const screenshotDesktop = require('screenshot-desktop')
const sharp = require('sharp')
const Store = require('electron-store')
const { OcrService } = require('./main/services/ocr-service')
const { EverythingService } = require('./main/services/everything-service')
const { createFakeEverythingQuery } = require('./main/services/e2e-fake-everything')
const { RecordingService } = require('./main/services/recording-service')
const { LongCaptureSession } = require('./main/services/long-capture-session')
const { findNativeDisplay, getNativeDisplayBounds, readPngSize } = require('./main/services/capture-geometry')
const { listNativeDisplays } = require('./main/services/native-display-list')
const { buildTableFromOcr } = require('./capture/recognition-utils')
const { createPinDomain } = require('./main/domains/pin')
const { createCaptureDomain } = require('./main/domains/capture')
const { createLongCaptureDomain } = require('./main/domains/long-capture')
const { createRecordDomain } = require('./main/domains/record')
const { createRecognitionDomain } = require('./main/domains/recognition')
const { createSearchDomain } = require('./main/domains/search')
const { createSettingsEffects } = require('./main/domains/settings-effects')
const aiClient = require('./main/services/ai')
const {
  ACTION_WINDOW_MIN_HEIGHT,
  ACTION_WINDOW_MIN_WIDTH,
  DEFAULT_SELECTION_TOOLBAR,
  DEFAULT_TOOLBAR_THINKING,
  TOOLBAR_ACTION_ORDER,
  buildOpenUrl,
  buildSearchUrl,
  getToolbarActionDefinition,
  getToolbarActionThinking,
  getToolbarWidth,
  getVisibleToolbarActionDefinitions,
  getVisibleToolbarActions,
  isAiToolbarAction,
  isLocalToolbarAction,
  normalizeSelectionToolbar,
  normalizeToolbarThinking
} = require('./toolbar/toolbar-utils')
const {
  createDefaultAssignments,
  createDefaultProviders,
  migrateAiSettings,
  normalizeAiSettings,
  resolveAiAssignment,
  resolveToolbarAiProvider
} = require('./main/services/ai-providers')

const DEFAULT_AI_PROVIDERS = createDefaultProviders()

const defaultHistoryDirectory = activePaths?.history || path.join(app.getPath('userData'), 'capture-history')
const logFile = activePaths ? path.join(activePaths.logs, 'app.log') : path.join(app.getPath('userData'), 'app.log')
const applicationSessionId = crypto.randomUUID()
const crashDumpsPath = activePaths
  ? path.join(activePaths.runtime, 'crash-dumps')
  : path.join(app.getPath('userData'), 'runtime', 'crash-dumps')
fs.mkdirSync(crashDumpsPath, { recursive: true })
app.setPath('crashDumps', crashDumpsPath)
crashReporter.start({
  productName: 'Highlighter',
  uploadToServer: false,
  globalExtra: { sessionId: applicationSessionId }
})

const DEFAULT_SETTINGS = {
  apiKey: '',
  providers: DEFAULT_AI_PROVIDERS,
  theme: 'system',
  mainColor: '#1677ff',
  borderRadius: 8,
  compact: false,
  skinPath: '',
  skinOpacity: 18,
  customCss: '',
  selectionToolbar: { ...DEFAULT_SELECTION_TOOLBAR, order: [...TOOLBAR_ACTION_ORDER, 'open'] },
  toolbarThinking: { ...DEFAULT_TOOLBAR_THINKING },
  plugins: { ocr: true, translation: true, ai: true, video: true },
  screenshot: {
    autoSaveOnCopy: false,
    fastSave: false,
    saveDirectory: '',
    historyDirectory: '',
    saveFormat: 'png',
    historyEnabled: true,
    historyLimit: 200,
    doubleClickCopy: true,
    selectionMask: 'rgba(0,0,0,.46)',
    showColorPicker: true,
    longCaptureDirection: 'vertical',
    watermark: { content: '', opacity: 80, color: '#ffffff', spacing: 30, fontSize: 24, rotation: 30, dateSuffix: false }
  },
  ocr: {
    modelProfile: 'ppocr-v4-ch',
    hotStart: true,
    modelWriteToMemory: false,
    detectAngle: false,
    minConfidence: 0.3,
    afterAction: 'none',
    idleTimeoutMs: 300000
  },
  fixedContent: {
    zoomWithMouse: true,
    autoResize: true,
    autoOcr: false,
    opacity: 1
  },
  record: {
    frameRate: 24,
    saveDirectory: ''
  },
  search: {
    matchPath: true,
    maxResults: 600,
    pageSize: 30,
    sortMode: 'modified-desc',
    useBundledEverything: true,
    categories: SEARCH_DEFAULT_CATEGORIES.map((category) => ({ ...category }))
  },
  ai: {
    schemaVersion: 2,
    maxTokens: 4096,
    temperature: 0.7,
    targetLanguage: '中文',
    assignments: createDefaultAssignments(DEFAULT_AI_PROVIDERS)
  },
  system: {
    autoStart: true,
    runLog: true,
    enableTray: true,
    gameMode: false,
    updateChannel: 'stable'
  },
  shortcuts: {
    screenshot: 'F1',
    screenshotDelay: '',
    screenshotFixed: '',
    screenshotOcr: '',
    screenshotTable: '',
    screenshotQr: '',
    screenshotOcrTranslate: '',
    screenshotCopy: '',
    screenshotFullScreen: '',
    screenshotFocusedWindow: '',
    screenshotLong: '',
    translationSelectText: '',
    chatSelectText: '',
    videoRecord: '',
    fullScreenDraw: '',
    toggleFixedContentVisibility: '',
    showOrHideMainWindow: '',
    openCaptureHistory: '',
    localSearch: 'Alt+F',
    explainClipboard: 'Ctrl+Alt+E'
  }
}

let store = null
let settingsService = null
let historyService = null
let diagnosticsService = null
let updateService = null
let sessionExitRecorded = false

function initializeStore() {
  if (store) return store
  const storeOptions = {
    defaults: {
      settings: DEFAULT_SETTINGS,
      captureHistory: []
    }
  }
  if (activePaths) storeOptions.cwd = activePaths.config
  store = new Store(storeOptions)
  settingsService = new SettingsService({
    store,
    safeStorage,
    defaults: DEFAULT_SETTINGS,
    migrateSettings: migrateAiSettings,
    normalizeSettings,
    onCredentialError: (error) => console.warn('Unable to access encrypted credentials:', error.message || String(error))
  })
  historyService = new HistoryService({
    store,
    nativeImage,
    sharp,
    getSettings,
    assertWritable: assertManagedDataWritable,
    defaultHistoryDirectory,
    makeCaptureName,
    onChanged: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('history:changed')
    },
    log
  })
  return store
}

let mainWindow = null
let firstMainWindowReady = true
let selectionWindowManager = null
let selectionHookService = null
const selectionPowerListeners = []
let tray = null
let ocrService = null
let everythingService = null
let recordingService = null
const fileIconCache = new Map()
const FILE_ICON_CACHE_LIMIT = 256
const managedRecordingWriters = new ManagedWriterCoordinator()
let dataRootMigrationInProgress = false
let isProcessing = false
const selectionEventDiagnostics = new Set()
let currentStreamController = null
let toolbarStreamSeq = 0
let pinDomain = null
let captureDomain = null
let longCaptureDomain = null
let recordDomain = null
let recognitionDomain = null
let searchDomain = null
let settingsEffects = null
const TOOLBAR_W = getToolbarWidth(getVisibleToolbarActions(DEFAULT_SELECTION_TOOLBAR))
const TOOLBAR_H = 40
const TOOLBAR_STREAM_IDLE_TIMEOUT_MS = 30000
const ACTION_WINDOW_SIZE_SAVE_DELAY_MS = 180
const isWin = process.platform === 'win32'
let nativeDisplayListPromise = null

function getOcrService() {
  if (dataRootMigrationInProgress) throw new Error('数据目录正在迁移，请稍候')
  if (ocrService) return ocrService
  const resourceRoot = app.isPackaged ? process.resourcesPath : __dirname
  const ocrSettings = getSettings().ocr || {}
  ocrService = new OcrService({
    sidecarPath: path.join(resourceRoot, 'native', 'ocr', 'HighlighterOcrSidecar.exe'),
    modelDir: path.join(resourceRoot, 'ocr', 'models', 'ppocr-v4-ch'),
    tempDir: activePaths?.ocrCache || path.join(app.getPath('temp'), 'Highlighter', 'ocr'),
    idleTimeoutMs: ocrSettings.idleTimeoutMs,
    log
  })
  return ocrService
}

async function recognizeWithPerformance(imageBuffer, options, source) {
  const token = performanceMonitor.begin('ocr.recognize', {
    source: String(source || 'unknown'),
    inputBytes: Buffer.isBuffer(imageBuffer) ? imageBuffer.length : Number(imageBuffer?.byteLength) || 0
  })
  try {
    const result = await getOcrService().recognize(imageBuffer, options)
    performanceMonitor.finish(token, {
      outcome: 'success',
      cached: result?.cached === true,
      engineDurationMs: Number(result?.durationMs) || 0
    })
    return result
  } catch (error) {
    performanceMonitor.finish(token, { outcome: 'error', errorName: error?.name || 'Error' })
    throw error
  }
}

function resolveFfmpegPath() {
  let candidate = ''
  try {
    candidate = require('ffmpeg-static')
  } catch (error) {
    log('Unable to resolve FFmpeg:', error)
  }
  if (!candidate || typeof candidate !== 'string') throw new Error('未找到 MP4 编码组件')
  return app.isPackaged ? candidate.replace('app.asar', 'app.asar.unpacked') : candidate
}

function getRecordingService() {
  if (dataRootMigrationInProgress) throw new Error('数据目录正在迁移，请稍候')
  if (recordingService) return recordingService
  recordingService = new RecordingService({
    tempRoot: activePaths?.recordingCache || path.join(app.getPath('userData'), 'temp', 'recordings'),
    ffmpegPath: resolveFfmpegPath(),
    log
  })
  return recordingService
}

function normalizeSettings(settings) {
  const normalized = normalizeAiSettings(settings)
  normalized.selectionToolbar = normalizeSelectionToolbar(normalized.selectionToolbar)
  normalized.toolbarThinking = normalizeToolbarThinking(normalized.toolbarThinking)
  const legacyDirectory = normalized.fixedContent?.autoSaveDirectory
  normalized.screenshot.historyDirectory = String(normalized.screenshot.historyDirectory || legacyDirectory || defaultHistoryDirectory).trim()
  if (!normalized.screenshot.historyDirectory) normalized.screenshot.historyDirectory = defaultHistoryDirectory
  normalized.system.updateChannel = normalized.system.updateChannel === 'beta' ? 'beta' : 'stable'
  normalized.system.gameMode = normalized.system.gameMode === true
  if (normalized.fixedContent && Object.hasOwn(normalized.fixedContent, 'autoSaveDirectory')) delete normalized.fixedContent.autoSaveDirectory
  return normalized
}

function getSettings() {
  return settingsService.getSettings()
}

function isGameModeEnabled(settings = null) {
  const currentSettings = settings || (settingsService ? getSettings() : null)
  return currentSettings?.system?.gameMode === true
}

function assertGameModeDisabled() {
  if (isGameModeEnabled()) {
    throw new Error('游戏模式已开启，请先通过托盘菜单关闭游戏模式')
  }
}

function persistSettings(settings, options) {
  return settingsService.persistSettings(settings, options)
}

function assertManagedDataWritable() {
  if (dataRootMigrationInProgress) throw new Error('数据目录正在迁移，请稍候')
}

const writeAppLog = createAppLogger({
  filePath: logFile,
  isEnabled: () => !dataRootMigrationInProgress && !!store && getSettings().system.runLog,
  sessionId: applicationSessionId,
  version: app.getVersion(),
  consoleLike: app.isPackaged ? null : console
})

const performanceMonitor = new PerformanceMonitor({
  logger: writeAppLog,
  getAppMetrics: () => app.getAppMetrics()
})

function log(...args) {
  writeAppLog(...args)
}

function collectDiagnosticSensitiveValues() {
  if (!store) return []
  const settings = getSettings()
  const values = [settings.apiKey]
  function visit(value, keyPath = '') {
    if (typeof value === 'string') {
      if (/(api[-_]?key|authorization|password|secret|token|prompt)/i.test(keyPath)) values.push(value)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      visit(nestedValue, keyPath ? `${keyPath}.${nestedKey}` : nestedKey)
    }
  }
  visit(settings)
  return values.filter(Boolean)
}

function getInstallType() {
  if (!app.isPackaged) return 'development'
  if (dataRootContext.portable) return 'portable'
  if (path.basename(path.dirname(process.execPath)).toLowerCase() === 'win-unpacked') return 'unpacked'
  return 'nsis'
}

function getUpdateInstallReadiness() {
  if (dataRootMigrationInProgress) return { ok: false, reason: '数据目录正在迁移，请完成后重试。' }
  if (captureDomain?.isTaskActive()) return { ok: false, reason: '截图任务仍在进行，请完成或关闭后重试。' }
  if (longCaptureDomain?.isTaskActive()) return { ok: false, reason: '长截图任务仍在进行，请完成或关闭后重试。' }
  if (recordDomain?.isTaskActive()) return { ok: false, reason: '录屏任务仍在进行，请完成或关闭后重试。' }
  if (ocrService?.inFlight?.size) return { ok: false, reason: 'OCR 正在识别，请完成后重试。' }
  if (managedRecordingWriters.inFlight.size) return { ok: false, reason: '媒体文件仍在写入，请完成后重试。' }
  if (isProcessing) return { ok: false, reason: '划词处理任务仍在进行，请完成后重试。' }
  return { ok: true }
}

function initializeUpdateService() {
  if (updateService) return updateService
  const installType = getInstallType()
  let updater = null
  if (installType === 'nsis') {
    try { updater = require('electron-updater').autoUpdater } catch (error) {
      log('Unable to initialize update client:', error.message || String(error))
    }
  }
  updateService = new UpdateService({
    updater,
    currentVersion: app.getVersion(),
    installType,
    channel: getSettings().system.updateChannel,
    openDownloadPage: () => shell.openExternal('https://github.com/SherUnlocked-4869/Highlighter/releases'),
    canInstall: async () => getUpdateInstallReadiness(),
    prepareInstall: async () => {
      await managedRecordingWriters.waitForIdle()
      const readiness = getUpdateInstallReadiness()
      if (!readiness.ok) throw new Error(readiness.reason)
      markSessionClean('update-install')
    },
    notify: (snapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', snapshot)
    },
    log
  })
  return updateService
}

function resolveUpdateService() {
  return updateService || initializeUpdateService()
}

function deferUpdateServiceStart() {
  const timer = setTimeout(() => {
    try { resolveUpdateService().start() } catch (error) { log('Update service start failed:', error?.message || String(error)) }
  }, 2000)
  timer.unref?.()
}

function getDiagnosticComponents() {
  const resourceRoot = app.isPackaged ? process.resourcesPath : __dirname
  let ffmpegPath = ''
  let ffmpegVersion = ''
  try { ffmpegPath = resolveFfmpegPath() } catch {}
  try { ffmpegVersion = require('ffmpeg-static/package.json').version } catch {}
  return [
    { name: 'SmartSelect', path: path.join(resourceRoot, 'native', 'smart-select', 'SmartSelect.exe'), version: app.getVersion() },
    { name: 'OCR sidecar', path: path.join(resourceRoot, 'native', 'ocr', 'HighlighterOcrSidecar.exe'), version: app.getVersion() },
    { name: 'FFmpeg', path: ffmpegPath, version: ffmpegVersion }
  ]
}

function initializeDiagnostics() {
  if (diagnosticsService) return diagnosticsService
  const dataRoot = activePaths?.root || app.getPath('userData')
  diagnosticsService = new DiagnosticsService({
    sessionId: applicationSessionId,
    version: app.getVersion(),
    paths: {
      dataRoot,
      logs: activePaths?.logs || path.dirname(logFile),
      logFile,
      runtime: activePaths?.runtime || path.join(dataRoot, 'runtime'),
      crashDumps: crashDumpsPath,
      userProfile: app.getPath('home'),
      temp: app.getPath('temp'),
      resources: process.resourcesPath,
      appRoot: app.getAppPath()
    },
    screen,
    getAppInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      installType: getInstallType()
    }),
    getComponents: getDiagnosticComponents,
    getSensitiveValues: collectDiagnosticSensitiveValues,
    getUpdateStatus: () => updateService?.getStatus() || { status: 'not-configured', error: null },
    log
  })
  const session = diagnosticsService.startSession()
  writeAppLog.event('session-start', {
    previousExit: session.previousExit,
    installType: getInstallType(),
    crashUploadEnabled: false
  })
  return diagnosticsService
}

function markSessionClean(exitType = 'clean') {
  if (!diagnosticsService || sessionExitRecorded) return false
  try {
    writeAppLog.event('session-end', { exitType })
    sessionExitRecorded = diagnosticsService.markClean(exitType)
  } catch (error) {
    log('Unable to mark diagnostics session clean:', error.message || String(error))
    return false
  }
  return sessionExitRecorded
}

function authorizeIpcRole(role, win) {
  if (role === 'main') return win === mainWindow
  if (role === 'toolbar') return selectionWindowManager?.ownsToolbarWindow(win) === true
  if (role === 'action') return selectionWindowManager?.ownsActionWindow(win) === true
  if (role === 'capture') return captureDomain?.ownsWindow(win) === true
  if (role === 'long-capture') return longCaptureDomain?.ownsControllerWindow(win) === true
  if (role === 'long-overlay') return longCaptureDomain?.ownsOverlayWindow(win) === true
  if (role === 'pin') return pinDomain?.ownsWindow(win) === true
  if (role === 'recognition') return recognitionDomain?.ownsWindow(win) === true
  if (role === 'search') return searchDomain?.ownsWindow(win) === true
  if (role === 'record') return recordDomain?.ownsControlWindow(win) === true
  if (role === 'record-frame') return recordDomain?.ownsFrameWindow(win) === true
  return false
}

const secureIpcMain = createSecureIpcMain({
  ipcMain,
  BrowserWindow,
  rootDirectory: __dirname,
  authorizeRole: authorizeIpcRole,
  onBlocked: ({ channel, reason, role, win }) => {
    log('IPC sender blocked:', { channel, reason, role: role || '' })
    // A superseded capture window can never receive its init payload, so close
    // it right away instead of letting it linger invisibly until the watchdog.
    if (channel === 'capture:ready' && reason === 'window-owner-mismatch' && win && !win.isDestroyed() && !captureDomain?.ownsWindow(win)) {
      win.close()
    }
  }
})

const shortcutService = new ShortcutService({
  globalShortcut,
  executeFunction: (name) => executeFunction(name),
  log
})

function ensureDirectory(directory) {
  return ensureDirectorySync(directory)
}

function imageDataToBuffer(value) {
  return imageBufferUtils.imageDataToBuffer(value)
}

function dataUrlToBuffer(dataUrl) {
  return imageBufferUtils.dataUrlToBuffer(dataUrl)
}

function bufferToDataUrl(value) {
  return imageBufferUtils.bufferToDataUrl(value)
}

function makeCaptureName(prefix = CAPTURE_PREFIX) {
  return captureNaming.makeCaptureName(prefix)
}

function persistHistory(imageData, meta = {}) {
  return typeof imageData === 'string'
    ? historyService.persistDataUrl(imageData, meta)
    : historyService.persistBuffer(imageDataToBuffer(imageData), meta)
}

async function persistHistoryFile(sourcePath, meta = {}) {
  return historyService.persistFile(sourcePath, meta)
}

function createLocalWindow(pagePath, options) {
  return createSecureWindow({
    BrowserWindow,
    pagePath,
    options,
    onBlocked: ({ url, reason }) => log(`Window ${reason}:`, url)
  })
}

pinDomain = createPinDomain({
  BrowserWindow,
  clipboard,
  nativeImage,
  screen,
  Menu,
  path,
  rootDirectory: __dirname,
  createLocalWindow,
  getSettings,
  saveDataUrl: (dataUrl) => saveDataUrl(dataUrl),
  createRecognitionWindow: (...args) => recognitionDomain.createRecognitionWindow(...args),
  getCreateCaptureWindow: () => (...args) => captureDomain.createCaptureWindow(...args),
  dataUrlToBuffer,
  bufferToDataUrl,
  log,
  ipcMain: secureIpcMain
})

captureDomain = createCaptureDomain({
  app,
  spawn,
  fs,
  path,
  screen,
  BrowserWindow,
  nativeImage,
  clipboard,
  dialog,
  performance,
  rootDirectory: __dirname,
  isWin,
  createLocalWindow,
  getSettings,
  log,
  assertGameModeDisabled,
  getDisplayCapture,
  pinDomain,
  createRecordWindow: (...args) => recordDomain.createRecordWindow(...args),
  createLongCaptureFromSelection: (...args) => longCaptureDomain.createLongCaptureFromSelection(...args),
  createRecognitionWindow: (...args) => recognitionDomain.createRecognitionWindow(...args),
  persistHistory: (...args) => persistHistory(...args),
  saveImageBuffer: (...args) => saveImageBuffer(...args),
  imageDataToBuffer,
  dataUrlToBuffer,
  bufferToDataUrl,
  performanceMonitor
})

longCaptureDomain = createLongCaptureDomain({
  app,
  desktopCapturer,
  path,
  screen,
  dialog,
  clipboard,
  nativeImage,
  fs,
  rootDirectory: __dirname,
  createLocalWindow,
  getSettings,
  log,
  assertManagedDataWritable,
  isMigrationInProgress: () => dataRootMigrationInProgress,
  LongCaptureSession,
  getLongCaptureTempRoot: () => activePaths?.longCaptureCache || app.getPath('temp'),
  captureDomain,
  pinDomain,
  persistHistoryFile: (...args) => persistHistoryFile(...args),
  ensureDirectory,
  makeCaptureName,
  LONG_CAPTURE_PREFIX: captureNaming.LONG_CAPTURE_PREFIX,
  updateSettings: (patch) => settingsService.updateSettings(patch)
})

recordDomain = createRecordDomain({
  app,
  desktopCapturer,
  path,
  screen,
  dialog,
  BrowserWindow,
  rootDirectory: __dirname,
  createLocalWindow,
  getSettings,
  log,
  assertGameModeDisabled,
  assertManagedDataWritable,
  getRecordingService: () => getRecordingService(),
  peekRecordingService: () => recordingService,
  managedRecordingWriters,
  makeCaptureName,
  VIDEO_CAPTURE_PREFIX: captureNaming.VIDEO_CAPTURE_PREFIX,
  performanceMonitor
})

recognitionDomain = createRecognitionDomain({
  path,
  rootDirectory: __dirname,
  BrowserWindow,
  clipboard,
  createLocalWindow,
  getSettings,
  dataUrlToBuffer,
  recognizeWithPerformance: (...args) => recognizeWithPerformance(...args),
  buildTableFromOcr
})

searchDomain = createSearchDomain({
  path,
  rootDirectory: __dirname,
  screen,
  clipboard,
  nativeTheme,
  shell,
  BrowserWindow,
  createLocalWindow,
  getSettings,
  log,
  assertGameModeDisabled,
  isGameModeEnabled,
  getEverythingService: () => getEverythingService(),
  positionAutomationWindow,
  getSearchFileIcon
})

settingsEffects = createSettingsEffects({
  app,
  registerShortcuts,
  applyGameModeState,
  createTrayIcon,
  getUpdateService: () => updateService,
  ocrServiceRef: {
    get: () => ocrService,
    set: (value) => { ocrService = value }
  },
  getOcrService,
  broadcastActionAppearance: (...args) => broadcastActionAppearance(...args),
  searchDomain,
  selectionHookServiceRef: {
    get: () => selectionHookService
  },
  log
})

function positionAutomationWindow(win) {
  if (!e2eContext.enabled || !win || win.isDestroyed()) return false
  const primary = screen.getPrimaryDisplay()
  const secondary = screen.getAllDisplays().find((display) => display.id !== primary.id)
  if (!secondary) return false
  const [width, height] = win.getSize()
  const area = secondary.workArea
  win.setPosition(
    Math.round(area.x + Math.max(0, (area.width - width) / 2)),
    Math.round(area.y + Math.max(0, (area.height - height) / 2)),
    false
  )
  return true
}

function createMainWindow(route = 'home') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const startedAt = performance.now()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('app:navigate', route)
    performanceMonitor.record('main-window.reopen', performance.now() - startedAt, { route })
    return mainWindow
  }
  const readyToken = performanceMonitor.begin('main-window.ready', {
    route,
    firstWindow: firstMainWindowReady
  })
  const pagePath = path.join(__dirname, 'config', 'config.html')
  const win = createLocalWindow(pagePath, {
    width: 1120,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    frame: false,
    title: 'Highlighter',
    backgroundColor: '#f5f5f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  })
  mainWindow = win
  win.loadFile(pagePath)
  win.once('ready-to-show', () => {
    if (mainWindow !== win || win.isDestroyed()) return
    positionAutomationWindow(win)
    win.show()
    performanceMonitor.finish(readyToken, {
      moduleElapsedMs: Math.round((performance.now() - mainModuleStartedAt) * 100) / 100
    })
    performanceMonitor.snapshot(firstMainWindowReady ? 'startup-main-window' : 'main-window-recreated')
    firstMainWindowReady = false
  })
  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.send('app:navigate', route)
  })
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
  return win
}

selectionWindowManager = new SelectionWindowManager({
  createWindow: createLocalWindow,
  rootDirectory: __dirname,
  isWindows: isWin,
  nativeTheme,
  getSettings,
  updateSettings: (patch) => settingsService.updateSettings(patch),
  toolbarWidth: TOOLBAR_W,
  toolbarHeight: TOOLBAR_H,
  actionMinWidth: ACTION_WINDOW_MIN_WIDTH,
  actionMinHeight: ACTION_WINDOW_MIN_HEIGHT,
  sizeSaveDelayMs: ACTION_WINDOW_SIZE_SAVE_DELAY_MS,
  onActionWindowClosed: (win, { wasPinned }) => {
    if (wasPinned) pinDomain.releasePinnedSlot()
    if (currentStreamController?.win === win) cancelToolbarStream(currentStreamController, 'window-closed')
  },
  onActionWindowBlur: (win) => {
    if (currentStreamController?.win === win) cancelToolbarStream(currentStreamController, 'window-hidden')
  },
  log
})

function createToolbarWindow() {
  return selectionWindowManager.createToolbarWindow()
}

function getOrCreateActionWindow() {
  return selectionWindowManager.getOrCreateActionWindow()
}

function queueActionMessage(win, channel, payload) {
  selectionWindowManager.queueActionMessage(win, channel, payload)
}

function getActionAppearance(settings = getSettings()) {
  return selectionWindowManager.getAppearance(settings)
}

function broadcastActionAppearance(settings = getSettings()) {
  selectionWindowManager.broadcastAppearance(settings)
}

function createTrayIcon() {
  const settings = getSettings()
  if (!settings.system.enableTray) {
    if (tray) { tray.destroy(); tray = null }
    return
  }
  if (!tray) {
    let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))
    if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty()
    tray = new Tray(icon.resize({ width: 24, height: 24 }))
    tray.on('click', () => {
      if (isGameModeEnabled()) return
      executeFunction('screenshot').catch((error) => log('Tray action failed:', error.message))
    })
    tray.on('double-click', () => createMainWindow('home'))
  }
  const gameMode = isGameModeEnabled(settings)
  tray.setToolTip(gameMode ? 'Highlighter（游戏模式）' : 'Highlighter')
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({
    gameMode,
    screenshotAccelerator: settings.shortcuts.screenshot,
    executeFunction: (name) => executeFunction(name).catch((error) => log('Tray action failed:', name, error.message)),
    setGameModeEnabled: (enabled) => {
      try {
        setGameModeEnabled(enabled)
      } catch (error) {
        log('Game mode update failed:', error.message)
        createTrayIcon()
      }
    },
    openHistory: () => createMainWindow('history'),
    openMainWindow: () => createMainWindow('home'),
    quit: () => app.quit()
  })))
}

function initSelectionHook() {
  if (!selectionHookService) {
    selectionHookService = new SelectionHookService({
      createHost: SelectionHookService.createUtilityProcessHostFactory({
        utilityProcess,
        hostPath: SelectionHookService.defaultHostPath()
      }),
      handlers: {
        textSelection: handleTextSelection,
        mouseDown: (data) => {
          const toolbarWindow = selectionWindowManager.getToolbarWindow()
          if (!toolbarWindow || !toolbarWindow.isVisible()) return
          const bounds = toolbarWindow.getBounds()
          let point = { x: data.x, y: data.y }
          if (isWin) point = screen.screenToDipPoint(point)
          const inside = point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height
          if (!inside) hideToolbar()
        },
        keyDown: hideToolbar,
        mouseWheel: hideToolbar,
        status: (status) => log('Selection hook status:', status)
      },
      startOptions: {
        debug: false,
        enableClipboard: getSettings().selectionToolbar.clipboardFallback
      },
      log
    })
  }
  if (isGameModeEnabled()) return selectionHookService.suspend('game-mode')
  return selectionHookService.start('startup')
}

function registerSelectionPowerEvents() {
  if (selectionPowerListeners.length) return
  const bindings = [
    ['suspend', () => selectionHookService?.notePowerEvent('sleep', 'system-suspend')],
    ['lock-screen', () => selectionHookService?.notePowerEvent('sleep', 'lock-screen')],
    ['resume', () => {
      if (!isGameModeEnabled()) selectionHookService?.notePowerEvent('wake', 'system-resume')
    }],
    ['unlock-screen', () => {
      if (!isGameModeEnabled()) selectionHookService?.notePowerEvent('wake', 'unlock-screen')
    }]
  ]
  for (const [eventName, listener] of bindings) {
    powerMonitor.on(eventName, listener)
    selectionPowerListeners.push([eventName, listener])
  }
}

function disposeSelectionHook() {
  for (const [eventName, listener] of selectionPowerListeners.splice(0)) {
    powerMonitor.removeListener(eventName, listener)
  }
  selectionHookService?.dispose()
  selectionHookService = null
}

function shouldFilterApp(programName) {
  const value = String(programName || '').toLowerCase()
  return value.includes('highlighter') || value.includes('划词助手') || value.includes('huacizhushou')
}

function validCoord(point) {
  return point && point.x > -90000 && point.x < 90000 && point.y > -90000 && point.y < 90000
}

function getRefPointAndOrientation(data) {
  const cursor = screen.getCursorScreenPoint()
  let refX = cursor.x
  let refY = cursor.y
  let orientation = 'bottomMiddle'
  const level = data.posLevel || 0
  if (level === 1) {
    if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y + 16 }
  } else if (level === 2) {
    if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y }
    if (validCoord(data.startBottom) && validCoord(data.endBottom)) {
      const delta = data.endBottom.y - data.startBottom.y
      orientation = delta > 10 ? 'bottomLeft' : delta < -10 ? 'topRight' : 'bottomRight'
    }
  } else if (level > 2) {
    if (validCoord(data.endBottom)) { refX = data.endBottom.x; refY = data.endBottom.y + 4 }
    else if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y }
    if (validCoord(data.startBottom) && validCoord(data.endBottom)) {
      const delta = data.endBottom.y - data.startBottom.y
      orientation = delta > 0 ? 'bottomLeft' : delta < 0 ? 'topRight' : 'bottomRight'
    }
  }
  if (isWin) {
    const point = screen.screenToDipPoint({ x: refX, y: refY })
    refX = point.x
    refY = point.y
  }
  return { refPoint: { x: refX, y: refY }, orientation }
}

function calculateToolbarPosition(refPoint, orientation, toolbarWidth = TOOLBAR_W) {
  let x = refPoint.x - toolbarWidth / 2
  let y = refPoint.y
  if (orientation === 'topRight') { x = refPoint.x; y = refPoint.y - TOOLBAR_H }
  if (orientation === 'bottomLeft') x = refPoint.x - toolbarWidth
  if (orientation === 'bottomRight') x = refPoint.x
  const workArea = screen.getDisplayNearestPoint(refPoint).workArea
  x = Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - toolbarWidth)))
  y = Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - TOOLBAR_H)))
  return { x, y }
}

function logSelectionDiagnosticOnce(reason, data = {}) {
  if (selectionEventDiagnostics.has(reason)) return
  selectionEventDiagnostics.add(reason)
  const programName = path.basename(String(data.programName || '')).slice(0, 128)
  const textLength = typeof data.text === 'string' ? data.text.length : 0
  log('Selection event diagnostic:', { reason, programName, textLength })
}

function handleTextSelection(data) {
  if (isGameModeEnabled()) { logSelectionDiagnosticOnce('game-mode', data); return }
  if (isProcessing) { logSelectionDiagnosticOnce('busy', data); return }
  if (!data?.text) { logSelectionDiagnosticOnce('missing-text', data); return }
  if (shouldFilterApp(data.programName)) { logSelectionDiagnosticOnce('filtered-app', data); return }
  const text = data.text.trim()
  if (!text) { logSelectionDiagnosticOnce('empty-text', data); return }
  if (text.length > 10000) { logSelectionDiagnosticOnce('text-too-long', data); return }
  const actions = getVisibleToolbarActionDefinitions(getSettings().selectionToolbar)
  if (!actions.length) { logSelectionDiagnosticOnce('no-actions', data); hideToolbar(); return }
  const toolbarWidth = getToolbarWidth(actions)
  const result = getRefPointAndOrientation(data)
  const position = calculateToolbarPosition(result.refPoint, result.orientation, toolbarWidth)
  selectionWindowManager.showToolbarSelection({ text, actions, position, width: toolbarWidth })
  logSelectionDiagnosticOnce('shown', data)
}

function hideToolbar() {
  selectionWindowManager.hideToolbar()
}

function finishToolbarStream(controller) {
  return controller?.finish() || false
}

function cancelToolbarStream(controller, reason = 'cancelled', { notify = false } = {}) {
  return controller?.cancel(reason, { notify }) || false
}

function armToolbarStreamTimeout(controller) {
  controller?.armTimeout()
}

function createToolbarStreamController(win) {
  const controller = new ToolbarStreamSession({
    win,
    timeoutMs: TOOLBAR_STREAM_IDLE_TIMEOUT_MS,
    onFinish: (finishedController) => {
      if (currentStreamController !== finishedController) return
      currentStreamController = null
      isProcessing = false
    }
  })
  toolbarStreamSeq += 1
  controller.streamId = toolbarStreamSeq
  currentStreamController = controller
  isProcessing = true
  armToolbarStreamTimeout(controller)
  return controller
}

function isCurrentToolbarStreamSender(event) {
  return !!currentStreamController?.matchesSender(event.sender)
}

function isStaleToolbarStreamSignal(event, streamId) {
  if (streamId === undefined || streamId === null) return false
  return currentStreamController?.streamId !== streamId
}

async function streamToWindow(win, action, text, controller) {
  const { createToolbarActionStream } = require('./main/services/ai-feature-router')
  const currentSettings = getSettings()
  const requestOptions = { signal: controller.signal }
  requestOptions.thinking = getToolbarActionThinking(currentSettings.selectionToolbar, currentSettings.toolbarThinking, action.id)
  try {
    const stream = await createToolbarActionStream({ settings: currentSettings, action, text, requestOptions })
    armToolbarStreamTimeout(controller)
    for await (const chunk of stream) {
      if (controller.cancelled || win.isDestroyed()) return
      armToolbarStreamTimeout(controller)
      const delta = chunk.choices?.[0]?.delta
      if (delta?.reasoning_content) queueActionMessage(win, 'stream:reasoning', { content: delta.reasoning_content })
      if (delta?.content) queueActionMessage(win, 'stream:data', { content: delta.content })
    }
    if (!controller.cancelled && !win.isDestroyed()) queueActionMessage(win, 'stream:done')
  } catch (error) {
    if (!controller.cancelled && !win.isDestroyed()) {
      queueActionMessage(win, 'stream:error', { error: error.message || '请求失败' })
    }
  } finally {
    finishToolbarStream(controller)
  }
}

function isBlankCapture(image) {
  if (!image || image.isEmpty()) return true
  const size = image.getSize()
  const sample = image.resize({
    width: Math.max(1, Math.min(32, size.width)),
    height: Math.max(1, Math.min(32, size.height)),
    quality: 'good'
  }).toBitmap()
  if (!sample.length) return true
  for (let index = 0; index + 2 < sample.length; index += 4) {
    if (sample[index] > 2 || sample[index + 1] > 2 || sample[index + 2] > 2) return false
  }
  return true
}

async function getDesktopCapture(display, scaleFactor) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(1, Math.round(display.bounds.width * scaleFactor)),
        height: Math.max(1, Math.round(display.bounds.height * scaleFactor))
      }
    })
    const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0]
    if (source && !source.thumbnail.isEmpty() && !isBlankCapture(source.thumbnail)) {
      return { imageBuffer: source.thumbnail.toPNG(), sourceId: source.id, scaleFactor }
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('屏幕捕获连续返回空白画面')
}

const NATIVE_CAPTURE_TIMEOUT_MS = 5000

async function getDisplayCapture(display) {
  const scaleFactor = display.scaleFactor || 1
  if (isWin) {
    try {
      if (!nativeDisplayListPromise) nativeDisplayListPromise = listNativeDisplays(screenshotDesktop.parseDisplaysOutput)
      const nativeDisplays = await nativeDisplayListPromise
      const physicalBounds = screen.dipToScreenRect(null, display.bounds)
      const nativeDisplay = findNativeDisplay(
        nativeDisplays,
        physicalBounds,
        Math.max(1, Math.ceil(scaleFactor))
      )
      if (nativeDisplay) {
        // The capture helper is an external cmd.exe pipeline with no timeout of
        // its own; without this guard a hung spawn would wedge window creation.
        const buffer = await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`原生抓屏超时（${NATIVE_CAPTURE_TIMEOUT_MS}ms）`)),
            NATIVE_CAPTURE_TIMEOUT_MS
          )
          screenshotDesktop({ format: 'png', screen: nativeDisplay.id }).then(
            (result) => { clearTimeout(timer); resolve(result) },
            (error) => { clearTimeout(timer); reject(error) }
          )
        })
        const nativeBounds = getNativeDisplayBounds(nativeDisplay)
        // Read the dimensions straight out of the PNG IHDR chunk so a
        // wrong-sized capture fails without decoding a full-screen bitmap.
        const pngSize = readPngSize(buffer)
        if (!pngSize || pngSize.width !== nativeBounds.width || pngSize.height !== nativeBounds.height) {
          throw new Error(`原生抓屏尺寸异常：${pngSize ? `${pngSize.width}x${pngSize.height}` : '未知'}`)
        }
        if (isBlankCapture(nativeImage.createFromBuffer(buffer))) throw new Error('原生抓屏返回空白画面')
        return {
          imageBuffer: buffer,
          sourceId: `native:${nativeDisplay.id}`,
          scaleFactor
        }
      }
    } catch (error) {
      nativeDisplayListPromise = null
      log('Native capture fallback:', error.message)
    }
  }
  return getDesktopCapture(display, scaleFactor)
}

async function captureFocusedWindow() {
  let title = ''
  if (isWin) {
    title = await new Promise((resolve) => {
      const script = `$sig='[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);'; Add-Type -MemberDefinition $sig -Name Win32 -Namespace Native; $h=[Native.Win32]::GetForegroundWindow(); $b=New-Object System.Text.StringBuilder 1024; [void][Native.Win32]::GetWindowText($h,$b,$b.Capacity); $b.ToString()`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4000 }, (_error, stdout) => resolve(String(stdout || '').trim()))
    })
  }
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1080 }, fetchWindowIcons: true })
  const source = sources.find((item) => title && (item.name === title || title.includes(item.name) || item.name.includes(title))) || sources.find((item) => !shouldFilterApp(item.name))
  if (!source || source.thumbnail.isEmpty()) throw new Error('无法捕获焦点窗口')
  return source.thumbnail.toDataURL()
}

async function saveImageBuffer(imageBuffer, options = {}) {
  const settings = getSettings()
  const preferredDirectory = options.directory || settings.screenshot.saveDirectory
  let filePath
  if (options.fast && preferredDirectory) {
    ensureDirectory(preferredDirectory)
    filePath = path.join(preferredDirectory, makeCaptureName())
  } else {
    const result = await dialog.showSaveDialog({
      title: '保存截图',
      defaultPath: path.join(preferredDirectory || app.getPath('pictures'), makeCaptureName()),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    })
    if (result.canceled || !result.filePath) return null
    filePath = result.filePath
  }
  await fs.promises.writeFile(filePath, imageDataToBuffer(imageBuffer))
  return filePath
}

async function saveDataUrl(dataUrl, options = {}) {
  return saveImageBuffer(dataUrlToBuffer(dataUrl), options)
}

function getEverythingService() {
  if (dataRootMigrationInProgress) throw new Error('数据目录正在迁移，请稍候')
  if (everythingService) return everythingService
  const resourceRoot = app.isPackaged ? process.resourcesPath : __dirname
  const sidecarPath = app.isPackaged
    ? path.join(resourceRoot, 'native', 'everything-search', 'HighlighterEverything.exe')
    : path.join(resourceRoot, 'native', 'everything-search', 'bin', 'HighlighterEverything.exe')
  const bundledEverythingPath = path.join(resourceRoot, 'native', 'everything', 'Everything.exe')
  everythingService = new EverythingService({
    sidecarPath,
    bundledEverythingPath,
    runtimeEverythingDir: path.join(activePaths?.runtime || path.join(app.getPath('userData'), 'runtime'), 'everything'),
    getUseBundledEverything: () => getSettings().search.useBundledEverything !== false,
    onStatusChange: (status) => {
      searchDomain?.notifyStatusChanged(status)
    },
    ...(e2eContext.fakeEverything ? { e2eQuery: createFakeEverythingQuery() } : {}),
    log
  })
  return everythingService
}

async function getSearchFileIcon(samplePath) {
  const value = String(samplePath || '').trim()
  if (!value || value.includes('\0') || !path.isAbsolute(value)) return null
  const extension = path.extname(value).toLowerCase()
  if (!extension) return null
  if (fileIconCache.has(extension)) return fileIconCache.get(extension)
  let dataUrl = null
  try {
    const icon = await app.getFileIcon(value, { size: 'small' })
    if (icon && !icon.isEmpty()) dataUrl = icon.toDataURL()
  } catch (error) {
    log('File icon lookup failed:', error.message)
  }
  if (fileIconCache.size >= FILE_ICON_CACHE_LIMIT) {
    fileIconCache.delete(fileIconCache.keys().next().value)
  }
  fileIconCache.set(extension, dataUrl)
  return dataUrl
}


async function openToolbarAiAction(action, text) {
  const toolbarConfig = getSettings().selectionToolbar
  const actionDefinition = getToolbarActionDefinition(toolbarConfig, action)
  if (!actionDefinition) return false
  const aiRuntime = resolveToolbarAiProvider(getSettings(), action)
  if (!aiRuntime?.apiKey) {
    createMainWindow('models')
    return false
  }
  const win = getOrCreateActionWindow()
  const controller = createToolbarStreamController(win)
  selectionWindowManager.positionActionWindow(win, screen)
  queueActionMessage(win, 'action:start', {
    type: actionDefinition.id,
    label: actionDefinition.label,
    icon: actionDefinition.icon,
    text,
    streamId: controller.streamId,
    appearance: getActionAppearance()
  })
  streamToWindow(win, actionDefinition, text, controller)
  win.show()
  win.focus()
  return true
}

async function executeFunction(name, payload = {}) {
  assertGameModeDisabled()
  switch (name) {
    case 'screenshot': await captureDomain.createCaptureWindow({ mode: 'region', source: 'region' }); return true
    case 'screenshotDelay': {
      const seconds = Math.max(0, Number(payload.seconds ?? 3))
      setTimeout(() => captureDomain.createCaptureWindow({ mode: 'region', source: 'delay' }).catch((error) => log(error.message)), seconds * 1000)
      return { scheduled: true, seconds }
    }
    case 'screenshotFixed': await captureDomain.createCaptureWindow({ mode: 'region', autoAction: 'pin', source: 'fixed' }); return true
    case 'screenshotOcr': await captureDomain.createCaptureWindow({ mode: 'region', autoAction: 'ocr', source: 'ocr' }); return true
    case 'screenshotTable': await captureDomain.createCaptureWindow({ mode: 'region', autoAction: 'table', source: 'table' }); return true
    case 'screenshotQr': await captureDomain.createCaptureWindow({ mode: 'region', autoAction: 'qr', source: 'qr' }); return true
    case 'screenshotOcrTranslate': await captureDomain.createCaptureWindow({ mode: 'region', autoAction: 'translate', source: 'ocr-translate' }); return true
    case 'screenshotCopy': await captureDomain.createCaptureWindow({ mode: 'region', autoAction: 'copy', source: 'copy' }); return true
    case 'screenshotLong': await captureDomain.createCaptureWindow({ mode: 'region', autoAction: 'long', source: 'long-capture' }); return true
    case 'screenshotFullScreen': await captureDomain.createCaptureWindow({ mode: 'fullscreen', autoAction: payload.save ? 'save' : 'copy', source: 'fullscreen' }); return true
    case 'screenshotFocusedWindow': {
      const dataUrl = await captureFocusedWindow()
      clipboard.writeImage(nativeImage.createFromDataURL(dataUrl))
      persistHistory(dataUrl, { action: 'copy', source: 'focused-window' })
      return true
    }
    case 'fixedContent': {
      const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] })
      if (result.canceled || !result.filePaths[0]) return false
      const image = nativeImage.createFromPath(result.filePaths[0])
      const dataUrl = image.toDataURL()
      pinDomain.createPinWindow(dataUrl, { source: 'file' })
      persistHistory(dataUrl, { source: 'file', action: 'pin' })
      return true
    }
    case 'videoRecord': {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      await recordDomain.createRecordWindow({ display, selectionBounds: display.bounds })
      return true
    }
    case 'fullScreenDraw': await captureDomain.createCaptureWindow({ mode: 'canvas', source: 'canvas' }); return true
    case 'toggleFixedContentVisibility': pinDomain.togglePinVisibility(); return true
    case 'showOrHideMainWindow': {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide()
      else createMainWindow('home')
      return true
    }
    case 'openImageSaveFolder': {
      const directory = getSettings().screenshot.saveDirectory || app.getPath('pictures')
      await shell.openPath(directory)
      return true
    }
    case 'openCaptureHistory': createMainWindow('history'); return true
    case 'localSearch': searchDomain.createSearchWindow(); return true
    case 'translation': createMainWindow('translation'); return true
    case 'chat': createMainWindow('chat'); return true
    case 'explainClipboard': {
      // Read-only clipboard path: never write or empty the clipboard.
      const text = String(clipboard.readText() || '').trim()
      if (!text) return false
      if (text.length > 10000) {
        log('Explain clipboard skipped: text too long', text.length)
        return false
      }
      hideToolbar()
      return openToolbarAiAction('explain', text)
    }
    default: throw new Error(`未知功能：${name}`)
  }
}

function registerShortcuts() {
  const shortcuts = getSettings().shortcuts
  if (isGameModeEnabled()) return shortcutService.suspendAll(shortcuts, 'game-mode')
  return shortcutService.registerAll(shortcuts)
}

function applyGameModeState(enabled, reason = 'state-change') {
  const gameMode = enabled === true
  registerShortcuts()
  if (gameMode) {
    selectionHookService?.suspend('game-mode')
    hideToolbar()
    if (currentStreamController) cancelToolbarStream(currentStreamController, 'game-mode')
    searchDomain.hideSearchWindow()
  } else if (selectionHookService) {
    selectionHookService.start('game-mode-disabled')
  }
  createTrayIcon()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:game-mode-changed', gameMode)
  log('Game mode changed:', { enabled: gameMode, reason })
  return gameMode
}

function setGameModeEnabled(enabled, reason = 'tray') {
  const nextEnabled = enabled === true
  if (isGameModeEnabled() !== nextEnabled) {
    settingsService.updateSettings({ system: { gameMode: nextEnabled } })
  }
  return applyGameModeState(nextEnabled, reason)
}

async function stopManagedDataWriters() {
  const activeOcrService = ocrService
  if (activeOcrService) {
    const inFlight = [...activeOcrService.inFlight.values()]
    activeOcrService.stop()
    await Promise.allSettled(inFlight)
    if (ocrService === activeOcrService) ocrService = null
  }

  await recordDomain.shutdown()
  recordingService = null

  await longCaptureDomain.shutdown()
}

function restoreManagedDataWriters(restartOcr) {
  if (!restartOcr) return
  getOcrService().ensureStarted().catch((error) => log('OCR restart failed:', error.message))
}

registerSettingsIpc({
  ipcMain: secureIpcMain,
  settingsService: {
    getSettings: () => getSettings(),
    getPublicSettings: (settings) => settingsService.getPublicSettings(settings),
    updateSettings: (patch) => settingsService.updateSettings(patch),
    resetSettings: () => settingsService.resetSettings(),
    prepareProviderConnection: (provider) => settingsService.prepareProviderConnection(provider)
  },
  assertWritable: assertManagedDataWritable,
  onSettingsUpdated: (patch, settings) => {
    settingsEffects.applyUpdate(patch, settings)
  },
  onSettingsReset: (settings) => {
    settingsEffects.applyReset(settings)
  },
  validateApiKey: async (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return aiClient.validateApiKey(input)
    }
    const provider = input.provider || input
    const result = await aiClient.testProviderConnection(provider, {
      fetchModels: input.fetchModels === true
    })
    return result
  },
  log
})
registerShortcutIpc({
  ipcMain: secureIpcMain,
  shortcutService
})

function openExternal(value) {
  if (!isSafeExternalUrl(value)) throw new Error('仅支持打开 HTTP 或 HTTPS 链接')
  return shell.openExternal(new URL(String(value)).toString())
}

async function getDisplayDiagnostics() {
  const displays = screen.getAllDisplays().map((display) => ({
    id: display.id,
    label: display.label,
    bounds: display.bounds,
    workArea: display.workArea,
    size: display.size,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    internal: display.internal,
    physicalBounds: isWin ? screen.dipToScreenRect(null, display.bounds) : display.bounds
  }))
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 4096, height: 4096 } })
  return {
    cursor: screen.getCursorScreenPoint(),
    displays,
    sources: sources.map((source) => ({ id: source.id, displayId: source.display_id, name: source.name, thumbnailSize: source.thumbnail.getSize() }))
  }
}

async function chooseDirectory() {
  return pickDirectory()
}

async function pickDirectory(options = {}) {
  const result = await dialog.showOpenDialog({
    ...(options.title ? { title: options.title } : {}),
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled ? '' : result.filePaths[0]
}

function getDataRootInfo() {
  return {
  portable: dataRootContext.portable,
  customized: !!dataRootContext.paths,
  path: dataRootContext.paths?.root || dataRootContext.legacyUserData
  }
}

function openDataRoot() {
  return shell.openPath(dataRootContext.paths?.root || app.getPath('userData'))
}

async function changeDataRoot() {
  if (dataRootMigrationInProgress || fs.existsSync(dataRootContext.pendingPath)) throw new Error('已有未完成的数据目录迁移，不能开始新的迁移')

  const activeRoot = dataRootContext.paths?.root || dataRootContext.legacyUserData
  const sourcePaths = dataRootContext.paths
    ? createManagedSourcePaths(activeRoot)
    : createLegacySourcePaths(activeRoot)
  const previousRoot = dataRootContext.paths ? activeRoot : ''
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  if (path.resolve(result.filePaths[0]) === path.resolve(activeRoot)) return { unchanged: true }
  const targetRoot = await validateDataRoot(result.filePaths[0], activeRoot)
  if (path.resolve(targetRoot) === path.resolve(activeRoot)) return { unchanged: true }

  const confirmation = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['取消', '迁移并重启'],
    defaultId: 1,
    cancelId: 0,
    message: '更改软件数据目录？',
    detail: 'Highlighter 将迁移配置、日志、截图历史，并在迁移完成后重启。缓存和运行数据不会迁移。'
  })
  if (confirmation.response !== 1) return { canceled: true }
  if (dataRootMigrationInProgress || fs.existsSync(dataRootContext.pendingPath)) throw new Error('已有未完成的数据目录迁移，不能开始新的迁移')

  const restartOcr = !!ocrService && getSettings().plugins.ocr && getSettings().ocr.hotStart
  let writerShutdownStarted = false
  dataRootMigrationInProgress = true
  try {
    persistSettings(getSettings())
    writerShutdownStarted = true
    await quiesceAndMigrate({
      coordinator: managedRecordingWriters,
      stopWriters: stopManagedDataWriters,
      migrate: () => migrateDataRoot({
        source: sourcePaths,
        target: createDataPaths(targetRoot),
        portableDirectory: dataRootContext.locatorDirectory,
        previousRoot
      }),
      relaunch: () => setImmediate(() => {
        markSessionClean('data-root-relaunch')
        relaunchApplication({ app, dataRootContext })
        app.exit(0)
      })
    })
  } catch (error) {
    dataRootMigrationInProgress = false
    restoreManagedDataWriters(restartOcr)
    const recovery = writerShutdownStarted ? '；为保证数据安全，录屏和长截图已停止，可重新启动这些功能' : ''
    throw new Error(`数据目录迁移失败：${error.message || String(error)}${recovery}`)
  }

  return { restarting: true }
}

registerAppIpc({
  ipcMain: secureIpcMain,
  controller: {
    openExternal,
    executeFunction,
    getInfo: () => ({
      version: app.getVersion(),
      platform: process.platform,
      installType: getInstallType(),
      dataDirectory: activePaths?.root || app.getPath('userData')
    }),
    getDisplayDiagnostics,
    chooseDirectory,
    openDataDirectory: () => shell.openPath(activePaths?.root || app.getPath('userData')),
    openSaveDirectory: () => shell.openPath(getSettings().screenshot.saveDirectory || app.getPath('pictures')),
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
  ipcMain: secureIpcMain,
  controller: {
    preview: () => {
      if (!diagnosticsService) throw new Error('诊断服务尚未就绪')
      return diagnosticsService.preview()
    },
    export: async ({ includeCrashDumps = false } = {}) => {
      if (!diagnosticsService) throw new Error('诊断服务尚未就绪')
      const date = new Date().toISOString().slice(0, 10)
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出 Highlighter 诊断包',
        defaultPath: path.join(app.getPath('documents'), `Highlighter-Diagnostics-${date}.zip`),
        filters: [{ name: 'ZIP 诊断包', extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      const exported = await diagnosticsService.exportZip(result.filePath, { includeCrashDumps })
      return { canceled: false, ...exported }
    }
  }
})

registerUpdateIpc({
  ipcMain: secureIpcMain,
  updateService: {
    getStatus: () => resolveUpdateService().getStatus(),
    check: (options) => resolveUpdateService().check(options),
    download: () => resolveUpdateService().download(),
    install: () => resolveUpdateService().install(),
    openDownloadPage: () => resolveUpdateService().openDownloadPage()
  }
})

registerDataRootIpc({
  ipcMain: secureIpcMain,
  controller: {
    get: getDataRootInfo,
    open: openDataRoot,
    change: changeDataRoot
  }
})

registerHistoryIpc({
  ipcMain: secureIpcMain,
  historyService: {
    list: (filter) => performanceMonitor.measure('history.list', () => historyService.list(filter), {
      limit: Math.max(0, Number(filter?.limit) || 0),
      filtered: !!(filter?.query || filter?.source)
    }),
    getThumbnail: (id) => historyService.getThumbnail(id),
    listSources: () => performanceMonitor.measure('history.sources', () => historyService.listSources()),
    stats: () => performanceMonitor.measure('history.stats', () => historyService.stats()),
    getItem: (id) => historyService.getItem(id),
    delete: (id) => historyService.delete(id),
    deleteMany: (ids) => historyService.deleteMany(ids),
    exportMany: (ids, directory) => historyService.exportMany(ids, directory),
    cleanup: () => historyService.cleanup(),
    clear: () => historyService.clear()
  },
  copyItem: (item) => {
    if (!fs.existsSync(item.filePath)) return false
    if (Math.max(Number(item.width) || 0, Number(item.height) || 0) > 65535 || (Number(item.width) || 0) * (Number(item.height) || 0) > 80000000) return false
    clipboard.writeImage(nativeImage.createFromPath(item.filePath))
    return true
  },
  editItem: async (item) => {
    if (!fs.existsSync(item.filePath)) return false
    await captureDomain.createCaptureWindow({ imageBuffer: await fs.promises.readFile(item.filePath), mode: 'image', source: 'history' })
    return true
  },
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
  chooseExportDirectory: () => pickDirectory({ title: '选择截图导出目录' })
})

const ocrIpcController = {
  ocrStatus: () => getOcrService().getStatus(),
  ocr: async (_event, payload) => {
  if (!getSettings().plugins.ocr) throw new Error('请先在插件页面启用文本识别')
  const imageData = typeof payload === 'string' ? payload : payload?.imageBuffer ?? payload?.dataUrl
  const buffer = imageDataToBuffer(imageData)
  if (!buffer.length) throw new Error('OCR 图片数据为空')
  const settings = getSettings()
  return recognizeWithPerformance(buffer, {
    scaleFactor: payload?.scaleFactor,
    detectAngle: settings.ocr.detectAngle,
    minConfidence: settings.ocr.minConfidence
  }, 'capture')
  },
  translate: async (_event, payload) => {
  if (!getSettings().plugins.ocr) throw new Error('请先在插件页面启用文本识别')
  const imageData = typeof payload === 'string' ? payload : payload?.imageBuffer ?? payload?.dataUrl
  const buffer = imageDataToBuffer(imageData)
  if (!buffer.length) throw new Error('OCR 图片数据为空')
  const settings = getSettings()
  const ocrResult = await recognizeWithPerformance(buffer, {
    scaleFactor: payload?.scaleFactor,
    detectAngle: settings.ocr.detectAngle,
    minConfidence: settings.ocr.minConfidence
  }, 'capture-translate')
  const text = ocrResult.text.trim()
  if (!text) throw new Error('未识别到可翻译的文本')
  const textBlocks = (Array.isArray(ocrResult.textBlocks) ? ocrResult.textBlocks : [])
    .filter((block) => String(block?.text || '').trim())
  if (!textBlocks.length) throw new Error('未识别到可定位的翻译文本')
  const translations = await aiClient.translateOcrTextBlocks(
    resolveAiAssignment(settings, 'ocr-translate'),
    textBlocks.map((block) => String(block.text).trim()),
    'auto',
    settings.ai.targetLanguage
  )
  const translatedBlocks = textBlocks.map((block, index) => ({
    ...block,
    sourceText: String(block.text).trim(),
    text: translations[index]
  }))
  const translation = translations.join('\n')
  return {
    text,
    translation,
    ocrResult,
    translationResult: {
      ...ocrResult,
      text: translation,
      textBlocks: translatedBlocks
    }
  }
  }
}

registerCaptureIpc({
  ipcMain: secureIpcMain,
  controller: {
    ...captureDomain.createCaptureController(),
    ...longCaptureDomain.createLongCaptureController(),
    ...ocrIpcController,
    ...recognitionDomain.createRecognitionController()
  }
})

registerSearchIpc({
  ipcMain: secureIpcMain,
  controller: searchDomain.createSearchController()
})

registerRecordingIpc({
  ipcMain: secureIpcMain,
  controller: recordDomain.createRecordingController()
})


secureIpcMain.on('toolbar:action', async (_event, { action, text }) => {
  if (isProcessing || !text) return
  const toolbarConfig = getSettings().selectionToolbar
  const visibleActions = getVisibleToolbarActions(toolbarConfig)
  if (!visibleActions.includes(action)) return
  const actionDefinition = getToolbarActionDefinition(toolbarConfig, action)
  if (!actionDefinition) return
  if (isLocalToolbarAction(action)) {
    hideToolbar()
    if (action === 'copy') clipboard.writeText(text)
    else if (action === 'open') {
      const target = buildOpenUrl(text)
      if (!target) return
      try { await shell.openExternal(target) } catch (error) { log('Toolbar open failed:', error.message) }
    }
    else {
      const url = buildSearchUrl(getSettings().selectionToolbar.searchEngine, text)
      try { await shell.openExternal(url) } catch (error) { log('Toolbar search failed:', error.message) }
    }
    return
  }
  if (!isAiToolbarAction(action, toolbarConfig)) return
  hideToolbar()
  await openToolbarAiAction(action, text)
})
secureIpcMain.on('window:toggle-pin', (event, shouldPin) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (shouldPin && !pinDomain.canPinMore()) return event.sender.send('window:pin-denied', { max: pinDomain.MAX_PINNED })
  if (shouldPin && !win._isPinned) {
    if (!pinDomain.acquirePinnedSlot()) {
      event.sender.send('window:pin-denied', { max: pinDomain.MAX_PINNED })
      return
    }
    win._isPinned = true
    win.setAlwaysOnTop(true, 'floating')
  }
  if (!shouldPin && win._isPinned) {
    win._isPinned = false
    pinDomain.releasePinnedSlot()
    win.setAlwaysOnTop(false)
  }
})
secureIpcMain.on('stream:cancel', (event, streamId) => {
  if (!isCurrentToolbarStreamSender(event)) return
  if (isStaleToolbarStreamSignal(event, streamId)) return
  cancelToolbarStream(currentStreamController, 'user-cancelled')
})
secureIpcMain.on('stream:finish', (event, streamId) => {
  if (!isCurrentToolbarStreamSender(event)) return
  if (isStaleToolbarStreamSignal(event, streamId)) return
  cancelToolbarStream(currentStreamController, 'renderer-finished')
})
secureIpcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
secureIpcMain.on('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (currentStreamController?.win === win) cancelToolbarStream(currentStreamController, 'window-hidden')
  win?.hide()
})
secureIpcMain.assertComplete()

async function chooseInitialDataRoot() {
  if (dataRootContext.startupError) {
    await dialog.showMessageBox({
      type: 'warning',
      title: '数据目录启动警告',
      message: '当前数据目录不可用，请重新选择。',
      detail: dataRootContext.startupError.message || String(dataRootContext.startupError),
      buttons: ['确定']
    })
  }

  const result = await dialog.showOpenDialog({
    title: '选择 Highlighter 数据目录',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths[0]) {
    removeProvisionalRoot(dataRootContext)
    app.exit(0)
    return
  }

  let targetRoot = result.filePaths[0]
  targetRoot = await validateDataRoot(targetRoot, dataRootContext.legacyUserData)
  await migrateDataRoot({
    source: createLegacySourcePaths(dataRootContext.legacyUserData),
    target: createDataPaths(targetRoot),
    portableDirectory: dataRootContext.locatorDirectory,
    previousRoot: ''
  })
  if (!removeProvisionalRoot(dataRootContext)) console.warn('Unable to remove provisional data directory')
  relaunchApplication({ app, dataRootContext })
  app.exit(0)
}

async function recoverUnavailableDataRoot() {
  let recoveryError = dataRootContext.startupError
  while (true) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Highlighter 数据目录不可用',
      message: '无法使用已配置的数据目录。',
      detail: recoveryError?.message || String(recoveryError || ''),
      buttons: ['重试', '选择其他目录', '退出'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })

    if (response === 0) {
      try {
        const targetRoot = await validateDataRoot(dataRootContext.requestedRoot)
        await ensureDataLayout(createDataPaths(targetRoot))
        if (!removeProvisionalRoot(dataRootContext)) console.warn('Unable to remove provisional data directory')
        relaunchApplication({ app, dataRootContext })
        app.exit(0)
        return
      } catch (error) {
        recoveryError = error
      }
      continue
    }

    if (response === 1) {
      if (fs.existsSync(dataRootContext.pendingPath)) {
        recoveryError = new Error('检测到未完成的数据目录迁移，请先恢复原数据目录')
        continue
      }
      const result = await dialog.showOpenDialog({
        title: '选择 Highlighter 数据目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths[0]) continue
      try {
        const targetRoot = await validateDataRoot(result.filePaths[0])
        await ensureDataLayout(createDataPaths(targetRoot))
        await writeLocator(dataRootContext.locatorPath, targetRoot)
        if (!removeProvisionalRoot(dataRootContext)) console.warn('Unable to remove provisional data directory')
        relaunchApplication({ app, dataRootContext })
        app.exit(0)
        return
      } catch (error) {
        recoveryError = error
      }
      continue
    }

    removeProvisionalRoot(dataRootContext)
    app.exit(1)
    return
  }
}

async function startApplication() {
  if (dataRootContext.needsSelection) {
    if (dataRootContext.startupError || !dataRootContext.portable) await recoverUnavailableDataRoot()
    else await chooseInitialDataRoot()
    return
  }

  const startupToken = performanceMonitor.begin('startup.services-ready')

  let finalization = null
  if (activePaths) {
    const hasPendingMigration = fs.existsSync(dataRootContext.pendingPath)
    try {
      finalization = await verifyAndFinalizeMigration({
        pendingPath: dataRootContext.pendingPath,
        activeRoot: activePaths.root
      })
      if (!finalization.finalized && finalization.cleanupErrors.length) {
        console.warn('Data migration cleanup remains pending:', finalization.cleanupErrors.join('; '))
      }
    } catch (startupError) {
      if (!hasPendingMigration) throw startupError
      app.releaseSingleInstanceLock()
      try {
        await rollbackPendingMigration({
          pendingPath: dataRootContext.pendingPath,
          locatorPath: dataRootContext.locatorPath
        })
      } catch (rollbackError) {
        rollbackError.cause = startupError
        throw rollbackError
      }
      dialog.showErrorBox('Highlighter 启动失败', startupError.message || String(startupError))
      relaunchApplication({ app, dataRootContext })
      app.exit(1)
      return
    }
    initializeStore()
  } else {
    initializeStore()
  }

  if (finalization && !finalization.finalized && finalization.cleanupErrors.length) {
    log('Data migration cleanup remains pending:', finalization.cleanupErrors)
  }
  initializeDiagnostics()
  persistSettings(getSettings())
  createMainWindow('home')
  if (!e2eContext.enabled) {
    createTrayIcon()
    createToolbarWindow()
    registerShortcuts()
    initSelectionHook()
    registerSelectionPowerEvents()
    if (getSettings().plugins.ocr && getSettings().ocr.hotStart) getOcrService().ensureStarted().catch((error) => log('OCR hot start failed:', error.message))
    if (isWin) {
      listNativeDisplays(screenshotDesktop.parseDisplaysOutput)
        .then((displays) => { nativeDisplayListPromise = Promise.resolve(displays) })
        .catch((error) => log('Display discovery warm-up failed:', error))
    }
    app.setLoginItemSettings({ openAtLogin: !!getSettings().system.autoStart })
  }
  if (e2eContext.enabled) createToolbarWindow()
  deferUpdateServiceStart()
  performanceMonitor.finish(startupToken, {
    e2e: e2eContext.enabled,
    moduleElapsedMs: Math.round((performance.now() - mainModuleStartedAt) * 100) / 100
  })
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  removeProvisionalRoot(dataRootContext)
  app.quit()
}
else {
  app.on('second-instance', () => { if (store) createMainWindow('home') })
  app.on('render-process-gone', (_event, webContents, details) => {
    diagnosticsService?.recordProcessExit('renderer', {
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents?.getURL?.() || ''
    })
    log('Renderer process exited:', {
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents?.getURL?.() || ''
    })
    const win = webContents ? BrowserWindow.fromWebContents(webContents) : null
    selectionWindowManager?.handleRendererGone(win, details)
  })
  app.on('child-process-gone', (_event, details) => {
    diagnosticsService?.recordProcessExit('child', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName || ''
    })
    log('Child process exited:', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName || ''
    })
  })
  nativeTheme.on('updated', () => {
    if (store && getSettings().theme === 'system') broadcastActionAppearance()
  })
  process.on('unhandledRejection', (reason) => log('Unhandled promise rejection:', reason))
  app.whenReady().then(startApplication).catch((error) => {
    dialog.showErrorBox('Highlighter 启动失败', error.message || String(error))
    removeProvisionalRoot(dataRootContext)
    app.exit(1)
  })
  app.on('activate', () => { if (store) createMainWindow('home') })
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => {
    markSessionClean('quit')
    updateService?.dispose()
    shortcutService.dispose()
  })
  app.on('before-quit', () => {
    recordDomain.shutdown()
      .catch((error) => log('Recording shutdown failed:', error.message))
      .finally(() => { recordingService = null })
    longCaptureDomain.closeLongCapture()
    if (ocrService) { ocrService.stop(); ocrService = null }
    if (everythingService) { everythingService.stop(); everythingService = null }
    disposeSelectionHook()
    if (tray) { tray.destroy(); tray = null }
  })
}
