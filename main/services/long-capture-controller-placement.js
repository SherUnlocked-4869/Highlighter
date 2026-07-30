const DEFAULT_WIDTH = 420
const DEFAULT_HEIGHT = 570
const MIN_WIDTH = 320
const MIN_HEIGHT = 440
const GAP = 10

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeRect(rect = {}) {
  return {
    x: Math.round(finite(rect.x)),
    y: Math.round(finite(rect.y)),
    width: Math.max(1, Math.round(finite(rect.width, 1))),
    height: Math.max(1, Math.round(finite(rect.height, 1)))
  }
}

function intersects(left, right) {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
}

function calculateLongCaptureControllerPlacement(display, selectionBounds, options = {}) {
  const area = normalizeRect(display?.workArea || display?.bounds)
  const selection = normalizeRect(selectionBounds)
  const preferredWidth = Math.max(MIN_WIDTH, Math.round(finite(options.width, DEFAULT_WIDTH)))
  const preferredHeight = Math.max(MIN_HEIGHT, Math.round(finite(options.height, DEFAULT_HEIGHT)))
  const maximumWidth = Math.max(1, area.width - GAP * 2)
  const maximumHeight = Math.max(1, area.height - GAP * 2)
  const baseWidth = Math.min(preferredWidth, maximumWidth)
  const baseHeight = Math.min(preferredHeight, maximumHeight)
  const areaRight = area.x + area.width
  const areaBottom = area.y + area.height
  const selectionRight = selection.x + selection.width
  const selectionBottom = selection.y + selection.height

  const rightWidth = areaRight - selectionRight - GAP
  if (rightWidth >= Math.min(MIN_WIDTH, maximumWidth)) {
    const bounds = {
      x: selectionRight + GAP,
      y: Math.max(area.y + GAP, Math.min(selection.y, areaBottom - baseHeight - GAP)),
      width: Math.min(baseWidth, rightWidth),
      height: baseHeight
    }
    return { bounds, overlapsSelection: false, side: 'right' }
  }

  const leftWidth = selection.x - area.x - GAP
  if (leftWidth >= Math.min(MIN_WIDTH, maximumWidth)) {
    const width = Math.min(baseWidth, leftWidth)
    const bounds = {
      x: selection.x - width - GAP,
      y: Math.max(area.y + GAP, Math.min(selection.y, areaBottom - baseHeight - GAP)),
      width,
      height: baseHeight
    }
    return { bounds, overlapsSelection: false, side: 'left' }
  }

  const belowHeight = areaBottom - selectionBottom - GAP
  if (belowHeight >= Math.min(MIN_HEIGHT, maximumHeight)) {
    const height = Math.min(baseHeight, belowHeight)
    const bounds = {
      x: Math.max(area.x + GAP, Math.min(selection.x, areaRight - baseWidth - GAP)),
      y: selectionBottom + GAP,
      width: baseWidth,
      height
    }
    return { bounds, overlapsSelection: false, side: 'bottom' }
  }

  const aboveHeight = selection.y - area.y - GAP
  if (aboveHeight >= Math.min(MIN_HEIGHT, maximumHeight)) {
    const height = Math.min(baseHeight, aboveHeight)
    const bounds = {
      x: Math.max(area.x + GAP, Math.min(selection.x, areaRight - baseWidth - GAP)),
      y: selection.y - height - GAP,
      width: baseWidth,
      height
    }
    return { bounds, overlapsSelection: false, side: 'top' }
  }

  const bounds = {
    x: Math.max(area.x + GAP, areaRight - baseWidth - GAP),
    y: Math.max(area.y + GAP, areaBottom - baseHeight - GAP),
    width: baseWidth,
    height: baseHeight
  }
  return {
    bounds,
    overlapsSelection: intersects(bounds, selection),
    side: 'fallback'
  }
}

module.exports = {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  GAP,
  MIN_HEIGHT,
  MIN_WIDTH,
  calculateLongCaptureControllerPlacement,
  intersects,
  normalizeRect
}
