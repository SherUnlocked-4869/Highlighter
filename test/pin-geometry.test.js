const test = require('node:test')
const assert = require('node:assert/strict')

const {
  PIN_ZOOM_MIN,
  PIN_ZOOM_MAX,
  PIN_OPACITY_MIN,
  clampPinZoom,
  applyPinZoomFactor,
  clampPinOpacity,
  getPixelAlignedPinSize,
  normalizeSelectionBounds,
  getRotatedPinSize,
  normalizePinRotation,
  hitTestPinHotspot,
  computePinDisplaySize
} = require('../main/domains/pin/geometry')

test('clampPinZoom keeps zoom inside the product range', () => {
  assert.equal(clampPinZoom(1), 1)
  assert.equal(clampPinZoom(0.05), PIN_ZOOM_MIN)
  assert.equal(clampPinZoom(10), PIN_ZOOM_MAX)
  assert.equal(clampPinZoom('2.5'), 2.5)
  assert.equal(clampPinZoom(Number.NaN), 1)
  assert.equal(clampPinZoom(undefined), 1)
  assert.equal(clampPinZoom(null), 1)
})

test('applyPinZoomFactor multiplies then clamps', () => {
  assert.equal(applyPinZoomFactor(1, 1.2), 1.2)
  assert.equal(applyPinZoomFactor(2, 1.5), PIN_ZOOM_MAX)
  assert.equal(applyPinZoomFactor(0.25, 0.5), PIN_ZOOM_MIN)
  assert.equal(applyPinZoomFactor(1, 0), 1)
  assert.equal(applyPinZoomFactor(1, Number.NaN), 1)
  assert.equal(applyPinZoomFactor(Number.NaN, 2), 2)
})

test('clampPinOpacity floors at 0.25 and defaults invalid input to 1', () => {
  assert.equal(clampPinOpacity(0.5), 0.5)
  // Matches original main.js `Number(opacity) || 1`: 0/NaN/undefined become 1.
  assert.equal(clampPinOpacity(0), 1)
  assert.equal(clampPinOpacity(1), 1)
  assert.equal(clampPinOpacity(0.1), PIN_OPACITY_MIN)
  assert.equal(clampPinOpacity(-1), PIN_OPACITY_MIN)
  assert.equal(clampPinOpacity('nope'), 1)
  assert.equal(clampPinOpacity(undefined), 1)
})

test('getPixelAlignedPinSize converts physical pixels to DIP using display scale', () => {
  const display = { scaleFactor: 1.5 }
  const aligned = getPixelAlignedPinSize(300, 150, display)
  assert.equal(aligned.width, 200)
  assert.equal(aligned.height, 100)
  assert.equal(aligned.scaleFactor, 1.5)
})

test('getPixelAlignedPinSize prefers explicit selection bounds over pixel conversion', () => {
  const display = { scaleFactor: 2 }
  const preferred = { width: 480, height: 270 }
  const aligned = getPixelAlignedPinSize(1920, 1080, display, preferred)
  assert.equal(aligned.width, 480)
  assert.equal(aligned.height, 270)
  assert.equal(aligned.scaleFactor, 2)
})

test('getPixelAlignedPinSize floors scale factor and minimum size', () => {
  const low = getPixelAlignedPinSize(10, 10, { scaleFactor: 0.01 })
  assert.equal(low.scaleFactor, 0.25)
  assert.equal(low.width, 40)
  assert.equal(low.height, 40)

  const tiny = getPixelAlignedPinSize(0.1, 0.1, { scaleFactor: 10 })
  assert.equal(tiny.width, 1)
  assert.equal(tiny.height, 1)
})

test('getPixelAlignedPinSize treats missing display as 1x', () => {
  const aligned = getPixelAlignedPinSize(640, 480, null)
  assert.equal(aligned.scaleFactor, 1)
  assert.equal(aligned.width, 640)
  assert.equal(aligned.height, 480)
})

test('normalizeSelectionBounds rounds and enforces positive size', () => {
  assert.equal(normalizeSelectionBounds(null), null)
  assert.deepEqual(
    normalizeSelectionBounds({ x: 10.4, y: -2.6, width: 0.2, height: 80.6 }),
    { x: 10, y: -3, width: 1, height: 81 }
  )
})

test('computePinDisplaySize applies zoom and long-capture height cap', () => {
  const normal = computePinDisplaySize({
    baseWidth: 100,
    baseHeight: 50,
    zoom: 2,
    longCapture: false,
    workAreaHeight: 1000
  })
  assert.deepEqual(normal, { width: 200, height: 100, zoom: 2 })

  const long = computePinDisplaySize({
    baseWidth: 100,
    baseHeight: 2000,
    zoom: 1,
    longCapture: true,
    workAreaHeight: 1000
  })
  assert.equal(long.width, 100)
  assert.equal(long.height, 550)
  assert.equal(long.zoom, 1)
})

test('computePinDisplaySize clamps out-of-range zoom', () => {
  const result = computePinDisplaySize({
    baseWidth: 100,
    baseHeight: 100,
    zoom: 99,
    longCapture: false
  })
  assert.equal(result.zoom, PIN_ZOOM_MAX)
  assert.equal(result.width, 300)
})

test('normalizePinRotation snaps to quarter turns and wraps into [0, 360)', () => {
  assert.equal(normalizePinRotation(0), 0)
  assert.equal(normalizePinRotation(90), 90)
  assert.equal(normalizePinRotation(180), 180)
  assert.equal(normalizePinRotation(270), 270)
  assert.equal(normalizePinRotation(360), 0)
  assert.equal(normalizePinRotation(450), 90)
  assert.equal(normalizePinRotation(-90), 270)
  assert.equal(normalizePinRotation(-450), 270)
  assert.equal(normalizePinRotation('270'), 270)
  // Snapped to the nearest quarter turn: 89 -> 90, 44 -> 0.
  assert.equal(normalizePinRotation(89), 90)
  assert.equal(normalizePinRotation(44), 0)
  assert.equal(normalizePinRotation(Number.NaN), 0)
  assert.equal(normalizePinRotation(undefined), 0)
  assert.equal(normalizePinRotation('nope'), 0)
})

test('getRotatedPinSize swaps the axes on quarter turns only', () => {
  assert.deepEqual(getRotatedPinSize(300, 150, 0), { width: 300, height: 150, rotation: 0 })
  assert.deepEqual(getRotatedPinSize(300, 150, 90), { width: 150, height: 300, rotation: 90 })
  assert.deepEqual(getRotatedPinSize(300, 150, 180), { width: 300, height: 150, rotation: 180 })
  assert.deepEqual(getRotatedPinSize(300, 150, 270), { width: 150, height: 300, rotation: 270 })
  assert.deepEqual(getRotatedPinSize(300, 150, -90), { width: 150, height: 300, rotation: 270 })
})

test('getRotatedPinSize rounds and never returns a sub-pixel box', () => {
  assert.deepEqual(getRotatedPinSize(10.4, 20.6, 0), { width: 10, height: 21, rotation: 0 })
  assert.deepEqual(getRotatedPinSize(0.2, 0.2, 90), { width: 1, height: 1, rotation: 90 })
  assert.deepEqual(getRotatedPinSize(Number.NaN, 'nope', 0), { width: 1, height: 1, rotation: 0 })
})

test('hitTestPinHotspot matches the badge rectangle including its edges', () => {
  const hotspot = { x: 100, y: 10, width: 80, height: 20 }
  assert.equal(hitTestPinHotspot({ x: 140, y: 20 }, hotspot), true)
  assert.equal(hitTestPinHotspot({ x: 100, y: 10 }, hotspot), true)
  assert.equal(hitTestPinHotspot({ x: 180, y: 30 }, hotspot), true)
  assert.equal(hitTestPinHotspot({ x: 99, y: 20 }, hotspot), false)
  assert.equal(hitTestPinHotspot({ x: 140, y: 31 }, hotspot), false)
  assert.equal(hitTestPinHotspot({ x: 181, y: 20 }, hotspot), false)
})

test('hitTestPinHotspot honours padding and normalises any-corner rects', () => {
  const hotspot = { x: 100, y: 10, width: 80, height: 20 }
  assert.equal(hitTestPinHotspot({ x: 96, y: 6 }, hotspot), false)
  assert.equal(hitTestPinHotspot({ x: 96, y: 6 }, hotspot, 4), true)
  // Negative padding can never grow the target area.
  assert.equal(hitTestPinHotspot({ x: 96, y: 6 }, hotspot, -4), false)
  // A rect dragged from the bottom-right corner is still a rect.
  const flipped = { x: 180, y: 30, width: -80, height: -20 }
  assert.equal(hitTestPinHotspot({ x: 140, y: 20 }, flipped), true)
})

test('hitTestPinHotspot never matches missing or non-finite input', () => {
  assert.equal(hitTestPinHotspot(null, { x: 0, y: 0, width: 10, height: 10 }), false)
  assert.equal(hitTestPinHotspot({ x: 5, y: 5 }, null), false)
  assert.equal(hitTestPinHotspot({ x: Number.NaN, y: 5 }, { x: 0, y: 0, width: 10, height: 10 }), false)
  assert.equal(hitTestPinHotspot({ x: 5, y: 5 }, { x: 0, y: 0, width: Number.NaN, height: 10 }), false)
  assert.equal(hitTestPinHotspot({ x: 5, y: 5 }, { width: 10, height: 10 }), false)
  assert.equal(hitTestPinHotspot({ x: 5, y: 5 }, { x: 0, y: 0, width: 10, height: 10 }, Number.NaN), true)
})
