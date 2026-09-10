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
  computePinDisplaySize
}
