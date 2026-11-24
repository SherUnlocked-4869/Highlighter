'use strict'

// A07 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the end-of-drag
// snap geometry and the tray's display names. Pure arithmetic, so every acceptance case
// the review names - 100%/150%, negative coordinates, the two-screen seam, a window
// larger than its work area - runs here without a desktop.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_PIN_SNAP_DISTANCE,
  normalizeRect,
  computePinSnap,
  orderDisplays,
  displayKey,
  pickDisplayForBounds,
  displayLabel
} = require('../main/services/pin-geometry')
const { t, registerLocales, setLanguage, currentLanguage } = require('../main/services/i18n-bootstrap')

registerLocales()

const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

function withLanguage(language, run) {
  const previous = currentLanguage()
  setLanguage(language)
  try {
    return run()
  } finally {
    setLanguage(previous)
  }
}

// A 1920x1080 primary work area with a 40 DIP taskbar, the same box the pin domain sees.
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }
const LEFT_150 = { x: -2560, y: 0, width: 2560, height: 1400 }
const NEGATIVE_ORIGIN = { x: -1920, y: -200, width: 1920, height: 1040 }
const RIGHT = { x: 1920, y: 0, width: 1920, height: 1040 }

function edgeError(a, b) {
  return Math.abs(a - b)
}

test('snap distance is the 8 DIP the review accepts', () => {
  assert.equal(DEFAULT_PIN_SNAP_DISTANCE, 8)
})

test('normalizeRect rounds and rejects non-finite or empty boxes', () => {
  assert.deepEqual(normalizeRect({ x: -1.4, y: 2.6, width: 100.4, height: 40.6 }), { x: -1, y: 3, width: 100, height: 41 })
  assert.equal(normalizeRect(null), null)
  assert.equal(normalizeRect({ x: 0, y: 0, width: 0, height: 10 }), null)
  assert.equal(normalizeRect({ x: Number.NaN, y: 0, width: 10, height: 10 }), null)
})

test('snaps to each work-area edge and leaves a 0 DIP error', () => {
  const area = PRIMARY
  const cases = [
    { bounds: { x: 5, y: 300, width: 200, height: 100 }, expect: { x: 0, y: 300 }, edge: ['x', 0] },
    { bounds: { x: 1715, y: 300, width: 200, height: 100 }, expect: { x: 1720, y: 300 }, edge: ['right', 1920] },
    { bounds: { x: 300, y: 3, width: 200, height: 100 }, expect: { x: 300, y: 0 }, edge: ['y', 0] },
    { bounds: { x: 300, y: 937, width: 200, height: 100 }, expect: { x: 300, y: 940 }, edge: ['bottom', 1040] }
  ]
  for (const testCase of cases) {
    const result = computePinSnap({ bounds: testCase.bounds, workAreas: [area] })
    assert.equal(result.width, testCase.bounds.width, 'never resizes')
    assert.equal(result.height, testCase.bounds.height, 'never resizes')
    assert.equal(result.x, testCase.expect.x)
    assert.equal(result.y, testCase.expect.y)
    if (testCase.edge[0] === 'right') {
      assert.ok(edgeError(result.x + result.width, testCase.edge[1]) <= 1)
      assert.equal(result.snapped.x, true)
    } else if (testCase.edge[0] === 'bottom') {
      assert.ok(edgeError(result.y + result.height, testCase.edge[1]) <= 1)
      assert.equal(result.snapped.y, true)
    } else {
      const value = testCase.edge[0] === 'x' ? result.x : result.y
      assert.ok(edgeError(value, testCase.edge[1]) <= 1)
    }
  }
})

test('snaps to a neighbouring pin edge, not only to the work area', () => {
  const neighbour = { x: 500, y: 0, width: 100, height: 100 }
  const near = computePinSnap({
    bounds: { x: 392, y: 300, width: 100, height: 100 },
    workAreas: [PRIMARY],
    windowEdges: [neighbour]
  })
  assert.equal(near.x, 400, 'right edge lands on the neighbour left edge')
  assert.ok(edgeError(near.x + near.width, neighbour.x) <= 1)
  assert.equal(near.y, 300, 'the far axis is untouched')

  // Below/above the neighbour works the same way.
  const below = computePinSnap({
    bounds: { x: 300, y: 402, width: 100, height: 100 },
    workAreas: [PRIMARY],
    windowEdges: [{ x: 300, y: 500, width: 100, height: 100 }]
  })
  assert.equal(below.y, 400)
  assert.ok(edgeError(below.y + below.height, 500) <= 1)
})

test('the 8 DIP boundary is inclusive and 9 DIP is not snapped', () => {
  const neighbour = { x: 500, y: 0, width: 100, height: 100 }
  const at = computePinSnap({
    bounds: { x: 392, y: 300, width: 108, height: 100 },
    workAreas: [PRIMARY],
    windowEdges: [neighbour]
  })
  assert.equal(at.x, 392, 'right edge 500 - 108 = 392, exactly 0 away')
  assert.equal(at.snapped.x, false, 'already aligned: no movement')

  const eight = computePinSnap({
    bounds: { x: 392, y: 300, width: 100, height: 100 },
    workAreas: [PRIMARY],
    windowEdges: [neighbour]
  })
  assert.equal(eight.x, 400, 'exactly 8 DIP still snaps')

  const nine = computePinSnap({
    bounds: { x: 391, y: 300, width: 100, height: 100 },
    workAreas: [PRIMARY],
    windowEdges: [neighbour]
  })
  assert.equal(nine.x, 391, '9 DIP is out of range')
  assert.deepEqual(nine.snapped, { x: false, y: false })
})

test('the smallest displacement wins and ties prefer the work area', () => {
  // The work-area left edge is 5 DIP away, the neighbour edge only 2.
  const neighbourWins = computePinSnap({
    bounds: { x: 5, y: 5, width: 100, height: 100 },
    workAreas: [PRIMARY],
    windowEdges: [{ x: 107, y: 106, width: 50, height: 50 }]
  })
  assert.equal(neighbourWins.x, 7, 'the 2 DIP neighbour edge beats the 5 DIP work-area edge')
  assert.equal(neighbourWins.y, 6, 'the 1 DIP neighbour edge beats the 5 DIP work-area top')

  // Equal distances: work area first, so repeating the call cannot change the answer.
  const tie = computePinSnap({
    bounds: { x: 4, y: 300, width: 100, height: 100 },
    workAreas: [PRIMARY],
    windowEdges: [{ x: 8, y: 0, width: 50, height: 50 }]
  })
  assert.equal(tie.x, 0)
})

test('a window larger than the work area is never resized or pushed further out', () => {
  const area = { x: 0, y: 0, width: 800, height: 600 }
  const result = computePinSnap({
    bounds: { x: 700, y: 6, width: 1000, height: 100 },
    workAreas: [area]
  })
  assert.equal(result.x, 700, 'the horizontal axis cannot be contained: leave it alone')
  assert.equal(result.y, 0, 'the vertical axis still snaps')
  assert.equal(result.width, 1000)
  assert.equal(result.height, 100)
  assert.deepEqual(result.snapped, { x: false, y: true })
})

test('negative-coordinate displays snap on their own origin', () => {
  const result = computePinSnap({
    bounds: { x: -1913, y: -194, width: 100, height: 100 },
    workAreas: [NEGATIVE_ORIGIN]
  })
  assert.equal(result.x, -1920)
  assert.equal(result.y, -200)
  assert.ok(edgeError(result.x, NEGATIVE_ORIGIN.x) <= 1)
  assert.ok(edgeError(result.y, NEGATIVE_ORIGIN.y) <= 1)

  // The 150% screen is a separate display with its own work area; the snap is in DIP,
  // so the scale factor changes nothing about the arithmetic.
  const scaled = computePinSnap({
    bounds: { x: -2553, y: 6, width: 200, height: 100 },
    workAreas: [LEFT_150]
  })
  assert.equal(scaled.x, -2560)
  assert.equal(scaled.y, 0)
})

test('Alt skips the snap entirely; an injected preference can disable it', () => {
  const bounds = { x: 392, y: 300, width: 100, height: 100 }
  const skipped = computePinSnap({ bounds, workAreas: [PRIMARY], windowEdges: [{ x: 500, y: 0, width: 100, height: 100 }], altKey: true })
  assert.deepEqual(skipped, { ...bounds, snapped: { x: false, y: false }, displayIndex: -1, reason: 'alt' })

  const disabled = computePinSnap({ bounds, workAreas: [PRIMARY], enabled: false })
  assert.equal(disabled.x, 392)
  assert.equal(disabled.reason, 'disabled')

  const noArea = computePinSnap({ bounds, workAreas: [] })
  assert.equal(noArea.x, 392)
  assert.equal(noArea.reason, 'no-work-area')
})

test('a seam-straddling pin belongs to the display that owns its center', () => {
  const areas = [PRIMARY, RIGHT]
  // Center 1850 - on the primary - even though the box reaches 80 DIP into the right screen.
  const onPrimary = computePinSnap({ bounds: { x: 1700, y: 300, width: 300, height: 100 }, workAreas: areas })
  assert.equal(onPrimary.displayIndex, 0)
  // Center 1970 - on the second screen.
  const onRight = computePinSnap({ bounds: { x: 1820, y: 300, width: 300, height: 100 }, workAreas: areas })
  assert.equal(onRight.displayIndex, 1)
  // One DIP of jitter cannot flip the owner.
  const jitter = computePinSnap({ bounds: { x: 1821, y: 300, width: 300, height: 100 }, workAreas: areas })
  assert.equal(jitter.displayIndex, 1)
})

test('snapping stays inside the centre-owned work area at a seam', () => {
  // A right-screen pin whose left edge is 3 DIP inside the primary: it belongs to the
  // right screen (center 2017) and snaps to that screen's own left edge, the seam.
  const rightPin = computePinSnap({
    bounds: { x: 1915, y: 300, width: 200, height: 100 },
    workAreas: [PRIMARY, RIGHT]
  })
  assert.equal(rightPin.displayIndex, 1)
  assert.equal(rightPin.x, 1920)
  assert.equal(rightPin.snapped.x, true)

  // A primary-screen pin 3 DIP before the seam keeps its own screen's right edge and
  // is not dragged across it by the right screen's left edge.
  const primaryPin = computePinSnap({
    bounds: { x: 1717, y: 300, width: 200, height: 100 },
    workAreas: [PRIMARY, RIGHT]
  })
  assert.equal(primaryPin.displayIndex, 0)
  assert.equal(primaryPin.x, 1720)
  assert.equal(primaryPin.x + primaryPin.width, 1920)
  assert.ok(primaryPin.x + primaryPin.width <= PRIMARY.x + PRIMARY.width)
})

test('orderDisplays is primary-first then left-to-right, negative origins included', () => {
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
  const left = { id: 2, bounds: { x: -2560, y: 0, width: 2560, height: 1440 } }
  const above = { id: 3, bounds: { x: 0, y: -1080, width: 1920, height: 1080 } }
  const ordered = orderDisplays([left, above, primary], primary)
  assert.deepEqual(ordered.map((display) => display.id), [1, 2, 3])
  assert.deepEqual(orderDisplays([left, above]).map((display) => display.id), [2, 3])
})

test('displayKey is stable with and without display ids', () => {
  assert.equal(displayKey({ id: 7 }), 'display:7')
  assert.equal(displayKey({ bounds: { x: -1, y: 2, width: 3, height: 4 } }), 'display:-1,2,3,4')
  assert.equal(displayKey(null), 'display:unknown')
})

test('pickDisplayForBounds prefers the center over a different Electron match', () => {
  const primary = { id: 1, bounds: PRIMARY }
  const right = { id: 2, bounds: RIGHT }
  // Matched says "right", but the center is on the primary: the center wins (seam rule).
  const chosen = pickDisplayForBounds({ x: 1700, y: 300, width: 300, height: 100 }, [primary, right], right)
  assert.equal(chosen.id, 1)
  // A center in no display falls back to Electron's match.
  const orphan = pickDisplayForBounds({ x: 5000, y: 5000, width: 100, height: 100 }, [primary, right], right)
  assert.equal(orphan.id, 2)
})

test('displayLabel carries ordinal, resolution, scale, role and negative origin', () => {
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1, primary: true }
  const secondary = { id: 2, bounds: { x: -2560, y: -200, width: 2560, height: 1440 }, size: { width: 2560, height: 1440 }, scaleFactor: 1.5, primary: false }

  const first = displayLabel(primary, 0)
  assert.match(first, /1920×1080/)
  assert.match(first, /100%/)
  assert.match(first, new RegExp(t('main.tray.pin-display-primary'), 'u'))
  assert.match(first, /显示器 1/)

  const second = displayLabel(secondary, 1)
  assert.match(second, /2560×1440/)
  assert.match(second, /150%/)
  assert.match(second, new RegExp(t('main.tray.pin-display-secondary'), 'u'))
  assert.match(second, /显示器 2/)
  assert.match(second, /\(-2560, -200\)/, 'the negative origin is printed verbatim')

  // The label moves with the language instead of falling back to the key.
  for (const language of LANGUAGES) {
    withLanguage(language, () => {
      const localized = displayLabel(secondary, 1)
      assert.doesNotMatch(localized, /^main\./, language + ': no key fallback')
      assert.match(localized, /\(-2560, -200\)/)
    })
  }
  const zh = withLanguage('zh-CN', () => displayLabel(secondary, 1))
  const en = withLanguage('en-US', () => displayLabel(secondary, 1))
  const tw = withLanguage('zh-TW', () => displayLabel(secondary, 1))
  assert.notEqual(zh, en)
  assert.notEqual(en, tw)
})

test('displayLabel tolerates a display without size or bounds', () => {
  const label = displayLabel(null, 0)
  assert.doesNotMatch(label, /^main\./)
  assert.match(label, /0×0/)
})
