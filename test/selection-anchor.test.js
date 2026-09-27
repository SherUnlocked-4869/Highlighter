const test = require('node:test')
const assert = require('node:assert/strict')
const {
  HOOK_OFFSETS,
  orientationFor,
  resolveSelectionAnchor,
  validCoord
} = require('../main/domains/selection/anchor')

// The layout this bug was reported on: a 1.5 landscape primary next to a 1.25
// portrait secondary, with the secondary to the right of the primary.
const PRIMARY = { origin: { x: 0, y: 0 }, scale: 1.5, physical: { x: 0, y: 0, width: 3840, height: 2160 } }
const SECONDARY = { origin: { x: 2560, y: -136 }, scale: 1.25, physical: { x: 3840, y: -170, width: 1440, height: 2560 } }
const DISPLAYS = [PRIMARY, SECONDARY]

function displayFor(point) {
  return DISPLAYS.find((display) => point.x >= display.physical.x
    && point.x < display.physical.x + display.physical.width
    && point.y >= display.physical.y
    && point.y < display.physical.y + display.physical.height)
}

function dipRect(display) {
  return {
    x: display.origin.x,
    y: display.origin.y,
    width: display.physical.width / display.scale,
    height: display.physical.height / display.scale
  }
}

function inside(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height
}

// Faithful `screen.screenToDipPoint`: scales relative to the display containing
// the *physical* point, exactly as Electron documents it.
function createToDip(calls = []) {
  const toDip = (point) => {
    calls.push({ ...point })
    const display = displayFor(point)
    if (!display) return { ...point }
    return {
      x: display.origin.x + (point.x - display.physical.x) / display.scale,
      y: display.origin.y + (point.y - display.physical.y) / display.scale
    }
  }
  toDip.calls = calls
  return toDip
}

// Physical points, one in the middle of each display.
const PHYSICAL_ON_PRIMARY = { x: 1920, y: 1080 }
const PHYSICAL_ON_SECONDARY = { x: 4560, y: 900 }
const DIP_ON_PRIMARY = { x: 1280, y: 720 }
const DIP_ON_SECONDARY = { x: 3136, y: 720 }

test('a positionless selection anchors on the pointer without converting it again', () => {
  const toDip = createToDip()
  const result = resolveSelectionAnchor(
    { posLevel: 0 },
    { cursorPoint: DIP_ON_SECONDARY, isWin: true, toDip }
  )
  assert.equal(result.source, 'cursor')
  assert.deepEqual(result.refPoint, DIP_ON_SECONDARY)
  assert.equal(toDip.calls.length, 0, 'an Electron DIP point must not be converted a second time')
  assert.equal(result.orientation, 'bottomMiddle')
})

test('hook geometry is converted once and lands inside the display it came from', () => {
  const toDip = createToDip()
  const result = resolveSelectionAnchor(
    { posLevel: 3, endBottom: PHYSICAL_ON_SECONDARY, startBottom: { x: 4400, y: 400 } },
    { cursorPoint: DIP_ON_PRIMARY, isWin: true, toDip }
  )
  assert.equal(result.source, 'hook')
  assert.deepEqual(result.physical, PHYSICAL_ON_SECONDARY)
  assert.equal(toDip.calls.length, 1)
  assert.deepEqual(toDip.calls[0], PHYSICAL_ON_SECONDARY)
  assert.deepEqual(result.refPoint, { x: 3136, y: 720 + HOOK_OFFSETS.selectionBottom })
  assert.ok(inside(result.refPoint, dipRect(SECONDARY)), 'anchor stays on the secondary display')
  assert.ok(!inside(result.refPoint, dipRect(PRIMARY)))
})

test('the hook nudge is applied in DIP, after the conversion', () => {
  const toDip = createToDip()
  const single = resolveSelectionAnchor(
    { posLevel: 1, mousePosEnd: PHYSICAL_ON_SECONDARY },
    { cursorPoint: DIP_ON_PRIMARY, isWin: true, toDip }
  )
  assert.deepEqual(single.refPoint, { x: 3136, y: 720 + HOOK_OFFSETS.mouseSingle })

  const dual = resolveSelectionAnchor(
    { posLevel: 2, mousePosEnd: PHYSICAL_ON_SECONDARY },
    { cursorPoint: DIP_ON_PRIMARY, isWin: true, toDip }
  )
  assert.deepEqual(dual.refPoint, { x: 3136, y: 720 }, 'posLevel 2 carries no nudge')
})

test('orientation keeps the original dead zones and survives a missing anchor field', () => {
  assert.equal(orientationFor({ x: 0, y: 200 }, { x: 0, y: 211 }, { deadZone: 10 }), 'bottomLeft')
  assert.equal(orientationFor({ x: 0, y: 200 }, { x: 0, y: 189 }, { deadZone: 10 }), 'topRight')
  assert.equal(orientationFor({ x: 0, y: 200 }, { x: 0, y: 205 }, { deadZone: 10 }), 'bottomRight')
  assert.equal(orientationFor({ x: 0, y: 200 }, { x: 0, y: 201 }, { deadZone: 0 }), 'bottomLeft')
  assert.equal(orientationFor(null, { x: 0, y: 1 }, { deadZone: 10 }), '')

  // posLevel 2 still reports the hook's orientation even when it has no anchor.
  const toDip = createToDip()
  const result = resolveSelectionAnchor(
    { posLevel: 2, mousePosEnd: null, startBottom: { x: 10, y: 10 }, endBottom: { x: 10, y: 30 } },
    { cursorPoint: DIP_ON_SECONDARY, isWin: true, toDip }
  )
  assert.equal(result.source, 'cursor')
  assert.deepEqual(result.refPoint, DIP_ON_SECONDARY)
  assert.equal(result.orientation, 'bottomLeft')
  assert.equal(toDip.calls.length, 0)
})

test('invalid hook coordinates fall back to the pointer and are never converted', () => {
  const toDip = createToDip()
  const result = resolveSelectionAnchor(
    { posLevel: 4, endBottom: { x: -99999, y: -99999 }, mousePosEnd: { x: -99999, y: -99999 } },
    { cursorPoint: DIP_ON_SECONDARY, isWin: true, toDip }
  )
  assert.equal(result.source, 'cursor')
  assert.deepEqual(result.refPoint, DIP_ON_SECONDARY)
  assert.equal(toDip.calls.length, 0)
  assert.equal(validCoord({ x: -99999, y: 0 }), false)
  assert.equal(validCoord({ x: 0, y: 0 }), true)
  assert.equal(validCoord(undefined), false)
})

test('a usable mouse position still anchors when the selection geometry is missing', () => {
  const toDip = createToDip()
  const result = resolveSelectionAnchor(
    { posLevel: 4, endBottom: null, mousePosEnd: PHYSICAL_ON_SECONDARY },
    { cursorPoint: DIP_ON_PRIMARY, isWin: true, toDip }
  )
  assert.equal(result.source, 'hook')
  assert.deepEqual(result.refPoint, { x: 3136, y: 720 }, 'no nudge without a selection bottom')
})

test('non-Windows platforms leave hook coordinates untouched', () => {
  const toDip = createToDip()
  const result = resolveSelectionAnchor(
    { posLevel: 3, endBottom: PHYSICAL_ON_SECONDARY },
    { cursorPoint: DIP_ON_PRIMARY, isWin: false, toDip }
  )
  assert.equal(result.source, 'hook')
  assert.deepEqual(result.refPoint, { x: 4560, y: 904 })
  assert.equal(toDip.calls.length, 0)
})

test('a converted anchor stays on its own display, and the old double conversion does not', () => {
  const toDip = createToDip()

  const onPrimary = resolveSelectionAnchor(
    { posLevel: 3, endBottom: PHYSICAL_ON_PRIMARY },
    { cursorPoint: DIP_ON_PRIMARY, isWin: true, toDip }
  )
  assert.ok(inside(onPrimary.refPoint, dipRect(PRIMARY)))

  const onSecondary = resolveSelectionAnchor(
    { posLevel: 3, endBottom: PHYSICAL_ON_SECONDARY },
    { cursorPoint: DIP_ON_PRIMARY, isWin: true, toDip }
  )
  assert.ok(inside(onSecondary.refPoint, dipRect(SECONDARY)))

  // This is what the defect did: a DIP point on the secondary display resolves
  // into the primary's *physical* range, so it was scaled by the primary's 1.5
  // and dragged onto the other monitor. Locking it here keeps the fix honest.
  const doubleConverted = toDip(DIP_ON_SECONDARY)
  assert.ok(!inside(doubleConverted, dipRect(SECONDARY)), 'double conversion leaves the secondary')
  assert.ok(inside(doubleConverted, dipRect(PRIMARY)), 'and lands on the primary')
})
