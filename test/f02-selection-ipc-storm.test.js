'use strict'

// F02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §3.2):
// everyday typing and scrolling must not wake the Electron main process.
//
// The native hook must keep observing input (highlighter::ObserveInput feeds the
// clipboard coordinator's guardrail/lease logic), so the suppression lives in the
// utility-process host: it mirrors toolbar visibility and only forwards
// key-down/mouse-wheel/mouse-down while the toolbar is on screen. The main process
// hides the toolbar only when it is actually visible, and reports transitions once.

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const {
  DEFAULT_SELECTION_TOOLBAR,
  DEFAULT_TOOLBAR_THINKING,
  TOOLBAR_ACTION_ORDER
} = require('../toolbar/toolbar-utils')
const { createDefaultAssignments, createDefaultProviders } = require('../main/services/ai-providers')
const { createSelectionDomain } = require('../main/domains/selection')
const { SelectionWindowManager } = require('../main/services/selection-window-manager')

const ROOT = path.join(__dirname, '..')
const HOST_PATH = path.join(ROOT, 'main/services/selection-hook-host.js')
const CPP_PATH = path.join(ROOT, 'vendor/selection-hook/src/windows/selection_hook.cc')
const TRANSIENT_PATH = path.join(ROOT, 'vendor/selection-hook/src/windows/lib/transient.cc')

// Runs the real host source in a VM with a fake utility-process parent port, the
// same seam test/selection-hook-host.test.js uses. No native module is loaded.
function createHostFixture() {
  const port = new EventEmitter()
  port.posted = []
  port.postMessage = (message) => port.posted.push(message)
  const instances = []
  class FakeHook extends EventEmitter {
    constructor() { super(); instances.push(this) }
    start() { return true }
    stop() {}
    cleanup() {}
    isRunning() { return true }
    setClipboardCoordinator() {}
    checkClipboardCoordinator() { return Promise.resolve(true) }
  }
  const proc = new EventEmitter()
  proc.pid = 4242
  proc.parentPort = port
  vm.runInNewContext(fs.readFileSync(HOST_PATH, 'utf8'), {
    process: proc,
    require: (name) => {
      assert.equal(name, 'selection-hook', 'the host may only load the native hook module')
      return FakeHook
    },
    setTimeout
  })
  const hook = () => instances.at(-1)
  return {
    port,
    hook,
    clear: () => { port.posted.length = 0 },
    // Host messages are built inside the VM realm; compare plain data, not prototypes.
    outgoing: () => JSON.parse(JSON.stringify(port.posted.filter((message) => message && message.type !== 'ready'))),
    start: () => { port.emit('message', { type: 'start' }) },
    visibility: (visible) => { port.emit('message', { type: 'toolbar-visibility', visible }) },
    sendToHost: (message) => { port.emit('message', message) },
    emitHook: (event, data) => { hook().emit(event, data) }
  }
}

test('F02 host suppresses input events while the toolbar is hidden but keeps observing them', () => {
  const host = createHostFixture()
  assert.equal(host.port.posted[0].type, 'ready', 'the host announces itself to the parent')
  host.start()
  host.clear()

  // A fresh host starts hidden; an explicit false must be just as quiet.
  host.visibility(false)
  host.emitHook('key-down', { uniKey: 'a', vkCode: 65 })
  host.emitHook('mouse-wheel', { x: 3, y: 4, button: 0, flag: -1 })
  host.emitHook('mouse-down', { x: 3, y: 4, button: 0 })
  assert.deepEqual(host.outgoing(), [], 'typing/scrolling/clicking must not wake the main process')

  // The one event the hidden surface still needs: showing the toolbar.
  host.emitHook('text-selection', { text: 'hello' })
  assert.deepEqual(host.outgoing(), [
    { type: 'event', event: 'text-selection', data: { text: 'hello' } }
  ])

  // Input observation is NOT gated: pong still reports the input timestamp the
  // heartbeat/guardrail diagnostics consume even though no event was forwarded.
  host.clear()
  host.sendToHost({ type: 'ping' })
  const pong = host.outgoing().find((message) => message.type === 'pong')
  assert.ok(pong, 'the host still answers liveness probes')
  assert.equal(pong.pid, 4242)
  assert.ok(Number(pong.lastInputAt) > 0, 'suppressed input was still observed by the host')
})

test('F02 host forwards input events again once the toolbar is visible', () => {
  const host = createHostFixture()
  host.start()
  host.clear()

  // Default state: hidden, so the first key press after startup is not forwarded.
  host.emitHook('key-down', { uniKey: 'a' })
  assert.deepEqual(host.outgoing(), [])

  host.visibility(true)
  host.emitHook('key-down', { uniKey: 'b', vkCode: 66 })
  host.emitHook('mouse-wheel', { x: 7, y: 8, button: 0, flag: 1 })
  host.emitHook('mouse-down', { x: 7, y: 8, button: 0 })
  assert.deepEqual(host.outgoing(), [
    { type: 'event', event: 'key-down', data: { uniKey: 'b', vkCode: 66 } },
    { type: 'event', event: 'mouse-wheel', data: { x: 7, y: 8, button: 0, flag: 1 } },
    { type: 'event', event: 'mouse-down', data: { x: 7, y: 8, button: 0 } }
  ], 'a visible toolbar keeps the original events in their original order')

  host.clear()
  host.visibility(false)
  host.emitHook('key-down', { uniKey: 'c' })
  host.emitHook('mouse-wheel', { x: 1, y: 2 })
  host.emitHook('mouse-down', { x: 1, y: 2 })
  assert.deepEqual(host.outgoing(), [], 'hiding the toolbar closes the gate again')
})

// --- main process: hideToolbar must not touch an already hidden window --------

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.messages = []
    this.destroyed = false
    this.crashed = false
  }
  isDestroyed() { return this.destroyed }
  isCrashed() { return this.crashed }
  send(channel, payload) { this.messages.push([channel, payload]) }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.webContents = new FakeWebContents()
    this.destroyed = false
    this.visible = false
    this.hideCalls = 0
    this.size = [options.width, options.height]
    this.position = [0, 0]
  }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop() {}
  loadFile() { return Promise.resolve() }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.webContents.destroyed = true
    this.emit('closed')
  }
  setSize(width, height) { this.size = [width, height] }
  getSize() { return this.size }
  setPosition(x, y) { this.position = [x, y] }
  showInactive() { this.visible = true }
  hide() { this.hideCalls += 1; this.visible = false }
  getBounds() { return { x: this.position[0], y: this.position[1], width: this.size[0], height: this.size[1] } }
}

function createManagerFixture() {
  const windows = []
  const visibility = []
  const timers = new Map()
  let nextTimer = 1
  const manager = new SelectionWindowManager({
    createWindow(pagePath, options) {
      const win = new FakeWindow(options)
      windows.push(win)
      return win
    },
    rootDirectory: ROOT,
    isWindows: true,
    nativeTheme: { shouldUseDarkColors: false },
    getSettings: () => ({ selectionToolbar: { resultWindow: { width: 420, height: 520 } } }),
    updateSettings: () => {},
    toolbarWidth: 200,
    toolbarHeight: 40,
    actionMinWidth: 320,
    actionMinHeight: 240,
    sizeSaveDelayMs: 180,
    onToolbarVisibilityChange: (visible) => { visibility.push(visible) },
    log: () => {},
    setTimer(callback, delay) {
      const id = nextTimer++
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer: (id) => timers.delete(id)
  })
  const selection = { text: 'selected', actions: [], position: { x: 10, y: 20 }, width: 200 }
  return { manager, windows, visibility, timers, selection }
}

test('F02 hideToolbar() does not call win.hide() on an already hidden window', () => {
  const { manager, windows, visibility } = createManagerFixture()
  const toolbar = manager.createToolbarWindow()
  assert.equal(toolbar.visible, false)

  assert.equal(manager.hideToolbar(), false)
  manager.hideToolbar()
  manager.hideToolbar()
  assert.equal(toolbar.hideCalls, 0, 'a hidden window is not hidden again per input event')
  assert.deepEqual(visibility, [], 'nothing is reported when the state does not change')
  assert.equal(windows.length, 1)
})

test('F02 hideToolbar() hides a visible window once and reports one transition', () => {
  const { manager, windows, visibility, selection } = createManagerFixture()

  manager.showToolbarSelection(selection)
  const toolbar = windows.at(-1)
  assert.equal(toolbar.visible, true)
  assert.deepEqual(visibility, [true], 'the show is mirrored to the host once')

  assert.equal(manager.hideToolbar(), true)
  assert.equal(toolbar.visible, false)
  assert.equal(toolbar.hideCalls, 1)
  assert.deepEqual(visibility, [true, false])

  // The old storm: every key/wheel signal called hideToolbar() again.
  manager.hideToolbar()
  manager.hideToolbar()
  assert.equal(toolbar.hideCalls, 1, 'repeated hide signals are no-ops')
  assert.deepEqual(visibility, [true, false], 'no duplicate transition is reported')

  // A recycled window cannot be visible any more, so a stale "visible" state must
  // not survive it (otherwise the host would keep forwarding after a display change).
  manager.showToolbarSelection(selection)
  assert.deepEqual(visibility, [true, false, true])
  manager.recycleToolbarWindow('display-metrics-changed')
  assert.deepEqual(visibility, [true, false, true, false])
})

// --- main process: the domain mirrors visibility into the host ----------------

function createDomainHarness() {
  const providers = createDefaultProviders()
  const state = {
    settings: {
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
    windows: [],
    lifecycleListeners: [],
    disposed: 0,
    started: [],
    logs: []
  }
  const host = {
    posted: [],
    postMessage(message) { this.posted.push(message) }
  }
  let handlers = null

  const domain = createSelectionDomain({
    BrowserWindow: { fromWebContents: () => null },
    clipboard: { writeText: () => {} },
    shell: { openExternal: () => Promise.resolve() },
    nativeTheme: { shouldUseDarkColors: false },
    screen: {
      getCursorScreenPoint: () => ({ x: 400, y: 300 }),
      getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      screenToDipPoint: (point) => point,
      dipToScreenRect: (_source, rect) => rect
    },
    powerMonitor: {
      on() {},
      removeListener() {}
    },
    utilityProcess: {},
    createLocalWindow: (pagePath, options) => {
      const win = new FakeWindow({ ...options, width: options.width || 200, height: options.height || 40 })
      win.loadFile = () => Promise.resolve()
      state.windows.push(win)
      return win
    },
    rootDirectory: ROOT,
    isWin: false,
    getSettings: () => state.settings,
    updateSettings: () => {},
    createTrayIcon: () => {},
    createMainWindow: () => {},
    getPinDomain: () => ({ releasePinnedSlot: () => {}, MAX_PINNED: 3, canPinMore: () => true }),
    isGameModeEnabled: () => state.settings.system.gameMode === true,
    shouldFilterApp: (name) => String(name || '').toLowerCase().includes('highlighter'),
    conversationsDirectory: path.join(ROOT, '.tmp', 'f02-selection-conversations'),
    log: (...args) => state.logs.push(args),
    createHookService: (options) => {
      handlers = options.handlers
      return {
        host,
        onLifecycle(listener) {
          state.lifecycleListeners.push(listener)
          return () => {
            const index = state.lifecycleListeners.indexOf(listener)
            if (index >= 0) state.lifecycleListeners.splice(index, 1)
          }
        },
        start: (reason) => { state.started.push(reason) },
        suspend: () => {},
        dispose: () => { state.disposed += 1 },
        isRunning: () => true
      }
    }
  })

  return { domain, state, host, handlers: () => handlers }
}

test('F02 the selection domain mirrors toolbar visibility into the hook host', () => {
  const { domain, state, host, handlers } = createDomainHarness()
  domain.initSelectionHook()
  assert.deepEqual(state.started, ['startup'])
  assert.equal(state.lifecycleListeners.length, 1)
  assert.equal(host.posted.length, 0, 'nothing is sent before the host exists')

  // A host that just became ready starts hidden; the current (hidden) state is
  // re-sent so a rebuilt host cannot silently disagree with the window.
  for (const listener of [...state.lifecycleListeners]) listener()
  assert.deepEqual(host.posted.at(-1), { type: 'toolbar-visibility', visible: false })

  domain.handleTextSelection({ text: 'hello', programName: 'chrome.exe' })
  assert.deepEqual(host.posted.at(-1), { type: 'toolbar-visibility', visible: true })

  handlers().keyDown({ uniKey: 'a' })
  assert.deepEqual(host.posted.at(-1), { type: 'toolbar-visibility', visible: false })
  const afterHide = host.posted.length
  handlers().keyDown({ uniKey: 'b' })
  handlers().mouseWheel({})
  handlers().mouseDown({ x: 0, y: 0 })
  assert.equal(host.posted.length, afterHide, 'repeated input does not re-post the same state')

  domain.handleTextSelection({ text: 'again', programName: 'chrome.exe' })
  assert.deepEqual(host.posted.at(-1), { type: 'toolbar-visibility', visible: true })
  // Host restart resync: the replacement process must learn the visible state.
  for (const listener of [...state.lifecycleListeners]) listener()
  assert.deepEqual(host.posted.at(-1), { type: 'toolbar-visibility', visible: true })

  domain.disposeSelectionHook()
  assert.equal(state.disposed, 1)
  assert.equal(state.lifecycleListeners.length, 0, 'the lifecycle listener is released with the hook')
})

// --- native source: ObserveInput must stay outside any visibility gate --------

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `missing source marker: ${startMarker}`)
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : -1
  return source.slice(start, end > start ? end : undefined)
}

test('F02 native ObserveInput still counts input and carries no toolbar-visibility branch', () => {
  const cpp = fs.readFileSync(CPP_PATH, 'utf8')
  const transient = fs.readFileSync(TRANSIENT_PATH, 'utf8')
  const keyboardHook = sliceBetween(
    cpp,
    'LRESULT CALLBACK SelectionHook::KeyboardHookCallback',
    'LRESULT CALLBACK SelectionHook::MouseHookCallback'
  )

  const observeAt = keyboardHook.indexOf('highlighter::ObserveInput(')
  const retrievalGateAt = keyboardHook.indexOf('IsRetrievalInFlight()')
  const forwardAt = keyboardHook.indexOf('keyboard_tsfn.NonBlockingCall')
  assert.ok(observeAt >= 0, 'the keyboard hook callback still calls ObserveInput')
  assert.ok(retrievalGateAt > observeAt, 'ObserveInput runs before the retrieval/event gate')
  assert.ok(forwardAt > observeAt, 'ObserveInput runs before the TSFN forward')
  assert.match(
    keyboardHook,
    /if \(nCode == HC_ACTION && currentInstance\)\s*\n\s*highlighter::ObserveInput\(/,
    'ObserveInput is guarded only by HC_ACTION - not by a visibility/input-suppression branch'
  )

  // The visibility state belongs to the host (JS); the native layer must not grow
  // a second gate that could silently skip ObserveInput and break the clipboard
  // coordinator's lease/guardrail accounting.
  assert.doesNotMatch(cpp, /toolbar/i)
  assert.match(cpp, /mouse_tsfn\.NonBlockingCall/)
  assert.match(cpp, /keyboard_tsfn\.NonBlockingCall/)

  // The clipboard guardrail/lease logic reads the InputSerial this increments, and
  // it is updated on the hook thread before any JavaScript sees the event.
  const observeBody = sliceBetween(transient, 'void ObserveInput(', 'std::array<BYTE,128> TransientLease::packet')
  assert.match(observeBody, /inputSerial\.fetch_add\(/)

  // The host may only flip a flag on toolbar-visibility - it must never stop or
  // reconfigure the native hook (that would also stop ObserveInput).
  const hostSource = fs.readFileSync(HOST_PATH, 'utf8')
  const visibilityCase = sliceBetween(hostSource, "case 'toolbar-visibility':", "case 'ping':")
  assert.match(visibilityCase, /toolbarVisible = message\.visible === true/)
  assert.doesNotMatch(visibilityCase, /hook\.(stop|cleanup)\(|disableClipboard\(/)
  assert.match(hostSource, /function forwardInput\(event, data\) \{\s*if \(!toolbarVisible\) return false/)
})
