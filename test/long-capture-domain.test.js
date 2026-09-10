const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const longCaptureSource = fs.readFileSync(path.join(root, 'main/domains/long-capture/index.js'), 'utf8')

test('main.js delegates long-capture domain instead of inlining session windows', () => {
  assert.match(main, /require\('\.\/main\/domains\/long-capture'\)/)
  assert.match(main, /createLongCaptureDomain\(\{/)
  assert.match(main, /longCaptureDomain\s*=\s*createLongCaptureDomain/)
  assert.doesNotMatch(main, /function createLongCaptureFromSelection\(/)
  assert.doesNotMatch(main, /function finishLongCapture\(/)
  assert.doesNotMatch(main, /function closeLongCapture\(/)
  assert.doesNotMatch(main, /let currentLongCapture = null/)
  assert.doesNotMatch(main, /longCaptureIpcController/)
})

test('main.js routes long-capture ownership, task checks, and IPC through the domain', () => {
  assert.match(main, /longCaptureDomain\?\.ownsControllerWindow\(win\)/)
  assert.match(main, /longCaptureDomain\?\.ownsOverlayWindow\(win\)/)
  assert.match(main, /longCaptureDomain\?\.isTaskActive\(\)/)
  assert.match(main, /\.\.\.longCaptureDomain\.createLongCaptureController\(\)/)
  assert.match(main, /longCaptureDomain\.createLongCaptureFromSelection\(/)
  assert.match(main, /longCaptureDomain\.closeLongCapture\(\)/)
  assert.match(main, /await longCaptureDomain\.shutdown\(\)/)
})

test('long-capture domain owns session lifecycle and long:* IPC handlers', () => {
  assert.match(longCaptureSource, /function createLongCaptureFromSelection/)
  assert.match(longCaptureSource, /function finishLongCapture/)
  assert.match(longCaptureSource, /function closeLongCapture/)
  assert.match(longCaptureSource, /function createLongCaptureController/)
  for (const channel of [
    'longReady',
    'longOverlayReady',
    'longOverlayActive',
    'longAddStrip',
    'longSetTrim',
    'longSetSelectionEditing',
    'longOverlayBoundsChanged',
    'longFinish',
    'longClose'
  ]) {
    assert.match(longCaptureSource, new RegExp(`${channel}:`))
  }
  assert.match(longCaptureSource, /assertManagedDataWritable\(\)/)
  assert.match(longCaptureSource, /LongCaptureSession/)
})
