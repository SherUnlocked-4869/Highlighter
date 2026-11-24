'use strict'

// A07 (docs/reviews/2026-11-24-windows-product-architecture-review.md): "多贴图按显示器
// 找回，拖放末端可吸附". Two pure pieces live here so the pin domain stays a thin
// Electron layer:
//
//   * computePinSnap() - the end-of-drag geometry. A dragged pin may snap at most
//     SNAP_DISTANCE DIP to the target work area or to a neighbouring pin's edges;
//     Alt (or an injected policy) skips the whole thing.
//   * displayLabel() / orderDisplays() / pickDisplayForBounds() - the tray grouping
//     names (resolution, scale, primary/secondary, negative origins) and a stable
//     display order, so a menu rebuilt twice lists the same screens in the same order.
//
// Seam rule (the risk called out by the review): the display that owns a window is
// the one whose BOUNDS contain the window CENTER. Electron's screen.getDisplayMatching
// returns the display with the largest intersection, which flips while a window
// straddles two screens - pointer jitter of one DIP would then move the pin between
// tray groups. The center does not move under a jitter, so ownership (and therefore
// snapping) stays put. getDisplayMatching remains the fallback for a center that is
// in no display at all (an unplugged screen, a gap between monitors).
//
// No Electron require: work areas and display objects arrive as plain data, which is
// what lets the 100%/150%, negative-coordinate and seam cases be unit-tested without
// a desktop. displayLabel is the only i18n touch point (the tray copy is three-language).

const { t } = require('./i18n-bootstrap')

// The review's acceptance number: 8 DIP, measured on the edge after the drag.
const DEFAULT_PIN_SNAP_DISTANCE = 8

function normalizeRect(rect) {
  if (!rect) return null
  const x = Number(rect.x)
  const y = Number(rect.y)
  const width = Number(rect.width)
  const height = Number(rect.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width <= 0 || height <= 0) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height))
  }
}

function pointInRect(point, rect) {
  if (!point || !rect) return false
  return point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
}

function intersectionArea(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

function rectCenter(bounds) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

function toRectList(values) {
  const list = Array.isArray(values) ? values : []
  const rects = []
  for (const value of list) {
    const rect = normalizeRect(value && value.bounds ? value.bounds : value)
    if (rect) rects.push(rect)
  }
  return rects
}

// The display index a window belongs to: its center wins, then the work area with the
// largest overlap, then the nearest center. Ties keep the earlier index so two calls
// with the same input can never disagree.
function resolveDisplayIndex(bounds, areas) {
  const center = rectCenter(bounds)
  for (let index = 0; index < areas.length; index += 1) {
    if (pointInRect(center, areas[index])) return index
  }
  let bestIndex = -1
  let bestArea = 0
  for (let index = 0; index < areas.length; index += 1) {
    const area = intersectionArea(bounds, areas[index])
    if (area > bestArea) {
      bestArea = area
      bestIndex = index
    }
  }
  if (bestIndex >= 0) return bestIndex
  let nearest = 0
  let nearestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < areas.length; index += 1) {
    const dx = areas[index].x + areas[index].width / 2 - center.x
    const dy = areas[index].y + areas[index].height / 2 - center.y
    const distance = Math.hypot(dx, dy)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = index
    }
  }
  return nearest
}

// One axis at a time: every candidate is an edge line (a work-area border or a
// neighbouring window's border) attached to either edge of the dragged window. A
// candidate is only legal when the resulting box still fits inside the target work
// area - that rule is what keeps a pin from snapping across a display seam to a
// neighbour that lives on the other screen. The winner is the smallest displacement
// ("优先位移最小的边"); ties prefer the work area over a window and the earlier
// neighbour, so repeated calls are stable.
function snapAxis(bounds, area, edges, maxDistance, axis) {
  const isX = axis === 'x'
  const size = isX ? bounds.width : bounds.height
  const origin = isX ? bounds.x : bounds.y
  const areaOrigin = isX ? area.x : area.y
  const areaSize = isX ? area.width : area.height
  // A window wider (taller) than the work area cannot be contained on this axis.
  // Leave it alone: snapping must never resize a pin - that would change its zoom.
  if (size > areaSize) return { delta: 0, snapped: false }

  const candidates = []
  const consider = (line, attachStart, rank) => {
    const delta = line - (attachStart ? origin : origin + size)
    if (!Number.isFinite(delta)) return
    if (Math.abs(delta) > maxDistance) return
    const nextOrigin = origin + delta
    if (nextOrigin < areaOrigin || nextOrigin + size > areaOrigin + areaSize) return
    candidates.push({ delta, rank, line })
  }
  // Every line is tried against BOTH edges of the dragged window: a pin left of a
  // neighbour aligns its right edge to that neighbour's left edge, one below it aligns
  // its bottom edge, and so on. The work-area pair is symmetric, so the extra
  // combination is rejected by the containment rule above.
  const considerLine = (line, rank) => {
    consider(line, true, rank)
    consider(line, false, rank)
  }
  considerLine(areaOrigin, 0)
  considerLine(areaOrigin + areaSize, 0)
  edges.forEach((edge, index) => {
    const edgeOrigin = isX ? edge.x : edge.y
    const edgeSize = isX ? edge.width : edge.height
    considerLine(edgeOrigin, 1 + index)
    considerLine(edgeOrigin + edgeSize, 1 + index)
  })
  if (!candidates.length) return { delta: 0, snapped: false }
  candidates.sort((a, b) => (
    Math.abs(a.delta) - Math.abs(b.delta) ||
    a.rank - b.rank ||
    a.line - b.line
  ))
  const best = candidates[0]
  return { delta: best.delta, snapped: best.delta !== 0 }
}

function computePinSnap({
  bounds,
  workAreas = [],
  windowEdges = [],
  snapDistance = DEFAULT_PIN_SNAP_DISTANCE,
  altKey = false,
  enabled = true
} = {}) {
  const rect = normalizeRect(bounds)
  if (!rect) {
    return {
      x: 0, y: 0, width: 0, height: 0,
      snapped: { x: false, y: false },
      displayIndex: -1,
      reason: 'invalid-bounds'
    }
  }
  const unchanged = (reason) => ({
    ...rect,
    snapped: { x: false, y: false },
    displayIndex: -1,
    reason
  })
  if (enabled === false) return unchanged('disabled')
  // Alt is the documented escape hatch: holding it at release keeps the exact drop
  // position, no matter how close an edge is.
  if (altKey === true) return unchanged('alt')

  const areas = toRectList(workAreas)
  if (!areas.length) return unchanged('no-work-area')
  const displayIndex = resolveDisplayIndex(rect, areas)
  const area = areas[displayIndex]
  const distance = Number(snapDistance)
  const maxDistance = Number.isFinite(distance) ? Math.max(0, distance) : DEFAULT_PIN_SNAP_DISTANCE
  const edges = toRectList(windowEdges)

  const horizontal = snapAxis(rect, area, edges, maxDistance, 'x')
  const vertical = snapAxis(rect, area, edges, maxDistance, 'y')
  const next = {
    x: rect.x + horizontal.delta,
    y: rect.y + vertical.delta,
    width: rect.width,
    height: rect.height
  }
  const snapped = { x: horizontal.snapped, y: vertical.snapped }
  return {
    ...next,
    snapped,
    displayIndex,
    reason: snapped.x || snapped.y ? 'snapped' : 'none'
  }
}

function displayBounds(display) {
  return normalizeRect(display && (display.bounds || display.workArea)) || null
}

function displayX(display) {
  const bounds = displayBounds(display)
  return bounds ? bounds.x : 0
}

function displayY(display) {
  const bounds = displayBounds(display)
  return bounds ? bounds.y : 0
}

function sameDisplay(a, b) {
  if (!a || !b) return false
  if (a.id !== undefined && a.id !== null && b.id !== undefined && b.id !== null) return a.id === b.id
  const left = displayBounds(a)
  const right = displayBounds(b)
  if (!left || !right) return false
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

// Primary first, then left-to-right, then top-to-bottom. Monitors on negative
// coordinates sort before the primary one unless they ARE the primary screen, which
// is the only thing a user can actually recognise in the tray.
function orderDisplays(displays, primary = null) {
  const list = (Array.isArray(displays) ? displays : []).filter((display) => displayBounds(display))
  return [...list].sort((a, b) => {
    const aPrimary = primary ? (sameDisplay(a, primary) ? 0 : 1) : 0
    const bPrimary = primary ? (sameDisplay(b, primary) ? 0 : 1) : 0
    if (aPrimary !== bPrimary) return aPrimary - bPrimary
    const ax = displayX(a)
    const bx = displayX(b)
    if (ax !== bx) return ax - bx
    const ay = displayY(a)
    const by = displayY(b)
    if (ay !== by) return ay - by
    const aid = Number(a.id)
    const bid = Number(b.id)
    if (Number.isFinite(aid) && Number.isFinite(bid) && aid !== bid) return aid - bid
    return 0
  })
}

function displayKey(display) {
  if (!display) return 'display:unknown'
  if (display.id !== undefined && display.id !== null) return `display:${display.id}`
  const bounds = displayBounds(display)
  if (!bounds) return 'display:unknown'
  return `display:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
}

// The seam rule in one place: the center's display beats Electron's largest-
// intersection match, and the match is the fallback when the center is in no display
// (a monitor was unplugged, or the point sits in a gap between screens).
function pickDisplayForBounds(bounds, displays, matched = null) {
  const list = (Array.isArray(displays) ? displays : []).filter((display) => displayBounds(display))
  const rect = normalizeRect(bounds)
  const matchedKnown = matched
    ? (list.find((display) => sameDisplay(display, matched)) || matched)
    : null
  if (!rect) return matchedKnown || list[0] || null
  const center = rectCenter(rect)
  const owner = list.find((display) => pointInRect(center, displayBounds(display))) || null
  return owner || matchedKnown || list[0] || null
}

// Tray group name: ordinal, resolution, scale, primary/secondary and the origin.
// The origin is what tells two same-resolution screens apart, and negative numbers
// are printed verbatim (a left-hand or above-primary monitor has a negative x/y).
function displayLabel(display, index = 0) {
  const bounds = displayBounds(display) || { x: 0, y: 0, width: 0, height: 0 }
  const size = display && display.size && Number(display.size.width) > 0 && Number(display.size.height) > 0
    ? display.size
    : bounds
  const ordinal = Number.isFinite(Number(index)) ? Math.max(0, Math.floor(Number(index))) : 0
  const width = Math.max(0, Math.round(Number(size.width) || 0))
  const height = Math.max(0, Math.round(Number(size.height) || 0))
  const scaleFactor = Number(display && display.scaleFactor)
  const scale = Math.round((Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1) * 100)
  // orderDisplays() puts the primary display first, so "index 0" is a safe default
  // when the caller has no explicit flag; an explicit primary:false always wins.
  const primary = display && display.primary !== undefined ? display.primary === true : ordinal === 0
  return t('main.tray.pin-display-label', {
    index: ordinal + 1,
    width,
    height,
    scale,
    role: primary ? t('main.tray.pin-display-primary') : t('main.tray.pin-display-secondary'),
    x: Math.round(Number(bounds.x) || 0),
    y: Math.round(Number(bounds.y) || 0)
  })
}

module.exports = {
  DEFAULT_PIN_SNAP_DISTANCE,
  normalizeRect,
  pointInRect,
  computePinSnap,
  sameDisplay,
  orderDisplays,
  displayKey,
  pickDisplayForBounds,
  displayLabel
}
