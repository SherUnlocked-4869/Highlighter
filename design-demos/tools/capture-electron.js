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
// is `img-src highlighter-clipboard:` only, so the thumbnail grid can only be
// captured by registering that scheme as privileged before app.whenReady
// (mirroring main.js) and serving a deterministic PNG per record through
// protocol.handle() once ready.
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
// Image records are grouped in runs of `cols` (4 at the panel's 480 DIP width),
// so this fixture is ordered to produce two complete grid rows. Eight images is
// the minimum that makes the grid unambiguous in one screenshot: a single tile
// cannot prove the columns work, and one row cannot prove the row model stacks
// image and text rows without drift. Ids are distinct because the protocol
// handler serves a different deterministic PNG for each.
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
    id: 'f6a7b8c9-0d1e-4f2a-8b3c-4d5e6f7a8b90', kind: 'image', isPinned: false,
    previewText: 'Design-Review-October.png',
    sourceDisplayName: '截图工具', lastCopiedAt: CLIP_NOW - 14 * 60e3, lastUsedAt: CLIP_NOW - 14 * 60e3,
    byteLength: 1468006, width: 1600, height: 1200
  },
  {
    id: 'b8c9d0e1-2f3a-4b4c-8d5e-6f7a8b9c0d12', kind: 'image', isPinned: true,
    previewText: '微信图片_20261015203012.png',
    sourceDisplayName: '微信', lastCopiedAt: CLIP_NOW - 19 * 60e3, lastUsedAt: CLIP_NOW - 12 * 60e3,
    byteLength: 310272, width: 1120, height: 630
  },
  {
    id: 'a7b8c9d0-1e2f-4a3b-9c4d-5e6f7a8b9c01', kind: 'image', isPinned: false,
    previewText: 'CleanShot-2026-10-15.png',
    sourceDisplayName: 'Google Chrome', lastCopiedAt: CLIP_NOW - 17 * 60e3, lastUsedAt: CLIP_NOW - 16 * 60e3,
    byteLength: 2202009, width: 2560, height: 1440
  },
  {
    id: 'c3d2e4f6-7a8b-4c0d-9e1f-2a3b4c5d6e73', kind: 'text', isPinned: false,
    previewText: 'npm run verify:all 通过后再合并 #1287，避免夜间回归。',
    sourceDisplayName: 'Visual Studio Code', lastCopiedAt: CLIP_NOW - 20 * 60e3, lastUsedAt: CLIP_NOW - 18 * 60e3, byteLength: 78
  },
  {
    id: 'c9d0e1f2-3a4b-4c5d-9e6f-7a8b9c0d1e23', kind: 'image', isPinned: false,
    previewText: 'Lightroom-export-01.png',
    sourceDisplayName: 'Lightroom', lastCopiedAt: CLIP_NOW - 24 * 60e3, lastUsedAt: CLIP_NOW - 23 * 60e3,
    byteLength: 833536, width: 1440, height: 900
  },
  {
    id: 'd0e1f2a3-4b5c-4d6e-8f7a-8b9c0d1e2f34', kind: 'image', isPinned: false,
    previewText: '幻灯片1.PNG',
    sourceDisplayName: 'PowerPoint', lastCopiedAt: CLIP_NOW - 28 * 60e3, lastUsedAt: CLIP_NOW - 27 * 60e3,
    byteLength: 1048576, width: 1920, height: 1080
  },
  {
    id: 'e1f2a3b4-5c6d-4e7f-9a8b-9c0d1e2f3a45', kind: 'image', isPinned: false,
    previewText: 'Snipaste_2026-10-12_09-30-51.png',
    sourceDisplayName: '截图工具', lastCopiedAt: CLIP_NOW - 32 * 60e3, lastUsedAt: CLIP_NOW - 31 * 60e3,
    byteLength: 194560, width: 800, height: 600
  },
  {
    id: 'f2a3b4c5-6d7e-4f8a-9b9c-0d1e2f3a4b56', kind: 'image', isPinned: false,
    previewText: 'Figma-Export-2026-10-11.png',
    sourceDisplayName: 'Figma', lastCopiedAt: CLIP_NOW - 33 * 60e3, lastUsedAt: CLIP_NOW - 33 * 60e3,
    byteLength: 655360, width: 1280, height: 800
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
  'f6a7b8c9-0d1e-4f2a-8b3c-4d5e6f7a8b90': { kind: 'image', truncated: false, text: '' },
  'a7b8c9d0-1e2f-4a3b-9c4d-5e6f7a8b9c01': { kind: 'image', truncated: false, text: '' },
  'b8c9d0e1-2f3a-4b4c-8d5e-6f7a8b9c0d12': { kind: 'image', truncated: false, text: '' },
  'c3d2e4f6-7a8b-4c0d-9e1f-2a3b4c5d6e73': { kind: 'text', truncated: false, text: 'npm run verify:all 通过后再合并 #1287，避免夜间回归。' },
  'c9d0e1f2-3a4b-4c5d-9e6f-7a8b9c0d1e23': { kind: 'image', truncated: false, text: '' },
  'd0e1f2a3-4b5c-4d6e-8f7a-8b9c0d1e2f34': { kind: 'image', truncated: false, text: '' },
  'e1f2a3b4-5c6d-4e7f-9a8b-9c0d1e2f3a45': { kind: 'image', truncated: false, text: '' },
  'f2a3b4c5-6d7e-4f8a-9b9c-0d1e2f3a4b56': { kind: 'image', truncated: false, text: '' },
  'd4e3f5a7-8b9c-4d1e-0f2a-3b4c5d6e7f84': { kind: 'text', truncated: false, text: '小鹿：周五的评审改到 14:30，会议室 3F-北。' },
  'e5f4a6b8-9cad-4e2f-1a3b-4c5d6e7f8a95': { kind: 'url', truncated: false, text: 'https://developer.mozilla.org/zh-CN/docs/Web/CSS/color-scheme' }
}

// Shared probe for the clipboard surfaces: prints the state that a static
// screenshot alone cannot prove into REPORT.txt. Since image records became a
// thumbnail grid, the facts that matter are the grid's own: how many image rows
// and plates are mounted, the plate geometry, whether each plate's <img> actually
// got a capability URL and decoded (a blank grid and a working grid are
// indistinguishable in a small PNG otherwise), and which plate state classes are
// still set. The text/feedback facts are kept because the other clipboard
// surfaces (list, empty, feedback) still render through them.
const CLIP_PROBE = `(() => {
  const list = document.getElementById('list')
  const rows = document.getElementById('rows')
  const feedback = document.getElementById('feedback')
  const feedbackText = document.getElementById('feedbackText')
  const empty = document.getElementById('empty')
  const detail = document.getElementById('detail')
  const badge = document.getElementById('detailBadge')
  const meta = document.getElementById('detailMeta')
  const text = document.getElementById('text')
  const tiles = [...rows.querySelectorAll('.tile')]
  const first = tiles[0]
  const rect = first ? first.getBoundingClientRect() : null
  const states = { loading: 0, failed: 0, none: 0 }
  for (const tile of tiles) {
    const state = tile.getAttribute('data-state')
    if (state === 'loading' || state === 'failed') states[state]++
    else states.none++
  }
  const images = tiles.map((tile) => tile.querySelector('img')).filter(Boolean)
  const withSrc = images.filter((image) => image.getAttribute('src')).length
  const decoded = images.filter((image) => image.complete && image.naturalWidth > 0).length
  // Selection can be a text row or a plate; report whichever is mounted so the
  // probe stays meaningful for both the list and image surfaces.
  const picked = rows.querySelector('[aria-selected="true"]')
  const selected = picked ? (() => { const r = picked.getBoundingClientRect(); return (picked.classList.contains('tile') ? 'tile ' : 'row ') + Math.round(r.height) + '@' + Math.round(r.top) + '-' + Math.round(r.bottom) })() : null
  return {
    textRows: rows.querySelectorAll('.row').length,
    gridRows: rows.querySelectorAll('.grid-row').length,
    tiles: tiles.length,
    tileRect: rect ? Math.round(rect.width) + 'x' + Math.round(rect.height) + '@' + Math.round(rect.top) : null,
    tileStates: states,
    tileImgsWithSrc: withSrc,
    tileImgsDecoded: decoded,
    cols: getComputedStyle(rows).getPropertyValue('--cols').trim() || null,
    viewport: Math.round(list.clientHeight) + ' scrollTop' + Math.round(list.scrollTop),
    selected,
    emptyHidden: empty ? empty.hidden : null,
    detailHidden: detail ? detail.hidden : null,
    detailBadge: badge ? badge.textContent : null,
    detailMeta: meta ? meta.textContent.slice(0, 40) : null,
    detailText: text ? text.textContent.slice(0, 18) : null,
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
  // list/status/detail/previews, and listens for raw init/paste-result payloads.
  // `previews(ids)` is the batch contract from preload-clipboard.js:13 —
  // main/ipc/clipboard-ipc.js:27 — main/domains/clipboard/index.js:250. One
  // entry per requested id, in the caller's order; a missing/falsey `url` means
  // the renderer draws its failed-thumbnail placeholder, so every id gets one.
  'clipboard/clipboard.html': `
    window.__hlClip = { status: ${JSON.stringify(CLIPBOARD_STATUS)}, imageId: ${JSON.stringify(CLIP_IMAGE_ID)} }
    window.clipboardAPI = window.__makeBridge({
      onInit: window.__on('init'), onStatus: window.__on('status'), onHistory: window.__on('history'),
      onHidden: window.__on('hidden'), onPasteResult: window.__on('pasteResult'), onLanguage: window.__on('language'),
      ready() {}, interactive() {}, close() {},
      list: async () => ({ ok: true, result: window.__hlSurface.fixture === 'empty' ? { items: [], cursor: null } : { items: ${JSON.stringify(CLIPBOARD_ITEMS)}, cursor: null } }),
      status: async () => ({ ok: true, result: ${JSON.stringify(CLIPBOARD_STATUS)} }),
      detail: async (id) => ({ ok: true, result: ${JSON.stringify(CLIPBOARD_DETAILS)}[id] || { text: '', truncated: false, kind: 'text' } }),
      previews: async (ids) => ({ ok: true, result: ids.map((id) => ({ id, url: 'highlighter-clipboard://preview/' + id })) }),
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
    act: `(async () => {
      // Select the first text row, then wait until its plate neighbours have
      // decoded too: the grid and the text list render from the same pass, and a
      // capture that shows tiles before their bitmaps arrive would document a
      // broken-looking panel.
      const row = document.querySelector('#rows .row')
      if (row) row.click()
      await new Promise((r) => setTimeout(r, 450))
      return row ? 'row-clicked' : 'no-rows'
    })()`
  },
  {
    name: 'clipboard-image', file: 'clipboard/clipboard.html', w: 480, h: 640, fixture: 'image', probe: CLIP_PROBE, bg: { light: '#eeebe4', dark: '#121110' },
    act: `(async () => {
      // Selecting an image record is a pure selection now: it never opens the
      // detail sheet, so the surface's job is to prove the grid's thumbnails
      // arrive. Poll until every mounted plate's <img> has a capability URL AND
      // has decoded (naturalWidth > 0), not merely an assigned src.
      const tiles = [...document.querySelectorAll('#rows .tile')]
      if (!tiles.length) return 'no-tiles'
      const decoded = () => [...document.querySelectorAll('#rows .tile img')]
        .filter((image) => image.getAttribute('src') && image.complete && image.naturalWidth > 0).length
      const target = document.getElementById('item-' + window.__hlClip.imageId)
      if (target) target.click()
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 100))
        const done = decoded()
        if (done >= tiles.length) return 'tiles-decoded ' + done + '/' + tiles.length
        if (done > 0 && i > 40) return 'tiles-partial ' + done + '/' + tiles.length
      }
      return 'tiles-pending ' + decoded() + '/' + tiles.length
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

// Deterministic per-record preview images for the thumbnail grid.
//
// The panel's page CSP is `img-src highlighter-clipboard:` only, so the grid can
// only be captured by serving real bytes through that scheme. Serving ONE png for
// every id would make the capture worthless: eight identical plates prove
// neither that previews(ids) pairs each URL to the right tile, nor that the grid
// is a grid. Bytes are therefore derived from the record id — same id, same
// bytes on every run (no clock, no RNG) — varying the accent hue, the layout and
// the pixel size, so a screenshot shows visibly distinct thumbnails per cell and
// the probe can prove it from naturalWidth alone.
const previewPngs = new Map()

// FNV-1a over the id: deterministic, dependency-free, spreads similar ids.
const hashId = (id) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

// h in [0,360), s/l in [0,1] -> [r, g, b] in 0..255.
const hslToRgb = (h, s, l) => {
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

// Plausible copy-source geometry: screenshots, photos and square exports. The
// real native pipeline caps the long edge at 240 px, but this fixture's job is
// the layout, so the aspect variety is what matters.
const PREVIEW_SIZES = [[640, 360], [480, 480], [720, 405], [560, 420], [520, 390], [768, 432], [600, 450], [480, 300]]

const buildPreviewPng = (id) => {
  const seed = hashId(id)
  const [width, height] = PREVIEW_SIZES[seed % PREVIEW_SIZES.length]
  const variant = (seed >>> 3) % 3
  const hue = seed % 360
  const accent = hslToRgb(hue, 0.62, 0.52)
  const accentSoft = hslToRgb(hue, 0.58, 0.86)
  const backdrop = hslToRgb(hue, 0.26, 0.15)
  const backdrop2 = hslToRgb(hue, 0.30, 0.23)
  const ink = [88, 94, 106]
  const inkSoft = [162, 168, 178]
  const rule = [212, 216, 222]
  const paper = [247, 248, 250]
  const buffer = Buffer.alloc(width * height * 4)
  // Coordinates are fractions of the image so the three layouts scale to every
  // entry of PREVIEW_SIZES. Filled as raw BGRA: nativeImage then encodes a PNG.
  const band = (fx0, fy0, fx1, fy1, rgb) => {
    const x0 = Math.round(fx0 * width); const y0 = Math.round(fy0 * height)
    const x1 = Math.round(fx1 * width); const y1 = Math.round(fy1 * height)
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
        const at = (y * width + x) * 4
        buffer[at] = rgb[2]; buffer[at + 1] = rgb[1]; buffer[at + 2] = rgb[0]; buffer[at + 3] = 255
      }
    }
  }
  const disc = (fx, fy, radius, rgb) => {
    const cx = fx * width; const cy = fy * height; const r = radius * Math.min(width, height)
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(height, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, Math.ceil(cx + r)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue
        const at = (y * width + x) * 4
        buffer[at] = rgb[2]; buffer[at + 1] = rgb[1]; buffer[at + 2] = rgb[0]; buffer[at + 3] = 255
      }
    }
  }
  // Desk gradient behind the "window": hue-tinted so the plate is not grey.
  for (let y = 0; y < height; y++) {
    const t = y / height
    const rgb = backdrop.map((c, i) => Math.round(c + (backdrop2[i] - c) * t))
    band(0, y / height, 1, (y + 1) / height, rgb)
  }

  if (variant === 0) {
    // A document window with a sidebar and a highlighted callout.
    band(0.07, 0.08, 0.93, 0.92, paper)
    band(0.07, 0.08, 0.93, 0.20, [234, 236, 241])
    band(0.07, 0.20, 0.93, 0.205, rule)
    for (let i = 0; i < 3; i++) band(0.10 + i * 0.023, 0.13, 0.115 + i * 0.023, 0.155, inkSoft)
    band(0.07, 0.205, 0.31, 0.92, [240, 242, 245])
    band(0.31, 0.205, 0.313, 0.92, rule)
    for (let i = 0; i < 8; i++) band(0.095, 0.245 + i * 0.075, 0.29, 0.268 + i * 0.075, i === 0 ? accent : inkSoft)
    band(0.35, 0.26, 0.66, 0.30, accent)
    band(0.35, 0.345, 0.90, 0.365, ink)
    band(0.35, 0.395, 0.84, 0.415, inkSoft)
    band(0.35, 0.445, 0.87, 0.465, inkSoft)
    band(0.35, 0.54, 0.89, 0.83, accentSoft)
    band(0.35, 0.54, 0.89, 0.548, accent)
    band(0.375, 0.60, 0.86, 0.618, inkSoft)
    band(0.375, 0.645, 0.80, 0.663, inkSoft)
    band(0.375, 0.69, 0.83, 0.708, inkSoft)
    band(0.35, 0.87, 0.55, 0.90, accent)
    band(0.585, 0.87, 0.75, 0.90, rule)
  } else if (variant === 1) {
    // A photo: tinted frame, disc motif, caption bars.
    band(0.06, 0.07, 0.94, 0.93, hslToRgb(hue, 0.55, 0.62))
    band(0.06, 0.07, 0.94, 0.50, hslToRgb(hue, 0.52, 0.70))
    disc(0.34, 0.34, 0.17, accentSoft)
    band(0.06, 0.63, 0.94, 0.66, hslToRgb(hue, 0.40, 0.42))
    band(0.10, 0.78, 0.62, 0.82, paper)
    band(0.10, 0.845, 0.44, 0.875, [236, 238, 242])
    band(0.10, 0.90, 0.28, 0.92, hslToRgb(hue, 0.45, 0.36))
  } else {
    // Two cards side by side: a solid accent card and a paper one.
    band(0, 0, 1, 1, hslToRgb(hue, 0.16, 0.90))
    band(0.06, 0.10, 0.47, 0.90, accent)
    band(0.51, 0.10, 0.94, 0.90, paper)
    band(0.51, 0.10, 0.94, 0.104, rule)
    band(0.095, 0.20, 0.42, 0.235, accentSoft)
    band(0.095, 0.30, 0.36, 0.335, hslToRgb(hue, 0.30, 0.78))
    band(0.095, 0.38, 0.40, 0.415, hslToRgb(hue, 0.30, 0.78))
    band(0.095, 0.72, 0.30, 0.79, hslToRgb(hue, 0.35, 0.34))
    band(0.55, 0.20, 0.90, 0.235, ink)
    band(0.55, 0.30, 0.84, 0.335, inkSoft)
    band(0.55, 0.38, 0.88, 0.415, inkSoft)
    band(0.55, 0.46, 0.80, 0.495, inkSoft)
    band(0.55, 0.72, 0.72, 0.79, accent)
    band(0.76, 0.72, 0.90, 0.79, rule)
  }
  return nativeImage.createFromBitmap(buffer, { width, height }).toPNG()
}
const previewPngFor = (id) => {
  if (!previewPngs.has(id)) previewPngs.set(id, buildPreviewPng(id))
  return previewPngs.get(id)
}
// Only the fixture's own image records are served, mirroring the real handler's
// unknown-token 404 — and keeping the byte cache bounded by the fixture.
const CLIP_IMAGE_IDS = new Set(CLIPBOARD_ITEMS.filter((item) => item.kind === 'image').map((item) => item.id))

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

  // Serves one deterministic PNG per image record over the privileged clipboard
  // scheme, mirroring main/domains/clipboard's protocol.handle on the panel
  // session. The URL path segment is the record id (see the fake previews()
  // above), which is what makes each grid cell show a different thumbnail.
  protocol.handle('highlighter-clipboard', (request) => {
    try {
      const url = new URL(request.url)
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (request.method === 'GET' && url.hostname === 'preview' && CLIP_IMAGE_IDS.has(id)) {
        return new Response(previewPngFor(id), { headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
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
