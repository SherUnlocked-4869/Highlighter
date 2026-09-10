const test = require('node:test')
const assert = require('node:assert/strict')

const { createSettingsEffects } = require('../main/domains/settings-effects')

function createHarness() {
  const calls = []
  const record = (name) => (...args) => { calls.push({ name, args }) }
  const ocr = { stopped: false, stop() { this.stopped = true } }
  const domain = createSettingsEffects({
    app: { setLoginItemSettings: record('login') },
    registerShortcuts: record('shortcuts'),
    applyGameModeState: (enabled, reason) => calls.push({ name: 'gameMode', args: [enabled, reason] }),
    createTrayIcon: record('tray'),
    getUpdateService: () => ({ setChannel: record('channel') }),
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

test('reset reapplies the documented effect set', () => {
  const { domain, calls } = createHarness()
  domain.applyReset({
    system: { gameMode: false, updateChannel: 'stable' },
    selectionToolbar: { clipboardFallback: false }
  })
  assert.deepEqual(calls.map((c) => c.name), ['gameMode', 'appearance', 'channel', 'clipboard', 'search'])
})

test('update effect ids are stable for contract tests', () => {
  const { domain } = createHarness()
  assert.deepEqual(domain.listUpdateEffectIds(), [
    'shortcuts',
    'system.autoStart',
    'system.gameMode',
    'system.enableTray',
    'system.updateChannel',
    'plugins.ocr.off',
    'plugins.ocr.hotStart',
    'appearance',
    'search',
    'selectionToolbar.clipboardFallback'
  ])
})
