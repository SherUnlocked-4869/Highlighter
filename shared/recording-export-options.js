// Recording trim + MP4/GIF/WebM export options, v2 (feature E plan §8, extended by the R4
// contract: docs/plans/2026-11-03-recording-r4-contracts.md §4).
//
// This module is the ONE place that decides (a) which export request is legal, (b) what the
// normalised request/expected shapes are, and (c) which whitelisted ffmpeg argv that request
// turns into. Both sides use it:
//   * the main process validates the renderer request here and builds argv here, so a
//     renderer can never smuggle an arbitrary ffmpeg flag, path or time span;
//   * the editor UI (`record/editor-timeline.js`) uses the same resolution/segment helpers for
//     its preview numbers, so "what the UI predicts" and "what the encoder does" cannot drift.
//
// UMD wrapper matches shared/region-presets.js: `require()` in the main process and in tests,
// `<script>` in a window (`window.recordingExportOptions`). The file is PURE: no Electron, no
// node:fs, no process, no clock.
//
// ---------------------------------------------------------------------------
// v2 request / normalised value (frozen contract §4.1/§4.2)
// ---------------------------------------------------------------------------
// Request:  { format: 'mp4'|'gif'|'webm', segments?: [{startMs,endMs}], range?: {startMs,endMs},
//             gif?: { edge, fps }, video?: { resolution, quality, fps } }
// Value:    { format, segments, totalDurationMs, gif, hasAudio, video, sourceWidth,
//             sourceHeight, sourceFrameRate }
// `segments` is the only selection form downstream code should read; `range` is accepted for
// compatibility with the R1-R3 single-segment callers and the legacy trim controller.
//
// ---------------------------------------------------------------------------
// Time basis and rounding (read before changing; plan §8.5 asks for one rule)
// ---------------------------------------------------------------------------
// All times are integer MILLISECONDS on the *media timeline*: 0 is the first frame the
// container's timeline exposes, i.e. what an HTML <video> reports as currentTime. Every kept
// segment is the half-open source interval [startMs, endMs). The probe reports the container's
// `start` offset separately as `startMs` for diagnostics; it is deliberately NOT added to a
// range, because `-ss` seeks in the same timeline the preview plays.
//
// ---------------------------------------------------------------------------
// ffmpeg assembly (contract §4.3)
// ---------------------------------------------------------------------------
// Multi-segment MP4/WebM/GIF is always "decode + cut + concat": one input per segment, an exact
// trim/atrim filter per input, then a concat filter (N=1 included so there is ONE code path).
// Stream copy is used ONLY for the WebM fast path (full range, source resolution, source fps):
// copying a non-keyframe boundary would silently break the selection.
//
// ---------------------------------------------------------------------------
// GIF guard rails (plan §3.3, MVP values - not measured optima)
// ---------------------------------------------------------------------------
// Total kept duration <= 60 s, never upscale, long edge <= 1280 px, fps in {10,15,20}, <= 1200
// frames. The UI shows the estimated frame count up front and refuses to submit an
// out-of-budget request; the main process re-validates the same numbers server-side.
;(function initRecordingExportOptions(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.recordingExportOptions = api
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const EXPORT_FORMATS = Object.freeze(['mp4', 'gif', 'webm'])
  const GIF_FRAME_RATES = Object.freeze([10, 15, 20])
  const SESSION_STATES = Object.freeze(['capturing', 'finalizing', 'ready', 'closing', 'closed', 'failed'])
  const EXPORT_TASK_STATES = Object.freeze([
    'queued', 'running', 'publishing', 'succeeded', 'failed', 'cancelling', 'cancelled'
  ])
  // R4 §4.2: resolution presets are LONG-EDGE CAPS (never widths, never upscaled). 'source'
  // means "keep the source dimensions". Mirrors record/editor-timeline.js, which owns the UI.
  const RESOLUTION_PRESETS = Object.freeze({ '1080p': 1920, '720p': 1280, '480p': 854 })
  const RESOLUTIONS = Object.freeze(['source', '1080p', '720p', '480p'])
  // Mirrors QUALITY_LEVELS in shared/recording-quality.js (frozen contract §4); duplicated so
  // this module stays a dependency-free classic script.
  const VIDEO_QUALITY_LEVELS = Object.freeze(['standard', 'high', 'ultra'])
  const VIDEO_FRAME_RATES = Object.freeze([30, 60])
  const DEFAULT_VIDEO = Object.freeze({ resolution: 'source', quality: 'standard', fps: 'source' })
  // Contract §3.1/§4.2: at most 20 kept segments, each at least the exporter's MIN_RANGE_MS.
  const MAX_SEGMENTS = 20
  // R4 §4.3 quality mapping. CRF is per-codec (`0` is lossless, higher is smaller/lower quality).
  const VIDEO_CRF = Object.freeze({
    mp4: Object.freeze({ standard: 28, high: 23, ultra: 18 }),
    webm: Object.freeze({ standard: 34, high: 28, ultra: 22 })
  })

  const LIMITS = Object.freeze({
    // Plan §3.3 video export row: one encoder, at most two queued tasks.
    MAX_ACTIVE_TASKS: 1,
    MAX_QUEUED_TASKS: 2,
    // Plan §3.3 GIF row.
    GIF_MAX_DURATION_MS: 60000,
    GIF_MAX_EDGE_PX: 1280,
    GIF_MAX_FRAMES: 1200,
    GIF_MIN_EDGE_PX: 16,
    // A range/segment shorter than this is a mis-click, not an edit.
    MIN_RANGE_MS: 100,
    // R4 §3.1: the same floor expressed for the segment normaliser.
    MIN_SEGMENT_MS: 100,
    // R4 §3.1/§4.1: at most 20 kept segments.
    MAX_SEGMENTS: 20,
    // Input seek distance before the exact filter trim. Long enough that the decoder has
    // a keyframe to start from (WebM keyframe intervals are seconds, not frames) while
    // still making a head-trim of a 30 minute recording cost seconds, not minutes.
    PREROLL_MS: 2000,
    // Publish verification: a finished encode must be within this tolerance of the
    // requested span. One source frame plus AAC priming is ~120 ms; the floor keeps a
    // 200 ms selection from failing on rounding. Multi-segment adds one frame boundary per
    // extra segment (durationToleranceMs below).
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

  // R5 §3.2: the demo plan is owned by shared/recording-demo.js. Lazy lookup keeps this module
  // loadable alone (node require / window global) and avoids a require cycle (that module also
  // looks us up lazily for computeVideoOutput).
  function demoModule() {
    try {
      if (typeof module === 'object' && module.exports && typeof require === 'function') {
        return require('./recording-demo')
      }
    } catch {
      // Fall through to the window global.
    }
    const scope = typeof globalThis === 'object' ? globalThis : null
    return scope && scope.recordingDemo ? scope.recordingDemo : null
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
  // Single-range normalisation (legacy compatibility, R1-R3 shape)
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

  // A clamped selection whose single segment spans the whole recording is canonicalised to
  // exactly [{0,duration}]: the empty-segments request, the explicit full range and the legacy
  // full range then produce the same normalised value (and the same request signature).
  function canonicalSegments(segments, durationMs) {
    if (segments.length === 1) {
      const segment = segments[0]
      if (segment.startMs <= 1 && segment.endMs >= durationMs - 1) return [{ startMs: 0, endMs: durationMs }]
    }
    return segments
  }

  function isFullRange(segments, durationMs) {
    const duration = Math.round(finiteNumber(durationMs) || 0)
    if (!(duration > 0) || !Array.isArray(segments) || segments.length !== 1) return false
    const segment = segments[0]
    return !!segment && segment.startMs <= 1 && segment.endMs >= duration - 1
  }

  // ---------------------------------------------------------------------------
  // Multi-segment normalisation (R4 §3.1/§4.1)
  // ---------------------------------------------------------------------------

  // `input` is the renderer's `segments` array (or absent). Returns
  // `{ ok:true, value: { segments, totalDurationMs } }` or a stable error code.
  // Rules: 1-20 segments, sorted by start, non-overlapping (touching is allowed and never
  // merged), each >= MIN_SEGMENT_MS, 0 <= start < end <= duration. An empty array means the
  // whole recording (contract §4.1 "省略/空 = 整段") and becomes [{0,duration}].
  function normalizeSegments(input, durationMs) {
    const duration = Math.round(finiteNumber(durationMs) || 0)
    if (!(duration > 0)) return fail('duration-unavailable')
    if (!Array.isArray(input)) return fail('invalid-range')
    if (input.length > MAX_SEGMENTS) return fail('too-many-segments')
    if (input.length === 0) {
      return { ok: true, value: { segments: [{ startMs: 0, endMs: duration }], totalDurationMs: duration } }
    }
    const segments = []
    for (const entry of input) {
      if (!isPlainObject(entry)) return fail('invalid-range')
      const start = finiteNumber(entry.startMs)
      const end = finiteNumber(entry.endMs)
      if (start === null || end === null) return fail('invalid-range')
      const roundedStart = Math.round(start)
      const roundedEnd = Math.round(end)
      if (roundedStart < -1 || roundedEnd > duration + 1) return fail('range-out-of-bounds')
      const startMs = Math.max(0, Math.min(roundedStart, Math.floor(duration)))
      const endMs = Math.max(0, Math.min(roundedEnd, Math.ceil(duration)))
      if (!(startMs < endMs)) return fail('invalid-range')
      if (endMs - startMs < LIMITS.MIN_SEGMENT_MS) return fail('range-too-short')
      segments.push({ startMs, endMs })
    }
    segments.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    for (let index = 1; index < segments.length; index += 1) {
      // Overlap is explicit (not silently dropped): the UI must not send an ambiguous
      // selection. Adjacency (prev.end === next.start) is legal.
      if (segments[index].startMs < segments[index - 1].endMs) return fail('overlapping-segments')
    }
    const canonical = canonicalSegments(segments, duration)
    const totalDurationMs = canonical.reduce((sum, segment) => sum + (segment.endMs - segment.startMs), 0)
    return { ok: true, value: { segments: canonical, totalDurationMs } }
  }

  // ---------------------------------------------------------------------------
  // Resolution / quality / fps (R4 §4.2)
  // ---------------------------------------------------------------------------

  function clampUnit(value) {
    const number = finiteNumber(value)
    return (number === null ? 0 : Math.max(0, Math.min(1, number))).toFixed(4)
  }

  // ---------------------------------------------------------------------------
  // F03 (review 2026-11-26 §3.3): ripple packing for the demo graph.
  // ---------------------------------------------------------------------------
  // The per-click chain gives every click its own `-loop 1 -i ripple.png` input, a scale node
  // and an overlay node: 30 clicks = 30 inputs + 60 filter nodes. A click's ring is visible
  // for exactly RIPPLE_WINDOW_MS, so clicks whose windows do not touch can share ONE looped
  // input whose per-frame expressions switch size/position/visibility to whichever click is
  // active. Every ring uses the same white asset, and compositing identical-colour layers
  // commutes, so packing lanes does not change the rendered pixels.
  //
  // MAX_RIPPLE_LAYERS is 2 (=> at most 2 inputs + 4 filter nodes). A denser burst (3+ rings on
  // screen at once) cannot be packed into two lanes without reordering the composite, so it
  // keeps the exact per-click chain instead; correctness wins over node count for that burst.
  const RIPPLE_WINDOW_MS = 600
  const MAX_RIPPLE_LAYERS = 2

  function rippleEntries(clicks) {
    return (Array.isArray(clicks) ? clicks : []).map((click) => {
      const startMs = Math.max(0, Math.round(finiteNumber(click?.tMs) || 0))
      return {
        startMs,
        endMs: startMs + RIPPLE_WINDOW_MS,
        focusX: clampUnit(click?.x),
        focusY: clampUnit(click?.y)
      }
    })
  }

  // Exactly the per-click expression, so a one-click film keeps the historical graph.
  function rippleSizeExpression(entry) {
    const startSeconds = (entry.startMs / 1000).toFixed(6)
    return `96*(0.35+0.65*min(1,max(0,(t-${startSeconds})/0.6)))`
  }

  function rippleWindow(entry) {
    return {
      startSeconds: (entry.startMs / 1000).toFixed(6),
      endSeconds: (entry.endMs / 1000).toFixed(6)
    }
  }

  // Lane-major compositing (lane 0 first, then lane 1) preserves the historical per-click
  // order only when, for every pair of OVERLAPPING windows, the earlier click's lane comes
  // first. Greedy packing can violate that (a later click can land in an earlier lane), and a
  // swapped pair of translucent overlays can differ by a rounding step at the intersection.
  // Such a burst keeps the per-click chain so the rendered frames stay byte-identical.
  function rippleOrderPreserved(sorted, lanes) {
    const laneOf = new Map()
    lanes.forEach((lane, laneIndex) => {
      for (const entry of lane.entries) laneOf.set(entry, laneIndex)
    })
    for (let index = 0; index < sorted.length; index += 1) {
      const earlier = sorted[index]
      for (let laterIndex = index + 1; laterIndex < sorted.length; laterIndex += 1) {
        const later = sorted[laterIndex]
        // Disjoint windows never composite together, so their order is irrelevant.
        if (later.startMs > earlier.endMs) continue
        if ((laneOf.get(earlier) ?? 0) > (laneOf.get(later) ?? 0)) return false
      }
    }
    return true
  }

  // Greedy interval packing (first fit by start time; optimal for interval graphs). Returns
  // one layer per non-overlapping lane, or null when the burst needs more than
  // MAX_RIPPLE_LAYERS lanes OR lane-major order would not match the per-click order (the
  // caller then keeps the per-click chain, which is pixel-identical by construction).
  function planRippleLayers(clicks) {
    const entries = rippleEntries(clicks)
    if (!entries.length) return []
    const sorted = entries.slice().sort((left, right) => left.startMs - right.startMs)
    const lanes = []
    for (const entry of sorted) {
      // `between()` is inclusive on both ends: windows [a, a+600] and [b, b+600] share the
      // instant b === a+600, so a lane may only take a click that starts STRICTLY later.
      const lane = lanes.find((candidate) => entry.startMs > candidate.endMs)
      if (lane) {
        lane.endMs = entry.endMs
        lane.entries.push(entry)
        continue
      }
      if (lanes.length >= MAX_RIPPLE_LAYERS) return null
      lanes.push({ endMs: entry.endMs, entries: [entry] })
    }
    if (!rippleOrderPreserved(sorted, lanes)) return null
    return lanes.map((lane) => {
      const windows = lane.entries.map((entry) => {
        const window = rippleWindow(entry)
        return {
          ...window,
          size: rippleSizeExpression(entry),
          x: `${entry.focusX}*W-w/2`,
          y: `${entry.focusY}*H-h/2`
        }
      })
      if (windows.length === 1) {
        const only = windows[0]
        return {
          sizeExpression: only.size,
          xExpression: only.x,
          yExpression: only.y,
          enableExpression: `between(t,${only.startSeconds},${only.endSeconds})`
        }
      }
      // Inactive frames fall back to a 2x2 ring (overlay is disabled there, but a zero-sized
      // scale argument is rejected by ffmpeg) and a 0,0 overlay position.
      const sizeExpression = windows.reduceRight(
        (fallback, window) => `if(between(t,${window.startSeconds},${window.endSeconds}),${window.size},${fallback})`,
        '2'
      )
      const xExpression = windows.reduceRight(
        (fallback, window) => `if(between(t,${window.startSeconds},${window.endSeconds}),${window.x},${fallback})`,
        '0'
      )
      const yExpression = windows.reduceRight(
        (fallback, window) => `if(between(t,${window.startSeconds},${window.endSeconds}),${window.y},${fallback})`,
        '0'
      )
      return {
        sizeExpression,
        xExpression,
        yExpression,
        enableExpression: windows.map((window) => `between(t,${window.startSeconds},${window.endSeconds})`).join('+')
      }
    })
  }

  // ---------------------------------------------------------------------------
  // N03/DEV-05: keystroke capsule overlay (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md
  // DEV-05). The editor already previews the shortcuts a take captured (N03 HUD); this section
  // carries the same capsules into the exported film.
  //
  // The renderer sends SOURCE-time capsules; this module projects them onto the kept segments
  // exactly like shared/recording-demo.js maps zooms/clicks, so trimmed-out time can never show a
  // capsule. Windows are half-open [tMs, endMs) so a capsule that starts on a cut boundary is
  // shown by the segment that owns the frame, and a capsule whose 1100 ms preview window crosses a
  // cut is truncated at that boundary instead of leaking into the next segment.
  //
  // Privacy: only the frozen capture allowlist (modifier chords + navigation/function keys) can
  // reach the filter graph. Anything else is dropped here, so an events.json written by another
  // build still cannot inject arbitrary text into the encoder's asset pipeline.
  const KEYSTROKE_OVERLAY_LIMITS = Object.freeze({
    // Same cap the editor HUD normalises to (record/trim-controller.js KEYSTROKE_CAPSULE_LIMIT):
    // preview and export must agree on how many events they consider.
    MAX_ITEMS: 500,
    // Preview display window (record/editor.js KEYSTROKE_CAPSULE_MS).
    DISPLAY_MS: 1100,
    COMBO_MAX_LENGTH: 48,
    // P2-05 filter/material budget. appendKeystrokeOverlay composes ONE looped PNG input and ONE
    // overlay node per DISTINCT label (never one per window), so the window count only adds
    // `gte()/lt()` terms to that label's enable expression: 300 presses of the same shortcut cost
    // one node, not 300 chained overlays. The cap therefore matches the editor's 500-capsule
    // sequence exactly, and 240 no longer silently hides the tail the preview showed.
    // It is still enforced for a hand-built/older caller: windows past the cap are dropped and
    // disclosed through `truncated` / `dropped` instead of disappearing silently.
    MAX_RENDER_WINDOWS: 500,
    // One looped PNG input per unique label: bound the number of extra ffmpeg inputs/overlay
    // nodes. Exceeding it drops whole labels, and `dropped` carries the exact counts and
    // source-time range so the editor can warn BEFORE the user confirms the export.
    MAX_LABELS: 64
  })
  const KEYSTROKE_NAMED_KEY = 'Space|Esc|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|(?:F(?:[1-9]|1[0-2]))'
  const KEYSTROKE_CHORD_PATTERN = new RegExp(`^(?:(?:Ctrl|Alt|Shift|Win)\\+){1,4}(?:[A-Z0-9]|${KEYSTROKE_NAMED_KEY})$`)
  const KEYSTROKE_SINGLE_PATTERN = new RegExp(`^(?:${KEYSTROKE_NAMED_KEY})$`)

  // Untrimmed on purpose: surrounding whitespace means the label did not come from the capture
  // policy, so it is invalid rather than silently normalised.
  function isValidKeystrokeCombo(value) {
    const combo = typeof value === 'string' ? value : ''
    if (!combo || combo.length > KEYSTROKE_OVERLAY_LIMITS.COMBO_MAX_LENGTH || combo !== combo.trim()) return false
    return KEYSTROKE_CHORD_PATTERN.test(combo) || KEYSTROKE_SINGLE_PATTERN.test(combo)
  }

  // Capsule geometry in OUTPUT pixels. Shared by the main-process rasteriser (which needs the PNG
  // size) and the ffmpeg graph (which needs the bottom margin), so both agree on the surface.
  function keystrokeOverlayMarginBottom(surfaceHeight) {
    const height = finiteNumber(surfaceHeight) || 0
    return Math.max(6, Math.round(height * 0.05))
  }

  function keystrokeCapsuleMetrics({ surfaceWidth = 0, surfaceHeight = 0, combo = '' } = {}) {
    const surface = Math.max(1, Math.round(finiteNumber(surfaceHeight) || 0))
    const widthLimit = Math.max(1, Math.round(finiteNumber(surfaceWidth) || 0))
    const label = typeof combo === 'string' ? combo : ''
    const height = Math.max(24, Math.min(96, Math.round(surface * 0.052)))
    const fontSize = Math.max(11, Math.round(height * 0.46))
    const paddingX = Math.max(8, Math.round(height * 0.52))
    // Segoe UI semibold caps are ~0.62 em wide; the fallback stack is close enough for a pill.
    const textWidth = Math.ceil(label.length * fontSize * 0.62)
    const width = Math.min(Math.max(height * 2, textWidth + paddingX * 2), Math.max(height * 2, widthLimit))
    return {
      width: Math.round(width),
      height,
      fontSize,
      paddingX,
      radius: Math.round(height / 2),
      marginBottom: keystrokeOverlayMarginBottom(surface)
    }
  }

  // The surface the capsules are composited onto: the demo canvas when the demo pipeline renders,
  // the GIF output, otherwise the encoded video size. 0x0 means "unknown" and the caller refuses
  // the overlay instead of guessing a coordinate space.
  function resolveKeystrokeSurface(value = {}) {
    const request = isPlainObject(value) ? value : {}
    if (request.format === 'gif') {
      return { width: Math.round(finiteNumber(request.gif?.width) || 0), height: Math.round(finiteNumber(request.gif?.height) || 0) }
    }
    const demo = isPlainObject(request.demo) && request.demo.rendered === true ? request.demo : null
    if (demo) {
      return { width: Math.round(finiteNumber(demo.canvasWidth) || 0), height: Math.round(finiteNumber(demo.canvasHeight) || 0) }
    }
    return {
      width: Math.round(finiteNumber(request.video?.width) || 0),
      height: Math.round(finiteNumber(request.video?.height) || 0)
    }
  }

  // Projects SOURCE-time capsules onto the output timeline and resolves the preview's visibility
  // rules (1100 ms window, same-time priority: the capsule that started last wins, so an earlier
  // one is cut short by the next capsule). Returns `{ ok:true, value:null }` for "overlay off".
  //
  // P2-05: the editor preview and the exported film must show ONE sequence, so the value carries
  // the visible plan in both coordinate spaces:
  //   * `items`       - OUTPUT-time windows, exactly what the ffmpeg graph composites;
  //   * `sourceItems` - the same windows back in SOURCE time (a kept segment maps linearly, a cut
  //                     only clips the window end), which the editor HUD plays against the media
  //                     clock.
  // When a retained material cap drops windows, `items`/`sourceItems` are the KEPT plan and
  // `total`/`dropped` describe the truncation precisely (capsule count, distinct label count,
  // first/last dropped SOURCE time) so the editor can disclose it before the user confirms.
  function normalizeKeystrokeOverlay(input, segments, durationMs = 0) {
    if (input === undefined || input === null) return { ok: true, value: null }
    if (!isPlainObject(input)) return fail('invalid-keystroke-option')
    if (typeof input.enabled !== 'boolean') return fail('invalid-keystroke-option')
    if (input.enabled !== true) return { ok: true, value: null }
    if (!Array.isArray(input.items)) return fail('invalid-keystroke-option')
    const limit = Math.max(0, Math.round(finiteNumber(durationMs) || 0))
    const ranges = Array.isArray(segments) ? segments : []
    const projected = []
    for (const entry of input.items.slice(0, KEYSTROKE_OVERLAY_LIMITS.MAX_ITEMS * 2)) {
      if (!isPlainObject(entry)) continue
      if (!isValidKeystrokeCombo(entry.combo)) continue
      const rawMs = finiteNumber(entry.tMs)
      if (rawMs === null) continue
      const sourceMs = Math.round(rawMs)
      if (!Number.isFinite(sourceMs) || sourceMs < 0) continue
      if (limit > 0 && sourceMs > limit) continue
      // Source time -> output time through the kept segments. A capsule inside a trimmed-out
      // range has no output position at all and is dropped.
      let outputStart = 0
      for (const segment of ranges) {
        const startMs = Math.max(0, Math.round(finiteNumber(segment?.startMs) || 0))
        const endMs = Math.max(startMs, Math.round(finiteNumber(segment?.endMs) || 0))
        const spanMs = endMs - startMs
        if (sourceMs >= startMs && sourceMs < endMs) {
          projected.push({
            tMs: outputStart + (sourceMs - startMs),
            segmentEndMs: outputStart + spanMs,
            combo: String(entry.combo),
            sourceMs
          })
          break
        }
        outputStart += spanMs
      }
    }
    projected.sort((left, right) => left.tMs - right.tMs)
    const visible = []
    for (let index = 0; index < projected.length; index += 1) {
      const entry = projected[index]
      let endMs = Math.min(entry.tMs + KEYSTROKE_OVERLAY_LIMITS.DISPLAY_MS, entry.segmentEndMs)
      const next = projected[index + 1]
      // Same-time priority: the later entry in time order wins from its first frame, matching
      // record/editor.js activeKeystrokeCapsule() (the last item in range wins).
      if (next) endMs = Math.min(endMs, Math.max(entry.tMs, next.tMs))
      if (!(endMs > entry.tMs)) continue
      visible.push({ tMs: entry.tMs, endMs, combo: entry.combo, sourceMs: entry.sourceMs })
    }
    const labels = []
    for (const window of visible) {
      if (!labels.includes(window.combo)) labels.push(window.combo)
    }
    // Material caps: keep the first MAX_LABELS distinct labels (first-appearance order), then the
    // first MAX_RENDER_WINDOWS of the survivors. Every removed window is collected so the exact
    // truncation can be reported instead of just a boolean.
    let kept = []
    const droppedWindows = []
    if (labels.length > KEYSTROKE_OVERLAY_LIMITS.MAX_LABELS) {
      const allowed = new Set(labels.slice(0, KEYSTROKE_OVERLAY_LIMITS.MAX_LABELS))
      for (const window of visible) {
        if (allowed.has(window.combo)) kept.push(window)
        else droppedWindows.push(window)
      }
    } else {
      kept = visible.slice()
    }
    if (kept.length > KEYSTROKE_OVERLAY_LIMITS.MAX_RENDER_WINDOWS) {
      droppedWindows.push(...kept.slice(KEYSTROKE_OVERLAY_LIMITS.MAX_RENDER_WINDOWS))
      kept = kept.slice(0, KEYSTROKE_OVERLAY_LIMITS.MAX_RENDER_WINDOWS)
    }
    const droppedLabels = []
    for (const window of droppedWindows) {
      if (!droppedLabels.includes(window.combo)) droppedLabels.push(window.combo)
    }
    // A null sentinel (not 0) so a capsule whose source time IS 0 cannot be mistaken for
    // "no dropped capsule yet" by the min/max loop.
    let firstDroppedMs = null
    let lastDroppedMs = null
    for (const window of droppedWindows) {
      if (!(window.sourceMs >= 0)) continue
      if (firstDroppedMs === null || window.sourceMs < firstDroppedMs) firstDroppedMs = window.sourceMs
      if (lastDroppedMs === null || window.sourceMs > lastDroppedMs) lastDroppedMs = window.sourceMs
    }
    if (firstDroppedMs === null) firstDroppedMs = 0
    if (lastDroppedMs === null) lastDroppedMs = 0
    return {
      ok: true,
      value: {
        enabled: true,
        displayMs: KEYSTROKE_OVERLAY_LIMITS.DISPLAY_MS,
        items: kept.map((window) => ({ tMs: window.tMs, endMs: window.endMs, combo: window.combo })),
        // The window span is identical in both timelines inside one kept segment, so the editor
        // HUD can stay on the media clock without owning the projection rules.
        sourceItems: kept.map((window) => ({
          tMs: window.sourceMs,
          durationMs: window.endMs - window.tMs,
          combo: window.combo
        })),
        truncated: droppedWindows.length > 0,
        total: { windows: visible.length, labels: labels.length },
        dropped: droppedWindows.length > 0
          ? {
              items: droppedWindows.length,
              labels: droppedLabels.length,
              firstSourceMs: firstDroppedMs,
              lastSourceMs: lastDroppedMs
            }
          : null
      }
    }
  }

  // ---------------------------------------------------------------------------
  // F03: hardware H.264 encoders for MP4 output (mirrors record/recording-utils.js).
  // ---------------------------------------------------------------------------
  // `videoEncoder` is an OPTIONAL build-time hint from the main process's capability probe;
  // without it (or with an unknown name) the argv is byte-identical to the historical
  // libx264/veryfast/CRF command. Muxer, extension and audio mapping never depend on it.
  const SOFTWARE_VIDEO_ENCODER = 'libx264'
  const HARDWARE_VIDEO_ENCODERS = Object.freeze(['h264_nvenc', 'h264_qsv', 'h264_amf'])

  function normalizeVideoEncoder(value) {
    const name = typeof value === 'string' ? value.trim() : ''
    return HARDWARE_VIDEO_ENCODERS.includes(name) ? name : SOFTWARE_VIDEO_ENCODER
  }

  // Per-encoder quality flags for H.264 MP4 output; `crf` is the software CRF value.
  function mp4VideoEncoderArgs(value, crf) {
    const encoder = normalizeVideoEncoder(value)
    const quality = String(Math.round(finiteNumber(crf) ?? 23))
    if (encoder === 'h264_nvenc') {
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', quality, '-b:v', '0']
    }
    if (encoder === 'h264_qsv') {
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', quality]
    }
    if (encoder === 'h264_amf') {
      return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', quality, '-qp_p', quality]
    }
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', quality]
  }

  function evenDimension(value) {
    // Contract formula: even(round(value)), minimum 2. `resolution:'source'` on the usual
    // even-sized canvas is the identity; a preset can only shrink (scale <= 1).
    return Math.max(2, Math.round(Number(value) / 2) * 2)
  }

  // Pure helper shared with the editor UI. `resolution` is one of RESOLUTIONS and the preset is
  // a LONG-EDGE CAP: scale = min(1, preset/max(width,height)); both output dimensions are even
  // and never larger than the source. Returns `{ ok:true, value:{ resolution,width,height,
  // scale,upscaled } }`; `upscaled` is always false by construction (the key exists so nothing
  // downstream ever has to guess).
  function computeVideoOutput({ sourceWidth, sourceHeight, resolution = DEFAULT_VIDEO.resolution } = {}) {
    const width = finiteNumber(sourceWidth)
    const height = finiteNumber(sourceHeight)
    if (width === null || height === null || width <= 0 || height <= 0) return fail('invalid-source-size')
    const requested = resolution === undefined || resolution === null ? DEFAULT_VIDEO.resolution : resolution
    if (!RESOLUTIONS.includes(requested)) return fail('invalid-video-option')
    const sourceWidthValue = Math.max(1, Math.round(width))
    const sourceHeightValue = Math.max(1, Math.round(height))
    const longEdge = Math.max(sourceWidthValue, sourceHeightValue)
    const cap = requested === 'source' ? longEdge : RESOLUTION_PRESETS[requested]
    const scale = requested === 'source' ? 1 : Math.min(1, cap / longEdge)
    return {
      ok: true,
      value: {
        resolution: requested,
        width: evenDimension(sourceWidthValue * scale),
        height: evenDimension(sourceHeightValue * scale),
        scale,
        upscaled: false
      }
    }
  }

  // Contract §4.2 video options. `format` is 'mp4' or 'webm' (GIF ignores video entirely);
  // `fullRange` decides the WebM copy fast path.
  function normalizeVideoOptions(input, metadata, format, fullRange) {
    const source = isPlainObject(input) ? input : {}
    const resolution = source.resolution === undefined || source.resolution === null
      ? DEFAULT_VIDEO.resolution
      : source.resolution
    if (!RESOLUTIONS.includes(resolution)) return fail('invalid-video-option')
    const quality = source.quality === undefined || source.quality === null
      ? DEFAULT_VIDEO.quality
      : source.quality
    if (!VIDEO_QUALITY_LEVELS.includes(quality)) return fail('invalid-video-option')

    const sourceFrameRate = (() => {
      const rate = finiteNumber(metadata?.video?.frameRate)
      return rate !== null && rate > 0 ? rate : 0
    })()
    let fps = DEFAULT_VIDEO.fps
    if (source.fps !== undefined && source.fps !== null && source.fps !== 'source') {
      const requested = Number(source.fps)
      if (!VIDEO_FRAME_RATES.includes(requested)) return fail('invalid-video-option')
      // A frame rate above the source cannot create detail; it can only duplicate frames.
      if (sourceFrameRate > 0 && requested > sourceFrameRate + 0.5) return fail('fps-above-source')
      fps = requested
    }
    // 'source' keeps the source rate; 0 means "leave the timeline alone" (unknown rate).
    const fpsValue = fps === 'source' ? Math.round(sourceFrameRate) : fps

    const sourceWidth = Math.round(finiteNumber(metadata?.video?.width) || 0)
    const sourceHeight = Math.round(finiteNumber(metadata?.video?.height) || 0)
    const copy = format === 'webm' && fullRange === true && resolution === 'source' && fps === 'source'
    if (copy) {
      // Stream copy cannot change dimensions: the copy path reports the source size even
      // when the probe reported an odd size.
      return {
        ok: true,
        value: { resolution, quality, fps, width: sourceWidth, height: sourceHeight, fpsValue, copy: true }
      }
    }
    if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
      // A probe without dimensions cannot be scaled. Keep the historical "unknown = skip the
      // dimension check" behaviour for the source-resolution encode path.
      if (resolution !== 'source') return fail('invalid-video-option')
      return {
        ok: true,
        value: { resolution, quality, fps, width: 0, height: 0, fpsValue, copy: false }
      }
    }
    const output = computeVideoOutput({ sourceWidth, sourceHeight, resolution })
    if (!output.ok) return output
    return {
      ok: true,
      value: {
        resolution,
        quality,
        fps,
        width: output.value.width,
        height: output.value.height,
        fpsValue,
        copy: false
      }
    }
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
  // `durationMs` is the TOTAL KEPT duration for a multi-segment selection: the GIF budget is
  // about how much footage the file contains, not the source length.
  function normalizeGifOptions(input, source, durationMs) {
    const options = isPlainObject(input) ? input : {}
    const metrics = isPlainObject(source?.video) ? source.video : (isPlainObject(source) ? source : {})
    const duration = finiteNumber(durationMs)
    if (duration === null || duration <= 0) return fail('duration-unavailable')
    if (duration > LIMITS.GIF_MAX_DURATION_MS) return fail('gif-too-long')
    const fps = Math.round(finiteNumber(options.fps) ?? 0)
    if (!GIF_FRAME_RATES.includes(fps)) return fail('gif-invalid-fps')
    if (options.loop !== undefined && options.loop !== true) return fail('gif-loop-required')
    // R4 §4.1 names the request field `edge`; `maxEdgePx` is the legacy alias the trim UI and
    // earlier contracts used, so both are accepted and the normalised value carries both.
    const requestedEdge = options.edge !== undefined ? options.edge : options.maxEdgePx
    const maxEdgePx = Math.round(finiteNumber(requestedEdge) ?? LIMITS.GIF_MAX_EDGE_PX)
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
        // Contract §4.2 shape (`edge`) plus the legacy `maxEdgePx` alias; both are the OUTPUT
        // long edge, not the requested cap.
        edge: dimensions.value.edgePx,
        maxEdgePx: dimensions.value.edgePx,
        fps,
        loop: true,
        width: dimensions.value.width,
        height: dimensions.value.height,
        frames
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Request normalisation (frozen contract §4.1/§4.2)
  // ---------------------------------------------------------------------------

  // `metadata` is the probe result: `{ durationMs, video: { width, height, frameRate },
  // audio: { exists } }`. Returns `{ ok:true, value: NormalisedRequest }` or `{ ok:false, code }`.
  function normalizeExportRequest(input, metadata) {
    const request = isPlainObject(input) ? input : {}
    const format = typeof request.format === 'string' ? request.format : ''
    if (!EXPORT_FORMATS.includes(format)) return fail('unsupported-format')
    const duration = finiteNumber(metadata?.durationMs)
    if (duration === null || duration <= 0) return fail('duration-unavailable')
    const durationMs = Math.round(duration)

    // Both selection forms at once is a client bug: `segments` is authoritative and `range`
    // exists only for R1-R3 compatibility (contract §4.1 `ambiguous-selection`).
    const hasSegments = request.segments !== undefined && request.segments !== null
    const hasRange = request.range !== undefined && request.range !== null
    if (hasSegments && hasRange) return fail('ambiguous-selection')

    let selection
    if (hasSegments) {
      const normalized = normalizeSegments(request.segments, durationMs)
      if (!normalized.ok) return normalized
      selection = normalized.value
    } else if (hasRange) {
      const rangeResult = normalizeRange(request.range, durationMs)
      if (!rangeResult.ok) return rangeResult
      const segments = canonicalSegments(
        [{ startMs: rangeResult.value.startMs, endMs: rangeResult.value.endMs }],
        durationMs
      )
      selection = {
        segments,
        totalDurationMs: segments.reduce((sum, segment) => sum + (segment.endMs - segment.startMs), 0)
      }
    } else {
      // No selection = the whole recording (contract §4.1).
      selection = { segments: [{ startMs: 0, endMs: durationMs }], totalDurationMs: durationMs }
    }

    const sourceWidth = Math.round(finiteNumber(metadata?.video?.width) || 0)
    const sourceHeight = Math.round(finiteNumber(metadata?.video?.height) || 0)
    const sourceFrameRate = (() => {
      const rate = finiteNumber(metadata?.video?.frameRate)
      return rate !== null && rate > 0 ? rate : 0
    })()

    let gif = null
    let video = null
    if (format === 'gif') {
      const gifResult = normalizeGifOptions(request.gif, metadata, selection.totalDurationMs)
      if (!gifResult.ok) return gifResult
      gif = gifResult.value
    } else {
      const videoResult = normalizeVideoOptions(
        request.video,
        metadata,
        format,
        isFullRange(selection.segments, durationMs)
      )
      if (!videoResult.ok) return videoResult
      video = videoResult.value
    }

    // R5 §3.2: optional demo look/camera plan. The request carries SOURCE-time style/zooms/
    // clicks; the value carries the OUTPUT-time plan and the resolved canvas. GIF keeps its own
    // budget/steps and ignores demo (documented R5 interpretation: GIF has no canvas pipeline).
    let demoValue = null
    if (request.demo !== undefined && request.demo !== null) {
      if (!isPlainObject(request.demo)) return fail('invalid-demo-option')
      const demoApi = demoModule()
      if (!demoApi) return fail('invalid-demo-option')
      const rawStyle = request.demo.style
      const rawZooms = request.demo.zooms
      const rawClicks = request.demo.clicks
      if (rawStyle !== undefined && rawStyle !== null && !isPlainObject(rawStyle)) return fail('invalid-demo-option')
      if (rawZooms !== undefined && rawZooms !== null && !Array.isArray(rawZooms)) return fail('invalid-demo-option')
      if (rawClicks !== undefined && rawClicks !== null && !Array.isArray(rawClicks)) return fail('invalid-demo-option')
      if (format !== 'gif') {
        const mapped = demoApi.mapDemoToOutput(
          { style: rawStyle, zooms: rawZooms, clicks: rawClicks },
          selection.segments
        )
        const style = mapped.style
        const zooms = mapped.zooms.slice(0, 8)
        // Ripples only render when the user turned them on; otherwise the click list is dropped
        // here so a stale editor state cannot add overlays the style does not ask for.
        const clicks = style.ripples === true ? mapped.clicks.slice(0, 30) : []
        // A visible style needs padding or a corner radius: a shadow alone has nothing to sit
        // behind at padding 0, so it must not force the enhanced pipeline.
        const styleVisible = style.enabled === true && (style.padding > 0 || style.radius > 0)
        const rendered = styleVisible || zooms.length > 0 || clicks.length > 0
        if (rendered) {
          // recording-demo returns the bare geometry object on success (contract §3.1) and
          // `{ ok:false, code }` only when the source dimensions are unusable.
          const canvasResult = demoApi.resolveDemoCanvas({
            sourceWidth,
            sourceHeight,
            resolution: video.resolution,
            style
          })
          if (!canvasResult || canvasResult.ok === false) return fail('invalid-demo-option')
          const canvas = canvasResult.ok === true ? canvasResult.value : canvasResult
          demoValue = {
            style,
            zooms,
            clicks,
            rendered: true,
            contentWidth: canvas.contentWidth,
            contentHeight: canvas.contentHeight,
            canvasWidth: canvas.canvasWidth,
            canvasHeight: canvas.canvasHeight,
            paddingPx: canvas.paddingPx,
            radiusPx: canvas.radiusPx
          }
          // A demo film is always re-rendered: the WebM stream-copy fast path cannot composite.
          if (video) video = { ...video, copy: false }
        }
      }
    }

    // N03/DEV-05: optional keystroke capsule overlay. Absent (or explicitly disabled) keeps the
    // pre-N03 export path byte-identical: no extra inputs, no extra filters, same argv.
    let keystrokesValue = null
    if (request.keystrokes !== undefined && request.keystrokes !== null) {
      const overlay = normalizeKeystrokeOverlay(request.keystrokes, selection.segments, durationMs)
      if (!overlay.ok) return overlay
      keystrokesValue = overlay.value
      if (keystrokesValue) {
        const surface = resolveKeystrokeSurface({ format, gif, video, demo: demoValue })
        if (!(surface.width > 0) || !(surface.height > 0)) return fail('invalid-keystroke-option')
        // Compositing cannot ride the WebM stream-copy fast path.
        if (video) video = { ...video, copy: false }
      }
    }

    return {
      ok: true,
      value: {
        format,
        segments: selection.segments,
        totalDurationMs: selection.totalDurationMs,
        gif,
        // System/microphone are already mixed into one track by the recorder; the exporter only
        // needs to know whether that track exists. GIF never carries audio.
        hasAudio: format !== 'gif' && metadata?.audio?.exists === true,
        video,
        demo: demoValue,
        keystrokes: keystrokesValue,
        sourceWidth,
        sourceHeight,
        // Additive (not part of the frozen §4.2 list): publish verification needs the source
        // frame rate for the multi-segment duration tolerance. UI code may ignore it.
        sourceFrameRate
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ffmpeg argv (whitelisted flags only; never a shell string)
  // ---------------------------------------------------------------------------

  function seconds(milliseconds) {
    // ffmpeg accepts decimal seconds; 6 decimals is microsecond precision, which is finer
    // than any frame or audio sample boundary we could be asked to honour.
    return (Math.round(Number(milliseconds) || 0) / 1000).toFixed(6)
  }

  // Input seek window for one segment (contract §4.3): seek back PREROLL_MS so the decoder
  // starts on a keyframe, then trim exactly inside the filter graph.
  function segmentWindow(segment) {
    const startMs = Math.max(0, Math.round(Number(segment?.startMs) || 0))
    const endMs = Math.max(startMs, Math.round(Number(segment?.endMs) || 0))
    const seekMs = Math.max(0, startMs - LIMITS.PREROLL_MS)
    return {
      seekMs,
      relStartMs: startMs - seekMs,
      relEndMs: endMs - seekMs,
      spanMs: endMs - startMs
    }
  }

  // Legacy single-range helper kept for callers that still pass `range` to buildExportArgs
  // (the performance probe script and the R1-R3 tests). New code uses normalizeExportRequest's
  // `segments`.
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

  // N03/DEV-05: appends the capsule overlay chain to a filter graph. `filters`/`extraInputs` are
  // mutated; returns the new tail stream name and the number of image inputs added.
  //
  // P2-05 material budget: ONE looped PNG input AND ONE overlay node per DISTINCT label, however
  // many windows that label has. The normaliser guarantees the visible windows never overlap (a
  // later capsule shortens the previous one), so all occurrences of a label can share a single
  // overlay whose `enable` expression is the union of its half-open windows: at most one capsule
  // is ever enabled, and the pixels are identical to one overlay node per window. This is what
  // lets the editor's whole 500-capsule sequence reach the film: 300 presses of one shortcut cost
  // one input plus a 300-term expression, not 300 chained overlays. MAX_LABELS still bounds the
  // number of inputs/overlay nodes, and every window past the caps was already removed by the
  // normaliser (which reports the exact truncation).
  //
  // Half-open windows: `gte(t,start)*lt(t,end)` reproduces the normaliser's [tMs,endMs) rule, so a
  // frame on a cut/capsule boundary belongs to the later window exactly as the preview does.
  function appendKeystrokeOverlay({
    base,
    items,
    assets,
    surfaceHeight,
    inputStart,
    renderFps,
    durationSeconds,
    extraInputs,
    filters
  }) {
    const labelList = Array.isArray(assets?.labels) ? assets.labels : []
    const byName = new Map()
    for (const label of labelList) {
      if (label && typeof label.combo === 'string' && typeof label.path === 'string' && label.path) byName.set(label.combo, label)
    }
    const grouped = []
    for (const item of Array.isArray(items) ? items : []) {
      const label = byName.get(item?.combo)
      if (!label) continue
      const startMs = Math.round(finiteNumber(item.tMs) || 0)
      const endMs = Math.max(startMs, Math.round(finiteNumber(item.endMs) || 0))
      let group = grouped.find((candidate) => candidate.combo === label.combo)
      if (!group) {
        group = { combo: label.combo, label, windows: [] }
        grouped.push(group)
      }
      group.windows.push({ startMs, endMs })
    }
    if (!grouped.length) return { current: base, inputCount: 0 }
    const marginBottom = keystrokeOverlayMarginBottom(surfaceHeight)
    let current = base
    grouped.forEach((group, index) => {
      const inputIndex = inputStart + index
      extraInputs.push('-loop', '1', '-framerate', String(renderFps), '-t', durationSeconds, '-i', group.label.path)
      const enable = group.windows
        .map((window) => `gte(t,${seconds(window.startMs)})*lt(t,${seconds(window.endMs)})`)
        .join('+')
      const tail = `keystroke${index}`
      filters.push(
        `[${current}][${inputIndex}:v]overlay=x=(W-w)/2:y=H-h-${marginBottom}:` +
        `enable='${enable}':format=auto:shortest=1[${tail}]`
      )
      current = tail
    })
    return { current, inputCount: grouped.length }
  }

  function normalizeBuildVideo(options, format) {
    const source = isPlainObject(options.video) ? options.video : {}
    const resolution = RESOLUTIONS.includes(source.resolution) ? source.resolution : DEFAULT_VIDEO.resolution
    const quality = VIDEO_QUALITY_LEVELS.includes(source.quality) ? source.quality : DEFAULT_VIDEO.quality
    const fps = source.fps === 30 || source.fps === 60 ? source.fps : DEFAULT_VIDEO.fps
    const fpsValue = Math.max(0, Math.round(Number(source.fpsValue) || 0))
    const width = Math.round(Number(source.width) || 0)
    const height = Math.round(Number(source.height) || 0)
    return {
      resolution,
      quality,
      fps,
      fpsValue,
      width,
      height,
      copy: format === 'webm' && source.copy === true,
      // F03: hardware H.264 is MP4-only (WebM is VP9 by contract; GIF has no encoder choice).
      encoder: format === 'mp4' ? normalizeVideoEncoder(options.videoEncoder) : SOFTWARE_VIDEO_ENCODER
    }
  }

  // Options: the normalised request fields plus `{ inputPath, outputPath }` (contract §4.3).
  // Legacy callers may pass `{ range, gif, hasAudio, sourceWidth, sourceHeight }` instead of
  // `{ segments, video, ... }`; both produce the same single/multi-segment graph.
  // Returns `{ args, expected }`; `expected` is what the publish verification checks:
  // `{ format, durationMs, width, height, hasAudio, fps }`.
  function buildExportArgs(options = {}) {
    const inputPath = String(options.inputPath || '')
    const outputPath = String(options.outputPath || '')
    const format = options.format
    if (!inputPath || !outputPath) throw new Error('recording-export-options: input and output paths are required')
    if (!EXPORT_FORMATS.includes(format)) throw new Error('recording-export-options: unsupported format')
    const segments = Array.isArray(options.segments) && options.segments.length
      ? options.segments
      : (isPlainObject(options.range) ? [options.range] : [])
    if (!segments.length) throw new Error('recording-export-options: empty selection')
    const windows = segments.map(segmentWindow)
    const totalDurationMs = windows.reduce((sum, window) => sum + window.spanMs, 0)
    const sourceWidth = Math.round(finiteNumber(options.sourceWidth) || 0)
    const sourceHeight = Math.round(finiteNumber(options.sourceHeight) || 0)
    const hasAudio = format !== 'gif' && options.hasAudio === true
    const video = normalizeBuildVideo(options, format)
    const progress = ['-progress', 'pipe:2', '-nostats']
    // N03/DEV-05: the normalizer only ever attaches a rendered capsule plan together with the
    // main-process raster assets. A plan without assets is a main-process wiring bug, not a
    // renderer input, so it fails loudly instead of silently exporting without capsules.
    const keystrokes = isPlainObject(options.keystrokes) && options.keystrokes.enabled === true &&
      Array.isArray(options.keystrokes.items) && options.keystrokes.items.length > 0
      ? options.keystrokes
      : null
    const keystrokeAssets = keystrokes && isPlainObject(options.keystrokeAssets)
      ? options.keystrokeAssets
      : null
    if (keystrokes && !keystrokeAssets) {
      throw new Error('recording-export-options: keystroke assets are required for a keystroke overlay')
    }

    // WebM fast path (contract §4.3): full-range, source resolution, source fps -> stream copy.
    // `-map 0` keeps every stream (video + the mixed audio track); no re-encode, no filter.
    // A keystroke overlay cannot be stream-copied; normalizeExportRequest already forces
    // `copy:false` for such a request, this guard keeps a hand-built legacy call honest.
    if (video.copy && keystrokes) {
      throw new Error('recording-export-options: a keystroke overlay cannot use the WebM copy path')
    }
    if (video.copy) {
      return {
        args: ['-hide_banner', '-nostdin', '-i', inputPath, '-map', '0', '-c', 'copy', '-y', outputPath],
        expected: {
          format,
          durationMs: totalDurationMs,
          width: sourceWidth,
          height: sourceHeight,
          hasAudio,
          fps: video.fpsValue
        }
      }
    }

    const inputs = []
    const filters = []
    const wantsGif = format === 'gif'
    // GIF has its own fps/scale options and ignores `video` entirely (contract §4.1/§4.3).
    const outputFps = !wantsGif && video.fps !== 'source' ? video.fpsValue : 0
    const needsScale = !wantsGif && video.width > 0 && video.height > 0 &&
      (video.width !== sourceWidth || video.height !== sourceHeight)
    for (const [index, window] of windows.entries()) {
      // Input-level seek + duration, then an EXACT filter trim (a non-keyframe boundary cannot
      // be stream-copied, plan §8.5).
      inputs.push('-ss', seconds(window.seekMs), '-t', seconds(window.relEndMs), '-i', inputPath)
      const relStart = seconds(window.relStartMs)
      const relEnd = seconds(window.relEndMs)
      let videoChain = `[${index}:v]trim=start=${relStart}:end=${relEnd},setpts=PTS-STARTPTS`
      if (outputFps > 0) videoChain += `,fps=${outputFps}`
      if (needsScale) videoChain += `,scale=${video.width}:${video.height}:flags=lanczos`
      videoChain += `[v${index}]`
      filters.push(videoChain)
      if (hasAudio) {
        filters.push(`[${index}:a]atrim=start=${relStart}:end=${relEnd},asetpts=PTS-STARTPTS,aresample=48000[a${index}]`)
      }
    }

    const head = ['-hide_banner', '-nostdin', ...inputs]

    if (wantsGif) {
      const gif = isPlainObject(options.gif) ? options.gif : {}
      const fps = GIF_FRAME_RATES.includes(Number(gif.fps)) ? Number(gif.fps) : GIF_FRAME_RATES[1]
      const width = Math.round(finiteNumber(gif.width) || 0)
      const height = Math.round(finiteNumber(gif.height) || 0)
      if (!(width > 0) || !(height > 0)) throw new Error('recording-export-options: gif dimensions are required')
      // ONE concat of the kept segments, then ONE palette pass over the concatenated stream:
      // `stats_mode=diff` budgets the palette for what changes between frames, and a bayer
      // dither keeps the gradient banding of a screen recording under control.
      const videoInputs = windows.map((_window, index) => `[v${index}]`).join('')
      filters.push(`${videoInputs}concat=n=${windows.length}:v=1:a=0[outv]`)
      const gifExtraInputs = []
      let gifTail = 'outv'
      // DEV-05: GIF gets the capsules too. They are composited AFTER the fps/scale pass so the
      // coordinates are final GIF pixels, and BEFORE palettegen so the palette budgets the pill.
      filters.push(`[${gifTail}]fps=${fps},scale=${width}:${height}:flags=lanczos[gifScaled]`)
      gifTail = 'gifScaled'
      if (keystrokes) {
        const overlay = appendKeystrokeOverlay({
          base: gifTail,
          items: keystrokes.items,
          assets: keystrokeAssets,
          surfaceHeight: height,
          inputStart: windows.length,
          renderFps: fps,
          durationSeconds: seconds(totalDurationMs),
          extraInputs: gifExtraInputs,
          filters
        })
        gifTail = overlay.current
      }
      filters.push(`[${gifTail}]split[gifA][gifB]`)
      filters.push('[gifA]palettegen=stats_mode=diff[gifPalette]')
      filters.push('[gifB][gifPalette]paletteuse=dither=bayer:bayer_scale=5[gifOut]')
      return {
        args: [
          ...head,
          ...gifExtraInputs,
          '-filter_complex', filters.join(';'),
          '-map', '[gifOut]',
          '-an',
          '-loop', '0',
          ...progress,
          '-y', outputPath
        ],
        expected: {
          format,
          durationMs: totalDurationMs,
          width,
          height,
          hasAudio: false,
          fps,
          ...(keystrokes ? { keystrokesRendered: true } : {})
        }
      }
    }

    // Video concat, then the audio interleave when the source has a track.
    const videoInputs = windows.map((_window, index) => `[v${index}]`).join('')
    if (hasAudio) {
      const interleaved = windows
        .map((_window, index) => `[v${index}][a${index}]`)
        .join('')
      filters.push(`${interleaved}concat=n=${windows.length}:v=1:a=1[outv][outa]`)
    } else {
      filters.push(`${videoInputs}concat=n=${windows.length}:v=1:a=0[outv]`)
    }

    const audioArgs = hasAudio && format === 'mp4'
      ? ['-map', '[outa]', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2']
      : hasAudio && format === 'webm'
        ? ['-map', '[outa]', '-c:a', 'libopus', '-b:a', '128k']
        : ['-an']

    // R5 §3.3: demo rendering replaces the "map [outv]" tail with
    //   concat -> scale content -> [ripples] -> zoompan -> alphamerge(mask) -> overlay bg.
    // The asset paths come from the main-process asset builder; without them the service never
    // sets demo.rendered, and the non-demo branch below is byte-identical to R4.
    const demo = isPlainObject(options.demo) && options.demo.rendered === true && format !== 'gif'
      ? options.demo
      : null
    if (demo) {
      const demoApi = demoModule()
      if (!demoApi) throw new Error('recording-export-options: demo module unavailable')
      const assets = isPlainObject(options.demoAssets) ? options.demoAssets : {}
      const contentWidth = Math.round(finiteNumber(demo.contentWidth) || 0)
      const contentHeight = Math.round(finiteNumber(demo.contentHeight) || 0)
      const canvasWidth = Math.round(finiteNumber(demo.canvasWidth) || 0)
      const canvasHeight = Math.round(finiteNumber(demo.canvasHeight) || 0)
      if (!(contentWidth > 0) || !(contentHeight > 0) || !(canvasWidth > 0) || !(canvasHeight > 0)) {
        throw new Error('recording-export-options: demo canvas is invalid')
      }
      const sourceFps = Number(options.sourceFrameRate) > 0 ? Number(options.sourceFrameRate) : 0
      const renderFps = video.fps !== 'source'
        ? Math.max(1, Math.round(video.fpsValue))
        : (sourceFps > 0 ? Math.max(1, Math.round(sourceFps)) : 30)
      const radiusPx = Math.max(0, Math.round(finiteNumber(demo.radiusPx) || 0))
      const offsetX = Math.max(0, Math.round((canvasWidth - contentWidth) / 2))
      const offsetY = Math.max(0, Math.round((canvasHeight - contentHeight) / 2))
      const needsCanvas = canvasWidth > contentWidth || canvasHeight > contentHeight || radiusPx > 0
      const demoFilters = [...filters]
      const extraInputs = []
      // Every looped PNG input is BOUNDED to the exact film duration: an unbounded `-loop 1`
      // image keeps the demuxer alive forever, and a padded bound would extend the output.
      const inputLimit = (totalDurationMs / 1000).toFixed(6)
      let nextInputIndex = windows.length
      let backgroundIndex = -1
      let maskIndex = -1
      if (needsCanvas) {
        if (typeof assets.bgPath !== 'string' || !assets.bgPath) throw new Error('recording-export-options: demo background asset is required')
        backgroundIndex = nextInputIndex
        nextInputIndex += 1
        extraInputs.push('-loop', '1', '-framerate', String(renderFps), '-t', inputLimit, '-i', assets.bgPath)
        if (radiusPx > 0) {
          if (typeof assets.maskPath !== 'string' || !assets.maskPath) throw new Error('recording-export-options: demo mask asset is required for a rounded canvas')
          maskIndex = nextInputIndex
          nextInputIndex += 1
          extraInputs.push('-loop', '1', '-framerate', String(renderFps), '-t', inputLimit, '-i', assets.maskPath)
        }
      }
      // The concatenated film is first laid out at CONTENT size; the canvas is only formed by
      // the background overlay at the end.
      demoFilters.push(`[outv]scale=${contentWidth}:${contentHeight}:flags=lanczos[scaled]`)
      let current = 'scaled'
      // Ripples: the packed lane graph renders the same ring pixels with far fewer filter
      // nodes (see planRippleLayers above). A burst that needs more than MAX_RIPPLE_LAYERS
      // concurrent lanes keeps the exact historical per-click chain instead.
      const clicks = Array.isArray(demo.clicks) ? demo.clicks : []
      if (clicks.length && (typeof assets.ripplePath !== 'string' || !assets.ripplePath)) {
        throw new Error('recording-export-options: demo ripple asset is required')
      }
      const rippleLayers = clicks.length ? planRippleLayers(clicks) : []
      if (rippleLayers) {
        rippleLayers.forEach((layer, laneIndex) => {
          const rippleIndex = nextInputIndex
          nextInputIndex += 1
          extraInputs.push('-loop', '1', '-framerate', String(renderFps), '-t', inputLimit, '-i', assets.ripplePath)
          demoFilters.push(
            `[${rippleIndex}:v]scale=w='${layer.sizeExpression}':h='${layer.sizeExpression}':eval=frame,format=rgba[ripple${laneIndex}]`
          )
          demoFilters.push(
            `[${current}][ripple${laneIndex}]overlay=x='${layer.xExpression}':y='${layer.yExpression}':enable='${layer.enableExpression}':format=auto:shortest=1[rippleOverlay${laneIndex}]`
          )
          current = `rippleOverlay${laneIndex}`
        })
      } else {
        clicks.forEach((click, index) => {
          const rippleIndex = nextInputIndex
          nextInputIndex += 1
          extraInputs.push('-loop', '1', '-framerate', String(renderFps), '-t', inputLimit, '-i', assets.ripplePath)
          const entry = rippleEntries([click])[0]
          const size = rippleSizeExpression(entry)
          const window = rippleWindow(entry)
          demoFilters.push(`[${rippleIndex}:v]scale=w='${size}':h='${size}':eval=frame,format=rgba[ripple${index}]`)
          demoFilters.push(
            `[${current}][ripple${index}]overlay=x='${entry.focusX}*W-w/2':y='${entry.focusY}*H-h/2':enable='between(t,${window.startSeconds},${window.endSeconds})':format=auto:shortest=1[rippleOverlay${index}]`
          )
          current = `rippleOverlay${index}`
        })
      }
      // Camera: zoompan only when there is at least one zoom (otherwise the frame pass-through
      // keeps the R4 timing exactly).
      const zooms = Array.isArray(demo.zooms) ? demo.zooms : []
      if (zooms.length) {
        const expression = demoApi.zoomExpression({ zooms, fps: renderFps, contentWidth, contentHeight })
        demoFilters.push(
          `[${current}]zoompan=z='${expression.z}':x='${expression.x}':y='${expression.y}':d=1:s=${contentWidth}x${contentHeight}:fps=${renderFps}[zoomed]`
        )
        current = 'zoomed'
      }
      // Rounded corners + background placement.
      if (needsCanvas) {
        if (maskIndex >= 0) {
          demoFilters.push(`[${current}]format=rgba[canvasContent]`)
          demoFilters.push(`[canvasContent][${maskIndex}:v]alphamerge[canvasMasked]`)
          current = 'canvasMasked'
          demoFilters.push(`[${backgroundIndex}:v][${current}]overlay=x=${offsetX}:y=${offsetY}:format=auto:shortest=1[demoCanvas]`)
        } else {
          demoFilters.push(`[${backgroundIndex}:v][${current}]overlay=x=${offsetX}:y=${offsetY}:format=auto:shortest=1[demoCanvas]`)
        }
        current = 'demoCanvas'
      }
      // DEV-05: capsule overlay on the FINAL canvas: after the zoom/canvas passes, so the pill is
      // never magnified by a zoom segment and the coordinates are canvas pixels (same as preview,
      // where the capsule is a sibling of the transformed video element).
      if (keystrokes) {
        const overlay = appendKeystrokeOverlay({
          base: current,
          items: keystrokes.items,
          assets: keystrokeAssets,
          surfaceHeight: canvasHeight,
          inputStart: nextInputIndex,
          renderFps,
          durationSeconds: inputLimit,
          extraInputs,
          filters: demoFilters
        })
        current = overlay.current
      }
      demoFilters.push(`[${current}]format=yuv420p[demoOut]`)
      const demoGraph = demoFilters.join(';')
      const demoHead = [...head, ...extraInputs]
      const demoExpected = {
        format,
        durationMs: totalDurationMs,
        width: canvasWidth,
        height: canvasHeight,
        hasAudio,
        fps: renderFps,
        demoRendered: true,
        contentWidth,
        contentHeight,
        ...(keystrokes ? { keystrokesRendered: true } : {})
      }
      if (format === 'mp4') {
        return {
          args: [
            ...demoHead,
            '-filter_complex', demoGraph,
            '-map', '[demoOut]',
            ...audioArgs,
            ...mp4VideoEncoderArgs(video.encoder, VIDEO_CRF.mp4[video.quality]),
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            ...progress,
            '-y', outputPath
          ],
          expected: demoExpected
        }
      }
      return {
        args: [
          ...demoHead,
          '-filter_complex', demoGraph,
          '-map', '[demoOut]',
          ...audioArgs,
          '-c:v', 'libvpx-vp9',
          '-b:v', '0',
          '-row-mt', '1',
          '-crf', String(VIDEO_CRF.webm[video.quality]),
          ...progress,
          '-y', outputPath
        ],
        expected: demoExpected
      }
    }

    // DEV-05: capsule overlay for the plain MP4/WebM path (the demo branch above composites on its
    // own final canvas instead). The overlay runs after concat and after any resolution scale, so
    // `(W-w)/2` centres the pill on the FINAL output frame; the yuv420p conversion stays last.
    const nonDemoExtraInputs = []
    let nonDemoTail = 'outv'
    if (keystrokes) {
      const surfaceWidth = video.width > 0 ? video.width : sourceWidth
      const surfaceHeight = video.height > 0 ? video.height : sourceHeight
      if (!(surfaceWidth > 0) || !(surfaceHeight > 0)) {
        throw new Error('recording-export-options: keystroke overlay needs output dimensions')
      }
      const sourceFps = Number(options.sourceFrameRate) > 0
        ? Number(options.sourceFrameRate)
        : (video.fpsValue > 0 ? video.fpsValue : 30)
      const renderFps = outputFps > 0 ? Math.max(1, Math.round(outputFps)) : Math.max(1, Math.round(sourceFps))
      const overlay = appendKeystrokeOverlay({
        base: nonDemoTail,
        items: keystrokes.items,
        assets: keystrokeAssets,
        surfaceHeight,
        inputStart: windows.length,
        renderFps,
        durationSeconds: seconds(totalDurationMs),
        extraInputs: nonDemoExtraInputs,
        filters
      })
      nonDemoTail = overlay.current
    }
    const nonDemoGraph = filters.join(';')

    if (format === 'mp4') {
      return {
        args: [
          ...head,
          ...nonDemoExtraInputs,
          '-filter_complex', nonDemoGraph,
          '-map', `[${nonDemoTail}]`,
          ...audioArgs,
          ...mp4VideoEncoderArgs(video.encoder, VIDEO_CRF.mp4[video.quality]),
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          ...progress,
          '-y', outputPath
        ],
        expected: {
          format,
          durationMs: totalDurationMs,
          width: video.width,
          height: video.height,
          hasAudio,
          fps: video.fpsValue,
          ...(keystrokes ? { keystrokesRendered: true } : {})
        }
      }
    }

    // WebM re-encode: VP9 is the only codec the R4 contract allows here, and audio stays Opus.
    return {
      args: [
        ...head,
        ...nonDemoExtraInputs,
        '-filter_complex', nonDemoGraph,
        '-map', `[${nonDemoTail}]`,
        ...audioArgs,
        '-c:v', 'libvpx-vp9',
        '-b:v', '0',
        '-row-mt', '1',
        '-crf', String(VIDEO_CRF.webm[video.quality]),
        ...progress,
        '-y', outputPath
      ],
      expected: {
        format,
        durationMs: totalDurationMs,
        width: video.width,
        height: video.height,
        hasAudio,
        fps: video.fpsValue,
        ...(keystrokes ? { keystrokesRendered: true } : {})
      }
    }
  }

  // Publish verification tolerance for a finished encode (plan §8.4: verify decodable,
  // format, dimensions and the selected span before replacing the user's target).
  // R4 §4.2: multi-segment exports gain one frame-boundary allowance per EXTRA segment so a
  // concat of N exact cuts is not rejected for N-1 rounding boundaries; GIF adds its own
  // quantisation allowance.
  function durationToleranceMs(expected, options = {}) {
    const settings = isPlainObject(options) ? options : { isGif: options === true }
    const span = Math.max(0, finiteNumber(expected) || 0)
    const isGif = settings.isGif === true
    const segmentCount = Math.max(1, Math.round(Number(settings.segments) || 1))
    const sourceFps = Number(settings.sourceFps) > 0 ? Number(settings.sourceFps) : 30
    const perExtraSegment = Math.ceil(1000 / Math.min(sourceFps, 30))
    const base = Math.max(LIMITS.VERIFY_MIN_TOLERANCE_MS, span * LIMITS.VERIFY_TOLERANCE_RATIO)
    return Math.round(base + (segmentCount - 1) * perExtraSegment + (isGif ? LIMITS.GIF_VERIFY_EXTRA_TOLERANCE_MS : 0))
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
    const range = isPlainObject(source.range) ? source.range : null
    const segments = Array.isArray(source.segments)
      ? source.segments.map((segment) => ({
          startMs: Math.round(finiteNumber(segment?.startMs) || 0),
          endMs: Math.round(finiteNumber(segment?.endMs) || 0)
        }))
      : null
    const gif = format === 'gif' && isPlainObject(source.gif) ? source.gif : null
    const video = format !== 'gif' && isPlainObject(source.video) ? source.video : null
    const demo = isPlainObject(source.demo)
      ? {
          style: isPlainObject(source.demo.style) ? source.demo.style : null,
          zooms: Array.isArray(source.demo.zooms) ? source.demo.zooms : null,
          clicks: Array.isArray(source.demo.clicks) ? source.demo.clicks : null
        }
      : null
    // N03/DEV-05: the caption overlay choice travels with the frozen request. A pre-N03 renderer
    // sends no field and the legacy payload shape is unchanged.
    const keystrokes = isPlainObject(source.keystrokes) && source.keystrokes.enabled === true
      ? {
          enabled: true,
          items: Array.isArray(source.keystrokes.items)
            ? source.keystrokes.items.slice(0, KEYSTROKE_OVERLAY_LIMITS.MAX_ITEMS)
            : null
        }
      : null
    return {
      ok: true,
      value: {
        sessionId: id,
        requestId: requestKey,
        format,
        segments,
        range: range ? { startMs: range.startMs, endMs: range.endMs } : null,
        gif,
        video,
        demo,
        keystrokes
      }
    }
  }

  // Stable per-request key used for replay: same key + same parameters returns the same
  // task; same key + different parameters is `request-mismatch` (plan §8.3). R4 §4.4: the
  // signature must cover segments AND the video options, otherwise changing the resolution
  // under a reused requestId would silently return the old task.
  function requestSignature(request) {
    const source = isPlainObject(request) ? request : {}
    const segments = Array.isArray(source.segments) && source.segments.length
      ? source.segments
      : (isPlainObject(source.range) ? [source.range] : [])
    const selection = segments
      .map((segment) => `${Math.round(Number(segment?.startMs) || 0)}-${Math.round(Number(segment?.endMs) || 0)}`)
      .join(',')
    const gif = isPlainObject(source.gif)
      ? `${Math.round(Number(source.gif.edge ?? source.gif.maxEdgePx) || 0)}x${Math.round(Number(source.gif.fps) || 0)}`
      : '-'
    const video = isPlainObject(source.video)
      ? `${source.video.resolution || DEFAULT_VIDEO.resolution}:${source.video.quality || DEFAULT_VIDEO.quality}:${source.video.fps === undefined || source.video.fps === null ? DEFAULT_VIDEO.fps : source.video.fps}`
      : '-'
    // R5 §3.2: the demo look/camera plan is part of the frozen request. Everything that changes
    // the rendered pixels is in the key, so reusing a requestId with a different style/zoom plan
    // is a `request-mismatch` instead of silently replaying the old film.
    const demo = isPlainObject(source.demo) && source.demo.rendered === true
      ? (() => {
          const style = isPlainObject(source.demo.style) ? source.demo.style : {}
          const zooms = Array.isArray(source.demo.zooms) ? source.demo.zooms : []
          const clicks = Array.isArray(source.demo.clicks) ? source.demo.clicks : []
          const zoomKey = zooms
            .map((zoom) => [
              Math.round(Number(zoom?.startMs) || 0),
              Math.round(Number(zoom?.endMs) || 0),
              Number(zoom?.scale).toFixed(3),
              Number(zoom?.focusX).toFixed(3),
              Number(zoom?.focusY).toFixed(3),
              zoom?.easing || ''
            ].join('-'))
            .join(',')
          const clickKey = clicks
            .map((click) => `${Math.round(Number(click?.tMs) || 0)}-${Number(click?.x).toFixed(3)}-${Number(click?.y).toFixed(3)}`)
            .join(',')
          return `demo:${Math.round(Number(source.demo.canvasWidth) || 0)}x${Math.round(Number(source.demo.canvasHeight) || 0)}:${style.background || ''}:${Number(style.padding).toFixed(3)}:${Math.round(Number(style.radius) || 0)}:${style.shadow === true ? 1 : 0}:${style.ripples === true ? 1 : 0}:${zoomKey}:${clickKey}`
        })()
      : '-'
    // N03/DEV-05: the capsule plan is part of the frozen request. Two fields are enough: the
    // enabled flag and the projected output-time windows (label + frame window) that will be
    // composited, so reusing a requestId with different shortcuts is a `request-mismatch`.
    const keystrokes = isPlainObject(source.keystrokes) && source.keystrokes.enabled === true
      ? `keystrokes:${(Array.isArray(source.keystrokes.items) ? source.keystrokes.items : [])
        .map((item) => `${Math.round(Number(item?.tMs) || 0)}-${Math.round(Number(item?.endMs) || 0)}-${item?.combo || ''}`)
        .join(',')}`
      : '-'
    return [source.format || '', selection, gif, video, demo, keystrokes].join('|')
  }

  return {
    DEFAULT_VIDEO,
    EXPORT_FORMATS,
    EXPORT_TASK_STATES,
    GIF_FRAME_RATES,
    HARDWARE_VIDEO_ENCODERS,
    LIMITS,
    MAX_SEGMENTS,
    RESOLUTION_PRESETS,
    RESOLUTIONS,
    SESSION_STATES,
    SESSION_TRANSITIONS,
    SOFTWARE_VIDEO_ENCODER,
    TASK_TRANSITIONS,
    TERMINAL_TASK_STATES,
    VIDEO_CRF,
    VIDEO_FRAME_RATES,
    VIDEO_QUALITY_LEVELS,
    buildExportArgs,
    computeGifDimensions,
    computeVideoOutput,
    durationToleranceMs,
    estimateGifFrames,
    exportWindow,
    isFullRange,
    isTerminalTaskState,
    isValidKeystrokeCombo,
    keystrokeCapsuleMetrics,
    keystrokeOverlayMarginBottom,
    normalizeExportRequest,
    normalizeGifOptions,
    normalizeKeystrokeOverlay,
    normalizeRange,
    normalizeSegments,
    normalizeVideoEncoder,
    normalizeVideoOptions,
    requestSignature,
    resolveKeystrokeSurface,
    KEYSTROKE_OVERLAY_LIMITS,
    sessionTransition,
    taskTransition,
    toExportRequest
  }
})
