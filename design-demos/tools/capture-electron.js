// Captures every application surface from a real Electron renderer.
//
// Why Electron and not plain Chromium: over file:// these differ. Plain
// Chromium treats each file as origin "null", so CSS mask icons are blocked as
// cross-origin; Electron's file:// origin resolves them normally. Verified with
// the app's locked web preferences (sandbox + webSecurity) in
// .tmp/icon-probe — maskLoads:true, zero console errors. A Chromium-based
// harness therefore reports icon failures that do not exist in the app.
//
// Windows are created hidden (show:false) and captured via capturePage(), so
// nothing is drawn on the user's display. This workspace has a single display,
// and AGENTS.md requires keeping it free.
//
// The IPC bridge is stubbed per surface: this is a layout/contrast capture, not
// an end-to-end test. Real wiring is covered by e2e/.
//
// The clipboard panel needs one piece of real main-process wiring: its page CSP
// is `img-src highlighter-clipboard:` only, so the image-detail surface can only
// be captured by registering that scheme as privileged before app.whenReady
// (mirroring main.js) and serving a deterministic PNG through protocol.handle()
// once ready.
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, protocol, nativeImage } = require('electron')

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(ROOT, 'design-demos', 'shots', 'surfaces')
fs.mkdirSync(OUT, { recursive: true })

const SETTINGS = {
  theme: 'light', mainColor: '#e5a44c', borderRadius: 9, compact: false,
  language: 'zh-CN', skinPath: '', skinOpacity: 18, customCss: '',
  providers: [{
    id: 'deepseek', name: 'DeepSeek', enabled: true, apiKey: '', hasApiKey: true,
    baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-chat', builtin: true,
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }]
  }],
  ai: { maxTokens: 4096, temperature: 0.7, targetLanguage: '中文', assignments: [{ feature: 'chat', providerId: 'deepseek', model: 'deepseek-chat' }] },
  selectionToolbar: {
    enabled: true, clipboardFallback: false,
    buttons: { copy: true, search: true, translate: true, explain: true },
    order: ['copy', 'search', 'translate', 'explain', 'open'],
    prompts: {
      translate: '你是一个专业的翻译助手。请按照设置的语言方向翻译用户输入的文本，只输出翻译结果，不要添加任何额外说明或解释。',
      explain: '你是一个知识渊博的解说专家。请对用户提供的文本进行深入分析和解读：\n\n### 核心要点\n先用一句话概括核心内容。\n\n### 详细解释\n对文本中的关键概念、术语、背景进行详细解释，帮助用户全面理解。如果涉及专业知识，请进行通俗易懂的说明。\n\n### 延伸知识\n补充相关的背景信息、实际应用场景或有趣的引申知识点。\n\n请使用中文回答，内容充实但不冗长，层次分明。'
    },
    customActions: [], searchEngine: 'bing',
    translateLanguages: { source: 'auto', target: '中文' },
    conversation: { enabled: true, maxFollowUpTurns: 10, persist: false }
  },
  toolbarThinking: { translate: 'off', explain: 'high' },
  shortcuts: { screenshot: 'Alt+A', ocr: 'Alt+O', localSearch: 'Alt+S', pin: 'Alt+P', videoRecord: 'Alt+A' },
  screenshot: { autoSaveOnCopy: false, saveDirectory: '', historyEnabled: true, historyLimit: 200, doubleClickCopy: true, selectionMask: 'rgba(0,0,0,.46)', showColorPicker: true, longCaptureDirection: 'vertical' },
  ocr: { modelProfile: 'ppocr-v4-ch', minConfidence: 0.3, detectAngle: false, afterAction: 'none', hotStart: true },
  record: { frameRate: 30, saveDirectory: '' },
  search: { useBundledEverything: true, matchPath: true, maxResults: 600, categories: [] },
  proxy: { autoStart: false, port: 8080, host: '127.0.0.1', apiBase: '' },
  system: { autoStart: true, enableTray: true, gameMode: false, runLog: true },
  // Mirrors main/services/settings-defaults.js: config-function reads
  // settings.pinned.clickThrough, and a missing nested group threw a TypeError.
  pinned: { clickThrough: false },
  plugins: { ocr: true, translation: true, ai: true, video: true }
}

// Generic bridge stub. Enumerating methods by hand kept missing ones (each miss
// surfaced as "X is not a function"), so unknown members resolve to a no-op.
// The methods whose return values the renderers actually consume are given
// fixture data, and the init events are fired so secondary windows render
// populated rather than empty.
const STUB_PRELUDE = `
  const __settings = ${JSON.stringify(SETTINGS)}
  const __searchResults = { total: 5, items: [
    { name: 'Highlighter-架构说明.md', path: 'D:\\\\Projects\\\\Highlighter\\\\docs', fullPath: 'D:\\\\Projects\\\\Highlighter\\\\docs\\\\Highlighter-架构说明.md', extension: 'md', size: 43008, modifiedAt: Date.now() - 3600e3 },
    { name: 'capture-domain.test.js', path: 'D:\\\\Projects\\\\Highlighter\\\\test', fullPath: 'D:\\\\Projects\\\\Highlighter\\\\test\\\\capture-domain.test.js', extension: 'js', size: 18432, modifiedAt: Date.now() - 86400e3 },
    { name: '产品评审纪要.docx', path: 'D:\\\\Docs\\\\工作', fullPath: 'D:\\\\Docs\\\\工作\\\\产品评审纪要.docx', extension: 'docx', size: 129024, modifiedAt: Date.now() - 172800e3 },
    { name: 'screenshot-2026-03-12.png', path: 'D:\\\\Pictures\\\\Screenshots', fullPath: 'D:\\\\Pictures\\\\Screenshots\\\\screenshot-2026-03-12.png', extension: 'png', size: 1468006, modifiedAt: Date.now() - 259200e3 },
    { name: 'release-notes-0.9.md', path: 'D:\\\\Projects\\\\Highlighter', fullPath: 'D:\\\\Projects\\\\Highlighter\\\\release-notes-0.9.md', extension: 'md', size: 6144, modifiedAt: Date.now() - 432000e3 }
  ] }

  const __handlers = {}
  const __fire = (name, payload) => {
    const list = __handlers[name] || []
    for (const fn of list) { try { fn(payload) } catch (e) { console.error(e) } }
  }
  // Mirrors preload-*.js: subscribing returns an unsubscribe cleanup, which the
  // renderers store and call on unload. Returning undefined tripped
  // "cleanup is not a function" once a surface's document was replaced.
  const __on = (name) => function (fn) {
    const list = (__handlers[name] = __handlers[name] || [])
    list.push(fn)
    return () => { const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1) }
  }

  const __base = {
    getSettings: async () => __settings,
    resetSettings: async () => __settings,
    getShortcutStatuses: async () => ({}),
    getSearchStatus: async () => ({ running: true, available: true, ipcAvailable: true, phase: 'ready', version: '1.4.1' }),
    getOcrStatus: async () => ({ available: true, phase: 'ready' }),
    updateSettings: async (p) => Object.assign(__settings, p || {}),
    getAppInfo: async () => ({ version: '2.2.6', platform: 'win32', installType: 'installed' }),
    getUpdateStatus: async () => ({ status: 'idle', channel: 'stable', installType: 'nsis' }),
    getSoftwareDataPaths: async () => ({ root: 'D:/Highlighter' }),
    getHistory: async () => ({ items: [], nextCursor: '', hasMore: false, totalCount: 0 }),
    getHistorySources: async () => ([]),
    getHistoryStats: async () => ({ totalBytes: 0, availableCount: 0, missingCount: 0, orphanCount: 0, orphanBytes: 0 }),
    getDataRoot: async () => ({ path: 'D:/Highlighter', isCustom: false }),
    previewDiagnostics: async () => '' ,
    listHistory: async () => ({ items: [], total: 0 }),
    getSearchCategories: async () => [],
    ensureReady: async () => ({ available: true, phase: 'ready' }),
    getStatus: async () => ({ available: true, phase: 'ready' }),
    query: async () => __searchResults,
    getFileIcon: async () => null,
    recognizeTable: async () => ({ rows: [] }),
    ready() {}
  }

  window.__makeBridge = (extra) => new Proxy(Object.assign({}, __base, extra || {}), {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      return function () { return Promise.resolve(undefined) }
    },
    has() { return true }
  })
  window.__fire = __fire
  window.__on = __on
  window.__handlers = __handlers
`

// Clipboard panel fixtures. Timestamps are relative to the run so the metadata
// line always reads like something copied minutes ago.
const CLIP_NOW = Date.now()
const CLIP_IMAGE_ID = 'c2d4e6f8-1a3b-4c5d-8e9f-0a1b2c3d4e5f'
const CLIPBOARD_STATUS = {
  enabled: true, userPaused: false, available: true, phase: 'running', pausedReasons: [],
  datasetId: 'd1', revision: 12, itemCount: 42, pinnedCount: 3,
  payloadBytes: 1048576, actualDiskBytes: 12976128, pendingGcBytes: 0
}
const CLIPBOARD_ITEMS = [
  {
    id: 'a1f0c2e4-5b6d-4f8a-9c1d-2e3f4a5b6c71', kind: 'text', isPinned: true,
    previewText: '把这段关于暗色模式对比度的评审意见整理成一页要点，明早发给设计组。',
    sourceDisplayName: '微信', lastCopiedAt: CLIP_NOW - 3 * 60e3, lastUsedAt: CLIP_NOW - 2 * 60e3, byteLength: 114
  },
  {
    id: 'b2e1d3f5-6c7a-4b9e-8d0f-1a2b3c4d5e62', kind: 'url', isPinned: false,
    previewText: 'https://github.com/highlighter-app/highlighter/pull/1287',
    sourceDisplayName: 'Google Chrome', lastCopiedAt: CLIP_NOW - 8 * 60e3, lastUsedAt: CLIP_NOW - 6 * 60e3, byteLength: 62
  },
  {
    id: CLIP_IMAGE_ID, kind: 'image', isPinned: false, previewText: 'Snipaste_2026-10-16_21-14-08.png',
    sourceDisplayName: '微信', lastCopiedAt: CLIP_NOW - 11 * 60e3, lastUsedAt: CLIP_NOW - 9 * 60e3,
    byteLength: 428032, width: 1280, height: 720
  },
  {
    id: 'c3d2e4f6-7a8b-4c0d-9e1f-2a3b4c5d6e73', kind: 'text', isPinned: false,
    previewText: 'npm run verify:all 通过后再合并 #1287，避免夜间回归。',
    sourceDisplayName: 'Visual Studio Code', lastCopiedAt: CLIP_NOW - 20 * 60e3, lastUsedAt: CLIP_NOW - 18 * 60e3, byteLength: 78
  },
  {
    id: 'd4e3f5a7-8b9c-4d1e-0f2a-3b4c5d6e7f84', kind: 'text', isPinned: false,
    previewText: '小鹿：周五的评审改到 14:30，会议室 3F-北。',
    sourceDisplayName: '微信', lastCopiedAt: CLIP_NOW - 35 * 60e3, lastUsedAt: CLIP_NOW - 35 * 60e3, byteLength: 69
  },
  {
    id: 'e5f4a6b8-9cad-4e2f-1a3b-4c5d6e7f8a95', kind: 'url', isPinned: false,
    previewText: 'https://developer.mozilla.org/zh-CN/docs/Web/CSS/color-scheme',
    sourceDisplayName: 'Google Chrome', lastCopiedAt: CLIP_NOW - 50 * 60e3, lastUsedAt: CLIP_NOW - 41 * 60e3, byteLength: 66
  }
]
const CLIPBOARD_DETAILS = {
  'a1f0c2e4-5b6d-4f8a-9c1d-2e3f4a5b6c71': {
    kind: 'text', truncated: false,
    text: '把这段关于暗色模式对比度的评审意见整理成一页要点，明早发给设计组。\n\n1. 浮层保持固定暗色，不跟随主题；\n2. 正文对比度至少 4.5:1，次要文字 3:1；\n3. 强调色只保留一个，用户可配置；\n4. 空状态用图标 + 一句话，不要整块插画。\n\n结论：先做低风险的三处修正，下周再评估其余调整。'
  },
  'b2e1d3f5-6c7a-4b9e-8d0f-1a2b3c4d5e62': { kind: 'url', truncated: false, text: 'https://github.com/highlighter-app/highlighter/pull/1287' },
  [CLIP_IMAGE_ID]: { kind: 'image', truncated: false, text: '' },
  'c3d2e4f6-7a8b-4c0d-9e1f-2a3b4c5d6e73': { kind: 'text', truncated: false, text: 'npm run verify:all 通过后再合并 #1287，避免夜间回归。' },
  'd4e3f5a7-8b9c-4d1e-0f2a-3b4c5d6e7f84': { kind: 'text', truncated: false, text: '小鹿：周五的评审改到 14:30，会议室 3F-北。' },
  'e5f4a6b8-9cad-4e2f-1a3b-4c5d6e7f8a95': { kind: 'url', truncated: false, text: 'https://developer.mozilla.org/zh-CN/docs/Web/CSS/color-scheme' }
}

// Shared probe for the clipboard surfaces: prints the state that a static
// screenshot alone cannot prove (detail sheet open, preview decoded, empty
// state, feedback rendered) into REPORT.txt.
const CLIP_PROBE = `(() => {
  const text = document.getElementById('text')
  const image = document.getElementById('image')
  const media = document.getElementById('media')
  const feedback = document.getElementById('feedback')
  const feedbackText = document.getElementById('feedbackText')
  const empty = document.getElementById('empty')
  const detail = document.getElementById('detail')
  const badge = document.getElementById('detailBadge')
  const meta = document.getElementById('detailMeta')
  return {
    rows: document.querySelectorAll('#rows .row').length,
    emptyHidden: empty ? empty.hidden : null,
    detailHidden: detail ? detail.hidden : null,
    detailRect: detail && !detail.hidden ? (() => { const r = detail.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.top) })() : null,
    selectedRect: (() => {
      const row = document.querySelector('#rows .row[aria-selected="true"]')
      if (!row) return null
      const r = row.getBoundingClientRect()
      const list = document.getElementById('list')
      return Math.round(r.height) + '@' + Math.round(r.top) + '-' + Math.round(r.bottom) + '/view' + Math.round(list.clientHeight) + ' scrollTop' + Math.round(list.scrollTop)
    })(),
    detailBadge: badge ? badge.textContent : null,
    detailMeta: meta ? meta.textContent.slice(0, 40) : null,
    detailText: text ? text.textContent.slice(0, 18) : null,
    mediaHidden: media ? media.hidden : null,
    imageHidden: image ? image.hidden : null,
    imageSize: image && image.naturalWidth ? image.naturalWidth + 'x' + image.naturalHeight : 0,
    feedbackHidden: feedback ? feedback.hidden : null,
    feedbackTone: feedback ? feedback.getAttribute('data-tone') : null,
    feedbackText: feedbackText ? feedbackText.textContent.slice(0, 30) : null,
    bodyClass: document.body.className
  }
})()`

const STUBS = {
  'config/config.html': `window.electronAPI = window.__makeBridge({ windowMinimize(){}, windowClose(){} })`,
  'search/search.html': `window.searchAPI = window.__makeBridge({
      onInit: window.__on('init'), onStatusChanged: window.__on('status'),
      onSettingsChanged: window.__on('settings')
    })`,
  'recognition/recognition.html': `window.recognitionAPI = window.__makeBridge({ onInit: window.__on('init') })`,
  'action/action.html': `window.actionBridge = window.__makeBridge({
      onActionStart: window.__on('start'), onActionAppearance: window.__on('appearance')
    }); window.actionAPI = window.actionBridge`,
  'capture/capture.html': `window.captureAPI = window.__makeBridge({ onInit: window.__on('init') })`,
  'record/record.html': `window.recordAPI = window.__makeBridge({ onInit: window.__on('init') })`,
  'record/frame.html': `window.recordFrameAPI = window.__makeBridge({ onInit: window.__on('init') })`,
  'toolbar/toolbar.html': `window.toolbarAPI = window.__makeBridge({
      onAppearance: window.__on('appearance'), onSelection: window.__on('selection')
    })`,
  'long-capture/long-capture.html': `window.longCaptureAPI = window.__makeBridge({ onInit: window.__on('init') })`,
  'long-capture/overlay.html': `window.longOverlayAPI = window.__makeBridge({ onInit: window.__on('init') })`,
  'pin/pin.html': `window.pinAPI = window.__makeBridge({ onInit: window.__on('init'), onUpdate: window.__on('update') })`,
  // The clipboard renderer unwraps IPC results shaped { ok, result } for
  // list/status/detail/preview, and listens for raw init/paste-result payloads.
  'clipboard/clipboard.html': `
    window.__hlClip = { status: ${JSON.stringify(CLIPBOARD_STATUS)}, imageId: ${JSON.stringify(CLIP_IMAGE_ID)} }
    window.clipboardAPI = window.__makeBridge({
      onInit: window.__on('init'), onStatus: window.__on('status'), onHistory: window.__on('history'),
      onHidden: window.__on('hidden'), onPasteResult: window.__on('pasteResult'), onLanguage: window.__on('language'),
      ready() {}, interactive() {}, close() {},
      list: async () => ({ ok: true, result: window.__hlSurface.fixture === 'empty' ? { items: [], cursor: null } : { items: ${JSON.stringify(CLIPBOARD_ITEMS)}, cursor: null } }),
      status: async () => ({ ok: true, result: ${JSON.stringify(CLIPBOARD_STATUS)} }),
      detail: async (id) => ({ ok: true, result: ${JSON.stringify(CLIPBOARD_DETAILS)}[id] || { text: '', truncated: false, kind: 'text' } }),
      preview: async (id) => ({ ok: true, result: { url: 'highlighter-clipboard://preview/' + id } }),
      setPaused: async (paused) => ({ ok: true, result: Object.assign({}, ${JSON.stringify(CLIPBOARD_STATUS)}, { userPaused: paused }) }),
      copy: async () => ({ ok: true, result: {} }),
      paste: async () => ({ ok: true, result: { copied: true, outcome: 'copiedOnly' } }),
      setPinned: async () => ({ ok: true, result: {} }),
      delete: async () => ({ ok: true, result: {} }),
      prepareClear: async () => ({ ok: true, result: { canceled: true } }),
      commitClear: async () => ({ ok: true, result: {} })
    })`
}

// Payloads that make each secondary window show its real content.
const EMIT = {
  'search/search.html': `window.__fire('init', {
    theme: 'system', mainColor: '#e5a44c',
    search: { categories: [], sortMode: 'modified-desc', pageSize: 60, maxResults: 200 }
  })`,
  'recognition/recognition.html': `window.__fire('init', { type: 'ocr', mainColor: '#e5a44c' })`,
  'action/action.html': `window.__fire('start', {
    appearance: { theme: 'system', mainColor: '#e5a44c' }, streamId: 'demo', type: 'translate',
    text: 'Ship a calmer capture tool for Windows — fewer chrome, more focus.'
  })`,
  'toolbar/toolbar.html': `window.__fire('appearance', { theme: 'system', mainColor: '#e5a44c' }); window.__fire('selection', { appearance: { theme: 'system', mainColor: '#e5a44c' }, actions: [{ id: 'copy', label: '复制', icon: 'copy' }, { id: 'search', label: '搜索', icon: 'search' }, { id: 'translate', label: '翻译', icon: 'translate' }, { id: 'explain', label: '解释', icon: 'lightbulb' }, { id: 'open', label: '跳转', icon: 'box-arrow-up-right' }] })`,
  // The paste-result payload is the full window appearance plus pasteFeedback,
  // exactly what main/domains/clipboard sends through clipboard:paste-result.
  'clipboard/clipboard.html': `(() => {
    const appearance = { language: 'zh-CN', dark: false, mainColor: '#e5a44c', generation: 'stub-generation', status: window.__hlClip.status }
    const fixture = window.__hlSurface.fixture
    // Injected is the success outcome the design must carry; the warn variant is
    // the copied-only fallback the main process normally shows this bar for.
    if (fixture === 'feedback') window.__fire('pasteResult', Object.assign({}, appearance, { pasteFeedback: { outcome: 'injected' } }))
    else if (fixture === 'feedback-warn') window.__fire('pasteResult', Object.assign({}, appearance, { pasteFeedback: { outcome: 'copiedOnly', reason: 'PASTE_UNAVAILABLE' } }))
    else window.__fire('init', appearance)
  })()`
}

const SURFACES = [
  // Settings pages: route ids follow the 12-item sidebar (general / capture &
  // recording / AI & models / system & data are settings, the rest are tools).
  { name: 'config-home', file: 'config/config.html', w: 1180, h: 760 },
  { name: 'config-general', file: 'config/config.html', w: 1180, h: 760, route: 'settings-general' },
  { name: 'config-function', file: 'config/config.html', w: 1180, h: 760, route: 'settings-function' },
  { name: 'config-models', file: 'config/config.html', w: 1180, h: 760, route: 'models' },
  { name: 'config-system', file: 'config/config.html', w: 1180, h: 760, route: 'settings-system' },
  { name: 'config-toolbar', file: 'config/config.html', w: 1180, h: 760, route: 'selection-toolbar' },
  { name: 'config-local-search', file: 'config/config.html', w: 1180, h: 760, route: 'local-search' },
  { name: 'config-about', file: 'config/config.html', w: 1180, h: 760, route: 'about' },
  { name: 'search', file: 'search/search.html', w: 720, h: 520 },
  { name: 'recognition', file: 'recognition/recognition.html', w: 560, h: 480 },
  { name: 'action', file: 'action/action.html', w: 380, h: 320 },
  { name: 'capture', file: 'capture/capture.html', w: 900, h: 620 },
  { name: 'record', file: 'record/record.html', w: 780, h: 400 },
  { name: 'record-frame', file: 'record/frame.html', w: 420, h: 260 },
  { name: 'toolbar', file: 'toolbar/toolbar.html', w: 620, h: 56 },
  { name: 'long-capture', file: 'long-capture/long-capture.html', w: 420, h: 560 },
  { name: 'pin', file: 'pin/pin.html', w: 320, h: 220 },
  // Clipboard panel: frameless 480x640 in the app; the paste-result fallback
  // resizes the same window to 480x148 and switches the body to feedback-only.
  // bg mirrors main/domains/clipboard's theme-aware window backgroundColor.
  {
    name: 'clipboard-list', file: 'clipboard/clipboard.html', w: 480, h: 640, fixture: 'list', probe: CLIP_PROBE, bg: { light: '#eeebe4', dark: '#121110' },
    act: `(async () => { const row = document.querySelector('#rows .row'); if (row) row.click(); await new Promise((r) => setTimeout(r, 450)); return row ? 'row-clicked' : 'no-rows' })()`
  },
  {
    name: 'clipboard-image', file: 'clipboard/clipboard.html', w: 480, h: 640, fixture: 'image', probe: CLIP_PROBE, bg: { light: '#eeebe4', dark: '#121110' },
    act: `(async () => {
      const row = document.getElementById('item-' + window.__hlClip.imageId)
      if (row) row.click()
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100))
        const image = document.getElementById('image')
        if (image && !image.hidden && image.complete && image.naturalWidth > 0) return 'image-loaded ' + image.naturalWidth + 'x' + image.naturalHeight
      }
      return 'image-pending'
    })()`
  },
  { name: 'clipboard-empty', file: 'clipboard/clipboard.html', w: 480, h: 640, fixture: 'empty', probe: CLIP_PROBE, bg: { light: '#eeebe4', dark: '#121110' } },
  { name: 'clipboard-feedback', file: 'clipboard/clipboard.html', w: 480, h: 148, fixture: 'feedback', probe: CLIP_PROBE, bg: { light: '#eeebe4', dark: '#121110' } },
  { name: 'clipboard-feedback-warn', file: 'clipboard/clipboard.html', w: 480, h: 148, fixture: 'feedback-warn', probe: CLIP_PROBE, bg: { light: '#eeebe4', dark: '#121110' } }
]

// Optional dev affordance: `electron capture-electron.js --only=clipboard` runs
// one surface instead of all of them while iterating on a single window.
const ONLY = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice('--only='.length)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Mirrors main.js: registerSchemesAsPrivileged must run before app.whenReady().
protocol.registerSchemesAsPrivileged([{ scheme: 'highlighter-clipboard', privileges: { standard: true, secure: true, supportFetchAPI: false } }])

// Deterministic 640x360 preview image for the clipboard image record: a light
// document window over a dark desktop, drawn as raw BGRA and encoded by
// nativeImage so repeated runs produce byte-identical screenshots.
const PREVIEW_W = 640
const PREVIEW_H = 360
const buildPreviewPng = () => {
  const buffer = Buffer.alloc(PREVIEW_W * PREVIEW_H * 4)
  const pixel = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= PREVIEW_W || y >= PREVIEW_H) return
    const at = (y * PREVIEW_W + x) * 4
    buffer[at] = b; buffer[at + 1] = g; buffer[at + 2] = r; buffer[at + 3] = 255
  }
  const fill = (x0, y0, x1, y1, r, g, b) => {
    for (let y = Math.max(0, y0); y < Math.min(PREVIEW_H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(PREVIEW_W, x1); x++) pixel(x, y, r, g, b)
  }
  for (let y = 0; y < PREVIEW_H; y++) {
    const t = y / PREVIEW_H
    fill(0, y, PREVIEW_W, y + 1, Math.round(30 + 14 * t), Math.round(34 + 16 * t), Math.round(42 + 20 * t))
  }
  fill(52, 32, 588, 328, 247, 248, 250)
  fill(52, 32, 588, 68, 233, 236, 241)
  fill(52, 68, 588, 69, 213, 217, 223)
  for (let i = 0; i < 3; i++) fill(68 + i * 14, 46, 74 + i * 14, 52, 196, 201, 209)
  fill(52, 69, 132, 328, 240, 242, 245)
  fill(132, 69, 133, 328, 226, 230, 236)
  for (let i = 0; i < 7; i++) fill(66, 86 + i * 32, 118, 92 + i * 32, 203, 208, 216)
  fill(66, 86, 118, 92, 229, 164, 76)
  fill(152, 88, 226, 100, 229, 164, 76)
  fill(152, 112, 552, 118, 90, 96, 108)
  fill(152, 128, 512, 134, 168, 174, 184)
  fill(152, 144, 540, 150, 168, 174, 184)
  fill(152, 176, 552, 270, 250, 238, 220)
  fill(152, 176, 552, 177, 229, 164, 76)
  fill(168, 192, 536, 198, 201, 190, 172)
  fill(168, 208, 500, 214, 201, 190, 172)
  fill(168, 224, 520, 230, 201, 190, 172)
  fill(152, 288, 260, 300, 229, 164, 76)
  fill(272, 288, 380, 300, 223, 226, 232)
  return nativeImage.createFromBitmap(buffer, { width: PREVIEW_W, height: PREVIEW_H }).toPNG()
}
let previewPng = null

app.disableHardwareAcceleration()
const REPORT_PATH = path.join(OUT, 'REPORT.txt')
// Written after every surface so a mid-run crash still leaves diagnosable output.
const writeReport = (lines) => {
  try { fs.writeFileSync(REPORT_PATH, lines.join('\n')) } catch {}
}
process.on('uncaughtException', (err) => {
  writeReport([`UNCAUGHT: ${err && err.stack ? err.stack : err}`])
  app.exit(1)
})
process.on('unhandledRejection', (err) => {
  writeReport([`UNHANDLED REJECTION: ${err && err.stack ? err.stack : err}`])
  app.exit(1)
})

app.whenReady().then(async () => {
  const report = []
  const lines = []
  const stubDir = path.join(app.getPath('temp'), 'hl-surface-stubs')
  fs.mkdirSync(stubDir, { recursive: true })
  const stubPath = path.join(stubDir, 'stub.js')

  // Serves the deterministic preview PNG over the privileged clipboard scheme,
  // mirroring main/domains/clipboard's protocol.handle on the panel session.
  protocol.handle('highlighter-clipboard', (request) => {
    try {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.hostname === 'preview') {
        previewPng = previewPng || buildPreviewPng()
        return new Response(previewPng, { headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
      }
    } catch {}
    return new Response(null, { status: 404 })
  })

  // A single window is reused for every surface. Creating one BrowserWindow per
  // capture fails on the second loadFile in Electron 43 (ERR_FAILED), and one
  // window also keeps the capture reproducible.
  let win = null
  const getWindow = () => {
    if (win && !win.isDestroyed()) return win
    win = new BrowserWindow({
      show: false,
      width: 1180,
      height: 760,
      webPreferences: {
        // Stub injection needs the main world; the app's real locked
        // preferences are exercised by e2e/ and by .tmp/icon-probe.
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
        preload: stubPath
      }
    })
    // Hidden windows otherwise composite lazily: a DOM state changed by script
    // (open inspector, decoded preview) can be live while capturePage still sees
    // the previous frame. Keep the renderer producing frames.
    win.webContents.setBackgroundThrottling(false)
    return win
  }

  for (const s of SURFACES.filter((surface) => !ONLY || surface.name.startsWith(ONLY))) {
    // Per-surface facts are injected before the page stub so fixtures can branch
    // on the surface being captured (e.g. the clipboard empty state).
    const surfaceInfo = JSON.stringify({ name: s.name, fixture: s.fixture || '' })
    fs.writeFileSync(stubPath, STUB_PRELUDE + `\n;window.__hlSurface = ${surfaceInfo}\n` + (STUBS[s.file] || '') + `
      ;window.__hlSetTheme = (t) => document.body.classList.toggle('dark', t === 'dark')
      ;window.__hlGoto = (r) => { const b = document.querySelector('.nav-item[data-route="' + r + '"]'); if (b) b.click() }
    `)

    const w = getWindow()
    w.setContentSize(s.w, s.h)
    w.setBackgroundColor('#eeebe4')

    const errors = []
    const onConsole = (event, level, message) => {
      const lvl = event && typeof event === 'object' ? event.level : level
      const msg = event && typeof event === 'object' ? event.message : message
      if (lvl === 'error' || lvl >= 2) errors.push(String(msg || ''))
    }
    w.webContents.removeAllListeners('console-message')
    w.webContents.on('console-message', onConsole)

    try {
      await w.loadFile(path.join(ROOT, s.file))
      await sleep(900)
      if (s.route) {
        // The renderer boots asynchronously and its init() ends with
        // navigate('home'), which can land after our click and silently reset the
        // route. Poll the active nav item and re-click until it sticks.
        const route = s.route
        for (let attempt = 0; attempt < 12; attempt++) {
          const active = await w.webContents.executeJavaScript(
            `[...document.querySelectorAll('.nav-item.active')].map(b => b.dataset.route)[0] || ''`)
          if (active === route) break
          await w.webContents.executeJavaScript(
            `(window.__hlGoto && window.__hlGoto(${JSON.stringify(route)}))`)
          await sleep(250)
        }
        await sleep(500)
      }
      if (EMIT[s.file] || s.emit) {
        await w.webContents.executeJavaScript(s.emit || EMIT[s.file])
        await sleep(700)
      }
      // Surface-specific interaction (open the clipboard detail sheet, wait for
      // the preview image to decode) runs before metrics so the capture and the
      // reported numbers describe the same state. A hidden BrowserWindow commits
      // frames lazily, so after the interaction wait two animation frames (with a
      // timer fallback for a fully hidden document) and throw away one capture:
      // without this the list capture raced the inspector paint and showed the
      // bare list while the probe already reported detailHidden:false.
      if (s.act) {
        await w.webContents.executeJavaScript(s.act)
        await w.webContents.executeJavaScript(`new Promise((resolve) => {
          let settled = false
          const finish = () => { if (!settled) { settled = true; resolve('painted') } }
          requestAnimationFrame(() => requestAnimationFrame(finish))
          setTimeout(finish, 900)
        })`)
        await w.webContents.capturePage()
        await sleep(s.settle || 450)
      }

      const probe = s.probe ? await w.webContents.executeJavaScript(s.probe) : null
      const metrics = await w.webContents.executeJavaScript(`(() => ({
        scrollW: document.documentElement.scrollWidth,
        scrollH: document.documentElement.scrollHeight,
        viewW: innerWidth, viewH: innerHeight,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        nodes: document.body.querySelectorAll('*').length,
        railVisible: (() => { const r = document.getElementById('statusRail'); return r ? !r.hidden : null })()
      }))()`)

      // A hidden BrowserWindow produces frames very slowly, so CSS transitions
      // can still be mid-flight (or stuck at their start value) when the capture
      // is taken — which showed up as the sidebar's active highlight lagging one
      // route behind. Freezing transitions makes every capture deterministic.
      // Injected through webContents.insertCSS rather than a <style> element:
      // the clipboard panel's CSP is style-src 'self', so DOM-injected styles
      // would log a violation (and would be dropped).
      await w.webContents.insertCSS('*{transition:none !important;animation:none !important}')
      await sleep(150)

      // Both themes come from the same load; only the class changes.
      for (const theme of ['light', 'dark']) {
        await w.webContents.executeJavaScript(`window.__hlSetTheme && window.__hlSetTheme(${JSON.stringify(theme)})`)
        // The clipboard panel's real window backgroundColor is theme-aware; mirror
        // it so any pixel the panel does not cover matches the app.
        if (s.bg) w.setBackgroundColor(s.bg[theme])
        await sleep(350)
        const image = await w.webContents.capturePage()
        fs.writeFileSync(path.join(OUT, `${s.name}.${theme}.png`), image.toPNG())
        const row = { name: `${s.name}.${theme}`, errors: [...errors], ...metrics }
        report.push(row)
        const over = row.scrollW > row.viewW
        lines.push(`${row.errors.length || over ? 'FAIL' : 'ok  '} ${row.name.padEnd(22)} ${row.viewW}x${row.viewH} page=${row.scrollW}x${row.scrollH} nodes=${row.nodes} rail=${row.railVisible} errors=${row.errors.length}${over ? ' OVERFLOW-X' : ''}`)
        row.errors.slice(0, 2).forEach((e) => lines.push(`      ! ${String(e).slice(0, 150)}`))
        if (probe && theme === 'light') lines.push(`      probe ${JSON.stringify(probe)}`)
        writeReport(lines)
      }
    } catch (err) {
      lines.push(`FAIL ${s.name.padEnd(22)} threw: ${String(err.message).slice(0, 120)}`)
      writeReport(lines)
    }
  }

  if (win && !win.isDestroyed()) win.destroy()
  const problems = report.filter((r) => (r.errors || []).length || r.scrollW > r.viewW).length
  lines.push('', `${problems ? problems + ' surface(s) with errors' : 'all surfaces render clean'}`)
  writeReport(lines)
  console.log(lines.join('\n'))
  app.quit()
})
