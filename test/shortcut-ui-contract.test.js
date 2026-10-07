const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

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
