'use strict'

// Where the selection toolbar should be anchored.
//
// The selection hook reports screen (physical) pixels — its own docs say so, and
// on Windows `screen.screenToDipPoint()` is the documented conversion. Electron's
// `screen.getCursorScreenPoint()` already speaks DIP. Both used to flow into one
// variable and get converted together, which scaled a DIP point a second time:
// invisible at 100%, a third of the screen off at 150%, and on a mixed-DPI setup
// it can resolve to the wrong display entirely. The two sources are therefore
// kept apart here and only the hook's point is converted.

const HOOK_OFFSETS = Object.freeze({ mouseSingle: 16, selectionBottom: 4 })

function validCoord(point) {
  return Boolean(point) && point.x > -90000 && point.x < 90000 && point.y > -90000 && point.y < 90000
}

// '' means "no usable geometry": the caller keeps whatever it already had.
function orientationFor(startBottom, endBottom, { deadZone = 0 } = {}) {
  if (!validCoord(startBottom) || !validCoord(endBottom)) return ''
  const delta = endBottom.y - startBottom.y
  if (delta > deadZone) return 'bottomLeft'
  if (delta < -deadZone) return 'topRight'
  return 'bottomRight'
}

/**
 * Resolves the toolbar anchor in DIP space.
 *
 * @param {object} event selection payload from the hook
 * @param {{ cursorPoint: {x:number,y:number}, isWin?: boolean, toDip?: Function }} deps
 * @returns {{ refPoint: {x:number,y:number}, orientation: string, source: 'hook'|'cursor', physical?: {x:number,y:number} }}
 *   `source: 'hook'` means the point came from the hook and was converted;
 *   `source: 'cursor'` means it fell back to the pointer and was left untouched.
 */
function resolveSelectionAnchor(event = {}, { cursorPoint, isWin = false, toDip } = {}) {
  const cursor = { x: Number(cursorPoint?.x) || 0, y: Number(cursorPoint?.y) || 0 }
  const level = Number(event?.posLevel) || 0
  let anchor = null
  let orientation = 'bottomMiddle'
  let offsetDip = 0

  if (level === 1) {
    if (validCoord(event.mousePosEnd)) {
      anchor = event.mousePosEnd
      offsetDip = HOOK_OFFSETS.mouseSingle
    }
  } else if (level === 2) {
    if (validCoord(event.mousePosEnd)) anchor = event.mousePosEnd
    const next = orientationFor(event.startBottom, event.endBottom, { deadZone: 10 })
    if (next) orientation = next
  } else if (level > 2) {
    if (validCoord(event.endBottom)) {
      anchor = event.endBottom
      offsetDip = HOOK_OFFSETS.selectionBottom
    } else if (validCoord(event.mousePosEnd)) {
      anchor = event.mousePosEnd
    }
    const next = orientationFor(event.startBottom, event.endBottom, { deadZone: 0 })
    if (next) orientation = next
  }

  if (!anchor) return { refPoint: cursor, orientation, source: 'cursor' }

  const physical = { x: anchor.x, y: anchor.y }
  const dip = isWin && typeof toDip === 'function' ? toDip(physical) : physical
  return {
    refPoint: { x: Number(dip?.x) || 0, y: (Number(dip?.y) || 0) + offsetDip },
    orientation,
    source: 'hook',
    physical
  }
}

module.exports = {
  HOOK_OFFSETS,
  orientationFor,
  resolveSelectionAnchor,
  validCoord
}
