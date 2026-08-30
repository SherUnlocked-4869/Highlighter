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
  Tray
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
const { registerHistoryIpc } = require('./main/ipc/history-ipc')
const { ShortcutService } = require('./main/services/shortcut-service')
const { registerShortcutIpc } = require('./main/ipc/shortcut-ipc')
const { registerAppIpc } = require('./main/ipc/app-ipc')
const { registerDiagnosticsIpc } = require('./main/ipc/diagnostics-ipc')
const { registerUpdateIpc } = require('./main/ipc/update-ipc')
const { registerDataRootIpc } = require('./main/ipc/data-root-ipc')
const { registerCaptureIpc } = require('./main/ipc/capture-ipc')
const { registerRecordingIpc } = require('./main/ipc/recording-ipc')
const { SelectionHookService } = require('./main/services/selection-hook-service')
const { SelectionWindowManager } = require('./main/services/selection-window-manager')
const { ToolbarStreamSession } = require('./main/services/toolbar-stream-session')
const { UpdateService } = require('./main/services/update-service')
const { createSecureIpcMain } = require('./main/services/ipc-security')
const { createSecureWindow } = require('./main/services/window-security')
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
const { RecordingService } = require('./main/services/recording-service')
const { LongCaptureSession } = require('./main/services/long-capture-session')
const { findNativeDisplay, getNativeDisplayBounds } = require('./main/services/capture-geometry')
const { listNativeDisplays } = require('./main/services/native-display-list')
const { buildTableFromOcr } = require('./capture/recognition-utils')
const {
  calculateFrameBounds,
  calculateRecordControlSize,
  calculateTranscodeProgress,
  normalizeFrameRate,
  normalizeSelectionBounds,
  pickDesktopSource
} = require('./record/recording-utils')
const {
  sanitizeAnnotationCommand,
  sanitizeAnnotationSnapshot
} = require('./record/annotation-utils')
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
    watermark: { content: '', opacity: 80, color: '#ffffff', spacing: 30, fontSize: 24, rotation: 30 }
  },
  ocr: {
    modelProfile: 'ppocr-v4-ch',
    hotStart: true,
    modelWriteToMemory: false,
    detectAngle: false,
    minConfidence: 0.3,
    afterAction: 'none'
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
    openCaptureHistory: ''
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
let currentCaptureWindow = null
let currentLongCapture = null
let recordWindow = null
let recordFrameWindow = null
let ocrService = null
let recordingService = null
const managedRecordingWriters = new ManagedWriterCoordinator()
let dataRootMigrationInProgress = false
let isProcessing = false
const selectionEventDiagnostics = new Set()
let currentStreamController = null
let toolbarStreamSeq = 0
let pinnedCount = 0
const pinWindows = new Set()
const recognitionWindows = new Set()
const MAX_PINNED = 20
const TOOLBAR_W = getToolbarWidth(getVisibleToolbarActions(DEFAULT_SELECTION_TOOLBAR))
const TOOLBAR_H = 40
const TOOLBAR_STREAM_IDLE_TIMEOUT_MS = 30000
const ACTION_WINDOW_SIZE_SAVE_DELAY_MS = 180
const isWin = process.platform === 'win32'
let nativeDisplayListPromise = null
let captureCreateSeq = 0

function getOcrService() {
  if (dataRootMigrationInProgress) throw new Error('数据目录正在迁移，请稍候')
  if (ocrService) return ocrService
  const resourceRoot = app.isPackaged ? process.resourcesPath : __dirname
  ocrService = new OcrService({
    sidecarPath: path.join(resourceRoot, 'native', 'ocr', 'HighlighterOcrSidecar.exe'),
    modelDir: path.join(resourceRoot, 'ocr', 'models', 'ppocr-v4-ch'),
    tempDir: activePaths?.ocrCache || path.join(app.getPath('temp'), 'Highlighter', 'ocr'),
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
  if (normalized.fixedContent && Object.hasOwn(normalized.fixedContent, 'autoSaveDirectory')) delete normalized.fixedContent.autoSaveDirectory
  return normalized
}

function getSettings() {
  return settingsService.getSettings()
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
  if (currentCaptureWindow && !currentCaptureWindow.isDestroyed()) return { ok: false, reason: '截图任务仍在进行，请完成或关闭后重试。' }
  if (currentLongCapture) return { ok: false, reason: '长截图任务仍在进行，请完成或关闭后重试。' }
  if (recordWindow && !recordWindow.isDestroyed()) return { ok: false, reason: '录屏任务仍在进行，请完成或关闭后重试。' }
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
  if (role === 'capture') return win === currentCaptureWindow
  if (role === 'long-capture') return win === currentLongCapture?.controllerWindow
  if (role === 'long-overlay') return win === currentLongCapture?.overlayWindow
  if (role === 'pin') return pinWindows.has(win)
  if (role === 'recognition') return recognitionWindows.has(win)
  if (role === 'record') return win === recordWindow
  if (role === 'record-frame') return win === recordFrameWindow && win._recordOwner === recordWindow
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
    if (channel === 'capture:ready' && reason === 'window-owner-mismatch' && win && !win.isDestroyed() && win !== currentCaptureWindow) {
      win.close()
    }
  }
})

const shortcutService = new ShortcutService({
  globalShortcut,
  executeFunction: (name) => executeFunction(name),
  log
})

class SmartSelectSession {
  constructor(executablePath) {
    this.process = spawn(executablePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.buffer = ''
    this.nextRequestId = 1
    this.pending = new Map()
    this.windowRects = []
    this.ready = false
    this.available = true
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', (chunk) => this.handleOutput(chunk))
    this.process.stderr.setEncoding('utf8')
    this.process.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim()
      if (message) log('Smart select helper:', message)
    })
    this.process.once('error', (error) => this.handleExit(error))
    this.process.once('exit', (code) => this.handleExit(new Error(`helper exited (${code})`)))
  }

  handleOutput(chunk) {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) {
        try {
          const message = JSON.parse(line)
          if (message.ready) {
            this.ready = true
            this.windowRects = Array.isArray(message.windows) ? message.windows : []
            this.resolveReady(true)
          } else if (Number.isInteger(message.id)) {
            const request = this.pending.get(message.id)
            if (request) {
              clearTimeout(request.timer)
              this.pending.delete(message.id)
              request.resolve(Array.isArray(message.rects) ? message.rects : [])
            }
          }
        } catch (error) {
          log('Smart select response error:', error.message)
        }
      }
      newline = this.buffer.indexOf('\n')
    }
  }

  handleExit(error) {
    if (!this.available) return
    this.available = false
    if (!this.ready) this.rejectReady(error)
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.resolve([])
    }
    this.pending.clear()
  }

  async waitUntilReady(timeout = 1000) {
    let timer
    try {
      await Promise.race([
        this.readyPromise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('helper startup timeout')), timeout)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  query(x, y) {
    if (!this.available || !this.ready) return Promise.resolve([])
    const id = this.nextRequestId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const requests = [...this.pending.values()]
        this.pending.clear()
        this.available = false
        try { this.process.kill() } catch {}
        requests.forEach((request) => {
          clearTimeout(request.timer)
          request.resolve([])
        })
      }, 350)
      this.pending.set(id, { resolve, timer })
      try {
        this.process.stdin.write(`${id} ${Math.round(x)} ${Math.round(y)}\n`)
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve([])
      }
    })
  }

  findWindowAt(x, y) {
    const rect = this.windowRects.find((item) => (
      x >= item.left && x <= item.right && y >= item.top && y <= item.bottom
    ))
    return rect ? [rect] : []
  }

  dispose() {
    if (!this.available && this.process.killed) return
    this.available = false
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.resolve([])
    }
    this.pending.clear()
    try { this.process.stdin.end('quit\n') } catch {}
    try { this.process.kill() } catch {}
  }
}

async function createSmartSelectSession() {
  if (!isWin) return null
  const executablePath = app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'smart-select', 'SmartSelect.exe')
    : path.join(__dirname, 'native', 'smart-select', 'SmartSelect.exe')
  if (!fs.existsSync(executablePath)) {
    log('Smart select helper missing:', executablePath)
    return null
  }
  const session = new SmartSelectSession(executablePath)
  try {
    await session.waitUntilReady()
    return session
  } catch (error) {
    log('Smart select unavailable:', error.message)
    session.dispose()
    return null
  }
}

function convertSmartSelectRects(rects, context) {
  const physical = context.physicalBounds
  const logical = context.captureBounds
  if (!physical?.width || !physical?.height) return []
  const scaleX = logical.width / physical.width
  const scaleY = logical.height / physical.height
  const result = []
  for (const rect of rects) {
    const left = Math.max(0, Math.min(logical.width, (Number(rect.left) - physical.x) * scaleX))
    const top = Math.max(0, Math.min(logical.height, (Number(rect.top) - physical.y) * scaleY))
    const right = Math.max(0, Math.min(logical.width, (Number(rect.right) - physical.x) * scaleX))
    const bottom = Math.max(0, Math.min(logical.height, (Number(rect.bottom) - physical.y) * scaleY))
    const candidate = {
      x: Math.round(Math.min(left, right)),
      y: Math.round(Math.min(top, bottom)),
      w: Math.round(Math.abs(right - left)),
      h: Math.round(Math.abs(bottom - top))
    }
    if (candidate.w < 3 || candidate.h < 3) continue
    if (result.some((item) => item.x === candidate.x && item.y === candidate.y && item.w === candidate.w && item.h === candidate.h)) continue
    result.push(candidate)
  }
  return result
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

function imageDataToBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') {
    return Buffer.from(value.replace(/^data:image\/[^;]+;base64,/, ''), 'base64')
  }
  return Buffer.alloc(0)
}

function dataUrlToBuffer(dataUrl) {
  return imageDataToBuffer(dataUrl)
}

function bufferToDataUrl(value) {
  return `data:image/png;base64,${imageDataToBuffer(value).toString('base64')}`
}

function makeCaptureName(prefix = 'Highlighter') {
  // 使用中国时区(UTC+8)的墙钟时间命名,便于直接按本地时间识别截图
  const stamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `${prefix}_${stamp}.png`
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
    if (wasPinned) pinnedCount = Math.max(0, pinnedCount - 1)
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
  if (tray) tray.destroy()
  if (!getSettings().system.enableTray) return
  let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty()
  tray = new Tray(icon.resize({ width: 24, height: 24 }))
  tray.setToolTip('Highlighter')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '截图', accelerator: getSettings().shortcuts.screenshot || undefined, click: () => executeFunction('screenshot') },
    { label: '截取全屏', click: () => executeFunction('screenshotFullScreen') },
    { label: '截取焦点窗口', click: () => executeFunction('screenshotFocusedWindow') },
    { label: '固定图片到屏幕', click: () => executeFunction('fixedContent') },
    { label: '视频录制', click: () => executeFunction('videoRecord') },
    { type: 'separator' },
    { label: '截图历史', click: () => createMainWindow('history') },
    { label: '显示主界面', click: () => createMainWindow('home') },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]))
  tray.on('click', () => executeFunction('screenshot'))
  tray.on('double-click', () => createMainWindow('home'))
}

function initSelectionHook() {
  if (!selectionHookService) {
    selectionHookService = new SelectionHookService({
      createHook: () => {
        const SelectionHook = require('selection-hook')
        return new SelectionHook()
      },
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
  return selectionHookService.start('startup')
}

function registerSelectionPowerEvents() {
  if (selectionPowerListeners.length) return
  const bindings = [
    ['suspend', () => selectionHookService?.suspend('system-suspend')],
    ['lock-screen', () => selectionHookService?.suspend('lock-screen')],
    ['resume', () => selectionHookService?.scheduleRestart('system-resume')],
    ['unlock-screen', () => selectionHookService?.scheduleRestart('unlock-screen')]
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

async function getDesktopSource(display) {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    })
    const source = pickDesktopSource(sources, display.id)
    if (!source) throw new Error('未找到匹配显示器的桌面源')
    return source
  } catch (error) {
    throw new Error(`无法获取桌面录制源：${error.message || error}`)
  }
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
        const image = nativeImage.createFromBuffer(buffer)
        const size = image.getSize()
        const nativeBounds = getNativeDisplayBounds(nativeDisplay)
        if (size.width !== nativeBounds.width || size.height !== nativeBounds.height) {
          throw new Error(`原生抓屏尺寸异常：${size.width}x${size.height}`)
        }
        if (isBlankCapture(image)) throw new Error('原生抓屏返回空白画面')
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

async function createCaptureWindow(options = {}) {
  const createSeq = ++captureCreateSeq
  const performanceStartedAt = performance.now()
  const performanceTiming = {
    startedAt: performanceStartedAt,
    mode: options.mode || 'region',
    captureMs: 0,
    smartSelectMs: 0,
    windowLoadMs: 0
  }
  const mode = options.mode || 'region'
  const requestedBounds = options.windowBounds && {
    x: Math.round(options.windowBounds.x),
    y: Math.round(options.windowBounds.y),
    width: Math.max(1, Math.round(options.windowBounds.width)),
    height: Math.max(1, Math.round(options.windowBounds.height))
  }
  const display = options.display || (requestedBounds
    ? screen.getDisplayMatching(requestedBounds)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
  const captureBounds = requestedBounds || display.bounds
  const suppliedImageBuffer = options.imageBuffer
    ? imageDataToBuffer(options.imageBuffer)
    : options.imageDataUrl
      ? dataUrlToBuffer(options.imageDataUrl)
      : null
  const rawCapturePromise = suppliedImageBuffer || options.mode === 'canvas'
    ? Promise.resolve({
        imageBuffer: suppliedImageBuffer || Buffer.alloc(0),
        sourceId: '',
        scaleFactor: Number(options.sourceScaleFactor) || display.scaleFactor || 1
      })
    : getDisplayCapture(display)
  const capturePromise = Promise.resolve(rawCapturePromise).then((capture) => {
    performanceTiming.captureMs = Math.round((performance.now() - performanceStartedAt) * 100) / 100
    return capture
  })
  const smartSelectStartedAt = performance.now()
  const smartSelectPromise = (mode === 'region' ? createSmartSelectSession() : Promise.resolve(null)).then((session) => {
    performanceTiming.smartSelectMs = Math.round((performance.now() - smartSelectStartedAt) * 100) / 100
    return session
  })
  const smartSelectSession = await smartSelectPromise
  // Rapid hotkey presses start overlapping creations; only the newest one may
  // proceed. Superseded runs must bail out before creating a window, otherwise
  // their orphaned windows fail the capture IPC owner check and stay invisible
  // until the render watchdog reclaims them.
  if (createSeq !== captureCreateSeq) {
    smartSelectSession?.dispose()
    capturePromise.catch(() => {})
    return null
  }
  if (currentCaptureWindow && !currentCaptureWindow.isDestroyed()) currentCaptureWindow.close()
  const transparent = mode === 'canvas' || !!options.transparent
  const pagePath = path.join(__dirname, 'capture', 'capture.html')
  const captureWindow = createLocalWindow(pagePath, {
    x: captureBounds.x,
    y: captureBounds.y,
    width: Math.min(captureBounds.width, 800),
    height: Math.min(captureBounds.height, 600),
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00ffffff' : '#000000',
    fullscreenable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    opacity: 0,
    resizable: false,
    movable: false,
    hasShadow: !transparent,
    webPreferences: {
      preload: path.join(__dirname, 'preload-capture.js'),
      backgroundThrottling: false
    }
  })
  currentCaptureWindow = captureWindow
  captureWindow._editingPinWindow = options.editingPinWindow || null
  captureWindow._captureVisible = false
  captureWindow._captureInitSent = false
  captureWindow._captureRendererReady = false
  captureWindow._performanceTiming = performanceTiming
  captureWindow._smartSelectContext = smartSelectSession
    ? {
        session: smartSelectSession,
        captureBounds,
        physicalBounds: screen.dipToScreenRect(null, captureBounds)
      }
    : null
  captureWindow.setAlwaysOnTop(true, 'screen-saver')

  // Moving the hidden HWND first switches it to the target monitor's DPI.
  // Keeping opacity at zero prevents Windows from flashing the temporary size.
  captureWindow.setPosition(display.bounds.x, display.bounds.y, false)
  captureWindow.setBounds(captureBounds, false)
  // BrowserWindow fullscreen adds invisible border compensation on Windows 11
  // under mixed-DPI setups, making the renderer larger than the captured display.
  // The frameless screen-saver-level window already covers the full display bounds.
  captureWindow.setResizable(false)

  const loadStartedAt = performance.now()
  const loadPromise = captureWindow.loadFile(pagePath).then((result) => {
    performanceTiming.windowLoadMs = Math.round((performance.now() - loadStartedAt) * 100) / 100
    return result
  })
  captureWindow.on('closed', () => {
    clearTimeout(captureWindow._renderTimeout)
    captureWindow._smartSelectContext?.session.dispose()
    captureWindow._smartSelectContext = null
    if (currentCaptureWindow === captureWindow) currentCaptureWindow = null
    const pinWindow = captureWindow._pendingPinWindow || captureWindow._editingPinWindow
    setImmediate(() => bringPinToFront(pinWindow))
  })
  // Arm the render watchdog at creation time: a hung capture or page load must
  // still reclaim the invisible window instead of hiding it indefinitely.
  captureWindow._renderTimeout = setTimeout(() => {
    if (captureWindow.isDestroyed() || captureWindow._captureVisible) return
    const init = captureWindow._captureInit
    log('Capture render timeout:', init ? 'renderer-stalled' : 'initializing', JSON.stringify({
      expected: init?.captureBounds || null,
      window: captureWindow.getBounds(),
      content: captureWindow.getContentBounds()
    }))
    captureWindow.close()
  }, 8000)

  try {
    const [capture] = await Promise.all([capturePromise, loadPromise])
    if (captureWindow.isDestroyed()) return null
    captureWindow._captureInit = {
      imageBuffer: capture.imageBuffer || Buffer.alloc(0),
      mode,
      autoAction: options.autoAction || '',
      source: options.source || 'region',
      displayBounds: display.bounds,
      captureBounds,
      imageBounds: options.imageBounds || null,
      scaleFactor: capture.scaleFactor,
      editPin: !!options.editPin,
      smartSelect: !!captureWindow._smartSelectContext,
      cursorPosition: (() => {
        const point = screen.getCursorScreenPoint()
        return { x: point.x - captureBounds.x, y: point.y - captureBounds.y }
      })(),
      settings: getSettings()
    }
    sendCaptureInit(captureWindow)
    return captureWindow
  } catch (error) {
    if (!captureWindow.isDestroyed()) captureWindow.close()
    throw error
  }
}

function sendCaptureInit(win) {
  if (
    !win ||
    win.isDestroyed() ||
    !win._captureRendererReady ||
    !win._captureInit ||
    win._captureInitSent
  ) return false
  win._captureInitSent = true
  win.webContents.send('capture:init', win._captureInit)
  return true
}

function revealCaptureWindow(win) {
  if (!win || win.isDestroyed() || win._captureVisible) return
  clearTimeout(win._renderTimeout)
  win._captureVisible = true
  // Reveal the fully rendered surface in one step. Showing the window while
  // its opacity is still zero lets Windows/DWM present a transient frame.
  win.setOpacity(1)
  win.showInactive()
  setImmediate(() => {
    if (win.isDestroyed()) return
    win.focus()
  })
}

async function getDesktopSourceForDisplay(display) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 16, height: 16 } })
  const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0]
  if (!source) throw new Error('无法创建长截图屏幕采集源')
  return source
}

function placeLongCaptureController(display, selectionBounds, width = 420, height = 570) {
  const area = display.workArea
  const gap = 10
  const candidates = [
    { x: selectionBounds.x + selectionBounds.width + gap, y: selectionBounds.y },
    { x: selectionBounds.x - width - gap, y: selectionBounds.y },
    { x: selectionBounds.x, y: selectionBounds.y + selectionBounds.height + gap },
    { x: selectionBounds.x, y: selectionBounds.y - height - gap }
  ]
  const fits = (bounds) => bounds.x >= area.x && bounds.y >= area.y && bounds.x + width <= area.x + area.width && bounds.y + height <= area.y + area.height
  const candidate = candidates.find(fits)
  if (candidate) return { ...candidate, width, height }
  return {
    x: Math.max(area.x, area.x + area.width - width - gap),
    y: Math.max(area.y, area.y + area.height - height - gap),
    width,
    height
  }
}

function closeLongCapture() {
  const state = currentLongCapture
  if (!state || state.closing) return
  state.closing = true
  currentLongCapture = null
  if (state.overlayWindow && !state.overlayWindow.isDestroyed()) state.overlayWindow.close()
  if (state.controllerWindow && !state.controllerWindow.isDestroyed()) state.controllerWindow.close()
  state.session.cleanup()
}

function setLongOverlayEditing(state, enabled, axis, hasContent) {
  if (!state || state.overlayWindow.isDestroyed() || state.controllerWindow.isDestroyed()) return false
  state.selectionEditing = !!enabled
  state.overlayWindow.setFocusable(state.selectionEditing)
  state.overlayWindow.setIgnoreMouseEvents(!state.selectionEditing, { forward: true })
  state.overlayWindow.webContents.send('long-overlay:editing', {
    enabled: state.selectionEditing,
    lockedAxis: state.selectionEditing && hasContent ? (axis === 'horizontal' ? 'horizontal' : 'vertical') : ''
  })
  if (state.selectionEditing) {
    state.overlayWindow.moveTop()
    state.overlayWindow.focus()
    setImmediate(() => {
      if (!state.controllerWindow.isDestroyed()) state.controllerWindow.moveTop()
    })
  } else {
    state.controllerWindow.focus()
  }
  return true
}

async function createLongCaptureFromSelection(captureWindow, payload = {}) {
  if (dataRootMigrationInProgress) throw new Error('数据目录正在迁移，请稍候')
  if (!captureWindow || captureWindow.isDestroyed() || captureWindow !== currentCaptureWindow) throw new Error('截图选区已失效')
  const selected = payload.selection || {}
  const captureBounds = captureWindow._captureInit?.captureBounds
  if (!captureBounds) throw new Error('缺少截图显示器信息')
  const selectionBounds = {
    x: Math.round(captureBounds.x + Number(selected.x || 0)),
    y: Math.round(captureBounds.y + Number(selected.y || 0)),
    width: Math.max(1, Math.round(Number(selected.w || 0))),
    height: Math.max(1, Math.round(Number(selected.h || 0)))
  }
  if (selectionBounds.width < 80 || selectionBounds.height < 80) throw new Error('长截图选区至少需要 80 × 80 像素')

  closeLongCapture()
  const display = screen.getDisplayMatching(selectionBounds)
  const source = await getDesktopSourceForDisplay(display)
  assertManagedDataWritable()
  const settings = getSettings()
  const session = new LongCaptureSession({
    tempRoot: activePaths?.longCaptureCache || app.getPath('temp'),
    axis: settings.screenshot.longCaptureDirection
  })
  const overlayPagePath = path.join(__dirname, 'long-capture', 'overlay.html')
  const controllerPagePath = path.join(__dirname, 'long-capture', 'long-capture.html')
  const overlayWindow = createLocalWindow(overlayPagePath, {
    ...display.bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    resizable: false,
    movable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-long-overlay.js'),
      backgroundThrottling: false
    }
  })
  const controllerBounds = placeLongCaptureController(display, selectionBounds)
  const controllerWindow = createLocalWindow(controllerPagePath, {
    ...controllerBounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-long-capture.js'),
      backgroundThrottling: false
    }
  })
  const init = {
    sourceId: source.id,
    displayBounds: display.bounds,
    selectionBounds,
    scaleFactor: display.scaleFactor || 1,
    settings
  }
  currentLongCapture = { session, overlayWindow, controllerWindow, init, closing: false, finishing: false, selectionEditing: false }
  overlayWindow._longCaptureRole = 'overlay'
  controllerWindow._longCaptureRole = 'controller'
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  controllerWindow.setContentProtection(true)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  controllerWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.on('closed', () => {
    if (currentLongCapture?.overlayWindow === overlayWindow) closeLongCapture()
  })
  controllerWindow.on('closed', () => {
    if (currentLongCapture?.controllerWindow === controllerWindow) closeLongCapture()
  })

  try {
    await Promise.all([
      overlayWindow.loadFile(overlayPagePath),
      controllerWindow.loadFile(controllerPagePath)
    ])
    if (captureWindow.isDestroyed() || currentLongCapture?.controllerWindow !== controllerWindow) throw new Error('长截图窗口初始化已取消')
    captureWindow.close()
    overlayWindow.showInactive()
    controllerWindow.show()
    controllerWindow.focus()
    return true
  } catch (error) {
    closeLongCapture()
    throw error
  }
}

async function finishLongCapture(action, fast = false) {
  const state = currentLongCapture
  if (!state || state.finishing) throw new Error('长截图会话不可用')
  state.finishing = true
  try {
    const size = state.session.getSize()
    const outputPath = await state.session.render()
    const meta = {
      source: 'long-capture',
      action,
      width: size.width,
      height: size.height,
      scaleFactor: state.init.scaleFactor,
      selectionBounds: state.init.selectionBounds,
      longCapture: true,
      axis: state.session.axis
    }
    if (action === 'save') {
      const settings = getSettings()
      const preferredDirectory = settings.screenshot.saveDirectory
      let filePath = ''
      if (fast && preferredDirectory) {
        ensureDirectory(preferredDirectory)
        filePath = path.join(preferredDirectory, makeCaptureName('Highlighter_Long'))
      } else {
        const result = await dialog.showSaveDialog({
          title: '保存长截图',
          defaultPath: path.join(preferredDirectory || app.getPath('pictures'), makeCaptureName('Highlighter_Long')),
          filters: [{ name: 'PNG 图片', extensions: ['png'] }]
        })
        if (result.canceled || !result.filePath) {
          state.finishing = false
          return { canceled: true }
        }
        filePath = result.filePath
      }
      fs.copyFileSync(outputPath, filePath)
      await persistHistoryFile(outputPath, { ...meta, action: 'save' })
    } else {
      if (Math.max(size.width, size.height) > 65535 || size.width * size.height > 80000000) {
        throw new Error('长截图过大，当前仅支持保存为文件')
      }
      const image = nativeImage.createFromPath(outputPath)
      if (image.isEmpty()) throw new Error('长截图图片解码失败')
      if (action === 'copy') clipboard.writeImage(image)
      else if (action === 'pin') {
        if (pinnedCount >= MAX_PINNED) throw new Error(`最多固定 ${MAX_PINNED} 张图片`)
        createPinWindow(image.toDataURL(), meta)
      } else throw new Error('不支持的长截图操作')
      await persistHistoryFile(outputPath, meta)
    }
    setImmediate(closeLongCapture)
    return { ok: true }
  } catch (error) {
    state.finishing = false
    throw error
  }
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
  fs.writeFileSync(filePath, imageDataToBuffer(imageBuffer))
  return filePath
}

async function saveDataUrl(dataUrl, options = {}) {
  return saveImageBuffer(dataUrlToBuffer(dataUrl), options)
}

function getPixelAlignedPinSize(pixelWidth, pixelHeight, display, preferredSize = null) {
  const scaleFactor = Math.max(0.25, Number(display?.scaleFactor) || 1)
  const preferredWidth = Number(preferredSize?.width)
  const preferredHeight = Number(preferredSize?.height)
  return {
    width: Number.isFinite(preferredWidth) && preferredWidth > 0
      ? preferredWidth
      : Math.max(1, Number(pixelWidth) / scaleFactor),
    height: Number.isFinite(preferredHeight) && preferredHeight > 0
      ? preferredHeight
      : Math.max(1, Number(pixelHeight) / scaleFactor),
    scaleFactor
  }
}

function syncPinDisplayScale(win) {
  if (!win || win.isDestroyed() || !win._pinData) return false
  const data = win._pinData
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const aligned = getPixelAlignedPinSize(data.pixelWidth, data.pixelHeight, display)
  if (Math.abs(aligned.scaleFactor - Number(data.displayScaleFactor || 1)) < 0.001) return false
  data.displayScaleFactor = aligned.scaleFactor
  data.baseWidth = aligned.width
  data.baseHeight = aligned.height
  data.zoom = Math.max(0.2, Math.min(3, Number(data.zoom) || 1))
  const width = Math.max(1, Math.round(data.baseWidth * data.zoom))
  const fullHeight = Math.max(1, Math.round(data.baseHeight * data.zoom))
  const height = data.longCapture
    ? Math.min(Math.round(display.workArea.height * 0.55), fullHeight)
    : fullHeight
  win.setBounds({ x: bounds.x, y: bounds.y, width, height }, false)
  win.webContents.send('pin:zoom-changed', Math.round(data.zoom * 100))
  return true
}

function createPinWindow(dataUrl, meta = {}) {
  const image = nativeImage.createFromDataURL(dataUrl)
  const size = image.getSize()
  const selectionBounds = meta.selectionBounds && {
    x: Math.round(meta.selectionBounds.x),
    y: Math.round(meta.selectionBounds.y),
    width: Math.max(1, Math.round(meta.selectionBounds.width)),
    height: Math.max(1, Math.round(meta.selectionBounds.height))
  }
  const display = selectionBounds
    ? screen.getDisplayMatching(selectionBounds)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const maxWidth = Math.round(display.workArea.width * 0.55)
  const maxHeight = Math.round(display.workArea.height * 0.55)
  const longCapture = !!meta.longCapture
  const aligned = getPixelAlignedPinSize(size.width, size.height, display, selectionBounds)
  const baseWidth = aligned.width
  const baseHeight = aligned.height
  const zoom = longCapture
    ? Math.min(1, maxWidth / baseWidth)
    : (selectionBounds ? 1 : Math.min(1, maxWidth / baseWidth, maxHeight / baseHeight))
  const width = Math.max(1, Math.round(baseWidth * zoom))
  const height = longCapture
    ? Math.max(1, Math.min(maxHeight, Math.round(baseHeight * zoom)))
    : Math.max(1, Math.round(baseHeight * zoom))
  const cursor = screen.getCursorScreenPoint()
  const x = selectionBounds?.x ?? Math.round(Math.min(display.workArea.x + display.workArea.width - width, Math.max(display.workArea.x, cursor.x - width / 2)))
  const y = selectionBounds?.y ?? Math.round(Math.min(display.workArea.y + display.workArea.height - height, Math.max(display.workArea.y, cursor.y - 30)))
  const pagePath = path.join(__dirname, 'pin', 'pin.html')
  const win = createLocalWindow(pagePath, {
    width: Math.min(width, 200),
    height: Math.min(height, 160),
    x: display.bounds.x,
    y: display.bounds.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    opacity: 0,
    resizable: false,
    useContentSize: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-pin.js')
    }
  })
  win._pinData = {
    dataUrl,
    meta,
    opacity: getSettings().fixedContent.opacity,
    zoomWithMouse: getSettings().fixedContent.zoomWithMouse !== false,
    clickThrough: false,
    longCapture,
    pixelWidth: size.width,
    pixelHeight: size.height,
    displayScaleFactor: aligned.scaleFactor,
    baseWidth,
    baseHeight,
    zoom
  }
  win._pinVisible = false
  // Switch the HWND to the target monitor before applying the DIP content size.
  win.setPosition(display.bounds.x, display.bounds.y, false)
  win.setContentSize(width, height, false)
  win.setPosition(x, y, false)
  win.setBounds({ x, y, width, height }, false)
  pinWindows.add(win)
  pinnedCount++
  win.loadFile(pagePath)
  win.on('closed', () => {
    pinWindows.delete(win)
    pinnedCount = Math.max(0, pinnedCount - 1)
  })
  return win
}

function updatePinWindow(win, dataUrl, meta = {}) {
  if (!win || win.isDestroyed()) return null
  const image = nativeImage.createFromDataURL(dataUrl)
  const size = image.getSize()
  const currentBounds = win.getBounds()
  const targetBounds = meta.selectionBounds
    ? {
        x: Math.round(meta.selectionBounds.x),
        y: Math.round(meta.selectionBounds.y),
        width: Math.max(1, Math.round(meta.selectionBounds.width)),
        height: Math.max(1, Math.round(meta.selectionBounds.height))
      }
    : currentBounds
  const display = screen.getDisplayMatching(targetBounds)
  const aligned = getPixelAlignedPinSize(size.width, size.height, display, meta.selectionBounds)
  const nextBounds = {
    ...targetBounds,
    width: Math.max(1, Math.round(aligned.width)),
    height: Math.max(1, Math.round(aligned.height))
  }
  win._pinData = {
    ...win._pinData,
    dataUrl,
    meta,
    pixelWidth: size.width,
    pixelHeight: size.height,
    displayScaleFactor: aligned.scaleFactor,
    baseWidth: aligned.width,
    baseHeight: aligned.height,
    zoom: 1
  }
  win.setBounds(nextBounds, false)
  win.setBounds(nextBounds, false)
  win.webContents.send('pin:update', win._pinData)
  return win
}

function revealPinWindow(win) {
  if (!win || win.isDestroyed() || win._pinVisible) return
  win._pinVisible = true
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  setImmediate(() => {
    if (win.isDestroyed()) return
    win.setOpacity(Number(win._pinData?.opacity) || 1)
    win.moveTop()
    win.focus()
  })
}

function bringPinToFront(win) {
  if (!win || win.isDestroyed()) return
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setOpacity(Number(win._pinData?.opacity) || 1)
  win.show()
  win.moveTop()
  win.focus()
}

function setPinOpacity(win, opacity) {
  if (!win || win.isDestroyed()) return
  const nextOpacity = Math.max(0.25, Math.min(1, Number(opacity) || 1))
  if (win._pinData) win._pinData.opacity = nextOpacity
  win.setOpacity(nextOpacity)
}

async function startPinReannotation(win, imageBounds = {}, autoAction = '') {
  if (!win || win.isDestroyed() || !win._pinData) return null
  const pinBounds = win.getBounds()
  const editBounds = {
    x: Math.round(pinBounds.x + (Number(imageBounds.x) || 0)),
    y: Math.round(pinBounds.y + (Number(imageBounds.y) || 0)),
    width: Math.max(1, Math.round(Number(imageBounds.width) || pinBounds.width)),
    height: Math.max(1, Math.round(Number(imageBounds.height) || pinBounds.height))
  }
  const imageSize = nativeImage.createFromDataURL(win._pinData.dataUrl).getSize()
  const isOcrEditor = autoAction === 'ocr'
  let editorBounds = editBounds
  let editorImageBounds = null
  let sourceScaleFactor = Math.max(0.25, imageSize.width / editBounds.width)
  if (isOcrEditor) {
    const workArea = screen.getDisplayMatching(editBounds).workArea
    const actionSpace = 62
    const toolbarSpace = 900
    const scale = Math.min(
      1,
      workArea.width / editBounds.width,
      Math.max(1, workArea.height - actionSpace) / editBounds.height
    )
    const imageWidth = Math.max(1, Math.round(editBounds.width * scale))
    const imageHeight = Math.max(1, Math.round(editBounds.height * scale))
    const width = Math.min(workArea.width, Math.max(toolbarSpace, Math.max(420, imageWidth)))
    const height = Math.min(workArea.height, imageHeight + actionSpace)
    const x = Math.round(Math.max(workArea.x, Math.min(
      editBounds.x + (editBounds.width - width) / 2,
      workArea.x + workArea.width - width
    )))
    const y = Math.round(Math.max(workArea.y, Math.min(
      editBounds.y,
      workArea.y + workArea.height - height
    )))
    editorBounds = { x, y, width, height }
    editorImageBounds = {
      x: Math.round((width - imageWidth) / 2),
      y: 0,
      width: imageWidth,
      height: imageHeight
    }
    sourceScaleFactor = Math.max(0.25, imageSize.width / imageWidth)
  }
  win.hide()
  try {
    const captureWindow = await createCaptureWindow({
      imageBuffer: dataUrlToBuffer(win._pinData.dataUrl),
      mode: 'image',
      autoAction,
      source: 'pin-reannotate',
      windowBounds: editorBounds,
      imageBounds: editorImageBounds,
      transparent: isOcrEditor,
      sourceScaleFactor,
      editPin: true,
      editingPinWindow: win
    })
    if (!captureWindow) bringPinToFront(win)
    return captureWindow
  } catch (error) {
    bringPinToFront(win)
    throw error
  }
}

function createRecognitionWindow(type, dataUrl, options = {}) {
  if (!['table', 'qr'].includes(type)) throw new Error('不支持的识别类型')
  if (!dataUrl) throw new Error('识别图片数据为空')
  const isTable = type === 'table'
  const settings = getSettings()
  const pagePath = path.join(__dirname, 'recognition', 'recognition.html')
  const win = createLocalWindow(pagePath, {
    width: isTable ? 820 : 640,
    height: isTable ? 620 : 420,
    minWidth: isTable ? 600 : 480,
    minHeight: isTable ? 440 : 320,
    frame: false,
    show: false,
    backgroundColor: '#18181b',
    title: isTable ? 'Highlighter 表格识别' : 'Highlighter 二维码识别',
    webPreferences: {
      preload: path.join(__dirname, 'preload-recognition.js')
    }
  })
  recognitionWindows.add(win)
  win._recognitionInit = {
    type,
    dataUrl,
    scaleFactor: Number(options.scaleFactor) || 1,
    mainColor: settings.mainColor || '#1677ff'
  }
  win.loadFile(pagePath)
  win.on('closed', () => recognitionWindows.delete(win))
  return win
}

function pinFromCapture(event, imageData, meta) {
  const captureWindow = BrowserWindow.fromWebContents(event.sender)
  const editingPinWindow = captureWindow?._editingPinWindow
  if (!editingPinWindow && pinnedCount >= MAX_PINNED) throw new Error(`最多固定 ${MAX_PINNED} 张图片`)
  const dataUrl = typeof imageData === 'string' ? imageData : bufferToDataUrl(imageData)
  const pinWindow = editingPinWindow
    ? updatePinWindow(editingPinWindow, dataUrl, meta)
    : createPinWindow(dataUrl, meta)
  if (captureWindow) {
    captureWindow._pendingPinWindow = pinWindow
    captureWindow._editingPinWindow = null
  }
  return { captureWindow, pinWindow }
}

async function cleanupRecordSession(win, service = recordingService, allowBlocked = false) {
  const sessionId = win?._recordSessionId
  if (!sessionId || !service) return false
  win._recordSessionId = null
  return managedRecordingWriters.track(() => service.cleanupSession(sessionId), { allowBlocked })
}

async function closeRecordFlow(service = recordingService, allowBlockedCleanup = false) {
  const control = recordWindow
  const frame = recordFrameWindow
  if (recordWindow === control) recordWindow = null
  if (recordFrameWindow === frame) recordFrameWindow = null
  await cleanupRecordSession(control, service, allowBlockedCleanup).catch((error) => log('Recording cleanup failed:', error.message))
  restoreRecordFramePassthrough(frame)
  if (control && !control.isDestroyed()) control.close()
  if (frame && !frame.isDestroyed()) frame.close()
}

function restoreRecordFramePassthrough(frame = recordFrameWindow) {
  if (!frame || frame.isDestroyed()) return false
  frame.setIgnoreMouseEvents(true, { forward: true })
  return true
}

function getRecordControlBounds(selectionBounds, workArea) {
  const { width, height } = calculateRecordControlSize(workArea)
  const minX = workArea.x
  const maxX = workArea.x + workArea.width - width
  const minY = workArea.y
  const maxY = workArea.y + workArea.height - height
  const x = Math.max(minX, Math.min(maxX, Math.round(selectionBounds.x + (selectionBounds.width - width) / 2)))
  let y = selectionBounds.y + selectionBounds.height + 12
  if (y > maxY) y = selectionBounds.y - height - 12
  return { x, y: Math.max(minY, Math.min(maxY, Math.round(y))), width, height }
}

async function createRecordWindow(options = {}) {
  await closeRecordFlow()
  const requestedBounds = options.selectionBounds && {
    x: Math.round(Number(options.selectionBounds.x)),
    y: Math.round(Number(options.selectionBounds.y)),
    width: Math.round(Number(options.selectionBounds.width)),
    height: Math.round(Number(options.selectionBounds.height))
  }
  const display = options.display || (requestedBounds
    ? screen.getDisplayMatching(requestedBounds)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
  const selectionBounds = normalizeSelectionBounds(requestedBounds || display.bounds, display.bounds)
  const source = await getDesktopSource(display)
  const frameRate = normalizeFrameRate(getSettings().record.frameRate)
  const frameBounds = calculateFrameBounds(selectionBounds, 2)
  const controlBounds = getRecordControlBounds(selectionBounds, display.workArea)

  const framePagePath = path.join(__dirname, 'record', 'frame.html')
  const controlPagePath = path.join(__dirname, 'record', 'record.html')
  const frameWindow = createLocalWindow(framePagePath, {
    ...frameBounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-record-frame.js'),
      backgroundThrottling: false
    }
  })
  const controlWindow = createLocalWindow(controlPagePath, {
    ...controlBounds,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-record.js'),
      backgroundThrottling: false
    }
  })
  recordFrameWindow = frameWindow
  recordWindow = controlWindow
  frameWindow._recordOwner = controlWindow
  controlWindow._recordControlBounds = controlBounds
  controlWindow._recordFrameState = 'idle'
  controlWindow._recordAnnotationCommand = sanitizeAnnotationCommand({})
  controlWindow._recordInit = {
    sourceId: source.id,
    displayBounds: display.bounds,
    selectionBounds,
    frameRate
  }

  for (const win of [frameWindow, controlWindow]) {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setContentProtection(true)
  }
  restoreRecordFramePassthrough(frameWindow)
  controlWindow.on('closed', () => {
    cleanupRecordSession(controlWindow).catch((error) => log('Recording cleanup failed:', error.message))
    if (recordWindow === controlWindow) recordWindow = null
    if (recordFrameWindow?._recordOwner === controlWindow) {
      const ownedFrame = recordFrameWindow
      recordFrameWindow = null
      if (!ownedFrame.isDestroyed()) ownedFrame.close()
    }
  })
  frameWindow.on('closed', () => {
    if (recordFrameWindow === frameWindow) recordFrameWindow = null
  })
  await Promise.all([
    frameWindow.loadFile(framePagePath),
    controlWindow.loadFile(controlPagePath)
  ])
  frameWindow.showInactive()
  controlWindow.show()
  return controlWindow
}

function togglePinVisibility() {
  const shouldShow = [...pinWindows].some((win) => !win.isDestroyed() && !win.isVisible())
  pinWindows.forEach((win) => {
    if (win.isDestroyed()) return
    if (shouldShow) win.showInactive()
    else win.hide()
  })
}

async function executeFunction(name, payload = {}) {
  switch (name) {
    case 'screenshot': await createCaptureWindow({ mode: 'region', source: 'region' }); return true
    case 'screenshotDelay': {
      const seconds = Math.max(0, Number(payload.seconds ?? 3))
      setTimeout(() => createCaptureWindow({ mode: 'region', source: 'delay' }).catch((error) => log(error.message)), seconds * 1000)
      return { scheduled: true, seconds }
    }
    case 'screenshotFixed': await createCaptureWindow({ mode: 'region', autoAction: 'pin', source: 'fixed' }); return true
    case 'screenshotOcr': await createCaptureWindow({ mode: 'region', autoAction: 'ocr', source: 'ocr' }); return true
    case 'screenshotTable': await createCaptureWindow({ mode: 'region', autoAction: 'table', source: 'table' }); return true
    case 'screenshotQr': await createCaptureWindow({ mode: 'region', autoAction: 'qr', source: 'qr' }); return true
    case 'screenshotOcrTranslate': await createCaptureWindow({ mode: 'region', autoAction: 'translate', source: 'ocr-translate' }); return true
    case 'screenshotCopy': await createCaptureWindow({ mode: 'region', autoAction: 'copy', source: 'copy' }); return true
    case 'screenshotLong': await createCaptureWindow({ mode: 'region', autoAction: 'long', source: 'long-capture' }); return true
    case 'screenshotFullScreen': await createCaptureWindow({ mode: 'fullscreen', autoAction: payload.save ? 'save' : 'copy', source: 'fullscreen' }); return true
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
      createPinWindow(dataUrl, { source: 'file' })
      persistHistory(dataUrl, { source: 'file', action: 'pin' })
      return true
    }
    case 'videoRecord': {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      await createRecordWindow({ display, selectionBounds: display.bounds })
      return true
    }
    case 'fullScreenDraw': await createCaptureWindow({ mode: 'canvas', source: 'canvas' }); return true
    case 'toggleFixedContentVisibility': togglePinVisibility(); return true
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
    case 'translation': createMainWindow('translation'); return true
    case 'chat': createMainWindow('chat'); return true
    default: throw new Error(`未知功能：${name}`)
  }
}

function registerShortcuts() {
  return shortcutService.registerAll(getSettings().shortcuts)
}

async function stopManagedDataWriters() {
  const activeOcrService = ocrService
  if (activeOcrService) {
    const inFlight = [...activeOcrService.inFlight.values()]
    activeOcrService.stop()
    await Promise.allSettled(inFlight)
    if (ocrService === activeOcrService) ocrService = null
  }

  const activeRecordingService = recordingService
  await closeRecordFlow(activeRecordingService, true)
  try {
    if (activeRecordingService) await activeRecordingService.dispose()
  } finally {
    if (recordingService === activeRecordingService) recordingService = null
  }

  const longCapture = currentLongCapture
  if (longCapture?.finishingPromise) {
    await longCapture.finishingPromise.catch((error) => log('Long capture shutdown failed:', error.message))
  }
  closeLongCapture()
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
    if (patch.shortcuts) registerShortcuts()
    if (patch.system?.autoStart !== undefined) app.setLoginItemSettings({ openAtLogin: !!settings.system.autoStart })
    if (patch.system?.enableTray !== undefined) createTrayIcon()
    if (patch.system?.updateChannel !== undefined) updateService?.setChannel(settings.system.updateChannel)
    if (patch.plugins?.ocr === false && ocrService) { ocrService.stop(); ocrService = null }
    if (patch.plugins?.ocr === true && settings.ocr.hotStart) getOcrService().ensureStarted().catch((error) => log('OCR hot start failed:', error.message))
    if (patch.theme !== undefined || patch.mainColor !== undefined) broadcastActionAppearance(settings)
    if (patch.selectionToolbar?.clipboardFallback !== undefined) {
      selectionHookService?.updateStartOptions({ enableClipboard: settings.selectionToolbar.clipboardFallback })
    }
  },
  onSettingsReset: (settings) => {
    registerShortcuts()
    broadcastActionAppearance(settings)
    updateService?.setChannel(settings.system.updateChannel)
    selectionHookService?.updateStartOptions({ enableClipboard: settings.selectionToolbar.clipboardFallback })
  },
  validateApiKey: async (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return require('./deepseek').validateApiKey(input)
    }
    const provider = input.provider || input
    const result = await require('./deepseek').testProviderConnection(provider, {
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
  const url = new URL(String(value || ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持打开 HTTP 或 HTTPS 链接')
  return shell.openExternal(url.toString())
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
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
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
      return require('./deepseek').completeChat(
        resolveAiAssignment(settings, 'chat'),
        messages,
        { maxTokens: settings.ai.maxTokens, temperature: settings.ai.temperature, ...(options || {}) }
      )
    },
    translateText: (text, sourceLanguage, targetLanguage) => {
      const settings = getSettings()
      return require('./deepseek').translateText(
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
    await createCaptureWindow({ imageBuffer: await fs.promises.readFile(item.filePath), mode: 'image', source: 'history' })
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
  chooseExportDirectory: async () => {
    const result = await dialog.showOpenDialog({
      title: '选择截图导出目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? '' : result.filePaths[0]
  }
})

const captureIpcController = {
  ready: (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  win._captureRendererReady = true
  sendCaptureInit(win)
  },
  renderReady: (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  revealCaptureWindow(win)
  if (win?._captureInit) {
    const timing = win._performanceTiming
    if (timing) {
      const bounds = win._captureInit.captureBounds || {}
      performanceMonitor.record('capture.interactive', performance.now() - timing.startedAt, {
        mode: timing.mode,
        captureMs: timing.captureMs,
        smartSelectMs: timing.smartSelectMs,
        windowLoadMs: timing.windowLoadMs,
        width: Number(bounds.width) || 0,
        height: Number(bounds.height) || 0,
        scaleFactor: Number(win._captureInit.scaleFactor) || 1
      })
      performanceMonitor.snapshot('capture-interactive', { mode: timing.mode })
      win._performanceTiming = null
    }
    win._captureInit.imageBuffer = null
  }
  },
  renderError: (event, message) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  log('Capture render failed:', message || 'image decode failed')
  win.close()
  },
  close: (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  win?.close()
  },
  startRegionRecording: async (event, { selectionBounds } = {}) => {
  const captureWindow = BrowserWindow.fromWebContents(event.sender)
  if (!captureWindow || captureWindow !== currentCaptureWindow || captureWindow.isDestroyed()) {
    throw new Error('无效的截图窗口')
  }
  const bounds = {
    x: Number(selectionBounds?.x),
    y: Number(selectionBounds?.y),
    width: Number(selectionBounds?.width),
    height: Number(selectionBounds?.height)
  }
  if (!Object.values(bounds).every(Number.isFinite)) throw new Error('录制区域无效')
  const display = screen.getDisplayMatching(bounds)
  await createRecordWindow({ display, selectionBounds: bounds })
  if (!captureWindow.isDestroyed()) captureWindow.close()
  return true
  },
  startLong: (event, payload) => createLongCaptureFromSelection(BrowserWindow.fromWebContents(event.sender), payload),
  smartSelect: async (event, point = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const context = win?._smartSelectContext
  if (!context || win.isDestroyed()) return []
  const localX = Math.max(0, Math.min(context.captureBounds.width, Number(point.x) || 0))
  const localY = Math.max(0, Math.min(context.captureBounds.height, Number(point.y) || 0))
  const physicalX = context.physicalBounds.x + localX * context.physicalBounds.width / context.captureBounds.width
  const physicalY = context.physicalBounds.y + localY * context.physicalBounds.height / context.captureBounds.height
  let rects = await context.session.query(physicalX, physicalY)
  if (!rects.length) rects = context.session.findWindowAt(physicalX, physicalY)
  const candidates = convertSmartSelectRects(rects, context)
  return candidates.length
    ? candidates
    : [{ x: 0, y: 0, w: context.captureBounds.width, h: context.captureBounds.height }]
  },
  copy: (_event, { imageBuffer, dataUrl, meta } = {}) => {
  const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
  if (!buffer.length) throw new Error('截图图片数据为空')
  clipboard.writeImage(nativeImage.createFromBuffer(buffer))
  const item = persistHistory(buffer, { ...meta, action: 'copy' })
  if (getSettings().screenshot.autoSaveOnCopy && getSettings().screenshot.saveDirectory) saveImageBuffer(buffer, { fast: true }).catch((error) => log(error.message))
  return item
  },
  save: (event, { imageBuffer, dataUrl, meta, fast } = {}) => {
  const captureWindow = BrowserWindow.fromWebContents(event.sender)
  const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
  if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
  setImmediate(async () => {
    try {
      if (!buffer.length) throw new Error('截图图片数据为空')
      const filePath = await saveImageBuffer(buffer, { fast: !!fast })
      if (filePath) persistHistory(buffer, { ...meta, action: 'save' })
    } catch (error) {
      log('Capture save failed:', error.message)
      dialog.showErrorBox('保存截图失败', error.message || String(error))
    }
  })
  },
  pin: (event, { imageBuffer, dataUrl, meta } = {}) => {
  const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
  pinFromCapture(event, buffer, meta)
  return persistHistory(buffer, { ...meta, action: 'pin' })
  },
  pinReannotate: (event, { imageBuffer, dataUrl, meta, action } = {}) => {
  const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
  const { captureWindow, pinWindow } = pinFromCapture(event, buffer, meta)
  pinWindow._pendingReannotateAction = action === 'ocr' ? 'ocr' : ''
  setImmediate(() => {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
  })
  return persistHistory(buffer, { ...meta, action: 'pin' })
  },
  openRecognition: (event, { type, imageBuffer, dataUrl, meta } = {}) => {
  const captureWindow = BrowserWindow.fromWebContents(event.sender)
  const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
  createRecognitionWindow(type, bufferToDataUrl(buffer), { scaleFactor: meta?.scaleFactor })
  setImmediate(() => {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
  })
  return persistHistory(buffer, { ...meta, action: type })
  },
  recordHistory: (_event, { imageBuffer, dataUrl, meta } = {}) => persistHistory(imageBuffer ?? dataUrl, meta),
  longReady: (event) => {
  const state = currentLongCapture
  if (!state || event.sender !== state.controllerWindow.webContents) return
  event.sender.send('long-capture:init', state.init)
  },
  longOverlayReady: (event) => {
  const state = currentLongCapture
  if (!state || event.sender !== state.overlayWindow.webContents) return
  event.sender.send('long-overlay:init', {
    displayBounds: state.init.displayBounds,
    selectionBounds: state.init.selectionBounds,
    mainColor: state.init.settings.mainColor
  })
  },
  longOverlayActive: (event, active) => {
  const state = currentLongCapture
  if (!state || event.sender !== state.controllerWindow.webContents || state.overlayWindow.isDestroyed()) return
  state.overlayWindow.webContents.send('long-overlay:active', !!active)
  },
  longAddStrip: (event, { arrayBuffer, metadata } = {}) => {
  if (dataRootMigrationInProgress) throw new Error('数据目录正在迁移，请稍候')
  const state = currentLongCapture
  if (!state || event.sender !== state.controllerWindow.webContents || state.finishing) throw new Error('长截图会话不可用')
  if (!state.session.strips.length && ['vertical', 'horizontal'].includes(metadata?.axis)) {
    state.session.axis = metadata.axis
    settingsService.updateSettings({ screenshot: { longCaptureDirection: metadata.axis } })
  }
  return state.session.addStrip(Buffer.from(arrayBuffer), metadata)
  },
  longSetTrim: (event, { start, end } = {}) => {
  const state = currentLongCapture
  if (!state || event.sender !== state.controllerWindow.webContents || state.finishing) throw new Error('长截图会话不可用')
  return state.session.setTrim(start, end)
  },
  longSetSelectionEditing: (event, { enabled, axis, hasContent } = {}) => {
  const state = currentLongCapture
  if (!state || event.sender !== state.controllerWindow.webContents || state.finishing) throw new Error('长截图会话不可用')
  return setLongOverlayEditing(state, enabled, axis, hasContent)
  },
  longOverlayBoundsChanged: (event, proposed = {}) => {
  const state = currentLongCapture
  if (!state || event.sender !== state.overlayWindow.webContents || !state.selectionEditing || state.finishing) return
  const display = state.init.displayBounds
  const previous = state.init.selectionBounds
  let next = {
    x: Math.round(Number(proposed.x) || display.x),
    y: Math.round(Number(proposed.y) || display.y),
    width: Math.max(80, Math.round(Number(proposed.width) || previous.width)),
    height: Math.max(80, Math.round(Number(proposed.height) || previous.height))
  }
  if (state.session.strips.length) {
    if (state.session.axis === 'vertical') next = { ...previous, y: next.y }
    else next = { ...previous, x: next.x }
  }
  next.width = Math.min(display.width, next.width)
  next.height = Math.min(display.height, next.height)
  next.x = Math.max(display.x, Math.min(display.x + display.width - next.width, next.x))
  next.y = Math.max(display.y, Math.min(display.y + display.height - next.height, next.y))
  state.init.selectionBounds = next
  if (!state.controllerWindow.isDestroyed()) state.controllerWindow.webContents.send('long-capture:selection-updated', next)
  },
  longFinish: (event, { action, fast } = {}) => {
  if (dataRootMigrationInProgress) throw new Error('数据目录正在迁移，请稍候')
  const state = currentLongCapture
  if (!state || event.sender !== state.controllerWindow.webContents) throw new Error('长截图会话不可用')
  const finishingPromise = finishLongCapture(action, fast)
  state.finishingPromise = finishingPromise
  return finishingPromise.finally(() => {
    if (state.finishingPromise === finishingPromise) state.finishingPromise = null
  })
  },
  longClose: (event) => {
  const state = currentLongCapture
  if (state && event.sender === state.controllerWindow.webContents) closeLongCapture()
  },
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
  const translation = await require('./deepseek').translateText(
    resolveAiAssignment(settings, 'ocr-translate'),
    text,
    'auto',
    settings.ai.targetLanguage
  )
  return { text, translation, ocrResult }
  },
  recognitionReady: (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !recognitionWindows.has(win) || !win._recognitionInit) return
  event.sender.send('recognition:init', win._recognitionInit)
  win.show()
  win.focus()
  },
  recognitionTable: async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !recognitionWindows.has(win)) throw new Error('无效的表格识别窗口')
  if (!getSettings().plugins.ocr) throw new Error('请先在插件页面启用文本识别')
  const dataUrl = payload?.dataUrl
  if (!dataUrl) throw new Error('表格图片数据为空')
  const settings = getSettings()
  const ocrResult = await recognizeWithPerformance(dataUrlToBuffer(dataUrl), {
    scaleFactor: payload?.scaleFactor,
    detectAngle: settings.ocr.detectAngle,
    minConfidence: settings.ocr.minConfidence
  }, 'table')
  const table = buildTableFromOcr(ocrResult, { minConfidence: settings.ocr.minConfidence })
  if (!table) throw new Error('未识别到稳定的表格结构，请扩大选区并确保至少包含两行两列')
  return table
  },
  recognitionCopy: (event, value) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !recognitionWindows.has(win)) throw new Error('无效的识别结果窗口')
  clipboard.writeText(String(value || ''))
  return true
  },
  recognitionClose: (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && recognitionWindows.has(win) && !win.isDestroyed()) win.close()
  }
}

registerCaptureIpc({
  ipcMain: secureIpcMain,
  controller: captureIpcController
})

secureIpcMain.on('pin:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win?._pinData) event.sender.send('pin:init', win._pinData)
})
secureIpcMain.on('pin:render-ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  revealPinWindow(win)
  const autoAction = win?._pendingReannotateAction
  if (!autoAction) return
  win._pendingReannotateAction = ''
  setTimeout(() => {
    startPinReannotation(win, {}, autoAction).catch((error) => {
      log('Auto reannotate pin failed:', error.message)
      bringPinToFront(win)
    })
  }, 80)
})
secureIpcMain.on('pin:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
secureIpcMain.on('pin:copy', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win?._pinData) clipboard.writeImage(nativeImage.createFromDataURL(win._pinData.dataUrl))
})
secureIpcMain.on('pin:save', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win?._pinData) await saveDataUrl(win._pinData.dataUrl)
})
secureIpcMain.on('pin:context-menu', (event, imageBounds = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win?._pinData) return
  const menu = Menu.buildFromTemplate([
    {
      label: '重新标注',
      click: async () => {
        try {
          await startPinReannotation(win, imageBounds)
        } catch (error) {
          log('Reannotate pin failed:', error.message)
        }
      }
    },
    {
      label: '文本识别',
      enabled: !!getSettings().plugins.ocr,
      click: async () => {
        try {
          await startPinReannotation(win, imageBounds, 'ocr')
        } catch (error) {
          log('OCR pin failed:', error.message)
        }
      }
    },
    {
      label: '表格识别',
      enabled: !!getSettings().plugins.ocr,
      click: () => {
        try {
          createRecognitionWindow('table', win._pinData.dataUrl, { scaleFactor: win._pinData.scaleFactor })
        } catch (error) {
          log('Table recognition failed:', error.message)
        }
      }
    },
    {
      label: '二维码识别',
      click: () => {
        try {
          createRecognitionWindow('qr', win._pinData.dataUrl, { scaleFactor: win._pinData.scaleFactor })
        } catch (error) {
          log('QR recognition failed:', error.message)
        }
      }
    },
    { type: 'separator' },
    {
      label: '透明度',
      submenu: [1, 0.75, 0.5, 0.25].map((opacity) => ({
        label: `${Math.round(opacity * 100)}%`,
        type: 'radio',
        checked: Math.abs((Number(win._pinData.opacity) || 1) - opacity) < 0.005,
        click: () => setPinOpacity(win, opacity)
      }))
    },
    { type: 'separator' },
    { label: '复制', click: () => clipboard.writeImage(nativeImage.createFromDataURL(win._pinData.dataUrl)) },
    { label: '保存', click: () => saveDataUrl(win._pinData.dataUrl).catch((error) => log(error.message)) },
    { type: 'separator' },
    { label: '关闭', click: () => { if (!win.isDestroyed()) win.close() } }
  ])
  menu.popup({ window: win })
})
secureIpcMain.on('pin:resize', (event, { factor } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !win._pinData?.zoomWithMouse) return
  const bounds = win.getBounds()
  const data = win._pinData
  const currentZoom = Number(data.zoom) || 1
  const nextZoom = Math.max(0.2, Math.min(3, currentZoom * (Number(factor) || 1)))
  if (Math.abs(nextZoom - currentZoom) < 0.001) return
  const width = Math.max(1, Math.round(data.baseWidth * nextZoom))
  const height = Math.max(1, Math.round(data.baseHeight * nextZoom))
  data.zoom = nextZoom
  win.setBounds({ x: bounds.x, y: bounds.y, width, height }, false)
  win.webContents.send('pin:zoom-changed', Math.round(nextZoom * 100))
})
secureIpcMain.on('pin:move-start', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  win._pinMove = { point: screen.getCursorScreenPoint(), bounds: win.getBounds() }
})
secureIpcMain.on('pin:move', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win?._pinMove) return
  const { point: start, bounds } = win._pinMove
  const point = screen.getCursorScreenPoint()
  win.setBounds({
    x: Math.round(bounds.x + point.x - start.x),
    y: Math.round(bounds.y + point.y - start.y),
    width: bounds.width,
    height: bounds.height
  }, false)
})
secureIpcMain.on('pin:move-end', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) {
    win._pinMove = null
    syncPinDisplayScale(win)
  }
})
secureIpcMain.on('pin:toggle-click-through', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  win._pinData.clickThrough = !win._pinData.clickThrough
  win.setIgnoreMouseEvents(win._pinData.clickThrough, { forward: true })
})

function requireRecordSender(event) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win !== recordWindow || win.isDestroyed()) throw new Error('无效的录制窗口')
  return win
}

function requireRecordFrameSender(event) {
  const frame = BrowserWindow.fromWebContents(event.sender)
  if (!frame || frame !== recordFrameWindow || frame.isDestroyed() || frame._recordOwner !== recordWindow) {
    throw new Error('无效的录制标注窗口')
  }
  return frame
}

function sendRecordAnnotationCommand(control, payload = {}) {
  const frame = recordFrameWindow
  if (!control || control !== recordWindow || control.isDestroyed() || !frame || frame.isDestroyed() || frame._recordOwner !== control) return false
  const sanitized = sanitizeAnnotationCommand({ ...control._recordAnnotationCommand, ...payload })
  const enabled = ['recording', 'paused'].includes(control._recordFrameState)
  const message = { ...sanitized, enabled, tool: enabled ? sanitized.tool : 'pointer' }
  control._recordAnnotationCommand = { ...sanitized, action: '' }
  frame.setIgnoreMouseEvents(message.tool === 'pointer', { forward: true })
  frame.webContents.send('record-frame:command', message)
  return message
}

function requireRecordSession(win, sessionId) {
  if (!sessionId || win._recordSessionId !== sessionId) throw new Error('录制会话不匹配')
  return sessionId
}

const recordingIpcController = {
  ready: (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win === recordWindow && win?._recordInit) event.sender.send('record:init', win._recordInit)
  },
  frameReady: (event) => {
  const frame = requireRecordFrameSender(event)
  sendRecordAnnotationCommand(frame._recordOwner)
  },
  frameSnapshot: (event, snapshot = {}) => {
  const frame = requireRecordFrameSender(event)
  const control = frame._recordOwner
  const bounds = control._recordInit.selectionBounds
  const clean = sanitizeAnnotationSnapshot(snapshot, { width: bounds.width, height: bounds.height })
  control.webContents.send('record:annotation-snapshot', clean)
  },
  performance: (event, metrics = {}) => {
  requireRecordSender(event)
  const durationMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(metrics.durationMs) || 0))
  const targetFrameRate = normalizeFrameRate(metrics.targetFrameRate)
  const callbacks = Math.max(0, Math.min(100000000, Math.round(Number(metrics.callbacks) || 0)))
  const renderedFrames = Math.max(0, Math.min(callbacks, Math.round(Number(metrics.renderedFrames) || 0)))
  const skippedCallbacks = Math.max(0, Math.min(callbacks, Math.round(Number(metrics.skippedCallbacks) || 0)))
  const scheduler = metrics.scheduler === 'video-frame' ? 'video-frame' : 'timer'
  performanceMonitor.record('record.compositor', durationMs, {
    targetFrameRate,
    callbacks,
    renderedFrames,
    skippedCallbacks,
    scheduler,
    effectiveFrameRate: durationMs > 0 ? Math.round(renderedFrames * 100000 / durationMs) / 100 : 0
  })
  performanceMonitor.snapshot('record-compositor', { targetFrameRate, scheduler })
  },
  setAnnotationCommand: (event, command = {}) => {
  const control = requireRecordSender(event)
  return sendRecordAnnotationCommand(control, command)
  },
  startSession: async (event) => {
  assertManagedDataWritable()
  const win = requireRecordSender(event)
  const service = getRecordingService()
  await cleanupRecordSession(win, service)
  managedRecordingWriters.assertOpen()
  const session = await managedRecordingWriters.track(() => service.startSession())
  win._recordSessionId = session.id
  return { id: session.id }
  },
  appendChunk: async (event, { sessionId, arrayBuffer } = {}) => {
  assertManagedDataWritable()
  const win = requireRecordSender(event)
  requireRecordSession(win, sessionId)
  const service = getRecordingService()
  await managedRecordingWriters.track(service.appendChunk(sessionId, Buffer.from(arrayBuffer || [])))
  return true
  },
  finishSession: async (event, { sessionId } = {}) => {
  assertManagedDataWritable()
  const win = requireRecordSender(event)
  requireRecordSession(win, sessionId)
  const service = getRecordingService()
  return managedRecordingWriters.track(service.finishSession(sessionId))
  },
  saveMp4: async (event, { sessionId, durationMs } = {}) => {
  assertManagedDataWritable()
  const win = requireRecordSender(event)
  requireRecordSession(win, sessionId)
  const settings = getSettings()
  const directory = settings.record.saveDirectory || app.getPath('videos')
  let result
  win.setAlwaysOnTop(false)
  try {
    result = await dialog.showSaveDialog(win, {
      title: '保存 MP4 录屏',
      defaultPath: path.join(directory, makeCaptureName('Highlighter_Video').replace('.png', '.mp4')),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    })
  } finally {
    if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver')
  }
  if (result.canceled || !result.filePath) return ''
  assertManagedDataWritable()
  const duration = Math.max(1, Number(durationMs) || 1)
  const service = getRecordingService()
  const outputPath = await managedRecordingWriters.track(service.transcode(sessionId, result.filePath, (elapsedMicroseconds) => {
    if (win.isDestroyed()) return
    const percent = calculateTranscodeProgress(elapsedMicroseconds, duration)
    win.webContents.send('record:save-progress', percent)
  }))
  if (!win.isDestroyed()) win.webContents.send('record:save-progress', 100)
  win._recordSessionId = null
  await managedRecordingWriters.track(service.cleanupSession(sessionId))
  return outputPath
  },
  cancelSession: async (event, { sessionId } = {}) => {
  assertManagedDataWritable()
  const win = requireRecordSender(event)
  requireRecordSession(win, sessionId)
  win._recordSessionId = null
  const service = getRecordingService()
  await managedRecordingWriters.track(service.cleanupSession(sessionId))
  return true
  },
  setFrameState: (event, state = 'idle') => {
  const control = requireRecordSender(event)
  const frame = recordFrameWindow
  if (!frame || frame.isDestroyed()) return false
  control._recordFrameState = ['recording', 'paused'].includes(state) ? state : 'idle'
  sendRecordAnnotationCommand(control)
  if (state === 'hidden') {
    restoreRecordFramePassthrough(frame)
    frame.hide()
  }
  else {
    frame.showInactive()
    frame.webContents.send('record-frame:state', ['recording', 'paused'].includes(state) ? state : 'idle')
  }
  return true
  },
  resizePreview: (event) => {
  const win = requireRecordSender(event)
  const display = screen.getDisplayMatching(win._recordInit.selectionBounds)
  const width = Math.min(760, display.workArea.width)
  const height = Math.min(560, display.workArea.height)
  win.setBounds({
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
    width,
    height
  }, false)
  return true
  },
  restart: async (event, { sessionId } = {}) => {
  assertManagedDataWritable()
  const win = requireRecordSender(event)
  if (sessionId) requireRecordSession(win, sessionId)
  await cleanupRecordSession(win, getRecordingService())
  win.setBounds(win._recordControlBounds, false)
  if (recordFrameWindow && !recordFrameWindow.isDestroyed()) {
    win._recordFrameState = 'idle'
    const resetVersion = Number(win._recordAnnotationCommand?.resetVersion || 0) + 1
    sendRecordAnnotationCommand(win, { action: 'reset', resetVersion })
    restoreRecordFramePassthrough(recordFrameWindow)
    recordFrameWindow.showInactive()
    recordFrameWindow.webContents.send('record-frame:state', 'idle')
  }
  return true
  },
  close: (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win !== recordWindow) return
  closeRecordFlow().catch((error) => log('Recording close failed:', error.message))
  }
}

registerRecordingIpc({
  ipcMain: secureIpcMain,
  controller: recordingIpcController
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
  const aiRuntime = resolveToolbarAiProvider(getSettings(), action)
  if (!aiRuntime?.apiKey) { createMainWindow('models'); hideToolbar(); return }
  hideToolbar()
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
})
secureIpcMain.on('window:toggle-pin', (event, shouldPin) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (shouldPin && pinnedCount >= MAX_PINNED) return event.sender.send('window:pin-denied', { max: MAX_PINNED })
  if (shouldPin && !win._isPinned) { win._isPinned = true; pinnedCount++; win.setAlwaysOnTop(true, 'floating') }
  if (!shouldPin && win._isPinned) { win._isPinned = false; pinnedCount = Math.max(0, pinnedCount - 1); win.setAlwaysOnTop(false) }
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
    closeRecordFlow()
      .then(() => recordingService?.dispose())
      .catch((error) => log('Recording shutdown failed:', error.message))
      .finally(() => { recordingService = null })
    closeLongCapture()
    if (ocrService) { ocrService.stop(); ocrService = null }
    disposeSelectionHook()
    if (tray) { tray.destroy(); tray = null }
  })
}
