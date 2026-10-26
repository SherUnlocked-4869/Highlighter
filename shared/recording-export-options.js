// Recording trim + MP4/GIF export options (feature E, plan §8:
// docs/plans/2026-10-25-snow-apps-feature-development-plan.md).
//
// This module is the ONE place that decides what a legal export request is and which
// whitelisted ffmpeg argv that request turns into. Both sides use it:
//   * the main process validates the renderer request here and builds argv here, so a
//     renderer can never smuggle an arbitrary ffmpeg flag, path or time span;
//   * `record/trim-controller.js` uses the same normalisation + frame estimate for the
//     preview UI, so "what the UI predicts" and "what the encoder does" cannot drift.
//
// UMD wrapper matches shared/region-presets.js: `require()` in the main process and in
// tests, `<script>` in a window (`window.recordingExportOptions`). The file is PURE:
// no Electron, no node:fs, no process, no clock.
//
// ---------------------------------------------------------------------------
// Time basis and rounding (read before changing; plan §8.5 asks for one rule)
// ---------------------------------------------------------------------------
// All times are integer MILLISECONDS on the *media timeline*: 0 is the first frame the
// container's timeline exposes, i.e. what an HTML <video> reports as currentTime. The
// probe reports the container's `start` offset separately as `startMs` for diagnostics;
// it is deliberately NOT added to a range, because `-ss` seeks in the same timeline the
// preview plays (verified against real WebM samples, see the feature handoff).
//
// The range is the half-open source interval `[startMs, endMs)`. Rounding rule:
//   1. non-finite / non-positive values are rejected (never clamped to 0 silently);
//   2. values are rounded to the nearest millisecond and clamped into
//      `[0, durationMs]` only when the request is already within one millisecond of the
//      boundary — a request outside the media is an error, not a silent clamp;
//   3. `endMs - startMs >= MIN_RANGE_MS`, otherwise `range-too-short`.
// The encoder then trims with an exact filter (`trim`/`atrim`), not stream copy, so the
// first output frame is the first source frame at or after `startMs` and the audio is cut
// at the same composed timestamp. Preview seeks the same millisecond value, so the only
// tolerated difference is one source frame (1000/fps ms) plus at most one output frame of
// the chosen GIF rate; that is the tolerance the publish verification uses, it is not a
// licence to widen the range.
//
// ---------------------------------------------------------------------------
// GIF guard rails (plan §3.3, MVP values - not measured optima)
// ---------------------------------------------------------------------------
// Duration <= 60 s, never upscale, long edge <= 1280 px, fps in {10,15,20}, <= 1200
// frames. The UI shows the estimated frame count up front and refuses to submit an
// out-of-budget request; the main process re-validates the same numbers server-side.
;(function initRecordingExportOptions(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.recordingExportOptions = api
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const EXPORT_FORMATS = Object.freeze(['mp4', 'gif'])
  const GIF_FRAME_RATES = Object.freeze([10, 15, 20])
  const SESSION_STATES = Object.freeze(['capturing', 'finalizing', 'ready', 'closing', 'closed', 'failed'])
  const EXPORT_TASK_STATES = Object.freeze([
    'queued', 'running', 'publishing', 'succeeded', 'failed', 'cancelling', 'cancelled'
  ])

  const LIMITS = Object.freeze({
    // Plan §3.3 video export row: one encoder, at most two queued tasks.
    MAX_ACTIVE_TASKS: 1,
    MAX_QUEUED_TASKS: 2,
    // Plan §3.3 GIF row.
    GIF_MAX_DURATION_MS: 60000,
    GIF_MAX_EDGE_PX: 1280,
    GIF_MAX_FRAMES: 1200,
    GIF_MIN_EDGE_PX: 16,
    // A range shorter than this is a mis-click, not an edit.
    MIN_RANGE_MS: 100,
    // Input seek distance before the exact filter trim. Long enough that the decoder has
    // a keyframe to start from (WebM keyframe intervals are seconds, not frames) while
    // still making a head-trim of a 30 minute recording cost seconds, not minutes.
    PREROLL_MS: 2000,
    // Publish verification: a finished encode must be within this tolerance of the
    // requested span. One source frame plus AAC priming is ~120 ms; the floor keeps a
    // 200 ms selection from failing on rounding.
    VERIFY_MIN_TOLERANCE_MS: 250,
    VERIFY_TOLERANCE_RATIO: 0.05,
    // GIF re-quantises the timeline, so its duration can land on the previous output
    // frame boundary instead of the requested millisecond.
    GIF_VERIFY_EXTRA_TOLERANCE_MS: 200
  })

  const SESSION_TRANSITIONS = Object.freeze({
    capturing: Object.freeze({ finalize: 'finalizing', fail: 'failed' }),
    finalizing: Object.freeze({ ready: 'ready', fail: 'failed' }),
    ready: Object.freeze({ close: 'closing', fail: 'failed' }),
    closing: Object.freeze({ closed: 'closed' }),
    closed: Object.freeze({}),
    failed: Object.freeze({ close: 'closing' })
  })

  const TASK_TRANSITIONS = Object.freeze({
    queued: Object.freeze({ run: 'running', cancel: 'cancelling', fail: 'failed' }),
    running: Object.freeze({ publish: 'publishing', cancel: 'cancelling', fail: 'failed', succeed: 'succeeded' }),
    // Publishing is the short critical section between "temp file verified" and
    // "target replaced". A cancel that arrives here does NOT replace anything and does not
    // report cancelled (plan §8.4): the task finishes as succeeded or failed.
    publishing: Object.freeze({ succeed: 'succeeded', fail: 'failed' }),
    cancelling: Object.freeze({ cancelled: 'cancelled', fail: 'failed' }),
    succeeded: Object.freeze({}),
    failed: Object.freeze({}),
    cancelled: Object.freeze({})
  })

  const TERMINAL_TASK_STATES = Object.freeze(['succeeded', 'failed', 'cancelled'])

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  function finiteNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function fail(code, detail) {
    return detail === undefined ? { ok: false, code } : { ok: false, code, detail }
  }

  function transition(map, from, event) {
    const next = map[from]?.[event]
    if (!next) return null
    return next
  }

  function sessionTransition(from, event) {
    return transition(SESSION_TRANSITIONS, from, event)
  }

  function taskTransition(from, event) {
    return transition(TASK_TRANSITIONS, from, event)
  }

  function isTerminalTaskState(state) {
    return TERMINAL_TASK_STATES.includes(state)
  }

  // ---------------------------------------------------------------------------
  // Range normalisation
  // ---------------------------------------------------------------------------

  // `input` is the renderer's `{ startMs, endMs }`. `durationMs` MUST come from the media
  // probe, never from the renderer: the renderer only supplies the selection, the main
  // process owns the boundary (plan §8.1).
  function normalizeRange(input, durationMs) {
    const duration = finiteNumber(durationMs)
    if (duration === null || duration <= 0) return fail('duration-unavailable')
    const source = isPlainObject(input) ? input : {}
    const start = finiteNumber(source.startMs)
    const end = finiteNumber(source.endMs)
    if (start === null || end === null) return fail('invalid-range')
    const roundedStart = Math.round(start)
    const roundedEnd = Math.round(end)
    // One millisecond of slack absorbs float noise from a slider, nothing more.
    if (roundedStart < -1 || roundedEnd > duration + 1) return fail('range-out-of-bounds')
    const startMs = Math.max(0, Math.min(roundedStart, Math.floor(duration)))
    const endMs = Math.max(0, Math.min(roundedEnd, Math.ceil(duration)))
    if (!(startMs < endMs)) return fail('invalid-range')
    if (endMs - startMs < LIMITS.MIN_RANGE_MS) return fail('range-too-short')
    return { ok: true, value: { startMs, endMs, durationMs: endMs - startMs } }
  }

  // Input-seek distance and the relative filter window. Exported so the service, the
  // verification step and the tests all compute it the same way.
  function exportWindow(range, prerollMs = LIMITS.PREROLL_MS) {
    const startMs = Math.max(0, Math.round(Number(range?.startMs) || 0))
    const endMs = Math.max(startMs, Math.round(Number(range?.endMs) || 0))
    const preroll = Math.max(0, Math.round(Number(prerollMs) || 0))
    const seekMs = Math.max(0, startMs - preroll)
    return {
      seekMs,
      relStartMs: startMs - seekMs,
      relEndMs: endMs - seekMs,
      spanMs: endMs - startMs
    }
  }

  function seconds(milliseconds) {
    // ffmpeg accepts decimal seconds; 6 decimals is microsecond precision, which is finer
    // than any frame or audio sample boundary we could be asked to honour.
    return (Math.round(Number(milliseconds) || 0) / 1000).toFixed(6)
  }

  // ---------------------------------------------------------------------------
  // GIF budget
  // ---------------------------------------------------------------------------

  function estimateGifFrames(durationMs, fps) {
    const duration = Math.max(0, finiteNumber(durationMs) || 0)
    const rate = Math.max(1, Math.round(finiteNumber(fps) || GIF_FRAME_RATES[1]))
    if (duration <= 0) return 0
    // Ceil, not round: a selection that ends mid-frame still emits that frame.
    return Math.max(1, Math.ceil((duration * rate) / 1000))
  }

  // Even dimensions keep the encoder on yuv420-friendly alignment; the result is never
  // larger than the source (plan §3.3 "do not upscale") and never larger than the cap.
  function computeGifDimensions({ width, height, maxEdgePx } = {}) {
    const sourceWidth = Math.round(finiteNumber(width) || 0)
    const sourceHeight = Math.round(finiteNumber(height) || 0)
    if (sourceWidth <= 0 || sourceHeight <= 0) return fail('invalid-source-size')
    const requested = Math.round(finiteNumber(maxEdgePx) ?? LIMITS.GIF_MAX_EDGE_PX)
    if (!(requested >= LIMITS.GIF_MIN_EDGE_PX) || requested > LIMITS.GIF_MAX_EDGE_PX) return fail('gif-invalid-edge')
    const longEdge = Math.max(sourceWidth, sourceHeight)
    // The cap applies to the output; a small window is never upscaled to it.
    const targetEdge = Math.min(requested, longEdge)
    const scale = targetEdge / longEdge
    const even = (value) => Math.max(2, Math.round((value * scale) / 2) * 2)
    const outWidth = even(sourceWidth)
    const outHeight = even(sourceHeight)
    if (outWidth > LIMITS.GIF_MAX_EDGE_PX || outHeight > LIMITS.GIF_MAX_EDGE_PX) return fail('gif-invalid-edge')
    return { ok: true, value: { width: outWidth, height: outHeight, edgePx: Math.max(outWidth, outHeight), upscaled: targetEdge > longEdge } }
  }

  // `source` is the probe's `{ video: { width, height } }` (or a bare `{width,height}`).
  function normalizeGifOptions(input, source, durationMs) {
    const options = isPlainObject(input) ? input : {}
    const metrics = isPlainObject(source?.video) ? source.video : (isPlainObject(source) ? source : {})
    const duration = finiteNumber(durationMs)
    if (duration === null || duration <= 0) return fail('duration-unavailable')
    if (duration > LIMITS.GIF_MAX_DURATION_MS) return fail('gif-too-long')
    const fps = Math.round(finiteNumber(options.fps) ?? 0)
    if (!GIF_FRAME_RATES.includes(fps)) return fail('gif-invalid-fps')
    if (options.loop !== undefined && options.loop !== true) return fail('gif-loop-required')
    const maxEdgePx = Math.round(finiteNumber(options.maxEdgePx) ?? LIMITS.GIF_MAX_EDGE_PX)
    const dimensions = computeGifDimensions({
      width: metrics.width,
      height: metrics.height,
      maxEdgePx
    })
    if (!dimensions.ok) return dimensions
    const frames = estimateGifFrames(duration, fps)
    if (frames > LIMITS.GIF_MAX_FRAMES) return fail('gif-too-many-frames')
    return {
      ok: true,
      value: {
        maxEdgePx: dimensions.value.edgePx,
        fps,
        loop: true,
        width: dimensions.value.width,
        height: dimensions.value.height,
        frames
      }
    }
  }

  // Validation entry point shared by the request normaliser and the UI predictor.
  // `metadata` is the probe result: `{ durationMs, video: { width, height, frameRate }, audio: { exists } }`.
  function normalizeExportRequest(input, metadata) {
    const request = isPlainObject(input) ? input : {}
    const format = typeof request.format === 'string' ? request.format : ''
    if (!EXPORT_FORMATS.includes(format)) return fail('unsupported-format')
    const duration = finiteNumber(metadata?.durationMs)
    const rangeResult = normalizeRange(request.range, duration)
    if (!rangeResult.ok) return rangeResult
    const range = rangeResult.value
    let gif = null
    if (format === 'gif') {
      const gifResult = normalizeGifOptions(request.gif, metadata, range.durationMs)
      if (!gifResult.ok) return gifResult
      gif = gifResult.value
    }
    const hasAudio = format === 'mp4' && metadata?.audio?.exists === true
    return {
      ok: true,
      value: { format, range, gif, hasAudio, sourceWidth: Math.round(finiteNumber(metadata?.video?.width) || 0), sourceHeight: Math.round(finiteNumber(metadata?.video?.height) || 0) }
    }
  }

  // ---------------------------------------------------------------------------
  // ffmpeg argv (whitelisted flags only; never a shell string)
  // ---------------------------------------------------------------------------

  // Exact trim: the video filter trims relative to the input seek, then rebases the
  // timestamps; the audio filter does the same with atrim so A/V stay aligned. This is
  // "decode and cut", never `-c copy` (plan §8.5: stream copy cannot honour a
  // non-keyframe boundary).
  function trimFilters(window) {
    const relStart = seconds(window.relStartMs)
    const relEnd = seconds(window.relEndMs)
    return {
      video: `[0:v]trim=start=${relStart}:end=${relEnd},setpts=PTS-STARTPTS[v]`,
      audio: `[0:a]atrim=start=${relStart}:end=${relEnd},asetpts=PTS-STARTPTS[a]`
    }
  }

  // Options: `{ inputPath, outputPath, format, range, gif, hasAudio, sourceWidth, sourceHeight }`.
  // Returns `{ args, expected }`; `expected` is what the publish verification checks.
  function buildExportArgs(options = {}) {
    const inputPath = String(options.inputPath || '')
    const outputPath = String(options.outputPath || '')
    const format = options.format
    if (!inputPath || !outputPath) throw new Error('recording-export-options: input and output paths are required')
    if (!EXPORT_FORMATS.includes(format)) throw new Error('recording-export-options: unsupported format')
    const window = exportWindow(options.range)
    if (!(window.spanMs > 0)) throw new Error('recording-export-options: empty range')
    const filters = trimFilters(window)
    const progress = ['-progress', 'pipe:2', '-nostats']
    const head = ['-hide_banner', '-nostdin', '-ss', seconds(window.seekMs), '-i', inputPath]

    if (format === 'mp4') {
      const hasAudio = options.hasAudio === true
      const graph = hasAudio ? `${filters.video};${filters.audio}` : filters.video
      const audioArgs = hasAudio
        ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2']
        : ['-an']
      return {
        args: [
          ...head,
          '-filter_complex', graph,
          '-map', '[v]',
          ...audioArgs,
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          ...progress,
          '-y', outputPath
        ],
        expected: {
          format,
          durationMs: window.spanMs,
          width: Math.round(finiteNumber(options.sourceWidth) || 0),
          height: Math.round(finiteNumber(options.sourceHeight) || 0),
          hasAudio
        }
      }
    }

    const gif = isPlainObject(options.gif) ? options.gif : {}
    const fps = GIF_FRAME_RATES.includes(Number(gif.fps)) ? Number(gif.fps) : GIF_FRAME_RATES[1]
    const width = Math.round(finiteNumber(gif.width) || 0)
    const height = Math.round(finiteNumber(gif.height) || 0)
    if (!(width > 0) || !(height > 0)) throw new Error('recording-export-options: gif dimensions are required')
    // Single pass palette generation + application: one process, no intermediate files.
    // `stats_mode=diff` budgets the palette for what changes between frames, and a bayer
    // dither keeps the gradient banding of a screen recording under control.
    // Three filter chains, so the graph is `;`-separated: the trimmed source is split into
    // a palette pass and the frames that are quantised with it.
    const gifSource = filters.video.replace(/\[v\]$/, `,fps=${fps},scale=${width}:${height}:flags=lanczos`)
    const gifGraph = [
      `${gifSource},split[gifA][gifB]`,
      '[gifA]palettegen=stats_mode=diff[gifPalette]',
      '[gifB][gifPalette]paletteuse=dither=bayer:bayer_scale=5[gifOut]'
    ].join(';')
    return {
      args: [
        ...head,
        '-filter_complex', gifGraph,
        '-map', '[gifOut]',
        '-an',
        '-loop', '0',
        ...progress,
        '-y', outputPath
      ],
      expected: { format, durationMs: window.spanMs, width, height, hasAudio: false, fps }
    }
  }

  // Publish verification tolerance for a finished encode (plan §8.4: verify decodable,
  // format, dimensions and the selected span before replacing the user's target).
  function durationToleranceMs(expected, { isGif = false } = {}) {
    const span = Math.max(0, finiteNumber(expected) || 0)
    const base = Math.max(LIMITS.VERIFY_MIN_TOLERANCE_MS, span * LIMITS.VERIFY_TOLERANCE_RATIO)
    return Math.round(base + (isGif ? LIMITS.GIF_VERIFY_EXTRA_TOLERANCE_MS : 0))
  }

  // The renderer's request shape (plan §8.3). Returns the exact payload the controller
  // forwards to the service, or a stable error code. The renderer never supplies a path.
  function toExportRequest({ sessionId, requestId, request } = {}) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!id) return fail('invalid-request')
    const requestKey = typeof requestId === 'string' ? requestId.trim() : ''
    if (!requestKey || requestKey.length > 128) return fail('invalid-request')
    const source = isPlainObject(request) ? request : {}
    const format = typeof source.format === 'string' ? source.format : ''
    if (!EXPORT_FORMATS.includes(format)) return fail('unsupported-format')
    const range = isPlainObject(source.range) ? source.range : {}
    return {
      ok: true,
      value: {
        sessionId: id,
        requestId: requestKey,
        format,
        range: { startMs: range.startMs, endMs: range.endMs },
        gif: format === 'gif' ? source.gif : undefined
      }
    }
  }

  // Stable per-request key used for replay: same key + same parameters returns the same
  // task; same key + different parameters is `request-mismatch` (plan §8.3).
  function requestSignature(request) {
    const gif = isPlainObject(request?.gif)
      ? `${Math.round(Number(request.gif.maxEdgePx) || 0)}x${Math.round(Number(request.gif.fps) || 0)}`
      : '-'
    return [
      request?.format || '',
      Math.round(Number(request?.range?.startMs) || 0),
      Math.round(Number(request?.range?.endMs) || 0),
      gif
    ].join('|')
  }

  return {
    EXPORT_FORMATS,
    EXPORT_TASK_STATES,
    GIF_FRAME_RATES,
    LIMITS,
    SESSION_STATES,
    SESSION_TRANSITIONS,
    TASK_TRANSITIONS,
    TERMINAL_TASK_STATES,
    buildExportArgs,
    computeGifDimensions,
    durationToleranceMs,
    estimateGifFrames,
    exportWindow,
    isTerminalTaskState,
    normalizeExportRequest,
    normalizeGifOptions,
    normalizeRange,
    requestSignature,
    sessionTransition,
    taskTransition,
    toExportRequest
  }
})
