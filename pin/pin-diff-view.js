'use strict'

// N05 / DEV-08 — renderer-side display math for the opt-in "real pixel compare" mode.
//
// The main process samples the real screen pixels UNDER the pin (the pin window itself is
// excluded with content protection) and sends one bounded RGBA frame per second. This
// module turns that frame into something drawable without a DOM:
//
//   1. a bounded comparison grid: a 4K capture is down-sampled by an integer step so the
//      overlay bitmap can never exceed MAX_DIFF_PIXELS (memory bound);
//   2. the changed-pixel mask: a red translucent RGBA bitmap plus the changed ratio and
//      the bounding box of the differences (the badge copy and the evidence);
//   3. the CSS placement: the capture rectangle in the pin window's CSS pixels, derived
//      from the DIP rect the main process reports, so a clamped capture on a multi-monitor
//      edge still lands on the right pixels.
//
// UMD: the pin window loads it as a classic script; node:test requires it. No DOM access
// at require time, and `paintDiffMask` accepts any object with putImageData so node can
// record the call.
;(function exposePinDiffView(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.pinDiffView = api
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, () => {
  const MAX_DIFF_PIXELS = 1000000
  const DEFAULT_TOLERANCE = 12
  const MASK_COLOR = Object.freeze({ r: 225, g: 29, b: 72 })
  const MASK_MIN_ALPHA = 96
  const MASK_MAX_ALPHA = 224
  // Below this share of changed pixels the badge says "no change": a handful of noisy
  // pixels across a big image is not a meaningful design difference.
  const CHANGED_RATIO_EPSILON = 0.0005

  function finiteOr(value, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  function normalizeSize(value) {
    const source = value && typeof value === 'object' ? value : {}
    return {
      width: Math.max(0, Math.round(finiteOr(source.width ?? source.w, 0))),
      height: Math.max(0, Math.round(finiteOr(source.height ?? source.h, 0)))
    }
  }

  function normalizeRect(value) {
    if (!value || typeof value !== 'object') return null
    const rect = {
      x: finiteOr(value.x, Number.NaN),
      y: finiteOr(value.y, Number.NaN),
      width: Math.max(0, finiteOr(value.width ?? value.w, Number.NaN)),
      height: Math.max(0, finiteOr(value.height ?? value.h, Number.NaN))
    }
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null
    if (!(rect.width > 0) || !(rect.height > 0)) return null
    return rect
  }

  // Comparison-grid plan. `capture` is the physical frame from main; `dipRect` is where
  // that frame sits in DIP screen coordinates; `windowOrigin` is the pin window's DIP
  // origin (renderer's screenX/screenY) so the CSS placement is window-relative.
  function planDiffOverlay(input = {}) {
    const source = input && typeof input === 'object' ? input : {}
    const capture = normalizeSize(source.capture)
    const dipRect = normalizeRect(source.dipRect)
    const devicePixelRatio = clamp(finiteOr(source.devicePixelRatio, 1), 0.5, 4)
    const maxPixels = clamp(finiteOr(source.maxPixels, MAX_DIFF_PIXELS), 16, MAX_DIFF_PIXELS)
    if (!capture.width || !capture.height) return { ok: false, code: 'EMPTY_CAPTURE' }
    if (!dipRect) return { ok: false, code: 'NO_DIP_RECT' }
    const pixels = capture.width * capture.height
    // One integer step for both axes keeps the pixel grid square (no aspect distortion).
    const step = Math.max(1, Math.ceil(Math.sqrt(pixels / maxPixels)))
    const width = Math.max(1, Math.floor(capture.width / step))
    const height = Math.max(1, Math.floor(capture.height / step))
    const windowOrigin = source.windowOrigin && typeof source.windowOrigin === 'object'
      ? { x: finiteOr(source.windowOrigin.x, 0), y: finiteOr(source.windowOrigin.y, 0) }
      : { x: 0, y: 0 }
    return {
      ok: true,
      capture,
      dipRect,
      devicePixelRatio,
      step,
      width,
      height,
      maskBytes: width * height * 4,
      // CSS placement inside the pin window. The main process reports the capture in
      // screen DIP coordinates; subtracting the window origin is the whole conversion.
      cssRect: {
        left: dipRect.x - windowOrigin.x,
        top: dipRect.y - windowOrigin.y,
        width: dipRect.width,
        height: dipRect.height
      }
    }
  }

  // Compare one captured frame against the pin's rendered current view. A size mismatch
  // means the two do not describe the same physical pixels - that is "alignment not
  // proven", answered with an explicit code instead of resampling the evidence.
  function buildDiffMask(capturePixels, viewPixels, plan, options = {}) {
    const settings = options && typeof options === 'object' ? options : {}
    if (!plan || plan.ok !== true) return { ok: false, code: 'INVALID_PLAN' }
    const width = plan.capture.width
    const height = plan.capture.height
    const expected = width * height * 4
    if (!capturePixels || capturePixels.length !== expected) return { ok: false, code: 'CAPTURE_SIZE_MISMATCH' }
    if (!viewPixels || viewPixels.length !== expected) return { ok: false, code: 'VIEW_SIZE_MISMATCH' }
    const tolerance = clamp(Math.round(finiteOr(settings.tolerance, DEFAULT_TOLERANCE)), 0, 255)
    const step = plan.step
    const gridWidth = plan.width
    const gridHeight = plan.height
    const mask = new Uint8ClampedArray(gridWidth * gridHeight * 4)
    let different = 0
    let maxDelta = 0
    let minX = gridWidth
    let minY = gridHeight
    let maxX = -1
    let maxY = -1
    for (let gridY = 0; gridY < gridHeight; gridY += 1) {
      const sourceY = Math.min(height - 1, gridY * step)
      for (let gridX = 0; gridX < gridWidth; gridX += 1) {
        const sourceX = Math.min(width - 1, gridX * step)
        const offset = (sourceY * width + sourceX) * 4
        const delta = Math.max(
          Math.abs(capturePixels[offset] - viewPixels[offset]),
          Math.abs(capturePixels[offset + 1] - viewPixels[offset + 1]),
          Math.abs(capturePixels[offset + 2] - viewPixels[offset + 2])
        )
        if (delta > maxDelta) maxDelta = delta
        if (delta <= tolerance) continue
        different += 1
        const gridIndex = (gridY * gridWidth + gridX) * 4
        const alpha = clamp(Math.round(MASK_MIN_ALPHA + (delta / 255) * (MASK_MAX_ALPHA - MASK_MIN_ALPHA)), MASK_MIN_ALPHA, MASK_MAX_ALPHA)
        mask[gridIndex] = MASK_COLOR.r
        mask[gridIndex + 1] = MASK_COLOR.g
        mask[gridIndex + 2] = MASK_COLOR.b
        mask[gridIndex + 3] = alpha
        if (gridX < minX) minX = gridX
        if (gridY < minY) minY = gridY
        if (gridX > maxX) maxX = gridX
        if (gridY > maxY) maxY = gridY
      }
    }
    const compared = gridWidth * gridHeight
    return {
      ok: true,
      width: gridWidth,
      height: gridHeight,
      step,
      compared,
      different,
      ratio: compared ? different / compared : 0,
      tolerance,
      maxDelta,
      // Grid coordinates scaled back to CAPTURE pixels: the evidence names real pixels.
      bounds: maxX >= 0
        ? {
            x: minX * step,
            y: minY * step,
            width: (maxX - minX + 1) * step,
            height: (maxY - minY + 1) * step
          }
        : null,
      mask
    }
  }

  // Put the mask on the overlay canvas. Accepts any 2D context with putImageData; the
  // node tests pass a recorder, the renderer passes the real context.
  function paintDiffMask(context, diff) {
    if (!context || typeof context.putImageData !== 'function' || !diff || diff.ok !== true) return false
    const ImageDataSource = typeof ImageData === 'function' ? ImageData : null
    if (!ImageDataSource) return false
    try {
      context.putImageData(new ImageDataSource(diff.mask, diff.width, diff.height), 0, 0)
      return true
    } catch (error) {
      return false
    }
  }

  // Badge copy as locale key + params (visible text always comes from the locale table).
  function diffBadge(diff) {
    if (!diff || diff.ok !== true) {
      return { key: 'pin.onion.real-diff.unavailable', params: { code: (diff && diff.code) || 'failed' } }
    }
    if (diff.ratio < CHANGED_RATIO_EPSILON) return { key: 'pin.onion.real-diff.no-change', params: null }
    return {
      key: 'pin.onion.real-diff.changed',
      params: { ratio: Math.min(100, Math.max(0.1, diff.ratio * 100)).toFixed(1) }
    }
  }

  return {
    MAX_DIFF_PIXELS,
    DEFAULT_TOLERANCE,
    MASK_COLOR,
    CHANGED_RATIO_EPSILON,
    planDiffOverlay,
    buildDiffMask,
    paintDiffMask,
    diffBadge
  }
})
