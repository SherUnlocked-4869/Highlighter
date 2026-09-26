'use strict'

const {
  DEFAULT_SELECTION_TOOLBAR,
  DEFAULT_TOOLBAR_THINKING,
  TOOLBAR_ACTION_ORDER
} = require('../../toolbar/toolbar-utils')
const { DEFAULT_CATEGORIES: SEARCH_DEFAULT_CATEGORIES } = require('../../search/search-utils')
const { createDefaultAssignments, createDefaultProviders } = require('./ai-providers')

const DEFAULT_AI_PROVIDERS = createDefaultProviders()

// Pure data: the settings shape the store starts from and resets to. It lives on
// its own so the defaults can be read, diffed and referenced without loading the
// assembly layer.
const DEFAULT_SETTINGS = {
  apiKey: '',
  providers: DEFAULT_AI_PROVIDERS,
  theme: 'system',
  mainColor: '#e5a44c',
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

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_AI_PROVIDERS
}
