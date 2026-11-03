'use strict'

// Pure timeline math for the standalone recording editor window (R3 contract §11, extended by
// R4 contract §3.2/§4.2: multi-segment edits plus export resolution/quality/fps helpers).
//
// This module owns NO DOM and NO Electron: it is loaded as a classic script by
// record/editor.html (`window.recordEditorTimeline`) and required by the node tests, so the
// decisions that matter are testable headlessly:
//   * pointer -> media-millisecond conversion on the rendered track geometry;
//   * segment normalisation, split/delete, source<->edited mapping and neighbour-aware boundary
//     clamping (the schema rules of 1-20 ordered, non-overlapping, half-open ranges);
//   * video output option resolution that mirrors the exporter's `computeVideoOutput`: presets
//     are long-edge caps, never upscaled;
//   * the legacy single-range helpers, kept because the old preview/session API is still
//     covered by tests and because a one-segment edit is just a multi-segment edit of length 1.
//
// Every exported time value is an integer millisecond on the media timeline, exactly the basis
// shared/recording-export-options.js documents.
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

  // KB: one track, two handles (legacy preview) / multi-segment editing (editor).
  const ARROW_STEP_MS = 100
  const SHIFT_STEP_MS = 1000
  const MIN_RANGE_MS = LIMITS.MIN_RANGE_MS
  const HANDLES = Object.freeze(['start', 'end'])
  // R4 contract §3.1: 1-20 kept ranges; split/delete must preserve the 100 ms minimum.
  const MAX_SEGMENTS = 20
  // R4 contract §4.2: resolution presets are LONG-EDGE CAPS, not widths.
  const RESOLUTION_PRESETS = Object.freeze({ '1080p': 1920, '720p': 1280, '480p': 854 })
  const RESOLUTIONS = Object.freeze(['source', '1080p', '720p', '480p'])
  const QUALITY_LEVELS = Object.freeze(['standard', 'high', 'ultra'])
  const FRAME_RATE_OPTIONS = Object.freeze([30, 60])
  const VIDEO_DEFAULTS = Object.freeze({ resolution: 'source', quality: 'standard', fps: 'source' })

  function finite(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  function durationOf(durationMs) {
    return Math.max(0, Math.round(finite(durationMs) || 0))
  }

  function copySegments(segments) {
    return (Array.isArray(segments) ? segments : []).map((segment) => ({
      startMs: Math.round(finite(segment?.startMs) || 0),
      endMs: Math.round(finite(segment?.endMs) || 0)
    }))
  }

  // ---------- legacy single-range helpers (kept for the session API and tests) ----------

  // Pointer position -> media milliseconds. Anything unusable (no geometry yet, a zero-length
  // track, a non-numeric clientX) resolves to 0 rather than NaN: the caller renders a valid
  // point instead of a broken handle.
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
  // normalizeRange is the authority for "is this legal"; this local pass only guarantees no
  // NaN and end > start before a handle moves.
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

  function moveHandle(range, handle, targetMs, durationMs) {
    if (!HANDLES.includes(handle)) return null
    const { startMs, endMs, duration, effectiveMin } = settleRange(range, durationMs)
    const target = Math.round(finite(targetMs) || 0)
    if (handle === 'start') {
      const maxStart = Math.max(0, endMs - effectiveMin)
      return { startMs: clamp(target, 0, Math.min(duration, maxStart)), endMs }
    }
    const minEnd = Math.min(duration, startMs + effectiveMin)
    return { startMs, endMs: clamp(target, minEnd, duration) }
  }

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

  // "00:01.2" | "1.2" | "1:02" | 1200 -> milliseconds. null means "leave the value alone", so a
  // half-typed value never jumps a trim point to zero.
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

  // ---------- multi-segment model (R4 contract §3) ----------

  // Every segment is the half-open `[startMs, endMs)` on the source timeline; adjacency
  // (end === next.start) is legal, overlap is not, and each segment keeps at least
  // MIN_RANGE_MS so the exporter's range rule is satisfied by construction.
  function normalizeSegments(segments, durationMs) {
    const duration = durationOf(durationMs)
    if (!(duration > 0)) return []
    const effectiveMin = Math.min(MIN_RANGE_MS, duration)
    const candidates = []
    for (const entry of Array.isArray(segments) ? segments : []) {
      if (!isObject(entry)) continue
      const rawStart = finite(entry.startMs)
      const rawEnd = finite(entry.endMs)
      if (rawStart === null || rawEnd === null) continue
      const startMs = Math.round(rawStart)
      const endMs = Math.round(rawEnd)
      if (startMs < 0 || endMs > duration) continue
      if (!(endMs > startMs)) continue
      if (endMs - startMs < effectiveMin) continue
      candidates.push({ startMs, endMs })
    }
    candidates.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    const result = []
    for (const candidate of candidates) {
      const previous = result[result.length - 1]
      // Overlap: the later segment is dropped (contract §3.2). Adjacency is allowed and never
      // merged, because a visible cut point has to survive normalisation.
      if (previous && candidate.startMs < previous.endMs) continue
      result.push(candidate)
      if (result.length >= MAX_SEGMENTS) break
    }
    return result
  }

  // The editor's internal representation is materialised: "whole recording" becomes
  // [{0,duration}] rather than an empty array, so an EMPTY array unambiguously means "the user
  // deleted every segment" (no content, export disabled). The schema-shaped `[]` = whole rule
  // is applied at the draft/request boundary, not here.
  function materializeSegments(segments, durationMs) {
    const duration = durationOf(durationMs)
    if (!(duration > 0)) return []
    const normalized = normalizeSegments(segments, duration)
    if (normalized.length > 0) return normalized
    if (!Array.isArray(segments) || segments.length === 0) {
      return [{ startMs: 0, endMs: duration }]
    }
    return []
  }

  function isFullRange(segments, durationMs) {
    const duration = durationOf(durationMs)
    if (!(duration > 0)) return false
    if (!Array.isArray(segments) || segments.length === 0) return true
    const normalized = normalizeSegments(segments, duration)
    if (normalized.length !== 1) return false
    return normalized[0].startMs <= 1 && normalized[0].endMs >= duration - 1
  }

  function segmentsEqual(left, right) {
    const a = copySegments(left)
    const b = copySegments(right)
    if (a.length !== b.length) return false
    return a.every((segment, index) => segment.startMs === b[index].startMs && segment.endMs === b[index].endMs)
  }

  function segmentAt(segments, ms, durationMs) {
    const base = materializeSegments(segments, durationMs)
    const position = Math.round(finite(ms) === null ? -1 : finite(ms))
    if (position < 0) return -1
    for (let index = 0; index < base.length; index += 1) {
      if (position >= base[index].startMs && position < base[index].endMs) return index
    }
    return -1
  }

  // Split only strictly inside a kept segment (and only when both halves keep the 100 ms
  // minimum). An empty array is materialised first, so splitting a whole-range recording works
  // and yields an explicit two-segment edit afterwards.
  function splitAt(segments, atMs, durationMs) {
    const duration = durationOf(durationMs)
    const base = materializeSegments(segments, duration)
    // Contract §3.1: a split may not push the edit past the 20-segment schema limit.
    if (base.length >= MAX_SEGMENTS) return copySegments(base)
    const at = Math.round(finite(atMs) === null ? -1 : finite(atMs))
    if (!(duration > 0) || !(at > 0)) return copySegments(base)
    const effectiveMin = Math.min(MIN_RANGE_MS, duration)
    const index = segmentAt(base, at, duration)
    if (index < 0) return copySegments(base)
    const segment = base[index]
    if (at - segment.startMs < effectiveMin || segment.endMs - at < effectiveMin) return copySegments(base)
    return [
      ...base.slice(0, index),
      { startMs: segment.startMs, endMs: at },
      { startMs: at, endMs: segment.endMs },
      ...base.slice(index + 1)
    ]
  }

  // Delete the segment containing atMs. A zero-length result is the editor's explicit "no
  // content" state (the schema cannot persist it; the controller documents that limitation).
  function deleteSegmentAt(segments, atMs, durationMs) {
    const duration = durationOf(durationMs)
    const base = materializeSegments(segments, duration)
    const index = segmentAt(base, atMs, duration)
    if (index < 0) return copySegments(base)
    return base.filter((_segment, position) => position !== index)
  }

  // Source time -> time on the edited (concatenated) timeline. Returns null when the position
  // falls in a removed gap, which is exactly the "skip removed content" playback signal.
  function sourceToEdited(segments, ms, durationMs) {
    const duration = durationOf(durationMs)
    if (!(duration > 0)) return null
    const position = Math.round(finite(ms) === null ? -1 : finite(ms))
    if (position < 0) return null
    let editedMs = 0
    for (const segment of materializeSegments(segments, duration)) {
      if (position < segment.startMs) return null
      if (position < segment.endMs) return editedMs + (position - segment.startMs)
      editedMs += segment.endMs - segment.startMs
    }
    return null
  }

  // Edited time -> source time. Positions past the last kept segment clamp to its end instead
  // of wrapping, so a transport seeking past the output length stays on the last frame.
  function editedToSource(segments, editedMs, durationMs) {
    const duration = durationOf(durationMs)
    const base = materializeSegments(segments, duration)
    if (!(duration > 0) || base.length === 0) return 0
    let remaining = Math.max(0, Math.round(finite(editedMs) || 0))
    for (const segment of base) {
      const length = segment.endMs - segment.startMs
      if (remaining < length) return segment.startMs + remaining
      remaining -= length
    }
    return base[base.length - 1].endMs
  }

  function totalKeptMs(segments, durationMs) {
    const duration = durationOf(durationMs)
    if (!(duration > 0)) return 0
    return materializeSegments(segments, duration)
      .reduce((total, segment) => total + (segment.endMs - segment.startMs), 0)
  }

  // First kept segment start strictly after `ms`, or null when there is none. Playback uses this
  // to jump forward over a removed gap without ever playing it.
  function nextKeptStart(segments, ms, durationMs) {
    const duration = durationOf(durationMs)
    if (!(duration > 0)) return null
    const position = Math.round(finite(ms) === null ? -1 : finite(ms))
    for (const segment of materializeSegments(segments, duration)) {
      if (segment.startMs > position) return segment.startMs
    }
    return null
  }

  // Drag one segment edge, constrained by its NEIGHBOURS and the media boundaries:
  //   * a start edge may move right up to (end - MIN) and left down to the previous end (gap)
  //     or 0 for the first segment;
  //   * an end edge may move left down to (start + MIN) and right up to the next start (gap) or
  //     the media duration for the last segment.
  // Adjacency is preserved as a position, not merged: dragging an edge next to a neighbour can
  // produce a gap, and dragging it back to the neighbour's edge closes the gap again.
  function moveBoundary(segments, index, edge, targetMs, durationMs) {
    const duration = durationOf(durationMs)
    const base = materializeSegments(segments, duration)
    const position = Math.round(Number(index))
    if (!Number.isInteger(position) || position < 0 || position >= base.length) return copySegments(base)
    if (edge !== 'start' && edge !== 'end') return copySegments(base)
    const effectiveMin = Math.min(MIN_RANGE_MS, duration)
    const segment = base[position]
    const target = Math.round(finite(targetMs) || 0)
    const next = base[position + 1] || null
    const previous = base[position - 1] || null
    const mutable = base.map((entry) => ({ ...entry }))
    if (edge === 'start') {
      const minimum = previous ? previous.endMs : 0
      const maximum = Math.max(minimum, segment.endMs - effectiveMin)
      mutable[position].startMs = clamp(target, minimum, maximum)
    } else {
      const minimum = segment.startMs + effectiveMin
      const maximum = Math.max(minimum, next ? next.startMs : duration)
      mutable[position].endMs = clamp(target, minimum, maximum)
    }
    return mutable
  }

  // Drag the split point between two ADJACENT segments: both edges move together so the cut
  // stays a cut (R4 contract §3.3: the boundary between neighbouring segments is one handle).
  // `index` is the right-hand segment.
  function moveJunction(segments, index, targetMs, durationMs) {
    const duration = durationOf(durationMs)
    const base = materializeSegments(segments, duration)
    const position = Math.round(Number(index))
    if (!Number.isInteger(position) || position <= 0 || position >= base.length) return copySegments(base)
    const previous = base[position - 1]
    const current = base[position]
    if (previous.endMs !== current.startMs) return copySegments(base)
    const effectiveMin = Math.min(MIN_RANGE_MS, duration)
    const minimum = previous.startMs + effectiveMin
    const maximum = Math.max(minimum, current.endMs - effectiveMin)
    const splitMs = clamp(Math.round(finite(targetMs) || 0), minimum, maximum)
    const mutable = base.map((entry) => ({ ...entry }))
    mutable[position - 1].endMs = splitMs
    mutable[position].startMs = splitMs
    return mutable
  }

  // ---------- export video options (R4 contract §4.2 / §5) ----------

  function sourceLongEdge(width, height) {
    const sourceWidth = Math.max(0, Math.round(finite(width) || 0))
    const sourceHeight = Math.max(0, Math.round(finite(height) || 0))
    return Math.max(sourceWidth, sourceHeight)
  }

  // Only presets whose cap is not larger than the source long edge are offered: a preset can
  // shrink footage but must never be used to upscale it.
  function availableResolutions(width, height) {
    const longEdge = sourceLongEdge(width, height)
    const available = ['source']
    for (const resolution of ['1080p', '720p', '480p']) {
      if (longEdge > 0 && RESOLUTION_PRESETS[resolution] <= longEdge) available.push(resolution)
    }
    return available
  }

  // A frame rate above the source is not offered: 24 fps footage cannot be turned into real
  // 30/60 fps detail. Unknown source frame rate offers only 'source'.
  function availableFrameRates(sourceFrameRate) {
    const rate = finite(sourceFrameRate)
    if (rate === null || rate <= 0) return ['source']
    return ['source', ...FRAME_RATE_OPTIONS.filter((option) => rate >= option - 0.5).map(String)]
  }

  function even(value) {
    return Math.max(2, Math.round(value / 2) * 2)
  }

  // Same value the exporter computes. p1 owns the shared implementation
  // (`shared/recording-export-options.js#computeVideoOutput`); once it lands this forwards to it
  // so the preview and the encoder cannot drift, and the local formula is the identical
  // fallback used until then (contract §4.2: presets are long-edge caps, never upscaled).
  function computeVideoOutput({ sourceWidth, sourceHeight, resolution } = {}) {
    const width = Math.max(2, Math.round(finite(sourceWidth) || 0))
    const height = Math.max(2, Math.round(finite(sourceHeight) || 0))
    const requested = RESOLUTIONS.includes(resolution) ? resolution : 'source'
    if (typeof options.computeVideoOutput === 'function') {
      try {
        const shared = options.computeVideoOutput({ sourceWidth: width, sourceHeight: height, resolution: requested })
        if (shared && typeof shared === 'object') {
          if (shared.ok === false) return shared
          if (shared.ok === true) return shared
          return { ok: true, value: shared }
        }
      } catch {
        // Fall through to the local formula; the shared one may be mid-landing.
      }
    }
    const longEdge = Math.max(width, height)
    const cap = requested === 'source' ? longEdge : RESOLUTION_PRESETS[requested]
    const scale = requested === 'source' ? 1 : Math.min(1, cap / longEdge)
    return {
      ok: true,
      value: {
        resolution: requested,
        width: even(width * scale),
        height: even(height * scale),
        scale,
        upscaled: false
      }
    }
  }

  // Normalise the export-panel video options against the source metadata. Mirrors the
  // exporter's normalisation so the panel cannot submit a combination the main process rejects.
  function normalizeVideoOptions(input, context = {}) {
    const source = isObject(input) ? input : {}
    const width = Math.max(0, Math.round(finite(context.sourceWidth) || 0))
    const height = Math.max(0, Math.round(finite(context.sourceHeight) || 0))
    const sourceFrameRate = finite(context.sourceFrameRate)
    const resolution = source.resolution === undefined ? VIDEO_DEFAULTS.resolution : source.resolution
    if (!RESOLUTIONS.includes(resolution)) {
      return { ok: false, code: 'invalid-video-option', detail: 'resolution' }
    }
    const quality = source.quality === undefined ? VIDEO_DEFAULTS.quality : source.quality
    if (!QUALITY_LEVELS.includes(quality)) {
      return { ok: false, code: 'invalid-video-option', detail: 'quality' }
    }
    const rawFps = source.fps === undefined ? VIDEO_DEFAULTS.fps : source.fps
    const fps = rawFps === 'source' ? 'source' : (Number.isInteger(Number(rawFps)) ? Number(rawFps) : null)
    if (fps !== 'source' && !FRAME_RATE_OPTIONS.includes(fps)) {
      return { ok: false, code: 'invalid-video-option', detail: 'fps' }
    }
    if (fps !== 'source' && sourceFrameRate !== null && sourceFrameRate > 0 && fps > sourceFrameRate + 0.5) {
      return { ok: false, code: 'fps-above-source', detail: `${fps} > ${sourceFrameRate}` }
    }
    const output = computeVideoOutput({ sourceWidth: width, sourceHeight: height, resolution })
    if (!output || output.ok === false) return output || { ok: false, code: 'invalid-video-option' }
    return {
      ok: true,
      value: {
        resolution,
        quality,
        fps,
        fpsValue: fps === 'source' ? (sourceFrameRate && sourceFrameRate > 0 ? sourceFrameRate : 0) : fps,
        width: output.value.width,
        height: output.value.height
      }
    }
  }

  // ---------- GIF (unchanged from R3) ----------

  function gifOutputSize({ width, height, maxEdgePx } = {}) {
    return computeGifDimensions({ width, height, maxEdgePx })
  }

  function gifFrameCount(durationMs, fps) {
    return estimateGifFrames(durationMs, fps)
  }

  return {
    ARROW_STEP_MS,
    FRAME_RATE_OPTIONS,
    GIF_FRAME_RATES,
    HANDLES,
    LIMITS,
    MAX_SEGMENTS,
    MIN_RANGE_MS,
    QUALITY_LEVELS,
    RESOLUTIONS,
    RESOLUTION_PRESETS,
    SHIFT_STEP_MS,
    VIDEO_DEFAULTS,
    availableFrameRates,
    availableResolutions,
    clamp,
    computeVideoOutput,
    copySegments,
    deleteSegmentAt,
    durationOf,
    editedToSource,
    formatClock,
    gifFrameCount,
    gifOutputSize,
    isFullRange,
    keyboardStep,
    materializeSegments,
    moveBoundary,
    moveHandle,
    moveJunction,
    msToPercent,
    nextKeptStart,
    normalizeSegments,
    normalizeVideoOptions,
    nudgeHandle,
    parseTimeInput,
    pointerToMs,
    rangeGeometry,
    segmentAt,
    segmentsEqual,
    sourceLongEdge,
    sourceToEdited,
    splitAt,
    totalKeptMs,
    validateRange
  }
})
