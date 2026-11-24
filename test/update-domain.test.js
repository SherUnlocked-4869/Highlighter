const test = require('node:test')
const assert = require('node:assert/strict')

const { createUpdateDomain, DEFAULT_START_DELAY_MS } = require('../main/domains/update')

function createHarness({ autoCheckUpdates = false, installType = 'portable' } = {}) {
  const timers = []
  const calls = []
  const app = { getVersion: () => '5.0.1' }
  const settings = { system: { updateChannel: 'stable', autoCheckUpdates } }
  const domain = createUpdateDomain({
    app,
    getSettings: () => settings,
    getInstallType: () => installType,
    openDownloadPage: async () => {},
    notify: () => {},
    log: (...args) => calls.push(['log', ...args]),
    setTimeoutFn: (fn, delay) => { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer },
    clearTimeoutFn: (timer) => { timer.cleared = true }
  })
  return { domain, timers, calls, settings }
}

test('D01: the startup path arms nothing unless the setting is on', () => {
  const { domain, timers } = createHarness({ autoCheckUpdates: false })
  assert.equal(domain.deferStart(), false)
  assert.equal(timers.length, 0)
  // Nothing was constructed either: a default install never requires electron-updater.
  assert.equal(domain.peek(), null)
  assert.deepEqual(domain.getStatus(), { status: 'not-configured', error: null })
})

test('D01: an opted-in install arms one timer and starts the lazily created service', () => {
  const { domain, timers } = createHarness({ autoCheckUpdates: true })
  assert.equal(domain.deferStart(), true)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, DEFAULT_START_DELAY_MS)
  assert.equal(domain.peek(), null, 'the service is not constructed before the timer fires')
  assert.equal(domain.deferStart(), false, 'a second call does not arm a second timer')
  assert.equal(timers.length, 1)

  timers[0].fn()
  const service = domain.peek()
  assert.ok(service, 'the timer constructs the service')
  assert.equal(service.getStatus().autoCheckEnabled, true)
})

test('D01: dispose clears a pending timer and releases the service', () => {
  const { domain, timers } = createHarness({ autoCheckUpdates: true })
  domain.deferStart()
  timers[0].fn()
  domain.dispose()
  assert.equal(domain.peek(), null)
  assert.equal(domain.getStatus().status, 'not-configured')

  const second = createHarness({ autoCheckUpdates: true })
  second.domain.deferStart()
  second.domain.dispose()
  assert.equal(second.timers[0].cleared, true)
})

test('D01: a portable install keeps the manual download-page path', async () => {
  let opened = 0
  const domain = createUpdateDomain({
    app: { getVersion: () => '5.0.1' },
    getSettings: () => ({ system: { updateChannel: 'beta', autoCheckUpdates: false } }),
    getInstallType: () => 'portable',
    openDownloadPage: async () => { opened++ },
    log: () => {}
  })
  const status = await domain.resolve().check({ manual: true })
  assert.equal(opened, 1)
  assert.equal(status.installType, 'portable')
  assert.equal(status.channel, 'beta')
  assert.equal(domain.resolve().start(), false)
})
