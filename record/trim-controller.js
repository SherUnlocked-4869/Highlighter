'use strict'

// Trim + export controller shared by the recording preview (feature E3) and the standalone
// recording editor (R1-R3 contract §9.3/§11; R4 contract §3/§4/§5).
//
// This module owns the EDIT STATE, not the DOM: it is loaded by record/editor.html as a classic
// script (`window.recordTrimController`) and required by node tests, but every DOM mutation is
// a callback the page supplies. That keeps the decisions that actually matter - multi-segment
// edits, undo/redo, range playback, format/GIF/video budgets, submission freeze, cancel
// arbitration, the result bar receipt, draft revision CAS - testable without a browser.
//
// Two addressing modes:
//   * session mode (`sessionId`): the old preview window, single `range`, export goes to
//     `record:export` with the legacy `range` field.
//   * project mode (`projectId` + `project`, used by the editor): the project is the durable
//     identity, `segments[]` is authoritative, export goes to `record-editor:export` with the
//     R4 request shape (`segments` omitted for a whole-recording selection, `video` options for
//     mp4/webm), and the edit is autosaved through `updateDraft` with an expectedRevision CAS.
//     A revision conflict is reported as state, never silently overwritten.
//
// Contract notes:
//   * Every kept range is `[startMs, endMs)` in SOURCE milliseconds. The controller always
//     materialises "whole recording" as `[{0,duration}]`; an EMPTY `segments` array is the
//     explicit "user deleted everything" state (export disabled). The schema-shaped
//     `keepRanges: []` = whole rule is applied at the draft boundary.
//   * Undo/redo stacks hold segment snapshots (limit 50). A drag wraps many transient boundary
//     updates in one snapshot via beginEdit()/commitEdit().
//   * Playback skips removed gaps and pauses at the last kept end; scrubbing the playhead never
//     changes the segments.
//   * Export freeze: once a request is accepted, edits/format/GIF/video controls are frozen
//     until the task reaches a terminal state. A retry re-reads the current controls, but a
//     replay of the SAME request keeps the same requestId (plan §8.3).
//   * A published task shows a result bar fed by `{ status:'saved', resultId, fileName, kind }`;
//     a cancelled or failed task never produces one.
;
(function initRecordTrimController(root, factory) {
  const options = typeof module === 'object' && module.exports
    ? require('../shared/recording-export-options')
    : root.recordingExportOptions
  const timeline = typeof module === 'object' && module.exports
    ? require('./editor-timeline')
    : root.recordEditorTimeline
  // W12 owns shared/recording-demo.js (style/zoom/ripple maths shared with the exporter).
  // It may be mid-landing in a parallel stream; the controller falls back to an identical
  // local implementation only until the module exists, and always prefers the shared one.
  const demo = typeof module === 'object' && module.exports
    ? (() => { try { return require('../shared/recording-demo') } catch { return null } })()
    : root.recordingDemo
  const api = factory(options, timeline, demo)
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.recordTrimController = api
})(typeof globalThis === 'object' ? globalThis : this, (options, timeline, sharedDemo) => {
  const {
    GIF_FRAME_RATES,
    LIMITS,
    computeGifDimensions,
    estimateGifFrames,
    normalizeGifOptions,
    normalizeRange
  } = options

  // W12 owns shared/recording-demo.js. If the script tag/require is missing the editor
  // degrades visibly instead of crashing: defaults only, no style rendering, no zoom.
  function createMissingDemoModule() {
    const defaults = Object.freeze({ enabled: false, background: '#0f1115', padding: 0.08, radius: 12, shadow: true, ripples: false })
    return {
      BACKGROUND_PRESETS: Object.freeze(['#0f1115', '#1e1e1e', '#f5f2ea', '#0a2540']),
      DEMO_DEFAULTS: defaults,
      RIPPLE_LIMITS: Object.freeze({ maxClicks: 30, durationMs: 600, basePx: 28, growPx: 96 }),
      STYLE_LIMITS: Object.freeze({ paddingMin: 0, paddingMax: 0.2, radiusMin: 0, radiusMax: 24 }),
      ZOOM_LIMITS: Object.freeze({ maxSegments: 8, minDurationMs: 600, scaleMin: 1.25, scaleMax: 3, rampMs: 300 }),
      evaluateZoomAt: () => ({ scale: 1, focusX: 0.5, focusY: 0.5 }),
      mapDemoToOutput: () => ({ style: { ...defaults }, zooms: [], clicks: [] }),
      normalizeClickTrack: () => ({ durationMs: 0, sampledAtHz: 20, pointer: [], clicks: [], truncated: false }),
      normalizeDemoStyle: (value) => ({ ...defaults, enabled: value && value.enabled === true }),
      normalizeZoomSegments: () => [],
      resolveDemoCanvas: ({ sourceWidth, sourceHeight }) => ({
        contentWidth: Math.max(0, Math.round(Number(sourceWidth) || 0)),
        contentHeight: Math.max(0, Math.round(Number(sourceHeight) || 0)),
        canvasWidth: Math.max(0, Math.round(Number(sourceWidth) || 0)),
        canvasHeight: Math.max(0, Math.round(Number(sourceHeight) || 0)),
        paddingPx: 0,
        radiusPx: 0
      }),
      suggestZoomSegments: () => [],
      zoomExpression: () => ({ z: '1', x: '0', y: '0' })
    }
  }

  const demoApi = sharedDemo || createMissingDemoModule()

  const TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled'])
  const EXPORT_FORMATS = Object.freeze(['mp4', 'gif', 'webm'])
  const HISTORY_LIMIT = 50

  // Locale keys this module resolves at runtime. The record UI contract test feeds this list
  // into its three-language check, so a new message cannot ship untranslated. R4 editor keys
  // live in shared/locales/recording-editor.js; the legacy record.* keys stay for the session
  // surface and the shared error-code table.
  const LOCALE_KEYS = Object.freeze([
    'record.trim.title',
    'record.trim.start',
    'record.trim.end',
    'record.trim.duration',
    'record.trim.selection',
    'record.trim.play-range',
    'record.trim.stop-range',
    'record.trim.format',
    'record.trim.format.mp4',
    'record.trim.format.gif',
    'record.trim.gif-size',
    'record.trim.gif-fps',
    'record.trim.gif-frames',
    'record.trim.gif-no-audio',
    'record.trim.export',
    'record.trim.exporting',
    'record.trim.finishing',
    'record.trim.cancel',
    'record.trim.retry',
    'record.trim.ready',
    'record.trim.succeeded',
    'record.trim.cancelled',
    'record.trim.disabled',
    'record.error.export-failed',
    'record.error.export-target-unavailable',
    'record.error.export-range-out-of-bounds',
    'record.error.export-range-too-short',
    'record.error.export-duration-unavailable',
    'record.error.export-probe-failed',
    'record.error.export-renderer-duration-disagrees',
    'record.error.export-gif-too-long',
    'record.error.export-gif-invalid-fps',
    'record.error.export-gif-invalid-edge',
    'record.error.export-gif-too-many-frames',
    'record.error.export-rate-limited',
    'record.error.export-request-mismatch',
    'record.error.export-session-not-ready',
    'record.error.export-encode-failed',
    'record.error.export-verify-failed',
    'record.error.export-target-changed',
    'record.error.export-publish-failed',
    'record.error.export-publish-in-progress',
    'record.error.export-invalid-request',
    'record.error.export-task-not-found',
    'record.error.export-codec-missing',
    // R4 editor-only messages (shared/locales/recording-editor.js)
    'recording.editor.timeline.kept',
    'recording.editor.timeline.empty',
    'recording.editor.format.webm',
    'recording.editor.resolution',
    'recording.editor.resolution.source',
    'recording.editor.resolution.p1080',
    'recording.editor.resolution.p720',
    'recording.editor.resolution.p480',
    'recording.editor.quality',
    'recording.editor.quality.standard',
    'recording.editor.quality.high',
    'recording.editor.quality.ultra',
    'recording.editor.fps',
    'recording.editor.fps.source',
    'recording.editor.output-size',
    'recording.editor.output-value',
    'recording.editor.result.kind.webm',
    'recording.editor.error.empty-selection',
    'recording.editor.error.invalid-video-option',
    'recording.editor.error.fps-above-source',
    'recording.editor.error.too-many-segments',
    'recording.editor.error.overlapping-segments',
    'recording.editor.error.ambiguous-selection'
  ])

  // Stable code -> locale key. Every code the export service can return has an entry; an
  // unknown code falls back to the generic failure message rather than showing a raw token.
  const ERROR_KEYS = Object.freeze({
    'target-unavailable': 'record.error.export-target-unavailable',
    'range-out-of-bounds': 'record.error.export-range-out-of-bounds',
    'range-too-short': 'record.error.export-range-too-short',
    'invalid-range': 'record.error.export-range-too-short',
    'duration-unavailable': 'record.error.export-duration-unavailable',
    'probe-failed': 'record.error.export-probe-failed',
    'probe-unavailable': 'record.error.export-probe-failed',
    'renderer-duration-disagrees': 'record.error.export-renderer-duration-disagrees',
    'gif-too-long': 'record.error.export-gif-too-long',
    'gif-invalid-fps': 'record.error.export-gif-invalid-fps',
    'gif-invalid-edge': 'record.error.export-gif-invalid-edge',
    'gif-too-many-frames': 'record.error.export-gif-too-many-frames',
    'gif-loop-required': 'record.error.export-gif-invalid-edge',
    'rate-limited': 'record.error.export-rate-limited',
    'request-mismatch': 'record.error.export-request-mismatch',
    'session-not-ready': 'record.error.export-session-not-ready',
    'session-not-found': 'record.error.export-session-not-ready',
    'encode-failed': 'record.error.export-encode-failed',
    'verify-failed': 'record.error.export-verify-failed',
    'target-changed': 'record.error.export-target-changed',
    'publish-failed': 'record.error.export-publish-failed',
    'publish-in-progress': 'record.error.export-publish-in-progress',
    'invalid-request': 'record.error.export-invalid-request',
    'unsupported-format': 'record.error.export-invalid-request',
    'task-not-found': 'record.error.export-task-not-found',
    'invalid-owner': 'record.error.export-invalid-request',
    'export-timeout': 'record.error.export-encode-failed',
    // R4 contract §4.1 validation codes
    'empty-selection': 'recording.editor.error.empty-selection',
    'invalid-video-option': 'recording.editor.error.invalid-video-option',
    'fps-above-source': 'recording.editor.error.fps-above-source',
    'too-many-segments': 'recording.editor.error.too-many-segments',
    'overlapping-segments': 'recording.editor.error.overlapping-segments',
    'ambiguous-selection': 'recording.editor.error.ambiguous-selection'
  })

  function errorKey(code) {
    return ERROR_KEYS[code] || 'record.error.export-failed'
  }

  function finiteNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function formatClock(milliseconds) {
    const total = Math.max(0, Math.round(Number(milliseconds) || 0))
    const seconds = Math.floor(total / 1000)
    const tenths = Math.floor((total % 1000) / 100)
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${tenths}`
  }

  // "00:01.2" | "1.2" | "1:02" | 1200 -> milliseconds. Returns null for anything unusable so the
  // caller can keep the last valid value instead of jumping the trim point to 0.
  function parseTimeInput(text) {
    if (typeof text === 'number') return finiteNumber(text)
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

  function createRecordTrimController({
    sessionId = '',
    projectId = '',
    project = null,
    metadata = null,
    revision = 0,
    available = null,
    translate = (key) => key,
    api = null,
    render = {},
    now = () => Date.now(),
    log = () => {}
  } = {}) {
    const hasSession = typeof sessionId === 'string' && sessionId.length > 0
    const hasProject = typeof projectId === 'string' && projectId.length > 0
    if (!hasSession && !hasProject) throw new TypeError('Record trim controller requires a session or project id')
    const durationMs = Math.max(0, Math.round(finiteNumber(metadata?.durationMs) || 0))
    const video = metadata?.video || {}
    const notify = (patch) => {
      if (typeof render.onChange === 'function') {
        try { render.onChange(state(), patch) } catch (error) { log('trim render failed:', error?.message || error) }
      }
    }

    const model = {
      sessionId: hasSession ? sessionId : '',
      projectId: hasProject ? projectId : '',
      revision: Math.max(0, Math.round(finiteNumber(revision) || 0)),
      // Project mode starts closed for recovery until the page says the source is usable.
      available: available === null ? true : available === true,
      metadata: {
        durationMs,
        startMs: Math.round(finiteNumber(metadata?.startMs) || 0),
        video: {
          width: Math.round(finiteNumber(video.width) || 0),
          height: Math.round(finiteNumber(video.height) || 0),
          frameRate: finiteNumber(video.frameRate) || 0
        },
        audio: { exists: metadata?.audio?.exists === true }
      },
      // Legacy single range (session mode) AND the derived outer range in project mode.
      range: { startMs: 0, endMs: durationMs },
      // Project mode's authoritative edit. Materialised: [] only when the user deleted
      // everything (explicit "no content", never "whole recording").
      segments: [],
      format: 'mp4',
      gif: { fps: GIF_FRAME_RATES[1], maxEdgePx: LIMITS.GIF_MAX_EDGE_PX, loop: true },
      // Export-panel video options. Contract §7.5: NOT persisted in the draft; a reopened
      // editor starts at source/standard/source.
      video: { resolution: 'source', quality: 'standard', fps: 'source' },
      // R5 demo parameters. Zooms are SOURCE-time; clicks come from the event track and
      // are only exported when style.ripples is on. Neither is burned into the source.
      demo: { style: demoApi.normalizeDemoStyle(null), zooms: [] },
      eventTrack: null,
      eventsState: { loaded: false, available: false, degraded: '', clickCount: 0, pointerCount: 0, truncated: false },
      ignoredSuggestions: [],
      suggestions: [],
      // Session playback window `{startMs,endMs}`; project playback `{mode:'kept',fromMs}`.
      playing: null,
      playheadMs: 0,
      // Export phase: idle -> submitting -> active -> succeeded | failed | cancelled
      phase: 'idle',
      task: null,
      receipt: null,
      error: null,
      // requestId is minted per ATTEMPT so a retry after a failure is a new request, while a
      // status poll/replay of the same attempt keeps its key (plan §8.3).
      requestId: '',
      // The segments/format actually submitted, shown frozen while the encode runs.
      frozen: null,
      // Draft autosave (editor mode only): the project revision the next save compare-and-
      // swaps against, plus the visible status the header renders.
      draftDirty: false,
      draftSaving: false,
      draftConflict: false,
      draftError: null
    }
    // Bumped on every user edit; a save only clears `draftDirty` when no edit landed while the
    // transport was in flight (otherwise the next debounce must still run).
    let draftEpoch = 0
    // Undo/redo stacks of segment snapshots, plus the in-flight drag snapshot.
    let history = []
    let future = []
    let pendingSnapshot = null

    // Materialise the initial edit: a project seeds from its saved keepRanges, a session starts
    // with the whole recording kept (session mode does not use segments for export).
    if (project && typeof project === 'object') applyEdit(project.edit)
    else model.segments = materializedFull()

    function materializedFull() {
      if (!(model.metadata.durationMs > 0)) return []
      return [{ startMs: 0, endMs: model.metadata.durationMs }]
    }

    function isFullSelection() {
      if (model.segments.length === 0) return false
      return timeline.isFullRange(model.segments, model.metadata.durationMs)
    }

    function syncRange() {
      if (model.segments.length > 0) {
        model.range = {
          startMs: model.segments[0].startMs,
          endMs: model.segments[model.segments.length - 1].endMs
        }
      } else {
        model.range = { startMs: 0, endMs: 0 }
      }
    }

    function keptMs() {
      if (model.segments.length === 0) return 0
      return timeline.totalKeptMs(model.segments, model.metadata.durationMs)
    }

    function lastKeptEnd() {
      return model.segments.length > 0 ? model.segments[model.segments.length - 1].endMs : 0
    }

    function snapshotSegments() {
      return timeline.copySegments(model.segments)
    }

    function pushHistory() {
      history.push(snapshotSegments())
      if (history.length > HISTORY_LIMIT) history.shift()
      future = []
    }

    function canUndo() {
      return history.length > 0 && !isFrozen()
    }

    function canRedo() {
      return future.length > 0 && !isFrozen()
    }

    // Begin a multi-step interaction (one drag). The stack is only advanced on commit, so the
    // whole drag undoes as one user action.
    function beginEdit() {
      if (isFrozen() || pendingSnapshot) return false
      pendingSnapshot = snapshotSegments()
      return true
    }

    function commitEdit() {
      if (!pendingSnapshot) return false
      const before = pendingSnapshot
      pendingSnapshot = null
      if (timeline.segmentsEqual(before, model.segments)) {
        notify({ reason: 'edit-unchanged' })
        return false
      }
      history.push(before)
      if (history.length > HISTORY_LIMIT) history.shift()
      future = []
      markDraftEdited()
      notify({ reason: 'edit-committed' })
      return true
    }

    function cancelEdit() {
      if (!pendingSnapshot) return false
      model.segments = pendingSnapshot
      pendingSnapshot = null
      syncRange()
      notify({ reason: 'edit-cancelled' })
      return true
    }

    function applySegments(nextSegments, { reason = 'segments', historyMode = 'auto' } = {}) {
      if (isFrozen()) return false
      const normalized = timeline.copySegments(nextSegments)
      if (timeline.segmentsEqual(normalized, model.segments)) return false
      if (historyMode === 'auto') pushHistory()
      model.segments = normalized
      syncRange()
      if (historyMode !== 'transient') markDraftEdited()
      notify({ reason })
      return true
    }

    function splitAt(atMs) {
      if (isFrozen()) return false
      const next = timeline.splitAt(model.segments, atMs, model.metadata.durationMs)
      return applySegments(next, { reason: 'split' })
    }

    function deleteSegmentAt(atMs) {
      if (isFrozen()) return false
      const next = timeline.deleteSegmentAt(model.segments, atMs, model.metadata.durationMs)
      return applySegments(next, { reason: 'delete-segment' })
    }

    function resetEdits() {
      if (isFrozen() || isFullSelection()) return false
      return applySegments(materializedFull(), { reason: 'reset-edits' })
    }

    // Boundary drag entry points. While beginEdit() is active the moves are transient (the
    // drag is one undo entry); a direct call (keyboard/nudge) records its own entry.
    function moveBoundary(index, edge, targetMs) {
      if (isFrozen()) return false
      const next = timeline.moveBoundary(model.segments, index, edge, targetMs, model.metadata.durationMs)
      return applySegments(next, {
        reason: 'boundary',
        historyMode: pendingSnapshot ? 'transient' : 'auto'
      })
    }

    function moveJunction(index, targetMs) {
      if (isFrozen()) return false
      const next = timeline.moveJunction(model.segments, index, targetMs, model.metadata.durationMs)
      return applySegments(next, {
        reason: 'junction',
        historyMode: pendingSnapshot ? 'transient' : 'auto'
      })
    }

    function undoEdit() {
      if (!canUndo()) return false
      future.push(snapshotSegments())
      model.segments = history.pop()
      syncRange()
      markDraftEdited()
      notify({ reason: 'undo' })
      return true
    }

    function redoEdit() {
      if (!canRedo()) return false
      history.push(snapshotSegments())
      model.segments = future.pop()
      syncRange()
      markDraftEdited()
      notify({ reason: 'redo' })
      return true
    }

    function canSplitAt(atMs) {
      if (isFrozen() || !(model.metadata.durationMs > 0) || model.segments.length === 0) return false
      const next = timeline.splitAt(model.segments, atMs, model.metadata.durationMs)
      return !timeline.segmentsEqual(next, model.segments)
    }

    function canDeleteAt(atMs) {
      if (isFrozen() || !(model.metadata.durationMs > 0)) return false
      return timeline.segmentAt(model.segments, atMs, model.metadata.durationMs) >= 0
    }

    function state() {
      const gif = gifBudget()
      const videoBudgetResult = videoBudget()
      return {
        sessionId: model.sessionId,
        projectId: model.projectId,
        revision: model.revision,
        available: model.available,
        durationMs: model.metadata.durationMs,
        metadata: { ...model.metadata },
        // Legacy single-range projection (first kept start .. last kept end) for tests and for
        // any consumer that still reads `range`; `segments` is authoritative in project mode.
        range: { ...model.range },
        // Session mode keeps the legacy single range authoritative; project mode uses the
        // materialised segment list.
        segments: model.projectId
          ? model.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs }))
          : [{ startMs: model.range.startMs, endMs: model.range.endMs }],
        keptMs: model.projectId ? keptMs() : Math.max(0, model.range.endMs - model.range.startMs),
        totalKeptMs: model.projectId ? keptMs() : Math.max(0, model.range.endMs - model.range.startMs),
        emptySelection: model.projectId && model.segments.length === 0,
        edited: model.projectId ? !isFullSelection() : model.edited,
        undo: model.projectId ? canUndo() : false,
        redo: model.projectId ? canRedo() : false,
        selectionMs: model.projectId ? keptMs() : Math.max(0, model.range.endMs - model.range.startMs),
        format: model.format,
        gif: { ...model.gif },
        gifBudget: gif,
        video: { ...model.video },
        videoBudget: videoBudgetResult,
        demo: {
          style: { ...model.demo.style },
          zooms: model.demo.zooms.map((zoom) => ({ ...zoom })),
          canAddZoom: canAddZoom(),
          maxZooms: demoApi.ZOOM_LIMITS.maxSegments,
          events: { ...model.eventsState },
          suggestions: model.suggestions.map((suggestion) => ({ ...suggestion })),
          canvas: demoCanvas()
        },
        videoOptions: {
          resolutions: timeline.availableResolutions(model.metadata.video.width, model.metadata.video.height),
          frameRates: timeline.availableFrameRates(model.metadata.video.frameRate),
          qualities: [...timeline.QUALITY_LEVELS]
        },
        playing: model.playing ? { ...model.playing } : null,
        playheadMs: model.playheadMs,
        phase: model.phase,
        task: model.task ? { ...model.task } : null,
        receipt: model.receipt ? { ...model.receipt } : null,
        error: model.error ? { ...model.error } : null,
        frozen: model.frozen
          ? {
            segments: model.frozen.segments.map((segment) => ({ ...segment })),
            format: model.frozen.format,
            gif: model.frozen.gif ? { ...model.frozen.gif } : null,
            video: model.frozen.video ? { ...model.frozen.video } : null,
            keptMs: model.frozen.keptMs
          }
          : null,
        // Editor mode: the autosave status the header renders and the page schedules saves
        // from. `conflict` means a save was refused because another window wrote first.
        draft: {
          dirty: model.draftDirty,
          saving: model.draftSaving,
          conflict: model.draftConflict,
          revision: model.revision
        },
        draftError: model.draftError ? { ...model.draftError } : null,
        canExport: canExport(),
        canCancel: canCancel(),
        busy: model.phase === 'submitting' || model.phase === 'active',
        // Plan §8.4: after the publish point the cancel button says "finishing".
        finishing: model.task?.state === 'publishing',
        labels: labels()
      }
    }

    function labels() {
      const range = model.frozen ? model.range : model.range
      const gif = gifBudget()
      return {
        title: translate('record.trim.title'),
        selection: translate('record.trim.selection', {
          start: formatClock(range.startMs),
          end: formatClock(range.endMs),
          duration: formatClock(Math.max(0, model.projectId ? keptMs() : range.endMs - range.startMs))
        }),
        duration: translate('record.trim.duration', { duration: formatClock(model.metadata.durationMs) }),
        formatMp4: translate('record.trim.format.mp4'),
        formatGif: translate('record.trim.format.gif'),
        gifFrames: gif.ok ? translate('record.trim.gif-frames', { frames: gif.frames }) : '',
        gifNoAudio: translate('record.trim.gif-no-audio'),
        export: model.phase === 'active'
          ? (model.task?.state === 'publishing' ? translate('record.trim.finishing') : translate('record.trim.exporting'))
          : translate('record.trim.export')
      }
    }

    // The GIF budget for the CURRENT kept content. A deleted-everything state has no duration,
    // which is exactly how normalizeGifOptions reports "cannot export".
    function gifBudget() {
      const selectionMs = model.projectId
        ? keptMs()
        : Math.max(0, model.range.endMs - model.range.startMs)
      const dimensions = computeGifDimensions({
        width: model.metadata.video.width,
        height: model.metadata.video.height,
        maxEdgePx: model.gif.maxEdgePx
      })
      const normalized = normalizeGifOptions(
        { fps: model.gif.fps, maxEdgePx: model.gif.maxEdgePx, loop: true },
        { video: { width: model.metadata.video.width, height: model.metadata.video.height } },
        selectionMs
      )
      const frames = estimateGifFrames(selectionMs, model.gif.fps)
      return {
        ok: normalized.ok,
        code: normalized.ok ? '' : normalized.code,
        frames,
        maxFrames: LIMITS.GIF_MAX_FRAMES,
        width: dimensions.ok ? dimensions.value.width : 0,
        height: dimensions.ok ? dimensions.value.height : 0,
        durationMs: selectionMs
      }
    }

    // The mp4/webm output size and fps the exporter will produce, computed here from the same
    // shared options so the panel's "final W x H" cannot disagree with the file.
    function videoBudget() {
      if (model.format === 'gif') return { ok: true, value: null }
      // W8 owns the authoritative normaliser (copy fast-path, error codes, dimensions); the
      // local timeline helper is the identical fallback used until that module lands.
      if (typeof options.normalizeVideoOptions === 'function') {
        return options.normalizeVideoOptions(
          model.video,
          { video: { ...model.metadata.video }, audio: { ...model.metadata.audio } },
          model.format,
          isFullSelection()
        )
      }
      return timeline.normalizeVideoOptions(model.video, {
        sourceWidth: model.metadata.video.width,
        sourceHeight: model.metadata.video.height,
        sourceFrameRate: model.metadata.video.frameRate
      })
    }

    function rangeIsValid() {
      if (model.projectId) return model.segments.length > 0
      return normalizeRange(model.range, model.metadata.durationMs).ok
    }

    function canExport() {
      if (model.phase === 'submitting' || model.phase === 'active') return false
      // Project mode: a recoverable/unreadable source has no trustworthy duration, so export
      // stays disabled instead of offering a fake span (R3 contract §11 recovery rule).
      if (!model.available) return false
      if (!model.metadata.durationMs) return false
      if (!rangeIsValid()) return false
      if (model.projectId && model.segments.length === 0) return false
      if (model.format === 'gif') {
        if (!gifBudget().ok) return false
      } else if (!videoBudget().ok) {
        return false
      }
      return true
    }

    // The page toggles this when the project's recovery state changes (ready <-> recoverable).
    // A recovery state never invents a duration: the export gate is simply closed.
    function setAvailable(value, detail = '') {
      const next = value === true
      if (model.available === next) return false
      model.available = next
      model.availableDetail = typeof detail === 'string' ? detail : ''
      notify({ reason: 'availability' })
      return true
    }

    function canCancel() {
      return model.phase === 'active' && model.task?.state !== 'publishing'
    }

    // ---------- draft autosave (project mode) ----------

    // Every user edit bumps the epoch so a save that was in flight when the next edit landed
    // cannot clear the dirty flag of the newer state.
    function markDraftEdited() {
      if (!model.projectId) return
      draftEpoch += 1
      model.draftDirty = true
    }

    // ---------- legacy trim points (session API; project delegates to boundaries) ----------

    function setStart(valueMs) {
      if (isFrozen()) return false
      const parsed = parseTimeInput(valueMs)
      if (parsed === null) return false
      if (model.projectId) {
        if (model.segments.length === 0) return false
        return moveBoundary(0, 'start', parsed)
      }
      const maxStart = Math.max(0, model.range.endMs - LIMITS.MIN_RANGE_MS)
      const startMs = Math.max(0, Math.min(Math.round(parsed), maxStart, model.metadata.durationMs))
      model.range.startMs = startMs
      model.edited = true
      markDraftEdited()
      notify({ reason: 'start' })
      return true
    }

    function setEnd(valueMs) {
      if (isFrozen()) return false
      const parsed = parseTimeInput(valueMs)
      if (parsed === null) return false
      if (model.projectId) {
        if (model.segments.length === 0) return false
        return moveBoundary(model.segments.length - 1, 'end', parsed)
      }
      const minEnd = Math.min(model.metadata.durationMs, model.range.startMs + LIMITS.MIN_RANGE_MS)
      const endMs = Math.max(minEnd, Math.min(Math.round(parsed), model.metadata.durationMs))
      model.range.endMs = endMs
      model.edited = true
      markDraftEdited()
      notify({ reason: 'end' })
      return true
    }

    function resetRange() {
      if (isFrozen()) return false
      if (model.projectId) return resetEdits()
      model.range = { startMs: 0, endMs: model.metadata.durationMs }
      model.edited = false
      markDraftEdited()
      notify({ reason: 'reset' })
      return true
    }

    function isFrozen() {
      return model.phase === 'submitting' || model.phase === 'active'
    }

    // ---------- format + video options ----------

    function setFormat(format) {
      if (isFrozen()) return false
      if (!EXPORT_FORMATS.includes(format)) return false
      model.format = format
      markDraftEdited()
      notify({ reason: 'format' })
      return true
    }

    function setGifFps(fps) {
      if (isFrozen()) return false
      if (!GIF_FRAME_RATES.includes(Number(fps))) return false
      model.gif.fps = Number(fps)
      markDraftEdited()
      notify({ reason: 'gif-fps' })
      return true
    }

    function setGifMaxEdge(edgePx) {
      if (isFrozen()) return false
      const value = Math.round(finiteNumber(edgePx) ?? 0)
      if (!(value >= LIMITS.GIF_MIN_EDGE_PX) || value > LIMITS.GIF_MAX_EDGE_PX) return false
      model.gif.maxEdgePx = value
      markDraftEdited()
      notify({ reason: 'gif-size' })
      return true
    }

    function setVideoOption(patch) {
      if (isFrozen()) return false
      const candidate = { ...model.video, ...patch }
      const normalized = timeline.normalizeVideoOptions(candidate, {
        sourceWidth: model.metadata.video.width,
        sourceHeight: model.metadata.video.height,
        sourceFrameRate: model.metadata.video.frameRate
      })
      if (!normalized.ok) return false
      model.video = {
        resolution: normalized.value.resolution,
        quality: normalized.value.quality,
        fps: normalized.value.fps
      }
      // Contract §7.5: export parameters are UI state, not draft state.
      notify({ reason: 'video-option' })
      return true
    }

    function setVideoResolution(resolution) {
      return setVideoOption({ resolution })
    }

    function setVideoQuality(quality) {
      return setVideoOption({ quality })
    }

    function setVideoFps(fps) {
      const value = fps === 'source' ? 'source' : Number(fps)
      return setVideoOption({ fps: value })
    }

    // ---------- playback ----------

    // Session mode: the old single-range playback. Kept exactly for the session API/tests.
    function playRange() {
      if (model.projectId) return startKeptPlayback(model.playheadMs)
      if (!model.metadata.durationMs || !rangeIsValid()) return null
      const startMs = model.range.startMs
      const endMs = model.range.endMs
      model.playing = { startMs, endMs }
      model.playheadMs = startMs
      notify({ reason: 'play-range' })
      return { ...model.playing }
    }

    // Project mode: play the kept content starting at/after the playhead, skipping removed
    // gaps. Returns the first kept source position to seek to, or null when nothing remains.
    function startKeptPlayback(fromSourceMs = model.playheadMs) {
      if (model.projectId && (model.segments.length === 0 || !(model.metadata.durationMs > 0))) return null
      const candidate = Math.max(0, Math.round(finiteNumber(fromSourceMs) ?? 0))
      let startMs
      if (timeline.segmentAt(model.segments, candidate, model.metadata.durationMs) >= 0) {
        startMs = candidate
      } else {
        const next = timeline.nextKeptStart(model.segments, candidate, model.metadata.durationMs)
        if (next === null) return null
        startMs = next
      }
      model.playing = { mode: 'kept', fromMs: startMs, totalMs: keptMs() }
      model.playheadMs = startMs
      notify({ reason: 'play-kept' })
      return { startMs, endMs: lastKeptEnd(), totalMs: keptMs() }
    }

    function stopRangePlayback() {
      if (!model.playing) return false
      model.playing = null
      notify({ reason: 'stop-range' })
      return true
    }

    // The page reports the media clock. Returns `{ action: 'seek'|'pause'|'none', toMs }` so the
    // controller owns the decision and the page only executes it.
    function reportTime(positionMs, { fromUser = false } = {}) {
      const position = Math.max(0, Math.round(finiteNumber(positionMs) || 0))
      if (fromUser) {
        model.playheadMs = position
        // A user scrub during playback ends the range: the playhead is now wherever the user
        // put it, and the segments must not follow it.
        if (model.playing) {
          model.playing = null
          notify({ reason: 'scrub' })
        }
        return { action: 'none', toMs: position }
      }
      model.playheadMs = position
      if (!model.playing) {
        notify({ reason: 'time' })
        return { action: 'none', toMs: position }
      }
      if (model.playing.mode === 'kept') {
        const lastEnd = lastKeptEnd()
        if (position >= lastEnd || model.segments.length === 0) {
          model.playing = null
          notify({ reason: 'kept-end' })
          return { action: 'pause', toMs: lastEnd }
        }
        if (timeline.segmentAt(model.segments, position, model.metadata.durationMs) >= 0) {
          return { action: 'none', toMs: position }
        }
        // In a removed gap: jump to the next kept start instead of playing deleted content.
        const next = timeline.nextKeptStart(model.segments, position, model.metadata.durationMs)
        if (next === null) {
          model.playing = null
          notify({ reason: 'kept-end' })
          return { action: 'pause', toMs: lastEnd }
        }
        return { action: 'seek', toMs: next }
      }
      // Session single-range playback (unchanged R3 semantics).
      if (position >= model.playing.endMs) {
        model.playing = null
        notify({ reason: 'range-end' })
        return { action: 'pause', toMs: model.range.endMs }
      }
      if (position < model.playing.startMs) {
        // A codec keyframe boundary: ask for a re-seek rather than playing the trimmed head.
        return { action: 'seek', toMs: model.playing.startMs }
      }
      return { action: 'none', toMs: position }
    }

    // ---------- demo model (R5 style / zoom / ripples / suggestions) ----------

    function markDemoEdited(reason) {
      markDraftEdited()
      notify({ reason })
    }

    function demoDuration() {
      return model.metadata.durationMs
    }

    // Source-time selection the demo values are mapped through (materialised; an empty list
    // means the user deleted every segment, so there is no output content at all).
    function demoSelection() {
      return model.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs }))
    }

    function demoCanvas() {
      const video = model.metadata.video
      const result = demoApi.resolveDemoCanvas({
        sourceWidth: video.width,
        sourceHeight: video.height,
        resolution: model.video.resolution,
        style: model.demo.style
      })
      // W12 currently wraps the value as {ok,value}; accept either shape so a change on
      // either side cannot blank the preview frame.
      if (result && result.ok === false) {
        return { contentWidth: 0, contentHeight: 0, canvasWidth: 0, canvasHeight: 0, paddingPx: 0, radiusPx: 0 }
      }
      return result && result.value ? result.value : result
    }

    // Source media time -> output (edited/concat) time; null when the position was deleted.
    function outputTimeFor(sourceMs) {
      if (!(demoDuration() > 0) || model.segments.length === 0) return null
      return timeline.sourceToEdited(model.segments, sourceMs, demoDuration())
    }

    function mappedZoomsOutput() {
      return demoApi.mapDemoToOutput(
        { style: model.demo.style, zooms: model.demo.zooms, clicks: [] },
        demoSelection()
      ).zooms
    }

    function mappedClicksOutput() {
      if (!model.eventTrack || model.eventTrack.clicks.length === 0) return []
      return demoApi.mapDemoToOutput(
        { style: model.demo.style, zooms: [], clicks: model.eventTrack.clicks },
        demoSelection()
      ).clicks
    }

    // Preview zoom at a SOURCE position: map to output time, then evaluate the shared ramp.
    function previewZoomAt(sourceMs) {
      const outputMs = outputTimeFor(sourceMs)
      if (outputMs === null) return { scale: 1, focusX: 0.5, focusY: 0.5, active: false }
      const zooms = mappedZoomsOutput()
      if (zooms.length === 0) return { scale: 1, focusX: 0.5, focusY: 0.5, active: false }
      if (typeof demoApi.evaluateZoomAt === 'function') {
        const value = demoApi.evaluateZoomAt(zooms, outputMs) || {}
        const scale = Math.max(1, Math.min(demoApi.ZOOM_LIMITS.scaleMax, Number(value.scale) || 1))
        return {
          scale,
          focusX: Math.max(0, Math.min(1, Number(value.focusX))),
          focusY: Math.max(0, Math.min(1, Number(value.focusY))),
          active: scale > 1.0001
        }
      }
      return { scale: 1, focusX: 0.5, focusY: 0.5, active: false }
    }

    function recomputeSuggestions() {
      if (!model.eventTrack || model.segments.length === 0 || !(demoDuration() > 0)) {
        model.suggestions = []
        return
      }
      let suggestions = []
      try {
        suggestions = demoApi.suggestZoomSegments({
          track: model.eventTrack,
          durationMs: demoDuration(),
          outputSegments: demoSelection()
        }) || []
      } catch (error) {
        log('demo: suggestZoomSegments failed:', error?.message || error)
        suggestions = []
      }
      model.suggestions = suggestions.filter((suggestion) => !model.ignoredSuggestions.includes(suggestion.id))
    }

    function applyEventTrack(track, { degraded = '' } = {}) {
      if (track && typeof track === 'object') {
        try {
          model.eventTrack = demoApi.normalizeClickTrack(track)
          model.eventsState = {
            loaded: true,
            available: model.eventTrack.clicks.length > 0 || model.eventTrack.pointer.length > 0,
            degraded: '',
            clickCount: model.eventTrack.clicks.length,
            pointerCount: model.eventTrack.pointer.length,
            truncated: model.eventTrack.truncated === true
          }
        } catch (error) {
          log('demo: invalid event track:', error?.message || error)
          model.eventTrack = null
          model.eventsState = { loaded: true, available: false, degraded: degraded || 'invalid', clickCount: 0, pointerCount: 0, truncated: false }
        }
      } else {
        model.eventTrack = null
        model.eventsState = {
          loaded: true,
          available: false,
          degraded: degraded || '',
          clickCount: 0,
          pointerCount: 0,
          truncated: false
        }
      }
      // Ripples need clicks; without an event track the switch must not pretend to work.
      if ((!model.eventTrack || model.eventTrack.clicks.length === 0) && model.demo.style.ripples) {
        model.demo.style = demoApi.normalizeDemoStyle({ ...model.demo.style, ripples: false })
        markDemoEdited('demo-style')
      }
      recomputeSuggestions()
      notify({ reason: 'events-loaded' })
      return true
    }

    function setDemoStylePatch(patch, reason = 'demo-style') {
      if (isFrozen()) return false
      const next = demoApi.normalizeDemoStyle({ ...model.demo.style, ...patch })
      if (JSON.stringify(next) === JSON.stringify(model.demo.style)) return false
      model.demo.style = next
      markDemoEdited(reason)
      return true
    }

    function setDemoEnabled(value) {
      return setDemoStylePatch({ enabled: value === true })
    }

    function setDemoBackground(color) {
      return setDemoStylePatch({ background: color }, 'demo-style')
    }

    function setDemoPaddingPercent(percent) {
      const number = Number(percent)
      if (!Number.isFinite(number)) return false
      return setDemoStylePatch({ padding: number / 100 }, 'demo-style')
    }

    function setDemoRadius(radiusPx) {
      const number = Number(radiusPx)
      if (!Number.isFinite(number)) return false
      return setDemoStylePatch({ radius: number }, 'demo-style')
    }

    function setDemoShadow(value) {
      return setDemoStylePatch({ shadow: value === true })
    }

    function setDemoRipples(value) {
      if (value === true) {
        if (!model.eventTrack || model.eventTrack.clicks.length === 0) return false
        return setDemoStylePatch({ ripples: true })
      }
      return setDemoStylePatch({ ripples: false })
    }

    function resetDemo() {
      if (isFrozen()) return false
      model.demo = { style: demoApi.normalizeDemoStyle(null), zooms: [] }
      model.ignoredSuggestions = []
      recomputeSuggestions()
      markDemoEdited('demo-reset')
      return true
    }

    function canAddZoom() {
      if (isFrozen() || !model.projectId) return false
      if (!(demoDuration() >= demoApi.ZOOM_LIMITS.minDurationMs)) return false
      if (model.demo.zooms.length >= demoApi.ZOOM_LIMITS.maxSegments) return false
      return true
    }

    // Add a 2.0x zoom starting at the playhead, clamped into the media and around the
    // existing (non-overlapping) zoom segments. A zoom segment lasts at least 1.2 s.
    function addZoomAt(sourceMs) {
      if (!canAddZoom()) return false
      const duration = demoDuration()
      const minDuration = 1200
      let startMs = Math.max(0, Math.min(Math.round(Number(sourceMs) || 0), duration - minDuration))
      // Skip past any segment the new zoom would overlap; adjacency stays legal.
      for (const zoom of model.demo.zooms) {
        if (startMs < zoom.endMs && startMs + minDuration > zoom.startMs) startMs = zoom.endMs
      }
      startMs = Math.max(0, Math.min(startMs, duration - minDuration))
      let endMs = Math.min(duration, startMs + minDuration)
      const next = model.demo.zooms.find((zoom) => zoom.startMs >= startMs && zoom.startMs < endMs)
      if (next) endMs = next.startMs
      if (endMs - startMs < demoApi.ZOOM_LIMITS.minDurationMs) return false
      const zoom = {
        id: 'zoom-' + (model.demo.zooms.length + 1) + '-' + Math.round(now()),
        startMs,
        endMs,
        scale: 2,
        focusX: 0.5,
        focusY: 0.5,
        easing: 'ease-in-out'
      }
      const nextZooms = demoApi.normalizeZoomSegments([...model.demo.zooms, zoom])
      if (nextZooms.length === model.demo.zooms.length) return false
      model.demo.zooms = nextZooms
      markDemoEdited('demo-zoom')
      return true
    }

    function updateZoom(index, patch) {
      if (isFrozen()) return false
      const position = Math.round(Number(index))
      if (!Number.isInteger(position) || position < 0 || position >= model.demo.zooms.length) return false
      const next = model.demo.zooms.map((zoom, zoomIndex) => (
        zoomIndex === position ? { ...zoom, ...patch } : zoom
      ))
      const normalized = demoApi.normalizeZoomSegments(next)
      if (normalized.length !== model.demo.zooms.length) return false
      model.demo.zooms = normalized
      markDemoEdited('demo-zoom')
      return true
    }

    function updateZoomScale(index, scale) {
      return updateZoom(index, { scale: Number(scale) })
    }

    function updateZoomFocus(index, focusX, focusY) {
      const x = Number(focusX)
      const y = Number(focusY)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false
      return updateZoom(index, { focusX: x, focusY: y })
    }

    function deleteZoom(index) {
      if (isFrozen()) return false
      const position = Math.round(Number(index))
      if (!Number.isInteger(position) || position < 0 || position >= model.demo.zooms.length) return false
      model.demo.zooms = model.demo.zooms.filter((_zoom, zoomIndex) => zoomIndex !== position)
      markDemoEdited('demo-zoom')
      return true
    }

    function addSuggestion(index) {
      if (isFrozen()) return false
      const position = Math.round(Number(index))
      if (!Number.isInteger(position) || position < 0 || position >= model.suggestions.length) return false
      const suggestion = model.suggestions[position]
      if (model.demo.zooms.length >= demoApi.ZOOM_LIMITS.maxSegments) return false
      const zoom = {
        id: 'zoom-suggest-' + (model.demo.zooms.length + 1),
        startMs: suggestion.startMs,
        endMs: suggestion.endMs,
        scale: suggestion.scale,
        focusX: suggestion.focusX,
        focusY: suggestion.focusY,
        easing: 'ease-in-out'
      }
      const normalized = demoApi.normalizeZoomSegments([...model.demo.zooms, zoom])
      if (normalized.length === model.demo.zooms.length) return false
      model.demo.zooms = normalized
      model.ignoredSuggestions = model.ignoredSuggestions.concat(suggestion.id)
      recomputeSuggestions()
      markDemoEdited('demo-suggestion')
      return true
    }

    function ignoreSuggestion(index) {
      if (isFrozen()) return false
      const position = Math.round(Number(index))
      if (!Number.isInteger(position) || position < 0 || position >= model.suggestions.length) return false
      model.ignoredSuggestions = model.ignoredSuggestions.concat(model.suggestions[position].id)
      recomputeSuggestions()
      notify({ reason: 'demo-suggestion' })
      return true
    }

    // ---------- project draft (editor mode) ----------

    // The edit object the project service persists (R1 schema): `keepRanges: []` means "whole
    // recording", otherwise 1-20 ordered half-open ranges. LIMITATION: the schema cannot express
    // "the user deleted everything", so a zero-segment edit is saved as [] (reopens as whole);
    // the current session still refuses to export it. `gif` uses the schema's `edge` name.
    function buildDraftEdit() {
      let keepRanges = []
      if (model.metadata.durationMs > 0 && model.segments.length > 0 && !isFullSelection()) {
        keepRanges = model.segments.map((segment, index) => ({
          id: `keep-${index + 1}`,
          startMs: segment.startMs,
          endMs: segment.endMs
        }))
      }
      return {
        revision: model.revision,
        keepRanges,
        format: model.format,
        gif: { edge: model.gif.maxEdgePx, fps: model.gif.fps },
        // R5 contract §4.1: style and SOURCE-time zoom segments ride the same CAS draft.
        style: { ...model.demo.style },
        zoomSegments: model.demo.zooms.map((zoom) => ({ ...zoom }))
      }
    }

    function applyMetadata(next) {
      const nextVideo = next?.video || {}
      const nextAudio = next?.audio || {}
      model.metadata = {
        durationMs: Math.max(0, Math.round(finiteNumber(next?.durationMs) || 0)),
        startMs: Math.round(finiteNumber(next?.startMs) || 0),
        video: {
          width: Math.round(finiteNumber(nextVideo.width) || 0),
          height: Math.round(finiteNumber(nextVideo.height) || 0),
          frameRate: finiteNumber(nextVideo.frameRate) || 0
        },
        // The editor gets the probe shape `{ tracks }` from `record-editor:init.metadata`;
        // the trim UI only needs the boolean the export options normaliser uses.
        audio: { exists: nextAudio.exists === true || Math.round(finiteNumber(nextAudio.tracks) || 0) > 0 }
      }
      if (model.metadata.durationMs > 0) {
        if (model.segments.length === 0) {
          model.segments = []
        } else {
          const normalized = timeline.normalizeSegments(model.segments, model.metadata.durationMs)
          model.segments = normalized.length > 0 ? normalized : materializedFull()
        }
      } else {
        model.segments = []
      }
      syncRange()
    }

    // Load the persisted edit into the live state. Called for the first `record-editor:init`
    // and again after a revision conflict / recovery retry, so it must be idempotent and must
    // not leave stale dirty/conflict/history flags behind.
    function applyEdit(edit) {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return false
      const projectRevision = Math.round(finiteNumber(edit.revision))
      if (projectRevision !== null && projectRevision >= 0) model.revision = projectRevision

      const keepRanges = Array.isArray(edit.keepRanges) ? edit.keepRanges : []
      if (model.metadata.durationMs > 0 && keepRanges.length > 0) {
        const normalized = timeline.normalizeSegments(keepRanges, model.metadata.durationMs)
        if (normalized.length > 0) {
          model.segments = normalized
        } else {
          log('draft: ignoring invalid keepRanges from the project; falling back to the full range')
          model.segments = materializedFull()
        }
      } else {
        model.segments = materializedFull()
      }

      if (EXPORT_FORMATS.includes(edit.format)) model.format = edit.format
      const gif = edit.gif && typeof edit.gif === 'object' ? edit.gif : {}
      const edge = Math.round(finiteNumber(gif.edge ?? gif.maxEdgePx) ?? LIMITS.GIF_MAX_EDGE_PX)
      if (edge >= LIMITS.GIF_MIN_EDGE_PX && edge <= LIMITS.GIF_MAX_EDGE_PX) model.gif.maxEdgePx = edge
      const fps = Math.round(finiteNumber(gif.fps) ?? 0)
      if (GIF_FRAME_RATES.includes(fps)) model.gif.fps = fps

      model.video = { resolution: 'source', quality: 'standard', fps: 'source' }
      model.demo = {
        style: demoApi.normalizeDemoStyle(edit.style),
        zooms: demoApi.normalizeZoomSegments(edit.zoomSegments)
      }
      model.ignoredSuggestions = []
      syncRange()
      recomputeSuggestions()
      history = []
      future = []
      pendingSnapshot = null
      model.draftDirty = false
      model.draftSaving = false
      model.draftConflict = false
      model.draftError = null
      draftEpoch = 0
      return true
    }

    // Merge a freshly loaded ProjectPublic into the controller. `options.metadata` is the
    // init payload's probe result (duration/video/audio); `options.available` closes the
    // export gate for a recoverable project.
    function applyProject(nextProject, options = {}) {
      if (!nextProject || typeof nextProject !== 'object') return false
      if (options.metadata) applyMetadata(options.metadata)
      applyEdit(nextProject.edit)
      if (options.available !== undefined) model.available = options.available === true
      notify({ reason: 'project' })
      return true
    }

    // One CAS save attempt. The page supplies the transport; a missing browser bridge is
    // reported as a code (not thrown) so the editor can render "autosave unavailable".
    async function saveDraft({ save } = {}) {
      if (!model.projectId) return { ok: false, code: 'draft-unavailable' }
      if (typeof save !== 'function') return { ok: false, code: 'draft-transport-missing' }
      if (!model.metadata.durationMs) return { ok: false, code: 'draft-unavailable' }
      if (!model.draftDirty || model.draftSaving) return { ok: true, skipped: true, revision: model.revision }
      const epoch = draftEpoch
      const edit = buildDraftEdit()
      model.draftSaving = true
      model.draftError = null
      notify({ reason: 'draft-saving' })
      let answer
      try {
        answer = await save({ projectId: model.projectId, expectedRevision: model.revision, edit })
      } catch (error) {
        model.draftSaving = false
        model.draftError = { code: 'save-failed', detail: error?.message || String(error) }
        notify({ reason: 'draft-failed' })
        return { ok: false, code: 'save-failed' }
      }
      model.draftSaving = false
      if (answer?.ok) {
        const nextRevision = Math.floor(finiteNumber(answer.revision) ?? model.revision)
        if (nextRevision >= 0) model.revision = nextRevision
        // Only clear the flag when no edit landed while the transport was in flight; a
        // newer state still owes the server a save.
        if (draftEpoch === epoch) {
          model.draftDirty = false
          model.draftConflict = false
        }
        model.draftError = null
        notify({ reason: 'draft-saved' })
        return { ok: true, skipped: false, revision: model.revision }
      }
      model.draftConflict = answer?.code === 'revision-conflict'
      model.draftError = { code: answer?.code || 'save-failed' }
      notify({ reason: model.draftConflict ? 'draft-conflict' : 'draft-failed' })
      return answer || { ok: false, code: 'save-failed' }
    }

    function draftState() {
      return {
        dirty: model.draftDirty,
        saving: model.draftSaving,
        conflict: model.draftConflict,
        revision: model.revision,
        error: model.draftError ? { ...model.draftError } : null
      }
    }

    // ---------- submit ----------

    function buildRequest() {
      // Session mode keeps the legacy single-range request shape (`range`), because the old
      // record:export channel is frozen there and still used by the session tests.
      if (!model.projectId) {
        const request = {
          format: model.format,
          range: { startMs: model.range.startMs, endMs: model.range.endMs }
        }
        if (model.format === 'gif') {
          request.gif = { maxEdgePx: model.gif.maxEdgePx, fps: model.gif.fps, loop: true }
        }
        return request
      }
      // R4 contract §4.1: `segments` omitted = whole recording; never send `range` alongside it
      // (that would be ambiguous-selection). GIF sends its own budget; mp4/webm send video
      // options so the main process freezes them with the request.
      const request = { format: model.format }
      if (model.segments.length > 0 && !isFullSelection()) {
        request.segments = model.segments.map((segment) => ({
          startMs: segment.startMs,
          endMs: segment.endMs
        }))
      }
      if (model.format === 'gif') {
        request.gif = { edge: model.gif.maxEdgePx, fps: model.gif.fps }
      } else {
        request.video = {
          resolution: model.video.resolution,
          quality: model.video.quality,
          fps: model.video.fps
        }
        // R5 contract §3.2: demo is source-time data; the main process maps it to output
        // time. Clicks are included only when ripples are on (and a track exists).
        const zoomPayload = model.demo.zooms.map((zoom) => ({
          id: zoom.id,
          startMs: zoom.startMs,
          endMs: zoom.endMs,
          scale: zoom.scale,
          focusX: zoom.focusX,
          focusY: zoom.focusY,
          easing: zoom.easing
        }))
        const clickPayload = model.demo.style.ripples && model.eventTrack
          ? model.eventTrack.clicks.map((click) => ({
            tMs: click.tMs,
            x: click.x,
            y: click.y,
            button: click.button
          }))
          : []
        if (model.demo.style.enabled || zoomPayload.length > 0 || clickPayload.length > 0) {
          request.demo = {
            style: { ...model.demo.style },
            zooms: zoomPayload,
            clicks: clickPayload
          }
        }
      }
      return request
    }

    // One submission attempt. The caller supplies the transport (`submit(request)`) so this
    // module stays Electron-free. Returns the `{ status, task }` the main process answered.
    async function startExport({ submit } = {}) {
      if (typeof submit !== 'function') throw new TypeError('Trim controller requires a submit transport')
      if (!canExport()) {
        const reason = model.projectId && model.segments.length === 0
          ? 'empty-selection'
          : !model.available
            ? 'probe-failed'
            : !model.metadata.durationMs
              ? 'duration-unavailable'
              : model.format === 'gif'
                ? (gifBudget().code || 'invalid-range')
                : (videoBudget().code || 'invalid-range')
        model.error = { code: reason }
        notify({ reason: 'export-rejected' })
        return { status: 'failed', code: reason }
      }
      model.error = null
      model.receipt = null
      model.task = null
      model.phase = 'submitting'
      model.requestId = `${(model.projectId || model.sessionId).slice(0, 8)}-${Math.round(now())}-${Math.round(Math.random() * 1e6)}`
      model.frozen = {
        segments: model.projectId
          ? snapshotSegments()
          : [{ startMs: model.range.startMs, endMs: model.range.endMs }],
        format: model.format,
        gif: model.format === 'gif' ? { ...model.gif } : null,
        video: model.format === 'gif' ? null : { ...model.video },
        keptMs: model.projectId ? keptMs() : Math.max(0, model.range.endMs - model.range.startMs)
      }
      notify({ reason: 'submitting' })
      let answer
      try {
        answer = await submit({ requestId: model.requestId, request: buildRequest() })
      } catch (error) {
        model.phase = 'failed'
        model.error = { code: 'encode-failed', detail: error?.message || String(error) }
        model.frozen = null
        notify({ reason: 'submit-threw' })
        return { status: 'failed', code: 'encode-failed' }
      }
      if (answer?.status === 'cancelled') {
        // The user dismissed the save dialog: no task exists, nothing was written (plan §8.3).
        model.phase = 'idle'
        model.frozen = null
        model.error = null
        notify({ reason: 'target-cancelled' })
        return { status: 'cancelled' }
      }
      if (answer?.status !== 'accepted') {
        model.phase = 'failed'
        model.error = { code: answer?.code || 'encode-failed' }
        model.frozen = null
        notify({ reason: 'submit-rejected' })
        return { status: 'failed', code: answer?.code || 'encode-failed' }
      }
      model.task = answer.task
      model.phase = 'active'
      if (TERMINAL_STATES.includes(answer.task?.state)) applyTask(answer.task)
      else notify({ reason: 'accepted' })
      return { status: 'accepted', task: answer.task }
    }

    // Progress push and status poll both land here, so a lost event is recoverable.
    function applyTask(task) {
      if (!task || typeof task !== 'object') return false
      if (model.task?.taskId && task.taskId && model.task.taskId !== task.taskId) return false
      model.task = { ...task }
      if (TERMINAL_STATES.includes(task.state)) {
        model.frozen = null
        if (task.state === 'succeeded') {
          model.phase = 'succeeded'
          model.receipt = task.receipt || null
          model.error = task.receipt ? null : { code: 'encode-failed' }
        } else if (task.state === 'cancelled') {
          model.phase = 'cancelled'
          model.error = null
          model.receipt = null
        } else {
          model.phase = 'failed'
          model.error = { code: task.error?.code || 'encode-failed' }
          model.receipt = null
        }
      } else if (task.state === 'cancelling' || task.state === 'publishing') {
        model.phase = 'active'
      } else {
        model.phase = 'active'
      }
      notify({ reason: 'task', state: task.state })
      return true
    }

    async function cancelExport({ cancel } = {}) {
      if (typeof cancel !== 'function' || !model.task?.taskId) return { ok: false, code: 'task-not-found' }
      const answer = await cancel({ taskId: model.task.taskId, requestId: model.requestId })
      if (answer?.ok && answer.task) applyTask(answer.task)
      // `publish-in-progress` is not an error the user caused: the bar keeps showing the task
      // and the button stays in its "finishing" state (plan §8.4).
      return answer || { ok: false, code: 'task-not-found' }
    }

    // A retry after a failure starts a NEW attempt (new requestId) with whatever the controls
    // now say; the previous frozen snapshot is gone.
    function prepareRetry() {
      if (model.phase === 'succeeded' || model.phase === 'active' || model.phase === 'submitting') return false
      model.phase = 'idle'
      model.task = null
      model.error = null
      model.receipt = null
      model.frozen = null
      notify({ reason: 'retry' })
      return true
    }

    // After a successful export the preview and the SOURCE stay alive so the user can trim
    // differently and export again (plan §8.2). Only `close()` ends the session.
    function resetAfterExport() {
      if (model.phase !== 'succeeded' && model.phase !== 'failed' && model.phase !== 'cancelled') return false
      model.phase = 'idle'
      model.task = null
      model.error = null
      model.receipt = null
      model.frozen = null
      notify({ reason: 'reset-after-export' })
      return true
    }

    return {
      // reads
      state,
      gifBudget,
      videoBudget,
      keptMs,
      formatClock,
      parseTimeInput,
      errorKey,
      // project / availability (editor mode)
      applyProject,
      buildDraftEdit,
      draftState,
      saveDraft,
      setAvailable,
      // legacy single-range trim (session API; project delegates to outer boundaries)
      setStart,
      setEnd,
      resetRange,
      // multi-segment edits + undo/redo (project mode)
      splitAt,
      deleteSegmentAt,
      resetEdits,
      moveBoundary,
      moveJunction,
      beginEdit,
      commitEdit,
      cancelEdit,
      undoEdit,
      redoEdit,
      canUndo,
      canRedo,
      canSplitAt,
      canDeleteAt,
      // demo style / zoom / ripples / suggestions (R5)
      DEMO_LIMITS: Object.freeze({
        RIPPLE: demoApi.RIPPLE_LIMITS,
        STYLE: demoApi.STYLE_LIMITS,
        ZOOM: demoApi.ZOOM_LIMITS,
        BACKGROUND_PRESETS: demoApi.BACKGROUND_PRESETS
      }),
      addSuggestion,
      addZoomAt,
      applyEventTrack,
      canAddZoom,
      deleteZoom,
      demoCanvas,
      ignoreSuggestion,
      mappedClicksOutput,
      mappedZoomsOutput,
      outputTimeFor,
      previewZoomAt,
      resetDemo,
      setDemoBackground,
      setDemoEnabled,
      setDemoPaddingPercent,
      setDemoRadius,
      setDemoRipples,
      setDemoShadow,
      updateZoom,
      updateZoomFocus,
      updateZoomScale,
      // format
      setFormat,
      setGifFps,
      setGifMaxEdge,
      setVideoResolution,
      setVideoQuality,
      setVideoFps,
      // playback
      playRange,
      startKeptPlayback,
      stopRangePlayback,
      reportTime,
      // export
      startExport,
      applyTask,
      cancelExport,
      prepareRetry,
      resetAfterExport,
      // test/debug surface
      getModel: () => model
    }
  }

  return {
    ERROR_KEYS,
    EXPORT_FORMATS,
    GIF_FRAME_RATES,
    HISTORY_LIMIT,
    LOCALE_KEYS,
    LIMITS,
    TERMINAL_STATES,
    createRecordTrimController,
    errorKey,
    formatClock,
    parseTimeInput
  }
})
