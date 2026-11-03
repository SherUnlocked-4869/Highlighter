// Recording demo look (background/padding/radius/shadow) + zoom segments + click ripples
// (R5 contract: docs/plans/2026-11-03-recording-r5-contracts.md §3).
//
// This module is the ONE pure description of the "演示成片" look and camera work. Both sides
// use it so the editor preview and the ffmpeg export cannot drift:
//   * the editor window loads it as a classic script (`window.recordingDemo`) to evaluate the
//     exact same style/zoom/canvas values the exporter will use;
//   * the main process requires it for request normalisation, source->output time mapping and
//     the zoompan expression handed to ffmpeg.
//
// Purity rules: no fs, no Electron, no clock, no randomness. Coordinates in this module are
// NORMALISED SOURCE-CONTENT coordinates (0..1) unless a name says otherwise. Times are integer
// MEDIA milliseconds; "source time" is the untouched recording timeline, "output time" is the
// timeline after the keepRange cuts are concatenated (the exported film's clock).
//
// UMD wrapper matches shared/recording-export-options.js: `require()` in node/main/tests and a
// classic `<script>` in a window. The only sibling-module usage is a LAZY lookup of
// `recordingExportOptions.computeVideoOutput` (node require / window global) so R4 resolution
// maths cannot drift; a local formula fallback keeps this module loadable on its own.

;(function initRecordingDemo(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.recordingDemo = api
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const DEMO_DEFAULTS = Object.freeze({
    enabled: false,
    background: '#0f1115',
    padding: 0.08,
    radius: 12,
    shadow: true,
    ripples: false
  })
  const STYLE_LIMITS = Object.freeze({
    paddingMin: 0,
    paddingMax: 0.2,
    radiusMin: 0,
    radiusMax: 24
  })
  const ZOOM_LIMITS = Object.freeze({
    maxSegments: 8,
    minDurationMs: 600,
    scaleMin: 1.25,
    scaleMax: 3,
    rampMs: 300
  })
  const RIPPLE_LIMITS = Object.freeze({
    maxClicks: 30,
    durationMs: 600,
    basePx: 28,
    growPx: 96
  })
  // Deep / light / brand backgrounds; the UI shows them as swatches.
  const BACKGROUND_PRESETS = Object.freeze(['#0f1115', '#1e1e1e', '#f5f2ea', '#0a2540'])
  // R4 contract §4.2 resolution presets (long-edge caps). Duplicated for the local canvas
  // fallback ONLY; resolveDemoCanvas prefers recording-export-options.computeVideoOutput.
  const RESOLUTION_PRESETS = Object.freeze({ '1080p': 1920, '720p': 1280, '480p': 854 })
  const RESOLUTIONS = Object.freeze(['source', '1080p', '720p', '480p'])
  // Bounded reads (contract §2.3 "读入时限长与数量上限"); the capture side is bounded tighter.
  const POINTER_LIMIT = 20000
  const CLICKS_LIMIT = 2000
  const INPUT_ENTRY_SCAN_LIMIT = 60000
  const EASINGS = Object.freeze(['linear', 'ease-in-out'])
  const DEFAULT_EASING = 'ease-in-out'
  // The mask radius is authored against a 1280px-wide content area and scaled linearly, so a
  // 12px style radius reads the same on 720p and 1080p footage.
  const RADIUS_REFERENCE_WIDTH = 1280

  const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  function finiteNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  function rounded(value, fallback) {
    const number = finiteNumber(value)
    return number === null ? fallback : Math.round(number)
  }

  function normalizedUnit(value, fallback) {
    const number = finiteNumber(value)
    return number === null ? fallback : round3(clamp(number, 0, 1))
  }

  function round3(value) {
    return Math.round(value * 1000) / 1000
  }

  function round4(value) {
    return Math.round(value * 10000) / 10000
  }

  function evenDimension(value) {
    return Math.max(2, Math.round(Number(value) / 2) * 2)
  }

  function text(value, limit = 64) {
    if (typeof value !== 'string') return ''
    return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit)
  }

  // Accepts '#rgb', '#rrggbb' (any case); normalises to lower-case '#rrggbb'. Unknown values
  // fall back to the default background rather than persisting junk.
  function normalizeColor(value, fallback = DEMO_DEFAULTS.background) {
    const candidate = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (!HEX_COLOR_PATTERN.test(candidate)) return fallback
    if (candidate.length === 4) {
      return `#${candidate[1]}${candidate[1]}${candidate[2]}${candidate[2]}${candidate[3]}${candidate[3]}`
    }
    return candidate
  }

  function normalizeEasing(value) {
    return EASINGS.includes(value) ? value : DEFAULT_EASING
  }

  // ---------------------------------------------------------------------------
  // Style / zoom / click-track normalisation
  // ---------------------------------------------------------------------------

  function normalizeDemoStyle(value) {
    const source = isPlainObject(value) ? value : {}
    const padding = finiteNumber(source.padding)
    const radius = finiteNumber(source.radius)
    return {
      enabled: source.enabled === true,
      background: normalizeColor(source.background),
      padding: padding === null
        ? DEMO_DEFAULTS.padding
        : round4(clamp(padding, STYLE_LIMITS.paddingMin, STYLE_LIMITS.paddingMax)),
      radius: radius === null
        ? DEMO_DEFAULTS.radius
        : Math.round(clamp(radius, STYLE_LIMITS.radiusMin, STYLE_LIMITS.radiusMax)),
      shadow: source.shadow === undefined ? DEMO_DEFAULTS.shadow : source.shadow === true,
      ripples: source.ripples === true
    }
  }

  // Source-time zoom segments. Entries that cannot be interpreted are DROPPED (never clamped
  // into a different span); scale/focus are clamped into their documented ranges because those
  // are display parameters, not structure. Ordering is by start time; overlapping later
  // segments are dropped so the camera plan stays unambiguous.
  function normalizeZoomSegments(value) {
    if (!Array.isArray(value)) return []
    const candidates = []
    for (const entry of value.slice(0, 64)) {
      if (!isPlainObject(entry)) continue
      const start = finiteNumber(entry.startMs)
      const end = finiteNumber(entry.endMs)
      if (start === null || end === null) continue
      const startMs = Math.max(0, Math.round(start))
      const endMs = Math.max(0, Math.round(end))
      if (!(endMs > startMs)) continue
      if (endMs - startMs < ZOOM_LIMITS.minDurationMs) continue
      const scale = finiteNumber(entry.scale)
      candidates.push({
        id: text(entry.id) || '',
        startMs,
        endMs,
        scale: scale === null ? 2 : clamp(scale, ZOOM_LIMITS.scaleMin, ZOOM_LIMITS.scaleMax),
        focusX: normalizedUnit(entry.focusX, 0.5),
        focusY: normalizedUnit(entry.focusY, 0.5),
        easing: normalizeEasing(entry.easing)
      })
    }
    candidates.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    const result = []
    for (const candidate of candidates) {
      const previous = result[result.length - 1]
      if (previous && candidate.startMs < previous.endMs) continue
      result.push(candidate)
      if (result.length >= ZOOM_LIMITS.maxSegments) break
    }
    // Deterministic ids for segments that did not carry one (the editor persists ids).
    return result.map((segment, index) => ({ ...segment, id: segment.id || `zoom-${index + 1}` }))
  }

  // events.json v1 track (contract §2.3): bounded read, sorted, invalid entries dropped.
  function normalizeClickTrack(value) {
    const source = isPlainObject(value) ? value : {}
    const declaredDuration = finiteNumber(source.durationMs)
    const durationMs = declaredDuration === null ? 0 : Math.max(0, Math.round(declaredDuration))
    const pointer = []
    let truncated = source.truncated === true
    const rawPointer = Array.isArray(source.pointer) ? source.pointer : []
    for (const entry of rawPointer.slice(0, INPUT_ENTRY_SCAN_LIMIT)) {
      if (!isPlainObject(entry)) continue
      const t = finiteNumber(entry.tMs)
      const x = finiteNumber(entry.x)
      const y = finiteNumber(entry.y)
      if (t === null || x === null || y === null) continue
      const tMs = Math.round(t)
      if (tMs < 0 || (durationMs > 0 && tMs > durationMs)) continue
      const point = { tMs, x: normalizedUnit(x, 0), y: normalizedUnit(y, 0) }
      const previousPoint = pointer[pointer.length - 1]
      if (previousPoint && point.x === previousPoint.x && point.y === previousPoint.y) continue
      pointer.push(point)
    }
    pointer.sort((left, right) => left.tMs - right.tMs)
    let boundedPointer = pointer
    if (pointer.length > POINTER_LIMIT) {
      boundedPointer = pointer.slice(pointer.length - POINTER_LIMIT)
      truncated = true
    }
    const clicks = normalizeClicks(source.clicks, durationMs)
    if (clicks.length > CLICKS_LIMIT) truncated = true
    const sampledAtHzRaw = finiteNumber(source.sampledAtHz)
    return {
      durationMs,
      sampledAtHz: sampledAtHzRaw !== null && sampledAtHzRaw > 0 && sampledAtHzRaw <= 240
        ? Math.round(sampledAtHzRaw)
        : 20,
      pointer: boundedPointer,
      clicks: clicks.slice(0, CLICKS_LIMIT),
      truncated
    }
  }

  // Click entries alone (source-time ripples): bounded and sorted, same validity rules.
  function normalizeClicks(value, durationMs = 0) {
    if (!Array.isArray(value)) return []
    const limit = Math.max(0, Math.round(Number(durationMs) || 0))
    const clicks = []
    for (const entry of value.slice(0, INPUT_ENTRY_SCAN_LIMIT)) {
      if (!isPlainObject(entry)) continue
      const t = finiteNumber(entry.tMs)
      const x = finiteNumber(entry.x)
      const y = finiteNumber(entry.y)
      if (t === null || x === null || y === null) continue
      const tMs = Math.round(t)
      if (tMs < 0 || (limit > 0 && tMs > limit)) continue
      const button = rounded(entry.button, 0)
      if (![0, 1, 2].includes(button)) continue
      clicks.push({ tMs, x: normalizedUnit(x, 0), y: normalizedUnit(y, 0), button })
    }
    clicks.sort((left, right) => left.tMs - right.tMs)
    return clicks
  }

  // ---------------------------------------------------------------------------
  // Source time -> output time mapping
  // ---------------------------------------------------------------------------

  // Keeps a sorted, non-overlapping set of half-open [startMs, endMs) intervals from a source-
  // time interval, expressed on the concatenated output timeline.
  function mapIntervalToOutput(intervals, startMs, endMs) {
    const pieces = []
    for (const interval of intervals) {
      const start = Math.max(startMs, interval.startMs)
      const end = Math.min(endMs, interval.endMs)
      if (end - start <= 0) continue
      pieces.push({ startMs: interval.outputStartMs + (start - interval.startMs), endMs: interval.outputStartMs + (end - interval.startMs) })
    }
    return pieces
  }

  // Builds the keep intervals on the output timeline: outputStartMs is where a source interval
  // lands after all earlier kept ranges were laid end to end.
  function buildOutputIntervals(segments) {
    if (!Array.isArray(segments)) return []
    const intervals = []
    let outputCursor = 0
    for (const segment of segments) {
      if (!isPlainObject(segment)) continue
      const start = finiteNumber(segment.startMs)
      const end = finiteNumber(segment.endMs)
      if (start === null || end === null) continue
      const startMs = Math.max(0, Math.round(start))
      const endMs = Math.round(end)
      if (!(endMs > startMs)) continue
      intervals.push({ startMs, endMs, outputStartMs: outputCursor })
      outputCursor += endMs - startMs
    }
    return intervals
  }

  // Contract §3.1: maps the source-time style/zoom/click plan through the kept segments.
  // Zooms are truncated per kept piece (a zoom spanning a deleted gap yields two pieces that
  // touch on the output timeline and are merged back into one continuous zoom, because the gap
  // no longer exists in the film). Clicks inside a deleted gap are dropped; style passes through
  // normalised.
  function mapDemoToOutput(value, segments) {
    const source = isPlainObject(value) ? value : {}
    const style = normalizeDemoStyle(source.style)
    const intervals = buildOutputIntervals(segments)
    // Clicks are validated against the SOURCE duration (the last kept end), not the output
    // duration: their timestamps live on the source timeline until the mapping below.
    const sourceDurationMs = intervals.length ? intervals[intervals.length - 1].endMs : 0
    const clicks = normalizeClicks(source.clicks, sourceDurationMs)
    const zooms = []
    const normalizedZooms = normalizeZoomSegments(source.zooms)
    for (const zoom of normalizedZooms) {
      const mapped = mapIntervalToOutput(intervals, zoom.startMs, zoom.endMs)
      if (!mapped.length) continue
      // Merge pieces that touch on the OUTPUT timeline: the cut between them is instantaneous,
      // so a zoom that crossed a removed gap stays continuous.
      let current = null
      for (const piece of mapped) {
        if (current && piece.startMs <= current.endMs) {
          current.endMs = Math.max(current.endMs, piece.endMs)
          continue
        }
        current = {
          startMs: piece.startMs,
          endMs: piece.endMs,
          scale: zoom.scale,
          focusX: zoom.focusX,
          focusY: zoom.focusY,
          easing: zoom.easing
        }
        zooms.push(current)
      }
    }
    zooms.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    const mappedClicks = []
    for (const click of clicks) {
      for (const interval of intervals) {
        if (click.tMs < interval.startMs || click.tMs >= interval.endMs) continue
        mappedClicks.push({
          tMs: interval.outputStartMs + (click.tMs - interval.startMs),
          x: click.x,
          y: click.y,
          button: click.button
        })
        break
      }
    }
    return { style, zooms, clicks: mappedClicks.sort((left, right) => left.tMs - right.tMs) }
  }

  // ---------------------------------------------------------------------------
  // Canvas / output geometry
  // ---------------------------------------------------------------------------

  // Lazy sibling-module lookup (R4 resolution maths). In node we require it; in the window the
  // editor loads recording-export-options as a classic script before using us.
  function exportOptionsModule() {
    try {
      if (typeof module === 'object' && module.exports && typeof require === 'function') {
        return require('./recording-export-options')
      }
    } catch {
      // Fall through to the window global / local formula.
    }
    const scope = typeof globalThis === 'object' ? globalThis : null
    return scope && scope.recordingExportOptions ? scope.recordingExportOptions : null
  }

  function computeContentOutput(sourceWidth, sourceHeight, resolution) {
    const requested = RESOLUTIONS.includes(resolution) ? resolution : 'source'
    const sharedModule = exportOptionsModule()
    if (sharedModule && typeof sharedModule.computeVideoOutput === 'function') {
      const shared = sharedModule.computeVideoOutput({
        sourceWidth,
        sourceHeight,
        resolution: requested
      })
      if (shared && typeof shared === 'object') {
        if (shared.ok === false) return shared
        const value = shared.ok === true ? shared.value : shared
        if (value && value.width > 0 && value.height > 0) {
          return { ok: true, value: { width: value.width, height: value.height } }
        }
      }
    }
    // Local fallback: identical formula (long-edge cap, even dimensions, never upscale).
    const width = Math.round(Number(sourceWidth) || 0)
    const height = Math.round(Number(sourceHeight) || 0)
    if (!(width > 0) || !(height > 0)) return { ok: false, code: 'invalid-source-size' }
    const longEdge = Math.max(width, height)
    const cap = requested === 'source' ? longEdge : RESOLUTION_PRESETS[requested]
    const scale = requested === 'source' ? 1 : Math.min(1, cap / longEdge)
    return { ok: true, value: { width: evenDimension(width * scale), height: evenDimension(height * scale) } }
  }

  // Contract §3.1/§3.3: content = R4 resolution result; canvas expands by padding so that the
  // content occupies (1 - 2*padding) of the canvas. Everything is even and the content is never
  // upscaled. `radiusPx` is the CONTENT-pixel corner radius used by the mask.
  function resolveDemoCanvas({ sourceWidth, sourceHeight, resolution = 'source', style } = {}) {
    const normalizedStyle = normalizeDemoStyle(style)
    const content = computeContentOutput(sourceWidth, sourceHeight, resolution)
    if (!content.ok) return content
    const contentWidth = content.value.width
    const contentHeight = content.value.height
    const enabled = normalizedStyle.enabled === true
    let canvasWidth = contentWidth
    let canvasHeight = contentHeight
    let paddingPx = 0
    if (enabled && normalizedStyle.padding > 0) {
      const factor = 1 / (1 - 2 * normalizedStyle.padding)
      canvasWidth = Math.max(contentWidth, evenDimension(contentWidth * factor))
      canvasHeight = Math.max(contentHeight, evenDimension(contentHeight * factor))
      paddingPx = Math.round((canvasWidth - contentWidth) / 2)
    }
    const radiusPx = enabled
      ? Math.round(clamp(
          normalizedStyle.radius * (contentWidth / RADIUS_REFERENCE_WIDTH),
          0,
          Math.floor(Math.min(contentWidth, contentHeight) / 2)
        ))
      : 0
    // Contract §3.1 shape: success returns the bare geometry object. Callers only see
    // `{ ok:false, code }` when the source dimensions cannot be resolved.
    return {
      contentWidth,
      contentHeight,
      canvasWidth,
      canvasHeight,
      paddingPx,
      radiusPx
    }
  }

  // ---------------------------------------------------------------------------
  // Auto zoom suggestions (contract §3.4, local and deterministic)
  // ---------------------------------------------------------------------------

  function distance(left, right) {
    const dx = left.x - right.x
    const dy = left.y - right.y
    return Math.sqrt(dx * dx + dy * dy)
  }

  function centroid(points) {
    const source = points.length ? points : [{ x: 0.5, y: 0.5 }]
    let x = 0
    let y = 0
    for (const point of source) {
      x += point.x
      y += point.y
    }
    return { x: round3(clamp(x / source.length, 0, 1)), y: round3(clamp(y / source.length, 0, 1)) }
  }

  function clampSuggestion(startMs, endMs, durationMs) {
    let start = Math.max(0, Math.round(startMs))
    let end = Math.min(durationMs, Math.round(endMs))
    if (end - start < 1200) {
      // Widen towards the side that still has room so the 1.2 s minimum survives a boundary.
      const deficit = 1200 - (end - start)
      const growStart = Math.min(Math.floor(deficit / 2), start)
      start -= growStart
      end = Math.min(durationMs, end + (deficit - growStart))
      if (end - start < 1200) start = Math.max(0, end - 1200)
    }
    return { startMs: start, endMs: end }
  }

  // `track` is a normalized (or raw) events.json track. `outputSegments` (optional) are the
  // SOURCE-time keepRanges: suggestions are clipped to kept content but stay in source time so
  // the editor can persist them in `edit.zoomSegments`.
  function suggestZoomSegments({ track, durationMs = 0, outputSegments = null } = {}) {
    const normalizedTrack = normalizeClickTrack(track)
    const duration = Math.max(
      0,
      Math.round(finiteNumber(durationMs) || normalizedTrack.durationMs || 0)
    )
    if (!(duration > 0)) return []
    const kept = Array.isArray(outputSegments) && outputSegments.length
      ? buildOutputIntervals(outputSegments)
      : null
    const suggestions = []

    // 1) Click clusters: 2 s window, 0.18 normalised distance, at least two clicks.
    const clicks = normalizedTrack.clicks
    let index = 0
    while (index < clicks.length) {
      const seed = clicks[index]
      const cluster = [seed]
      let cursor = index + 1
      while (cursor < clicks.length && clicks[cursor].tMs - seed.tMs <= 2000) {
        if (distance(clicks[cursor], seed) <= 0.18) cluster.push(clicks[cursor])
        cursor += 1
      }
      if (cluster.length >= 2) {
        const focus = centroid(cluster)
        const first = cluster[0].tMs
        const last = cluster[cluster.length - 1].tMs
        const window = clampSuggestion(first - 800, last + 1200, duration)
        suggestions.push({
          startMs: window.startMs,
          endMs: window.endMs,
          scale: Math.min(2.2, round3(1.4 + 0.2 * cluster.length)),
          focusX: focus.x,
          focusY: focus.y,
          reason: 'clicks'
        })
        while (index < clicks.length && clicks[index].tMs <= last) index += 1
        continue
      }
      index += 1
    }

    // 2) Dwell runs: pointer samples staying within 0.04 for >= 1.2 s.
    const pointer = normalizedTrack.pointer
    let dwellIndex = 0
    while (dwellIndex < pointer.length) {
      const start = pointer[dwellIndex]
      let endIndex = dwellIndex
      while (endIndex + 1 < pointer.length) {
        const candidate = pointer[endIndex + 1]
        if (candidate.tMs - start.tMs > 12000) break
        if (distance(candidate, start) >= 0.04) break
        endIndex += 1
      }
      const end = pointer[endIndex]
      if (endIndex > dwellIndex && end.tMs - start.tMs >= 1200) {
        const center = centroid(pointer.slice(dwellIndex, endIndex + 1))
        const window = clampSuggestion(start.tMs - 600, end.tMs + 600, duration)
        suggestions.push({
          startMs: window.startMs,
          endMs: window.endMs,
          scale: 1.6,
          focusX: center.x,
          focusY: center.y,
          reason: 'dwell'
        })
        dwellIndex = endIndex + 1
        continue
      }
      dwellIndex += 1
    }

    suggestions.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    const merged = []
    for (const suggestion of suggestions) {
      const previous = merged[merged.length - 1]
      if (previous && suggestion.startMs <= previous.endMs) {
        previous.endMs = Math.max(previous.endMs, suggestion.endMs)
        continue
      }
      merged.push({ ...suggestion })
      if (merged.length >= 5) break
    }

    // Optional keepRanges clipping: intersect in SOURCE time (the suggestions stay source-time,
    // because that is what edit.zoomSegments persists) and keep pieces long enough to be a
    // meaningful zoom (one ramp in + one ramp out).
    const clipped = []
    for (const suggestion of merged) {
      if (!kept) {
        clipped.push(suggestion)
        continue
      }
      for (const interval of kept) {
        const start = Math.max(suggestion.startMs, interval.startMs)
        const end = Math.min(suggestion.endMs, interval.endMs)
        if (end - start < ZOOM_LIMITS.minDurationMs) continue
        clipped.push({ ...suggestion, startMs: start, endMs: end })
      }
    }
    return clipped
      .sort((left, right) => left.startMs - right.startMs)
      .slice(0, 5)
      .map((suggestion, index) => ({
        id: `suggest-${suggestion.reason}-${index + 1}`,
        startMs: suggestion.startMs,
        endMs: suggestion.endMs,
        scale: suggestion.scale,
        focusX: suggestion.focusX,
        focusY: suggestion.focusY,
        reason: suggestion.reason
      }))
  }

  // ---------------------------------------------------------------------------
  // ffmpeg zoompan expressions (contract §3.3) + the shared preview evaluator
  // ---------------------------------------------------------------------------

  function easeProgress(progressExpression, easing) {
    if (easing === 'ease-in-out') {
      return `(${progressExpression})*(${progressExpression})*(3-2*(${progressExpression}))`
    }
    return progressExpression
  }

  // Piecewise nested `if()` expression over OUTPUT-time zooms. `valueForSegment` receives the
  // segment and returns the expression that applies while the segment is active; outside every
  // segment the fallback applies. Segments are sorted and non-overlapping by construction.
  function piecewise(zooms, fps, fallback, valueForSegment) {
    const timeExpression = `on/${fps}`
    let expression = fallback
    for (let index = zooms.length - 1; index >= 0; index -= 1) {
      const zoom = zooms[index]
      const startSeconds = (zoom.startMs / 1000).toFixed(6)
      const endSeconds = (zoom.endMs / 1000).toFixed(6)
      const active = valueForSegment(zoom, timeExpression, startSeconds, endSeconds)
      expression = `if(lt(${timeExpression},${startSeconds}),${expression},if(lt(${timeExpression},${endSeconds}),${active},${expression}))`
    }
    return expression
  }

  // `startSeconds`/`endSeconds` are the STRINGS produced by piecewise(); parse them only for the
  // ramp arithmetic, and keep the originals for the ffmpeg expression text.
  function zoomValueExpression(zoom, timeExpression, startSeconds, endSeconds) {
    const ramp = ZOOM_LIMITS.rampMs / 1000
    const duration = (zoom.endMs - zoom.startMs) / 1000
    const scale = round4(zoom.scale)
    const start = Number(startSeconds)
    const end = Number(endSeconds)
    // 600 ms is exactly one ramp in plus one ramp out: no hold, up/down meet in the middle.
    const upEnd = (duration <= 2 * ramp ? start + duration / 2 : start + ramp).toFixed(6)
    const downStart = (duration <= 2 * ramp ? start + duration / 2 : end - ramp).toFixed(6)
    const upProgress = `min(1,max(0,((${timeExpression})-${startSeconds})/${ramp}))`
    const downProgress = `min(1,max(0,(${endSeconds}-(${timeExpression}))/${ramp}))`
    const up = `(1+(${scale}-1)*${easeProgress(upProgress, zoom.easing)})`
    const down = `(1+(${scale}-1)*${easeProgress(downProgress, zoom.easing)})`
    const hold = String(scale)
    return `if(lt(${timeExpression},${upEnd}),${up},if(lt(${timeExpression},${downStart}),${hold},${down}))`
  }

  function focusExpression(zoom, axis) {
    const focus = axis === 'x' ? zoom.focusX : zoom.focusY
    const input = axis === 'x' ? 'iw' : 'ih'
    return `clip(${round4(focus)}*${input}-(${input}/zoom/2),0,${input}-${input}/zoom)`
  }

  // Returns the ffmpeg zoompan z/x/y expression strings. `on` is the output frame number, so
  // `on/fps` is the output timeline in seconds; each segment ramps 300 ms in, holds, ramps out.
  // Focus panning uses the documented clip(): x=clip(fx*iw-(iw/zoom/2),0,iw-iw/zoom).
  function zoomExpression({ zooms, fps, contentWidth, contentHeight } = {}) {
    const normalizedZooms = normalizeZoomSegments(zooms)
    const rate = Math.max(1, Math.round(finiteNumber(fps) || 30))
    if (!normalizedZooms.length) return { z: '1', x: '0', y: '0' }
    return {
      z: piecewise(normalizedZooms, rate, '1', (zoom, timeExpression, startSeconds, endSeconds) =>
        zoomValueExpression(zoom, timeExpression, startSeconds, endSeconds)),
      x: piecewise(normalizedZooms, rate, '0', (zoom) => focusExpression(zoom, 'x')),
      y: piecewise(normalizedZooms, rate, '0', (zoom) => focusExpression(zoom, 'y'))
    }
  }

  // Shared PREVIEW evaluator: the editor applies this to the <video> transform so the 300 ms
  // ramp matches the exported zoompan exactly. Takes OUTPUT-time zooms (mapDemoToOutput).
  function evaluateZoomAt(zooms, outputMs) {
    const normalized = normalizeZoomSegments(zooms)
    const time = Math.max(0, Math.round(finiteNumber(outputMs) || 0))
    for (const zoom of normalized) {
      if (time < zoom.startMs || time > zoom.endMs) continue
      const ramp = ZOOM_LIMITS.rampMs
      const duration = zoom.endMs - zoom.startMs
      const upEnd = duration <= 2 * ramp ? zoom.startMs + duration / 2 : zoom.startMs + ramp
      const downStart = duration <= 2 * ramp ? upEnd : zoom.endMs - ramp
      let progress = 1
      if (time < upEnd) progress = clamp((time - zoom.startMs) / ramp, 0, 1)
      else if (time >= downStart) progress = clamp((zoom.endMs - time) / ramp, 0, 1)
      const eased = zoom.easing === 'ease-in-out'
        ? progress * progress * (3 - 2 * progress)
        : progress
      return {
        scale: 1 + (zoom.scale - 1) * eased,
        focusX: zoom.focusX,
        focusY: zoom.focusY,
        active: true
      }
    }
    return { scale: 1, focusX: 0.5, focusY: 0.5, active: false }
  }

  return {
    BACKGROUND_PRESETS,
    DEMO_DEFAULTS,
    EASINGS,
    POINTER_LIMIT,
    CLICKS_LIMIT,
    RESOLUTION_PRESETS,
    RIPPLE_LIMITS,
    STYLE_LIMITS,
    ZOOM_LIMITS,
    evaluateZoomAt,
    mapDemoToOutput,
    normalizeClickTrack,
    normalizeClicks,
    normalizeColor,
    normalizeDemoStyle,
    normalizeZoomSegments,
    resolveDemoCanvas,
    suggestZoomSegments,
    zoomExpression
  }
})
