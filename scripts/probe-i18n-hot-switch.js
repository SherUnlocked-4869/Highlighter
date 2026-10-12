// Lead probe: drive the "language hot switch leaves stale copy" cases through a REAL
// renderer. Each case boots one window with its real preload, seeds the state the
// window normally gets from main-process events, reads the DOM, emits the real
// `i18n:language` broadcast, and reads the DOM again.
//
// Why a runtime probe: `applyTranslations()` cannot fix copy that a script rendered
// from an already-translated sentence, or dynamic text sitting on an element that also
// carries a static `data-i18n` (the shared checker and the data-i18n tests merge every
// table and therefore cannot see either shape). Only a live renderer can.
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { createSecureWindow } = require('../main/services/window-security')

const resultPrefix = 'HIGHLIGHTER_I18N_HOT_SWITCH_PROBE='
const userDataPath = process.env.HIGHLIGHTER_I18N_HOT_SWITCH_USER_DATA
if (userDataPath) app.setPath('userData', userDataPath)

const probeSettings = {
  apiKey: '',
  theme: 'system',
  mainColor: '#e5a44c',
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
  ocr: { modelProfile: 'ppocr-v4-ch', hotStart: true, modelWriteToMemory: false, detectAngle: false, minConfidence: 0.3, afterAction: 'none' },
  fixedContent: { zoomWithMouse: true, autoResize: true, autoOcr: false, opacity: 1 },
  record: { frameRate: 24, saveDirectory: '' },
  ai: { model: 'deepseek-v4-flash', maxTokens: 4096, temperature: 0.7, targetLanguage: '中文' },
  system: { autoStart: false, runLog: false, enableTray: false },
  shortcuts: {}
}

function registerProbeIpc() {
  const handlers = new Map([
    ['settings:get', () => probeSettings],
    ['settings:update', () => probeSettings],
    ['settings:reset', () => probeSettings],
    ['shortcuts:status', () => ({})],
    ['config:test-connection', () => true],
    ['data-root:get', () => ({ path: 'D:\\HighlighterProbe', portable: false })],
    ['data-root:change', () => ({ canceled: true })],
    ['data-root:open', () => true],
    ['app:execute-function', () => true],
    ['history:list', () => ({ items: [], total: 0 })],
    ['app:get-info', () => ({ version: 'probe', platform: process.platform })],
    ['app:get-display-diagnostics', () => ({ displays: [] })],
    ['ocr:status', () => ({ ready: false })],
    ['shell:open-external', () => true],
    ['search:query', () => ({ results: [], total: 0 })],
    ['search:status', () => ({ phase: 'idle', message: '', version: null })],
    ['search:ensure-ready', () => ({ phase: 'idle', message: '', version: null })],
    ['search:open-path', () => true],
    ['search:reveal-path', () => true],
    ['search:copy-path', () => true],
    ['search:file-icon', () => ''],
    ['chat:copy', () => true],
    ['recognition:copy-text', () => true],
    ['recognition:open-external', () => true]
  ])
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// `read` must evaluate to an object of the DOM fields under test.
const cases = [
  {
    name: 'search-ready',
    page: ['search', 'search.html'],
    preload: 'preload-search.js',
    seed: `renderStatus({ phase: 'ready', version: '1.5' })`,
    read: `({ status: document.getElementById('statusText').textContent })`,
    keys: ['search.status.ready-version']
  },
  {
    name: 'search-message-key',
    page: ['search', 'search.html'],
    preload: 'preload-search.js',
    // Main publishes `message` already translated (everything-service); `messageKey`
    // is what makes the retained payload re-translatable on a switch.
    seed: `renderStatus({ phase: 'error', message: window.__LOCALES['zh-CN']['main.everything.unavailable'], messageKey: 'main.everything.unavailable' })`,
    read: `({ status: document.getElementById('statusText').textContent })`,
    keys: ['main.everything.unavailable']
  },
  {
    name: 'long-capture-status',
    page: ['long-capture', 'long-capture.html'],
    preload: 'preload-long-capture.js',
    seed: `setStatusKey('long-capture.status.ready')`,
    read: `({ status: document.getElementById('status').textContent })`,
    keys: ['long-capture.status.ready', 'long-capture.status.preparing']
  },
  {
    name: 'record-audio-notice',
    page: ['record', 'record.html'],
    preload: 'preload-record.js',
    seed: `setState('recording'); setAudioNotice('record.audio.notice.system-interrupted')`,
    read: `({ status: document.getElementById('statusLabel').textContent })`,
    keys: ['record.status.recording', 'record.audio.notice.system-interrupted']
  },
  {
    name: 'recognition-error-title',
    page: ['recognition', 'recognition.html'],
    preload: 'preload-recognition.js',
    seed: `showError(new Error('probe failure'))`,
    read: `({ title: document.getElementById('title').textContent })`,
    keys: ['recognition.error.title']
  },
  {
    name: 'action-header-explain',
    page: ['action', 'action.html'],
    preload: 'preload-action.js',
    seed: `conversation.type = 'explain'; conversation.labelSource = 'action.answer.label.explain'; renderHeader()`,
    read: `({
      title: document.getElementById('headerTitle').textContent,
      loading: document.getElementById('loadingText').textContent
    })`,
    keys: ['action.answer.label.explain', 'action.loading.thinking', 'action.header.translating']
  }
]

function readExpression(caseEntry) {
  return `({
    value: (${caseEntry.read}),
    language: window.i18n.currentLanguage(),
    tables: ${JSON.stringify(caseEntry.keys)}.reduce((accumulator, key) => {
      accumulator.zh[key] = (window.__LOCALES['zh-CN'] || {})[key] || ''
      accumulator.en[key] = (window.__LOCALES['en-US'] || {})[key] || ''
      return accumulator
    }, { zh: {}, en: {} })
  })`
}

async function runCase(caseEntry) {
  const pagePath = path.join(__dirname, '..', ...caseEntry.page)
  const win = createSecureWindow({
    BrowserWindow,
    pagePath,
    options: {
      show: false,
      webPreferences: { preload: path.join(__dirname, '..', caseEntry.preload) }
    },
    onBlocked: () => {}
  })
  const consoleMessages = []
  win.webContents.on('console-message', (event) => {
    if (event && typeof event.message === 'string') consoleMessages.push(event.message)
  })
  // Every `file://` window shares one localStorage, so the previous case's
  // `setLanguage('en-US')` would leak into the next window's boot. Clear it so each
  // case starts from the documented priority: data-language -> localStorage -> default.
  await win.webContents.session.clearStorageData({ storages: ['localstorage'] })
  await win.loadFile(pagePath)
  await delay(60)
  await win.webContents.executeJavaScript(caseEntry.seed)
  await delay(30)
  const before = await win.webContents.executeJavaScript(readExpression(caseEntry))
  win.webContents.send('i18n:language', 'en-US')
  await delay(150)
  const after = await win.webContents.executeJavaScript(readExpression(caseEntry))
  win.destroy()
  return {
    name: caseEntry.name,
    before: before.value,
    after: after.value,
    beforeLanguage: before.language,
    afterLanguage: after.language,
    tables: after.tables,
    consoleMessages
  }
}

let probeFinished = false
const probeTimeout = setTimeout(() => {
  if (probeFinished) return
  console.error('i18n hot-switch probe timed out')
  app.exit(1)
}, 60000)

app.on('window-all-closed', () => {})
app.whenReady()
  .then(async () => {
    registerProbeIpc()
    const results = []
    for (const caseEntry of cases) results.push(await runCase(caseEntry))
    return { cases: results }
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
