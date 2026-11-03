const test = require('node:test')
const assert = require('node:assert/strict')
const { buildTrayMenuTemplate } = require('../main/services/tray-menu')
// S13 / P0-1-T6: the labels below are the zh-CN values of the `main.tray.*` keys,
// so the lookups keep working for the literal assertions while making the source
// of the copy explicit. A language round-trip lives in test/i18n-main.test.js.
const { t, registerLocales } = require('../main/services/i18n-bootstrap')
registerLocales()
const label = (key) => t(key)

function createMenu(gameMode, { hasConversation = true, translationProxy = null, setTranslationProxyEnabled } = {}, recording = null) {
  const calls = []
  return {
    calls,
    template: buildTrayMenuTemplate({
      gameMode,
      hasConversation,
      screenshotAccelerator: 'F1',
      translationProxy,
      setTranslationProxyEnabled,
      recording,
      executeFunction: (name) => calls.push(['execute', name]),
      setGameModeEnabled: (enabled) => calls.push(['game-mode', enabled]),
      openHistory: () => calls.push(['history']),
      openMainWindow: () => calls.push(['main']),
      showConversation: () => calls.push(['conversation']),
      quit: () => calls.push(['quit'])
    })
  }
}

test('tray menu exposes an unchecked game mode toggle during normal operation', () => {
  const { calls, template } = createMenu(false)
  const toggle = template.find((item) => item.label === label('main.tray.game-mode'))
  const screenshot = template.find((item) => item.label === label('main.tray.screenshot'))

  assert.equal(toggle.type, 'checkbox')
  assert.equal(toggle.checked, false)
  assert.equal(screenshot.enabled, true)
  assert.equal(screenshot.accelerator, 'F1')
  toggle.click()
  assert.deepEqual(calls, [['game-mode', true]])
})

test('tray menu disables summon actions and can turn game mode off', () => {
  const { calls, template } = createMenu(true)
  const featureLabels = [
    'main.tray.screenshot',
    'main.tray.screenshot-full-screen',
    'main.tray.screenshot-focused-window',
    'main.tray.pin-image',
    // R2 (contracts §4.1): the regular recording entry is now the workbench.
    'main.tray.recording-workbench',
    'main.tray.local-search'
  ].map(label)
  for (const entry of featureLabels) {
    assert.equal(template.find((item) => item.label === entry).enabled, false, entry)
  }

  const toggle = template.find((item) => item.label === label('main.tray.game-mode'))
  assert.equal(toggle.checked, true)
  toggle.click()
  assert.deepEqual(calls, [['game-mode', false]])
})

test('the tray recording entry opens the workbench and keeps the fullscreen quick start out of the menu', () => {
  // Without a recording domain the entry falls back to the router name, exactly like the other
  // summon entries.
  const viaRouter = createMenu(false)
  const entry = viaRouter.template.find((item) => item.label === label('main.tray.recording-workbench'))
  assert.ok(entry, 'the workbench entry exists')
  entry.click()
  assert.deepEqual(viaRouter.calls, [['execute', 'openRecording']])
  assert.equal(viaRouter.template.some((item) => item.label === label('main.tray.video-record')), false)

  // With a recording domain the entry calls the domain directly (no router round-trip).
  const calls = []
  const direct = createMenu(false, {}, { openWorkbench: () => calls.push(['open']) })
  direct.template.find((item) => item.label === label('main.tray.recording-workbench')).click()
  assert.deepEqual(calls, [['open']])
})

test('tray menu exposes pause/finish only while a recording is active', () => {
  const idle = createMenu(false, {}, { active: null })
  assert.equal(idle.template.some((item) => item.label === label('main.tray.recording-pause')), false)
  assert.equal(idle.template.some((item) => item.label === label('main.tray.recording-finish')), false)

  const calls = []
  const recording = {
    active: { status: 'recording', elapsedMs: 1200, microphoneMuted: false },
    pauseResume: () => calls.push(['pause-resume']),
    finish: () => calls.push(['finish'])
  }
  const active = createMenu(false, {}, recording)
  const pause = active.template.find((item) => item.label === label('main.tray.recording-pause'))
  assert.ok(pause, 'a recording session offers pause')
  assert.equal(pause.enabled, true)
  const finish = active.template.find((item) => item.label === label('main.tray.recording-finish'))
  assert.ok(finish, 'a recording session offers finish')
  pause.click()
  finish.click()
  assert.deepEqual(calls, [['pause-resume'], ['finish']])
  // The live entries sit in their own group: a separator on each side separates them from the
  // summon list above and the local-search entry below.
  const pauseIndex = active.template.indexOf(pause)
  assert.equal(active.template[pauseIndex - 1].type, 'separator')

  const paused = createMenu(false, {}, { active: { status: 'paused' } })
  assert.ok(paused.template.find((item) => item.label === label('main.tray.recording-resume')), 'a paused capture offers resume')
  assert.equal(paused.template.some((item) => item.label === label('main.tray.recording-pause')), false)
})

test('tray live recording entries fall back to the router names', () => {
  const menu = createMenu(false, {}, { active: { status: 'paused' } })
  menu.template.find((item) => item.label === label('main.tray.recording-resume')).click()
  menu.template.find((item) => item.label === label('main.tray.recording-finish')).click()
  assert.deepEqual(menu.calls, [['execute', 'recordPauseResume'], ['execute', 'recordFinish']])
})

test('tray menu only offers the result window while a conversation is alive', () => {
  const menu = createMenu(false)
  const item = menu.template.find((entry) => entry.label === label('main.tray.show-selection-chat'))
  assert.equal(item.visible, true)
  assert.equal(item.enabled, true)
  item.click()
  assert.deepEqual(menu.calls, [['conversation']])

  const hidden = createMenu(false, { hasConversation: false }).template.find((entry) => entry.label === label('main.tray.show-selection-chat'))
  assert.equal(hidden.visible, false)
})

test('tray menu summons the conversation from a game-mode session as disabled', () => {
  // A hidden window is not reachable by a new selection without discarding the
  // conversation, so the entry exists but respects game mode like the others.
  const item = createMenu(true).template.find((entry) => entry.label === label('main.tray.show-selection-chat'))
  assert.equal(item.visible, true)
  assert.equal(item.enabled, false)
})

test('tray menu refuses to build without a conversation handler', () => {
  const base = {
    executeFunction: () => {},
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    quit: () => {}
  }
  assert.throws(() => buildTrayMenuTemplate(base), /showConversation/)
})

test('the proxy bridge entry is absent when the host does not own one', () => {
  // Backwards compatibility: every caller and test that predates the proxy builds
  // the template without the dependency, and a required argument would throw.
  const { template } = createMenu(false)
  assert.equal(template.some((item) => item.label === label('main.tray.translation-proxy')), false)
  assert.equal(template.filter((item) => item.type === 'separator').length, 3)
})

test('the proxy bridge entry sits in its own group between search and game mode', () => {
  const { template } = createMenu(false, {
    translationProxy: { running: true, busy: false },
    setTranslationProxyEnabled: () => {}
  })
  const index = template.findIndex((item) => item.label === label('main.tray.translation-proxy'))
  const searchIndex = template.findIndex((item) => item.label === label('main.tray.local-search'))
  const gameModeIndex = template.findIndex((item) => item.label === label('main.tray.game-mode'))

  assert.ok(index > 0, 'the entry exists')
  // Its own group: exactly one separator on each side, so it never looks like part
  // of the capture list above it or the game-mode switch below it. Neighbours are
  // not asserted by name - other features may add entries in between.
  assert.equal(template[index - 1].type, 'separator')
  assert.equal(template[index + 1].type, 'separator')
  assert.ok(index > searchIndex, 'it comes after the capture/search group')
  assert.ok(index < gameModeIndex, 'it comes before the game mode switch')
})

test('the proxy bridge entry toggles the service and mirrors its state', () => {
  const calls = []
  const { template } = createMenu(false, {
    translationProxy: { running: false, busy: false },
    setTranslationProxyEnabled: (enabled) => calls.push(['proxy', enabled])
  })
  const entry = template.find((item) => item.label === label('main.tray.translation-proxy'))

  assert.equal(entry.type, 'checkbox')
  assert.equal(entry.checked, false)
  assert.equal(entry.enabled, true)
  entry.click()
  assert.deepEqual(calls, [['proxy', true]])

  const running = createMenu(false, {
    translationProxy: { running: true, busy: false },
    setTranslationProxyEnabled: (enabled) => calls.push(['proxy', enabled])
  }).template.find((item) => item.label === label('main.tray.translation-proxy'))
  assert.equal(running.checked, true)
  running.click()
  assert.deepEqual(calls, [['proxy', true], ['proxy', false]])
})

test('the proxy bridge entry is disabled while a transition is in flight and survives game mode', () => {
  const busy = createMenu(false, {
    translationProxy: { running: false, busy: true },
    setTranslationProxyEnabled: () => {}
  }).template.find((item) => item.label === label('main.tray.translation-proxy'))
  assert.equal(busy.enabled, false)

  // A local HTTP service cannot interfere with a game, so - unlike the capture
  // entries - this one stays enabled in game mode.
  const gameMode = createMenu(true, {
    translationProxy: { running: true, busy: false },
    setTranslationProxyEnabled: () => {}
  }).template.find((item) => item.label === label('main.tray.translation-proxy'))
  assert.equal(gameMode.enabled, true)
  assert.equal(gameMode.checked, true)
})

test('the proxy bridge entry needs both the state and the handler', () => {
  const stateOnly = createMenu(false, { translationProxy: { running: false, busy: false } })
  assert.equal(stateOnly.template.some((item) => item.label === label('main.tray.translation-proxy')), false)

  const handlerOnly = createMenu(false, { setTranslationProxyEnabled: () => {} })
  assert.equal(handlerOnly.template.some((item) => item.label === label('main.tray.translation-proxy')), false)
})
