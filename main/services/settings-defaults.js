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
  // Local AI CLI usage statistics are opt-in: the page shows a consent card on
  // first visit and only scans after the user explicitly enables it.
  usage: { enabled: false },
  providers: DEFAULT_AI_PROVIDERS,
  theme: 'system',
  mainColor: '#e5a44c',
  // FILM (direction B1): the floating-surface language wants a softer corner than
  // Nightshift's 8. Kept in step with --radius in shared/tokens.css, which this
  // value overrides at runtime via an inline style on <html>. Existing installs
  // keep whatever they had: a user who moved the slider chose that.
  borderRadius: 13,
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
      serial: { color: '#ff3b30', width: 4 },
      // Brush plan (D2-B'): the mosaic brush remembers its own width, so the wheel's
      // step survives the gesture. Template membership IS the validation whitelist, so
      // this block and capture/annotation-style.js's TOOL_STYLE_TOOLS must ship together.
      blur: { color: '#ff3b30', width: 4 }
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
    detectAngle: false,
    minConfidence: 0.3,
    afterAction: 'none',
    idleTimeoutMs: 300000
  },
  fixedContent: {
    zoomWithMouse: true,
    opacity: 1
  },
  pinned: {
    clickThrough: false,
    // P1 (2026-10-18 snow migration §9.1): the wheel step for a pinned image.
    // 0.1 keeps the historic 1.1x factor; the pin domain reads it when a window is
    // created, so changing it only affects new pins (a live pin would jump).
    zoomStep: 0.1
  },
  record: {
    frameRate: 24,
    saveDirectory: '',
    audioSystem: true,
    audioMicrophone: false,
    audioSystemGain: 1,
    audioMicrophoneGain: 1
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
  // Index-Translate proxy bridge (docs/proxy-inprocess-relay-plan.md). This block
  // IS the patch-validation template, so every field the settings page may write
  // has to be listed here; an unlisted key is rejected outright.
  // The relay runs inside this process: there is no interpreter, no script path
  // and no child process to keep alive, so none of those are configurable.
  // autoStart stays false so tests, CI and a plain `npm start` never open a port.
  proxy: {
    autoStart: false,
    port: 8080,
    // Loopback only by default: the relay forwards to a public endpoint without
    // authentication, so 0.0.0.0 would expose it to the whole LAN.
    host: '127.0.0.1',
    // Empty means the shipped cloud endpoint. Point this at a local vLLM
    // (http://127.0.0.1:8000/v1) to keep page text on the machine.
    apiBase: ''
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
