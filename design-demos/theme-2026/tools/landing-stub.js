// Preload stub for the landing preview: gives the REAL config window enough of
// its IPC surface to boot, draw a populated home / general route and switch
// theme. Fixture shapes mirror design-demos/tools/capture-electron.js (which is
// the established stub for this window) so the two harnesses cannot disagree
// about what the renderer expects — this file only adds the subset that
// config/routes/*.js touches during boot and on those two routes.
const { contextBridge } = require('electron')

const NOW = Date.now()
const SETTINGS = {
  theme: 'light', mainColor: '#e5a44c', borderRadius: 9, compact: false,
  language: 'zh-CN', skinPath: '', skinOpacity: 18, customCss: '',
  providers: [{ id: 'deepseek', name: 'DeepSeek', enabled: true, apiKey: '', hasApiKey: true, baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-chat', builtin: true, models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }] }],
  ai: { maxTokens: 4096, temperature: 0.7, targetLanguage: '中文', assignments: [{ feature: 'chat', providerId: 'deepseek', model: 'deepseek-chat' }] },
  selectionToolbar: { enabled: true, clipboardFallback: false, buttons: { copy: true, search: true, translate: true, explain: true }, order: ['copy', 'search', 'translate', 'explain', 'open'], prompts: {}, customActions: [], searchEngine: 'bing', translateLanguages: { source: 'auto', target: '中文' }, conversation: { enabled: true, maxFollowUpTurns: 10, persist: false } },
  toolbarThinking: { translate: 'off', explain: 'high' },
  shortcuts: { screenshot: 'Alt+A', ocr: 'Alt+O', localSearch: 'Alt+S', pin: 'Alt+P', videoRecord: 'Alt+A' },
  screenshot: { autoSaveOnCopy: false, saveDirectory: '', historyEnabled: true, historyLimit: 200, doubleClickCopy: true, selectionMask: 'rgba(0,0,0,.46)', showColorPicker: true, longCaptureDirection: 'vertical' },
  ocr: { modelProfile: 'ppocr-v4-ch', minConfidence: 0.3, detectAngle: false, afterAction: 'none', hotStart: true },
  record: { frameRate: 30, saveDirectory: '' },
  search: { useBundledEverything: true, matchPath: true, maxResults: 600, categories: [] },
  proxy: { autoStart: false, port: 8080, host: '127.0.0.1', apiBase: '' },
  system: { autoStart: true, enableTray: true, gameMode: false, runLog: true },
  pinned: { clickThrough: false },
  plugins: { ocr: true, translation: true, ai: true, video: true },
}

const HISTORY = [
  { id: 'h1', source: 'region', createdAt: NOW - 3 * 60e3, width: 2840, height: 1680, bytes: 2_400_000, filePath: 'D:/Highlighter/h1.png', available: true },
  { id: 'h2', source: 'long-capture', createdAt: NOW - 40 * 60e3, width: 1280, height: 4620, bytes: 3_100_000, filePath: 'D:/Highlighter/h2.png', available: true },
  { id: 'h3', source: 'focused-window', createdAt: NOW - 120 * 60e3, width: 1920, height: 1080, bytes: 1_800_000, filePath: 'D:/Highlighter/h3.png', available: false },
  { id: 'h4', source: 'region', createdAt: NOW - 26 * 60 * 60e3, width: 1640, height: 900, bytes: 900_000, filePath: 'D:/Highlighter/h4.png', available: true },
]

// One transparent 1x1 PNG: history cards ask for a thumbnail and the capture must
// not depend on the user's real files existing.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const handlers = {}
const on = (name) => (fn) => {
  ;(handlers[name] = handlers[name] || []).push(fn)
  return () => {
    const at = (handlers[name] || []).indexOf(fn)
    if (at >= 0) handlers[name].splice(at, 1)
  }
}

const api = {
  getSettings: async () => SETTINGS,
  updateSettings: async (patch) => Object.assign(SETTINGS, patch || {}),
  resetSettings: async () => SETTINGS,
  getAppInfo: async () => ({ version: '4.1.2', platform: 'win32', installType: 'installed' }),
  getUpdateStatus: async () => ({ status: 'idle', channel: 'stable', installType: 'nsis' }),
  getSoftwareDataPaths: async () => ({ root: 'D:/Highlighter' }),
  getDataRoot: async () => ({ path: 'D:/Highlighter', isCustom: false }),
  getShortcutStatuses: async () => ({}),
  getSearchStatus: async () => ({ running: true, available: true, ipcAvailable: true, phase: 'ready', version: '1.4.1' }),
  getOcrStatus: async () => ({ available: true, phase: 'ready' }),
  getProxyStatus: async () => ({ running: false, port: 8080 }),
  getClipboardStatus: async () => ({ enabled: true, phase: 'running', itemCount: 42 }),
  getHistory: async ({ limit = 40 } = {}) => ({ items: HISTORY.slice(0, limit), nextCursor: '', hasMore: false, totalCount: HISTORY.length }),
  getHistorySources: async () => ['region', 'long-capture', 'focused-window'],
  getHistoryStats: async () => ({ totalBytes: 1_420_000_000, availableCount: 186, missingCount: 3, orphanCount: 0, orphanBytes: 0 }),
  getHistoryThumbnail: async () => ({ ok: true, dataUrl: PIXEL }),
  getUsage: async () => ({ ok: true, result: { totals: { billable: 1_240_000 }, days: [] } }),
  getUsageStatus: async () => ({ ok: true, result: { sources: [], lastScan: 0 } }),
  getUsageDetail: async () => ({ ok: true, result: [] }),
  getUsageRange: async () => ({ ok: true, result: { totals: { billable: 0 }, days: [] } }),
  windowMinimize() {},
  windowClose() {},
  onNavigate: on('navigate'),
  onHistoryChanged: on('historyChanged'),
  onGameModeChanged: on('gameModeChanged'),
  onUpdateStatus: on('updateStatus'),
  onProxyStatus: on('proxyStatus'),
  onInterfaceLanguage: on('interfaceLanguage'),
  ready() {},
}

// Unknown members must be real functions, not a Proxy: contextBridge deep-clones
// the exposed object into the isolated world, and a Proxy cannot be cloned
// ("An object could not be cloned"), which left window.electronAPI undefined and
// the renderer dying on its first call. So the surface is enumerated explicitly
// and then filled from a known key list.
const NAMES = [
  'getSettings', 'updateSettings', 'resetSettings', 'getAppInfo', 'getUpdateStatus',
  'getSoftwareDataPaths', 'getDataRoot', 'getShortcutStatuses', 'getSearchStatus',
  'getOcrStatus', 'getProxyStatus', 'getClipboardStatus', 'getHistory', 'getHistorySources',
  'getHistoryStats', 'getHistoryThumbnail', 'getUsage', 'getUsageStatus', 'getUsageDetail',
  'getUsageRange', 'onNavigate', 'onHistoryChanged', 'onGameModeChanged', 'onUpdateStatus',
  'onProxyStatus', 'onInterfaceLanguage', 'ready', 'windowMinimize', 'windowClose',
  // Remaining route actions. They resolve to undefined, which every caller in
  // config/routes/*.js either ignores or turns into an "empty" render; the preview
  // only needs the window to paint its populated home / general route.
  'changeDataRoot', 'checkForUpdates', 'chooseDirectory', 'cleanupHistory', 'clearHistory',
  'commitClipboardClear', 'copyHistory', 'copyHistoryPath', 'createCodingPlanProvider',
  'deleteHistory', 'deleteHistoryMany', 'downloadUpdate', 'editHistory', 'executeFunction',
  'exportDiagnostics', 'exportHistory', 'exportHistoryPdf', 'fetchProviderModels',
  'getProviderModels', 'installUpdate', 'openDataDirectory', 'openPath', 'pickDirectory',
  'previewDiagnostics', 'quitApp', 'restartApp', 'revealHistory', 'saveHistoryAs',
  'setClipboardPaused', 'setMainColor', 'setPinned', 'testProvider', 'updateProvider',
  'deleteProvider', 'addProvider', 'getCodingPlanProviders', 'deleteCodingPlanProvider',
  'clearUsage', 'refreshUsage', 'scanUsage', 'onUsageScanProgress', 'getDiagnostics',
].filter((name, i, all) => all.indexOf(name) === i)

const surface = {}
for (const name of NAMES) {
  if (!(name in api)) surface[name] = () => Promise.resolve(undefined)
}

for (const [name, value] of Object.entries(api)) surface[name] = value

contextBridge.exposeInMainWorld('electronAPI', surface)
