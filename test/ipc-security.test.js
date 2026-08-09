const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  buildIpcPolicies,
  createSecureIpcMain
} = require('../main/services/ipc-security')
const { createSecureWindow } = require('../main/services/window-security')

class FakeWebContents {
  constructor() {
    this.listeners = new Map()
    this.mainFrame = { url: '' }
    this.destroyed = false
  }

  on(event, listener) {
    this.listeners.set(event, listener)
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler
  }

  isDestroyed() {
    return this.destroyed
  }
}

class FakeBrowserWindow {
  static windows = new WeakMap()

  constructor(options) {
    this.options = options
    this.webContents = new FakeWebContents()
    this.destroyed = false
    FakeBrowserWindow.windows.set(this.webContents, this)
  }

  static fromWebContents(webContents) {
    return FakeBrowserWindow.windows.get(webContents) || null
  }

  isDestroyed() {
    return this.destroyed
  }
}

function createIpcMain() {
  const handlers = new Map()
  const listeners = new Map()
  return {
    handlers,
    listeners,
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, listener) => listeners.set(channel, listener)
  }
}

function createWindow(root, relativePage, role) {
  const pagePath = path.join(root, relativePage)
  const win = createSecureWindow({
    BrowserWindow: FakeBrowserWindow,
    pagePath,
    options: { webPreferences: { preload: path.join(root, 'preload.js') } }
  })
  win.role = role
  win.webContents.mainFrame.url = pathToFileURL(pagePath).href
  return win
}

function eventFor(win, senderFrame = win.webContents.mainFrame) {
  return { sender: win.webContents, senderFrame }
}

function registerPolicySurface(secureIpcMain, policies, calls) {
  for (const policy of policies.values()) {
    secureIpcMain[policy.kind](policy.channel, (_event, ...args) => {
      calls.push({ channel: policy.channel, args })
      return policy.channel
    })
  }
}

test('IPC policy exactly covers every main-process registration', () => {
  const root = path.resolve(__dirname, '..')
  const policies = buildIpcPolicies(root)
  const counts = [...policies.values()].reduce((result, policy) => {
    result[policy.kind]++
    return result
  }, { handle: 0, on: 0 })
  const sourceFiles = [
    path.join(root, 'main.js'),
    ...fs.readdirSync(path.join(root, 'main', 'ipc'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => path.join(root, 'main', 'ipc', name))
  ]
  const registrations = new Map()
  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:secureIpcMain|ipcMain)\.(handle|on)\('([^']+)'/g)) {
      assert.equal(registrations.has(match[2]), false, `duplicate registration: ${match[2]}`)
      registrations.set(match[2], match[1])
    }
  }

  assert.equal(policies.size, 98)
  assert.deepEqual(counts, { handle: 64, on: 34 })
  assert.equal(registrations.size, policies.size)
  for (const [channel, policy] of policies) {
    assert.equal(registrations.get(channel), policy.kind, `${channel} policy kind`)
  }
  assert.deepEqual(
    policies.get('shell:open-external').pages.map(({ role }) => role),
    ['main', 'action', 'recognition']
  )
  assert.deepEqual(policies.get('toolbar:action').pages.map(({ role }) => role), ['toolbar'])
  assert.equal(registrations.has('toolbar:close'), false)
  assert.equal(registrations.has('debug:text-received'), false)
})

test('every renderer-to-main preload channel has a matching page policy', () => {
  const root = path.resolve(__dirname, '..')
  const policies = buildIpcPolicies(root)
  const preloadRoles = new Map([
    ['preload.js', 'main'],
    ['preload-toolbar.js', 'toolbar'],
    ['preload-action.js', 'action'],
    ['preload-capture.js', 'capture'],
    ['preload-long-capture.js', 'long-capture'],
    ['preload-long-overlay.js', 'long-overlay'],
    ['preload-pin.js', 'pin'],
    ['preload-recognition.js', 'recognition'],
    ['preload-record.js', 'record'],
    ['preload-record-frame.js', 'record-frame']
  ])

  for (const [preload, role] of preloadRoles) {
    const source = fs.readFileSync(path.join(root, preload), 'utf8')
    const calls = [
      ...source.matchAll(/ipcRenderer\.(invoke|send)\('([^']+)'/g),
      ...source.matchAll(/sendStreamSignal\('([^']+)'/g)
    ].map((match) => match.length === 3
      ? { method: match[1], channel: match[2] }
      : { method: 'send', channel: match[1] })
    for (const { method, channel } of calls) {
      const policy = policies.get(channel)
      assert.ok(policy, `${preload} channel lacks a policy: ${channel}`)
      assert.equal(policy.kind, method === 'invoke' ? 'handle' : 'on', `${channel} kind mismatch`)
      assert.ok(policy.pages.some((page) => page.role === role), `${preload} cannot call ${channel}`)
    }
  }
})

test('secure IPC accepts registered owners and rejects cross-page senders', () => {
  const root = path.resolve(__dirname, '..')
  const ipcMain = createIpcMain()
  const blocked = []
  const calls = []
  const policies = buildIpcPolicies(root)
  const secureIpcMain = createSecureIpcMain({
    ipcMain,
    BrowserWindow: FakeBrowserWindow,
    rootDirectory: root,
    authorizeRole: (role, win) => win.role === role,
    onBlocked: (entry) => blocked.push(entry)
  })
  registerPolicySurface(secureIpcMain, policies, calls)
  assert.equal(secureIpcMain.assertComplete(), true)

  const mainWindow = createWindow(root, 'config/config.html', 'main')
  const actionWindow = createWindow(root, 'action/action.html', 'action')
  const recognitionWindow = createWindow(root, 'recognition/recognition.html', 'recognition')
  const captureWindow = createWindow(root, 'capture/capture.html', 'capture')

  assert.equal(ipcMain.handlers.get('settings:get')(eventFor(mainWindow)), 'settings:get')
  assert.equal(ipcMain.handlers.get('shell:open-external')(eventFor(actionWindow), 'https://example.com'), 'shell:open-external')
  assert.equal(ipcMain.handlers.get('shell:open-external')(eventFor(recognitionWindow), 'https://example.com'), 'shell:open-external')
  assert.throws(() => ipcMain.handlers.get('settings:get')(eventFor(actionWindow)), /IPC sender not authorized/)
  assert.throws(() => ipcMain.handlers.get('capture:copy')(eventFor(mainWindow), {}), /IPC sender not authorized/)

  ipcMain.listeners.get('toolbar:action')(eventFor(captureWindow), { action: 'copy', text: 'blocked' })
  assert.equal(calls.some(({ channel, args }) => channel === 'toolbar:action' && args[0]?.text === 'blocked'), false)
  assert.deepEqual(blocked.map(({ reason }) => reason), ['page-not-allowed', 'page-not-allowed', 'page-not-allowed'])
})

test('secure IPC rejects unregistered, navigated, iframe, destroyed, and stale owners', () => {
  const root = path.resolve(__dirname, '..')
  const ipcMain = createIpcMain()
  const blocked = []
  const calls = []
  const policies = buildIpcPolicies(root)
  const secureIpcMain = createSecureIpcMain({
    ipcMain,
    BrowserWindow: FakeBrowserWindow,
    rootDirectory: root,
    authorizeRole: (role, win) => win.role === role,
    onBlocked: (entry) => blocked.push(entry)
  })
  registerPolicySurface(secureIpcMain, policies, calls)

  const unregistered = new FakeBrowserWindow({})
  unregistered.role = 'main'
  unregistered.webContents.mainFrame.url = pathToFileURL(path.join(root, 'config/config.html')).href
  assert.throws(() => ipcMain.handlers.get('settings:get')(eventFor(unregistered)), /IPC sender not authorized/)

  const navigated = createWindow(root, 'config/config.html', 'main')
  navigated.webContents.mainFrame.url = pathToFileURL(path.join(root, 'action/action.html')).href
  assert.throws(() => ipcMain.handlers.get('settings:get')(eventFor(navigated)), /IPC sender not authorized/)

  const iframe = createWindow(root, 'config/config.html', 'main')
  assert.throws(
    () => ipcMain.handlers.get('settings:get')(eventFor(iframe, { url: iframe.webContents.mainFrame.url })),
    /IPC sender not authorized/
  )

  const destroyed = createWindow(root, 'config/config.html', 'main')
  destroyed.webContents.destroyed = true
  assert.throws(() => ipcMain.handlers.get('settings:get')(eventFor(destroyed)), /IPC sender not authorized/)

  const staleOwner = createWindow(root, 'capture/capture.html', 'stale-capture')
  assert.throws(() => ipcMain.handlers.get('capture:copy')(eventFor(staleOwner), {}), /IPC sender not authorized/)

  assert.deepEqual(blocked.map(({ reason }) => reason), [
    'unregistered-window',
    'sender-url-mismatch',
    'non-top-level-frame',
    'missing-or-destroyed-sender',
    'window-owner-mismatch'
  ])
})

test('secure IPC refuses unlisted, duplicate, wrong-kind, and incomplete registrations', () => {
  const root = path.resolve(__dirname, '..')
  const secureIpcMain = createSecureIpcMain({
    ipcMain: createIpcMain(),
    BrowserWindow: FakeBrowserWindow,
    rootDirectory: root
  })

  assert.throws(() => secureIpcMain.handle('unknown:channel', () => {}), /no sender policy/)
  assert.throws(() => secureIpcMain.on('settings:get', () => {}), /wrong registration kind/)
  secureIpcMain.handle('settings:get', () => {})
  assert.throws(() => secureIpcMain.handle('settings:get', () => {}), /more than once/)
  assert.throws(() => secureIpcMain.assertComplete(), /missing registrations/)
})
