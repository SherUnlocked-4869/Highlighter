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
  utilityProcess, protocol, session
} = require('electron')
const fs = require('fs')
const path = require('path')
const { prepareDataRoot, removeProvisionalRoot } = require('./main/services/data-root-bootstrap')
const { configureE2eEnvironment } = require('./main/services/e2e-bootstrap')
const { relaunchApplication } = require('./main/services/relaunch-application')
const {
  rollbackPendingMigration,
  verifyAndFinalizeMigration
} = require('./main/services/data-root-migration')
const { ManagedWriterCoordinator } = require('./main/services/managed-writer-coordinator')
const { createAppLogger } = require('./main/services/app-logger')
const { PerformanceMonitor } = require('./main/services/performance-monitor')
const { DiagnosticsService } = require('./main/services/diagnostics-service')
const { SettingsService } = require('./main/services/settings-service')
const { DEFAULT_SETTINGS } = require('./main/services/settings-defaults')
const { registerSettingsIpc } = require('./main/ipc/settings-ipc')
const { createCodingPlanIpcController, registerCodingPlanIpc } = require('./main/ipc/coding-plan-ipc')
const { HistoryService } = require('./main/services/history-service')
const { ensureDirectory: ensureDirectorySync } = require('./main/services/fs-utils')
const imageBufferUtils = require('./main/services/image-buffer')
const captureNaming = require('./main/services/capture-naming')
const { CAPTURE_PREFIX } = captureNaming
const { registerHistoryIpc } = require('./main/ipc/history-ipc')
const { ShortcutService } = require('./main/services/shortcut-service')
const { buildTrayMenuTemplate } = require('./main/services/tray-menu')
const { createProxyBridgeController } = require('./main/services/proxy-bridge-controller')
const { registerShortcutIpc } = require('./main/ipc/shortcut-ipc')
const { registerAppIpc } = require('./main/ipc/app-ipc')
const { registerDiagnosticsIpc } = require('./main/ipc/diagnostics-ipc')
const { registerUpdateIpc } = require('./main/ipc/update-ipc')
const { registerDataRootIpc } = require('./main/ipc/data-root-ipc')
const { registerCaptureIpc } = require('./main/ipc/capture-ipc')
const { createOcrIpcController, registerOcrIpc } = require('./main/ipc/ocr-ipc')
const { registerRecordingIpc } = require('./main/ipc/recording-ipc')
const { registerSearchIpc } = require('./main/ipc/search-ipc')
const { registerSelectionIpc } = require('./main/ipc/selection-ipc')
const { UpdateService } = require('./main/services/update-service')
const { createSecureIpcMain } = require('./main/services/ipc-security')
const { createSecureWindow, isSafeExternalUrl } = require('./main/services/window-security')
const { name: applicationName } = require('./package.json')

protocol.registerSchemesAsPrivileged([{ scheme: 'highlighter-clipboard', privileges: { standard: true, secure: true, supportFetchAPI: false } }])
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
const { createClipboardDomain } = require('./main/domains/clipboard')
const { createFileIconLookup } = require('./main/services/file-icon-lookup')
const { createSelectionDomain } = require('./main/domains/selection')
const { createDataRootDomain } = require('./main/domains/data-root')
const { createSettingsEffects } = require('./main/domains/settings-effects')
const aiClient = require('./main/services/ai')
const { createFunctionRouter } = require('./main/services/function-router')
const { createSettingsNormalizer } = require('./main/services/settings-normalize')
const { createFfmpegPathResolver } = require('./main/services/ffmpeg-path')
const { createImageFileSaver, resolveSaveDirectory } = require('./main/services/image-file-save')
const { createCursorProvider } = require('./main/services/cursor-provider')
// P0-1-T6：主进程文案的 i18n 入口（加载 shared/locales/*.js 并提供 t/setLanguage）。
const { setLanguage, t } = require('./main/services/i18n-bootstrap')
const {
  migrateAiSettings,
  resolveAiAssignment
} = require('./main/services/ai-providers')
const { migrateAppearanceSettings } = require('./main/services/appearance-migration')
const { migrateShortcutSettings } = require('./main/services/shortcut-migration')

const defaultHistoryDirectory = activePaths?.history || path.join(app.getPath('userData'), 'capture-history')
const normalizeSettings = createSettingsNormalizer({ defaultHistoryDirectory })
const resolveFfmpegPath = createFfmpegPathResolver({ log, isPackaged: () => app.isPackaged })
const conversationsDirectory = activePaths?.conversations || path.join(app.getPath('userData'), 'conversations')
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

let store = null
let settingsService = null
let historyService = null
let diagnosticsService = null
let updateService = null
let sessionExitRecorded = false
let proxyBridgeController = null

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
    migrateSettings: (settings, context) => {
      const ai = migrateAiSettings(settings, context)
      const appearance = migrateAppearanceSettings(ai.settings)
      const shortcuts = migrateShortcutSettings(appearance.settings, { log })
      return {
        settings: shortcuts.settings,
        changed: ai.changed || appearance.changed || shortcuts.changed
      }
    },
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
  selectionDomain.ensureConversationStore()
  return store
}

let mainWindow = null
let firstMainWindowReady = true
let tray = null
let ocrService = null
let everythingService = null
let recordingService = null
const getSearchFileIcon = createFileIconLookup({ app, log })
const managedRecordingWriters = new ManagedWriterCoordinator()
let dataRootMigrationInProgress = false
let pinDomain = null
let captureDomain = null
let cursorProvider = null
let longCaptureDomain = null
let recordDomain = null
let recognitionDomain = null
let searchDomain = null
let clipboardDomain = null
let selectionDomain = null
let dataRootDomain = null
let functionRouter = null
let settingsEffects = null
const isWin = process.platform === 'win32'

// Shared mutable service handles. The refs let domains that need to stop or
// replace a lazily created service without main.js owning the call.
const ocrServiceRef = {
  get: () => ocrService,
  set: (value) => { ocrService = value }
}
const recordingServiceRef = {
  get: () => recordingService,
  set: (value) => { recordingService = value }
}
const dataRootMigrationState = {
  get: () => dataRootMigrationInProgress,
  set: (value) => { dataRootMigrationInProgress = value }
}

function shouldFilterApp(programName) {
  const value = String(programName || '').toLowerCase()
  return value.includes('highlighter') || value.includes('划词助手') || value.includes('huacizhushou')
}

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
  // Reads the store rather than getSettings(): this predicate also runs while the
  // settings service is still being constructed (a stored-value migration logs),
  // and getSettings() would dereference the not-yet-assigned service.
  isEnabled: () => !dataRootMigrationInProgress && !!store && store.get('settings', {}).system?.runLog !== false,
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
  if (selectionDomain?.isProcessing()) return { ok: false, reason: '划词处理任务仍在进行，请完成后重试。' }
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
  if (role === 'toolbar') return selectionDomain?.ownsToolbarWindow(win) === true
  if (role === 'action') return selectionDomain?.ownsActionWindow(win) === true
  if (role === 'capture') return captureDomain?.ownsWindow(win) === true
  if (role === 'long-capture') return longCaptureDomain?.ownsControllerWindow(win) === true
  if (role === 'long-overlay') return longCaptureDomain?.ownsOverlayWindow(win) === true
  if (role === 'pin') return pinDomain?.ownsWindow(win) === true
  if (role === 'recognition') return recognitionDomain?.ownsWindow(win) === true
  if (role === 'clipboard') return clipboardDomain?.ownsWindow(win) === true
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
  executeFunction: (name) => functionRouter.executeFunction(name),
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

// The extended signature is a pass-through: `ext` and `nameSettings` are read by
// the module, and callers that omit them keep the legacy `*.png` shape. That is
// how the history and long-capture paths opt into screenshot.nameTemplate while
// the recorder deliberately stays on the legacy format.
function makeCaptureName(prefix = CAPTURE_PREFIX, ext, nameSettings) {
  return captureNaming.makeCaptureName(prefix, ext, nameSettings)
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

// P0-2-T2: the screenshot path asks this provider for the cursor shape; it stays lazy, so no
// helper process is spawned until a capture actually requests the cursor.
cursorProvider = createCursorProvider({ app, spawn, log, rootDirectory: __dirname })

captureDomain = createCaptureDomain({
  app,
  spawn,
  execFile,
  fs,
  path,
  screen,
  BrowserWindow,
  desktopCapturer,
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
  screenshotDesktop,
  listNativeDisplays,
  findNativeDisplay,
  getNativeDisplayBounds,
  readPngSize,
  shouldFilterApp,
  pinDomain,
  createRecordWindow: (...args) => recordDomain.createRecordWindow(...args),
  createLongCaptureFromSelection: (...args) => longCaptureDomain.createLongCaptureFromSelection(...args),
  createRecognitionWindow: (...args) => recognitionDomain.createRecognitionWindow(...args),
  persistHistory: (...args) => persistHistory(...args),
  saveImageBuffer: (...args) => saveImageBuffer(...args),
  imageDataToBuffer,
  dataUrlToBuffer,
  bufferToDataUrl,
  performanceMonitor,
  cursorProvider
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

selectionDomain = createSelectionDomain({
  BrowserWindow,
  clipboard,
  screen,
  shell,
  nativeTheme,
  powerMonitor,
  utilityProcess,
  createLocalWindow,
  rootDirectory: __dirname,
  isWin,
  getSettings,
  updateSettings: (patch) => settingsService.updateSettings(patch),
  createTrayIcon,
  createMainWindow,
  getPinDomain: () => pinDomain,
  isGameModeEnabled,
  shouldFilterApp,
  conversationsDirectory,
  log
})

clipboardDomain = createClipboardDomain({
  app, BrowserWindow, screen, nativeTheme, session, dialog, powerMonitor,
  ipcMain: secureIpcMain, rootDirectory: __dirname,
  directory: activePaths?.clipboard || path.join(app.getPath('userData'), 'clipboard'),
  getSettings, updateSettings: (patch) => settingsService.updateSettings(patch),
  getHook: () => selectionDomain.hookService(), createLocalWindow,
  positionAutomationWindow, isGameModeEnabled,
  isMigrationInProgress: () => dataRootMigrationState.get(), automation: e2eContext.enabled
})

settingsEffects = createSettingsEffects({
  app,
  registerShortcuts,
  applyGameModeState,
  createTrayIcon,
  getUpdateService: () => updateService,
  ocrServiceRef,
  getOcrService,
  broadcastActionAppearance: (settings) => selectionDomain.broadcastActionAppearance(settings),
  // P0-1-T2：语言切换广播到所有窗口（主→渲染；按方案 §2.2 不登记 IPC_SURFACES）。
  broadcastInterfaceLanguage: (language) => {
    // 主进程自己的文案（托盘/更新/状态）也要跟着切；托盘 label 在构建时求值，
    // 由 settings-effects 的 `language.tray` effect 负责重建。
    setLanguage(language)
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('i18n:language', language)
  },
  searchDomain,
  selectionHookServiceRef: {
    get: () => selectionDomain.hookService()
  },
  syncConversationStore: () => selectionDomain.syncConversationStore(),
  getClipboardDomain: () => clipboardDomain,
  log
})

dataRootDomain = createDataRootDomain({
  app,
  dialog,
  fs,
  path,
  shell,
  dataRootContext,
  getSettings,
  persistSettings,
  isMigrationInProgress: () => dataRootMigrationState.get(),
  setMigrationInProgress: (value) => dataRootMigrationState.set(value),
  ocrServiceRef,
  recordingServiceRef,
  getOcrService,
  recordDomain,
  longCaptureDomain,
  managedRecordingWriters, selectionDomain, getClipboardDomain: () => clipboardDomain,
  removeProvisionalRoot,
  markSessionClean,
  log
})

functionRouter = createFunctionRouter({
  app,
  clipboard,
  dialog,
  nativeImage,
  screen,
  shell,
  captureDomain,
  pinDomain,
  // P0-6-T4: the click-through fallback resolves the pin domain lazily so a
  // recycled delegate cannot hold a stale reference.
  getPinDomain: () => pinDomain,
  // Owned by the tray bridge controller: the shortcut shares the same toggle so
  // both entry points send the user through the same failure copy.
  getProxyBridge: () => proxyBridgeController,
  getClipboardDomain: () => clipboardDomain,
  recordDomain,
  searchDomain,
  selectionDomain,
  getMainWindow: () => mainWindow,
  createMainWindow,
  getSettings,
  persistHistory,
  assertGameModeDisabled,
  log
})

// The Index-Translate proxy bridge: the tray toggles it, the controller owns the
// failure copy, the tray refresh and the status broadcast.
proxyBridgeController = createProxyBridgeController({
  getSettings,
  log,
  dialog,
  t,
  createTrayIcon,
  getMainWindow: () => mainWindow
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
      functionRouter.executeFunction('screenshot').catch((error) => log('Tray action failed:', error.message))
    })
    tray.on('double-click', () => createMainWindow('home'))
  }
  const gameMode = isGameModeEnabled(settings)
  const proxyState = proxyBridgeController ? proxyBridgeController.menuState(settings) : null
  tray.setToolTip([gameMode ? 'Highlighter（游戏模式）' : 'Highlighter', proxyState?.running ? t('main.proxy.tooltip-running') : ''].filter(Boolean).join(' · '))
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({
    gameMode,
    screenshotAccelerator: settings.shortcuts.screenshot, clipboardEnabled: settings.clipboard.enabled,
    translationProxy: proxyState,
    setTranslationProxyEnabled: (enabled) => proxyBridgeController.setEnabled(enabled),
    executeFunction: (name) => functionRouter.executeFunction(name).catch((error) => log('Tray action failed:', name, error.message)),
    // P0-6-T4: a click-through pin swallows clicks, and game mode suspends both
    // the router and the global shortcuts, so this entry calls the domain
    // directly - it is the only recovery path that survives game mode.
    exitClickThrough: () => {
      const exited = pinDomain.exitAllClickThrough()
      log('Click-through exit:', exited)
      return exited
    },
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
    hasConversation: selectionDomain.hasConversation(),
    showConversation: () => selectionDomain.showOrRestoreConversation(),
    quit: () => app.quit()
  })))
}

// The save flow lives in main/services/image-file-save.js, which owns the
// template-aware naming, the fast-path uniqueness probe and the write itself.
const saveImageBuffer = createImageFileSaver({
  dialog,
  getSettings,
  getPicturesDirectory: () => app.getPath('pictures'),
  rememberDirectory: (directory) => settingsService?.updateSettings({ screenshot: { lastSaveDirectory: directory } }),
  log
})

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


function registerShortcuts() {
  const shortcuts = getSettings().shortcuts
  if (isGameModeEnabled()) return shortcutService.suspendAll(shortcuts, 'game-mode')
  return shortcutService.registerAll(shortcuts)
}

function applyGameModeState(enabled, reason = 'state-change') {
  const gameMode = enabled === true
  registerShortcuts()
  selectionDomain.applyGameMode(gameMode)
  clipboardDomain?.applyGameMode(gameMode)
  if (gameMode) searchDomain.hideSearchWindow()
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
registerCodingPlanIpc({
  ipcMain: secureIpcMain,
  controller: createCodingPlanIpcController({
    settingsService,
    assertWritable: assertManagedDataWritable,
    testProviderConnection: (provider, options) => aiClient.testProviderConnection(provider, options),
    appVersion: app.getVersion()
  })
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
registerAppIpc({
  ipcMain: secureIpcMain,
  controller: {
    openExternal,
    executeFunction: (name, payload) => functionRouter.executeFunction(name, payload),
    getInfo: () => ({
      version: app.getVersion(),
      platform: process.platform,
      installType: getInstallType(),
      dataDirectory: activePaths?.root || app.getPath('userData')
    }),
    getDisplayDiagnostics,
    chooseDirectory,
    openDataDirectory: () => shell.openPath(activePaths?.root || app.getPath('userData')),
    openSaveDirectory: () => shell.openPath(resolveSaveDirectory(getSettings()) || app.getPath('pictures')),
    getProxyStatus: () => proxyBridgeController.getStatus(),
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
  controller: dataRootDomain.createController()
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

registerCaptureIpc({
  ipcMain: secureIpcMain,
  controller: {
    ...captureDomain.createCaptureController(),
    ...longCaptureDomain.createLongCaptureController(),
    ...recognitionDomain.createRecognitionController()
  }
})

registerOcrIpc({
  ipcMain: secureIpcMain,
  controller: createOcrIpcController({
    getSettings,
    getOcrService,
    imageDataToBuffer,
    recognizeWithPerformance,
    aiClient,
    resolveAiAssignment
  })
})

registerSearchIpc({
  ipcMain: secureIpcMain,
  controller: searchDomain.createSearchController()
})

registerRecordingIpc({
  ipcMain: secureIpcMain,
  controller: recordDomain.createRecordingController()
})


registerSelectionIpc({
  ipcMain: secureIpcMain,
  controller: selectionDomain.createIpcController()
})
secureIpcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
secureIpcMain.on('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  selectionDomain.cancelStreamForWindow(win, 'window-hidden')
  win?.hide()
})
secureIpcMain.assertComplete()
async function startApplication() {
  if (dataRootContext.needsSelection) {
    if (dataRootContext.startupError || !dataRootContext.portable) await dataRootDomain.recoverUnavailableDataRoot()
    else await dataRootDomain.chooseInitialDataRoot()
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
  // P0-1-T6：主进程文案要先按设置里的语言生效，再建托盘（label 在构建时求值）。
  setLanguage(getSettings().language)
  selectionDomain.syncConversationStore()
  createMainWindow('home')
  if (!e2eContext.enabled) {
    createTrayIcon()
    selectionDomain.createToolbarWindow()
    registerShortcuts()
    selectionDomain.initSelectionHook()
    selectionDomain.registerSelectionPowerEvents()
    clipboardDomain.start()
    if (getSettings().plugins.ocr && getSettings().ocr.hotStart) getOcrService().ensureStarted().catch((error) => log('OCR hot start failed:', error.message))
    if (isWin) captureDomain.warmUpNativeDisplays()
    app.setLoginItemSettings({ openAtLogin: !!getSettings().system.autoStart })
    // Reconcile the tray state first, then honour the opt-in autostart. Neither
    // opens a socket unless the user asked for it, so the default configuration
    // stays quiet.
    if (proxyBridgeController) proxyBridgeController.refresh().finally(() => createTrayIcon())
    proxyBridgeController?.startIfConfigured()
  }
  if (e2eContext.enabled) selectionDomain.createToolbarWindow()
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
    selectionDomain?.handleRendererGone(win, details)
  })
  app.on('child-process-gone', (_event, details) => {
    const description = { type: details.type, reason: details.reason, exitCode: details.exitCode, serviceName: details.serviceName || '' }
    diagnosticsService?.recordProcessExit('child', description)
    log('Child process exited:', description)
    // A restarted GPU process invalidates the surfaces of long-lived windows,
    // so the selection toolbar is recycled instead of reused. See
    // main/domains/selection/index.js (handleChildProcessGone).
    selectionDomain?.handleChildProcessGone(details)
  })
  nativeTheme.on('updated', () => {
    if (store) clipboardDomain?.notifyAppearance()
    if (store && getSettings().theme === 'system') selectionDomain.broadcastActionAppearance()
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
    cursorProvider?.dispose()
  })
  app.on('before-quit', (event) => {
    if (clipboardDomain && !clipboardDomain.isShutdownComplete()) {
      event.preventDefault()
      clipboardDomain.dispose().catch((error) => log('Clipboard shutdown failed:', error.code || 'SHUTDOWN_FAILED')).finally(() => app.quit())
      return
    }
    recordDomain.shutdown()
      .catch((error) => log('Recording shutdown failed:', error.message))
      .finally(() => { recordingService = null })
    longCaptureDomain.closeLongCapture()
    if (ocrService) { ocrService.stop(); ocrService = null }
    if (everythingService) { everythingService.stop(); everythingService = null }
    selectionDomain.disposeSelectionHook()
    if (proxyBridgeController) { proxyBridgeController.dispose(); proxyBridgeController = null }
    if (tray) { tray.destroy(); tray = null }
  })
}
