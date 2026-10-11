const test = require('node:test')
const assert = require('node:assert/strict')
const { buildTrayMenuTemplate } = require('../main/services/tray-menu')
// S13 / P0-1-T6: the labels below are the zh-CN values of the `main.tray.*` keys,
// so the lookups keep working for the literal assertions while making the source
// of the copy explicit. A language round-trip lives in test/i18n-main.test.js.
const { t, registerLocales } = require('../main/services/i18n-bootstrap')
registerLocales()
const label = (key) => t(key)

function createMenu(gameMode, { hasConversation = true } = {}) {
  const calls = []
  return {
    calls,
    template: buildTrayMenuTemplate({
      gameMode,
      hasConversation,
      screenshotAccelerator: 'F1',
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
    'main.tray.video-record',
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
