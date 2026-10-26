const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')

const { SelectionWindowManager } = require('../main/services/selection-window-manager')

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.messages = []
    this.destroyed = false
    this.crashed = false
  }

  isDestroyed() { return this.destroyed }
  isCrashed() { return this.crashed }
  send(channel, payload) {
    this.messages.push([channel, payload])
  }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.webContents = new FakeWebContents()
    this.destroyed = false
    this.visible = false
    this.size = [options.width, options.height]
    this.position = [0, 0]
    this.loadError = null
  }

  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  setVisibleOnAllWorkspaces(value, options) { this.visibleOnAllWorkspaces = [value, options] }
  setAlwaysOnTop(value, level) { this.alwaysOnTop = [value, level] }
  loadFile(pagePath) {
    this.loadedPage = pagePath
    return this.loadError ? Promise.reject(this.loadError) : Promise.resolve()
  }
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
  hide() { this.visible = false }
  getBounds() { return { x: this.position[0], y: this.position[1], width: this.size[0], height: this.size[1] } }
}

function createHarness(overrides = {}) {
  const rootDirectory = path.resolve(__dirname, '..')
  const windows = []
  const settingsUpdates = []
  const closedActions = []
  const blurredActions = []
  const logs = []
  const timers = new Map()
  let nextTimer = 1
  let settings = {
    theme: 'system',
    mainColor: '#123456',
    selectionToolbar: { resultWindow: { width: 420, height: 520 } }
  }
  const manager = new SelectionWindowManager({
    createWindow(pagePath, options) {
      const win = new FakeWindow(options)
      windows.push({ pagePath, options, win })
      return win
    },
    rootDirectory,
    isWindows: true,
    nativeTheme: { shouldUseDarkColors: true },
    getSettings: () => settings,
    updateSettings: (patch) => settingsUpdates.push(patch),
    toolbarWidth: 200,
    toolbarHeight: 40,
    actionMinWidth: 320,
    actionMinHeight: 240,
    sizeSaveDelayMs: 180,
    onActionWindowClosed: (win, details) => closedActions.push([win, details]),
    onActionWindowBlur: (win) => blurredActions.push(win),
    log: (...args) => logs.push(args),
    setTimer(callback, delay) {
      const id = nextTimer++
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    ...overrides
  })
  return {
    manager,
    windows,
    settingsUpdates,
    closedActions,
    blurredActions,
    logs,
    timers,
    setSettings: (value) => { settings = value }
  }
}

test('toolbar lifecycle is reused and selection state drives action placement', () => {
  const { manager, windows } = createHarness()
  const toolbar = manager.createToolbarWindow()

  assert.equal(manager.createToolbarWindow(), toolbar)
  assert.equal(windows.length, 1)
  assert.equal(windows[0].pagePath, path.resolve(__dirname, '..', 'toolbar', 'toolbar.html'))
  assert.equal(windows[0].options.hasShadow, false)
  assert.equal(windows[0].options.focusable, false)
  assert.deepEqual(toolbar.visibleOnAllWorkspaces, [true, { visibleOnFullScreen: true }])
  assert.deepEqual(toolbar.alwaysOnTop, [true, 'screen-saver'])

  toolbar.webContents.emit('did-finish-load')
  assert.deepEqual(toolbar.webContents.messages[0], [
    'toolbar:appearance',
    { theme: 'system', resolvedTheme: 'dark', mainColor: '#123456' }
  ])

  manager.showToolbarSelection({
    text: 'selected text',
    actions: [{ id: 'copy', label: '复制' }],
    position: { x: 900, y: 700 },
    width: 260
  })
  assert.deepEqual(toolbar.size, [260, 40])
  assert.deepEqual(toolbar.position, [900, 700])
  assert.equal(toolbar.visible, true)
  assert.equal(toolbar.webContents.messages.at(-1)[0], 'selection:text')

  const action = manager.createActionWindow()
  action.size = [420, 520]
  const positioned = manager.positionActionWindow(action, {
    getDisplayNearestPoint: () => ({ workArea: { x: 100, y: 100, width: 1000, height: 800 } })
  })
  assert.equal(positioned, true)
  assert.deepEqual(action.position, [680, 168])

  manager.hideToolbar()
  assert.equal(toolbar.visible, false)
  toolbar.destroyed = true
  toolbar.emit('closed')
  assert.equal(manager.getToolbarWindow(), null)
})

test('action lifecycle queues renderer messages, saves size, and handles blur and close', () => {
  const { manager, windows, settingsUpdates, blurredActions, closedActions, timers } = createHarness()
  const action = manager.getOrCreateActionWindow()

  assert.equal(manager.getOrCreateActionWindow(), action)
  assert.equal(manager.ownsActionWindow(action), true)
  assert.equal(windows[0].options.width, 420)
  assert.equal(windows[0].options.height, 520)
  assert.equal(windows[0].options.minWidth, 320)
  assert.equal(windows[0].options.minHeight, 240)
  // Assert the CONTRACT, not a literal: the action window must take its backdrop
  // from the shared module, so a palette change (Nightshift -> FILM, 2026-10-24)
  // has exactly one place to move. Pinning the hex here made this test fail for a
  // correct change, and it would have passed a hardcoded wrong colour just as
  // happily.
  const { WINDOW_BACKDROP } = require('../main/services/window-backdrop')
  assert.equal(windows[0].options.backgroundColor, WINDOW_BACKDROP.dark)

  manager.queueActionMessage(action, 'action:start', { text: 'queued' })
  assert.deepEqual(action.webContents.messages, [])
  action.webContents.emit('did-finish-load')
  assert.deepEqual(action.webContents.messages, [['action:start', { text: 'queued' }]])
  manager.queueActionMessage(action, 'stream:data', 'ready')
  assert.deepEqual(action.webContents.messages.at(-1), ['stream:data', 'ready'])

  action.size = [640, 480]
  action.emit('resize')
  assert.equal(timers.size, 1)
  const timer = [...timers.values()][0]
  assert.equal(timer.delay, 180)
  timer.callback()
  assert.deepEqual(settingsUpdates, [
    { selectionToolbar: { resultWindow: { width: 640, height: 480 } } }
  ])

  action.visible = true
  action.emit('blur')
  assert.deepEqual(blurredActions, [action])
  assert.equal(action.visible, false)

  action._isPinned = true
  action.visible = true
  action.emit('blur')
  assert.equal(action.visible, true)
  const replacement = manager.getOrCreateActionWindow()
  assert.notEqual(replacement, action)
  assert.equal(manager.ownsActionWindow(replacement), true)

  action.emit('closed')
  assert.equal(manager.ownsActionWindow(action), false)
  assert.deepEqual(closedActions, [[action, { wasPinned: true }]])
})

test('crashed selection windows fail health checks and are rebuilt', () => {
  const { manager, windows } = createHarness()
  const toolbar = manager.createToolbarWindow()
  toolbar.webContents.crashed = true

  const replacementToolbar = manager.createToolbarWindow()
  assert.notEqual(replacementToolbar, toolbar)
  assert.equal(toolbar.destroyed, true)
  assert.equal(manager.getToolbarWindow(), replacementToolbar)

  const action = manager.getOrCreateActionWindow()
  action.webContents.crashed = true
  const replacementAction = manager.getOrCreateActionWindow()
  assert.notEqual(replacementAction, action)
  assert.equal(action.destroyed, true)
  assert.equal(manager.ownsActionWindow(action), false)
  assert.equal(manager.ownsActionWindow(replacementAction), true)
  assert.equal(windows.length, 4)
})

test('toolbar recovery queues the latest selection until the replacement renderer loads', () => {
  const { manager } = createHarness()
  const firstToolbar = manager.showToolbarSelection({
    text: 'before crash',
    actions: [{ id: 'copy', label: '复制' }],
    position: { x: 100, y: 200 },
    width: 240
  })

  assert.deepEqual(firstToolbar.webContents.messages, [])
  firstToolbar.webContents.emit('did-finish-load')
  assert.equal(firstToolbar.webContents.messages.at(-1)[0], 'selection:text')

  manager.handleRendererGone(firstToolbar, { reason: 'crashed', exitCode: -1 })
  const replacement = manager.showToolbarSelection({
    text: 'first selection after crash',
    actions: [{ id: 'search', label: '搜索' }],
    position: { x: 300, y: 400 },
    width: 280
  })
  manager.showToolbarSelection({
    text: 'latest selection while loading',
    actions: [{ id: 'translate', label: '翻译' }],
    position: { x: 320, y: 420 },
    width: 300
  })

  assert.notEqual(replacement, firstToolbar)
  assert.deepEqual(replacement.webContents.messages, [])
  replacement.webContents.emit('did-finish-load')
  assert.deepEqual(replacement.webContents.messages.at(-1), [
    'selection:text',
    {
      text: 'latest selection while loading',
      actions: [{ id: 'translate', label: '翻译' }],
      appearance: { theme: 'system', resolvedTheme: 'dark', mainColor: '#123456' }
    }
  ])
})

test('renderer exit recovery destroys only owned selection windows', () => {
  const { manager, logs } = createHarness()
  const toolbar = manager.createToolbarWindow()
  const foreign = new FakeWindow({ width: 10, height: 10 })

  assert.equal(manager.handleRendererGone(foreign, { reason: 'crashed', exitCode: -1 }), false)
  assert.equal(foreign.destroyed, false)
  assert.equal(manager.handleRendererGone(toolbar, { reason: 'crashed', exitCode: -1 }), true)
  assert.equal(toolbar.destroyed, true)
  assert.equal(manager.getToolbarWindow(), null)
  assert.match(logs.at(-1).join(' '), /renderer crashed \(-1\)/)
})

test('failed page loads destroy selection windows and allow clean retries', async () => {
  const created = []
  const failures = new Set(['toolbar', 'action'])
  const { manager, closedActions, logs } = createHarness({
    createWindow(pagePath, options) {
      const win = new FakeWindow(options)
      const kind = pagePath.includes(`${path.sep}toolbar${path.sep}`) ? 'toolbar' : 'action'
      if (failures.delete(kind)) win.loadError = new Error(`${kind} fixture failed`)
      created.push(win)
      return win
    }
  })

  const failedToolbar = manager.createToolbarWindow()
  const failedAction = manager.createActionWindow()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(failedToolbar.destroyed, true)
  assert.equal(failedAction.destroyed, true)
  assert.equal(manager.getToolbarWindow(), null)
  assert.equal(manager.ownsActionWindow(failedAction), false)
  assert.deepEqual(closedActions, [[failedAction, { wasPinned: false }]])
  assert.equal(logs.filter((entry) => entry.join(' ').includes('load failed')).length, 2)

  const toolbar = manager.createToolbarWindow()
  const action = manager.getOrCreateActionWindow()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(toolbar.destroyed, false)
  assert.equal(action.destroyed, false)
  assert.equal(created.length, 4)
})

test('appearance is normalized and broadcast to every live selection window', () => {
  const { manager, setSettings } = createHarness()
  const toolbar = manager.createToolbarWindow()
  const firstAction = manager.createActionWindow()
  firstAction._isPinned = true
  const secondAction = manager.getOrCreateActionWindow()
  toolbar.webContents.messages = []

  const settings = {
    theme: 'light',
    mainColor: 'invalid',
    selectionToolbar: { resultWindow: { width: 420, height: 520 } }
  }
  setSettings(settings)
  assert.deepEqual(manager.getAppearance(), {
    theme: 'light',
    resolvedTheme: 'light',
    mainColor: '#e5a44c'
  })

  manager.broadcastAppearance()
  const expected = ['action:appearance', { theme: 'light', resolvedTheme: 'light', mainColor: '#e5a44c' }]
  assert.deepEqual(toolbar.webContents.messages, [
    ['toolbar:appearance', { theme: 'light', resolvedTheme: 'light', mainColor: '#e5a44c' }]
  ])
  assert.deepEqual(firstAction.webContents.messages, [expected])
  assert.deepEqual(secondAction.webContents.messages, [expected])
})

test('a recycled toolbar window is rebuilt on the next selection and keeps its anchor', () => {
  const { manager, windows, logs } = createHarness()
  const first = manager.showToolbarSelection({ text: 'one', actions: [], position: { x: 500, y: 400 }, width: 200 })
  assert.equal(manager.getToolbarWindow(), first)
  assert.deepEqual(manager.lastToolbarPosition, { x: 500, y: 400 })

  assert.equal(manager.recycleToolbarWindow('display-metrics-changed'), true)
  assert.equal(first.destroyed, true)
  assert.equal(manager.getToolbarWindow(), null)
  assert.deepEqual(manager.lastToolbarPosition, { x: 500, y: 400 }, 'the anchor survives a recycle')
  assert.ok(logs.some(([message, reason]) => message === 'Selection toolbar window recycled:' && reason === 'display-metrics-changed'))

  const second = manager.showToolbarSelection({ text: 'two', actions: [], position: { x: 500, y: 400 }, width: 200 })
  assert.notEqual(second, first, 'the next selection builds a fresh window')
  assert.equal(windows.length, 2)
  assert.equal(second.visible, true)
  assert.equal(manager.recycleToolbarWindow('again'), true)
  assert.equal(manager.recycleToolbarWindow('nothing-cached'), false)
})

test('a toolbar window whose native size stopped following setSize is rebuilt once', () => {
  const now = { value: 1000 }
  const { manager, windows, logs } = createHarness({ now: () => now.value })
  const first = manager.createToolbarWindow()
  // The 2026-10-07 failure mode: the window stayed at 508x102 although every
  // show asked for 444x40.
  first.setSize = () => {}

  manager.showToolbarSelection({ text: 'x', actions: [], position: { x: 10, y: 20 }, width: 444 })

  const report = manager.getToolbarPresentationReport()
  assert.equal(report.ok, false)
  assert.equal(report.reason, 'size-mismatch')
  assert.equal(report.rebuilt, true)
  assert.equal(report.requestedSize[0], 444)
  assert.equal(first.destroyed, true, 'the window that cannot be sized is dropped')
  assert.equal(windows.length, 2, 'a replacement is created and shown')
  assert.deepEqual(windows.at(-1).win.size, [444, 40])
  assert.equal(windows.at(-1).win.visible, true)
  assert.equal(windows.at(-1).win._pendingToolbarSelection.text, 'x')
  assert.ok(logs.some(([message]) => message === 'Selection toolbar presentation check failed:'))
})

test('the rebuild cooldown stops a second rebuild for the next selection', () => {
  const now = { value: 5000 }
  const { manager, windows } = createHarness({ now: () => now.value })
  const first = manager.createToolbarWindow()
  first.setSize = () => {}
  manager.showToolbarSelection({ text: 'x', actions: [], position: { x: 10, y: 20 }, width: 444 })
  assert.equal(windows.length, 2)

  const second = windows.at(-1).win
  // The real failure mode: the window is stuck at a native size setSize can no
  // longer change.
  second.size = [508, 102]
  second.setSize = () => {}
  now.value += 1000
  manager.showToolbarSelection({ text: 'y', actions: [], position: { x: 10, y: 20 }, width: 444 })
  assert.equal(windows.length, 2, 'inside the cooldown the failure is only reported')
  assert.equal(manager.getToolbarPresentationReport().ok, false)
  assert.equal(manager.getToolbarPresentationReport().rebuilt, false)

  now.value += 10000
  manager.showToolbarSelection({ text: 'z', actions: [], position: { x: 10, y: 20 }, width: 444 })
  assert.equal(windows.length, 3, 'past the cooldown the window is replaced')
})

test('a toolbar window that never becomes visible is rebuilt', () => {
  const { manager, windows } = createHarness()
  const first = manager.createToolbarWindow()
  first.showInactive = () => {}

  manager.showToolbarSelection({ text: 'x', actions: [], position: { x: 0, y: 0 }, width: 200 })

  assert.equal(manager.getToolbarPresentationReport().reason, 'not-visible')
  assert.equal(manager.getToolbarPresentationReport().rebuilt, true)
  assert.equal(windows.length, 2)
  assert.equal(windows.at(-1).win.visible, true)
})

test('a signal the manager cannot read is not treated as a failure', () => {
  const { manager, windows } = createHarness()
  const first = manager.createToolbarWindow()
  first.getSize = undefined

  manager.showToolbarSelection({ text: 'x', actions: [], position: { x: 1, y: 2 }, width: 260 })

  assert.equal(manager.getToolbarPresentationReport().ok, true)
  assert.equal(manager.getToolbarPresentationReport().actualSize, null)
  assert.equal(windows.length, 1, 'no rebuild without proof of failure')
})

// --- M2/W7 idle reclaim of the unpinned action window -----------------------

const ACTION_WINDOW_RELEASE_MS = 120000

function reclaimTimers(timers) {
  return [...timers.entries()].filter(([, timer]) => timer.delay === ACTION_WINDOW_RELEASE_MS)
}

// A fired timer no longer exists on a real event loop; the fake map keeps it, so
// drop it before invoking to keep "is anything still armed?" assertions honest.
function fireReclaimTimer(timers) {
  const entry = reclaimTimers(timers)[0]
  assert.ok(entry, `expected a ${ACTION_WINDOW_RELEASE_MS}ms reclaim timer`)
  timers.delete(entry[0])
  entry[1].callback()
}

test('an unpinned action window is reclaimed 120s after blur, but a show disarms it', () => {
  const events = []
  const { manager, closedActions, timers } = createHarness({
    onActionWindowReclaim: (win) => { events.push(['reclaim', win]) }
  })
  const action = manager.getOrCreateActionWindow()
  action.on('closed', () => events.push(['closed', action]))

  action.visible = true
  action.emit('blur')
  assert.equal(action.visible, false, 'blur still hides the unpinned window exactly as before')
  assert.equal(reclaimTimers(timers).length, 1, 'hiding arms the reclaim timer')

  // Coming back before the deadline keeps the warm window.
  action.visible = true
  action.emit('show')
  assert.equal(reclaimTimers(timers).length, 0, 'show/focus disarms the pending reclaim')
  assert.equal(action.destroyed, false)

  // The next hide arms a fresh one, and this time it fires.
  action.emit('blur')
  assert.equal(action.visible, false)
  fireReclaimTimer(timers)
  assert.equal(action.destroyed, true)
  assert.deepEqual(events.map(([kind]) => kind), ['reclaim', 'closed'], 'the reclaim callback runs before destroy')
  assert.deepEqual(closedActions, [[action, { wasPinned: false }]], 'closed cleanup still runs exactly once')
  assert.equal(manager.ownsActionWindow(action), false)
  assert.equal(manager.getActionWindow(), null)

  const replacement = manager.getOrCreateActionWindow()
  assert.notEqual(replacement, action, 'a window can be created after a reclaim')
  assert.equal(replacement.destroyed, false)
  assert.equal(manager.ownsActionWindow(replacement), true)
})

test('a pinned action window and a disabled release timeout are never reclaimed', () => {
  const { manager, timers } = createHarness()
  const pinned = manager.createActionWindow()
  pinned._isPinned = true
  pinned.visible = true
  pinned.emit('blur')
  assert.equal(pinned.visible, true, 'a pinned window still does not hide on blur')
  assert.equal(reclaimTimers(timers).length, 0, 'nothing is armed for a pinned window')
  assert.equal(manager.shouldReclaimActionWindow(pinned), false)

  const disabled = createHarness({ actionWindowReleaseMs: 0 })
  const lazy = disabled.manager.getOrCreateActionWindow()
  lazy.visible = true
  lazy.emit('blur')
  assert.equal(lazy.visible, false, 'hiding semantics are unchanged when reclaiming is off')
  assert.equal(reclaimTimers(disabled.timers).length, 0, 'timeout 0 disables reclaiming entirely')
  assert.equal(lazy.destroyed, false)
})

test('a reclaim the domain still owns is skipped once and never retried', () => {
  let reclaimCalls = 0
  const { manager, logs, timers } = createHarness({
    isActionWindowReclaimable: () => false,
    onActionWindowReclaim: () => { reclaimCalls += 1; return true }
  })
  const action = manager.getOrCreateActionWindow()
  action.visible = true
  action.emit('blur')

  fireReclaimTimer(timers)
  assert.equal(action.destroyed, false, 'the blocked window is kept')
  assert.equal(reclaimCalls, 0, 'the domain callback is never the one deciding')
  assert.equal(reclaimTimers(timers).length, 0, 'a skipped fire is not retried')
  assert.ok(logs.some(([message]) => message === 'reclaim-skipped'))
})

test('a reclaim the domain refuses with false is skipped without destroying the window', () => {
  let reclaimCalls = 0
  const { manager, timers } = createHarness({
    onActionWindowReclaim: () => { reclaimCalls += 1; return false }
  })
  const action = manager.getOrCreateActionWindow()
  action.visible = true
  action.emit('blur')

  fireReclaimTimer(timers)
  assert.equal(reclaimCalls, 1)
  assert.equal(action.destroyed, false, 'refusing the reclaim keeps the conversation alive')
  assert.equal(manager.disarmActionWindowReclaim(action), false, 'the timer was consumed, not left armed')
})

test('closing a hidden window disposes its reclaim timer so a stale fire is inert', () => {
  let reclaimCalls = 0
  const { manager, timers } = createHarness({
    onActionWindowReclaim: () => { reclaimCalls += 1; return true }
  })
  const action = manager.getOrCreateActionWindow()
  action.visible = true
  action.emit('blur')
  const entry = reclaimTimers(timers)[0]
  assert.ok(entry)

  // The window goes away for another reason (user close, crash, rebuild) while a
  // reclaim is pending: the timer must be dropped with it.
  action.destroy()
  assert.equal(timers.has(entry[0]), false, 'the pending reclaim timer is cleared')
  entry[1].callback()
  assert.equal(reclaimCalls, 0, 'a stale timer cannot act on a destroyed window')
  assert.equal(manager.ownsActionWindow(action), false)
})

