'use strict'

// The presentation half of the proxy bridge: the failure copy, the tray refresh
// and the status broadcast. The lifecycle itself is covered by
// test/translation-proxy-service.test.js; here the service is a stub.

const test = require('node:test')
const assert = require('node:assert/strict')

const { createProxyBridgeController, ERROR_KEYS } = require('../main/services/proxy-bridge-controller')
const { t, setLanguage, registerLocales } = require('../main/services/i18n-bootstrap')

registerLocales()

function createStubService(overrides = {}) {
  const calls = { start: 0, stop: 0, refresh: 0, dispose: 0, statusArgs: [] }
  let current = {
    state: 'idle',
    running: false,
    busy: false,
    adopted: false,
    pid: null,
    port: 8080,
    host: '127.0.0.1',
    endpoint: 'http://127.0.0.1:8080/v1',
    lastError: '',
    lastErrorCode: '',
    changedAt: 0,
    ...(overrides.status || {})
  }
  const service = {
    calls,
    setStatus(next) { current = { ...current, ...next } },
    getStatus: (override) => {
      calls.statusArgs.push(override)
      return { ...current }
    },
    start: async () => {
      calls.start += 1
      if (overrides.startError) throw overrides.startError
      current = { ...current, state: 'running', running: true, busy: false }
      return { ...current }
    },
    stop: async () => {
      calls.stop += 1
      if (overrides.stopError) throw overrides.stopError
      current = { ...current, state: 'idle', running: false, busy: false }
      return { ...current }
    },
    toggle: async () => (current.running ? service.stop() : service.start()),
    refresh: async () => {
      calls.refresh += 1
      if (overrides.refreshError) throw overrides.refreshError
      return { ...current }
    },
    dispose: () => {
      calls.dispose += 1
      return overrides.disposeResult !== false
    }
  }
  return service
}

function createHarness({ settings = {}, service, window = null, dialog = null } = {}) {
  const calls = { tray: 0, dispatched: [], dialogs: [], logs: [] }
  const controller = createProxyBridgeController({
    getSettings: () => ({ proxy: { autoStart: false, keepRunningOnExit: false, ...(settings.proxy || {}) }, ...settings }),
    log: (...args) => calls.logs.push(args),
    t,
    dialog: dialog || { showMessageBox: (options) => { calls.dialogs.push(options); return Promise.resolve() } },
    createTrayIcon: () => { calls.tray += 1 },
    getMainWindow: () => window,
    service
  })
  return { controller, calls }
}

function createFakeWindow() {
  const sent = []
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => sent.push([channel, payload])
    }
  }
}

test('menuState mirrors the service status', () => {
  const service = createStubService({ status: { running: true, busy: false } })
  const { controller } = createHarness({ service })

  assert.deepEqual(controller.menuState(), { running: true, busy: false })

  service.setStatus({ running: false, busy: true })
  assert.deepEqual(controller.menuState(), { running: false, busy: true })
})

test('menuState forwards the settings snapshot the tray already read', () => {
  // createTrayIcon runs on every action-window event, and SettingsService.getSettings()
  // decrypts stored credentials on each call, so the controller must not read twice.
  const service = createStubService({ status: { running: true, state: 'running' } })
  const { controller } = createHarness({ service, settings: { proxy: { port: 8088 } } })
  const snapshot = { proxy: { port: 8088 } }

  assert.deepEqual(controller.menuState(snapshot), { running: true, busy: false })
  assert.equal(service.calls.statusArgs[0], snapshot)
})

test('setEnabled starts, rebuilds the tray and reports the new status', async () => {
  const service = createStubService()
  const { controller, calls } = createHarness({ service })

  const status = await controller.setEnabled(true)

  assert.equal(service.calls.start, 1)
  assert.equal(service.calls.stop, 0)
  assert.equal(status.running, true)
  // The template is a snapshot, so a state change without a rebuild would leave
  // the checkbox showing the previous value.
  assert.equal(calls.tray, 1)
})

test('setEnabled stops when the box is cleared', async () => {
  const service = createStubService({ status: { running: true, state: 'running' } })
  const { controller, calls } = createHarness({ service })

  const status = await controller.setEnabled(false)

  assert.equal(service.calls.stop, 1)
  assert.equal(status.running, false)
  assert.equal(calls.tray, 1)
})

test('a failed start is reported through the dialog and never rejects', async () => {
  const error = Object.assign(new Error('Proxy script not found: F:\\nope\\call_api.py'), { code: 'script-missing' })
  const service = createStubService({ startError: error })
  const { controller, calls } = createHarness({ service })

  const status = await controller.setEnabled(true)

  assert.equal(status.running, false)
  assert.equal(calls.dialogs.length, 1)
  assert.equal(calls.dialogs[0].type, 'warning')
  assert.equal(calls.dialogs[0].message, t('main.proxy.toggle-failed'))
  // The localized guidance and the raw technical message both survive.
  assert.match(calls.dialogs[0].detail, /call_api\.py/)
  assert.match(calls.dialogs[0].detail, /F:\\nope/)
  assert.equal(calls.tray, 1)
})

test('every sidecar error code has its own localized copy', () => {
  for (const [code, key] of Object.entries(ERROR_KEYS)) {
    const value = t(key)
    assert.notEqual(value, key, `${code} has no copy for ${key}`)
  }
  assert.equal(Object.keys(ERROR_KEYS).length, 8)
})

test('an unknown error code falls back to the generic copy', async () => {
  const service = createStubService({ startError: Object.assign(new Error('boom'), { code: 'who-knows' }) })
  const { controller, calls } = createHarness({ service })

  await controller.setEnabled(true)

  assert.match(calls.dialogs[0].detail, new RegExp(t('main.proxy.unavailable')))
  assert.match(calls.dialogs[0].detail, /boom/)
})

test('a missing dialog still reports to the log instead of throwing', async () => {
  const service = createStubService({ startError: Object.assign(new Error('boom'), { code: 'start-timeout' }) })
  const { controller, calls } = createHarness({ service, dialog: {} })

  const status = await controller.setEnabled(true)

  assert.equal(status.running, false)
  assert.ok(calls.logs.some((entry) => String(entry[0]).includes('Translation proxy toggle failed')))
})

test('the failure copy follows the interface language', async () => {
  const previous = 'zh-CN'
  setLanguage('en-US')
  try {
    const service = createStubService({ startError: Object.assign(new Error('x'), { code: 'python-missing' }) })
    const { controller, calls } = createHarness({ service })
    await controller.setEnabled(true)
    assert.equal(calls.dialogs[0].message, 'The translation proxy could not be started or stopped')
    assert.match(calls.dialogs[0].detail, /Python interpreter/)
  } finally {
    setLanguage(previous)
  }
})

test('refresh never rejects, even when the probe blows up', async () => {
  const service = createStubService({ refreshError: new Error('probe exploded') })
  const { controller, calls } = createHarness({ service })

  const status = await controller.refresh()

  assert.equal(status.state, 'idle')
  assert.ok(calls.logs.some((entry) => String(entry[0]).includes('refresh failed')))
})

test('startIfConfigured stays dormant unless the user opted in', async () => {
  const dormant = createHarness({ service: createStubService(), settings: { proxy: { autoStart: false } } })
  await dormant.controller.startIfConfigured()
  assert.equal(dormant.controller.getStatus().state, 'idle')
  assert.equal(dormant.controller.service.calls.start, 0)

  const enabled = createHarness({ service: createStubService(), settings: { proxy: { autoStart: true } } })
  await enabled.controller.startIfConfigured()
  assert.equal(enabled.controller.getStatus().running, true)
  assert.equal(enabled.calls.tray, 1)
})

test('dispose honours keepRunningOnExit', () => {
  const kill = createHarness({ service: createStubService(), settings: { proxy: { keepRunningOnExit: false } } })
  assert.equal(kill.controller.dispose(), true)
  assert.equal(kill.controller.service.calls.dispose, 1)

  const keep = createHarness({ service: createStubService(), settings: { proxy: { keepRunningOnExit: true } } })
  assert.equal(keep.controller.dispose(), false)
  assert.equal(keep.controller.service.calls.dispose, 0)
})

test('broadcast pushes the status to the main window', () => {
  const service = createStubService({ status: { running: true, state: 'running' } })
  const window = createFakeWindow()
  const { controller } = createHarness({ service, window })

  assert.equal(controller.broadcast(), true)
  assert.equal(window.sent.length, 1)
  assert.equal(window.sent[0][0], 'proxy:status')
  assert.equal(window.sent[0][1].running, true)
})

test('broadcast degrades quietly without a window', () => {
  const { controller, calls } = createHarness({ service: createStubService(), window: null })
  assert.equal(controller.broadcast(), false)
  assert.deepEqual(calls.dialogs, [])
})

test('broadcast tolerates a window that is going away', () => {
  const { controller } = createHarness({
    service: createStubService(),
    window: { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: () => { throw new Error('should not send') } } }
  })
  assert.equal(controller.broadcast(), false)
})

test('a throwing tray rebuild is logged instead of failing the toggle', async () => {
  const service = createStubService()
  const logs = []
  const controller = createProxyBridgeController({
    getSettings: () => ({ proxy: {} }),
    log: (...args) => logs.push(args),
    t,
    dialog: null,
    createTrayIcon: () => { throw new Error('tray exploded') },
    getMainWindow: () => null,
    service
  })

  const status = await controller.setEnabled(true)

  assert.equal(status.running, true)
  assert.ok(logs.some((entry) => String(entry[0]).includes('tray refresh failed')))
})
