const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { createSecureWindow } = require('../main/services/window-security')

const resultPrefix = 'HIGHLIGHTER_WINDOW_SECURITY_PROBE='
const userDataPath = process.env.HIGHLIGHTER_WINDOW_SECURITY_USER_DATA
if (userDataPath) app.setPath('userData', userDataPath)

const probeSettings = {
  apiKey: '',
  theme: 'system',
  mainColor: '#1677ff',
  borderRadius: 8,
  compact: false,
  skinPath: '',
  skinOpacity: 18,
  customCss: '',
  selectionToolbar: {
    enabled: true,
    order: ['copy', 'search', 'translate', 'explain', 'open'],
    buttons: { copy: true, search: true, translate: true, explain: true, open: false },
    prompts: { translate: '', explain: '' },
    customActions: [],
    searchEngine: 'bing',
    resultWindow: { width: 420, height: 520 }
  },
  toolbarThinking: { translate: 'off', explain: 'high' },
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
  fixedContent: { zoomWithMouse: true, autoResize: true, autoOcr: false, opacity: 1 },
  record: { frameRate: 24, saveDirectory: '' },
  ai: { model: 'deepseek-v4-flash', maxTokens: 4096, temperature: 0.7, targetLanguage: '中文' },
  system: { autoStart: false, runLog: false, enableTray: false },
  shortcuts: {}
}

const entries = [
  { name: 'config', page: ['config', 'config.html'], preload: 'preload.js', api: 'electronAPI', marker: 'renderHome' },
  { name: 'toolbar', page: ['toolbar', 'toolbar.html'], preload: 'preload-toolbar.js', api: 'toolbarAPI', marker: 'applyAppearance' },
  { name: 'capture', page: ['capture', 'capture.html'], preload: 'preload-capture.js', api: 'captureAPI', marker: 'resizeCanvas' },
  { name: 'long-overlay', page: ['long-capture', 'overlay.html'], preload: 'preload-long-overlay.js', api: 'longOverlayAPI', marker: 'localBounds' },
  { name: 'long-capture', page: ['long-capture', 'long-capture.html'], preload: 'preload-long-capture.js', api: 'longCaptureAPI', marker: 'setStatus' },
  { name: 'pin', page: ['pin', 'pin.html'], preload: 'preload-pin.js', api: 'pinAPI', marker: 'applyPinData' },
  { name: 'recognition', page: ['recognition', 'recognition.html'], preload: 'preload-recognition.js', api: 'recognitionAPI', marker: 'renderQr' },
  { name: 'record-frame', page: ['record', 'frame.html'], preload: 'preload-record-frame.js', api: 'recordFrameAPI', marker: 'render' },
  { name: 'record', page: ['record', 'record.html'], preload: 'preload-record.js', api: 'recordAPI', marker: 'setState' }
]

function registerProbeIpc() {
  const handlers = new Map([
    ['settings:get', () => probeSettings],
    ['settings:update', () => probeSettings],
    ['settings:reset', () => probeSettings],
    ['shortcuts:status', () => ({})],
    ['config:get-api-key', () => ''],
    ['config:save-api-key', () => true],
    ['config:test-connection', () => true],
    ['data-root:get', () => ({ path: 'D:\\HighlighterProbe', portable: false })],
    ['data-root:change', () => ({ canceled: true })],
    ['data-root:open', () => true],
    ['app:execute-function', () => true],
    ['history:list', () => ({ items: [], total: 0 })],
    ['history:thumbnail', () => ''],
    ['history:sources', () => []],
    ['history:stats', () => ({ count: 0, bytes: 0 })],
    ['history:delete', () => true],
    ['history:delete-many', () => ({ deleted: [], failed: [] })],
    ['history:export', () => ({ exported: [], failed: [] })],
    ['history:cleanup', () => ({ removed: [], failed: [] })],
    ['history:copy', () => true],
    ['history:edit', () => true],
    ['history:reveal', () => true],
    ['history:clear', () => true],
    ['ai:complete', () => ({ content: '' })],
    ['ai:translate', () => ''],
    ['dialog:choose-directory', () => null],
    ['app:open-data-directory', () => true],
    ['app:open-save-directory', () => true],
    ['app:get-info', () => ({ version: 'probe', platform: process.platform })],
    ['app:get-display-diagnostics', () => ({ displays: [] })],
    ['ocr:status', () => ({ ready: false })],
    ['shell:open-external', () => true]
  ])
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function inspectEntry(entry) {
  const pagePath = path.join(__dirname, '..', ...entry.page)
  const consoleMessages = []
  const blocked = []
  const win = createSecureWindow({
    BrowserWindow,
    pagePath,
    options: {
      show: false,
      webPreferences: { preload: path.join(__dirname, '..', entry.preload) }
    },
    onBlocked: (item) => blocked.push(item)
  })
  win.webContents.on('console-message', (_event, details) => {
    const message = typeof details === 'object' ? details.message : String(details || '')
    consoleMessages.push(message)
  })
  await win.loadFile(pagePath)
  await delay(50)
  const state = await win.webContents.executeJavaScript(`({
    apiType: typeof window[${JSON.stringify(entry.api)}],
    requireType: typeof window.require,
    processType: typeof window.process,
    markerType: typeof ${entry.marker},
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '',
    inlineScriptCount: [...document.scripts].filter((script) => !script.src).length,
    externalScriptCount: [...document.scripts].filter((script) => script.src).length,
    styleSheetCount: document.styleSheets.length
  })`)
  if (entry.name === 'long-capture') {
    state.matcherWorker = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const matcherWorker = new Worker('matcher-worker.js')
      const timeout = setTimeout(() => {
        matcherWorker.terminate()
        resolve({ status: 'timeout' })
      }, 3000)
      matcherWorker.onerror = () => {
        clearTimeout(timeout)
        matcherWorker.terminate()
        resolve({ status: 'error' })
      }
      matcherWorker.onmessage = (event) => {
        clearTimeout(timeout)
        matcherWorker.terminate()
        resolve(event.data)
      }
      const rgba = new Uint8ClampedArray(64)
      matcherWorker.postMessage({ type: 'frame', id: 7, rgba: rgba.buffer, width: 4, height: 4, axis: 'vertical' }, [rgba.buffer])
    })`)
  }
  const preferences = win.webContents.getLastWebPreferences()
  win.destroy()
  return {
    name: entry.name,
    state,
    preferences: {
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      sandbox: preferences.sandbox,
      webSecurity: preferences.webSecurity,
      webviewTag: preferences.webviewTag
    },
    consoleMessages,
    blocked
  }
}

let probeFinished = false
const probeTimeout = setTimeout(() => {
  if (probeFinished) return
  console.error('Window security probe timed out')
  app.exit(1)
}, 30000)

app.on('window-all-closed', () => {})
app.whenReady()
  .then(async () => {
    registerProbeIpc()
    const windows = []
    for (const entry of entries) windows.push(await inspectEntry(entry))
    return { windows }
  })
  .then((result) => {
    probeFinished = true
    clearTimeout(probeTimeout)
    console.log(`${resultPrefix}${JSON.stringify(result)}`)
    app.quit()
  })
  .catch((error) => {
    probeFinished = true
    clearTimeout(probeTimeout)
    console.error(error?.stack || error)
    app.exit(1)
  })
