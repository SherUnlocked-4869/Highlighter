const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const manager = fs.readFileSync(path.join(root, 'main', 'services', 'selection-window-manager.js'), 'utf8')

test('selection result windows use and persist the configured size', () => {
  assert.match(manager, /const size = this\.getSettings\(\)\.selectionToolbar\.resultWindow/)
  assert.match(manager, /width: size\.width,[\s\S]*height: size\.height/)
  assert.match(manager, /minWidth: this\.actionMinWidth,[\s\S]*minHeight: this\.actionMinHeight/)
  assert.match(manager, /win\.on\('resize', \(\) => this\.scheduleActionWindowSizeSave\(win\)\)/)
  assert.match(manager, /win\.on\('close', \(\) => this\.flushActionWindowSizeSave\(win\)\)/)
  assert.match(manager, /this\.updateSettings\(\{ selectionToolbar: \{ resultWindow: \{ width, height \} \} \}\)/)
})
