'use strict'

const {
  DEFAULT_SELECTION_TOOLBAR,
  DEFAULT_TOOLBAR_THINKING,
  TOOLBAR_ACTION_ORDER
} = require('../../toolbar/toolbar-utils')
const { DEFAULT_CATEGORIES: SEARCH_DEFAULT_CATEGORIES } = require('../../search/search-utils')
const { createDefaultAssignments, createDefaultProviders } = require('./ai-providers')
const { DEFAULT_CLIPBOARD } = require('./clipboard-settings')

const DEFAULT_AI_PROVIDERS = createDefaultProviders()

// Pure data: the settings shape the store starts from and resets to. It lives on
// its own so the defaults can be read, diffed and referenced without loading the
// assembly layer.
const DEFAULT_SETTINGS = {
  apiKey: '',
  clipboard: { ...DEFAULT_CLIPBOARD, excludedApps: [] },
  providers: DEFAULT_AI_PROVIDERS,
  theme: 'system',
  mainColor: '#e5a44c',
  borderRadius: 8,
  compact: false,
  language: 'zh-CN',
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
    annotationWidth: 4,
    // A3 (2026-10-14 plan): the capture palette's persisted default colour. The
    // value stays unwhitelisted on the main side - only its type is checked - and
    // capture/annotation-style.js normalises the #rrggbb shape on read.
    annotationColor: '#ff3b30',
    // B4 (D7): one remembered style per drawing tool. This block IS the validation
    // template (settings-validation recurses through it), so every field the capture
    // window may write has to be enumerated here - an unlisted field is rejected.
    // Value ranges (2/4/8, the dash/fill/alpha preset ids) are normalised by
    // capture/annotation-style.js on read, exactly like annotationWidth.
    annotationStyles: {
      rect: { color: '#ff3b30', width: 4, fill: 'none', dash: 'solid', radius: 0 },
      ellipse: { color: '#ff3b30', width: 4, fill: 'none', dash: 'solid' },
      arrow: { color: '#ff3b30', width: 4, dash: 'solid', startHead: false, endHead: true },
      line: { color: '#ff3b30', width: 4, dash: 'solid' },
      pen: { color: '#ff3b30', width: 4 },
      highlight: { color: '#ffcc00', width: 4, alpha: 'medium' },
      text: { color: '#ff3b30', width: 4, bold: false },
      serial: { color: '#ff3b30', width: 4 }
    },
    captureCursor: false,
    shutterSound: true,
    nameTemplate: '',
    lastSaveDirectory: '',
    keepSerialAcrossCaptures: false,
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
  pinned: {
    clickThrough: false
  },
  record: {
    frameRate: 24,
    saveDirectory: '',
    audioSystem: true,
    audioMicrophone: false,
    audioSystemGain: 1,
    audioMicrophoneGain: 1,
    captureCursor: false
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
  // Index-Translate proxy bridge (docs/proxy-bridge-tray-integration.md). This
  // block IS the patch-validation template, so every field the settings page may
  // write has to be listed here; an unlisted key is rejected outright.
  // autoStart stays false so tests, CI and a plain `npm start` never spawn python.
  proxy: {
    autoStart: false,
    port: 8080,
    // Loopback only by default: the proxy relays to a public endpoint without
    // authentication, so 0.0.0.0 would expose it to the whole LAN.
    host: '127.0.0.1',
    // Typically F:\workspace\Index-Translate; empty means "not configured yet"
    // and the tray surfaces that instead of guessing a path.
    repoDirectory: '',
    // Overrides repoDirectory/inference/llm/call_api.py when set. Absolute only.
    scriptPath: '',
    // Empty means: try "py -3", then "python" (python3/python elsewhere).
    pythonPath: '',
    // Empty means the script's own default upstream (the public cloud endpoint).
    apiBase: '',
    // false keeps the proxy tied to Highlighter's lifetime.
    keepRunningOnExit: false
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
    openClipboardHistory: '',
    localSearch: 'Alt+F',
    explainClipboard: 'Ctrl+Alt+E',
    screenshotQuickSave: '',
    screenshotSaveAs: '',
    togglePinClickThrough: '',
    toggleTranslationProxy: ''
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_AI_PROVIDERS
}
