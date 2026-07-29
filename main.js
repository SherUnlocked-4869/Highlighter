const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  Tray
} = require('electron')
const { prepareDataRoot, removeProvisionalRoot } = require('./main/services/data-root-bootstrap')
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
const { SettingsService } = require('./main/services/settings-service')
const { registerSettingsIpc } = require('./main/ipc/settings-ipc')
const { HistoryService } = require('./main/services/history-service')
const { registerHistoryIpc } = require('./main/ipc/history-ipc')
const { ShortcutService } = require('./main/services/shortcut-service')
const { registerShortcutIpc } = require('./main/ipc/shortcut-ipc')
const { registerAppIpc } = require('./main/ipc/app-ipc')
const { registerDataRootIpc } = require('./main/ipc/data-root-ipc')
const { registerCaptureIpc } = require('./main/ipc/capture-ipc')
const { registerRecordingIpc } = require('./main/ipc/recording-ipc')
const { SelectionHookService } = require('./main/services/selection-hook-service')
const { ToolbarStreamSession } = require('./main/services/toolbar-stream-session')
const { name: applicationName } = require('./package.json')

const dataRootContext = prepareDataRoot({ app, applicationName })
const activePaths = dataRootContext.paths
const { execFile, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const screenshotDesktop = require('screenshot-desktop')
const sharp = require('sharp')
const Store = require('electron-store')
const { OcrService } = require('./main/services/ocr-service')
const { RecordingService } = require('./main/services/recording-service')
const { LongCaptureSession } = require('./main/services/long-capture-session')
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
  DEFAULT_SELECTION_TOOLBAR,
  buildSearchUrl,
  getToolbarActionDefinition,
  getToolbarWidth,
  getVisibleToolbarActionDefinitions,
  getVisibleToolbarActions,
  isAiToolbarAction,
  isLocalToolbarAction,
  normalizeSelectionToolbar
} = require('./toolbar/toolbar-utils')

const defaultHistoryDirectory = activePaths?.history || path.join(app.getPath('userData'), 'capture-history')
const logFile = activePaths ? path.join(activePaths.logs, 'app.log') : path.join(app.getPath('userData'), 'app.log')

const DEFAULT_SETTINGS = {
  apiKey: '',
  theme: 'system',
  mainColor: '#1677ff',
  borderRadius: 8,
  compact: false,
  skinPath: '',
  skinOpacity: 18,
  customCss: '',
  selectionToolbar: DEFAULT_SELECTION_TOOLBAR,
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
    longCaptureDirection: 'vertical'
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
    model: 'deepseek-v4-flash',
    maxTokens: 4096,
    temperature: 0.7,
    targetLanguage: '中文'
  },
  system: {
    autoStart: true,
    runLog: true,
    enableTray: true
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
let toolbarWindow = null
let actionWindow = null
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
let currentStreamController = null
let lastToolbarPos = null
let pinnedCount = 0
const pinWindows = new Set()
const recognitionWindows = new Set()
const actionWindows = []
const MAX_PINNED = 20
const TOOLBAR_W = getToolbarWidth(getVisibleToolbarActions(DEFAULT_SELECTION_TOOLBAR))
const TOOLBAR_H = 40
const TOOLBAR_STREAM_IDLE_TIMEOUT_MS = 30000
const isWin = process.platform === 'win32'
let nativeDisplayListPromise = null

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
  const normalized = settings
  normalized.selectionToolbar = normalizeSelectionToolbar(normalized.selectionToolbar)
  const legacyDirectory = normalized.fixedContent?.autoSaveDirectory
  normalized.screenshot.historyDirectory = String(normalized.screenshot.historyDirectory || legacyDirectory || defaultHistoryDirectory).trim()
  if (!normalized.screenshot.historyDirectory) normalized.screenshot.historyDirectory = defaultHistoryDirectory
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
  isEnabled: () => !dataRootMigrationInProgress && !!store && getSettings().system.runLog
})

function log(...args) {
  writeAppLog(...args)
}

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
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
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

function createMainWindow(route = 'home') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('app:navigate', route)
    return mainWindow
  }
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    frame: false,
    title: 'Highlighter',
    backgroundColor: '#f5f5f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.loadFile(path.join(__dirname, 'config', 'config.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.once('did-finish-load', () => mainWindow.webContents.send('app:navigate', route))
  mainWindow.on('closed', () => { mainWindow = null })
  return mainWindow
}

function createToolbarWindow() {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) return toolbarWindow
  toolbarWindow = new BrowserWindow({
    width: TOOLBAR_W,
    height: TOOLBAR_H,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: !isWin,
    show: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-toolbar.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  toolbarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  toolbarWindow.setAlwaysOnTop(true, 'screen-saver')
  toolbarWindow.loadFile(path.join(__dirname, 'toolbar', 'toolbar.html'))
  return toolbarWindow
}

function createActionWindow() {
  const win = new BrowserWindow({
    width: 550,
    height: 520,
    minWidth: 380,
    minHeight: 300,
    title: 'Highlighter',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile(path.join(__dirname, 'action', 'action.html'))
  win._isPinned = false
  actionWindows.push(win)
  win.on('closed', () => {
    const index = actionWindows.indexOf(win)
    if (index >= 0) actionWindows.splice(index, 1)
    if (win._isPinned) pinnedCount = Math.max(0, pinnedCount - 1)
    if (currentStreamController?.win === win) cancelToolbarStream(currentStreamController, 'window-closed')
    if (actionWindow === win) actionWindow = null
  })
  win.on('blur', () => {
    if (!win._isPinned && !win.isDestroyed()) win.close()
  })
  actionWindow = win
  return win
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

function handleTextSelection(data) {
  if (isProcessing || !data?.text || shouldFilterApp(data.programName)) return
  const text = data.text.trim()
  if (!text || text.length > 10000) return
  const actions = getVisibleToolbarActionDefinitions(getSettings().selectionToolbar)
  if (!actions.length) { hideToolbar(); return }
  const toolbarWidth = getToolbarWidth(actions)
  const result = getRefPointAndOrientation(data)
  const position = calculateToolbarPosition(result.refPoint, result.orientation, toolbarWidth)
  if (!toolbarWindow || toolbarWindow.isDestroyed()) createToolbarWindow()
  toolbarWindow.setSize(toolbarWidth, TOOLBAR_H)
  lastToolbarPos = position
  toolbarWindow.setPosition(position.x, position.y)
  toolbarWindow.showInactive()
  toolbarWindow.webContents.send('selection:text', { text, actions })
}

function hideToolbar() {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) toolbarWindow.hide()
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
  currentStreamController = controller
  isProcessing = true
  armToolbarStreamTimeout(controller)
  return controller
}

function isCurrentToolbarStreamSender(event) {
  return !!currentStreamController?.matchesSender(event.sender)
}

async function streamToWindow(win, action, text, controller) {
  const { createCustomStream, createExplainStream, createTranslateStream } = require('./deepseek')
  const apiKey = getSettings().apiKey
  const requestOptions = { signal: controller.signal }
  try {
    let stream
    if (action.id === 'translate') stream = await createTranslateStream(apiKey, text, action.prompt, requestOptions)
    else if (action.id === 'explain') stream = await createExplainStream(apiKey, text, action.prompt, requestOptions)
    else stream = await createCustomStream(apiKey, text, action.prompt, requestOptions)
    armToolbarStreamTimeout(controller)
    for await (const chunk of stream) {
      if (controller.cancelled || win.isDestroyed()) return
      armToolbarStreamTimeout(controller)
      const delta = chunk.choices?.[0]?.delta
      if (delta?.reasoning_content) win.webContents.send('stream:reasoning', { content: delta.reasoning_content })
      if (delta?.content) win.webContents.send('stream:data', { content: delta.content })
    }
    if (!controller.cancelled && !win.isDestroyed()) win.webContents.send('stream:done')
  } catch (error) {
    if (!controller.cancelled && !win.isDestroyed()) {
      win.webContents.send('stream:error', { error: error.message || '请求失败' })
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

async function getDisplayCapture(display) {
  const scaleFactor = display.scaleFactor || 1
  if (isWin) {
    try {
      if (!nativeDisplayListPromise) nativeDisplayListPromise = screenshotDesktop.listDisplays()
      const nativeDisplays = await nativeDisplayListPromise
      const physicalBounds = screen.dipToScreenRect(null, display.bounds)
      const nativeDisplay = nativeDisplays.find((item) => (
        item.left === physicalBounds.x && item.top === physicalBounds.y &&
        item.width === physicalBounds.width && item.height === physicalBounds.height
      ))
      if (nativeDisplay) {
        const buffer = await screenshotDesktop({ format: 'png', screen: nativeDisplay.id })
        const image = nativeImage.createFromBuffer(buffer)
        const size = image.getSize()
        if (size.width !== physicalBounds.width || size.height !== physicalBounds.height) {
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
  if (currentCaptureWindow && !currentCaptureWindow.isDestroyed()) currentCaptureWindow.close()
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
  const capturePromise = suppliedImageBuffer || options.mode === 'canvas'
    ? Promise.resolve({
        imageBuffer: suppliedImageBuffer || Buffer.alloc(0),
        sourceId: '',
        scaleFactor: Number(options.sourceScaleFactor) || display.scaleFactor || 1
      })
    : getDisplayCapture(display)
  const smartSelectPromise = mode === 'region' ? createSmartSelectSession() : Promise.resolve(null)
  const smartSelectSession = await smartSelectPromise
  const transparent = mode === 'canvas' || !!options.transparent
  const captureWindow = new BrowserWindow({
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
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  currentCaptureWindow = captureWindow
  captureWindow._editingPinWindow = options.editingPinWindow || null
  captureWindow._captureVisible = false
  captureWindow._captureInitSent = false
  captureWindow._captureRendererReady = false
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

  const loadPromise = captureWindow.loadFile(path.join(__dirname, 'capture', 'capture.html'))
  captureWindow.on('closed', () => {
    clearTimeout(captureWindow._renderTimeout)
    captureWindow._smartSelectContext?.session.dispose()
    captureWindow._smartSelectContext = null
    if (currentCaptureWindow === captureWindow) currentCaptureWindow = null
    const pinWindow = captureWindow._pendingPinWindow || captureWindow._editingPinWindow
    setImmediate(() => bringPinToFront(pinWindow))
  })

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
    captureWindow._renderTimeout = setTimeout(() => {
      if (captureWindow.isDestroyed() || captureWindow._captureVisible) return
      log('Capture render timeout:', capture.sourceId || options.mode || 'unknown', JSON.stringify({
        expected: captureWindow._captureInit?.captureBounds,
        window: captureWindow.getBounds(),
        content: captureWindow.getContentBounds()
      }))
      captureWindow.close()
    }, 8000)
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
  win.show()
  setImmediate(() => {
    if (win.isDestroyed()) return
    win.setOpacity(1)
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
  const overlayWindow = new BrowserWindow({
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
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  const controllerBounds = placeLongCaptureController(display, selectionBounds)
  const controllerWindow = new BrowserWindow({
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
      contextIsolation: true,
      nodeIntegration: false,
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
      overlayWindow.loadFile(path.join(__dirname, 'long-capture', 'overlay.html')),
      controllerWindow.loadFile(path.join(__dirname, 'long-capture', 'long-capture.html'))
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

function getPixelAlignedPinSize(pixelWidth, pixelHeight, display) {
  const scaleFactor = Math.max(0.25, Number(display?.scaleFactor) || 1)
  return {
    width: Math.max(1, Number(pixelWidth) / scaleFactor),
    height: Math.max(1, Number(pixelHeight) / scaleFactor),
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
  const aligned = getPixelAlignedPinSize(size.width, size.height, display)
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
  const win = new BrowserWindow({
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
      preload: path.join(__dirname, 'preload-pin.js'),
      contextIsolation: true,
      nodeIntegration: false
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
  win.loadFile(path.join(__dirname, 'pin', 'pin.html'))
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
  const aligned = getPixelAlignedPinSize(size.width, size.height, display)
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
    const scale = Math.min(
      1,
      workArea.width / editBounds.width,
      Math.max(1, workArea.height - actionSpace) / editBounds.height
    )
    const imageWidth = Math.max(1, Math.round(editBounds.width * scale))
    const imageHeight = Math.max(1, Math.round(editBounds.height * scale))
    const width = Math.min(workArea.width, Math.max(420, imageWidth))
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
  const win = new BrowserWindow({
    width: isTable ? 820 : 640,
    height: isTable ? 620 : 420,
    minWidth: isTable ? 600 : 480,
    minHeight: isTable ? 440 : 320,
    frame: false,
    show: false,
    backgroundColor: '#18181b',
    title: isTable ? 'Highlighter 表格识别' : 'Highlighter 二维码识别',
    webPreferences: {
      preload: path.join(__dirname, 'preload-recognition.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  recognitionWindows.add(win)
  win._recognitionInit = {
    type,
    dataUrl,
    scaleFactor: Number(options.scaleFactor) || 1,
    mainColor: settings.mainColor || '#1677ff'
  }
  win.loadFile(path.join(__dirname, 'recognition', 'recognition.html'))
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

  const frameWindow = new BrowserWindow({
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
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  const controlWindow = new BrowserWindow({
    ...controlBounds,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-record.js'),
      contextIsolation: true,
      nodeIntegration: false,
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
    frameWindow.loadFile(path.join(__dirname, 'record', 'frame.html')),
    controlWindow.loadFile(path.join(__dirname, 'record', 'record.html'))
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
  ipcMain,
  settingsService: {
    getSettings: () => getSettings(),
    updateSettings: (patch) => settingsService.updateSettings(patch),
    resetSettings: () => settingsService.resetSettings(),
    normalizeApiKey: (apiKey) => settingsService.normalizeApiKey(apiKey),
    setApiKey: (apiKey) => settingsService.setApiKey(apiKey)
  },
  assertWritable: assertManagedDataWritable,
  onSettingsUpdated: (patch, settings) => {
    if (patch.shortcuts) registerShortcuts()
    if (patch.system?.autoStart !== undefined) app.setLoginItemSettings({ openAtLogin: !!settings.system.autoStart })
    if (patch.system?.enableTray !== undefined) createTrayIcon()
    if (patch.plugins?.ocr === false && ocrService) { ocrService.stop(); ocrService = null }
    if (patch.plugins?.ocr === true && settings.ocr.hotStart) getOcrService().ensureStarted().catch((error) => log('OCR hot start failed:', error.message))
  },
  onSettingsReset: () => registerShortcuts(),
  onStartHook: () => initSelectionHook(),
  validateApiKey: (apiKey) => require('./deepseek').validateApiKey(apiKey),
  log
})
registerShortcutIpc({
  ipcMain,
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
  ipcMain,
  controller: {
    openExternal,
    executeFunction,
    getInfo: () => ({
      version: app.getVersion(),
      platform: process.platform,
      dataDirectory: activePaths?.root || app.getPath('userData')
    }),
    getDisplayDiagnostics,
    chooseDirectory,
    openDataDirectory: () => shell.openPath(activePaths?.root || app.getPath('userData')),
    openSaveDirectory: () => shell.openPath(getSettings().screenshot.saveDirectory || app.getPath('pictures')),
    completeAi: (messages, options) => require('./deepseek').completeChat(
      getSettings().apiKey,
      messages,
      { ...getSettings().ai, ...(options || {}) }
    ),
    translateText: (text, sourceLanguage, targetLanguage) => require('./deepseek').translateText(
      getSettings().apiKey,
      text,
      sourceLanguage,
      targetLanguage || getSettings().ai.targetLanguage
    )
  }
})

registerDataRootIpc({
  ipcMain,
  controller: {
    get: getDataRootInfo,
    open: openDataRoot,
    change: changeDataRoot
  }
})

registerHistoryIpc({
  ipcMain,
  historyService: {
    list: (filter) => historyService.list(filter),
    getThumbnail: (id) => historyService.getThumbnail(id),
    listSources: () => historyService.listSources(),
    stats: () => historyService.stats(),
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
  revealItem: (item) => {
    shell.showItemInFolder(item.filePath)
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
  if (win?._captureInit) win._captureInit.imageBuffer = null
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
  return getOcrService().recognize(buffer, {
    scaleFactor: payload?.scaleFactor,
    detectAngle: settings.ocr.detectAngle,
    minConfidence: settings.ocr.minConfidence
  })
  },
  translate: async (_event, payload) => {
  if (!getSettings().plugins.ocr) throw new Error('请先在插件页面启用文本识别')
  const imageData = typeof payload === 'string' ? payload : payload?.imageBuffer ?? payload?.dataUrl
  const buffer = imageDataToBuffer(imageData)
  if (!buffer.length) throw new Error('OCR 图片数据为空')
  const settings = getSettings()
  const ocrResult = await getOcrService().recognize(buffer, {
    scaleFactor: payload?.scaleFactor,
    detectAngle: settings.ocr.detectAngle,
    minConfidence: settings.ocr.minConfidence
  })
  const text = ocrResult.text.trim()
  if (!text) throw new Error('未识别到可翻译的文本')
  const translation = await require('./deepseek').translateText(getSettings().apiKey, text, 'auto', getSettings().ai.targetLanguage)
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
  const ocrResult = await getOcrService().recognize(dataUrlToBuffer(dataUrl), {
    scaleFactor: payload?.scaleFactor,
    detectAngle: settings.ocr.detectAngle,
    minConfidence: settings.ocr.minConfidence
  })
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
  ipcMain,
  controller: captureIpcController
})

ipcMain.on('pin:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win?._pinData) event.sender.send('pin:init', win._pinData)
})
ipcMain.on('pin:render-ready', (event) => {
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
ipcMain.on('pin:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
ipcMain.on('pin:copy', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win?._pinData) clipboard.writeImage(nativeImage.createFromDataURL(win._pinData.dataUrl))
})
ipcMain.on('pin:save', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win?._pinData) await saveDataUrl(win._pinData.dataUrl)
})
ipcMain.on('pin:context-menu', (event, imageBounds = {}) => {
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
    { label: '复制', click: () => clipboard.writeImage(nativeImage.createFromDataURL(win._pinData.dataUrl)) },
    { label: '保存', click: () => saveDataUrl(win._pinData.dataUrl).catch((error) => log(error.message)) },
    { type: 'separator' },
    { label: '关闭', click: () => { if (!win.isDestroyed()) win.close() } }
  ])
  menu.popup({ window: win })
})
ipcMain.on('pin:set-opacity', (event, opacity) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const nextOpacity = Math.max(0.2, Math.min(1, Number(opacity) || 1))
  if (win._pinData) win._pinData.opacity = nextOpacity
  win.setOpacity(nextOpacity)
})
ipcMain.on('pin:resize', (event, { factor } = {}) => {
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
ipcMain.on('pin:move-start', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  win._pinMove = { point: screen.getCursorScreenPoint(), bounds: win.getBounds() }
})
ipcMain.on('pin:move', (event) => {
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
ipcMain.on('pin:move-end', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) {
    win._pinMove = null
    syncPinDisplayScale(win)
  }
})
ipcMain.on('pin:toggle-click-through', (event) => {
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
  ipcMain,
  controller: recordingIpcController
})

ipcMain.on('toolbar:action', async (_event, { action, text }) => {
  if (isProcessing || !text) return
  const toolbarConfig = getSettings().selectionToolbar
  const visibleActions = getVisibleToolbarActions(toolbarConfig)
  if (!visibleActions.includes(action)) return
  const actionDefinition = getToolbarActionDefinition(toolbarConfig, action)
  if (!actionDefinition) return
  if (isLocalToolbarAction(action)) {
    hideToolbar()
    if (action === 'copy') clipboard.writeText(text)
    else {
      const url = buildSearchUrl(getSettings().selectionToolbar.searchEngine, text)
      try { await shell.openExternal(url) } catch (error) { log('Toolbar search failed:', error.message) }
    }
    return
  }
  if (!isAiToolbarAction(action, toolbarConfig)) return
  if (!getSettings().apiKey) { createMainWindow('settings-function'); hideToolbar(); return }
  hideToolbar()
  const win = createActionWindow()
  const controller = createToolbarStreamController(win)
  if (lastToolbarPos) {
    const workArea = screen.getDisplayNearestPoint(lastToolbarPos).workArea
    const [width, height] = win.getSize()
    const x = Math.round(Math.max(workArea.x, Math.min(lastToolbarPos.x - width / 2, workArea.x + workArea.width - width)))
    let y = lastToolbarPos.y + 48
    if (y + height > workArea.y + workArea.height) y = lastToolbarPos.y - height - 12
    win.setPosition(x, Math.round(Math.max(workArea.y, y)))
  }
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('action:start', {
      type: actionDefinition.id,
      label: actionDefinition.label,
      icon: actionDefinition.icon,
      text
    })
    streamToWindow(win, actionDefinition, text, controller)
  })
  win.show()
  win.focus()
})
ipcMain.on('toolbar:close', hideToolbar)
ipcMain.on('window:toggle-pin', (event, shouldPin) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (shouldPin && pinnedCount >= MAX_PINNED) return event.sender.send('window:pin-denied', { max: MAX_PINNED })
  if (shouldPin && !win._isPinned) { win._isPinned = true; pinnedCount++; win.setAlwaysOnTop(true, 'floating') }
  if (!shouldPin && win._isPinned) { win._isPinned = false; pinnedCount = Math.max(0, pinnedCount - 1); win.setAlwaysOnTop(false) }
})
ipcMain.on('stream:cancel', (event) => {
  if (!isCurrentToolbarStreamSender(event)) return
  cancelToolbarStream(currentStreamController, 'user-cancelled')
})
ipcMain.on('stream:finish', (event) => {
  if (!isCurrentToolbarStreamSender(event)) return
  cancelToolbarStream(currentStreamController, 'renderer-finished')
})
ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
ipcMain.on('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (currentStreamController?.win === win) cancelToolbarStream(currentStreamController, 'window-hidden')
  win?.hide()
})
ipcMain.on('debug:text-received', () => {})

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
  persistSettings(getSettings())
  createTrayIcon()
  createToolbarWindow()
  registerShortcuts()
  createMainWindow('home')
  initSelectionHook()
  registerSelectionPowerEvents()
  if (getSettings().plugins.ocr && getSettings().ocr.hotStart) getOcrService().ensureStarted().catch((error) => log('OCR hot start failed:', error.message))
  if (isWin) {
    screenshotDesktop.listDisplays()
      .then((displays) => { nativeDisplayListPromise = Promise.resolve(displays) })
      .catch((error) => log('Display discovery warm-up failed:', error))
  }
  app.setLoginItemSettings({ openAtLogin: !!getSettings().system.autoStart })
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  removeProvisionalRoot(dataRootContext)
  app.quit()
}
else {
  app.on('second-instance', () => { if (store) createMainWindow('home') })
  app.on('render-process-gone', (_event, webContents, details) => {
    log('Renderer process exited:', {
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents?.getURL?.() || ''
    })
  })
  app.on('child-process-gone', (_event, details) => {
    log('Child process exited:', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName || ''
    })
  })
  process.on('unhandledRejection', (reason) => log('Unhandled promise rejection:', reason))
  app.whenReady().then(startApplication).catch((error) => {
    dialog.showErrorBox('Highlighter 启动失败', error.message || String(error))
    removeProvisionalRoot(dataRootContext)
    app.exit(1)
  })
  app.on('activate', () => { if (store) createMainWindow('home') })
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => shortcutService.dispose())
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
