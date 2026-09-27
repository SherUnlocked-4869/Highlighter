const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  DEFAULT_SELECTION_TOOLBAR,
  DEFAULT_TOOLBAR_THINKING,
  TOOLBAR_ACTION_ORDER
} = require('../toolbar/toolbar-utils')
const { createDefaultAssignments, createDefaultProviders } = require('../main/services/ai-providers')
const { createSelectionDomain } = require('../main/domains/selection')

const ROOT = path.join(__dirname, '..')

function createFakeWindow(pagePath, options = {}) {
  const listeners = new Map()
  const win = {
    pagePath,
    options,
    destroyed: false,
    visible: false,
    bounds: {
      x: options.x || 0,
      y: options.y || 0,
      width: options.width || 0,
      height: options.height || 0
    },
    webContents: {
      sent: [],
      once() {},
      send(channel, payload) { this.sent.push([channel, payload]) },
      isDestroyed: () => false,
      isCrashed: () => false
    },
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    loadFile: () => Promise.resolve(),
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return win
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) || []) listener(...args)
    },
    setVisibleOnAllWorkspaces() {},
    setAlwaysOnTop() {},
    setResizable() {},
    setSize(width, height) { win.bounds.width = width; win.bounds.height = height },
    getSize: () => [win.bounds.width, win.bounds.height],
    setPosition(x, y) { win.bounds.x = x; win.bounds.y = y },
    setBounds(bounds) { win.bounds = { ...bounds } },
    getBounds: () => ({ ...win.bounds }),
    getContentBounds: () => ({ ...win.bounds }),
    show() { win.visible = true },
    showInactive() { win.visible = true },
    hide() { win.visible = false },
    focus() {},
    close() { win.emit('close'); win.destroyed = true; win.emit('closed') },
    destroy() { win.destroyed = true; win.emit('closed') }
  }
  return win
}

function createHarness(overrides = {}) {
  const providers = createDefaultProviders()
  const state = {
    settings: {
      apiKey: '',
      providers,
      selectionToolbar: {
        ...DEFAULT_SELECTION_TOOLBAR,
        order: [...TOOLBAR_ACTION_ORDER, 'open'],
        conversation: { enabled: true, persist: false }
      },
      toolbarThinking: { ...DEFAULT_TOOLBAR_THINKING },
      system: { gameMode: false },
      ai: { assignments: createDefaultAssignments(providers), targetLanguage: '中文' }
    },
    routes: [],
    trayRefreshes: 0,
    logs: [],
    windows: [],
    powerListeners: new Map()
  }

  const hook = {
    options: null,
    started: [],
    suspended: [],
    powerEvents: [],
    disposed: 0,
    startOptionsPatches: []
  }

  const domain = createSelectionDomain({
    BrowserWindow: { fromWebContents: () => null },
    clipboard: { writeText: () => {} },
    shell: { openExternal: () => Promise.resolve() },
    nativeTheme: { shouldUseDarkColors: false },
    screen: {
      getCursorScreenPoint: () => ({ x: 400, y: 300 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      screenToDipPoint: (point) => point,
      dipToScreenRect: (_source, rect) => rect
    },
    powerMonitor: {
      on(event, listener) { state.powerListeners.set(event, listener) },
      removeListener(event) { state.powerListeners.delete(event) },
      emit(event) { state.powerListeners.get(event)?.() }
    },
    utilityProcess: {},
    createLocalWindow: (pagePath, options) => {
      const win = createFakeWindow(pagePath, options)
      state.windows.push(win)
      return win
    },
    rootDirectory: ROOT,
    isWin: false,
    getSettings: () => state.settings,
    updateSettings: () => {},
    createTrayIcon: () => { state.trayRefreshes += 1 },
    createMainWindow: (route) => { state.routes.push(route) },
    getPinDomain: () => ({ releasePinnedSlot: () => {}, MAX_PINNED: 3, canPinMore: () => true }),
    isGameModeEnabled: () => state.settings.system.gameMode === true,
    shouldFilterApp: (name) => String(name || '').toLowerCase().includes('highlighter'),
    conversationsDirectory: path.join(ROOT, '.tmp', 'selection-domain-conversations'),
    log: (...args) => state.logs.push(args),
    createHookService: (options) => {
      hook.options = options
      return {
        start: (reason) => { hook.started.push(reason) },
        suspend: (reason) => { hook.suspended.push(reason) },
        notePowerEvent: (type, reason) => { hook.powerEvents.push([type, reason]) },
        updateStartOptions: (patch) => { hook.startOptionsPatches.push(patch) },
        dispose: () => { hook.disposed += 1 }
      }
    },
    ...overrides
  })

  return { domain, state, hook }
}

test('text selection routes to the toolbar window and filters its own process', () => {
  const { domain, state } = createHarness()

  domain.handleTextSelection({ text: '  hello  ', programName: 'chrome.exe', posLevel: 0 })
  const toolbar = state.windows.at(-1)
  assert.ok(toolbar, 'a toolbar window is created')
  assert.equal(toolbar._pendingToolbarSelection.text, 'hello')
  assert.ok(toolbar._pendingToolbarSelection.actions.length > 0)
  assert.equal(toolbar.visible, true)

  const before = state.windows.length
  domain.handleTextSelection({ text: 'hi', programName: 'Highlighter.exe' })
  assert.equal(state.windows.length, before, 'own process is not offered the toolbar')

  domain.handleTextSelection({ text: '' })
  assert.equal(state.windows.length, before, 'empty selections are ignored')
})

test('an AI action without a configured key opens the model settings route', () => {
  const { domain, state } = createHarness()

  return domain.openToolbarAiAction('explain', 'some text').then((opened) => {
    assert.equal(opened, false)
    assert.deepEqual(state.routes, ['models'])
    assert.equal(state.windows.length, 0, 'no action window is opened without a provider')
  })
})

test('the stream controller tracks ownership, staleness, and finishes exactly once', () => {
  const { domain, state } = createHarness()
  const streams = domain.createIpcController().streams
  const win = createFakeWindow(path.join(ROOT, 'action', 'action.html'))

  const controller = streams.create(win, 7)
  assert.equal(controller.streamId, 7)
  assert.equal(domain.isProcessing(), true)
  assert.equal(streams.getCurrent(), controller)
  assert.equal(streams.isCurrentSender({ sender: win.webContents }), true)
  assert.equal(streams.isCurrentSender({ sender: {} }), false)
  assert.equal(streams.isStaleSignal({ sender: win.webContents }, 8), true)
  assert.equal(streams.isStaleSignal({ sender: win.webContents }, 7), false)
  assert.equal(streams.isStaleSignal({ sender: win.webContents }, null), false)

  assert.equal(streams.cancel(controller, 'user-cancelled'), true)
  assert.equal(domain.isProcessing(), false)
  assert.equal(streams.getCurrent(), null)
  assert.equal(streams.cancel(controller, 'again'), false, 'a finished stream cannot cancel twice')

  const fresh = streams.create(win)
  assert.equal(fresh.streamId, 1, 'an id is allocated when the caller omits one')
  assert.equal(domain.isProcessing(), true)

  // A conversation's own stream id wins: restore reuses a stored id.
  const restored = streams.create(win, 42)
  assert.equal(restored.streamId, 42)
  assert.equal(domain.isProcessing(), true)
})

test('the hook forwards selection and power events, and stops on dispose', () => {
  const { domain, state, hook } = createHarness()

  domain.initSelectionHook()
  assert.deepEqual(hook.started, ['startup'])
  assert.equal(typeof hook.options.handlers.textSelection, 'function')
  assert.equal(hook.options.startOptions.enableClipboard, state.settings.selectionToolbar.clipboardFallback)

  hook.options.handlers.textSelection({ text: 'from hook', programName: 'chrome.exe' })
  assert.equal(state.windows.at(-1)._pendingToolbarSelection.text, 'from hook')

  domain.registerSelectionPowerEvents()
  assert.deepEqual([...state.powerListeners.keys()].sort(), ['lock-screen', 'resume', 'suspend', 'unlock-screen'])

  state.powerListeners.get('suspend')()
  state.powerListeners.get('lock-screen')()
  state.powerListeners.get('resume')()
  state.powerListeners.get('unlock-screen')()
  assert.deepEqual(hook.powerEvents, [
    ['sleep', 'system-suspend'],
    ['sleep', 'lock-screen'],
    ['wake', 'system-resume'],
    ['wake', 'unlock-screen']
  ])

  // Game mode suppresses the wake notifications so the hook is not revived.
  state.settings.system.gameMode = true
  state.powerListeners.get('resume')()
  state.powerListeners.get('unlock-screen')()
  assert.equal(hook.powerEvents.length, 4)

  domain.disposeSelectionHook()
  assert.equal(state.powerListeners.size, 0)
  assert.equal(hook.disposed, 1)
  assert.equal(domain.hookService(), null)
})

test('game mode suspends the hook, hides the toolbar, and cancels the round', () => {
  const { domain, state, hook } = createHarness()
  const streams = domain.createIpcController().streams
  const win = createFakeWindow(path.join(ROOT, 'action', 'action.html'))
  domain.initSelectionHook()
  domain.handleTextSelection({ text: 'hi', programName: 'chrome.exe' })
  const toolbar = state.windows.at(-1)
  const controller = streams.create(win, 1)

  domain.applyGameMode(true)
  assert.deepEqual(hook.suspended, ['game-mode'])
  assert.equal(toolbar.visible, false)
  assert.equal(controller.cancelled, true)
  assert.equal(domain.isProcessing(), false)

  domain.applyGameMode(false)
  assert.deepEqual(hook.started, ['startup', 'game-mode-disabled'])
})

test('window ownership drives renderer-gone recovery for the toolbar only', () => {
  const { domain, state } = createHarness()

  assert.equal(domain.ownsToolbarWindow(null), false)
  assert.equal(domain.ownsActionWindow(null), false)

  domain.handleTextSelection({ text: 'hi', programName: 'chrome.exe' })
  const toolbar = state.windows.at(-1)
  assert.equal(domain.ownsToolbarWindow(toolbar), true)
  assert.equal(domain.handleRendererGone(toolbar, { reason: 'crashed', exitCode: 1 }), true)
  assert.equal(toolbar.destroyed, true)
})

// --- mixed-DPI anchoring -----------------------------------------------------
// The layout the defect was reported on: a 1.5 landscape primary with a 1.25
// portrait secondary to its right. `screenToDipPoint` scales relative to the
// display containing the *physical* point, so feeding it a DIP point resolves
// onto the wrong monitor — the toolbar then clamps into that monitor's work area.
const DIP_PRIMARY = { x: 0, y: 0, width: 2560, height: 1440 }
const DIP_SECONDARY = { x: 2560, y: -136, width: 1152, height: 2048 }
const PHYSICAL_SECONDARY = { x: 3840, y: -170, width: 1440, height: 2560 }

function createMixedDpiScreen({ cursorPoint, calls = [] }) {
  const displays = [
    { workArea: DIP_PRIMARY, scale: 1.5, physical: { x: 0, y: 0, width: 3840, height: 2160 }, origin: { x: 0, y: 0 } },
    { workArea: DIP_SECONDARY, scale: 1.25, physical: PHYSICAL_SECONDARY, origin: { x: DIP_SECONDARY.x, y: DIP_SECONDARY.y } }
  ]
  return {
    calls,
    getCursorScreenPoint: () => cursorPoint,
    getDisplayNearestPoint: (point) => displays.find((display) => (
      point.x >= display.workArea.x && point.x <= display.workArea.x + display.workArea.width
      && point.y >= display.workArea.y && point.y <= display.workArea.y + display.workArea.height
    )) || displays[0],
    screenToDipPoint: (point) => {
      calls.push({ ...point })
      const display = displays.find((item) => point.x >= item.physical.x
        && point.x < item.physical.x + item.physical.width
        && point.y >= item.physical.y
        && point.y < item.physical.y + item.physical.height)
      if (!display) return { ...point }
      return {
        x: display.origin.x + (point.x - display.physical.x) / display.scale,
        y: display.origin.y + (point.y - display.physical.y) / display.scale
      }
    },
    dipToScreenRect: (_source, rect) => rect
  }
}

function insideWorkArea(win, workArea) {
  return win.bounds.x >= workArea.x && win.bounds.x <= workArea.x + workArea.width
    && win.bounds.y >= workArea.y && win.bounds.y <= workArea.y + workArea.height
}

test('a selection on a mixed-DPI secondary display anchors the toolbar on that display', () => {
  const cursorOnSecondary = { x: 3136, y: 720 }   // DIP, middle of the secondary
  const screen = createMixedDpiScreen({ cursorPoint: cursorOnSecondary })
  const { domain, state } = createHarness({ isWin: true, screen })

  // posLevel 0: the hook has no geometry, so the pointer is the anchor and it is
  // already DIP — converting it again is what used to drag the toolbar away.
  domain.handleTextSelection({ text: 'hi', programName: 'chrome.exe', posLevel: 0 })
  const fromCursor = state.windows.at(-1)
  assert.ok(insideWorkArea(fromCursor, DIP_SECONDARY), `cursor anchor left the secondary: ${JSON.stringify(fromCursor.bounds)}`)
  assert.equal(screen.calls.length, 0, 'a DIP pointer point must never be converted')

  // posLevel 3: the hook's physical point is converted exactly once and stays put.
  domain.handleTextSelection({
    text: 'hi',
    programName: 'chrome.exe',
    posLevel: 3,
    endBottom: { x: 4560, y: 900 },
    startBottom: { x: 4400, y: 400 }
  })
  const fromHook = state.windows.at(-1)
  assert.ok(insideWorkArea(fromHook, DIP_SECONDARY), `hook anchor left the secondary: ${JSON.stringify(fromHook.bounds)}`)
  assert.equal(screen.calls.length, 1, 'the hook point is converted exactly once')
  assert.deepEqual(screen.calls[0], { x: 4560, y: 900 })
})
