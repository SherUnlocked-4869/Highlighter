'use strict'

const PIN_ZOOM_MIN = 0.2
const PIN_ZOOM_MAX = 3
// settings.pinned.zoomStep (product decision: one wheel notch = 10% by default).
// settings-normalize.js clamps the stored value, but a store written by an older
// build (or a unit-test fake) may omit the key, so the pin domain routes it
// through normalizePinZoomStep as well.
const DEFAULT_PIN_ZOOM_STEP = 0.1
const PIN_ZOOM_STEP_MIN = 0.05
const PIN_ZOOM_STEP_MAX = 0.5
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

// One wheel notch scales by 1 + step (10% by default). Mirrors
// settings-normalize.normalizePinZoomStep so the pin domain still behaves when a
// caller hands it raw settings (unit-test fakes) or a store written before the
// key existed: non-finite/non-positive falls back to the default, everything
// else is clamped into the product range.
function normalizePinZoomStep(value) {
  const step = Number(value)
  if (!Number.isFinite(step) || step <= 0) return DEFAULT_PIN_ZOOM_STEP
  return Math.min(PIN_ZOOM_STEP_MAX, Math.max(PIN_ZOOM_STEP_MIN, Math.round(step * 100) / 100))
}

// One Ctrl+wheel notch changes opacity by 5 percentage points (0.05), the step
// the context menu's 25/50/75/100 radio items already imply. The wheel handler in
// pin/pin.js sends a direction (+1 wheel-up / -1 wheel-down); the clamp keeps the
// value inside the product range even after many notches.
function nextPinOpacity(current, direction, step = 0.05) {
  const delta = Math.max(0.01, Number(step) || 0.05) * (Number(direction) < 0 ? -1 : 1)
  return clampPinOpacity((Number(current) || 1) + delta)
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

// Display reflow (P0, plan §9.2-①): after a monitor is unplugged or its metrics
// change, a pin can sit on coordinates that no longer exist. The domain clamps
// the window box into the matched display's work area; a box that does not
// intersect any work area at all is treated as "its display vanished" and is
// re-centred on the primary display instead. This helper is the pure half.
function clampPinBoundsToWorkArea(bounds, workArea) {
  const area = workArea && Number.isFinite(Number(workArea.width)) && Number(workArea.width) > 0
    ? workArea
    : bounds
  const areaX = Math.round(Number(area?.x) || 0)
  const areaY = Math.round(Number(area?.y) || 0)
  const areaWidth = Math.max(1, Math.round(Number(area?.width) || 1))
  const areaHeight = Math.max(1, Math.round(Number(area?.height) || 1))
  const width = Math.max(1, Math.min(Math.round(Number(bounds?.width) || 1), areaWidth))
  const height = Math.max(1, Math.min(Math.round(Number(bounds?.height) || 1), areaHeight))
  return {
    x: Math.round(Math.max(areaX, Math.min(Number(bounds?.x) || 0, areaX + areaWidth - width))),
    y: Math.round(Math.max(areaY, Math.min(Number(bounds?.y) || 0, areaY + areaHeight - height))),
    width,
    height
  }
}

function boundsIntersectWorkArea(bounds, workArea) {
  const left = Number(bounds?.x)
  const top = Number(bounds?.y)
  const width = Number(bounds?.width)
  const height = Number(bounds?.height)
  const areaLeft = Number(workArea?.x)
  const areaTop = Number(workArea?.y)
  const areaWidth = Number(workArea?.width)
  const areaHeight = Number(workArea?.height)
  if (![left, top, width, height, areaLeft, areaTop, areaWidth, areaHeight].every(Number.isFinite)) return false
  return left < areaLeft + areaWidth &&
    left + width > areaLeft &&
    top < areaTop + areaHeight &&
    top + height > areaTop
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
  DEFAULT_PIN_ZOOM_STEP,
  PIN_ZOOM_STEP_MIN,
  PIN_ZOOM_STEP_MAX,
  PIN_OPACITY_MIN,
  PIN_OPACITY_MAX,
  MIN_SCALE_FACTOR,
  clampPinZoom,
  applyPinZoomFactor,
  clampPinOpacity,
  normalizePinZoomStep,
  nextPinOpacity,
  getPixelAlignedPinSize,
  normalizeSelectionBounds,
  getRotatedPinSize,
  normalizePinRotation,
  clampPinBoundsToWorkArea,
  boundsIntersectWorkArea,
  hitTestPinHotspot,
  computePinDisplaySize
}
