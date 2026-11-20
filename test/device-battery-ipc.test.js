'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')
const { createRendererWindowState } = require('../main/services/main-window-reclaimer')
const { registerWindowReclaimIpc } = require('../main/ipc/window-reclaim-ipc')
const { install, FEED } = require('../main/services/device-battery-feature')
const { createSecureWindow } = require('../main/services/window-security')
const { createSecureIpcMain } = require('../main/services/ipc-security')

const root = path.resolve(__dirname, '..')

function fixture() {
  const routes = createRendererWindowState()
  const handles = new Map()
  const listeners = new Map()
  const calls = []
  const sent = []
  const children = new Set()
  const timers = new Map()
  const app = new EventEmitter()
  const powerMonitor = new EventEmitter()
  app.isReady = () => true
  app.quit = () => sent.push(['quit'])
  let id = 0
  class Window extends EventEmitter {
    static fromWebContents(contents) { return contents.window }
    constructor() {
      super()
      this.visible = true
      this.minimized = false
      this.webContents = Object.assign(new EventEmitter(), {
        id: ++id, window: this, isDestroyed: () => false,
        setWindowOpenHandler() {}, send: (...data) => sent.push(data)
      })
    }
    isVisible() { return this.visible }
    isMinimized() { return this.minimized }
    isDestroyed() { return false }
  }
  function createWindow(page) {
    const pagePath = path.join(root, page)
    const win = createSecureWindow({ BrowserWindow: Window, pagePath, options: { webPreferences: { preload: path.join(root, 'preload.js') } } })
    win.webContents.mainFrame = { url: pathToFileURL(pagePath).href }
    return win
  }
  const win = createWindow('config/config.html')
  const other = createWindow('capture/capture.html')
  const guarded = createSecureIpcMain({
    ipcMain: { handle: (name, fn) => handles.set(name, fn), on: (name, fn) => listeners.set(name, fn) },
    BrowserWindow: Window, rootDirectory: root, authorizeRole: (role, candidate) => role === 'main' && candidate === win
  })
  const event = (sender = win.webContents, senderFrame = sender.mainFrame) => ({ sender, senderFrame })
  registerWindowReclaimIpc({ ipcMain: guarded, state: routes, getMainWindow: () => win })
  const feature = install({
    ipcMain: guarded, app, powerMonitor, windowState: routes, getMainWindow: () => win,
    stateDirectory: root, appRoot: root,
    setTimer(callback, ms) { const key = Symbol(); timers.set(key, { callback, ms }); return key },
    clearTimer(key) { timers.delete(key) },
    spawnProcess(_exe, args) {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stdin = Object.assign(new EventEmitter(), { write() {}, end: (data) => calls.push(data) })
      child.kill = () => calls.push('kill')
      children.add(child)
      child.once('close', () => children.delete(child))
      calls.push(args)
      return child
    }
  })
  const invoke = (name = 'snapshot', ...args) => handles.get(`device-battery:${name}`)(event(), ...args)
  const report = (route, source = event()) => listeners.get('window:renderer-state')(source, { route, dirty: false })
  const onlyChild = () => [...children][0]
  return { app, powerMonitor, feature, win, other, event, handles, calls, children, timers, sent, invoke, report, onlyChild }
}

const snapshot = { schemaVersion: 1, status: 'ready', system: { state: 'no-battery' }, devices: [
  { id: 'fixture:receiver', name: 'Mouse', source: 'logitech', kind: 'mouse', percent: 16 }
] }

const push = (child, value = snapshot) => child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'))

const windowsOnly = { skip: process.platform !== 'win32' || process.arch !== 'x64' }

test('battery IPC requires the current top-level main window and no arguments', windowsOnly, () => {
  const f = fixture()
  assert.equal(f.invoke().status, 'paused')
  assert.throws(() => f.invoke('refresh', { command: 'powershell.exe' }), /Unexpected/)
  assert.throws(() => f.handles.get('device-battery:snapshot')(f.event(f.other.webContents)), /not authorized/)
  assert.throws(() => f.handles.get('device-battery:snapshot')(f.event(f.win.webContents, {})), /not authorized/)
  f.report('device-battery', f.event(f.other.webContents))
  f.report('invalid')
  assert.equal(f.calls.length, 0)
  f.report('device-battery')
  assert.equal(f.calls.length, 1)
  push(f.onlyChild())
  assert.equal(f.invoke().devices[0].percent, 16)
  assert.equal(f.sent.at(-1)[0], FEED)
  assert.doesNotMatch(JSON.stringify(f.sent.at(-1)), /fixture:receiver/)
  f.report('home')
  assert.equal(f.calls.at(-1), 'stop\n')
  assert.equal(f.invoke().status, 'paused')
  f.onlyChild().emit('close', 0)
})

test('visibility, suspend, navigation and bounded shutdown own the live helper', windowsOnly, async () => {
  const f = fixture()
  f.win.visible = false
  f.report('device-battery')
  assert.equal(f.calls.length, 0)
  f.win.visible = true
  f.win.emit('show')
  const first = f.onlyChild()
  push(first)
  f.win.minimized = true
  f.win.emit('minimize')
  assert.equal(f.calls.at(-1), 'stop\n')
  f.win.minimized = false
  f.win.emit('restore')
  assert.equal(f.onlyChild(), first)
  first.emit('close', 0)
  const second = f.onlyChild()
  assert.notEqual(second, first)
  f.powerMonitor.emit('suspend')
  assert.equal(f.invoke().status, 'paused')
  second.emit('close', 0)
  f.powerMonitor.emit('resume')
  assert.equal(f.children.size, 0)
  const resumeTimer = [...f.timers].find(([, timer]) => timer.ms === 2000)
  f.timers.delete(resumeTimer[0]); resumeTimer[1].callback()
  assert.ok(f.onlyChild())
  f.win.webContents.emit('did-start-navigation', { isMainFrame: false })
  assert.equal(f.invoke().status, 'loading')
  f.win.webContents.emit('did-start-navigation', { isMainFrame: true, isInPlace: false })
  assert.equal(f.invoke().status, 'paused')
  f.onlyChild().emit('close', 0)
  f.report('device-battery')
  const third = f.onlyChild()
  let prevented = false
  assert.equal(f.feature.shutdownBeforeQuit({ preventDefault: () => { prevented = true } }), true)
  assert.equal(prevented, true)
  assert.equal(f.calls.at(-1), 'stop\n')
  third.emit('close', 0)
  await Promise.resolve()
  assert.deepEqual(f.sent.at(-1), ['quit'])
  assert.equal(f.feature.shutdownBeforeQuit({ preventDefault() {} }), false)
})
