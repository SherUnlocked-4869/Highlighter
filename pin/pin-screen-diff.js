'use strict'

// N05 / DEV-08 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md):
// real screen pixels under a pin, measured and ADOPTED 2026-11-28.
//
// Evidence: docs/plans/2026-11-28-dev08-screen-diff-measurement.md plus the reproducible
// probe in scripts/probe-pin-screen-diff.js. On the target Windows host a window with
// content protection enabled stays visible on screen but is absent from desktopCapturer
// frames (0/30 protected frames contained its colour; ~0.986 with protection off),
// including two stacked pins and a display with a negative DIP origin. Flash and
// difference remain the defaults; the product exposes this as an explicit per-pin opt-in
// in the context menu ("real pixel compare"), and the side effect (that pin is excluded
// from screenshots/recordings while the mode runs) is stated there.
//
// This module is the side-effect-free planning/measurement seam shared by the product and
// the probe:
//   * DIP -> display-local PHYSICAL capture rectangle (multi-screen, mixed DPI, rotation,
//     negative coordinates, edge clamping, pixel budget);
//   * desktopCapturer source choice by display_id with a bounded fallback;
//   * BGRA -> RGBA normalisation for nativeImage.toBitmap();
//   * RGBA diff + nearest-neighbour resampling for alignment checks;
//   * a bounded 1 Hz / one-in-flight / failure-capped sampler;
//   * the adoption gate (measured exclusion + alignment + budget + rate).
//
// The product session lives in main/domains/pin/index.js (startRealPixelCompare); the
// renderer display math lives in pin/pin-diff-view.js.

;(function exposePinScreenDiff(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.pinScreenDiff = api
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, () => {
  const MIN_INTERVAL_MS = 1000
  const MAX_INFLIGHT = 1
  const MAX_CAPTURE_PIXELS = 16000000
  const MAX_CAPTURE_BYTES = MAX_CAPTURE_PIXELS * 4
  const MAX_CONSECUTIVE_FAILURES = 3
  const DEFAULT_DIFF_TOLERANCE = 8
  // Colour channels are compared per channel; below this delta a pixel counts as equal
  // (screen capture re-encodes and window compositing may round a channel by 1-2).
  const SELF_CAPTURE_MAX_RATIO = 0.02
  const ALIGNMENT_TOLERANCE_RATIO = 0.05
  const MIN_PROBE_SAMPLES = 3

  function finiteOr(value, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  function normalizeRotation(value) {
    const snapped = ((Math.round(finiteOr(value, 0) / 90) * 90) % 360 + 360) % 360
    return snapped === 0 || snapped === 90 || snapped === 180 || snapped === 270 ? snapped : 0
  }

  function normalizeRect(value) {
    if (!value || typeof value !== 'object') return null
    const rect = {
      x: finiteOr(value.x, Number.NaN),
      y: finiteOr(value.y, Number.NaN),
      width: finiteOr(value.width ?? value.w, Number.NaN),
      height: finiteOr(value.height ?? value.h, Number.NaN)
    }
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null
    if (!(rect.width > 0) || !(rect.height > 0)) return null
    return rect
  }

  function normalizeDisplays(displays) {
    const list = Array.isArray(displays) ? displays : []
    const normalized = []
    for (const display of list) {
      const bounds = normalizeRect(display?.bounds)
      if (!bounds) continue
      normalized.push({
        id: display.id ?? null,
        bounds,
        workArea: normalizeRect(display.workArea) || bounds,
        scaleFactor: Math.max(0.25, finiteOr(display.scaleFactor, 1))
      })
    }
    return normalized
  }

  function pickDisplay(displays, bounds) {
    const list = Array.isArray(displays) ? displays : []
    if (!list.length) return null
    if (!bounds) return list[0]
    let best = null
    let bestArea = 0
    for (const display of list) {
      const left = Math.max(bounds.x, display.bounds.x)
      const top = Math.max(bounds.y, display.bounds.y)
      const right = Math.min(bounds.x + bounds.width, display.bounds.x + display.bounds.width)
      const bottom = Math.min(bounds.y + bounds.height, display.bounds.y + display.bounds.height)
      const area = Math.max(0, right - left) * Math.max(0, bottom - top)
      if (area > bestArea) {
        bestArea = area
        best = display
      }
    }
    return best || list[0]
  }

  // DIP image box on screen -> display-local physical capture rectangle.
  //
  // `imageBounds` is the renderer's image rectangle inside the pin window (DIP); the
  // pin window origin plus that offset is the on-screen image box. Note the box is the
  // ROTATED bounding box, which is exactly the screen region the picture covers.
  function planScreenCapture(input = {}) {
    const source = input && typeof input === 'object' ? input : {}
    const pinBounds = normalizeRect(source.pinBounds)
    if (!pinBounds) return { ok: false, code: 'INVALID_PIN_BOUNDS' }
    const imageBounds = normalizeRect(source.imageBounds) || { x: 0, y: 0, width: pinBounds.width, height: pinBounds.height }
    const imageBox = {
      x: pinBounds.x + imageBounds.x,
      y: pinBounds.y + imageBounds.y,
      width: imageBounds.width,
      height: imageBounds.height
    }
    const displays = normalizeDisplays(source.displays)
    const display = pickDisplay(displays, imageBox)
    if (!display) return { ok: false, code: 'NO_DISPLAY' }
    // Intersect with the display: a pin hanging over an edge is captured only where it
    // is actually visible, so the caller never reads pixels that do not exist.
    const left = Math.max(imageBox.x, display.bounds.x)
    const top = Math.max(imageBox.y, display.bounds.y)
    const right = Math.min(imageBox.x + imageBox.width, display.bounds.x + display.bounds.width)
    const bottom = Math.min(imageBox.y + imageBox.height, display.bounds.y + display.bounds.height)
    if (right - left < 1 || bottom - top < 1) return { ok: false, code: 'OUTSIDE_DISPLAY' }
    const scaleFactor = display.scaleFactor
    const physicalRect = {
      x: Math.round((left - display.bounds.x) * scaleFactor),
      y: Math.round((top - display.bounds.y) * scaleFactor),
      width: Math.max(1, Math.round((right - left) * scaleFactor)),
      height: Math.max(1, Math.round((bottom - top) * scaleFactor))
    }
    const maxPixels = clamp(finiteOr(source.maxPixels, MAX_CAPTURE_PIXELS), 1, MAX_CAPTURE_PIXELS)
    if (physicalRect.width * physicalRect.height > maxPixels) {
      return { ok: false, code: 'TOO_MANY_PIXELS', width: physicalRect.width, height: physicalRect.height, maxPixels }
    }
    return {
      ok: true,
      display,
      rotation: normalizeRotation(source.rotation),
      imageBox,
      dipRect: { x: left, y: top, width: right - left, height: bottom - top },
      physicalRect,
      scaleFactor,
      // The capture thumbnail is requested at the display's physical size; cropping this
      // rectangle out of it keeps desktopCapturer from doing a second, lossy resize.
      thumbnail: {
        width: Math.max(1, Math.round(display.bounds.width * scaleFactor)),
        height: Math.max(1, Math.round(display.bounds.height * scaleFactor))
      },
      bytes: physicalRect.width * physicalRect.height * 4
    }
  }

  // Nearest-neighbour RGBA sampling, used only to put two frames of different physical
  // sizes into the same comparison grid. Deliberately never used for the diff output:
  // the experiment rejects frames whose size cannot be compared 1:1 as "alignment
  // unproven" instead of hiding the mismatch behind interpolation.
  function resampleRgba(pixels, width, height, targetWidth, targetHeight) {
    if (!pixels || width <= 0 || height <= 0 || targetWidth <= 0 || targetHeight <= 0) return null
    const source = pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray
      ? pixels
      : new Uint8Array(pixels)
    const target = new Uint8Array(targetWidth * targetHeight * 4)
    for (let y = 0; y < targetHeight; y += 1) {
      const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / targetHeight))
      for (let x = 0; x < targetWidth; x += 1) {
        const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / targetWidth))
        const from = (sourceY * width + sourceX) * 4
        const to = (y * targetWidth + x) * 4
        target[to] = source[from]
        target[to + 1] = source[from + 1]
        target[to + 2] = source[from + 2]
        target[to + 3] = source[from + 3]
      }
    }
    return target
  }

  // Pure RGBA diff. Returns the changed-pixel count/ratio, the channel delta extremes and
  // the bounding box of differences (the "changed coordinates" acceptance evidence).
  // `sameSizeOnly: true` is the honest default for the experiment: two frames that do
  // not describe the same physical pixels are reported as `size-mismatch`, never compared.
  function diffRgba(pixelsA, pixelsB, options = {}) {
    const source = options && typeof options === 'object' ? options : {}
    const width = Math.round(finiteOr(source.width, 0))
    const height = Math.round(finiteOr(source.height, 0))
    const tolerance = clamp(finiteOr(source.tolerance, DEFAULT_DIFF_TOLERANCE), 0, 255)
    const sameSizeOnly = source.sameSizeOnly !== false
    const sizeA = pixelsA?.length || 0
    const sizeB = pixelsB?.length || 0
    if (!width || !height) return { ok: false, code: 'INVALID_SIZE' }
    if (sizeA !== width * height * 4 || sizeB !== width * height * 4) return { ok: false, code: 'INVALID_FRAME' }
    let different = 0
    let maxDelta = 0
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4
      const delta = Math.max(
        Math.abs(pixelsA[offset] - pixelsB[offset]),
        Math.abs(pixelsA[offset + 1] - pixelsB[offset + 1]),
        Math.abs(pixelsA[offset + 2] - pixelsB[offset + 2]),
        Math.abs(pixelsA[offset + 3] - pixelsB[offset + 3])
      )
      if (delta > maxDelta) maxDelta = delta
      if (delta <= tolerance) continue
      different += 1
      const x = index % width
      const y = Math.floor(index / width)
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    const compared = width * height
    return {
      ok: true,
      width,
      height,
      compared,
      different,
      ratio: compared ? different / compared : 0,
      maxDelta,
      tolerance,
      sameSizeOnly,
      bounds: maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null
    }
  }

  // Electron's nativeImage.toBitmap() is BGRA on Windows. The diff API is RGBA, and the
  // screen capture's alpha channel is meaningless (0 or 255 depending on the compositor),
  // so normalisation swaps R/B and forces opaque. A fresh buffer keeps the frame a single
  // owned allocation that can be dropped right after it is delivered.
  function bgraToRgba(pixels) {
    if (!pixels || typeof pixels.length !== 'number' || pixels.length % 4 !== 0) return null
    const source = pixels instanceof Uint8Array ? pixels : Uint8Array.from(pixels)
    const out = new Uint8Array(source.length)
    for (let offset = 0; offset < source.length; offset += 4) {
      out[offset] = source[offset + 2]
      out[offset + 1] = source[offset + 1]
      out[offset + 2] = source[offset]
      out[offset + 3] = 255
    }
    return out
  }

  // Pick the desktopCapturer source for one display. display_id is the authoritative
  // match; the bounded fallback is the first source with real pixels (Electron may omit
  // display_id on some platforms/driver combinations). Returns null if nothing usable.
  function pickScreenSource(sources, displayId) {
    const usable = (entry) => {
      if (!entry || !entry.thumbnail) return false
      const thumbnail = entry.thumbnail
      return !(typeof thumbnail.isEmpty === 'function' && thumbnail.isEmpty())
    }
    const list = Array.isArray(sources) ? sources.filter(usable) : []
    if (!list.length) return null
    const matched = list.find((entry) => displayId != null && String(entry.display_id ?? '') === String(displayId))
    if (matched) return { source: matched, matched: true }
    return { source: list[0], matched: false }
  }

  // Frame-rate / in-flight / byte budget state machine. Everything is injected so node
  // tests drive a fake clock and fake capture promises. The experiment aborts after
  // MAX_CONSECUTIVE_FAILURES failures instead of retrying forever.
  function createDiffSampler(options = {}) {
    const settings = options && typeof options === 'object' ? options : {}
    const captureFrame = typeof settings.captureFrame === 'function' ? settings.captureFrame : null
    const onFrame = typeof settings.onFrame === 'function' ? settings.onFrame : null
    const now = typeof settings.now === 'function' ? settings.now : () => Date.now()
    const intervalMs = clamp(finiteOr(settings.intervalMs, MIN_INTERVAL_MS), 250, 60000)
    const maxPixels = clamp(finiteOr(settings.maxPixels, MAX_CAPTURE_PIXELS), 1, MAX_CAPTURE_PIXELS)
    let lastCaptureAt = -Infinity
    let inFlight = false
    let frames = 0
    let skippedRate = 0
    let failures = 0
    let consecutiveFailures = 0
    let stopped = false
    let stopCode = ''
    let maxBytesSeen = 0

    function stop(code = 'stopped') {
      stopped = true
      stopCode = code
      return getStats()
    }

    function getStats() {
      return {
        frames,
        skippedRate,
        failures,
        consecutiveFailures,
        inFlight,
        stopped,
        stopCode,
        maxBytesSeen,
        intervalMs
      }
    }

    async function sample() {
      if (stopped) return { ok: false, code: 'STOPPED' }
      if (inFlight) return { ok: false, code: 'BUSY' }
      const at = now()
      if (at - lastCaptureAt < intervalMs) {
        skippedRate += 1
        return { ok: false, code: 'RATE_LIMITED', waitMs: intervalMs - (at - lastCaptureAt) }
      }
      if (!captureFrame) return { ok: false, code: 'NO_CAPTURE' }
      lastCaptureAt = at
      inFlight = true
      try {
        const frame = await captureFrame()
        if (!frame || frame.ok !== true) return fail(frame?.code || 'CAPTURE_FAILED')
        const pixels = frame.pixels
        const width = Math.round(finiteOr(frame.width, 0))
        const height = Math.round(finiteOr(frame.height, 0))
        if (!pixels || width * height > maxPixels || pixels.length !== width * height * 4) {
          return fail('FRAME_BUDGET')
        }
        const bytes = pixels.length
        if (bytes > maxBytesSeen) maxBytesSeen = bytes
        frames += 1
        consecutiveFailures = 0
        let delivered = true
        if (onFrame) {
          try {
            delivered = onFrame({ pixels, width, height, bytes, at }) !== false
          } catch (error) {
            delivered = false
          }
        }
        // The callback returned: the frame is no longer retained by the sampler.
        return { ok: true, delivered, width, height, bytes }
      } catch (error) {
        return fail('CAPTURE_THREW')
      } finally {
        inFlight = false
      }
    }

    function fail(code) {
      failures += 1
      consecutiveFailures += 1
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stop('FAILURE_LIMIT')
      return { ok: false, code, failures, consecutiveFailures }
    }

    return { sample, stop, getStats }
  }

  // Adoption gate for the real probe. It refuses to adopt unless every requirement has a
  // measured number - missing evidence is a reject, not a benefit of the doubt.
  function evaluateDiffAdoption(probe = {}) {
    const source = probe && typeof probe === 'object' ? probe : {}
    const reasons = []
    const samples = clamp(Math.round(finiteOr(source.samples, 0)), 0, 100000)
    if (samples < MIN_PROBE_SAMPLES) reasons.push('insufficient-samples')
    // selfCaptureRatio high means the screen samples tracked the pin's own content.
    const selfCaptureRatio = finiteOr(source.selfCaptureRatio, Number.NaN)
    if (!Number.isFinite(selfCaptureRatio)) reasons.push('self-capture-unmeasured')
    else if (selfCaptureRatio > SELF_CAPTURE_MAX_RATIO) reasons.push('self-capture-detected')
    // alignmentRatio is the share of strongly differing pixels for an UNCHANGED design.
    const alignmentRatio = finiteOr(source.alignmentRatio, Number.NaN)
    if (!Number.isFinite(alignmentRatio)) reasons.push('alignment-unmeasured')
    else if (alignmentRatio > ALIGNMENT_TOLERANCE_RATIO) reasons.push('alignment-exceeded')
    const maxFrameBytes = finiteOr(source.maxFrameBytes, Number.NaN)
    if (!Number.isFinite(maxFrameBytes)) reasons.push('budget-unmeasured')
    else if (maxFrameBytes > MAX_CAPTURE_BYTES) reasons.push('budget-exceeded')
    const minIntervalMs = finiteOr(source.minIntervalMs, Number.NaN)
    if (!Number.isFinite(minIntervalMs)) reasons.push('rate-unmeasured')
    else if (minIntervalMs < MIN_INTERVAL_MS) reasons.push('rate-exceeded')
    if (source.exclusionMethod && source.exclusionMethod !== 'content-protection') {
      reasons.push('unsupported-exclusion-method')
    }
    return { adopt: reasons.length === 0, reasons }
  }

  return {
    MIN_INTERVAL_MS,
    MAX_INFLIGHT,
    MAX_CAPTURE_PIXELS,
    MAX_CAPTURE_BYTES,
    MAX_CONSECUTIVE_FAILURES,
    DEFAULT_DIFF_TOLERANCE,
    SELF_CAPTURE_MAX_RATIO,
    ALIGNMENT_TOLERANCE_RATIO,
    MIN_PROBE_SAMPLES,
    normalizeRotation,
    normalizeDisplays,
    pickDisplay,
    pickScreenSource,
    bgraToRgba,
    planScreenCapture,
    resampleRgba,
    diffRgba,
    createDiffSampler,
    evaluateDiffAdoption
  }
})
