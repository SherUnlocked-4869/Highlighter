const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

test('selection result windows use and persist the configured size', () => {
  assert.match(main, /const size = getSettings\(\)\.selectionToolbar\.resultWindow/)
  assert.match(main, /width: size\.width,[\s\S]*height: size\.height/)
  assert.match(main, /minWidth: ACTION_WINDOW_MIN_WIDTH,[\s\S]*minHeight: ACTION_WINDOW_MIN_HEIGHT/)
  assert.match(main, /win\.on\('resize', \(\) => scheduleActionWindowSizeSave\(win\)\)/)
  assert.match(main, /win\.on\('close', \(\) => flushActionWindowSizeSave\(win\)\)/)
  assert.match(main, /settingsService\.updateSettings\(\{ selectionToolbar: \{ resultWindow: \{ width, height \} \} \}\)/)
})
