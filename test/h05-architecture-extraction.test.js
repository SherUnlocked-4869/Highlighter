// H05 —— docs/reviews/2026-11-26-code-review-and-optimization-report.md §二.5
//
// main.js was at a hard line ceiling (1330/1330) and had grown 300+ character lines and a
// stray `secureIpcMain.handle('record:pin-frame')` that the on()-only architecture pattern
// could not see. The fix moved the tray to main/domains/tray and every channel registration
// to main/ipc/index.js, expanded the squeezed lines again, and paired the ceiling with a
// line-length cap plus a stricter forbidden-pattern list.
//
// These cases drive the two new modules with fakes (the real ones need Electron) and pin the
// gate itself; the architecture-gate suite already runs the script end to end.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const {
  MAIN_LINE_CEILING,
  MAX_MAIN_LINE_LENGTH,
  FORBIDDEN_IN_MAIN,
  collectFailures
} = require('../scripts/check-architecture')
const { registerAllIpc } = require('../main/ipc')
const { createTrayController } = require('../main/domains/tray')

// ---------- main.js assembly shape ----------

test('H05: main.js no longer registers domain channels or builds the tray itself', () => {
  // Only the two window: channels stay in the assembly file; every domain channel moved out.
  assert.doesNotMatch(mainSource, /secureIpcMain\.(on|handle)\('(?!window:)/)
  // ...which are the two exceptions the design keeps in the assembly file.
  assert.match(mainSource, /secureIpcMain\.on\('window:minimize'/)
  assert.match(mainSource, /secureIpcMain\.on\('window:close'/)
  assert.doesNotMatch(mainSource, /register(?!All)[A-Za-z]*Ipc\(\{/, 'channel registration moved to main/ipc/index.js')
  assert.match(mainSource, /registerAllIpc\(\{/)
  assert.doesNotMatch(mainSource, /new Tray\(/, 'the tray singleton moved to main/domains/tray')
  assert.match(mainSource, /const trayController = createTrayController\(\{/)
  assert.match(mainSource, /function createTrayIcon\(\) \{\s*return trayController\.refresh\(\)\s*\}/)
})

test('H05: record:pin-frame is registered by the recording editor module, not main.js', () => {
  const editorSource = fs.readFileSync(path.join(root, 'main', 'ipc', 'recording-workbench-ipc.js'), 'utf8')
  assert.match(editorSource, /ipcMain\.handle\('record:pin-frame', controller\.editorPinFrame\)/)
  for (const pattern of FORBIDDEN_IN_MAIN) {
    assert.doesNotMatch(mainSource, pattern, `main.js must not contain ${pattern}`)
  }
})

test('H05: the gate now enforces a per-line limit and reports it', () => {
  assert.equal(typeof MAX_MAIN_LINE_LENGTH, 'number')
  assert.ok(MAX_MAIN_LINE_LENGTH <= 200, 'the assembly file must not grow 300-character lines again')
  const { mainLines, longestLine, failures } = collectFailures()
  assert.deepEqual(failures, [])
  assert.ok(mainLines <= MAIN_LINE_CEILING)
  assert.ok(longestLine <= MAX_MAIN_LINE_LENGTH)
  assert.ok(MAIN_LINE_CEILING < 1330, 'the ceiling went down, not up')
  for (const line of mainSource.split(/\r?\n/)) {
    assert.ok(line.length <= MAX_MAIN_LINE_LENGTH, `over-long line: ${line.slice(0, 80)}`)
  }
})

// ---------- main/domains/tray ----------

function createTrayHarness({ enableTray = true, gameMode = false, recording = null } = {}) {
  const state = {
    tray: null,
    tooltips: [],
    menus: [],
    imageSets: 0,
    executeFunctionCalls: [],
    mainWindowRoutes: [],
    destroyed: 0,
    quitCalls: 0
  }
  const settings = {
    system: { enableTray },
    theme: 'system',
    shortcuts: { screenshot: 'F1' },
    clipboard: { enabled: true }
  }
  class FakeTray {
    constructor(image) {
      this.image = image
      this.handlers = {}
      state.tray = this
    }

    on(event, handler) {
      this.handlers[event] = handler
    }

    setImage(image) {
      this.image = image
      state.imageSets += 1
    }

    setToolTip(value) {
      state.tooltips.push(value)
    }

    setContextMenu(menu) {
      state.menus.push(menu)
    }

    destroy() {
      state.destroyed += 1
    }
  }
  const controller = createTrayController({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    app: { quit: () => { state.quitCalls += 1 } },
    path,
    rootDirectory: root,
    // A tiny 1x1 PNG keeps createTrayIconImage + nativeImage happy without touching assets;
    // the file selection itself is what the controller reads back.
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize: () => ({}) }), createEmpty: () => ({}) },
    nativeTheme: { shouldUseDarkColors: false },
    t: (key) => key,
    log: () => {},
    getSettings: () => settings,
    isGameModeEnabled: () => gameMode,
    createMainWindow: (route) => state.mainWindowRoutes.push(route),
    executeFunction: (name) => {
      state.executeFunctionCalls.push(name)
      return Promise.resolve()
    },
    getProxyBridge: () => ({ menuState: () => ({ running: false }) }),
    getPinDomain: () => ({
      exitAllClickThrough: () => 0,
      listPinsByDisplay: () => [],
      trayRecoveryMenu: () => []
    }),
    getRecordDomain: () => ({
      getActiveState: () => recording,
      getActiveStateForTray: undefined,
      openRecordingWorkbench: () => {},
      pauseResumeActive: () => {},
      finishActive: () => {}
    }),
    getSelectionDomain: () => ({ hasConversation: () => false, showOrRestoreConversation: () => {} }),
    getExportResultService: () => null,
    setGameModeEnabled: () => {}
  })
  return { controller, state, settings }
}

test('H05: tray refresh creates the icon once, refreshes the menu and stops when disabled', () => {
  const harness = createTrayHarness()
  const { controller, state, settings } = harness

  controller.refresh()
  assert.ok(state.tray, 'first refresh creates the tray')
  assert.equal(state.tooltips.at(-1).includes('Highlighter'), true)
  assert.equal(state.menus.at(-1).template.length > 0, true)
  const itemCountAfterFirst = state.menus.length

  controller.refresh()
  assert.equal(state.menus.length, itemCountAfterFirst + 1, 'the menu is rebuilt on every refresh')
  assert.equal(state.imageSets, 0, 'an unchanged icon file does not re-set the image')

  settings.system.enableTray = false
  assert.equal(controller.refresh(), null)
  assert.equal(state.destroyed, 1)
  assert.equal(controller.isActive(), false)
})

test('H05: tray click and tooltip reflect game mode and the live recording state', () => {
  const harness = createTrayHarness({ gameMode: true, recording: { status: 'paused' } })
  const { controller, state } = harness
  controller.refresh()
  assert.match(state.tooltips.at(-1), /main\.tray\.tooltip-game-mode/)
  assert.match(state.tooltips.at(-1), /main\.tray\.tooltip-recording-paused/)

  state.tray.handlers.click()
  assert.deepEqual(state.executeFunctionCalls, [], 'game mode suspends the tray screenshot entry')
})

test('H05: tray click bypasses the router only when game mode is off', () => {
  const harness = createTrayHarness()
  const { controller, state } = harness
  controller.refresh()
  state.tray.handlers.click()
  assert.deepEqual(state.executeFunctionCalls, ['screenshot'])
  state.tray.handlers['double-click']()
  assert.deepEqual(state.mainWindowRoutes, ['home'])
})

// ---------- main/ipc/index.js ----------

function fakeController() {
  return new Proxy({}, {
    get: (target, property) => {
      if (property === 'then') return undefined
      if (property === Symbol.toPrimitive) return undefined
      return () => undefined
    }
  })
}

function createFakeIpcMain() {
  const handlers = new Map()
  const listeners = new Map()
  const state = { asserted: false }
  return {
    handlers,
    listeners,
    state,
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error(`duplicate handle: ${channel}`)
      handlers.set(channel, handler)
    },
    on(channel, handler) {
      if (listeners.has(channel)) throw new Error(`duplicate listener: ${channel}`)
      listeners.set(channel, handler)
    },
    assertComplete() {
      state.asserted = true
    }
  }
}

function createIpcHarness({ installUsageFeature } = {}) {
  const ipcMain = createFakeIpcMain()
  const calls = []
  const settings = {
    ai: { maxTokens: 10, temperature: 0.2, targetLanguage: 'zh-CN' },
    providers: []
  }
  const settingsService = {
    getSettings: () => settings,
    getPublicSettings: () => ({ ok: true }),
    updateSettings: (patch) => ({ patch, settings }),
    resetSettings: () => settings,
    prepareProviderConnection: () => ({ ok: true })
  }
  const historyService = {
    list: () => [],
    getThumbnail: () => '',
    listSources: () => [],
    stats: () => ({ totalCount: 0 }),
    getItem: () => null,
    delete: () => true,
    deleteMany: () => ({ deletedCount: 0 }),
    exportMany: () => ({ exportedCount: 0 }),
    cleanup: () => ({}),
    clear: () => true
  }
  const deps = {
    ipcMain,
    app: { getVersion: () => '5.0.1', getPath: () => path.join(root, '.tmp-test'), quit: () => {} },
    path,
    fs,
    shell: { openPath: async () => '' },
    clipboard: { writeImage: () => {}, writeText: () => {} },
    nativeImage: { createFromPath: () => ({}) },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 0 }) },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    log: () => {},
    performanceMonitor: {
      measure: (name, task) => {
        calls.push(name)
        return task()
      }
    },
    windowActions: {
      openExternal: () => {},
      getDisplayDiagnostics: () => ({}),
      chooseDirectory: async () => '',
      openDataDirectory: async () => {},
      openSaveDirectory: async () => {},
      pickDirectory: async () => ''
    },
    getSettings: () => settings,
    getSettingsService: () => settingsService,
    getHistoryService: () => historyService,
    getDiagnosticsService: () => null,
    getMainWindow: () => null,
    getPaths: () => ({ root: path.join(root, '.tmp-test') }),
    getExportResultService: () => null,
    getRegionPreferences: () => null,
    getProxyBridge: () => ({ getStatus: () => ({ running: false }) }),
    getInstallType: () => 'nsis',
    resolveAiAssignment: () => ({ provider: null }),
    aiClient: {
      validateApiKey: async () => ({ ok: true }),
      discoverProviderModels: async () => ({ models: [] }),
      testProviderConnection: async () => ({ ok: true }),
      completeChat: async () => ({}),
      translateText: async () => ({})
    },
    settingsEffects: { applyUpdate: () => {}, applyReset: () => {} },
    preparePatch: () => null,
    assertWritable: () => {},
    shortcutService: { list: () => [], dispose: () => {} },
    dataRootDomain: { createController: () => fakeController() },
    captureDomain: { createCaptureController: () => fakeController(), editHistoryDocument: () => true },
    longCaptureDomain: { createLongCaptureController: () => fakeController() },
    recognitionDomain: { createRecognitionController: () => fakeController() },
    recordDomain: { createRecordingController: () => fakeController() },
    searchDomain: { createSearchController: () => fakeController() },
    selectionDomain: { createIpcController: () => fakeController() },
    ocrController: fakeController(),
    functionRouter: { executeFunction: () => Promise.resolve() },
    resolveUpdateService: () => ({})
  }
  if (installUsageFeature) deps.installUsageFeature = installUsageFeature
  return { deps, calls, historyService, settingsService }
}

test('H05: registerAllIpc registers every domain channel once and asserts completeness', () => {
  const { deps } = createIpcHarness({
    installUsageFeature: ({ ipcMain }) => {
      ipcMain.handle('usage:export', async () => ({}))
      return { handlers: {} }
    }
  })
  const { recordController } = registerAllIpc(deps)
  assert.ok(recordController, 'the recording controller is returned to its caller')

  const channels = [...deps.ipcMain.handlers.keys()]
  for (const channel of [
    'settings:get',
    'settings:update',
    'history:list',
    'history:delete',
    'record:pin-frame',
    'data-root:get',
    'usage:export',
    'shortcuts:status',
    'app:get-info',
    'ocr:status'
  ]) {
    assert.ok(channels.includes(channel), `missing channel ${channel}`)
  }
  // Completeness is asserted by main.js after the two window: channels it still owns, so the
  // aggregation must not do it early.
  assert.equal(deps.ipcMain.state.asserted, false)
  assert.match(mainSource, /secureIpcMain\.assertComplete\(\)/)
  assert.equal(fs.readFileSync(path.join(root, 'main', 'ipc', 'index.js'), 'utf8').includes('assertComplete()'), false)
  // window:minimize/close stay in main.js (D26), so the aggregation must not take them.
  assert.equal(deps.ipcMain.listeners.has('window:minimize'), false)
  assert.equal(deps.ipcMain.listeners.has('window:close'), false)
})

test('H05: the history facade keeps the measured entry points main.js used to inline', () => {
  const { deps, calls } = createIpcHarness({ installUsageFeature: () => ({}) })
  registerAllIpc(deps)
  assert.deepEqual(calls, [])
  deps.ipcMain.handlers.get('history:list')({}, { limit: 10 })
  deps.ipcMain.handlers.get('history:stats')({})
  deps.ipcMain.handlers.get('history:sources')({})
  assert.deepEqual(calls, ['history.list', 'history.stats', 'history.sources'])
})
