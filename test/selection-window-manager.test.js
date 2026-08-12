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
  assert.equal(windows[0].options.backgroundColor, '#121316')

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
    mainColor: '#1677ff'
  })

  manager.broadcastAppearance()
  const expected = ['action:appearance', { theme: 'light', resolvedTheme: 'light', mainColor: '#1677ff' }]
  assert.deepEqual(toolbar.webContents.messages, [
    ['toolbar:appearance', { theme: 'light', resolvedTheme: 'light', mainColor: '#1677ff' }]
  ])
  assert.deepEqual(firstAction.webContents.messages, [expected])
  assert.deepEqual(secondAction.webContents.messages, [expected])
})
