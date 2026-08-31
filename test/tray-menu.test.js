const test = require('node:test')
const assert = require('node:assert/strict')
const { buildTrayMenuTemplate } = require('../main/services/tray-menu')

function createMenu(gameMode) {
  const calls = []
  return {
    calls,
    template: buildTrayMenuTemplate({
      gameMode,
      screenshotAccelerator: 'F1',
      executeFunction: (name) => calls.push(['execute', name]),
      setGameModeEnabled: (enabled) => calls.push(['game-mode', enabled]),
      openHistory: () => calls.push(['history']),
      openMainWindow: () => calls.push(['main']),
      quit: () => calls.push(['quit'])
    })
  }
}

test('tray menu exposes an unchecked game mode toggle during normal operation', () => {
  const { calls, template } = createMenu(false)
  const toggle = template.find((item) => item.label === '游戏模式')
  const screenshot = template.find((item) => item.label === '截图')

  assert.equal(toggle.type, 'checkbox')
  assert.equal(toggle.checked, false)
  assert.equal(screenshot.enabled, true)
  assert.equal(screenshot.accelerator, 'F1')
  toggle.click()
  assert.deepEqual(calls, [['game-mode', true]])
})

test('tray menu disables summon actions and can turn game mode off', () => {
  const { calls, template } = createMenu(true)
  const featureLabels = ['截图', '截取全屏', '截取焦点窗口', '固定图片到屏幕', '视频录制', '本地搜索']
  for (const label of featureLabels) {
    assert.equal(template.find((item) => item.label === label).enabled, false, label)
  }

  const toggle = template.find((item) => item.label === '游戏模式')
  assert.equal(toggle.checked, true)
  toggle.click()
  assert.deepEqual(calls, [['game-mode', false]])
})
