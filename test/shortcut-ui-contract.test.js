const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
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
  assert.match(main, /explainClipboard:\s*'Ctrl\+Alt\+E'/)
  assert.match(main, /case 'explainClipboard':\s*\{[\s\S]*clipboard\.readText\(\)[\s\S]*openToolbarAiAction\('explain', text\)/)
  // Must not write or empty the clipboard in this path.
  const explainCase = main.match(/case 'explainClipboard':\s*\{[\s\S]*?\n    \}/)?.[0] || ''
  assert.ok(explainCase, 'explainClipboard case present')
  assert.doesNotMatch(explainCase, /clipboard\.write/)
  assert.doesNotMatch(explainCase, /EmptyClipboard|clipboard\.clear/)
  assert.match(config, /\['explainClipboard', '解释剪贴板文本'/)
})

test('selection extraction native patch includes a UIA timeout', () => {
  const patched = fs.readFileSync(
    path.join(__dirname, '..', 'patches', 'selection-hook', 'selection_hook.cc'),
    'utf8'
  )
  assert.match(patched, /SELECTION_EXTRACT_TIMEOUT_MS/)
  assert.match(patched, /GetSelectedTextTimed/)
  assert.match(patched, /selection_epoch/)
})
