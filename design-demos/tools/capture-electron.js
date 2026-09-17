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
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(ROOT, 'design-demos', 'shots', 'surfaces')
fs.mkdirSync(OUT, { recursive: true })

const SETTINGS = {
  theme: 'light', mainColor: '#e5a44c', borderRadius: 9, compact: false,
  skinPath: '', skinOpacity: 18, customCss: '',
  providers: [{
    id: 'deepseek', name: 'DeepSeek', enabled: true, apiKey: '', hasApiKey: true,
    baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-chat', builtin: true,
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }]
  }],
  ai: { maxTokens: 4096, temperature: 0.7, targetLanguage: '中文', assignments: [{ feature: 'chat', providerId: 'deepseek', model: 'deepseek-chat' }] },
  shortcuts: { screenshot: 'Alt+A', ocr: 'Alt+O', localSearch: 'Alt+S', pin: 'Alt+P', videoRecord: 'Alt+A' },
  screenshot: { autoSaveOnCopy: false, saveDirectory: '', historyEnabled: true, historyLimit: 200, doubleClickCopy: true, selectionMask: 'rgba(0,0,0,.46)', showColorPicker: true, longCaptureDirection: 'vertical' },
  ocr: { modelProfile: 'ppocr-v4-ch', minConfidence: 0.3, detectAngle: false, afterAction: 'none', hotStart: true },
  record: { frameRate: 30, saveDirectory: '' },
  search: { useBundledEverything: true, categories: [] },
  system: { autoStart: true, gameMode: false, trayIcon: true },
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
  const __on = (name) => function (fn) { (__handlers[name] = __handlers[name] || []).push(fn) }

  const __base = {
    getSettings: async () => __settings,
    resetSettings: async () => __settings,
    getShortcutStatuses: async () => ({}),
    getSearchStatus: async () => ({ running: true, available: true, ipcAvailable: true, phase: 'ready', version: '1.4.1' }),
    getOcrStatus: async () => ({ available: true, phase: 'ready' }),
    updateSettings: async (p) => Object.assign(__settings, p || {}),
    getAppInfo: async () => ({ version: '2.2.6', platform: 'win32', installType: 'installed' }),
    getUpdateStatus: async () => ({ state: 'idle', channel: 'stable' }),
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
  'pin/pin.html': `window.pinAPI = window.__makeBridge({ onInit: window.__on('init'), onUpdate: window.__on('update') })`
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
  'toolbar/toolbar.html': `window.__fire('appearance', { theme: 'system', mainColor: '#e5a44c' }); window.__fire('selection', { appearance: { theme: 'system', mainColor: '#e5a44c' }, actions: [{ id: 'copy', label: '复制', icon: '⧉' }, { id: 'search', label: '搜索', icon: '⌕' }, { id: 'translate', label: '翻译', icon: '译' }, { id: 'explain', label: '解释', icon: '?' }, { id: 'open', label: '跳转', icon: '⇗' }] })`
}

const SURFACES = [
  { name: 'config-home', file: 'config/config.html', w: 1180, h: 760 },
  { name: 'config-hotkeys', file: 'config/config.html', w: 1180, h: 760, route: 'settings-hotkeys' },
  { name: 'config-models', file: 'config/config.html', w: 1180, h: 760, route: 'models' },
  { name: 'config-history', file: 'config/config.html', w: 1180, h: 760, route: 'history' },
  { name: 'config-appearance', file: 'config/config.html', w: 1180, h: 760, route: 'appearance' },
  { name: 'config-function', file: 'config/config.html', w: 1180, h: 760, route: 'settings-function' },
  { name: 'config-system', file: 'config/config.html', w: 1180, h: 760, route: 'settings-system' },
  { name: 'config-about', file: 'config/config.html', w: 1180, h: 760, route: 'about' },
  { name: 'search', file: 'search/search.html', w: 720, h: 520 },
  { name: 'recognition', file: 'recognition/recognition.html', w: 560, h: 480 },
  { name: 'action', file: 'action/action.html', w: 380, h: 320 },
  { name: 'capture', file: 'capture/capture.html', w: 900, h: 620 },
  { name: 'record', file: 'record/record.html', w: 780, h: 400 },
  { name: 'record-frame', file: 'record/frame.html', w: 420, h: 260 },
  { name: 'toolbar', file: 'toolbar/toolbar.html', w: 620, h: 56 },
  { name: 'long-capture', file: 'long-capture/long-capture.html', w: 420, h: 560 },
  { name: 'pin', file: 'pin/pin.html', w: 320, h: 220 }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    return win
  }

  for (const s of SURFACES) {
    fs.writeFileSync(stubPath, STUB_PRELUDE + (STUBS[s.file] || '') + `
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
      if (EMIT[s.file]) {
        await w.webContents.executeJavaScript(EMIT[s.file])
        await sleep(700)
      }

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
      await w.webContents.executeJavaScript(
        `(() => { const s = document.createElement('style'); s.textContent = '*{transition:none !important;animation:none !important}'; document.head.appendChild(s); return 'frozen' })()`)
      await sleep(150)

      // Both themes come from the same load; only the class changes.
      for (const theme of ['light', 'dark']) {
        await w.webContents.executeJavaScript(`window.__hlSetTheme && window.__hlSetTheme(${JSON.stringify(theme)})`)
        await sleep(350)
        const image = await w.webContents.capturePage()
        fs.writeFileSync(path.join(OUT, `${s.name}.${theme}.png`), image.toPNG())
        const row = { name: `${s.name}.${theme}`, errors: [...errors], ...metrics }
        report.push(row)
        const over = row.scrollW > row.viewW
        lines.push(`${row.errors.length || over ? 'FAIL' : 'ok  '} ${row.name.padEnd(22)} ${row.viewW}x${row.viewH} page=${row.scrollW}x${row.scrollH} nodes=${row.nodes} rail=${row.railVisible} errors=${row.errors.length}${over ? ' OVERFLOW-X' : ''}`)
        row.errors.slice(0, 2).forEach((e) => lines.push(`      ! ${String(e).slice(0, 150)}`))
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
