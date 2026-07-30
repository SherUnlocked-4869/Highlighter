const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  calculateLongCaptureControllerPlacement
} = require('../main/services/long-capture-controller-placement')

const root = path.resolve(__dirname, '..')

test('long capture controller shrinks into a narrow side band without covering the selection', () => {
  const placement = calculateLongCaptureControllerPlacement(
    { workArea: { x: 0, y: 0, width: 1365, height: 1112 } },
    { x: 222, y: 89, width: 785, height: 977 }
  )

  assert.equal(placement.side, 'right')
  assert.equal(placement.overlapsSelection, false)
  assert.equal(placement.bounds.x, 1017)
  assert.equal(placement.bounds.width, 348)
  assert.ok(placement.bounds.y >= 0)
  assert.ok(placement.bounds.y + placement.bounds.height <= 1112)
})

test('long capture fallback remains fully on-screen and reports selection overlap', () => {
  const placement = calculateLongCaptureControllerPlacement(
    { workArea: { x: -1280, y: 0, width: 1280, height: 720 } },
    { x: -1260, y: 20, width: 1240, height: 680 }
  )
  const bounds = placement.bounds

  assert.equal(placement.side, 'fallback')
  assert.equal(placement.overlapsSelection, true)
  assert.ok(bounds.x >= -1280)
  assert.ok(bounds.y >= 0)
  assert.ok(bounds.x + bounds.width <= 0)
  assert.ok(bounds.y + bounds.height <= 720)
})

test('quick long-capture entry auto-starts and keeps the controller recoverable', () => {
  const capture = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
  const capturePreload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')
  const controller = fs.readFileSync(path.join(root, 'long-capture', 'long-capture.js'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

  assert.match(capture, /const autoStart=initData\?\.autoAction==='long'/)
  assert.match(capture, /startLongCapture\(\{\.\.\.selection\},autoStart\)/)
  assert.match(capturePreload, /autoStart:\s*!!autoStart/)
  assert.match(main, /autoStart:\s*!!payload\.autoStart/)
  assert.match(controller, /autoStartRequested = !!data\.autoStart/)
  assert.match(controller, /setTimeout\(\(\) => startAutomation\(\), 120\)/)
  assert.match(main, /skipTaskbar:\s*false/)
  assert.match(main, /setContentProtection\(controllerPlacement\.overlapsSelection\)/)
  assert.match(main, /controllerWindow\.moveTop\(\)/)
})

test('long-capture selection overlay stays visually identifiable without entering captured frames', () => {
  const html = fs.readFileSync(path.join(root, 'long-capture', 'overlay.html'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'long-capture', 'overlay.css'), 'utf8')
  const renderer = fs.readFileSync(path.join(root, 'long-capture', 'overlay.js'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

  assert.match(html, /自动长截图区域/)
  assert.match(html, /<em>准备<\/em>/)
  assert.match(css, /border:\s*3px solid/)
  assert.match(css, /100vmax/)
  assert.match(css, /@keyframes capturePulse/)
  assert.match(renderer, /label-inside/)
  assert.match(renderer, /采集中/)
  assert.match(main, /overlayWindow\.setContentProtection\(true\)/)
  assert.match(main, /overlayWindow\.setAlwaysOnTop\(true, 'screen-saver'/)
})
