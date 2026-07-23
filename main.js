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
  screen,
  shell,
  Tray
} = require('electron')
const { execFile, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const screenshotDesktop = require('screenshot-desktop')
const Store = require('electron-store')
const { OcrService } = require('./main/services/ocr-service')
const { RecordingService } = require('./main/services/recording-service')
const { buildTableFromOcr } = require('./capture/recognition-utils')
const {
  calculateTranscodeProgress,
  normalizeFrameRate,
  normalizeSelectionBounds,
  pickDesktopSource
} = require('./record/recording-utils')
const {
  DEFAULT_SELECTION_TOOLBAR,
  buildSearchUrl,
  getToolbarWidth,
  getVisibleToolbarActions,
  isAiToolbarAction,
  isLocalToolbarAction
} = require('./toolbar/toolbar-utils')

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
    saveFormat: 'png',
    historyEnabled: true,
    historyLimit: 200,
    doubleClickCopy: true,
    selectionMask: 'rgba(0,0,0,.46)',
    showColorPicker: true
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
    includeMicrophone: false,
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
    translationSelectText: '',
    chatSelectText: '',
    videoRecord: '',
    fullScreenDraw: '',
    toggleFixedContentVisibility: '',
    showOrHideMainWindow: '',
    openCaptureHistory: ''
  }
}

const store = new Store({
  defaults: {
    settings: DEFAULT_SETTINGS,
    captureHistory: []
  }
})

let mainWindow = null
let toolbarWindow = null
let actionWindow = null
let selectionHook = null
let tray = null
let currentCaptureWindow = null
let recordWindow = null
let recordFrameWindow = null
let ocrService = null
let recordingService = null
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
const isWin = process.platform === 'win32'
let nativeDisplayListPromise = null

function getOcrService() {
  if (ocrService) return ocrService
  const resourceRoot = app.isPackaged ? process.resourcesPath : __dirname
  ocrService = new OcrService({
    sidecarPath: path.join(resourceRoot, 'native', 'ocr', 'HighlighterOcrSidecar.exe'),
    modelDir: path.join(resourceRoot, 'ocr', 'models', 'ppocr-v4-ch'),
    log
  })
  return ocrService
}

function resolveFfmpegPath() {
  const candidate = require('ffmpeg-static')
  return app.isPackaged ? candidate.replace('app.asar', 'app.asar.unpacked') : candidate
}

function getRecordingService() {
  if (recordingService) return recordingService
  recordingService = new RecordingService({
    tempRoot: path.join(app.getPath('userData'), 'temp', 'recordings'),
    ffmpegPath: resolveFfmpegPath(),
    log
  })
  return recordingService
}

function mergeDeep(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const output = { ...(target || {}) }
  for (const [key, value] of Object.entries(patch)) {
    output[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeDeep(output[key], value)
      : value
  }
  return output
}

function getSettings() {
  return mergeDeep(DEFAULT_SETTINGS, store.get('settings', {}))
}

function log(...args) {
  const message = args.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')
  console.log(message)
  if (!getSettings().system.runLog) return
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), `[${new Date().toISOString()}] ${message}\n`)
  } catch {}
}

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

function historyDirectory() {
  return ensureDirectory(path.join(app.getPath('userData'), 'capture-history'))
}

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64')
}

function fileToDataUrl(filePath) {
  return `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`
}

function makeCaptureName(prefix = 'Highlighter') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `${prefix}_${stamp}.png`
}

function persistHistory(dataUrl, meta = {}) {
  const settings = getSettings()
  if (!settings.screenshot.historyEnabled) return null
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const filePath = path.join(historyDirectory(), `${id}.png`)
  fs.writeFileSync(filePath, dataUrlToBuffer(dataUrl))
  const image = nativeImage.createFromPath(filePath)
  const size = image.getSize()
  const item = {
    id,
    filePath,
    createdAt: Date.now(),
    source: meta.source || 'capture',
    action: meta.action || 'edit',
    width: size.width,
    height: size.height
  }
  const history = [item, ...store.get('captureHistory', [])]
  const limit = Math.max(10, Number(settings.screenshot.historyLimit) || 200)
  const removed = history.splice(limit)
  removed.forEach((entry) => {
    try { fs.unlinkSync(entry.filePath) } catch {}
  })
  store.set('captureHistory', history)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('history:changed')
  return item
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
    if (isProcessing && actionWindow === win) {
      if (currentStreamController) currentStreamController.cancelled = true
      isProcessing = false
      currentStreamController = null
    }
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
  try {
    const SelectionHook = require('selection-hook')
    if (selectionHook && selectionHook.isRunning()) return true
    selectionHook = new SelectionHook()
    selectionHook.on('text-selection', handleTextSelection)
    selectionHook.on('mouse-down', (data) => {
      if (!toolbarWindow || !toolbarWindow.isVisible()) return
      const bounds = toolbarWindow.getBounds()
      let point = { x: data.x, y: data.y }
      if (isWin) point = screen.screenToDipPoint(point)
      const inside = point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height
      if (!inside) hideToolbar()
    })
    selectionHook.on('key-down', hideToolbar)
    selectionHook.on('mouse-wheel', hideToolbar)
    selectionHook.on('error', (error) => log('Selection hook error:', error.message))
    selectionHook.start({ debug: false, enableClipboard: true })
    return true
  } catch (error) {
    log('Selection hook unavailable:', error.message)
    return false
  }
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
  const actions = getVisibleToolbarActions(getSettings().selectionToolbar)
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

async function streamToWindow(win, action, text) {
  const { createExplainStream, createTranslateStream } = require('./deepseek')
  const apiKey = getSettings().apiKey
  try {
    const stream = await (action === 'translate' ? createTranslateStream(apiKey, text) : createExplainStream(apiKey, text))
    for await (const chunk of stream) {
      if (currentStreamController?.cancelled || win.isDestroyed()) return
      const delta = chunk.choices?.[0]?.delta
      if (delta?.reasoning_content) win.webContents.send('stream:reasoning', { content: delta.reasoning_content })
      if (delta?.content) win.webContents.send('stream:data', { content: delta.content })
    }
    if (!win.isDestroyed()) win.webContents.send('stream:done')
  } catch (error) {
    if (!win.isDestroyed()) win.webContents.send('stream:error', { error: error.message || '请求失败' })
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
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 }
  })
  const source = pickDesktopSource(sources, display.id)
  if (!source) throw new Error('未找到可录制的屏幕源')
  return source
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
      return { dataUrl: source.thumbnail.toDataURL(), sourceId: source.id, scaleFactor }
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
          dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
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
  const capturePromise = options.imageDataUrl || options.mode === 'canvas'
    ? Promise.resolve({
        dataUrl: options.imageDataUrl || '',
        sourceId: '',
        scaleFactor: Number(options.sourceScaleFactor) || display.scaleFactor || 1
      })
    : getDisplayCapture(display)
  const smartSelectPromise = mode === 'region' ? createSmartSelectSession() : Promise.resolve(null)
  const smartSelectSession = await smartSelectPromise
  const captureWindow = new BrowserWindow({
    x: captureBounds.x,
    y: captureBounds.y,
    width: Math.min(captureBounds.width, 800),
    height: Math.min(captureBounds.height, 600),
    frame: false,
    transparent: options.mode === 'canvas',
    backgroundColor: options.mode === 'canvas' ? '#00ffffff' : '#000000',
    fullscreenable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    opacity: 0,
    resizable: false,
    movable: false,
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
  if (!requestedBounds) captureWindow.setFullScreen(true)
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
      imageDataUrl: capture.dataUrl || '',
      mode,
      autoAction: options.autoAction || '',
      source: options.source || 'region',
      displayBounds: display.bounds,
      captureBounds,
      scaleFactor: capture.scaleFactor,
      editPin: !!options.editPin,
      smartSelect: !!captureWindow._smartSelectContext,
      cursorPosition: (() => {
        const point = screen.getCursorScreenPoint()
        return { x: point.x - captureBounds.x, y: point.y - captureBounds.y }
      })(),
      settings: getSettings()
    }
    captureWindow._captureInitSent = true
    captureWindow.webContents.send('capture:init', captureWindow._captureInit)
    captureWindow._renderTimeout = setTimeout(() => {
      if (captureWindow.isDestroyed() || captureWindow._captureVisible) return
      log('Capture render timeout:', capture.sourceId || options.mode || 'unknown')
      captureWindow.close()
    }, 8000)
    return captureWindow
  } catch (error) {
    if (!captureWindow.isDestroyed()) captureWindow.close()
    throw error
  }
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

async function saveDataUrl(dataUrl, options = {}) {
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
  fs.writeFileSync(filePath, dataUrlToBuffer(dataUrl))
  return filePath
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
  const sourceScaleFactor = Math.max(0.25, Number(meta.scaleFactor) || display.scaleFactor || 1)
  const baseWidth = selectionBounds?.width || Math.max(1, size.width / sourceScaleFactor)
  const baseHeight = selectionBounds?.height || Math.max(1, size.height / sourceScaleFactor)
  const zoom = selectionBounds ? 1 : Math.min(1, maxWidth / baseWidth, maxHeight / baseHeight)
  const width = selectionBounds?.width || Math.max(1, Math.round(baseWidth * zoom))
  const height = selectionBounds?.height || Math.max(1, Math.round(baseHeight * zoom))
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
  const scaleFactor = Math.max(0.25, Number(meta.scaleFactor) || size.width / targetBounds.width || 1)
  win._pinData = {
    ...win._pinData,
    dataUrl,
    meta,
    baseWidth: Math.max(1, size.width / scaleFactor),
    baseHeight: Math.max(1, size.height / scaleFactor),
    zoom: 1
  }
  win.setBounds(targetBounds, false)
  win.setBounds(targetBounds, false)
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
  const windowBounds = win.getBounds()
  const editBounds = {
    x: Math.round(windowBounds.x + (Number(imageBounds.x) || 0)),
    y: Math.round(windowBounds.y + (Number(imageBounds.y) || 0)),
    width: Math.max(1, Math.round(Number(imageBounds.width) || windowBounds.width)),
    height: Math.max(1, Math.round(Number(imageBounds.height) || windowBounds.height))
  }
  const imageSize = nativeImage.createFromDataURL(win._pinData.dataUrl).getSize()
  const sourceScaleFactor = Math.max(0.25, imageSize.width / editBounds.width)
  win.hide()
  try {
    const captureWindow = await createCaptureWindow({
      imageDataUrl: win._pinData.dataUrl,
      mode: 'image',
      autoAction,
      source: 'pin-reannotate',
      windowBounds: editBounds,
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

function pinFromCapture(event, dataUrl, meta) {
  const captureWindow = BrowserWindow.fromWebContents(event.sender)
  const editingPinWindow = captureWindow?._editingPinWindow
  if (!editingPinWindow && pinnedCount >= MAX_PINNED) throw new Error(`最多固定 ${MAX_PINNED} 张图片`)
  const pinWindow = editingPinWindow
    ? updatePinWindow(editingPinWindow, dataUrl, meta)
    : createPinWindow(dataUrl, meta)
  if (captureWindow) {
    captureWindow._pendingPinWindow = pinWindow
    captureWindow._editingPinWindow = null
  }
  return { captureWindow, pinWindow }
}

async function cleanupRecordSession(win) {
  const sessionId = win?._recordSessionId
  if (!sessionId) return false
  win._recordSessionId = null
  return getRecordingService().cleanupSession(sessionId)
}

async function closeRecordFlow() {
  const control = recordWindow
  const frame = recordFrameWindow
  if (recordWindow === control) recordWindow = null
  if (recordFrameWindow === frame) recordFrameWindow = null
  await cleanupRecordSession(control).catch((error) => log('Recording cleanup failed:', error.message))
  if (control && !control.isDestroyed()) control.close()
  if (frame && !frame.isDestroyed()) frame.close()
}

function getRecordControlBounds(selectionBounds, workArea, width = 440, height = 86) {
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
  const controlBounds = getRecordControlBounds(selectionBounds, display.workArea)

  const frameWindow = new BrowserWindow({
    ...selectionBounds,
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
  frameWindow.setIgnoreMouseEvents(true)
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
      createPinWindow(image.toDataURL(), { source: 'file' })
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
  globalShortcut.unregisterAll()
  const shortcuts = getSettings().shortcuts
  for (const [name, accelerator] of Object.entries(shortcuts)) {
    if (!accelerator) continue
    try {
      const registered = globalShortcut.register(accelerator, () => executeFunction(name).catch((error) => log('Shortcut error:', name, error.message)))
      if (!registered) log('Shortcut unavailable:', accelerator)
    } catch (error) {
      log('Shortcut registration failed:', accelerator, error.message)
    }
  }
}

ipcMain.handle('settings:get', () => getSettings())
ipcMain.handle('settings:update', (_event, patch) => {
  const settings = mergeDeep(getSettings(), patch || {})
  store.set('settings', settings)
  if (patch?.shortcuts) registerShortcuts()
  if (patch?.system?.autoStart !== undefined) app.setLoginItemSettings({ openAtLogin: !!settings.system.autoStart })
  if (patch?.system?.enableTray !== undefined) createTrayIcon()
  if (patch?.plugins?.ocr === false && ocrService) { ocrService.stop(); ocrService = null }
  if (patch?.plugins?.ocr === true && settings.ocr.hotStart) getOcrService().ensureStarted().catch((error) => log('OCR hot start failed:', error.message))
  return settings
})
ipcMain.handle('settings:reset', () => {
  store.set('settings', DEFAULT_SETTINGS)
  registerShortcuts()
  return getSettings()
})
ipcMain.handle('config:get-api-key', () => getSettings().apiKey)
ipcMain.handle('config:save-api-key', (_event, apiKey) => {
  store.set('settings', mergeDeep(getSettings(), { apiKey }))
  return true
})
ipcMain.handle('config:test-connection', async (_event, apiKey) => require('./deepseek').validateApiKey(apiKey))
ipcMain.handle('shell:open-external', (_event, value) => {
  const url = new URL(String(value || ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持打开 HTTP 或 HTTPS 链接')
  return shell.openExternal(url.toString())
})
ipcMain.handle('app:execute-function', (_event, { name, payload }) => executeFunction(name, payload))
ipcMain.handle('app:get-info', () => ({ version: app.getVersion(), platform: process.platform, dataDirectory: app.getPath('userData') }))
ipcMain.handle('app:get-display-diagnostics', async () => {
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
})
ipcMain.handle('dialog:choose-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return result.canceled ? '' : result.filePaths[0]
})
ipcMain.handle('app:open-data-directory', () => shell.openPath(app.getPath('userData')))
ipcMain.handle('app:open-save-directory', () => shell.openPath(getSettings().screenshot.saveDirectory || app.getPath('pictures')))
ipcMain.handle('ai:complete', async (_event, { messages, options }) => require('./deepseek').completeChat(getSettings().apiKey, messages, { ...getSettings().ai, ...(options || {}) }))
ipcMain.handle('ai:translate', async (_event, { text, sourceLanguage, targetLanguage }) => require('./deepseek').translateText(getSettings().apiKey, text, sourceLanguage, targetLanguage || getSettings().ai.targetLanguage))

ipcMain.handle('history:list', () => store.get('captureHistory', []).filter((item) => fs.existsSync(item.filePath)).map((item) => {
  const image = nativeImage.createFromPath(item.filePath)
  const size = image.getSize()
  const width = Math.min(360, size.width || 360)
  const thumbnail = image.resize({ width, quality: 'good' }).toDataURL()
  return { ...item, thumbnail }
}))
ipcMain.handle('history:delete', (_event, id) => {
  const history = store.get('captureHistory', [])
  const item = history.find((entry) => entry.id === id)
  if (item) { try { fs.unlinkSync(item.filePath) } catch {} }
  store.set('captureHistory', history.filter((entry) => entry.id !== id))
  return true
})
ipcMain.handle('history:clear', () => {
  store.get('captureHistory', []).forEach((item) => { try { fs.unlinkSync(item.filePath) } catch {} })
  store.set('captureHistory', [])
  return true
})
ipcMain.handle('history:copy', (_event, id) => {
  const item = store.get('captureHistory', []).find((entry) => entry.id === id)
  if (!item) return false
  clipboard.writeImage(nativeImage.createFromPath(item.filePath))
  return true
})
ipcMain.handle('history:edit', async (_event, id) => {
  const item = store.get('captureHistory', []).find((entry) => entry.id === id)
  if (!item || !fs.existsSync(item.filePath)) return false
  await createCaptureWindow({ imageDataUrl: fileToDataUrl(item.filePath), mode: 'image', source: 'history' })
  return true
})
ipcMain.handle('history:reveal', (_event, id) => {
  const item = store.get('captureHistory', []).find((entry) => entry.id === id)
  if (item) shell.showItemInFolder(item.filePath)
  return !!item
})

ipcMain.on('capture:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win?._captureInit && !win._captureInitSent) {
    win._captureInitSent = true
    event.sender.send('capture:init', win._captureInit)
  }
})
ipcMain.on('capture:render-ready', (event) => revealCaptureWindow(BrowserWindow.fromWebContents(event.sender)))
ipcMain.on('capture:render-error', (event, message) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  log('Capture render failed:', message || 'image decode failed')
  win.close()
})
ipcMain.on('capture:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  win?.close()
})
ipcMain.handle('capture:start-region-recording', async (event, { selectionBounds } = {}) => {
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
})
ipcMain.handle('capture:smart-select', async (event, point = {}) => {
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
})
ipcMain.handle('capture:copy', (_event, { dataUrl, meta }) => {
  clipboard.writeImage(nativeImage.createFromDataURL(dataUrl))
  const item = persistHistory(dataUrl, { ...meta, action: 'copy' })
  if (getSettings().screenshot.autoSaveOnCopy && getSettings().screenshot.saveDirectory) saveDataUrl(dataUrl, { fast: true }).catch((error) => log(error.message))
  return item
})
ipcMain.handle('capture:save', async (_event, { dataUrl, meta, fast }) => {
  const filePath = await saveDataUrl(dataUrl, { fast: !!fast })
  if (filePath) persistHistory(dataUrl, { ...meta, action: 'save' })
  return filePath
})
ipcMain.handle('capture:pin', (event, { dataUrl, meta }) => {
  pinFromCapture(event, dataUrl, meta)
  return persistHistory(dataUrl, { ...meta, action: 'pin' })
})
ipcMain.handle('capture:pin-reannotate', (event, { dataUrl, meta, action }) => {
  const { captureWindow, pinWindow } = pinFromCapture(event, dataUrl, meta)
  pinWindow._pendingReannotateAction = action === 'ocr' ? 'ocr' : ''
  setImmediate(() => {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
  })
  return persistHistory(dataUrl, { ...meta, action: 'pin' })
})
ipcMain.handle('capture:open-recognition', (event, { type, dataUrl, meta }) => {
  const captureWindow = BrowserWindow.fromWebContents(event.sender)
  createRecognitionWindow(type, dataUrl, { scaleFactor: meta?.scaleFactor })
  setImmediate(() => {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
  })
  return persistHistory(dataUrl, { ...meta, action: type })
})
ipcMain.handle('capture:record-history', (_event, { dataUrl, meta }) => persistHistory(dataUrl, meta))
ipcMain.handle('ocr:status', () => getOcrService().getStatus())
ipcMain.handle('capture:ocr', async (_event, payload) => {
  if (!getSettings().plugins.ocr) throw new Error('请先在插件页面启用文本识别')
  const dataUrl = typeof payload === 'string' ? payload : payload?.dataUrl
  if (!dataUrl) throw new Error('OCR 图片数据为空')
  const settings = getSettings()
  return getOcrService().recognize(dataUrlToBuffer(dataUrl), {
    scaleFactor: payload?.scaleFactor,
    detectAngle: settings.ocr.detectAngle,
    minConfidence: settings.ocr.minConfidence
  })
})
ipcMain.handle('capture:translate', async (_event, payload) => {
  if (!getSettings().plugins.ocr) throw new Error('请先在插件页面启用文本识别')
  const dataUrl = typeof payload === 'string' ? payload : payload?.dataUrl
  if (!dataUrl) throw new Error('OCR 图片数据为空')
  const settings = getSettings()
  const ocrResult = await getOcrService().recognize(dataUrlToBuffer(dataUrl), {
    scaleFactor: payload?.scaleFactor,
    detectAngle: settings.ocr.detectAngle,
    minConfidence: settings.ocr.minConfidence
  })
  const text = ocrResult.text.trim()
  if (!text) throw new Error('未识别到可翻译的文本')
  const translation = await require('./deepseek').translateText(getSettings().apiKey, text, 'auto', getSettings().ai.targetLanguage)
  return { text, translation, ocrResult }
})

ipcMain.on('recognition:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !recognitionWindows.has(win) || !win._recognitionInit) return
  event.sender.send('recognition:init', win._recognitionInit)
  win.show()
  win.focus()
})
ipcMain.handle('recognition:table', async (event, payload) => {
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
})
ipcMain.handle('recognition:copy', (event, value) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !recognitionWindows.has(win)) throw new Error('无效的识别结果窗口')
  clipboard.writeText(String(value || ''))
  return true
})
ipcMain.on('recognition:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && recognitionWindows.has(win) && !win.isDestroyed()) win.close()
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
  if (win) win._pinMove = null
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

function requireRecordSession(win, sessionId) {
  if (!sessionId || win._recordSessionId !== sessionId) throw new Error('录制会话不匹配')
  return sessionId
}

ipcMain.on('record:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win === recordWindow && win?._recordInit) event.sender.send('record:init', win._recordInit)
})
ipcMain.handle('record:start-session', async (event) => {
  const win = requireRecordSender(event)
  await cleanupRecordSession(win)
  const session = await getRecordingService().startSession()
  win._recordSessionId = session.id
  return { id: session.id }
})
ipcMain.handle('record:append-chunk', async (event, { sessionId, arrayBuffer } = {}) => {
  const win = requireRecordSender(event)
  requireRecordSession(win, sessionId)
  await getRecordingService().appendChunk(sessionId, Buffer.from(arrayBuffer || []))
  return true
})
ipcMain.handle('record:finish-session', async (event, { sessionId } = {}) => {
  const win = requireRecordSender(event)
  requireRecordSession(win, sessionId)
  return getRecordingService().finishSession(sessionId)
})
ipcMain.handle('record:save-mp4', async (event, { sessionId, durationMs } = {}) => {
  const win = requireRecordSender(event)
  requireRecordSession(win, sessionId)
  const settings = getSettings()
  const directory = settings.record.saveDirectory || app.getPath('videos')
  const result = await dialog.showSaveDialog({
    title: '保存 MP4 录屏',
    defaultPath: path.join(directory, makeCaptureName('Highlighter_Video').replace('.png', '.mp4')),
    filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
  })
  if (result.canceled || !result.filePath) return ''
  const duration = Math.max(1, Number(durationMs) || 1)
  const outputPath = await getRecordingService().transcode(sessionId, result.filePath, (elapsedMicroseconds) => {
    if (win.isDestroyed()) return
    const percent = calculateTranscodeProgress(elapsedMicroseconds, duration)
    win.webContents.send('record:save-progress', percent)
  })
  if (!win.isDestroyed()) win.webContents.send('record:save-progress', 100)
  win._recordSessionId = null
  await getRecordingService().cleanupSession(sessionId)
  return outputPath
})
ipcMain.handle('record:cancel-session', async (event, { sessionId } = {}) => {
  const win = requireRecordSender(event)
  requireRecordSession(win, sessionId)
  win._recordSessionId = null
  await getRecordingService().cleanupSession(sessionId)
  return true
})
ipcMain.handle('record:set-frame-state', (event, state = 'idle') => {
  requireRecordSender(event)
  const frame = recordFrameWindow
  if (!frame || frame.isDestroyed()) return false
  if (state === 'hidden') frame.hide()
  else {
    frame.showInactive()
    frame.webContents.send('record-frame:state', ['recording', 'paused'].includes(state) ? state : 'idle')
  }
  return true
})
ipcMain.handle('record:resize-preview', (event) => {
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
})
ipcMain.handle('record:restart', async (event, { sessionId } = {}) => {
  const win = requireRecordSender(event)
  if (sessionId) requireRecordSession(win, sessionId)
  await cleanupRecordSession(win)
  win.setBounds(win._recordControlBounds, false)
  if (recordFrameWindow && !recordFrameWindow.isDestroyed()) {
    recordFrameWindow.showInactive()
    recordFrameWindow.webContents.send('record-frame:state', 'idle')
  }
  return true
})
ipcMain.on('record:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win !== recordWindow) return
  closeRecordFlow().catch((error) => log('Recording close failed:', error.message))
})

ipcMain.on('toolbar:action', async (_event, { action, text }) => {
  if (isProcessing || !text) return
  if (isLocalToolbarAction(action)) {
    hideToolbar()
    if (action === 'copy') clipboard.writeText(text)
    else {
      const url = buildSearchUrl(getSettings().selectionToolbar.searchEngine, text)
      try { await shell.openExternal(url) } catch (error) { log('Toolbar search failed:', error.message) }
    }
    return
  }
  if (!isAiToolbarAction(action)) return
  if (!getSettings().apiKey) { createMainWindow('settings-function'); hideToolbar(); return }
  isProcessing = true
  currentStreamController = { cancelled: false }
  hideToolbar()
  const win = createActionWindow()
  if (lastToolbarPos) {
    const workArea = screen.getDisplayNearestPoint(lastToolbarPos).workArea
    const [width, height] = win.getSize()
    const x = Math.round(Math.max(workArea.x, Math.min(lastToolbarPos.x - width / 2, workArea.x + workArea.width - width)))
    let y = lastToolbarPos.y + 48
    if (y + height > workArea.y + workArea.height) y = lastToolbarPos.y - height - 12
    win.setPosition(x, Math.round(Math.max(workArea.y, y)))
  }
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('action:start', { type: action, text })
    streamToWindow(win, action, text)
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
ipcMain.on('stream:cancel', () => {
  if (currentStreamController) currentStreamController.cancelled = true
  isProcessing = false
  currentStreamController = null
})
ipcMain.on('stream:finish', () => { isProcessing = false; currentStreamController = null })
ipcMain.on('config:start-hook', (_event, apiKey) => {
  store.set('settings', mergeDeep(getSettings(), { apiKey }))
  initSelectionHook()
})
ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.hide())
ipcMain.on('debug:text-received', () => {})

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) app.quit()
else {
  app.on('second-instance', () => createMainWindow('home'))
  app.whenReady().then(() => {
    createTrayIcon()
    createToolbarWindow()
    createMainWindow('home')
    registerShortcuts()
    initSelectionHook()
    if (getSettings().plugins.ocr && getSettings().ocr.hotStart) getOcrService().ensureStarted().catch((error) => log('OCR hot start failed:', error.message))
    if (isWin) screenshotDesktop.listDisplays().then((displays) => { nativeDisplayListPromise = Promise.resolve(displays) }).catch(() => {})
    app.setLoginItemSettings({ openAtLogin: !!getSettings().system.autoStart })
  })
  app.on('activate', () => createMainWindow('home'))
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => globalShortcut.unregisterAll())
  app.on('before-quit', () => {
    closeRecordFlow()
      .then(() => recordingService?.dispose())
      .catch((error) => log('Recording shutdown failed:', error.message))
      .finally(() => { recordingService = null })
    if (ocrService) { ocrService.stop(); ocrService = null }
    if (selectionHook) { try { selectionHook.cleanup() } catch {}; selectionHook = null }
    if (tray) { tray.destroy(); tray = null }
  })
}
