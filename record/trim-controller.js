'use strict'

// Trim + export controller shared by the recording preview (feature E3, plan §8.2/§8.3:
// docs/plans/2026-10-25-snow-apps-feature-development-plan.md) and the standalone recording
// editor (R1-R3 contract §9.3/§11: `record/editor.js`).
//
// This module owns the EDIT STATE, not the DOM: it is loaded by record/editor.html as a classic
// script (`window.recordTrimController`) and required by node tests, but every DOM mutation is
// a callback the page supplies. That keeps the decisions that actually matter - the half-open
// range, range playback, format/GIF budget, submission freeze, cancel arbitration, the result
// bar receipt, draft revision CAS - testable without a browser.
//
// Two addressing modes:
//   * session mode (`sessionId`): the old preview window, export goes to `record:export`.
//   * project mode (`projectId` + `project`, added for the editor): the project is the durable
//     identity, export goes to `record-editor:export`, and the edit is autosaved through
//     `updateDraft` with an expectedRevision CAS. A revision conflict is reported as state,
//     never silently overwritten; the page reloads the project.
//
// Contract notes:
//   * The range is `[startMs, endMs)` in SOURCE milliseconds, validated by the SAME
//     shared/recording-export-options.js the main process uses, so the UI cannot offer a
//     selection the server will reject.
//   * Playback: `playRange()` seeks to start and drives the <video>; when it reaches the end it
//     pauses. Scrubbing the playhead NEVER changes the trim points (plan §8.2).
//   * Export freeze: once a request is accepted, the range/format/GIF controls are frozen until
//     the task reaches a terminal state. A retry after failure re-reads the current controls,
//     but a retry of the SAME request keeps the same requestId so the server can replay it
//     instead of encoding twice (plan §8.3 "same requestId + same parameters reuses the task").
//   * Cancel: the button becomes "finishing" once the task reaches `publishing`, because after
//     that point the target may already have been replaced (plan §8.4).
//   * A published task shows a result bar fed by `{ status:'saved', resultId, fileName, kind }`,
//     exactly the feature-A receipt. A cancelled or failed task never produces one.

;(function initRecordTrimController(root, factory) {
  const options = typeof module === 'object' && module.exports
    ? require('../shared/recording-export-options')
    : root.recordingExportOptions
  const api = factory(options)
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.recordTrimController = api
})(typeof globalThis === 'object' ? globalThis : this, (options) => {
  const {
    GIF_FRAME_RATES,
    LIMITS,
    computeGifDimensions,
    estimateGifFrames,
    normalizeGifOptions,
    normalizeRange
  } = options

  const TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled'])

  // Locale keys this module resolves at runtime. The record UI contract test feeds this list
  // into its three-language check, so a new message cannot ship untranslated.
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
    'record.error.export-codec-missing'
  ])

  // Stable code -> locale key. Every code recording-export-service.js can return has an entry;
  // an unknown code falls back to the generic failure message rather than showing a raw token.
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
    'export-timeout': 'record.error.export-encode-failed'
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
        video: { width: Math.round(finiteNumber(video.width) || 0), height: Math.round(finiteNumber(video.height) || 0), frameRate: finiteNumber(video.frameRate) || 0 },
        audio: { exists: metadata?.audio?.exists === true }
      },
      range: { startMs: 0, endMs: durationMs },
      format: 'mp4',
      gif: { fps: GIF_FRAME_RATES[1], maxEdgePx: LIMITS.GIF_MAX_EDGE_PX, loop: true },
      // Playback window: `null` means "not range playing".
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
      // The range/format actually submitted. The UI shows the frozen snapshot, so moving a
      // handle during an encode cannot make the displayed numbers disagree with the file.
      frozen: null,
      // True once the user has moved a trim point: the default full range is replaced.
      edited: false,
      // Draft autosave (editor mode only): the project revision the next save compare-and-
      // swaps against, plus the visible status the header renders.
      draftDirty: false,
      draftSaving: false,
      draftConflict: false,
      draftError: null
    }
    // Bumped on every user edit; a save only clears `draftDirty` when no edit landed while
    // the transport was in flight (otherwise the next debounce must still run).
    let draftEpoch = 0
    // Seed the live edit from the project's persisted draft on construction, so the first
    // paint already shows the saved trim points and the next CAS compares against its revision.
    if (project && typeof project === 'object') applyEdit(project.edit)

    function state() {
      const range = model.range
      const gif = gifBudget()
    return {
      sessionId: model.sessionId,
      projectId: model.projectId,
      revision: model.revision,
      available: model.available,
      durationMs: model.metadata.durationMs,
        metadata: { ...model.metadata },
        range: { ...range },
        selectionMs: Math.max(0, range.endMs - range.startMs),
        format: model.format,
        gif: { ...model.gif },
        gifBudget: gif,
        playing: model.playing ? { ...model.playing } : null,
        playheadMs: model.playheadMs,
        phase: model.phase,
        task: model.task ? { ...model.task } : null,
        receipt: model.receipt ? { ...model.receipt } : null,
        error: model.error ? { ...model.error } : null,
        frozen: model.frozen ? { ...model.frozen } : null,
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
      const range = model.frozen?.range || model.range
      const gif = gifBudget()
      return {
        title: translate('record.trim.title'),
        selection: translate('record.trim.selection', {
          start: formatClock(range.startMs),
          end: formatClock(range.endMs),
          duration: formatClock(Math.max(0, range.endMs - range.startMs))
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

    // The GIF budget for the CURRENT selection, resolved with the shared validator so the
    // number shown is the number the server will accept.
    function gifBudget() {
      const selectionMs = Math.max(0, model.range.endMs - model.range.startMs)
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

    function rangeIsValid() {
      return normalizeRange(model.range, model.metadata.durationMs).ok
    }

    function canExport() {
      if (model.phase === 'submitting' || model.phase === 'active') return false
      // Project mode: a recoverable/unreadable source has no trustworthy duration, so export
      // stays disabled instead of offering a fake span (contract §11 recovery rule).
      if (!model.available) return false
      if (!model.metadata.durationMs) return false
      if (!rangeIsValid()) return false
      if (model.format === 'gif' && !gifBudget().ok) return false
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

    // ---------- trim points ----------

    // Setting a trim point never produces an invalid range: a start at/after the end is pushed
    // back by MIN_RANGE_MS (and vice versa), clamped to the media. The UI then shows a valid
    // selection instead of a disabled export button the user cannot explain.
    function setStart(valueMs) {
      if (isFrozen()) return false
      const parsed = parseTimeInput(valueMs)
      if (parsed === null) return false
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
      model.range = { startMs: 0, endMs: model.metadata.durationMs }
      model.edited = false
      markDraftEdited()
      notify({ reason: 'reset' })
      return true
    }

    function isFrozen() {
      return model.phase === 'submitting' || model.phase === 'active'
    }

    // ---------- format ----------

    function setFormat(format) {
      if (isFrozen()) return false
      if (format !== 'mp4' && format !== 'gif') return false
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

    // ---------- range playback ----------

    // Called by the page when the user presses play. Returns the range the <video> must honour,
    // or null when the current playhead is outside the selection (in which case the page seeks
    // to start first). Scrubbing never edits the trim points (plan §8.2).
    function playRange() {
      if (!model.metadata.durationMs || !rangeIsValid()) return null
      const startMs = model.range.startMs
      const endMs = model.range.endMs
      model.playing = { startMs, endMs }
      model.playheadMs = startMs
      notify({ reason: 'play-range' })
      return { ...model.playing }
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
        // A user scrub during range playback ends the range: the playhead is now wherever the
        // user put it, and the trim points must not follow it.
        if (model.playing && (position < model.playing.startMs || position >= model.playing.endMs)) {
          model.playing = null
          notify({ reason: 'scrub-outside-range' })
        }
        return { action: 'none', toMs: position }
      }
      model.playheadMs = position
      if (!model.playing) {
        notify({ reason: 'time' })
        return { action: 'none', toMs: position }
      }
      if (position >= model.playing.endMs) {
        model.playing = null
        notify({ reason: 'range-end' })
        return { action: 'pause', toMs: model.range.endMs }
      }
      if (position < model.playing.startMs) {
        // Seeking landed before the range (a codec keyframe boundary): ask for a re-seek rather
        // than playing the head the user trimmed away.
        return { action: 'seek', toMs: model.playing.startMs }
      }
      return { action: 'none', toMs: position }
    }

    // ---------- project draft (editor mode) ----------

    // The edit object the project service persists (contract §7): a full-range selection is
    // stored as an empty keepRanges array ("whole recording"), an edited one as the single
    // half-open range. `gif` uses the schema's `edge` name, not the export request's
    // `maxEdgePx`, because that is what `updateDraft` writes into project.json.
    function buildDraftEdit() {
      const keepRanges = model.edited && model.metadata.durationMs > 0
        ? [{ id: 'keep-1', startMs: model.range.startMs, endMs: model.range.endMs }]
        : []
      return {
        revision: model.revision,
        keepRanges,
        format: model.format,
        gif: { edge: model.gif.maxEdgePx, fps: model.gif.fps }
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
      const checked = normalizeRange(model.range, model.metadata.durationMs)
      if (checked.ok) {
        model.range = { startMs: checked.value.startMs, endMs: checked.value.endMs }
      } else {
        model.range = { startMs: 0, endMs: model.metadata.durationMs }
        model.edited = false
      }
    }

    // Load the persisted edit into the live state. Called for the first `record-editor:init`
    // and again after a revision conflict / recovery retry, so it must be idempotent and must
    // not leave stale dirty/conflict flags behind.
    function applyEdit(edit) {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return false
      const projectRevision = Math.round(finiteNumber(edit.revision))
      if (projectRevision !== null && projectRevision >= 0) model.revision = projectRevision

      const keepRanges = Array.isArray(edit.keepRanges) ? edit.keepRanges : []
      let range = { startMs: 0, endMs: model.metadata.durationMs }
      if (keepRanges.length > 0) {
        const first = keepRanges[0] || {}
        const candidate = {
          startMs: Math.round(finiteNumber(first.startMs) || 0),
          endMs: Math.round(finiteNumber(first.endMs) || 0)
        }
        const checked = normalizeRange(candidate, model.metadata.durationMs)
        if (checked.ok) range = { startMs: checked.value.startMs, endMs: checked.value.endMs }
        else log('draft: ignoring an invalid keep range from the project:', checked.code)
        // Contract §0: multi-range editing is out of this round; the first range is the
        // closest meaningful projection rather than a crash on a future project shape.
        if (keepRanges.length > 1) log('draft: multi-range edit is not supported yet; using the first range')
      }

      if (edit.format === 'gif' || edit.format === 'mp4') model.format = edit.format
      const gif = edit.gif && typeof edit.gif === 'object' ? edit.gif : {}
      const edge = Math.round(finiteNumber(gif.edge ?? gif.maxEdgePx) ?? LIMITS.GIF_MAX_EDGE_PX)
      if (edge >= LIMITS.GIF_MIN_EDGE_PX && edge <= LIMITS.GIF_MAX_EDGE_PX) model.gif.maxEdgePx = edge
      const fps = Math.round(finiteNumber(gif.fps) ?? 0)
      if (GIF_FRAME_RATES.includes(fps)) model.gif.fps = fps

      model.range = range
      model.edited = keepRanges.length > 0
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
    }    // ---------- submit ----------

    function buildRequest() {
      const request = {
        format: model.format,
        range: { startMs: model.range.startMs, endMs: model.range.endMs }
      }
      // `maxEdgePx` is the CAP the user picked; the service recomputes the exact even output
      // size from the source dimensions, so the request never carries a derived width/height.
      if (model.format === 'gif') {
        request.gif = { maxEdgePx: model.gif.maxEdgePx, fps: model.gif.fps, loop: true }
      }
      return request
    }

    // One submission attempt. The caller supplies the transport (`submit(request)`) so this
    // module stays Electron-free. Returns the `{ status, task }` the main process answered.
    async function startExport({ submit } = {}) {
      if (typeof submit !== 'function') throw new TypeError('Trim controller requires a submit transport')
      if (!canExport()) {
        const reason = !model.available
          ? 'probe-failed'
          : !model.metadata.durationMs
            ? 'duration-unavailable'
            : (model.format === 'gif' ? (gifBudget().code || 'invalid-range') : 'invalid-range')
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
        range: { ...model.range },
        format: model.format,
        gif: model.format === 'gif' ? { ...model.gif } : null
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
      formatClock,
      parseTimeInput,
      errorKey,
      // project / availability (editor mode)
      applyProject,
      buildDraftEdit,
      draftState,
      saveDraft,
      setAvailable,
      // trim
      setStart,
      setEnd,
      resetRange,
      // format
      setFormat,
      setGifFps,
      setGifMaxEdge,
      // playback
      playRange,
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
    GIF_FRAME_RATES,
    LOCALE_KEYS,
    LIMITS,
    TERMINAL_STATES,
    createRecordTrimController,
    errorKey,
    formatClock,
    parseTimeInput
  }
})
