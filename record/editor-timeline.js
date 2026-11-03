'use strict'

// Pure timeline math for the standalone recording editor window (R3 plan §4.3,
// contract §11: one track with a left and a right handle).
//
// This module owns NO DOM and NO Electron: it is loaded as a classic script by
// record/editor.html (`window.recordEditorTimeline`) and required by the node tests,
// so the decisions that matter are testable headlessly:
//   * pointer -> media-millisecond conversion on the rendered track geometry;
//   * handle clamping that can never produce an invalid (or too short) range;
//   * the same half-open range validation the main process applies, reusing
//     shared/recording-export-options.js `normalizeRange` / `LIMITS` so the UI
//     cannot offer a selection the exporter will reject;
//   * keyboard steps and the "moving the playhead never edits the trim points"
//     split (the playhead lives in editor.js; this module is trim-only).
//
// Every exported time value is an integer millisecond on the media timeline,
// exactly the basis shared/recording-export-options.js documents.
;(function initEditorTimeline(root, factory) {
  const options = typeof module === 'object' && module.exports
    ? require('../shared/recording-export-options')
    : root.recordingExportOptions
  const api = factory(options)
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.recordEditorTimeline = api
})(typeof globalThis === 'object' ? globalThis : this, (options) => {
  const {
    GIF_FRAME_RATES,
    LIMITS,
    computeGifDimensions,
    estimateGifFrames,
    normalizeRange
  } = options

  // Keyboard trim steps: a normal arrow moves 100 ms (one or two frames of a 30-60 FPS
  // recording, fine enough to land on a word boundary), Shift moves a full second.
  const ARROW_STEP_MS = 100
  const SHIFT_STEP_MS = 1000
  // A selection shorter than this is a mis-click, not an edit; the exporter rejects it.
  const MIN_RANGE_MS = LIMITS.MIN_RANGE_MS
  const HANDLES = Object.freeze(['start', 'end'])

  function finite(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  function durationOf(durationMs) {
    return Math.max(0, Math.round(finite(durationMs) || 0))
  }

  // Pointer position -> media milliseconds. Anything unusable (no geometry yet, a
  // zero-length track, a non-numeric clientX) resolves to 0 rather than NaN: the caller
  // renders a valid point instead of a broken handle.
  function pointerToMs(clientX, rect, durationMs) {
    const duration = durationOf(durationMs)
    const left = finite(rect?.left)
    const width = finite(rect?.width)
    const x = finite(clientX)
    if (!(duration > 0) || left === null || width === null || width <= 0 || x === null) return 0
    return Math.round(clamp((x - left) / width, 0, 1) * duration)
  }

  function msToPercent(ms, durationMs) {
    const duration = durationOf(durationMs)
    if (!(duration > 0)) return 0
    return clamp((Math.round(finite(ms) || 0) / duration) * 100, 0, 100)
  }

  // Normalise an incoming range just enough to move a handle safely. The contract's
  // normalizeRange is the authority for "is this legal"; this local pass only guarantees
  // no NaN and end >= start before a handle moves.
  function settleRange(range, durationMs) {
    const duration = durationOf(durationMs)
    const effectiveMin = Math.min(MIN_RANGE_MS, duration)
    const rawStart = Math.round(finite(range?.startMs) || 0)
    const rawEnd = Math.round(finite(range?.endMs) || (duration ? duration : 0))
    let startMs = clamp(rawStart, 0, duration)
    let endMs = clamp(rawEnd, 0, duration)
    if (!(endMs > startMs)) {
      startMs = clamp(startMs, 0, Math.max(0, duration - effectiveMin))
      endMs = Math.min(duration, startMs + effectiveMin)
    }
    return { startMs, endMs, duration, effectiveMin }
  }

  // Move one handle to `targetMs`, keeping the other handle and the minimum duration.
  // Returns a fresh `{ startMs, endMs }`, or null for an unknown handle name.
  function moveHandle(range, handle, targetMs, durationMs) {
    if (!HANDLES.includes(handle)) return null
    const settled = settleRange(range, durationMs)
    const { startMs, endMs, duration, effectiveMin } = settled
    const target = Math.round(finite(targetMs) || 0)
    if (handle === 'start') {
      const maxStart = Math.max(0, endMs - effectiveMin)
      return { startMs: clamp(target, 0, Math.min(duration, maxStart)), endMs }
    }
    const minEnd = Math.min(duration, startMs + effectiveMin)
    return { startMs, endMs: clamp(target, minEnd, duration) }
  }

  // Arrow/Shift deducation for the focused handle.
  function keyboardStep(event) {
    const shift = event === true || (event && typeof event === 'object' && event.shiftKey === true)
    return shift ? SHIFT_STEP_MS : ARROW_STEP_MS
  }

  function nudgeHandle(range, handle, deltaMs, durationMs) {
    if (!HANDLES.includes(handle)) return null
    const settled = settleRange(range, durationMs)
    const current = handle === 'start' ? settled.startMs : settled.endMs
    return moveHandle(settled, handle, current + (finite(deltaMs) || 0), durationMs)
  }

  // The exact validation the exporter applies. A UI state that fails this must not
  // submit, which is why the editor keeps `canExport` derived from it.
  function validateRange(range, durationMs) {
    return normalizeRange(range, durationMs)
  }

  function rangeGeometry(range, durationMs) {
    const duration = durationOf(durationMs)
    const settled = settleRange(range, duration)
    const startPercent = msToPercent(settled.startMs, duration)
    const endPercent = msToPercent(settled.endMs, duration)
    return {
      startPercent,
      endPercent,
      widthPercent: Math.max(0, endPercent - startPercent),
      startMs: settled.startMs,
      endMs: settled.endMs,
      durationMs: duration
    }
  }

  function formatClock(milliseconds) {
    const total = Math.max(0, Math.round(finite(milliseconds) || 0))
    const seconds = Math.floor(total / 1000)
    const tenths = Math.floor((total % 1000) / 100)
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${tenths}`
  }

  // "00:01.2" | "1.2" | "1:02" | 1200 -> milliseconds. null means "leave the handle alone",
  // so a half-typed value never jumps a trim point to zero.
  function parseTimeInput(text) {
    if (typeof text === 'number') return finite(text)
    const value = String(text || '').trim()
    if (!value) return null
    const parts = value.split(':')
    if (parts.length > 3) return null
    let seconds = 0
    for (const part of parts) {
      const number = Number(part)
      if (!Number.isFinite(number) || number < 0) return null
      seconds = seconds * 60 + number
    }
    return Math.round(seconds * 1000)
  }

  // The GIF output size the shared validator will produce for a given cap, so the export
  // panel can show the real final width x height instead of a guessed ratio.
  function gifOutputSize({ width, height, maxEdgePx } = {}) {
    return computeGifDimensions({ width, height, maxEdgePx })
  }

  function gifFrameCount(durationMs, fps) {
    return estimateGifFrames(durationMs, fps)
  }

  return {
    ARROW_STEP_MS,
    GIF_FRAME_RATES,
    HANDLES,
    LIMITS,
    MIN_RANGE_MS,
    SHIFT_STEP_MS,
    clamp,
    formatClock,
    gifFrameCount,
    gifOutputSize,
    keyboardStep,
    moveHandle,
    msToPercent,
    nudgeHandle,
    parseTimeInput,
    pointerToMs,
    rangeGeometry,
    validateRange
  }
})
