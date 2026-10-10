const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { buildTrayMenuTemplate } = require('../main/services/tray-menu')
const { DEFAULT_SETTINGS } = require('../main/services/settings-defaults')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const settingsDefaults = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'settings-defaults.js'), 'utf8')
const functionRouter = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'function-router.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const config = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.js'), 'utf8')
const styles = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.css'), 'utf8')

test('main process delegates shortcut registration and exposes status through preload', () => {
  assert.match(main, /new ShortcutService\(\{[\s\S]*globalShortcut[\s\S]*executeFunction/)
  assert.match(main, /function registerShortcuts\(\)[\s\S]*shortcutService\.suspendAll\(shortcuts, 'game-mode'\)[\s\S]*shortcutService\.registerAll\(shortcuts\)/)
  assert.match(main, /registerShortcutIpc\(\{[\s\S]*shortcutService/)
  assert.match(main, /app\.on\('will-quit',[\s\S]*shortcutService\.dispose\(\)/)
  assert.match(preload, /getShortcutStatuses:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('shortcuts:status'\)/)
})

test('settings UI refreshes and clearly marks unavailable shortcuts', () => {
  assert.match(config, /await window\.electronAPI\.getShortcutStatuses\(\)/)
  assert.match(config, /status\.reason === 'duplicate'/)
  assert.match(config, /status\.reason === 'unavailable'/)
  assert.match(config, /status\.reason === 'game-mode'/)
  assert.match(config, /className: 'set unavailable'/)
  assert.match(config, /红色警告表示快捷键冲突或不可用/)
  assert.match(styles, /\.shortcut\.unavailable\{/)
})

test('shortcut changes refresh registration status before user feedback', () => {
  assert.match(config, /if \(patch\.shortcuts\) await refreshShortcutStatuses\(\)/)
  assert.match(config, /const presentation = shortcutPresentation\(shortcutName, accelerator\)[\s\S]*renderRoute\(\)[\s\S]*toast\(presentation\.message \|\| '快捷键已更新'\)/)
})

test('explainClipboard shortcut reads clipboard only and opens the explain window', () => {
  assert.match(settingsDefaults, /explainClipboard:\s*'Ctrl\+Alt\+E'/)
  assert.match(functionRouter, /async explainClipboard\(\) \{[\s\S]*clipboard\.readText\(\)[\s\S]*openToolbarAiAction\('explain', text\)/)
  // Must not write or empty the clipboard in this path.
  const explainCase = functionRouter.match(/async explainClipboard\(\) \{[\s\S]*?\n    \},?/)?.[0] || ''
  assert.ok(explainCase, 'explainClipboard handler present')
  assert.doesNotMatch(explainCase, /clipboard\.write/)
  assert.doesNotMatch(explainCase, /EmptyClipboard|clipboard\.clear/)
  assert.match(config, /\['explainClipboard', '解释剪贴板文本'/)
})

test('the two save shortcuts and the click-through exit are frozen keys with router handlers', () => {
  // settings-defaults.js is frozen after Wave 0: these keys default to '' on
  // purpose (Ctrl+S / Ctrl+Shift+S are heavily used by other applications, so
  // registration stays best-effort and opt-in).
  assert.equal(DEFAULT_SETTINGS.shortcuts.screenshotQuickSave, '')
  assert.equal(DEFAULT_SETTINGS.shortcuts.screenshotSaveAs, '')
  assert.equal(DEFAULT_SETTINGS.shortcuts.togglePinClickThrough, '')
  assert.match(settingsDefaults, /screenshotQuickSave: ''/)
  assert.match(settingsDefaults, /screenshotSaveAs: ''/)
  assert.match(settingsDefaults, /togglePinClickThrough: ''/)

  // The handler names must be exactly the settings keys: ShortcutService
  // dispatches the key name straight into the router.
  assert.match(functionRouter, /screenshotQuickSave: \(\) => createCapture\(\{[^}]*saveMode: 'fast'/)
  assert.match(functionRouter, /screenshotSaveAs: \(\) => createCapture\(\{[^}]*saveMode: 'dialog'/)
  assert.match(functionRouter, /async togglePinClickThrough\(\) \{[\s\S]*exitAllClickThrough\(\)/)
  assert.match(functionRouter, /getPinDomain/)
})

test('the tray offers the mandatory bulk click-through exit', () => {
  const calls = []
  const template = buildTrayMenuTemplate({
    gameMode: true,
    executeFunction: (name) => calls.push(['execute', name]),
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    showConversation: () => {},
    quit: () => {}
  })
  const item = template.find((entry) => entry.label === '取消全部穿透')
  assert.ok(item, 'the tray entry exists')
  // Esc is unreliable in click-through mode, so this recovery entry must stay
  // reachable even while game mode disables the feature entries.
  assert.equal(item.enabled, true)
  item.click()
  assert.deepEqual(calls, [['execute', 'togglePinClickThrough']])

  const direct = []
  const injected = buildTrayMenuTemplate({
    executeFunction: () => direct.push('router'),
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    showConversation: () => {},
    exitClickThrough: () => direct.push('domain'),
    quit: () => {}
  }).find((entry) => entry.label === '取消全部穿透')
  injected.click()
  assert.deepEqual(direct, ['domain'], 'an injected domain exit is preferred over the router')
})

test('the main process wires the pin domain click-through exit into the router and the tray', () => {
  assert.match(main, /createFunctionRouter\(\{[\s\S]*getPinDomain/, 'the router can resolve the pin domain for the fallback shortcut')
  assert.match(main, /buildTrayMenuTemplate\(\{[\s\S]*exitClickThrough/, 'the tray entry calls the domain directly so it survives game mode')
})
test('recording defers to the shared key rules and stored values are repaired', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.html'), 'utf8')
  const validation = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'settings-validation.js'), 'utf8')
  const shortcutService = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'shortcut-service.js'), 'utf8')
  const migration = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'shortcut-migration.js'), 'utf8')

  // The renderer needs the shared module before config.js runs.
  assert.match(html, /<script src="\.\.\/shared\/shortcut-keys\.js"><\/script>\s*<script src="routes\/model-helpers\.js"><\/script>\s*<script src="config\.js"><\/script>/)
  // The recorder must not rebuild an accelerator by hand again: it asks the
  // shared module, waits out input-method compositions, and reports rejections.
  assert.match(config, /keys\.isIgnoredRecordingEvent\(keyEvent\)/)
  assert.match(config, /keys\.isRecordableShortcut\(accelerator\)/)
  assert.match(config, /keys\.describeShortcutRejection\(/)
  assert.doesNotMatch(config, /keyEvent\.key\.length === 1 \? keyEvent\.key\.toUpperCase\(\)/)
  // Both the patch validator and the registry refuse a value that cannot register.
  assert.match(validation, /isValidAccelerator\(value\)/)
  assert.match(shortcutService, /!isValidAccelerator\(accelerator\)/)
  assert.match(migration, /isValidAccelerator\(raw\)/)
  assert.match(main, /migrateShortcutSettings\(appearance\.settings, \{ log \}\)/)
})
