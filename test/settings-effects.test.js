const test = require('node:test')
const assert = require('node:assert/strict')

const { createSettingsEffects } = require('../main/domains/settings-effects')

function createHarness() {
  const calls = []
  const record = (name) => (...args) => { calls.push({ name, args }) }
  const ocr = {
    stopped: false,
    stopIdleCalls: 0,
    idleTimeouts: [],
    stop() { this.stopped = true },
    stopIfIdle() { this.stopIdleCalls += 1; this.stop(); return true },
    setIdleTimeoutMs(value) { this.idleTimeouts.push(value) }
  }
  const domain = createSettingsEffects({
    app: { setLoginItemSettings: record('login') },
    registerShortcuts: record('shortcuts'),
    applyGameModeState: (enabled, reason) => calls.push({ name: 'gameMode', args: [enabled, reason] }),
    createTrayIcon: record('tray'),
    getUpdateService: () => ({
      setChannel: record('channel'),
      setAutoCheckEnabled: record('autoCheck')
    }),
    peekUpdateService: () => ({
      setChannel: record('channel'),
      setAutoCheckEnabled: record('autoCheck')
    }),
    ocrServiceRef: {
      get: () => ocr.stopped ? null : ocr,
      set: (value) => { if (value === null) ocr.stop() }
    },
    getOcrService: () => ({ ensureStarted: async () => { calls.push({ name: 'ocrHotStart', args: [] }) } }),
    broadcastActionAppearance: record('appearance'),
    searchDomain: { notifySettingsChanged: record('search') },
    selectionHookServiceRef: {
      get: () => ({ updateStartOptions: record('clipboard') })
    },
    log: record('log')
  })
  return { domain, calls, ocr }
}

test('settings update effects are field-gated and ordered', () => {
  const { domain, calls } = createHarness()
  domain.applyUpdate({ shortcuts: {} }, { system: {}, selectionToolbar: {}, ocr: {} })
  assert.deepEqual(calls.map((c) => c.name), ['shortcuts'])
})

test('D01: the update auto-check switch arms and disarms the service', () => {
  const toggles = []
  let received = null
  const domain = createSettingsEffects({
    app: { setLoginItemSettings: () => {} },
    registerShortcuts: () => {},
    applyGameModeState: () => {},
    createTrayIcon: () => {},
    // Enabling resolves the lazily created service; the off path must not construct one.
    getUpdateService: () => ({ setChannel: () => {}, setAutoCheckEnabled: (value) => toggles.push(['live', value]) }),
    peekUpdateService: () => ({ setAutoCheckEnabled: (value) => toggles.push(['peek', value]) }),
    ocrServiceRef: { get: () => null, set: () => {} },
    getOcrService: () => ({ ensureStarted: async () => {} }),
    broadcastActionAppearance: () => {},
    searchDomain: { notifySettingsChanged: () => {} },
    selectionHookServiceRef: { get: () => null },
    log: () => {}
  })

  domain.applyUpdate({ system: { autoCheckUpdates: true } }, { system: { autoCheckUpdates: true }, selectionToolbar: {}, ocr: {} })
  domain.applyUpdate({ system: { autoCheckUpdates: false } }, { system: { autoCheckUpdates: false }, selectionToolbar: {}, ocr: {} })
  // A patch that never touches the switch must not poke the updater.
  domain.applyUpdate({ system: { autoStart: true } }, { system: { autoCheckUpdates: true }, selectionToolbar: {}, ocr: {} })
  assert.deepEqual(toggles, [['live', true], ['peek', false]])
  assert.equal(received, null)
})

test('gameMode takes precedence over enableTray in the same patch', () => {
  const { domain, calls } = createHarness()
  domain.applyUpdate({ system: { gameMode: true, enableTray: true } }, { system: { gameMode: true }, selectionToolbar: {}, ocr: {} })
  assert.deepEqual(calls.map((c) => c.name), ['gameMode'])
})

test('autoStart, channel, appearance, search, and clipboard effects fire independently', () => {
  const { domain, calls } = createHarness()
  domain.applyUpdate(
    {
      system: { autoStart: true, updateChannel: 'beta' },
      theme: 'dark',
      search: { matchPath: false },
      selectionToolbar: { clipboardFallback: true }
    },
    {
      system: { autoStart: true, updateChannel: 'beta', gameMode: false },
      selectionToolbar: { clipboardFallback: true },
      ocr: {}
    }
  )
  assert.deepEqual(calls.map((c) => c.name), ['login', 'channel', 'appearance', 'search', 'clipboard'])
})

test('autoStart login item carries the start-to-tray marker (W6a)', () => {
  const { domain, calls } = createHarness()
  domain.applyUpdate(
    { system: { autoStart: true } },
    { system: { autoStart: true, gameMode: false }, selectionToolbar: {}, ocr: {} }
  )
  const login = calls.find((entry) => entry.name === 'login')
  assert.deepEqual(login.args[0], { openAtLogin: true, args: ['--start-to-tray'] })
})

test('OCR disable stops the sidecar and enable hot-starts only when configured', async () => {
  const off = createHarness()
  off.domain.applyUpdate({ plugins: { ocr: false } }, { system: {}, selectionToolbar: {}, ocr: {} })
  assert.equal(off.ocr.stopped, true)

  const hot = createHarness()
  hot.domain.applyUpdate({ plugins: { ocr: true } }, { system: {}, selectionToolbar: {}, ocr: { hotStart: true } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(hot.calls.map((c) => c.name), ['ocrHotStart'])

  const cold = createHarness()
  cold.domain.applyUpdate({ plugins: { ocr: true } }, { system: {}, selectionToolbar: {}, ocr: { hotStart: false } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(cold.calls.map((c) => c.name), [])
})

test('turning hot-start off stops the idle OCR service only', () => {
  const { domain, ocr } = createHarness()
  domain.applyUpdate(
    { ocr: { hotStart: false } },
    { plugins: { ocr: true }, system: {}, selectionToolbar: {}, ocr: { hotStart: false, idleTimeoutMs: 300000 } }
  )
  assert.equal(ocr.stopIdleCalls, 1)
})

test('OCR idle timeout changes reach the live service', () => {
  const { domain, ocr } = createHarness()
  domain.applyUpdate(
    { ocr: { idleTimeoutMs: 60000 } },
    { plugins: { ocr: true }, system: {}, selectionToolbar: {}, ocr: { hotStart: true, idleTimeoutMs: 60000 } }
  )
  assert.deepEqual(ocr.idleTimeouts, [60000])
})

test('reset reapplies the documented effect set', () => {
  const { domain, calls } = createHarness()
  domain.applyReset({
    system: { gameMode: false, updateChannel: 'stable' },
    selectionToolbar: { clipboardFallback: false }
  })
  // `language.tray` rebuilds the tray on reset too (the template resolves its labels at
  // build time), so the reset path now records that call as well.
  // D01 (plan item 03): the reset also applies the auto-check switch, so restoring the
  // default (off) must reach the same service the switch does - peek only, never construct.
  assert.deepEqual(calls.map((c) => c.name), ['gameMode', 'appearance', 'tray', 'channel', 'autoCheck', 'clipboard', 'search'])
})

test('update effect ids are stable for contract tests', () => {
  const { domain } = createHarness()
  assert.deepEqual(domain.listUpdateEffectIds(), [
    'shortcuts',
    'system.autoStart',
    'system.gameMode',
    'system.enableTray',
    'system.updateChannel',
    // D01: opt-in scheduler switch, ordered with the other system.update* effects.
    'system.autoCheckUpdates',
    'plugins.ocr.off',
    'plugins.ocr.hotStart',
    'ocr.idleTimeoutMs',
    'appearance',
    'language',
    'language.tray',
    'search',
    // The clipboard panel (commit e7c7752) added these two effects after the list
    // was first written; the ids are part of the contract, so they are enumerated.
    'clipboard',
    'clipboard.appearance',
    'selectionToolbar.clipboardFallback',
    'selectionToolbar.enabled',
    'selectionToolbar.conversation.persist'
  ])
})

// ---------------------------------------------------------------------------
// D01 (plan item 03): "restore defaults" must stop the automatic update timer.
// ---------------------------------------------------------------------------

test('D01 (03): a reset disarms the automatic check through the peek-only path', () => {
  const toggles = []
  const domain = createSettingsEffects({
    app: { setLoginItemSettings: () => {} },
    registerShortcuts: () => {},
    applyGameModeState: () => {},
    createTrayIcon: () => {},
    // The channel effect may resolve the service; what must NOT happen is that the
    // auto-check switch constructs one just to turn the schedule off.
    getUpdateService: () => ({ setChannel: () => {}, setAutoCheckEnabled: (value) => toggles.push(['live', value]) }),
    peekUpdateService: () => ({ setChannel: () => {}, setAutoCheckEnabled: (value) => toggles.push(['peek', value]) }),
    ocrServiceRef: { get: () => null, set: () => {} },
    getOcrService: () => ({ ensureStarted: async () => {} }),
    broadcastActionAppearance: () => {},
    searchDomain: { notifySettingsChanged: () => {} },
    selectionHookServiceRef: { get: () => null },
    log: () => {}
  })
  // The defaults restored by "restore defaults" have auto check OFF.
  domain.applyReset({ system: { gameMode: false, updateChannel: 'stable', autoCheckUpdates: false }, selectionToolbar: {}, ocr: {} })
  assert.deepEqual(toggles, [['peek', false]])

  // A reset that restores the non-default ON value arms it, and that path needs the live
  // service (a peek would return null on a session that never built one).
  const armed = []
  const armedDomain = createSettingsEffects({
    app: { setLoginItemSettings: () => {} },
    registerShortcuts: () => {},
    applyGameModeState: () => {},
    createTrayIcon: () => {},
    getUpdateService: () => ({ setChannel: () => {}, setAutoCheckEnabled: (value) => armed.push(['live', value]) }),
    peekUpdateService: () => ({ setChannel: () => {}, setAutoCheckEnabled: (value) => armed.push(['peek', value]) }),
    ocrServiceRef: { get: () => null, set: () => {} },
    getOcrService: () => ({ ensureStarted: async () => {} }),
    broadcastActionAppearance: () => {},
    searchDomain: { notifySettingsChanged: () => {} },
    selectionHookServiceRef: { get: () => null },
    log: () => {}
  })
  armedDomain.applyReset({ system: { gameMode: false, updateChannel: 'stable', autoCheckUpdates: true }, selectionToolbar: {}, ocr: {} })
  assert.deepEqual(armed, [['live', true]])
})

test('D01 (03): a real update service stops scheduling when reset restores the defaults', async () => {
  const { UpdateService, DEFAULT_STARTUP_DELAY_MS, DEFAULT_CHECK_INTERVAL_MS } = require('../main/services/update-service')
  // A fake clock: armed timers fire only when the test says so.
  const timers = {
    pending: null,
    id: 0,
    setTimeoutFn: (fn, delay) => {
      const entry = {
        delay,
        id: ++timers.id,
        // A real timer is gone once it fires: drop it from the fake queue first so a
        // captured handle can be re-run later without pretending to be pending.
        fn: () => {
          if (timers.pending === entry) timers.pending = null
          return fn()
        }
      }
      timers.pending = entry
      return entry.id
    },
    clearTimeoutFn: (id) => { if (timers.pending && timers.pending.id === id) timers.pending = null }
  }
  const updater = { checkCalls: 0, on() {}, removeListener() {}, configure: 0, checkForUpdates: async () => { updater.checkCalls += 1 } }
  const service = new UpdateService({
    updater,
    currentVersion: '5.0.1',
    installType: 'nsis',
    autoCheckEnabled: false,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  })
  const domain = createSettingsEffects({
    app: { setLoginItemSettings: () => {} },
    registerShortcuts: () => {},
    applyGameModeState: () => {},
    createTrayIcon: () => {},
    getUpdateService: () => service,
    peekUpdateService: () => service,
    ocrServiceRef: { get: () => null, set: () => {} },
    getOcrService: () => ({ ensureStarted: async () => {} }),
    broadcastActionAppearance: () => {},
    searchDomain: { notifySettingsChanged: () => {} },
    selectionHookServiceRef: { get: () => null },
    log: () => {}
  })

  // 1) The user enables scheduling, then restores defaults BEFORE the first round.
  domain.applyUpdate({ system: { autoCheckUpdates: true } }, { system: { autoCheckUpdates: true }, selectionToolbar: {}, ocr: {} })
  assert.equal(timers.pending.delay, DEFAULT_STARTUP_DELAY_MS, 'the opt-in armed the first round')
  domain.applyReset({ system: { gameMode: false, updateChannel: 'stable', autoCheckUpdates: false }, selectionToolbar: {}, ocr: {} })
  assert.equal(timers.pending, null, 'the reset cleared the pending timer')
  // Advancing the whole 24h window must not reach the feed.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(updater.checkCalls, 0)
  assert.equal(service.getStatus().autoCheckEnabled, false)

  // 2) Re-enabling after the reset arms exactly one fresh first round.
  domain.applyUpdate({ system: { autoCheckUpdates: true } }, { system: { autoCheckUpdates: true }, selectionToolbar: {}, ocr: {} })
  assert.equal(timers.pending.delay, DEFAULT_STARTUP_DELAY_MS)
  const firstRound = timers.pending
  await firstRound.fn()
  assert.equal(updater.checkCalls, 1)
  assert.equal(timers.pending.delay, DEFAULT_CHECK_INTERVAL_MS, 'the periodic round is armed')

  // 3) A reset while the periodic round is pending stops the schedule.
  domain.applyReset({ system: { gameMode: false, updateChannel: 'stable', autoCheckUpdates: false }, selectionToolbar: {}, ocr: {} })
  assert.equal(timers.pending, null)
  await firstRound.fn()
  assert.equal(updater.checkCalls, 1, 'the captured periodic tick cannot reach the feed after the reset')

  // 4) A reset while a request is IN FLIGHT: the answer arrives, nothing is rescheduled.
  //    (Clear the last-checked stamp so the non-manual path really issues the request.)
  service.state.lastCheckedAt = ''
  domain.applyUpdate({ system: { autoCheckUpdates: true } }, { system: { autoCheckUpdates: true }, selectionToolbar: {}, ocr: {} })
  let release = null
  updater.checkForUpdates = () => { updater.checkCalls += 1; return new Promise((resolve) => { release = resolve }) }
  const inFlight = timers.pending.fn()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(updater.checkCalls, 2)
  domain.applyReset({ system: { gameMode: false, updateChannel: 'stable', autoCheckUpdates: false }, selectionToolbar: {}, ocr: {} })
  release()
  await inFlight
  assert.equal(timers.pending, null, 'an in-flight request does not re-arm the schedule')

  // 5) A repeated reset is harmless.
  domain.applyReset({ system: { gameMode: false, updateChannel: 'stable', autoCheckUpdates: false }, selectionToolbar: {}, ocr: {} })
  assert.equal(timers.pending, null)
  // 6) The manual check is untouched by all of this: exactly one request per click.
  updater.checkForUpdates = async () => { updater.checkCalls += 1 }
  await service.check({ manual: true })
  assert.equal(updater.checkCalls, 3)
  assert.equal(timers.pending, null, 'a manual check never arms the schedule')
  service.dispose()
})
