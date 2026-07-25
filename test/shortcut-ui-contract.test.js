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
  assert.match(main, /return shortcutService\.registerAll\(getSettings\(\)\.shortcuts\)/)
  assert.match(main, /registerShortcutIpc\(\{[\s\S]*shortcutService/)
  assert.match(main, /app\.on\('will-quit', \(\) => shortcutService\.dispose\(\)\)/)
  assert.match(preload, /getShortcutStatuses:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('shortcuts:status'\)/)
})

test('settings UI refreshes and clearly marks unavailable shortcuts', () => {
  assert.match(config, /await window\.electronAPI\.getShortcutStatuses\(\)/)
  assert.match(config, /status\.reason === 'duplicate'/)
  assert.match(config, /status\.reason === 'unavailable'/)
  assert.match(config, /className: 'set unavailable'/)
  assert.match(config, /红色警告表示快捷键冲突或不可用/)
  assert.match(styles, /\.shortcut\.unavailable\{/)
})

test('shortcut changes refresh registration status before user feedback', () => {
  assert.match(config, /if \(patch\.shortcuts\) await refreshShortcutStatuses\(\)/)
  assert.match(config, /const presentation = shortcutPresentation\(shortcutName, accelerator\)[\s\S]*renderRoute\(\)[\s\S]*toast\(presentation\.message \|\| '快捷键已更新'\)/)
})
