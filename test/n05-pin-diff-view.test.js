'use strict'

// N05 / DEV-08 (adopted 2026-11-28): renderer-side display math for the opt-in
// "real pixel compare" mode (pin/pin-diff-view.js).
//
// The main process sends bounded RGBA frames of the real screen pixels under the pin;
// this module turns each frame into a bounded comparison grid, a red diff mask, the
// changed ratio/bounds and the badge copy. Everything here is pure and node-testable; the
// renderer only owns canvas/DOM plumbing on top.
const test = require('node:test')
const assert = require('node:assert/strict')

const diffView = require('../pin/pin-diff-view')

const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }

function rgba(width, height, fill = 0) {
  return new Uint8Array(width * height * 4).fill(fill)
}

function planFor(width = 4, height = 2, extra = {}) {
  return diffView.planDiffOverlay({
    capture: { width, height },
    dipRect: { x: 100, y: 200, width, height },
    devicePixelRatio: 1,
    windowOrigin: { x: 60, y: 150 },
    ...extra
  })
}

test('plan: the comparison grid is bounded and the CSS rect is window-relative', () => {
  const small = planFor(4, 2)
  assert.equal(small.ok, true)
  assert.equal(small.step, 1)
  assert.equal(small.width, 4)
  assert.equal(small.height, 2)
  assert.equal(small.maskBytes, 4 * 2 * 4)
  assert.deepEqual(small.cssRect, { left: 40, top: 50, width: 4, height: 2 })

  // 2000x1500 = 3 Mpx > 1 Mpx: one integer step of 2 keeps a square pixel grid.
  const big = planFor(2000, 1500)
  assert.equal(big.ok, true)
  assert.equal(big.step, 2)
  assert.equal(big.width, 1000)
  assert.equal(big.height, 750)
  assert.ok(big.width * big.height <= diffView.MAX_DIFF_PIXELS)

  // A caller can lower the budget further (bounded representation, never unbounded).
  const tiny = planFor(100, 100, { maxPixels: 100 })
  assert.equal(tiny.step, 10)
  assert.equal(tiny.width * tiny.height, 100)

  assert.deepEqual(diffView.planDiffOverlay({ capture: { width: 0, height: 0 } }), { ok: false, code: 'EMPTY_CAPTURE' })
  assert.deepEqual(diffView.planDiffOverlay({ capture: { width: 4, height: 2 } }), { ok: false, code: 'NO_DIP_RECT' })
})

test('mask: identical frames report no change; one changed pixel is located and tinted', () => {
  const plan = planFor(4, 2)
  const same = rgba(4, 2, 9)
  const noChange = diffView.buildDiffMask(same, same, plan, { tolerance: 8 })
  assert.equal(noChange.ok, true)
  assert.equal(noChange.different, 0)
  assert.equal(noChange.ratio, 0)
  assert.equal(noChange.bounds, null)
  assert.equal(noChange.mask.reduce((sum, value) => sum + value, 0), 0)

  const changed = Uint8Array.from(same)
  const offset = (1 * 4 + 2) * 4
  changed[offset] = 200
  const diff = diffView.buildDiffMask(changed, same, plan)
  assert.equal(diff.ok, true)
  assert.equal(diff.different, 1)
  assert.equal(diff.ratio, 1 / 8)
  assert.deepEqual(diff.bounds, { x: 2, y: 1, width: 1, height: 1 })
  assert.equal(diff.maxDelta, 191)
  const maskOffset = (1 * 4 + 2) * 4
  assert.deepEqual([...diff.mask.slice(maskOffset, maskOffset + 3)], [
    diffView.MASK_COLOR.r, diffView.MASK_COLOR.g, diffView.MASK_COLOR.b
  ])
  assert.ok(diff.mask[maskOffset + 3] > 0, 'the changed pixel is tinted')
  // Tolerance suppresses capture noise but keeps the real edit.
  const tolerant = diffView.buildDiffMask(changed, same, plan, { tolerance: 255 })
  assert.equal(tolerant.different, 0)

  // A bounded grid reports the changed region in CAPTURE pixels, not grid pixels.
  const bigPlan = planFor(200, 100, { maxPixels: 1250 })
  assert.equal(bigPlan.step, 4)
  const a = rgba(200, 100, 10)
  const b = Uint8Array.from(a)
  b[((20 * 200) + 40) * 4] = 200
  const bigDiff = diffView.buildDiffMask(b, a, bigPlan)
  assert.deepEqual(bigDiff.bounds, { x: 40, y: 20, width: 4, height: 4 })
})

test('mask: frame sizes that do not describe the same physical pixels are refused', () => {
  const plan = planFor(4, 2)
  assert.equal(diffView.buildDiffMask(rgba(4, 2), rgba(4, 2), plan, {}).ok, true)
  assert.equal(diffView.buildDiffMask(rgba(2, 2), rgba(4, 2), plan).code, 'CAPTURE_SIZE_MISMATCH')
  assert.equal(diffView.buildDiffMask(rgba(4, 2), rgba(4, 3), plan).code, 'VIEW_SIZE_MISMATCH')
  assert.equal(diffView.buildDiffMask(rgba(4, 2), rgba(4, 2), { ok: false }).code, 'INVALID_PLAN')
})

test('paint: the mask is painted through putImageData on the overlay canvas', () => {
  const previousImageData = globalThis.ImageData
  let painted = null
  globalThis.ImageData = class FakeImageData {
    constructor(data, width, height) {
      this.data = data
      this.width = width
      this.height = height
    }
  }
  try {
    const plan = planFor(4, 2)
    const mask = rgba(4, 2)
    mask[0] = 200
    const diff = diffView.buildDiffMask(mask, rgba(4, 2), plan)
    const recorder = { putImageData: (imageData, x, y) => { painted = { imageData, x, y } } }
    assert.equal(diffView.paintDiffMask(recorder, diff), true)
    assert.equal(painted.x, 0)
    assert.equal(painted.y, 0)
    assert.equal(painted.imageData.width, 4)
    assert.equal(painted.imageData.height, 2)
    assert.equal(painted.imageData.data, diff.mask)
    assert.equal(diffView.paintDiffMask(null, diff), false)
    assert.equal(diffView.paintDiffMask(recorder, { ok: false }), false)
  } finally {
    if (previousImageData) globalThis.ImageData = previousImageData
    else delete globalThis.ImageData
  }
})

test('badge: locale keys carry the ratio or the no-change/failure state', () => {
  const noChange = diffView.diffBadge({ ok: true, ratio: 0, different: 0 })
  assert.equal(noChange.key, 'pin.onion.real-diff.no-change')
  assert.equal(noChange.params, null)
  const changed = diffView.diffBadge({ ok: true, ratio: 0.1234, different: 10 })
  assert.equal(changed.key, 'pin.onion.real-diff.changed')
  assert.equal(changed.params.ratio, '12.3')
  const failed = diffView.diffBadge({ ok: false, code: 'VIEW_SIZE_MISMATCH' })
  assert.equal(failed.key, 'pin.onion.real-diff.unavailable')
  assert.equal(failed.params.code, 'VIEW_SIZE_MISMATCH')
  // A few noisy pixels across a large grid still read as "no change".
  assert.equal(diffView.diffBadge({ ok: true, ratio: 0.0001, different: 1 }).key, 'pin.onion.real-diff.no-change')
})

test('plan: display snapshot helper is unused by this module (planning stays in main)', () => {
  // Guard against a second, drifting screen-plan implementation in the renderer.
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'pin', 'pin-diff-view.js'), 'utf8')
  assert.doesNotMatch(source, /desktopCapturer|display_id|physicalRect/)
  assert.ok(DISPLAY.bounds.width > 0)
})

test('wiring: the real-diff view composes the same measured visible rectangle as the view export (P2-02)', () => {
  // DEV-08 P2-02: the diff view called planViewExport() too, and duplicated the broken
  // document.scrollingElement read. Both entries must feed ONE measurement of the picture's
  // actual on-screen rectangle, otherwise a long pin compares the diff frame against the
  // picture top instead of the scrolled viewport.
  const fs = require('node:fs')
  const path = require('node:path')
  const pinScript = fs.readFileSync(path.join(__dirname, '..', 'pin', 'pin.js'), 'utf8')
  const code = pinScript.replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /document\.scrollingElement/)
  assert.doesNotMatch(code, /document\.documentElement\.scrollTop/)
  const composeAt = code.indexOf('async function composeViewExport')
  const diffAt = code.indexOf('async function handleScreenDiffFrame')
  assert.ok(composeAt > 0 && diffAt > composeAt, 'both compositor entries exist')
  assert.match(code.slice(composeAt, diffAt), /visibleRect: measureVisibleSurfaceRect\(\)/, 'the export feeds the measurement')
  const diffSource = code.slice(diffAt)
  assert.match(diffSource, /visibleRect: measureVisibleSurfaceRect\(\)/, 'the diff view feeds the same measurement')
  assert.match(diffSource, /planViewExport\(\{/)
  assert.match(diffSource, /longCapture: settings\.longCapture === true/)
})
