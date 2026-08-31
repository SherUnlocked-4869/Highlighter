const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const config = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.js'), 'utf8')

test('game mode is persisted and synchronizes tray, shortcuts, selection, and search', () => {
  assert.match(main, /system:\s*\{[\s\S]*gameMode: false/)
  assert.match(main, /settingsService\.updateSettings\(\{ system: \{ gameMode: nextEnabled \} \}\)/)
  assert.match(main, /function applyGameModeState\([\s\S]*registerShortcuts\(\)[\s\S]*selectionHookService\?\.suspend\('game-mode'\)[\s\S]*hideToolbar\(\)[\s\S]*searchWindow\.hide\(\)/)
  assert.match(main, /if \(isGameModeEnabled\(\)\) return selectionHookService\.suspend\('game-mode'\)/)
  assert.match(main, /\['resume',[\s\S]*if \(!isGameModeEnabled\(\)\) selectionHookService\?\.scheduleRestart\('system-resume'\)/)
  assert.match(main, /tray\.setContextMenu\(Menu\.buildFromTemplate\(buildTrayMenuTemplate\(\{/)
  assert.match(main, /webContents\.send\('app:game-mode-changed', gameMode\)/)
  assert.match(preload, /onGameModeChanged:[\s\S]*ipcRenderer\.on\('app:game-mode-changed'/)
  assert.match(config, /switchMarkup\(settings\.system\.gameMode, 'gameMode', 'system'\)/)
  assert.match(config, /onGameModeChanged\(\(enabled\) =>/)
})

test('game mode guards every feature dispatch and passive summon entry point', () => {
  assert.match(main, /async function executeFunction\(name, payload = \{\}\) \{\s*assertGameModeDisabled\(\)/)
  assert.match(main, /async function createCaptureWindow\(options = \{\}\) \{\s*assertGameModeDisabled\(\)/)
  assert.match(main, /function createSearchWindow\(\) \{\s*assertGameModeDisabled\(\)/)
  assert.match(main, /async function createRecordWindow\(options = \{\}\) \{\s*assertGameModeDisabled\(\)/)
  assert.match(main, /function handleTextSelection\(data\) \{\s*if \(isGameModeEnabled\(\)\)/)
})
