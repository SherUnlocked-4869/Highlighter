'use strict'

const PIN_ZOOM_MIN = 0.2
const PIN_ZOOM_MAX = 3
const PIN_OPACITY_MIN = 0.25
const PIN_OPACITY_MAX = 1
const MIN_SCALE_FACTOR = 0.25

function clampPinZoom(value) {
  return Math.max(PIN_ZOOM_MIN, Math.min(PIN_ZOOM_MAX, Number(value) || 1))
}

function applyPinZoomFactor(currentZoom, factor) {
  const next = (Number(currentZoom) || 1) * (Number(factor) || 1)
  return clampPinZoom(next)
}

function clampPinOpacity(value) {
  return Math.max(PIN_OPACITY_MIN, Math.min(PIN_OPACITY_MAX, Number(value) || 1))
}

function getPixelAlignedPinSize(pixelWidth, pixelHeight, display, preferredSize = null) {
  const scaleFactor = Math.max(MIN_SCALE_FACTOR, Number(display?.scaleFactor) || 1)
  const preferredWidth = Number(preferredSize?.width)
  const preferredHeight = Number(preferredSize?.height)
  return {
    width: Number.isFinite(preferredWidth) && preferredWidth > 0
      ? preferredWidth
      : Math.max(1, Number(pixelWidth) / scaleFactor),
    height: Number.isFinite(preferredHeight) && preferredHeight > 0
      ? preferredHeight
      : Math.max(1, Number(pixelHeight) / scaleFactor),
    scaleFactor
  }
}

function normalizeSelectionBounds(selectionBounds) {
  if (!selectionBounds) return null
  return {
    x: Math.round(Number(selectionBounds.x) || 0),
    y: Math.round(Number(selectionBounds.y) || 0),
    width: Math.max(1, Math.round(Number(selectionBounds.width) || 0)),
    height: Math.max(1, Math.round(Number(selectionBounds.height) || 0))
  }
}

// Rotation is quarter-turn only (D5: the rotation feature previews with a CSS
// transform in the renderer, it never re-encodes _pinData.dataUrl). Any input is
// snapped to the nearest 90 degrees and wrapped into [0, 360); non-numeric input
// falls back to 0 so a stale/hostile setting cannot produce a NaN transform.
function normalizePinRotation(value) {
  const degrees = Number(value)
  if (!Number.isFinite(degrees)) return 0
  return ((Math.round(degrees / 90) * 90 % 360) + 360) % 360
}

// A CSS transform does not resize its container, so the host window must be told
// the rotated bounding box explicitly. Quarter turns swap the axes; everything
// else keeps the original box. Inputs are clamped the same way as the other
// window-sizing helpers (never below 1px).
function getRotatedPinSize(width, height, rotation) {
  const normalized = normalizePinRotation(rotation)
  const baseWidth = Math.max(1, Math.round(Number(width) || 0))
  const baseHeight = Math.max(1, Math.round(Number(height) || 0))
  const swapped = normalized === 90 || normalized === 270
  return {
    width: swapped ? baseHeight : baseWidth,
    height: swapped ? baseWidth : baseHeight,
    rotation: normalized
  }
}

// Once a pin ignores mouse events, forwarded mouse *moves* are the only pointer
// signal it still receives (setIgnoreMouseEvents(true, { forward: true }) does
// not forward clicks or the wheel), so the reserved corner badge is detected by
// a rectangle hit test rather than by a click. `padding` grows the target area
// in CSS pixels so a small badge stays reachable. Rects drawn from any corner
// work (negative width/height are normalised); a missing or non-finite point or
// rect is never a hit.
function hitTestPinHotspot(point, hotspot, padding = 0) {
  const x = Number(point?.x)
  const y = Number(point?.y)
  const left = Number(hotspot?.x)
  const top = Number(hotspot?.y)
  const width = Number(hotspot?.width)
  const height = Number(hotspot?.height)
  if (![x, y, left, top, width, height].every(Number.isFinite)) return false
  const pad = Math.max(0, Number(padding) || 0)
  return x >= Math.min(left, left + width) - pad &&
    x <= Math.max(left, left + width) + pad &&
    y >= Math.min(top, top + height) - pad &&
    y <= Math.max(top, top + height) + pad
}

function computePinDisplaySize({ baseWidth, baseHeight, zoom, longCapture, workAreaHeight }) {
  const z = clampPinZoom(zoom)
  const width = Math.max(1, Math.round(Number(baseWidth) * z))
  const fullHeight = Math.max(1, Math.round(Number(baseHeight) * z))
  const height = longCapture && Number.isFinite(Number(workAreaHeight))
    ? Math.min(Math.round(Number(workAreaHeight) * 0.55), fullHeight)
    : fullHeight
  return { width, height, zoom: z }
}

module.exports = {
  PIN_ZOOM_MIN,
  PIN_ZOOM_MAX,
  PIN_OPACITY_MIN,
  PIN_OPACITY_MAX,
  MIN_SCALE_FACTOR,
  clampPinZoom,
  applyPinZoomFactor,
  clampPinOpacity,
  getPixelAlignedPinSize,
  normalizeSelectionBounds,
  getRotatedPinSize,
  normalizePinRotation,
  hitTestPinHotspot,
  computePinDisplaySize
}
