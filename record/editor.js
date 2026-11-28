'use strict'

// Independent recording editor window (R1-R3 plan §4.3, contract §9.3/§11).
//
// record/editor.html loads this file as a classic script. It owns the DOM and the window
// lifecycle; record/trim-controller.js owns the edit/export state and
// record/editor-timeline.js owns the track math, so this file stays a view + bridge layer.
//
// Testability: the module is also CommonJS-requirable. The browser boot calls
// `recordingEditor.boot()` automatically; node tests call `createEditorView({ api, document })`
// over a fake DOM and drive the same code path the window runs. That is deliberate - the old
// preview tests caught real interaction bugs (the export button doubling as an unusable cancel
// control) only because they exercised the view instead of grepping it.
//
// Degradation: when the preload bridge is missing (or a method was not shipped yet), the window
// still renders its layout and shows a translated error; it never throws the user out of the app.
// Every IPC call is guarded to match the frozen contract:
//   record-editor:init push, ready, save-draft (CAS), export, export-status, cancel-export,
//   rename, rerecord, reveal, back, close, window actions, reload (recovery/conflict),
//   export:perform-action (feature-A receipt) and the record:export-progress push.

;(function initRecordingEditor(globalRoot, factory) {
  const api = factory(globalRoot)
  if (typeof module === 'object' && module.exports) module.exports = api
  else globalRoot.recordingEditor = api
})(typeof globalThis === 'object' ? globalThis : this, (root) => {
  const controllerModule = typeof module === 'object' && module.exports
    ? require('./trim-controller')
    : root.recordTrimController
  const timelineModule = typeof module === 'object' && module.exports
    ? require('./editor-timeline')
    : root.recordEditorTimeline
  const options = typeof module === 'object' && module.exports
    ? require('../shared/recording-export-options')
    : root.recordingExportOptions
  const { GIF_FRAME_RATES, errorKey } = controllerModule

  // Every DOM id the view touches. The list is exported so tests build a fake document from
  // exactly the same surface the real markup provides, and the probe/E2E ids stay honest.
  const ELEMENT_IDS = Object.freeze([
    'editor-root',
    'window-minimize', 'window-close',
    'source-name', 'source-name-input', 'save-state',
    'reveal-source', 'rerecord', 'back-to-records', 'export-button',
    'export-progress',
    'video-stage',
    'preview-video',
    'demo-preview-frame',
    'recovery-banner', 'recovery-message', 'recovery-retry', 'recovery-reveal',
    // D03 (17): salvage the decodable part of a damaged source from the recovery banner.
    'recovery-salvage', 'recovery-salvage-cancel', 'recovery-notice',
    'draft-conflict', 'draft-conflict-message', 'draft-reload',
    'timeline', 'timeline-track', 'timeline-selection', 'timeline-segments', 'timeline-playhead',
    'handle-start', 'handle-end',
    'timeline-duration', 'range-selection', 'empty-selection-hint',
    'range-start-input', 'range-end-input', 'play-range',
    // B08: pin the current frame straight from the timeline.
    'pin-frame', 'pin-frame-status',
    'split-at-playhead', 'delete-segment', 'reset-edits', 'undo-edit', 'redo-edit',
    'export-format', 'gif-edge', 'gif-fps', 'gif-budget',
    'export-resolution', 'export-quality', 'export-fps', 'export-output-size',
    // DEV-05: burn the recorded shortcut capsules into the exported film.
    'export-keystrokes',
    // P2-05: discloses the exact capsule truncation an export material cap causes.
    'keystroke-truncation',
    'demo-canvas', 'ripple-layer',
    'demo-enabled', 'demo-background', 'demo-background-custom',
    'demo-padding', 'demo-padding-value', 'demo-radius', 'demo-radius-value',
    'demo-shadow', 'demo-ripples', 'demo-reset', 'events-status',
    'zoom-add', 'zoom-list', 'zoom-suggestions',
    // N03: shortcut capsule HUD + one-click dead-air removal.
    'toggle-keystrokes', 'keystroke-capsule', 'cut-silence', 'pause-cut-status',
    'result-bar', 'result-name', 'result-kind', 'result-open', 'result-address', 'result-reveal',
    'result-status', 'result-dismiss',
    'cancel-export', 'error-text'
  ])

  // Reasons emitted by the trim controller that represent a committed USER EDIT and therefore
  // need an autosave. Drag moves are transient until commitEdit() emits 'edit-committed';
  // playback, export progress and project reloads must not write a draft.
  const EDIT_REASONS = new Set([
    'start', 'end', 'reset', 'format', 'gif-fps', 'gif-size',
    'split', 'delete-segment', 'reset-edits', 'boundary', 'junction',
    'edit-committed', 'undo', 'redo',
    'demo-style', 'demo-zoom', 'demo-reset', 'demo-suggestion',
    // N03: the dead-air suggestion is an ordinary segment edit and must autosave.
    'pause-cuts'
  ])
  // Autosave debounce. Contract §11: <= 500 ms.
  const SAVE_DEBOUNCE_MS = 400
  // Status polling covers a dropped `record:export-progress` push (contract §9.3 allows a
  // query by taskId/requestId). ~1 s is cheap for one running encode.
  const EXPORT_POLL_MS = 900
  // Range playback sampling, same cadence the preview view used.
  const RANGE_PLAY_POLL_MS = 80
  // N03: a capsule stays on screen for at least this long after its keystroke (the fade is a CSS
  // transition) so a fast combo is still readable at normal playback speed.
  const KEYSTROKE_CAPSULE_MS = 1100
  // If the main process never sends `record-editor:init`, say so instead of rendering a
  // permanently blank project. Long enough for a slow first paint, short enough to notice.
  const INIT_TIMEOUT_MS = 5000
  const RECOVERY_KEYS = Object.freeze({
    'probe-failed': 'recording.editor.recovery.probe-failed',
    interrupted: 'recording.editor.recovery.interrupted',
    'duration-unavailable': 'recording.editor.recovery.duration-unavailable'
  })
  // D03 (17): the salvage service's failure reasons, grouped into the four answers the user
  // can act on. Anything unmapped still reports a failure, never a silent no-op.
  const SALVAGE_NO_PLAYABLE = new Set([
    'source-empty', 'copy-empty', 'output-empty', 'duration-unavailable',
    'probe-failed', 'output-too-large', 'duration-exceeds-limit'
  ])
  const SALVAGE_STATUS_KEYS = Object.freeze({
    running: 'recording.editor.recovery.salvage-running',
    cancelling: 'recording.editor.recovery.salvage-cancelling',
    done: 'recording.editor.recovery.salvage-done',
    reused: 'recording.editor.recovery.salvage-reused',
    cancelled: 'recording.editor.recovery.salvage-cancelled',
    'cancel-failed': 'recording.editor.recovery.salvage-cancel-failed',
    'disk-full': 'recording.editor.recovery.salvage-disk-full',
    'no-playable': 'recording.editor.recovery.salvage-no-playable',
    unavailable: 'recording.editor.recovery.salvage-unavailable',
    failed: 'recording.editor.recovery.salvage-failed'
  })
  // B08: the "pin current frame" probe. The bitmap is the PREVIEW's source pixels, so a
  // 4K recording pins a 4K image and no window chrome can leak into it. The byte ceiling
  // mirrors the main-process re-check; the wait covers a seek plus one presented frame.
  const PIN_FRAME_MAX_BYTES = 32 * 1024 * 1024
  const PIN_FRAME_SEEK_TIMEOUT_MS = 1500
  const PIN_FRAME_FRAME_WAIT_MS = 900
  const PIN_FRAME_DEFAULT_RATE = 30

  function defaultTranslate(key, params) {
    const translator = typeof root.t === 'function' ? root.t : null
    if (!translator) return key
    try {
      return translator(key, params)
    } catch {
      return key
    }
  }

  function finite(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function elementOf(documentRef, id) {
    if (!documentRef || typeof documentRef.getElementById !== 'function') return null
    return documentRef.getElementById(id) || null
  }

  function normalizeEditorMetadata(next) {
    const video = next && typeof next.video === 'object' ? next.video : {}
    const audio = next && typeof next.audio === 'object' ? next.audio : {}
    return {
      durationMs: Math.max(0, Math.round(finite(next?.durationMs) || 0)),
      video: {
        width: Math.max(0, Math.round(finite(video.width) || 0)),
        height: Math.max(0, Math.round(finite(video.height) || 0)),
        frameRate: finite(video.frameRate) || 0
      },
      // `record-editor:init.metadata` carries `{ tracks }`; the export options normaliser
      // (and therefore the trim controller) wants `{ exists }`.
      audio: { exists: audio.exists === true || Math.round(finite(audio.tracks) || 0) > 0 }
    }
  }

  // The export service shapes status as `{ ok, task }`; a push is the task itself. Accept both
  // so a lost push and a poll answer land in the same `applyTask`.
  function taskFromAnswer(answer) {
    if (!answer || typeof answer !== 'object') return null
    if (answer.task && typeof answer.task === 'object') return answer.task
    if (typeof answer.taskId === 'string' && typeof answer.state === 'string') return answer
    return null
  }

  // ---------- B08: frame pin maths (pure, window-free) ----------
  //
  // The preview plays SOURCE time; the edit only decides which source times survive. A pin
  // must therefore answer two questions with the same numbers the timeline shows:
  //   1. which source time is "the current frame" (kept content, or the nearest kept frame
  //      when the playhead sits in a deleted gap / past the last kept edge);
  //   2. whether the frame Chromium actually presented is the one that was requested, on a
  //      variable-frame-rate source where mediaTime does not advance on a fixed grid.

  // One frame's duration. An unknown rate (0, e.g. after a restart the manifest does not
  // record it) falls back to 30 fps: every tolerance below is then a conservative bound.
  function frameDurationMs(frameRate) {
    const rate = finite(frameRate)
    return rate && rate > 0 ? 1000 / rate : 1000 / PIN_FRAME_DEFAULT_RATE
  }

  // |presented - requested| expressed in frames. Infinity for unusable input so a caller
  // can never turn a missing mediaTime into an accidental match.
  function frameDeviation(presentedMs, requestedMs, frameRate) {
    // null/undefined means "no presented frame was reported"; that is never a match, so it
    // must not be coerced to 0 ms by the numeric helper.
    if (presentedMs === null || presentedMs === undefined) return Infinity
    const presented = finite(presentedMs)
    const requested = finite(requestedMs)
    if (presented === null || requested === null) return Infinity
    return Math.abs(presented - requested) / frameDurationMs(frameRate)
  }

  // Acceptance rule for the ticket: the pinned frame may be at most ONE frame away from the
  // frame the user was looking at.
  function withinOneFrame(presentedMs, requestedMs, frameRate) {
    return frameDeviation(presentedMs, requestedMs, frameRate) <= 1 + 1e-6
  }

  // VFR: frames are not evenly spaced, so "the frame at t" is the nearest presentation time
  // actually observed. `candidates` are rVFC mediaTimes (ms); null when none is usable.
  function nearestFrameTime(requestedMs, candidates) {
    const target = finite(requestedMs)
    if (target === null || !Array.isArray(candidates) || candidates.length === 0) return null
    let best = null
    let bestDistance = Infinity
    for (const value of candidates) {
      if (value === null || value === undefined) continue
      const candidate = finite(value)
      if (candidate === null || candidate < 0) continue
      const distance = Math.abs(candidate - target)
      if (distance < bestDistance) {
        bestDistance = distance
        best = candidate
      }
    }
    return best
  }

  // After a seek the presented frame is usually the one that contains the requested time,
  // but on a VFR source the seek can land a frame (or more) early. Accept anything inside one
  // frame; otherwise ask for one more seek half a frame PAST the request, which lands inside
  // the target frame's presentation interval instead of on its leading edge.
  function frameSeekTarget(requestedMs, presentedMs, frameRate) {
    const requested = finite(requestedMs)
    if (requested === null) return { accept: false, seekMs: null, deviation: Infinity }
    if (presentedMs === null || presentedMs === undefined) {
      // No mediaTime was reported: accept the frame we have instead of seeking blindly.
      return { accept: true, seekMs: null, deviation: Infinity }
    }
    const presented = finite(presentedMs)
    if (presented === null) return { accept: true, seekMs: null, deviation: Infinity }
    const deviation = frameDeviation(presented, requested, frameRate)
    if (deviation <= 1 + 1e-6) return { accept: true, seekMs: null, deviation }
    const nudge = frameDurationMs(frameRate) / 2
    return {
      accept: false,
      seekMs: Math.max(0, Math.round(requested + (presented < requested ? nudge : -nudge))),
      deviation
    }
  }

  // Which source millisecond the pin must capture. Kept content is used verbatim; a playhead
  // inside a removed gap settles on the NEXT kept start (the frame kept playback would show
  // next), and a playhead at/after the last kept end settles one frame inside the last kept
  // segment so a removed tail can never be pinned. `segments: []` is the whole recording.
  function locatePinFrame({ currentMs, segments, durationMs, frameRate } = {}) {
    const duration = Math.max(0, Math.round(finite(durationMs) || 0))
    if (!(duration > 0)) return { ok: false, code: 'duration-unavailable' }
    const kept = timelineModule.materializeSegments(segments, duration)
    if (kept.length === 0) return { ok: false, code: 'empty-selection' }
    const frameMs = frameDurationMs(frameRate)
    const position = Math.max(0, Math.min(duration, Math.round(finite(currentMs) || 0)))
    for (let index = 0; index < kept.length; index += 1) {
      const segment = kept[index]
      if (position >= segment.startMs && position < segment.endMs) {
        return { ok: true, sourceMs: position, adjusted: false, segmentIndex: index, code: '' }
      }
    }
    const next = kept.find((segment) => segment.startMs > position)
    if (next) {
      return { ok: true, sourceMs: next.startMs, adjusted: true, segmentIndex: kept.indexOf(next), code: 'snapped-to-next-kept' }
    }
    const last = kept[kept.length - 1]
    return {
      ok: true,
      sourceMs: Math.max(last.startMs, Math.round(last.endMs - frameMs)),
      adjusted: true,
      segmentIndex: kept.length - 1,
      code: 'clamped-to-last-kept-frame'
    }
  }

  // The canvas is sized from the decoded frame's INTRINSIC size so the pinned bitmap is the
  // source pixels: preview scaling, the demo frame and every editor control stay out of it.
  // Metadata is only a fallback for the moment before the element reports its size.
  function frameCanvasSize(videoWidth, videoHeight, metadata = null) {
    const intrinsicWidth = Math.round(finite(videoWidth) || 0)
    const intrinsicHeight = Math.round(finite(videoHeight) || 0)
    const probed = metadata && metadata.video ? metadata.video : {}
    const width = intrinsicWidth > 0 ? intrinsicWidth : Math.max(0, Math.round(finite(probed.width) || 0))
    const height = intrinsicHeight > 0 ? intrinsicHeight : Math.max(0, Math.round(finite(probed.height) || 0))
    if (!(width > 0) || !(height > 0)) return { ok: false, code: 'no-frame', width: 0, height: 0 }
    return { ok: true, width, height, intrinsic: intrinsicWidth > 0 && intrinsicHeight > 0 }
  }

  // Data-only pin metadata. The main process derives the pixel size again from the PNG, so a
  // hostile renderer cannot claim a size it did not encode; the renderer's claim is only used
  // for display and for the pin window's scale.
  function buildPinFrameMeta({ projectId = '', frameMs = 0, width = 0, height = 0, scaleFactor = 1, nowMs = 0 } = {}) {
    const scale = finite(scaleFactor)
    return {
      source: 'record-frame',
      projectId: typeof projectId === 'string' ? projectId : '',
      frameMs: Math.max(0, Math.round(finite(frameMs) || 0)),
      width: Math.max(0, Math.round(finite(width) || 0)),
      height: Math.max(0, Math.round(finite(height) || 0)),
      scaleFactor: scale && scale > 0 ? scale : 1,
      capturedAt: Math.max(0, Math.round(finite(nowMs) || 0))
    }
  }

  // Main-process answer (or a renderer-side failure) -> the timeline's status copy. An unknown
  // code must never leak as raw text, and every branch has a key in all three languages.
  function pinFrameStatusKey(code, ok = false) {
    if (ok === true) return { key: 'record.pin-frame.succeeded', state: '' }
    switch (code) {
      case 'pin-limit': return { key: 'record.pin-frame.limit', state: 'unsaved' }
      case 'pin-unavailable':
      case 'unavailable': return { key: 'record.pin-frame.unavailable', state: 'conflict' }
      case 'empty-selection': return { key: 'record.pin-frame.empty', state: 'conflict' }
      case 'cancelled': return { key: 'record.pin-frame.cancelled', state: '' }
      case 'duration-unavailable':
      case 'no-frame':
      case 'frame-encode-failed':
      case 'canvas-unavailable': return { key: 'record.pin-frame.no-frame', state: 'conflict' }
      default: return { key: 'record.pin-frame.failed', state: 'conflict' }
    }
  }

  function createEditorView({
    api = null,
    document: documentRef = root.document,
    window: windowRef = root,
    translate = defaultTranslate,
    now = () => Date.now(),
    translateDocument = null,
    log = () => {}
  } = {}) {
    const elements = Object.create(null)
    const listeners = []
    const timers = {
      setTimeout: (handler, delay) => root.setTimeout(handler, delay),
      clearTimeout: (id) => root.clearTimeout(id),
      setInterval: (handler, delay) => root.setInterval(handler, delay),
      clearInterval: (id) => root.clearInterval(id)
    }

    let booted = false
    let controller = null
    let project = null
    let metadata = null
    let recovery = { state: 'ready', errorCode: '' }
    let sourceUrl = ''
    let fatalCode = ''
    let dragging = null
    let scrubDragging = false
    let dragListeners = null
    let saveTimer = 0
    let savePromise = null
    let initTimer = 0
    let playTimer = 0
    let pollTimer = 0
    let pollAttempts = 0
    let resultReceipt = null
    let renameOpen = false
    let languageUnsubscribe = null
    let destroyed = false
    // The last manually requested error message (draft save failure, rename failure, reload
    // unavailable). Render recomputes `error-text` from fatal > export error > this, so a
    // transient controller state cannot silently wipe a message the user still needs.
    let manualErrorKey = ''
    // R5: event-track load generation (a reload wins over an older in-flight load), focus
    // picking target, and the last OUTPUT time ripples were evaluated for.
    let eventsLoadId = 0
    let pickingZoomIndex = null
    let lastPlaybackOutputMs = null
    // B08: one frame grab at a time. `pinGeneration` invalidates an in-flight grab when the
    // view is torn down (or a later grab starts), so a closed window can never invoke IPC
    // with a bitmap the user already dismissed.
    let pinBusy = false
    let pinGeneration = 0
    let pinStatus = { key: '', state: '', params: null }
    // D03 (17): one salvage run per page. `salvageRequestId` invalidates a receipt that
    // arrives after the user switched projects, cancelled, or started a newer run, so a
    // stale answer can never swap the preview or clear a live status line.
    let salvageRunning = false
    let salvageRequestId = 0
    let salvageStatus = { key: '', params: null }
    // N03: the capsule HUD is session-only UI state (no draft field), and the dead-air status line
    // is rebuilt from the controller's answer instead of being stored anywhere.
    let keystrokesEnabled = false
    let pauseCutStatus = { key: '', params: null }

    function body() {
      return documentRef && documentRef.body ? documentRef.body : null
    }

    function element(id) {
      return elements[id] || null
    }

    function on(target, type, handler) {
      if (!target || typeof target.addEventListener !== 'function') return
      target.addEventListener(type, handler)
      listeners.push({ target, type, handler })
    }

    function state() {
      return controller ? controller.state() : null
    }

    // Apply the shared i18n runtime to the STATIC markup (data-i18n attributes). Dynamic
    // labels are resolved by `render()` through `t()`, but the header/panel fallbacks in
    // editor.html are English text and stay English unless this pipeline runs. record.js does
    // the same at boot; skipping it shipped an editor whose static and dynamic copy were in
    // different languages on first paint. Also used on a language broadcast so a flip updates
    // both halves at once. `restore` is boot-only: on a broadcast the language has already
    // been chosen by the sender, so re-reading storage would fight it.
    function applyDocumentTranslations({ restore = false } = {}) {
      if (typeof translateDocument === 'function') {
        try {
          translateDocument(documentRef)
        } catch (error) {
          log('editor: injected translation hook failed:', error?.message || error)
        }
        return
      }
      try {
        if (restore && typeof root.restoreStoredLanguage === 'function') root.restoreStoredLanguage()
        if (typeof root.applyTranslations === 'function') root.applyTranslations(documentRef)
      } catch (error) {
        log('editor: translations failed:', error?.message || error)
      }
    }

    function isRecoveryBlocked() {
      if (!metadata) return false
      if (metadata.durationMs <= 0) return true
      return !!(recovery && recovery.state !== 'ready')
    }

    function recoveryKey() {
      const code = typeof recovery?.errorCode === 'string' ? recovery.errorCode : ''
      if (RECOVERY_KEYS[code]) return RECOVERY_KEYS[code]
      // A ready-but-unreadable project has no code of its own; name the real reason (no
      // trustworthy duration) instead of a vague "failed".
      if (metadata && metadata.durationMs <= 0) return 'recording.editor.recovery.duration-unavailable'
      return 'recording.editor.recovery.failed'
    }

    // ---------- boot / init ----------

    function boot() {
      if (booted || destroyed) return false
      if (!documentRef) return false
      booted = true
      for (const id of ELEMENT_IDS) {
        const found = elementOf(documentRef, id)
        if (found) elements[id] = found
      }
      // Translate the static markup BEFORE the first render and before the main process is
      // told the window is ready, so the user's first frame is not a mixed-language flash.
      applyDocumentTranslations({ restore: true })
      bindDom()
      bindBridge()
      render()
      if (!api) {
        fatalCode = 'recording.editor.error.bridge-missing'
        render()
        return false
      }
      // Contract §9.3: main pushes record-editor:init after record-editor:ready.
      initTimer = timers.setTimeout(() => {
        if (!project && !destroyed) {
          fatalCode = 'recording.editor.error.project-missing'
          render()
        }
      }, INIT_TIMEOUT_MS)
      try {
        if (typeof api.ready === 'function') api.ready()
      } catch (error) {
        log('editor: ready failed:', error?.message || error)
      }
      return true
    }

    function bindBridge() {
      if (!api) return
      if (typeof api.onInit === 'function') {
        try { api.onInit((data) => applyInit(data)) } catch (error) { log('editor: onInit failed:', error?.message || error) }
      }
      if (typeof api.onExportProgress === 'function') {
        try { api.onExportProgress((task) => handleTask(task)) } catch (error) { log('editor: onExportProgress failed:', error?.message || error) }
      }
      if (typeof api.onInterfaceLanguage === 'function') {
        try {
          const unsubscribe = api.onInterfaceLanguage((language) => {
            if (typeof language !== 'string' || !language) return
            if (typeof root.setLanguage === 'function') root.setLanguage(language)
            // Re-translate the static markup and then re-render the dynamic labels, so both
            // halves switch together.
            applyDocumentTranslations()
            render()
          })
          languageUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null
        } catch (error) {
          log('editor: onInterfaceLanguage failed:', error?.message || error)
        }
      }
    }

    // One entry point for the first init AND for a later reload (recovery retry, revision
    // conflict). The payload shape is exactly contract §9.3 / the approved reload extension.
    function applyInit(data) {
      if (destroyed || !data || typeof data !== 'object') return false
      if (initTimer) {
        timers.clearTimeout(initTimer)
        initTimer = 0
      }
      const nextProject = data.project && typeof data.project === 'object' ? data.project : null
      if (!nextProject || typeof nextProject.id !== 'string' || !nextProject.id) {
        fatalCode = 'recording.editor.error.project-missing'
        render()
        return false
      }
      const first = !project || project.id !== nextProject.id
      project = nextProject
      if (first) {
        // N03: a different project starts with the HUD hidden and no stale dead-air message.
        keystrokesEnabled = false
        pauseCutStatus = { key: '', params: null }
      }
      metadata = normalizeEditorMetadata(data.metadata || nextProject.media)
      recovery = data.recovery && typeof data.recovery === 'object'
        ? { state: data.recovery.state === 'recoverable' ? 'recoverable' : 'ready', errorCode: typeof data.recovery.errorCode === 'string' ? data.recovery.errorCode : '' }
        : { state: 'ready', errorCode: '' }
      if (typeof data.sourceUrl === 'string' && data.sourceUrl) sourceUrl = data.sourceUrl
      fatalCode = ''
      renameOpen = false
      hideDraftConflict()
      clearError()
      // D03 (17): a new project (or a new source for the same one) ends any salvage status
      // and invalidates a receipt that is still in flight from the previous page state.
      salvageRequestId += 1
      salvageRunning = false
      salvageStatus = { key: '', params: null }
      // B08: a reload swaps the source under the preview, so an in-flight grab from the old
      // project must not land as if it belonged to the new one, and a stale status must go.
      pinGeneration += 1
      pinBusy = false
      setPinStatus('')

      const ready = !isRecoveryBlocked()
      const revision = Math.max(0, Math.floor(finite(nextProject.edit?.revision) || 0))
      if (first) {
        controller = controllerModule.createRecordTrimController({
          projectId: project.id,
          project: nextProject,
          metadata,
          revision,
          available: ready,
          translate,
          render: { onChange: handleChange },
          now,
          log
        })
      } else if (controller) {
        controller.applyProject(nextProject, { metadata, available: ready })
      }
      if (controller && !ready) controller.setAvailable(false)

      const video = element('preview-video')
      if (video && sourceUrl && video.src !== sourceUrl) {
        video.src = sourceUrl
        if (typeof video.load === 'function') video.load()
      }
      if (elements['source-name']) elements['source-name'].textContent = project.name || ''
      dragging = null
      scrubDragging = false
      removeDragListeners()
      if (isRecoveryBlocked()) setSaveState('unavailable')
      pickingZoomIndex = null
      resetRippleClock()
      render()
      loadEvents()
      return true
    }

    // ---------- autosave ----------

    function handleChange(_snapshot, patch) {
      if (EDIT_REASONS.has(patch && patch.reason)) scheduleSave()
      render()
    }

    function setSaveState(kind) {
      const elementRef = element('save-state')
      if (!elementRef) return
      const keys = {
        saved: 'recording.editor.save.saved',
        saving: 'recording.editor.save.saving',
        unsaved: 'recording.editor.save.unsaved',
        conflict: 'recording.editor.save.conflict',
        unavailable: 'recording.editor.save.unavailable'
      }
      elementRef.textContent = keys[kind] ? translate(keys[kind]) : ''
      if (elementRef.dataset) elementRef.dataset.state = kind
    }

    function currentSaveKind() {
      if (fatalCode || isRecoveryBlocked() || !controller) return 'unavailable'
      const draft = controller.state().draft
      if (draft.conflict) return 'conflict'
      if (draft.saving) return 'saving'
      if (draft.dirty) return 'unsaved'
      return 'saved'
    }

    function scheduleSave() {
      if (!controller || !project || typeof api?.saveDraft !== 'function') return false
      if (saveTimer) timers.clearTimeout(saveTimer)
      saveTimer = timers.setTimeout(() => {
        saveTimer = 0
        saveNow()
      }, SAVE_DEBOUNCE_MS)
      return true
    }

    function clearSaveTimer() {
      if (saveTimer) {
        timers.clearTimeout(saveTimer)
        saveTimer = 0
      }
    }

    function saveNow() {
      if (!controller || !project || typeof api?.saveDraft !== 'function') return Promise.resolve({ ok: false, code: 'draft-unavailable' })
      if (savePromise) return savePromise
      const running = controller.saveDraft({
        save: ({ projectId, expectedRevision, edit }) => api.saveDraft(projectId, expectedRevision, edit)
      })
      savePromise = running
        .then((answer) => {
          if (answer && answer.ok === false && answer.code === 'revision-conflict') {
            return handleRevisionConflict(answer)
          }
          if (answer && answer.ok === false && answer.code !== 'revision-conflict') {
            showError('recording.editor.error.save-failed')
          }
          if (answer && answer.ok === true) {
            // A successful save (including the one after a reloaded conflict) clears the
            // draft messages; export errors are re-derived from the controller on render.
            hideDraftConflict()
            if (manualErrorKey === 'recording.editor.error.save-failed'
              || manualErrorKey === 'recording.editor.error.draft-conflict'
              || manualErrorKey === 'recording.editor.error.reload-unavailable') {
              clearError()
            }
          }
          render()
          return answer
        })
        .catch((error) => {
          log('editor: saveDraft failed:', error?.message || error)
          showError('recording.editor.error.save-failed')
          render()
          return { ok: false, code: 'save-failed' }
        })
        .finally(() => {
          savePromise = null
          if (controller && controller.state().draft.dirty && !isRecoveryBlocked()) scheduleSave()
        })
      return savePromise
    }

    async function flushDraft() {
      clearSaveTimer()
      if (!controller) return { ok: false }
      if (savePromise) await savePromise
      if (controller.state().draft.dirty) return saveNow()
      return { ok: true, skipped: true }
    }

    // ---------- revision conflict / recovery reload ----------

    function showDraftConflict() {
      if (elements['draft-conflict']) elements['draft-conflict'].hidden = false
      showError('recording.editor.error.draft-conflict')
    }

    function hideDraftConflict() {
      if (elements['draft-conflict']) elements['draft-conflict'].hidden = true
    }

    async function reloadProject({ fallbackProject = null, keepConflictNotice = false } = {}) {
      if (!project) return false
      let payload = null
      if (typeof api?.reload === 'function') {
        try {
          payload = await api.reload(project.id)
        } catch (error) {
          log('editor: reload failed:', error?.message || error)
          payload = null
        }
      }
      if (payload && payload.ok !== false && payload.project) {
        applyInit(payload)
        if (keepConflictNotice) showDraftConflict()
        return true
      }
      if (fallbackProject && typeof fallbackProject === 'object' && fallbackProject.id) {
        applyInit({
          project: fallbackProject,
          sourceUrl,
          metadata,
          recovery
        })
        if (keepConflictNotice) showDraftConflict()
        return true
      }
      showError('recording.editor.error.reload-unavailable')
      render()
      return false
    }

    async function handleRevisionConflict(answer) {
      showError('recording.editor.error.draft-conflict')
      const fallback = answer && answer.project ? answer.project : null
      return reloadProject({ fallbackProject: fallback, keepConflictNotice: true })
    }

    async function retryRecovery() {
      clearError()
      const reloaded = await reloadProject()
      if (!reloaded) showError('recording.editor.error.reload-unavailable')
      render()
      return reloaded
    }

    // ---------- D03 (17): salvage the playable part of a damaged source ----------

    // The salvage service speaks reasons, the window speaks copy. Every reason lands in one
    // of the four answers the user can act on: cancelled, disk full, nothing decodable, or
    // a plain failure that keeps the original untouched.
    function salvageStatusKeyFor(answer) {
      const reason = typeof answer?.reason?.code === 'string' ? answer.reason.code : ''
      const code = typeof answer?.code === 'string' ? answer.code : ''
      const effective = reason || code
      if (effective === 'cancelled' || effective === 'salvage-cancelled') return SALVAGE_STATUS_KEYS.cancelled
      if (effective === 'disk-full') return SALVAGE_STATUS_KEYS['disk-full']
      if (SALVAGE_NO_PLAYABLE.has(effective)) return SALVAGE_STATUS_KEYS['no-playable']
      if (effective === 'salvage-unavailable' || effective === 'project-service-unavailable') return SALVAGE_STATUS_KEYS.unavailable
      return SALVAGE_STATUS_KEYS.failed
    }

    function setSalvageStatus(key, params = null) {
      salvageStatus = { key: key || '', params: params || null }
    }

    // The recovery banner's primary action. It sends ONLY the project id: main checks the
    // window owner, the project state and the one-job-per-project rule, and answers the same
    // payload shape as a reload so the verified asset replaces the preview in place.
    async function salvagePlayable() {
      if (!project || salvageRunning) return false
      if (typeof api?.salvage !== 'function') {
        setSalvageStatus(SALVAGE_STATUS_KEYS.unavailable)
        render()
        return false
      }
      const projectId = project.id
      const requestId = ++salvageRequestId
      salvageRunning = true
      setSalvageStatus(SALVAGE_STATUS_KEYS.running)
      clearError()
      render()
      let answer = null
      try {
        answer = await api.salvage(projectId)
      } catch (error) {
        log('editor: salvage failed:', error?.message || error)
        answer = { ok: false, code: 'salvage-failed' }
      }
      // A receipt from a page that already moved on (another project, another run, a
      // cancel) is dropped: it must not swap the preview or rewrite the status line.
      if (requestId !== salvageRequestId || !project || project.id !== projectId) return false
      salvageRunning = false
      if (answer && answer.ok === true && answer.project) {
        applyInit(answer)
        const seconds = Math.max(0, Math.round((Number(answer.durationMs) || 0) / 1000))
        // Reopening a project that was already salvaged reuses the verified asset.
        if (answer.salvaged === false) setSalvageStatus(SALVAGE_STATUS_KEYS.reused, { seconds })
        else setSalvageStatus(SALVAGE_STATUS_KEYS.done, { seconds })
        render()
        return true
      }
      setSalvageStatus(salvageStatusKeyFor(answer))
      render()
      return false
    }

    // Cancels the running job (FFmpeg kill + temp cleanup happen in main). The pending
    // receipt is invalidated here so the cancel answer is the one the user sees.
    async function cancelSalvage() {
      if (!project || typeof api?.cancelSalvage !== 'function') return false
      const projectId = project.id
      salvageRequestId += 1
      setSalvageStatus(SALVAGE_STATUS_KEYS.cancelling)
      render()
      let answer = null
      try {
        answer = await api.cancelSalvage(projectId)
      } catch (error) {
        log('editor: cancel salvage failed:', error?.message || error)
        answer = null
      }
      if (!project || project.id !== projectId) return false
      salvageRunning = false
      setSalvageStatus(answer && answer.ok === true ? SALVAGE_STATUS_KEYS.cancelled : SALVAGE_STATUS_KEYS['cancel-failed'])
      render()
      return !!(answer && answer.ok === true)
    }

    // ---------- render ----------

    function isBusy() {
      const snapshot = state()
      return !!snapshot && (snapshot.phase === 'submitting' || snapshot.phase === 'active')
    }

    function canEdit() {
      const snapshot = state()
      if (!snapshot || !project) return false
      if (!snapshot.available) return false
      if (!snapshot.durationMs) return false
      if (snapshot.phase === 'submitting' || snapshot.phase === 'active') return false
      return true
    }


    // ---------- R4 timeline + export panel rendering ----------

    function clearContainer(container) {
      if (!container || typeof container.removeChild !== 'function') return
      while (container.firstChild) container.removeChild(container.firstChild)
    }

    function createNode(tagName, className) {
      if (!documentRef || typeof documentRef.createElement !== 'function') return null
      const node = documentRef.createElement(tagName)
      if (!node) return null
      if (className) node.className = className
      return node
    }

    // Percentage geometry for a source-time value on the full-duration track.
    function percentOf(milliseconds, durationMs) {
      return timelineModule.msToPercent(milliseconds, durationMs)
    }

    // Build one boundary grip descriptor -> DOM node. Boundary kinds:
    //   outer-start / outer-end : the static #handle-start / #handle-end elements
    //   junction               : a shared split point between ADJACENT segments; dragging it
    //                            moves both edges so the cut stays a cut
    //   edge                   : one segment edge with a gap on the other side
    function boundaryDescriptorLabel(descriptor) {
      if (descriptor.kind === 'junction') {
        return translate('recording.editor.timeline.junction')
      }
      if (descriptor.kind === 'outer-start' || (descriptor.kind === 'edge' && descriptor.edge === 'start')) {
        return translate('recording.editor.timeline.handle-start')
      }
      return translate('recording.editor.timeline.handle-end')
    }

    function renderTimelineSegments(snapshot, durationMs, editable) {
      const container = element('timeline-segments')
      if (!container) return
      clearContainer(container)
      const segments = snapshot && Array.isArray(snapshot.segments) ? snapshot.segments : []
      const staticStart = element('handle-start')
      const staticEnd = element('handle-end')
      const visible = durationMs > 0 && segments.length > 0
      if (staticStart) {
        staticStart.hidden = !visible
        staticStart.disabled = !editable
      }
      if (staticEnd) {
        staticEnd.hidden = !visible
        staticEnd.disabled = !editable
      }
      if (!visible) return
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]
        const previous = segments[index - 1] || null
        const next = segments[index + 1] || null
        const block = createNode('div', 'timeline-segment')
        if (block) {
          block.dataset.index = String(index)
          block.dataset.testid = 'segment-block'
          block.style.left = percentOf(segment.startMs, durationMs) + '%'
          block.style.width = percentOf(segment.endMs - segment.startMs, durationMs) + '%'
          block.setAttribute('aria-hidden', 'true')
          container.appendChild(block)
        }
        const grips = []
        if (index === 0) {
          if (staticStart) staticStart.style.left = percentOf(segment.startMs, durationMs) + '%'
        } else if (previous && previous.endMs === segment.startMs) {
          grips.push({ kind: 'junction', index })
        } else {
          grips.push({ kind: 'edge', index, edge: 'start' })
        }
        if (index === segments.length - 1) {
          if (staticEnd) staticEnd.style.left = percentOf(segment.endMs, durationMs) + '%'
        } else if (next && next.startMs === segment.endMs) {
          // Adjacent pair: the junction grip is rendered by the right-hand segment.
        } else {
          grips.push({ kind: 'edge', index, edge: 'end' })
        }
        for (const descriptor of grips) {
          const positionMs = descriptor.kind === 'junction'
            ? segments[descriptor.index].startMs
            : (descriptor.edge === 'start'
              ? segments[descriptor.index].startMs
              : segments[descriptor.index].endMs)
          const grip = createNode('button', 'timeline-boundary')
          if (!grip) continue
          grip.type = 'button'
          grip.dataset.kind = descriptor.kind
          if (descriptor.index !== undefined) grip.dataset.index = String(descriptor.index)
          if (descriptor.edge) grip.dataset.edge = descriptor.edge
          grip.dataset.testid = descriptor.kind === 'junction' ? 'segment-junction' : 'segment-edge'
          grip.style.left = percentOf(positionMs, durationMs) + '%'
          grip.setAttribute('aria-label', boundaryDescriptorLabel(descriptor))
          grip.disabled = !editable
          grip.addEventListener('pointerdown', (event) => beginBoundaryDrag(descriptor, event))
          grip.addEventListener('keydown', (event) => nudgeBoundary(descriptor, event))
          container.appendChild(grip)
        }
      }
      // The legacy single-selection backing element stays hidden; kept blocks are authoritative.
      if (element('timeline-selection')) element('timeline-selection').hidden = true
    }

    function setSelectOptions(select, entries, currentValue, disabled) {
      if (!select) return
      clearContainer(select)
      for (const entry of entries) {
        const option = createNode('option')
        if (!option) continue
        option.value = String(entry.value)
        option.textContent = entry.label
        option.disabled = entry.disabled === true
        if (String(entry.value) === String(currentValue)) option.selected = true
        select.appendChild(option)
      }
      select.value = String(currentValue)
      select.disabled = disabled
    }

    // P2-05: an export material cap (the ffmpeg label budget) can still drop capsules. That is
    // disclosed HERE, in the export panel, before the user presses Export: the exact capsule and
    // label counts plus the first/last dropped source time. The preview HUD already follows the
    // kept plan, so this notice explains the difference instead of leaving it silent.
    function renderKeystrokeTruncation(snapshot) {
      const notice = element('keystroke-truncation')
      if (!notice) return
      const keystrokes = snapshot && snapshot.keystrokes ? snapshot.keystrokes : null
      const plan = keystrokes && keystrokes.plan ? keystrokes.plan : null
      const dropped = plan && plan.truncated === true && plan.dropped ? plan.dropped : null
      // P2-05: the notice describes what ENABLING the overlay would drop, so it must stay
      // silent while the user has the switch off (otherwise it reads as if the current
      // export already loses capsules).
      if (!keystrokes || keystrokes.available !== true || keystrokes.exportSelected !== true ||
          !dropped || !(dropped.items > 0)) {
        notice.hidden = true
        notice.textContent = ''
        return
      }
      const clock = timelineModule.formatClock
      notice.textContent = translate('recording.editor.keystrokes.truncated', {
        count: dropped.items,
        labels: dropped.labels,
        maxLabels: plan.maxLabels,
        first: clock(dropped.firstSourceMs),
        last: clock(dropped.lastSourceMs)
      })
      notice.hidden = false
    }

    function renderExportPanel(snapshot, editable) {
      const format = snapshot ? snapshot.format : 'mp4'
      const videoFormat = format !== 'gif'
      const video = snapshot ? snapshot.video : { resolution: 'source', quality: 'standard', fps: 'source' }
      const optionsList = snapshot ? snapshot.videoOptions : { resolutions: ['source'], frameRates: ['source'], qualities: ['standard', 'high', 'ultra'] }
      const resolutionLabels = {
        source: translate('recording.editor.resolution.source'),
        '1080p': translate('recording.editor.resolution.p1080'),
        '720p': translate('recording.editor.resolution.p720'),
        '480p': translate('recording.editor.resolution.p480')
      }
      const qualityLabels = {
        standard: translate('recording.editor.quality.standard'),
        high: translate('recording.editor.quality.high'),
        ultra: translate('recording.editor.quality.ultra')
      }
      const fpsLabels = {
        source: translate('recording.editor.fps.source'),
        '30': '30 FPS',
        '60': '60 FPS'
      }
      setSelectOptions(
        element('export-resolution'),
        optionsList.resolutions.map((value) => ({ value, label: resolutionLabels[value] || value })),
        video.resolution,
        !editable || !videoFormat
      )
      setSelectOptions(
        element('export-quality'),
        optionsList.qualities.map((value) => ({ value, label: qualityLabels[value] || value })),
        video.quality,
        !editable || !videoFormat
      )
      setSelectOptions(
        element('export-fps'),
        optionsList.frameRates.map((value) => ({ value, label: fpsLabels[String(value)] || String(value) })),
        String(video.fps),
        !editable || !videoFormat
      )
      // DEV-05: the capsule overlay is only offered when the take recorded shortcuts; the choice
      // is session-only (controller state) and works for MP4, WebM and GIF alike.
      if (elements['export-keystrokes']) {
        const toggle = element('export-keystrokes')
        const keystrokes = snapshot && snapshot.keystrokes ? snapshot.keystrokes : null
        const available = !!(keystrokes && keystrokes.available)
        toggle.checked = available && keystrokes.exportSelected === true
        toggle.disabled = !editable || !available
      }

      const output = element('export-output-size')
      if (output) {
        let size = ''
        if (snapshot && metadata) {
          const source = metadata.video
          if (format === 'gif' && source.width > 0 && source.height > 0) {
            const dimensions = options.computeGifDimensions({
              width: source.width,
              height: source.height,
              maxEdgePx: snapshot.gif.maxEdgePx
            })
            if (dimensions.ok) size = dimensions.value.width + ' \u00d7 ' + dimensions.value.height
          } else if (snapshot.videoBudget && snapshot.videoBudget.ok && snapshot.videoBudget.value
            && snapshot.videoBudget.value.width > 0 && snapshot.videoBudget.value.height > 0) {
            const budget = snapshot.videoBudget.value
            size = budget.width + ' \u00d7 ' + budget.height
          }
        }
        output.textContent = size
          ? translate('recording.editor.output-value', {
            size,
            duration: timelineModule.formatClock(snapshot.keptMs)
          })
          : ''
      }

      const emptyHint = element('empty-selection-hint')
      if (emptyHint) emptyHint.hidden = !(snapshot && snapshot.emptySelection)
      renderKeystrokeTruncation(snapshot)
    }

    function renderEditControls(snapshot, editable) {
      const playheadMs = mediaMs()
      const hasContent = !!snapshot && snapshot.segments.length > 0
      const canSplit = !!controller && editable && controller.canSplitAt(playheadMs)
      const canDelete = !!controller && editable && controller.canDeleteAt(playheadMs)
      if (element('split-at-playhead')) element('split-at-playhead').disabled = !canSplit
      if (element('delete-segment')) element('delete-segment').disabled = !canDelete
      if (element('undo-edit')) element('undo-edit').disabled = !(snapshot && snapshot.undo) || !editable
      if (element('redo-edit')) element('redo-edit').disabled = !(snapshot && snapshot.redo) || !editable
      if (element('reset-edits')) element('reset-edits').disabled = !(editable && snapshot && snapshot.edited)
      if (element('play-range')) {
        element('play-range').disabled = !hasContent || !(snapshot && snapshot.durationMs > 0) || isBusy()
        element('play-range').textContent = translate(snapshot && snapshot.playing
          ? 'recording.editor.timeline.stop'
          : 'recording.editor.timeline.play-kept')
      }
    }

    // ---------- R5 demo rendering ----------

    function demoLimits() {
      return controller && controller.DEMO_LIMITS ? controller.DEMO_LIMITS : null
    }

    function backgroundPresetEntries(style) {
      const limits = demoLimits()
      const presets = limits ? limits.BACKGROUND_PRESETS : []
      const entries = presets.map((color) => ({
        value: color,
        label: translate(BACKGROUND_LABEL_KEYS[color] || 'recording.editor.background.custom')
      }))
      const current = style && typeof style.background === 'string' ? style.background.toLowerCase() : ''
      if (current && !presets.includes(current)) {
        entries.push({ value: 'custom', label: translate('recording.editor.background.custom') })
      } else {
        entries.push({ value: 'custom', label: translate('recording.editor.background.custom') })
      }
      return entries
    }

    const BACKGROUND_LABEL_KEYS = {
      '#0f1115': 'recording.editor.background.dark',
      '#1e1e1e': 'recording.editor.background.slate',
      '#f5f2ea': 'recording.editor.background.paper',
      '#0a2540': 'recording.editor.background.brand'
    }

    function eventsStatusText(demo) {
      const events = demo && demo.events ? demo.events : null
      if (!events) return ''
      if (events.degraded) return translate('recording.editor.events-status.degraded')
      if (!events.available) return translate('recording.editor.events-status.none')
      const base = translate('recording.editor.events-status.track', {
        clicks: events.clickCount,
        pointer: events.pointerCount
      })
      return events.truncated ? base + ' · ' + translate('recording.editor.events-status.truncated') : base
    }

    function renderPreviewFrame(snapshot) {
      const frame = element('demo-preview-frame')
      const canvas = element('demo-canvas')
      const player = element('preview-video')
      if (!frame || !canvas || !player) return
      const style = snapshot && snapshot.demo ? snapshot.demo.style : null
      const demoCanvas = snapshot && snapshot.demo ? snapshot.demo.canvas : null
      const source = snapshot ? snapshot.metadata.video : (metadata ? metadata.video : { width: 0, height: 0 })
      const enabled = !!(style && style.enabled && demoCanvas && demoCanvas.canvasWidth > 0)
      frame.dataset.demo = enabled ? 'on' : 'off'
      // Fit the output-canvas aspect ratio inside the stage in real pixels. A CSS-only
      // aspect-ratio box cannot satisfy max-width AND max-height at every window size.
      const stage = element('video-stage')
      const stageRect = stage && typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : null
      const canvasWidth = enabled ? demoCanvas.canvasWidth : (source && source.width > 0 ? source.width : 0)
      const canvasHeight = enabled ? demoCanvas.canvasHeight : (source && source.height > 0 ? source.height : 0)
      if (stageRect && stageRect.width > 0 && stageRect.height > 0 && canvasWidth > 0 && canvasHeight > 0) {
        const fit = Math.min(stageRect.width / canvasWidth, stageRect.height / canvasHeight)
        const paddingPx = enabled && demoCanvas ? Math.max(0, Number(demoCanvas.paddingPx) || 0) : 0
        frame.style.width = Math.max(1, Math.floor(canvasWidth * fit)) + 'px'
        frame.style.height = Math.max(1, Math.floor(canvasHeight * fit)) + 'px'
        // The inner content box is the output content area; sizing it explicitly avoids a
        // percentage-height flex ambiguity at very short stage heights (narrow windows).
        const contentBox = element('demo-canvas')
        if (contentBox) {
          contentBox.style.width = Math.max(1, Math.floor((canvasWidth - paddingPx * 2) * fit)) + 'px'
          contentBox.style.height = Math.max(1, Math.floor((canvasHeight - paddingPx * 2) * fit)) + 'px'
        }
      } else {
        frame.style.width = '100%'
        frame.style.height = '100%'
        const contentBox = element('demo-canvas')
        if (contentBox) {
          contentBox.style.width = '100%'
          contentBox.style.height = '100%'
        }
      }
      if (enabled) {
        frame.style.aspectRatio = demoCanvas.canvasWidth + ' / ' + demoCanvas.canvasHeight
        frame.style.background = style.background
        const paddingPercent = demoCanvas.paddingPx > 0 ? (demoCanvas.paddingPx / demoCanvas.canvasWidth) * 100 : 0
        frame.style.padding = paddingPercent.toFixed(3) + '%'
        frame.classList.toggle('demo-shadow', style.shadow === true)
        canvas.style.borderRadius = Math.max(0, Math.round(Number(demoCanvas.radiusPx) || 0)) + 'px'
      } else {
        frame.style.padding = '0'
        frame.style.background = 'transparent'
        frame.style.aspectRatio = source && source.width > 0 && source.height > 0
          ? source.width + ' / ' + source.height
          : ''
        frame.classList.remove('demo-shadow')
        canvas.style.borderRadius = '0px'
      }
      // Zoom is evaluated at the source playhead and mapped to output time by the controller.
      let zoom = { scale: 1, focusX: 0.5, focusY: 0.5 }
      if (controller && snapshot) {
        try {
          zoom = controller.previewZoomAt(mediaMs())
        } catch (error) {
          log('editor: previewZoomAt failed:', error?.message || error)
        }
      }
      const scale = Number(zoom.scale) || 1
      player.style.transformOrigin = ((Number(zoom.focusX) || 0.5) * 100).toFixed(2) + '% ' + ((Number(zoom.focusY) || 0.5) * 100).toFixed(2) + '%'
      player.style.transform = scale > 1.0001 ? 'scale(' + scale.toFixed(4) + ')' : 'none'
    }

    function renderDemoControls(snapshot, editable, blocked) {
      const demo = snapshot && snapshot.demo ? snapshot.demo : null
      const style = demo ? demo.style : null
      const events = demo ? demo.events : { available: false, degraded: '', clickCount: 0, pointerCount: 0, truncated: false }
      const busy = !!snapshot && (snapshot.phase === 'submitting' || snapshot.phase === 'active')
      const gifFormat = snapshot ? snapshot.format === 'gif' : false
      // Contract/p1: the demo engine renders mp4/webm only; GIF ignores demo, so the panel is
      // visibly disabled instead of silently dropping the user's settings.
      const demoEditable = !!(editable && !busy && !blocked && snapshot && !gifFormat)
      const disabled = !demoEditable

      if (elements['events-status']) {
        const status = element('events-status')
        status.textContent = snapshot ? eventsStatusText(demo) : ''
        status.classList.toggle('warning', !!(snapshot && (events.degraded || !events.available)))
      }
      if (elements['demo-enabled']) {
        const toggle = element('demo-enabled')
        toggle.checked = !!(style && style.enabled)
        toggle.disabled = disabled
      }
      if (elements['demo-padding']) {
        const range = element('demo-padding')
        range.value = String(Math.round(((style ? style.padding : 0.08) * 100)))
        range.disabled = disabled
        if (elements['demo-padding-value']) element('demo-padding-value').textContent = range.value + '%'
      }
      if (elements['demo-radius']) {
        const range = element('demo-radius')
        range.value = String(Math.round(style ? style.radius : 12))
        range.disabled = disabled
        if (elements['demo-radius-value']) element('demo-radius-value').textContent = range.value
      }
      if (elements['demo-shadow']) {
        element('demo-shadow').checked = !!(style && style.shadow)
        element('demo-shadow').disabled = disabled
      }
      if (elements['demo-ripples']) {
        const ripples = element('demo-ripples')
        ripples.checked = !!(style && style.ripples)
        ripples.disabled = disabled || !events.available
      }
      if (elements['demo-reset']) element('demo-reset').disabled = disabled
      if (elements['demo-background']) {
        const select = element('demo-background')
        const current = style ? String(style.background || '').toLowerCase() : ''
        const presetMatch = Object.keys(BACKGROUND_LABEL_KEYS).includes(current)
        const entries = backgroundPresetEntries(style)
        setSelectOptions(select, entries, presetMatch ? current : 'custom', disabled)
        if (elements['demo-background-custom']) {
          const custom = element('demo-background-custom')
          custom.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#0f1115'
          custom.hidden = presetMatch
          custom.disabled = disabled
        }
      }
      if (elements['zoom-add']) {
        element('zoom-add').disabled = disabled || !(demo && demo.canAddZoom)
      }
      renderZoomList(demo, disabled)
      renderSuggestions(demo, disabled)
      if (gifFormat && elements['events-status'] && snapshot) {
        element('events-status').textContent = translate('recording.editor.demo-gif-disabled')
        element('events-status').classList.add('warning')
      }
    }

    function renderZoomList(demo, disabled) {
      const container = element('zoom-list')
      if (!container) return
      clearContainer(container)
      const zooms = demo && Array.isArray(demo.zooms) ? demo.zooms : []
      if (zooms.length === 0) {
        const empty = createNode('p', 'zoom-empty')
        if (empty) empty.textContent = translate('recording.editor.zoom-empty')
        if (empty) container.appendChild(empty)
        return
      }
      zooms.forEach((zoom, index) => {
        const row = createNode('div', 'zoom-item' + (pickingZoomIndex === index ? ' picking' : ''))
        if (!row) return
        row.dataset.testid = 'zoom-item'
        row.dataset.index = String(index)
        const head = createNode('div', 'zoom-item-head')
        const time = createNode('span', 'zoom-item-time')
        if (time) {
          time.textContent = translate('recording.editor.zoom-item-time', {
            start: timelineModule.formatClock(zoom.startMs),
            end: timelineModule.formatClock(zoom.endMs),
            scale: Number(zoom.scale).toFixed(2)
          })
        }
        const actions = createNode('div', 'zoom-item-actions')
        const focusButton = createNode('button')
        if (focusButton) {
          focusButton.type = 'button'
          focusButton.dataset.testid = 'zoom-item-focus'
          focusButton.textContent = pickingZoomIndex === index
            ? translate('recording.editor.zoom-focus-picking')
            : translate('recording.editor.zoom-focus')
          focusButton.disabled = disabled
          focusButton.addEventListener('click', () => startPickingZoom(index))
        }
        const deleteButton = createNode('button')
        if (deleteButton) {
          deleteButton.type = 'button'
          deleteButton.dataset.testid = 'zoom-item-delete'
          deleteButton.textContent = translate('recording.editor.zoom-delete')
          deleteButton.disabled = disabled
          deleteButton.addEventListener('click', () => {
            if (controller && controller.deleteZoom(index)) render()
          })
        }
        if (actions) {
          if (focusButton) actions.appendChild(focusButton)
          if (deleteButton) actions.appendChild(deleteButton)
        }
        if (head) {
          if (time) head.appendChild(time)
          if (actions) head.appendChild(actions)
          row.appendChild(head)
        }
        const scaleRow = createNode('div', 'zoom-scale-row')
        const scaleLabel = createNode('span')
        if (scaleLabel) scaleLabel.textContent = translate('recording.editor.zoom-scale')
        const scaleInput = createNode('input', 'demo-range')
        if (scaleInput) {
          scaleInput.type = 'range'
          scaleInput.min = '125'
          scaleInput.max = '300'
          scaleInput.step = '5'
          scaleInput.value = String(Math.round((Number(zoom.scale) || 1.25) * 100))
          scaleInput.dataset.testid = 'zoom-item-scale'
          scaleInput.disabled = disabled
          scaleInput.addEventListener('change', () => {
            if (controller && controller.updateZoomScale(index, Number(scaleInput.value) / 100)) render()
          })
        }
        const scaleValue = createNode('b', 'demo-value')
        if (scaleValue) scaleValue.textContent = (Number(zoom.scale) || 1.25).toFixed(2) + '\u00d7'
        if (scaleRow) {
          if (scaleLabel) scaleRow.appendChild(scaleLabel)
          if (scaleInput) scaleRow.appendChild(scaleInput)
          if (scaleValue) scaleRow.appendChild(scaleValue)
          row.appendChild(scaleRow)
        }
        container.appendChild(row)
      })
    }

    function renderSuggestions(demo, disabled) {
      const container = element('zoom-suggestions')
      if (!container) return
      clearContainer(container)
      const suggestions = demo && Array.isArray(demo.suggestions) ? demo.suggestions : []
      suggestions.forEach((suggestion, index) => {
        const row = createNode('div', 'zoom-suggestion')
        if (!row) return
        row.dataset.testid = 'zoom-suggestion'
        row.dataset.index = String(index)
        const head = createNode('div', 'zoom-suggestion-head')
        const reason = createNode('span', 'zoom-suggestion-reason')
        if (reason) {
          reason.textContent = suggestion.reason === 'clicks'
            ? translate('recording.editor.zoom-suggestion-clicks', { count: 2 })
            : translate('recording.editor.zoom-suggestion-dwell')
          const timeText = timelineModule.formatClock(suggestion.startMs) + ' – ' + timelineModule.formatClock(suggestion.endMs)
          reason.textContent = reason.textContent + ' · ' + timeText
        }
        const actions = createNode('div', 'zoom-suggestion-actions')
        const addButton = createNode('button')
        if (addButton) {
          addButton.type = 'button'
          addButton.dataset.testid = 'zoom-suggestion-add'
          addButton.textContent = translate('recording.editor.zoom-suggestion-add')
          addButton.disabled = disabled
          addButton.addEventListener('click', () => {
            if (controller && controller.addSuggestion(index)) render()
          })
        }
        const ignoreButton = createNode('button')
        if (ignoreButton) {
          ignoreButton.type = 'button'
          ignoreButton.dataset.testid = 'zoom-suggestion-ignore'
          ignoreButton.textContent = translate('recording.editor.zoom-suggestion-ignore')
          ignoreButton.disabled = disabled
          ignoreButton.addEventListener('click', () => {
            if (controller && controller.ignoreSuggestion(index)) render()
          })
        }
        if (actions) {
          if (addButton) actions.appendChild(addButton)
          if (ignoreButton) actions.appendChild(ignoreButton)
        }
        if (head) {
          if (reason) head.appendChild(reason)
          if (actions) head.appendChild(actions)
          row.appendChild(head)
        }
        container.appendChild(row)
      })
    }

    // ---------- R5 event track loading ----------

    async function loadEvents() {
      if (!controller || !project) return { ok: false }
      const generation = ++eventsLoadId
      if (typeof api?.events !== 'function') {
        controller.applyEventTrack(null, { degraded: 'bridge-missing' })
        render()
        return { ok: false, code: 'bridge-missing' }
      }
      let answer
      try {
        answer = await api.events(project.id)
      } catch (error) {
        log('editor: events failed:', error?.message || error)
        answer = { ok: false, code: 'events-unavailable' }
      }
      if (generation !== eventsLoadId || !controller) return { ok: false }
      if (answer && answer.ok === true) {
        controller.applyEventTrack(answer.track || null, { pauseAnalysis: answer.pauseAnalysis || null })
      } else {
        controller.applyEventTrack(null, { degraded: answer?.code || 'events-unavailable' })
      }
      render()
      return answer || { ok: false }
    }

    // ---------- N03: shortcut capsules + one-click dead-air removal ----------

    // P2-05: the HUD follows the exporter's own visible sequence (`plan.items`), never the raw
    // captured list: a capsule trimmed out of the selection, or one dropped by a retained export
    // material cap, must not be previewed as if the film would contain it. The fallback keeps the
    // pre-P2-05 controller working (it exposes only the raw list) without owning any new rules.
    function capsuleItems() {
      const snapshot = state()
      const keystrokes = snapshot && snapshot.keystrokes ? snapshot.keystrokes : null
      const plan = keystrokes && keystrokes.plan ? keystrokes.plan : null
      if (plan && Array.isArray(plan.items)) return plan.items
      return keystrokes && Array.isArray(keystrokes.items)
        ? keystrokes.items.map((item) => ({ ...item, durationMs: KEYSTROKE_CAPSULE_MS }))
        : []
    }

    // The capsule for a media position: the visible window itself comes from the export plan, so
    // a cut-clipped window ends exactly when the burned-in capsule does.
    function activeKeystrokeCapsule(atMs) {
      let active = null
      for (const item of capsuleItems()) {
        const duration = Number.isFinite(item.durationMs) && item.durationMs > 0
          ? item.durationMs
          : KEYSTROKE_CAPSULE_MS
        if (atMs >= item.tMs && atMs < item.tMs + duration) active = item
      }
      return active
    }

    function renderKeystrokeCapsule() {
      const toggle = element('toggle-keystrokes')
      const container = element('keystroke-capsule')
      const snapshot = state()
      const available = !!(snapshot && snapshot.keystrokes && snapshot.keystrokes.available)
      if (toggle) {
        toggle.disabled = !available
        toggle.setAttribute('aria-pressed', keystrokesEnabled ? 'true' : 'false')
        toggle.classList.toggle('active', keystrokesEnabled)
      }
      if (!container) return
      if (!keystrokesEnabled || !available) {
        container.hidden = true
        container.textContent = ''
        container.classList.remove('visible')
        return
      }
      // The element stays laid out (absolute, opacity 0) between keystrokes so the CSS opacity
      // transition can actually run both ways; `hidden` would cut the fade.
      container.hidden = false
      const active = activeKeystrokeCapsule(mediaMs())
      if (!active) {
        container.classList.remove('visible')
        return
      }
      if (container.textContent !== active.combo) container.textContent = active.combo
      container.classList.add('visible')
    }

    function toggleKeystrokes() {
      const snapshot = state()
      if (!snapshot || !snapshot.keystrokes || !snapshot.keystrokes.available) return false
      keystrokesEnabled = !keystrokesEnabled
      render()
      return keystrokesEnabled
    }

    // Main-process codes -> editor copy. Anything unmapped still tells the user the timeline was
    // left untouched instead of failing silently.
    function pauseCutErrorKey(code) {
      if (code === 'no-audio') return 'recording.editor.pause.no-audio'
      if (code === 'no-idle') return 'recording.editor.pause.no-idle'
      if (code === 'nothing-to-cut' || code === 'nothing-kept') return 'recording.editor.pause.nothing'
      if (code === 'analysis-pending') return 'recording.editor.pause.analysis-running'
      if (code === 'analysis-unavailable' || code === 'session-mode') return 'recording.editor.pause.unavailable'
      return 'recording.editor.pause.failed'
    }

    function setPauseCutStatus(key, params = null) {
      pauseCutStatus = { key: key || '', params: params || null }
    }

    function renderPauseCutControls(snapshot, editable) {
      const button = element('cut-silence')
      const analysis = snapshot && snapshot.pauseAnalysis
        ? snapshot.pauseAnalysis
        : { status: 'unavailable', code: '', cuts: [] }
      if (button) {
        button.disabled = !editable
        if (button.dataset) button.dataset.status = analysis.status
      }
      const status = element('pause-cut-status')
      if (status) {
        status.textContent = pauseCutStatus.key ? translate(pauseCutStatus.key, pauseCutStatus.params || undefined) : ''
        if (status.dataset) status.dataset.state = analysis.status
      }
    }

    // "One click remove silent pauses": the controller turns the main-process suggestion into the
    // complement segment list (undoable, autosaved) - this function only routes the answer to the
    // visible status line and never writes anything itself.
    function applyOneClickCut() {
      if (!controller) return false
      const snapshot = state()
      if (!snapshot) return false
      const analysis = snapshot.pauseAnalysis || { status: 'unavailable', code: '', cuts: [] }
      if (analysis.status === 'loading' || analysis.status === 'unavailable') {
        setPauseCutStatus(pauseCutErrorKey(analysis.status === 'loading' ? 'analysis-pending' : 'analysis-unavailable'))
        render()
        return false
      }
      if (analysis.status === 'failed') {
        setPauseCutStatus(pauseCutErrorKey(analysis.code))
        render()
        return false
      }
      if (analysis.status !== 'ready' || !Array.isArray(analysis.cuts) || analysis.cuts.length === 0) {
        setPauseCutStatus('recording.editor.pause.nothing')
        render()
        return false
      }
      const result = controller.applyPauseCuts()
      if (!result || result.ok !== true) {
        setPauseCutStatus(pauseCutErrorKey(result?.code))
        render()
        return false
      }
      setPauseCutStatus('recording.editor.pause.applied', {
        count: result.cuts,
        removed: timelineModule.formatClock(result.removedMs)
      })
      render()
      return true
    }

    // ---------- R5 preview interactions ----------

    function startPickingZoom(index) {
      if (!canEdit()) return false
      pickingZoomIndex = index
      render()
      return true
    }

    function cancelPickingZoom() {
      if (pickingZoomIndex === null) return false
      pickingZoomIndex = null
      render()
      return true
    }

    function applyPickedFocus(event) {
      if (pickingZoomIndex === null || !controller || !event) return false
      const player = element('preview-video')
      if (!player || typeof player.getBoundingClientRect !== 'function') return false
      const rect = player.getBoundingClientRect()
      if (!(rect.width > 0) || !(rect.height > 0)) return false
      const x = Math.max(0, Math.min(1, (Number(event.clientX) - rect.left) / rect.width))
      const y = Math.max(0, Math.min(1, (Number(event.clientY) - rect.top) / rect.height))
      const index = pickingZoomIndex
      pickingZoomIndex = null
      controller.updateZoomFocus(index, x, y)
      render()
      return true
    }

    function spawnRipple(click) {
      const layer = element('ripple-layer')
      if (!layer) return
      const node = createNode('i', 'click-ripple')
      if (!node) return
      node.style.left = (Number(click.x) * 100).toFixed(3) + '%'
      node.style.top = (Number(click.y) * 100).toFixed(3) + '%'
      layer.appendChild(node)
      timers.setTimeout(() => {
        if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node)
      }, 700)
    }

    // Ripple preview is a playback effect: clicks fire once when the clock crosses their
    // OUTPUT time. Scrubbing backwards re-arms them; paused seeks never fire.
    function maybeSpawnRipples(sourceMs) {
      if (!controller) return
      const snapshot = state()
      if (!snapshot || !snapshot.playing || !snapshot.demo.style.ripples) {
        lastPlaybackOutputMs = null
        return
      }
      const outputMs = controller.outputTimeFor(sourceMs)
      if (outputMs === null) {
        lastPlaybackOutputMs = null
        return
      }
      if (lastPlaybackOutputMs === null || outputMs < lastPlaybackOutputMs) {
        lastPlaybackOutputMs = outputMs
        return
      }
      const clicks = controller.mappedClicksOutput()
      for (const click of clicks) {
        if (click.tMs > lastPlaybackOutputMs && click.tMs <= outputMs) spawnRipple(click)
      }
      lastPlaybackOutputMs = outputMs
    }

    function resetRippleClock() {
      lastPlaybackOutputMs = null
    }

    function isTypingTarget(target) {
      if (!target) return false
      const tag = String(target.tagName || '').toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      return target.isContentEditable === true
    }

    function render() {
      if (!booted) return
      const snapshot = state()
      const bodyRef = body()
      if (bodyRef && bodyRef.dataset) {
        bodyRef.dataset.format = snapshot ? snapshot.format : 'mp4'
        if (snapshot?.task?.state) bodyRef.dataset.exportState = snapshot.task.state
        else delete bodyRef.dataset.exportState
      }

      const blocked = !!fatalCode || !project || isRecoveryBlocked()
      const editable = canEdit()

      if (elements['recovery-banner']) {
        const visible = !fatalCode && project && isRecoveryBlocked()
        elements['recovery-banner'].hidden = !visible
        if (visible && elements['recovery-message']) {
          elements['recovery-message'].textContent = translate(recoveryKey())
        }
      }
      if (!fatalCode && !isRecoveryBlocked()) {
        // A successful (or unblocked) load clears the recovery banner's text.
        if (elements['recovery-message']) elements['recovery-message'].textContent = ''
      }
      // D03 (17): the salvage action lives in the banner and is only offered while the
      // project is actually recoverable. It is disabled for the whole run (a double click
      // cannot submit twice) and the cancel button only exists while a run is live.
      const salvageVisible = !fatalCode && !!project && isRecoveryBlocked()
      if (elements['recovery-salvage']) {
        const button = elements['recovery-salvage']
        button.hidden = !salvageVisible
        button.disabled = salvageRunning || typeof api?.salvage !== 'function'
      }
      if (elements['recovery-salvage-cancel']) {
        const button = elements['recovery-salvage-cancel']
        button.hidden = !salvageVisible || !salvageRunning
        button.disabled = !salvageRunning
      }
      if (elements['recovery-notice']) {
        const notice = elements['recovery-notice']
        const text = salvageStatus.key ? translate(salvageStatus.key, salvageStatus.params) : ''
        notice.textContent = text
        notice.hidden = !text
      }

      const durationMs = snapshot ? snapshot.durationMs : (metadata ? metadata.durationMs : 0)
      const segments = snapshot && Array.isArray(snapshot.segments) ? snapshot.segments : []
      const range = snapshot ? snapshot.range : { startMs: 0, endMs: 0 }
      const clock = timelineModule.formatClock
      const keptMs = snapshot ? snapshot.keptMs : 0

      if (elements['timeline-duration']) {
        elements['timeline-duration'].textContent = durationMs > 0
          ? translate('recording.editor.timeline.duration', { duration: clock(durationMs) })
          : ''
      }
      if (elements['range-selection']) {
        // R4 contract §3.3: the statistic is kept vs source length, not a single range.
        elements['range-selection'].textContent = snapshot && durationMs > 0
          ? translate('recording.editor.timeline.kept', {
            kept: clock(keptMs),
            duration: clock(durationMs)
          })
          : ''
      }
      renderTimelineSegments(snapshot, durationMs, editable)
      renderEditControls(snapshot, editable)
      renderPinFrame(snapshot)
      updatePlayhead()

      const focused = documentRef ? documentRef.activeElement : null
      if (elements['range-start-input']) {
        const input = elements['range-start-input']
        input.disabled = !editable || segments.length === 0
        if (input !== focused) input.value = clock(range.startMs)
      }
      if (elements['range-end-input']) {
        const input = elements['range-end-input']
        input.disabled = !editable || segments.length === 0
        if (input !== focused) input.value = clock(range.endMs)
      }

      const format = snapshot ? snapshot.format : 'mp4'
      if (elements['export-format']) {
        elements['export-format'].value = format
        elements['export-format'].disabled = !editable
      }
      if (elements['gif-edge']) {
        elements['gif-edge'].value = String(snapshot?.gif.maxEdgePx ?? timelineModule.LIMITS.GIF_MAX_EDGE_PX)
        elements['gif-edge'].disabled = !editable || format !== 'gif'
      }
      if (elements['gif-fps']) {
        elements['gif-fps'].value = String(snapshot?.gif.fps ?? GIF_FRAME_RATES[1])
        elements['gif-fps'].disabled = !editable || format !== 'gif'
      }
      if (elements['gif-budget']) {
        let text = ''
        if (snapshot && durationMs > 0 && !snapshot.emptySelection) {
          const budget = snapshot.gifBudget
          text = budget.ok
            ? translate('recording.editor.gif-frames', { frames: budget.frames })
            : (budget.code ? translate(errorKey(budget.code)) : '')
          elements['gif-budget'].classList.toggle('invalid', !budget.ok)
        }
        elements['gif-budget'].textContent = text
      }
      renderExportPanel(snapshot, editable)

      renderPreviewFrame(snapshot)
      renderDemoControls(snapshot, editable, blocked)
      // N03: the capsule HUD is an editor-only overlay; the dead-air button only becomes usable
      // once the main process has an analysis answer (the status line explains the rest).
      renderKeystrokeCapsule()
      renderPauseCutControls(snapshot, editable)
      renderProgress(snapshot)
      renderResultBar(snapshot)
      renderExportButton(snapshot, blocked)
      if (elements['cancel-export']) elements['cancel-export'].hidden = !(snapshot && snapshot.canCancel)
      setSaveState(currentSaveKind())

      if (elements['save-state']) elements['save-state'].title = ''

      // Error text: fatal > export error > the last manual message. Recomputing on every
      // render keeps a transient controller state from wiping a message the user needs.
      writeErrorText(fatalCode
        ? fatalCode
        : (snapshot && snapshot.error ? errorKey(snapshot.error.code) : manualErrorKey))
    }

    function renderExportButton(snapshot, blocked) {
      const button = element('export-button')
      if (!button) return
      const busy = !!snapshot && (snapshot.phase === 'submitting' || snapshot.phase === 'active')
      const canCancel = !!snapshot && snapshot.canCancel
      const canExport = !!snapshot && snapshot.canExport && !blocked
      if (busy) {
        // While a task runs the same button is the cancel action, except past the publish
        // point (cancelling is impossible there) where it must still NAME the real state.
        button.disabled = !canCancel
        button.textContent = translate(snapshot.task?.state === 'publishing'
          ? 'recording.editor.finishing'
          : snapshot.task?.state === 'cancelling'
            ? 'recording.editor.cancelling'
            : 'recording.editor.exporting')
        button.dataset.action = canCancel ? 'cancel' : 'busy'
        return
      }
      button.disabled = !canExport
      button.textContent = translate('recording.editor.export')
      button.dataset.action = 'export'
    }

    function renderProgress(snapshot) {
      const progress = element('export-progress')
      if (!progress) return
      const active = !!snapshot && (snapshot.phase === 'submitting' || snapshot.phase === 'active')
      progress.hidden = !active
      const task = snapshot?.task
      if (active && task?.state === 'running' && Number.isFinite(task.progress)) {
        progress.setAttribute('value', String(Math.max(0, Math.min(100, Math.round(task.progress)))))
      } else {
        progress.removeAttribute('value')
      }
    }

    function renderResultBar(snapshot) {
      if (!resultReceipt && snapshot && snapshot.phase === 'succeeded' && snapshot.receipt) {
        showResultBar(snapshot.receipt)
        return
      }
      // No receipt (idle, running, failed or cancelled): the bar stays hidden. That is the
      // feature-A rule that a failed/cancelled export never shows a success bar.
      if (!resultReceipt && elements['result-bar']) elements['result-bar'].hidden = true
    }

    // ---------- result bar (feature-A receipt) ----------

    function setResultStatus(key, isError) {
      const status = element('result-status')
      if (!status) return
      status.textContent = key ? translate(key) : ''
      status.classList.toggle('error', isError === true)
    }

    function showResultBar(receipt) {
      if (!receipt || receipt.status !== 'saved' || typeof receipt.resultId !== 'string' || !receipt.resultId) {
        resultReceipt = null
        if (elements['result-bar']) elements['result-bar'].hidden = true
        return false
      }
      resultReceipt = receipt
      if (elements['result-name']) {
        elements['result-name'].textContent = translate('capture.export-result.saved', {
          fileName: String(receipt.fileName || '')
        })
      }
      const kindElement = element('result-kind')
      if (kindElement) {
        const kindKeys = {
          mp4: 'recording.editor.result.kind.mp4',
          gif: 'recording.editor.result.kind.gif',
          webm: 'recording.editor.result.kind.webm'
        }
        const kind = typeof receipt.kind === 'string' ? receipt.kind : ''
        const kindKey = kindKeys[kind]
        kindElement.textContent = kindKey ? translate(kindKey) : ''
        kindElement.hidden = !kindElement.textContent
      }
      setResultStatus('', false)
      if (elements['result-bar']) elements['result-bar'].hidden = false
      return true
    }

    function hideResultBar() {
      resultReceipt = null
      if (elements['result-bar']) elements['result-bar'].hidden = true
      setResultStatus('', false)
    }

    async function runResultAction(action) {
      if (!resultReceipt) return { status: 'failed', code: 'result-expired' }
      if (typeof api?.exportAction !== 'function') {
        setResultStatus('recording.editor.error.action-unavailable', true)
        return { status: 'failed', code: 'action-unavailable' }
      }
      setResultStatus('capture.export-result.pending', false)
      let result
      try {
        result = await api.exportAction(resultReceipt.resultId, action)
      } catch (error) {
        log('editor: result action failed:', error?.message || error)
        result = { status: 'failed', code: 'open-failed' }
      }
      if (result?.status === 'done') {
        if (action === 'copy-path') setResultStatus('capture.export-result.copied', false)
        else hideResultBar()
        return result
      }
      const keys = {
        'open-failed': 'capture.export-result.open-failed',
        'file-missing': 'capture.export-result.file-missing',
        'result-expired': 'capture.export-result.expired',
        'invalid-owner': 'capture.export-result.expired',
        'unknown-action': 'capture.export-result.action-failed'
      }
      setResultStatus(keys[result?.code] || 'capture.export-result.action-failed', true)
      return result || { status: 'failed', code: 'open-failed' }
    }

    // ---------- error text ----------

    function writeErrorText(key) {
      const error = element('error-text')
      if (!error) return
      error.textContent = key ? translate(key) : ''
    }

    function showError(key) {
      manualErrorKey = key || ''
      writeErrorText(manualErrorKey)
    }

    function clearError() {
      manualErrorKey = ''
      writeErrorText('')
    }

    // ---------- playback ----------

    function video() {
      return element('preview-video')
    }

    function mediaMs() {
      const player = video()
      return Math.max(0, Math.round((Number(player?.currentTime) || 0) * 1000))
    }

    function updatePlayhead() {
      // N03: the capsule follows the media clock, so it is refreshed on every timeupdate/seek.
      renderKeystrokeCapsule()
      const playhead = element('timeline-playhead')
      if (!playhead) return
      const duration = state()?.durationMs || (metadata ? metadata.durationMs : 0)
      if (!(duration > 0)) {
        playhead.style.left = '0%'
        return
      }
      playhead.style.left = `${timelineModule.msToPercent(mediaMs(), duration)}%`
    }

    function stopPlayTimer() {
      if (playTimer) {
        timers.clearInterval(playTimer)
        playTimer = 0
      }
    }

    function playTick() {
      if (controller) maybeSpawnRipples(mediaMs())
      if (!controller) {
        stopPlayTimer()
        return
      }
      const snapshot = controller.state()
      if (!snapshot.playing) {
        stopPlayTimer()
        return
      }
      const decision = controller.reportTime(mediaMs())
      if (decision.action === 'pause') {
        video()?.pause?.()
        const player = video()
        // Land on the last kept frame, not on a removed tail.
        const landingMs = snapshot.playing && Number.isFinite(snapshot.playing.endMs)
          ? snapshot.playing.endMs
          : decision.toMs
        if (player) player.currentTime = Math.max(0, landingMs) / 1000
        stopPlayTimer()
        updatePlayhead()
        render()
        return
      }
      if (decision.action === 'seek') {
        const player = video()
        if (player) player.currentTime = Math.max(0, decision.toMs) / 1000
      }
      updatePlayhead()
    }

    function startRangePlayback() {
      if (!controller) return false
      resetRippleClock()
      const snapshot = controller.state()
      const fromMs = mediaMs()
      const started = snapshot.projectId
        ? controller.startKeptPlayback(fromMs)
        : controller.playRange()
      const player = video()
      if (!started || !player) {
        if (snapshot.projectId && snapshot.segments.length === 0) {
          showError('recording.editor.timeline.empty')
          render()
        }
        return false
      }
      player.currentTime = Math.max(0, started.startMs) / 1000
      // Arm the ripple clock at the first played OUTPUT position so a click between the
      // start and the first polling tick still fires exactly once.
      if (controller) {
        const startOutputMs = controller.outputTimeFor(started.startMs)
        lastPlaybackOutputMs = startOutputMs === null ? null : startOutputMs
      }
      stopPlayTimer()
      playTimer = timers.setInterval(playTick, RANGE_PLAY_POLL_MS)
      const playing = player.play?.()
      if (playing && typeof playing.catch === 'function') playing.catch(() => {})
      render()
      return true
    }

    function stopRangePlayback() {
      stopPlayTimer()
      controller?.stopRangePlayback()
      video()?.pause?.()
      render()
    }

    function toggleRangePlayback() {
      if (state()?.playing) stopRangePlayback()
      else startRangePlayback()
    }

    function seekTo(milliseconds) {
      resetRippleClock()
      const player = video()
      const duration = state()?.durationMs || 0
      if (!player || !(duration > 0)) return
      const target = Math.max(0, Math.min(Math.round(milliseconds), duration))
      player.currentTime = target / 1000
      if (state()?.playing) controller.reportTime(target, { fromUser: true })
      updatePlayhead()
    }

    // ---------- B08: pin the current frame ----------

    // Result -> copy mapping lives in one table so the timeline can never show a raw
    // main-process code and the three translations stay testable without a DOM.
    function renderPinStatus() {
      const status = element('pin-frame-status')
      if (!status) return
      status.textContent = pinStatus.key ? translate(pinStatus.key, pinStatus.params || undefined) : ''
      if (pinStatus.state) status.dataset.state = pinStatus.state
      else if (status.dataset) delete status.dataset.state
    }

    function setPinStatus(key, state = '', params = null) {
      pinStatus = { key: key || '', state: state || '', params: params || null }
      renderPinStatus()
    }

    // Enabled only when a frame exists to pin: a live project, a known duration, kept content
    // and no encode in flight. `pinBusy` disables it as well so a repeated activation cannot
    // queue a second grab before the next render commits the disabled state.
    function renderPinFrame(snapshot) {
      const button = element('pin-frame')
      if (!button) return
      const usable = !!project && !!snapshot && snapshot.durationMs > 0
        && !snapshot.emptySelection && !snapshot.busy
      button.disabled = !usable || pinBusy
      button.dataset.busy = pinBusy ? 'true' : 'false'
      renderPinStatus()
    }

    function waitForPlayerEvent(player, type, timeoutMs) {
      return new Promise((resolve) => {
        if (!player || typeof player.addEventListener !== 'function') { resolve(false); return }
        let settled = false
        let timer = 0
        const finish = (value) => {
          if (settled) return
          settled = true
          if (typeof player.removeEventListener === 'function') player.removeEventListener(type, onEvent)
          if (timer) timers.clearTimeout(timer)
          resolve(value)
        }
        const onEvent = () => finish(true)
        player.addEventListener(type, onEvent)
        timer = timers.setTimeout(() => finish(false), timeoutMs)
      })
    }

    // Seek to a source time and report the mediaTime of the frame Chromium actually presents.
    // rVFC must be armed BEFORE the seek: on a paused element the seeked frame IS the next
    // presentation, so a callback registered after 'seeked' never fires (verified against
    // Electron 43's Chromium). Without rVFC the post-'seeked' currentTime is the best estimate.
    function seekToPresentedFrame(player, milliseconds, frameRate) {
      const target = Math.max(0, Math.round(finite(milliseconds) || 0))
      const requestFrame = player && typeof player.requestVideoFrameCallback === 'function'
        ? player.requestVideoFrameCallback.bind(player)
        : null
      if (!requestFrame) {
        const waiting = waitForPlayerEvent(player, 'seeked', PIN_FRAME_SEEK_TIMEOUT_MS)
        player.currentTime = target / 1000
        return waiting.then((seeked) => (
          seeked ? { ok: true, presentedMs: mediaMs() } : { ok: false, presentedMs: target }
        ))
      }
      return new Promise((resolve) => {
        let settled = false
        let nudged = false
        let timer = 0
        const finish = (presentedMs) => {
          if (settled) return
          settled = true
          if (timer) timers.clearTimeout(timer)
          resolve({ ok: true, presentedMs: Math.max(0, Math.round(finite(presentedMs) || 0)) })
        }
        const arm = (requestedMs) => {
          requestFrame((_now, metadata) => {
            if (settled) return
            const mediaTime = metadata && finite(metadata.mediaTime) !== null
              ? Number(metadata.mediaTime) * 1000
              : null
            if (mediaTime === null) { finish(mediaMs()); return }
            const decision = frameSeekTarget(requestedMs, mediaTime, frameRate)
            if (!decision.accept && !nudged && decision.seekMs !== null) {
              // One corrective seek, armed before it lands, then take whatever is presented.
              nudged = true
              arm(decision.seekMs)
              player.currentTime = Math.max(0, decision.seekMs) / 1000
              return
            }
            finish(mediaTime)
          })
        }
        timer = timers.setTimeout(() => finish(mediaMs()), PIN_FRAME_SEEK_TIMEOUT_MS + PIN_FRAME_FRAME_WAIT_MS)
        arm(target)
        player.currentTime = target / 1000
      })
    }

    function canvasToPngBytes(canvas) {
      return new Promise((resolve) => {
        if (!canvas) { resolve(null); return }
        if (typeof canvas.toBlob === 'function') {
          try {
            canvas.toBlob((blob) => {
              if (!blob || typeof blob.arrayBuffer !== 'function') { resolve(null); return }
              blob.arrayBuffer().then(
                (buffer) => resolve(new Uint8Array(buffer)),
                () => resolve(null)
              )
            }, 'image/png')
            return
          } catch (error) {
            log('editor: canvas toBlob failed:', error?.message || error)
          }
        }
        // A tainted canvas throws on both encoders. Report an empty result rather than
        // leaking a DOM exception; the caller shows the translated failure instead.
        try {
          const dataUrl = typeof canvas.toDataURL === 'function' ? canvas.toDataURL('image/png') : ''
          const prefix = 'data:image/png;base64,'
          if (!dataUrl.startsWith(prefix) || typeof root.atob !== 'function') { resolve(null); return }
          const binary = root.atob(dataUrl.slice(prefix.length))
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          resolve(bytes)
        } catch (error) {
          log('editor: canvas toDataURL failed:', error?.message || error)
          resolve(null)
        }
      })
    }

    // Pause the transport if needed, settle on the current KEPT frame, then rasterise the
    // preview's source pixels into an offscreen canvas. Nothing touches the project: the PNG
    // exists only in memory and the main process decides what to do with it.
    async function captureCurrentFrame(generation) {
      const snapshot = state()
      if (!snapshot || !project) return { ok: false, code: 'project-missing' }
      const player = video()
      if (!player) return { ok: false, code: 'no-frame' }
      // Read the position BEFORE pausing: pausing must not move the frame the user saw.
      const currentMs = mediaMs()
      if (snapshot.playing) stopRangePlayback()
      else if (player.paused === false && typeof player.pause === 'function') player.pause()
      // HAVE_CURRENT_DATA is the first state that has a frame to draw; before it the canvas
      // would be transparent, so report the "not decoded yet" copy instead of a blank pin.
      if (typeof player.readyState === 'number' && player.readyState < 2) {
        return { ok: false, code: 'no-frame' }
      }

      const frameRate = snapshot.metadata?.video?.frameRate
        || (metadata && metadata.video ? metadata.video.frameRate : 0)
      const located = locatePinFrame({
        currentMs,
        segments: snapshot.segments,
        durationMs: snapshot.durationMs,
        frameRate
      })
      if (!located.ok) return located

      let frameMs = located.sourceMs
      if (located.adjusted) {
        const presented = await seekToPresentedFrame(player, located.sourceMs, frameRate)
        if (destroyed || generation !== pinGeneration) return { ok: false, code: 'cancelled' }
        if (!presented.ok) return { ok: false, code: 'no-frame' }
        frameMs = presented.presentedMs
      }
      if (destroyed || generation !== pinGeneration) return { ok: false, code: 'cancelled' }

      const size = frameCanvasSize(player.videoWidth, player.videoHeight, snapshot.metadata || metadata)
      if (!size.ok) return size
      if (!documentRef || typeof documentRef.createElement !== 'function') {
        return { ok: false, code: 'canvas-unavailable' }
      }
      const canvas = documentRef.createElement('canvas')
      if (!canvas || typeof canvas.getContext !== 'function') return { ok: false, code: 'canvas-unavailable' }
      canvas.width = size.width
      canvas.height = size.height
      const context = canvas.getContext('2d')
      if (!context || typeof context.drawImage !== 'function') return { ok: false, code: 'canvas-unavailable' }
      try {
        // Source pixels 1:1, no editor chrome: the canvas IS the frame, not the preview box.
        context.drawImage(player, 0, 0, size.width, size.height)
      } catch (error) {
        log('editor: frame draw failed:', error?.message || error)
        return { ok: false, code: 'no-frame' }
      }
      const png = await canvasToPngBytes(canvas)
      if (destroyed || generation !== pinGeneration) return { ok: false, code: 'cancelled' }
      if (!png || !png.byteLength) return { ok: false, code: 'frame-encode-failed' }
      if (png.byteLength > PIN_FRAME_MAX_BYTES) return { ok: false, code: 'frame-too-large' }
      if (typeof api?.pinFrame !== 'function') return { ok: false, code: 'unavailable' }

      const pinMeta = buildPinFrameMeta({
        projectId: project.id,
        frameMs,
        width: size.width,
        height: size.height,
        scaleFactor: root.devicePixelRatio,
        nowMs: now()
      })
      try {
        const answer = await api.pinFrame(project.id, png, pinMeta)
        return answer && typeof answer === 'object' ? answer : { ok: false, code: 'pin-failed' }
      } catch (error) {
        if (destroyed) return { ok: false, code: 'cancelled' }
        log('editor: pin frame invoke failed:', error?.message || error)
        return { ok: false, code: 'pin-failed' }
      }
    }

    async function pinCurrentFrame() {
      if (pinBusy) return { ok: false, code: 'busy' }
      if (destroyed) return { ok: false, code: 'cancelled' }
      const snapshot = state()
      if (!snapshot || !project) {
        setPinStatus('record.pin-frame.empty', 'conflict')
        render()
        return { ok: false, code: 'project-missing' }
      }
      if (snapshot.emptySelection || !(snapshot.durationMs > 0)) {
        setPinStatus('record.pin-frame.empty', 'conflict')
        render()
        return { ok: false, code: 'empty-selection' }
      }
      if (typeof api?.pinFrame !== 'function') {
        setPinStatus('record.pin-frame.unavailable', 'conflict')
        render()
        return { ok: false, code: 'unavailable' }
      }
      pinBusy = true
      const generation = ++pinGeneration
      setPinStatus('record.pin-frame.busy', 'saving')
      render()
      let result
      try {
        result = await captureCurrentFrame(generation)
      } catch (error) {
        log('editor: pin current frame failed:', error?.message || error)
        result = { ok: false, code: 'pin-failed' }
      }
      if (destroyed || generation !== pinGeneration) return { ok: false, code: 'cancelled' }
      pinBusy = false
      const status = pinFrameStatusKey(result && result.code, result?.ok === true)
      setPinStatus(status.key, status.state, status.key === 'record.pin-frame.limit'
        ? { max: Math.max(1, Math.round(finite(result && result.max) || 20)) }
        : null)
      render()
      return result
    }

    // ---------- pointer drag / keyboard ----------

    function trackRect() {
      const track = element('timeline-track')
      if (!track || typeof track.getBoundingClientRect !== 'function') return { left: 0, width: 0 }
      const rect = track.getBoundingClientRect()
      return { left: Number(rect.left) || 0, width: Number(rect.width) || 0 }
    }

    function descriptorValueMs(descriptor) {
      const segments = state()?.segments || []
      if (segments.length === 0) return 0
      if (descriptor.kind === 'outer-start') return segments[0].startMs
      if (descriptor.kind === 'outer-end') return segments[segments.length - 1].endMs
      const segment = segments[descriptor.index]
      if (!segment) return 0
      if (descriptor.kind === 'junction') return segment.startMs
      return descriptor.edge === 'start' ? segment.startMs : segment.endMs
    }

    // Push a descriptor's target time through the controller. The timeline helpers clamp it
    // against the neighbours, so a drag can never overlap another segment.
    function applyDescriptorTarget(descriptor, targetMs) {
      const segments = state()?.segments || []
      if (!controller || segments.length === 0) return false
      if (descriptor.kind === 'outer-start') return controller.moveBoundary(0, 'start', targetMs)
      if (descriptor.kind === 'outer-end') return controller.moveBoundary(segments.length - 1, 'end', targetMs)
      if (descriptor.kind === 'junction') return controller.moveJunction(descriptor.index, targetMs)
      return controller.moveBoundary(descriptor.index, descriptor.edge, targetMs)
    }

    function beginBoundaryDrag(descriptor, event) {
      if (!canEdit() || !controller) return false
      if (event && typeof event === 'object' && typeof event.button === 'number' && event.button !== 0) return false
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      // One drag = one undo entry: snapshot at pointerdown, commit at pointerup.
      controller.beginEdit()
      dragging = { ...descriptor }
      addDragListeners()
      return true
    }

    // Kept for the R3 static handles/tests: #handle-start and #handle-end are the outer edges.
    function beginHandleDrag(handle, event) {
      return beginBoundaryDrag(handle === 'start' ? { kind: 'outer-start' } : { kind: 'outer-end' }, event)
    }

    function addDragListeners() {
      if (dragListeners || !windowRef || typeof windowRef.addEventListener !== 'function') return
      dragListeners = {
        move: (event) => dragMove(event),
        end: () => endHandleDrag()
      }
      windowRef.addEventListener('pointermove', dragListeners.move)
      windowRef.addEventListener('pointerup', dragListeners.end)
      windowRef.addEventListener('pointercancel', dragListeners.end)
    }

    function removeDragListeners() {
      if (!dragListeners || !windowRef || typeof windowRef.removeEventListener !== 'function') {
        dragListeners = null
        return
      }
      windowRef.removeEventListener('pointermove', dragListeners.move)
      windowRef.removeEventListener('pointerup', dragListeners.end)
      windowRef.removeEventListener('pointercancel', dragListeners.end)
      dragListeners = null
    }

    function dragMove(event) {
      if (!controller || !event) return
      const milliseconds = timelineModule.pointerToMs(event.clientX, trackRect(), state()?.durationMs || 0)
      // The playhead is draggable too; it never edits the kept segments (contract §3.3).
      if (scrubDragging) {
        seekTo(milliseconds)
        return
      }
      if (!dragging) return
      applyDescriptorTarget(dragging, milliseconds)
    }

    function endHandleDrag() {
      if (dragging && controller) controller.commitEdit()
      dragging = null
      scrubDragging = false
      removeDragListeners()
    }

    function nudgeBoundary(descriptor, event) {
      if (!canEdit() || !controller || !event) return false
      const key = event.key
      const duration = state()?.durationMs || 0
      if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return false
      let targetMs
      if (key === 'Home') targetMs = 0
      else if (key === 'End') targetMs = duration
      else {
        const step = timelineModule.keyboardStep(event)
        targetMs = descriptorValueMs(descriptor) + (key === 'ArrowLeft' ? -step : step)
      }
      controller.beginEdit()
      const changed = applyDescriptorTarget(descriptor, targetMs)
      if (changed) controller.commitEdit()
      else controller.cancelEdit()
      if (typeof event.preventDefault === 'function') event.preventDefault()
      return changed
    }

    function nudgeHandle(handle, event) {
      return nudgeBoundary(handle === 'start' ? { kind: 'outer-start' } : { kind: 'outer-end' }, event)
    }

    // ---------- export ----------

    async function exportSelection() {
      if (!controller || !project) {
        showError('recording.editor.error.project-missing')
        render()
        return { status: 'failed', code: 'project-missing' }
      }
      if (isBusy()) return cancelRunningExport()
      const snapshot = controller.state()
      if (snapshot.phase === 'succeeded' || snapshot.phase === 'cancelled') controller.resetAfterExport()
      else if (snapshot.phase === 'failed') controller.prepareRetry()
      hideResultBar()
      clearError()
      if (snapshot.emptySelection) {
        // Contract §5: an empty selection is refused in the renderer and never reaches IPC.
        showError('recording.editor.error.empty-selection')
        render()
        return { status: 'failed', code: 'empty-selection' }
      }
      if (!snapshot.canExport) {
        // The controller refuses a submit without a valid source/range. Do not fake an
        // export attempt: report why the gate is closed and leave the source untouched.
        showError(snapshot.available
          ? errorKey(snapshot.format === 'gif' ? (snapshot.gifBudget.code || 'invalid-request') : 'invalid-request')
          : 'recording.editor.error.export-not-ready')
        render()
        return { status: 'failed', code: snapshot.available ? 'invalid-range' : 'not-ready' }
      }
      if (typeof api?.exportProject !== 'function') {
        showError('recording.editor.error.action-unavailable')
        render()
        return { status: 'failed', code: 'action-unavailable' }
      }
      const answer = await controller.startExport({
        submit: ({ requestId, request }) => api.exportProject(project.id, requestId, request)
      })
      if (answer?.status === 'accepted' && answer.task) {
        controller.applyTask(answer.task)
        startStatusPolling()
      }
      render()
      return answer
    }

    async function cancelRunningExport() {
      if (!controller || !project) return { ok: false, code: 'task-not-found' }
      if (!controller.state().canCancel) return { ok: false, code: 'publish-in-progress' }
      if (typeof api?.cancelExport !== 'function') {
        showError('recording.editor.error.action-unavailable')
        return { ok: false, code: 'action-unavailable' }
      }
      const answer = await controller.cancelExport({
        cancel: (query) => api.cancelExport(query)
      })
      if (answer?.code === 'publish-in-progress') {
        setResultStatus('record.error.export-publish-in-progress', false)
      }
      render()
      return answer
    }

    function stopStatusPolling() {
      if (pollTimer) {
        timers.clearInterval(pollTimer)
        pollTimer = 0
        pollAttempts = 0
      }
    }

    function startStatusPolling() {
      stopStatusPolling()
      if (typeof api?.exportStatus !== 'function' || !controller || !project) return
      pollTimer = timers.setInterval(async () => {
        pollAttempts += 1
        if (pollAttempts > 240 || !controller || !project) return stopStatusPolling()
        const snapshot = controller.state()
        if (!snapshot || !snapshot.busy) return stopStatusPolling()
        try {
          const answer = await api.exportStatus({
            projectId: project.id,
            taskId: snapshot.task?.taskId,
            requestId: snapshot.requestId
          })
          const task = taskFromAnswer(answer)
          if (task) controller.applyTask(task)
          render()
          if (!controller.state().busy) stopStatusPolling()
        } catch (error) {
          log('editor: exportStatus failed:', error?.message || error)
        }
      }, EXPORT_POLL_MS)
    }

    // A progress push and a poll answer both land here, so a lost event is recoverable. A task
    // for a different id is ignored by the controller.
    function handleTask(task) {
      if (!controller || !task) return false
      const applied = controller.applyTask(task)
      if (applied) {
        if (!controller.state().busy) stopStatusPolling()
        render()
      }
      return applied
    }

    // ---------- window / header actions ----------

    async function closeWindow() {
      const flushed = controller && controller.state().draft.dirty ? await flushDraft() : null
      if (flushed && flushed.ok === false) log('editor: draft flush before close did not succeed')
      try {
        if (typeof api?.windowAction === 'function') api.windowAction('close')
        else if (typeof api?.closeWindow === 'function') api.closeWindow()
      } catch (error) {
        log('editor: close failed:', error?.message || error)
      }
    }

    function minimizeWindow() {
      try {
        if (typeof api?.windowAction === 'function') api.windowAction('minimize')
      } catch (error) {
        log('editor: minimize failed:', error?.message || error)
      }
    }

    async function backToRecords() {
      await flushDraft()
      try {
        if (typeof api?.back === 'function') api.back()
        else showError('recording.editor.error.action-unavailable')
      } catch (error) {
        log('editor: back failed:', error?.message || error)
      }
    }

    async function rerecord() {
      if (!project) return
      await flushDraft()
      try {
        if (typeof api?.rerecord === 'function') api.rerecord(project.id)
        else showError('recording.editor.error.action-unavailable')
      } catch (error) {
        log('editor: rerecord failed:', error?.message || error)
      }
    }

    async function revealSource() {
      if (!project) return
      try {
        if (typeof api?.reveal === 'function') await api.reveal(project.id)
        else showError('recording.editor.error.action-unavailable')
      } catch (error) {
        log('editor: reveal failed:', error?.message || error)
        showError('recording.editor.error.action-unavailable')
      }
    }

    function openNameEditor() {
      if (!project) return false
      const name = element('source-name')
      const input = element('source-name-input')
      if (!name || !input) return false
      input.value = project.name || ''
      input.hidden = false
      name.hidden = true
      renameOpen = true
      if (typeof input.focus === 'function') input.focus()
      if (typeof input.select === 'function') input.select()
      return true
    }

    function closeNameEditor() {
      const name = element('source-name')
      const input = element('source-name-input')
      if (input) input.hidden = true
      if (name) name.hidden = false
      renameOpen = false
    }

    async function commitRename() {
      if (!renameOpen) return { ok: false }
      const input = element('source-name-input')
      const name = input ? String(input.value || '').trim() : ''
      closeNameEditor()
      if (!project || !name || name === project.name) return { ok: true, skipped: true }
      if (typeof api?.renameProject !== 'function') {
        showError('recording.editor.error.action-unavailable')
        return { ok: false }
      }
      let answer
      try {
        answer = await api.renameProject(project.id, name)
      } catch (error) {
        log('editor: rename failed:', error?.message || error)
        answer = { ok: false }
      }
      if (answer?.ok && answer.project) {
        project = { ...project, name: typeof answer.project.name === 'string' ? answer.project.name : name }
        if (elements['source-name']) elements['source-name'].textContent = project.name
        return answer
      }
      showError('recording.editor.error.rename-failed')
      render()
      return { ok: false }
    }

    // ---------- DOM bindings ----------

    // An async handler that rejects would surface as an unhandled rejection in the window and
    // leave the user with no feedback; this turns any of them into a visible translated error.
    function runSafely(promise) {
      if (!promise || typeof promise.catch !== 'function') return
      promise.catch((error) => {
        log('editor: action failed:', error?.message || error)
        showError('recording.editor.error.action-unavailable')
        render()
      })
    }

    function bindDom() {
      const track = element('timeline-track')
      on(element('handle-start'), 'pointerdown', (event) => beginHandleDrag('start', event))
      on(element('handle-end'), 'pointerdown', (event) => beginHandleDrag('end', event))
      on(element('handle-start'), 'keydown', (event) => nudgeHandle('start', event))
      on(element('handle-end'), 'keydown', (event) => nudgeHandle('end', event))
      // Clicking the track scrubs the PLAYHEAD only. Moving the playhead never edits the
      // segments (R4 contract §3.3); only boundary grips and the precise inputs do.
      on(track, 'pointerdown', (event) => {
        if (dragging || scrubDragging) return
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        seekTo(timelineModule.pointerToMs(event?.clientX, trackRect(), state()?.durationMs || 0))
        scrubDragging = true
        addDragListeners()
        render()
      })
      on(element('range-start-input'), 'change', () => {
        controller?.setStart(element('range-start-input').value)
        render()
      })
      on(element('range-end-input'), 'change', () => {
        controller?.setEnd(element('range-end-input').value)
        render()
      })
      on(element('play-range'), 'click', () => toggleRangePlayback())
      // N03: capsule HUD toggle + one-click dead-air removal (both are ordinary button actions;
      // the actual edit goes through the trim controller and is undoable/autosaved).
      on(element('toggle-keystrokes'), 'click', () => { toggleKeystrokes() })
      on(element('cut-silence'), 'click', () => { applyOneClickCut() })
      on(element('pin-frame'), 'click', () => { runSafely(pinCurrentFrame()) })
      on(element('split-at-playhead'), 'click', () => {
        if (controller?.splitAt(mediaMs())) render()
      })
      on(element('delete-segment'), 'click', () => {
        if (controller?.deleteSegmentAt(mediaMs())) render()
      })
      on(element('reset-edits'), 'click', () => {
        if (controller?.resetEdits()) render()
      })
      on(element('undo-edit'), 'click', () => {
        if (controller?.undoEdit()) render()
      })
      on(element('redo-edit'), 'click', () => {
        if (controller?.redoEdit()) render()
      })
      on(element('export-format'), 'change', () => {
        controller?.setFormat(element('export-format').value)
        render()
      })
      on(element('gif-edge'), 'change', () => {
        controller?.setGifMaxEdge(Number(element('gif-edge').value))
        render()
      })
      on(element('gif-fps'), 'change', () => {
        controller?.setGifFps(Number(element('gif-fps').value))
        render()
      })
      on(element('export-resolution'), 'change', () => {
        controller?.setVideoResolution(element('export-resolution').value)
        render()
      })
      on(element('export-quality'), 'change', () => {
        controller?.setVideoQuality(element('export-quality').value)
        render()
      })
      on(element('export-fps'), 'change', () => {
        controller?.setVideoFps(element('export-fps').value)
        render()
      })
      // DEV-05: opt-in capsule overlay for the exported film. The controller owns the choice so a
      // request rebuild (retry, format switch) always carries the latest selection.
      on(element('export-keystrokes'), 'change', () => {
        controller?.setExportKeystrokes(element('export-keystrokes').checked)
        render()
      })
      on(element('export-button'), 'click', () => { runSafely(exportSelection()) })
      on(element('cancel-export'), 'click', () => { runSafely(cancelRunningExport()) })
      on(element('result-open'), 'click', () => runSafely(runResultAction('open')))
      on(element('result-address'), 'click', () => runSafely(runResultAction('copy-path')))
      on(element('result-reveal'), 'click', () => runSafely(runResultAction('reveal')))
      on(element('result-dismiss'), 'click', () => hideResultBar())
      on(element('recovery-retry'), 'click', () => { runSafely(retryRecovery()) })
      on(element('recovery-reveal'), 'click', () => { runSafely(revealSource()) })
      // D03 (17): the two salvage actions go through the same runSafely wrapper as every
      // other button, so a rejected promise surfaces instead of dying in the console.
      on(element('recovery-salvage'), 'click', () => { runSafely(salvagePlayable()) })
      on(element('recovery-salvage-cancel'), 'click', () => { runSafely(cancelSalvage()) })
      on(element('draft-reload'), 'click', () => { runSafely(reloadProject({ keepConflictNotice: false })) })
      on(element('reveal-source'), 'click', () => { runSafely(revealSource()) })
      on(element('rerecord'), 'click', () => { runSafely(rerecord()) })
      on(element('back-to-records'), 'click', () => { runSafely(backToRecords()) })
      on(element('window-minimize'), 'click', () => { minimizeWindow() })
      on(element('window-close'), 'click', () => { runSafely(closeWindow()) })
      on(element('source-name'), 'click', () => { openNameEditor() })
      on(element('source-name-input'), 'keydown', (event) => {
        if (!event) return
        if (event.key === 'Enter') runSafely(commitRename())
        else if (event.key === 'Escape') {
          closeNameEditor()
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
        }
      })
      on(element('source-name-input'), 'blur', () => { runSafely(commitRename()) })

      // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (and the Cmd variants). Never intercepted while a text
      // field or select is focused, so the user can still undo their typing.
      on(windowRef, 'keydown', (event) => {
        if (event && event.key === 'Escape' && pickingZoomIndex !== null) {
          cancelPickingZoom()
          if (typeof event.preventDefault === 'function') event.preventDefault()
          return
        }
        if (!event || !(event.ctrlKey || event.metaKey)) return
        if (isTypingTarget(event.target) || isTypingTarget(documentRef?.activeElement)) return
        const key = String(event.key || '').toLowerCase()
        const handled = (key === 'z' && event.shiftKey)
          ? controller?.redoEdit()
          : (key === 'z' ? controller?.undoEdit() : (key === 'y' ? controller?.redoEdit() : false))
        if (handled) {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          render()
        }
      })

      // R5 demo controls.
      on(element('demo-enabled'), 'change', () => {
        controller?.setDemoEnabled(element('demo-enabled').checked)
        render()
      })
      on(element('demo-background'), 'change', () => {
        const value = element('demo-background').value
        if (value === 'custom') {
          const custom = element('demo-background-custom')
          if (custom) {
            custom.hidden = false
            if (typeof custom.focus === 'function') custom.focus()
            controller?.setDemoBackground(custom.value)
          }
        } else {
          controller?.setDemoBackground(value)
        }
        render()
      })
      on(element('demo-background-custom'), 'input', () => {
        const custom = element('demo-background-custom')
        if (custom && !custom.hidden) controller?.setDemoBackground(custom.value)
        render()
      })
      on(element('demo-padding'), 'input', () => {
        controller?.setDemoPaddingPercent(Number(element('demo-padding').value))
        render()
      })
      on(element('demo-radius'), 'input', () => {
        controller?.setDemoRadius(Number(element('demo-radius').value))
        render()
      })
      on(element('demo-shadow'), 'change', () => {
        controller?.setDemoShadow(element('demo-shadow').checked)
        render()
      })
      on(element('demo-ripples'), 'change', () => {
        const enabled = element('demo-ripples').checked
        if (controller?.setDemoRipples(enabled) === false && enabled) {
          showError('recording.editor.events-status.none')
        }
        render()
      })
      on(element('demo-reset'), 'click', () => {
        controller?.resetDemo()
        pickingZoomIndex = null
        render()
      })
      on(element('zoom-add'), 'click', () => {
        if (controller?.addZoomAt(mediaMs())) render()
      })
      on(element('demo-canvas'), 'click', (event) => applyPickedFocus(event))
      on(element('preview-video'), 'click', (event) => applyPickedFocus(event))

      const player = element('preview-video')
      on(player, 'timeupdate', () => updatePlayhead())
      on(player, 'seeking', () => updatePlayhead())
      on(player, 'play', () => {
        const snapshot = state()
        if (!snapshot || !snapshot.playing) return
        // Kept playback is driven by the controller's interval; a user-initiated play outside
        // it is left alone.
        if (snapshot.playing.mode === 'kept') return
        if (mediaMs() < snapshot.playing.startMs || mediaMs() >= snapshot.playing.endMs) {
          stopRangePlayback()
        }
      })
      on(player, 'pause', () => {
        const snapshot = state()
        if (!snapshot?.playing) return
        if (snapshot.playing.mode === 'kept') {
          // A pause before the last kept end means the user stopped playback; at/after it the
          // controller has already ended playback by itself.
          const segments = snapshot.segments
          const lastEnd = segments.length > 0 ? segments[segments.length - 1].endMs : 0
          if (mediaMs() >= lastEnd) return
          stopRangePlayback()
          return
        }
        if (mediaMs() >= snapshot.playing.endMs) return
        stopRangePlayback()
      })
      on(player, 'loadedmetadata', () => updatePlayhead())
      on(windowRef, 'resize', () => { render() })
      on(windowRef, 'pagehide', () => {
        // Contract §11: flush the draft before the window goes away. The IPC promise may not
        // settle after the renderer is destroyed, so this is best-effort by design.
        if (controller && controller.state().draft.dirty) flushDraft()
      })
    }


    function destroy() {
      if (destroyed) return
      destroyed = true
      // B08: invalidate an in-flight frame grab so a closed window never reaches IPC with
      // pixels the user already left behind. Nothing was written, so there is nothing to undo.
      pinGeneration += 1
      pinBusy = false
      stopPlayTimer()
      stopStatusPolling()
      clearSaveTimer()
      if (initTimer) timers.clearTimeout(initTimer)
      if (typeof languageUnsubscribe === 'function') languageUnsubscribe()
      removeDragListeners()
      for (const listener of listeners) {
        if (listener.target && typeof listener.target.removeEventListener === 'function') {
          listener.target.removeEventListener(listener.type, listener.handler)
        }
      }
      listeners.length = 0
      controller = null
      project = null
    }

    return {
      boot,
      applyInit,
      render,
      handleChange,
      exportSelection,
      cancelRunningExport,
      pinCurrentFrame,
      handleTask,
      retryRecovery,
      reloadProject,
      saveNow,
      flushDraft,
      toggleRangePlayback,
      startRangePlayback,
      stopRangePlayback,
      runResultAction,
      showResultBar,
      hideResultBar,
      showError,
      closeWindow,
      minimizeWindow,
      backToRecords,
      rerecord,
      revealSource,
      commitRename,
      openNameEditor,
      destroy,
      // Read-only surface used by the layout probe and the node tests.
      getController: () => controller,
      getReceipt: () => (resultReceipt ? { ...resultReceipt } : null),
      getProject: () => project,
      getMetadata: () => metadata,
      getRecovery: () => ({ ...recovery }),
      getFatalCode: () => fatalCode,
      loadEvents,
      // N03 read-only/action surface for the fake-DOM tests and the layout probe.
      applyOneClickCut,
      toggleKeystrokes,
      isKeystrokesEnabled: () => keystrokesEnabled,
      getPauseCutStatus: () => ({ ...pauseCutStatus }),
      startPickingZoom,
      cancelPickingZoom,
      getPickingZoomIndex: () => pickingZoomIndex,
      isRecoveryVisible: () => !!element('recovery-banner') && !element('recovery-banner').hidden,
      isDraftConflictVisible: () => !!element('draft-conflict') && !element('draft-conflict').hidden,
      // D03 (17): the salvage surface is inspectable so an E2E/probe can assert the running
      // state, the stale-receipt rule and the final status without scraping DOM text.
      salvagePlayable,
      cancelSalvage,
      getSalvageState: () => ({
        running: salvageRunning,
        requestId: salvageRequestId,
        statusKey: salvageStatus.key,
        params: salvageStatus.params ? { ...salvageStatus.params } : null
      }),
      elements
    }
  }

  // The browser boot. Kept as a factory-level function so record/editor.html only needs the
  // script tags; the probe and E2E drive the same view through `recordingEditor.applyInit`.
  let bootedView = null

  function boot(documentRef = root.document) {
    if (bootedView) return bootedView
    bootedView = createEditorView({ api: root.recordEditorAPI || null, document: documentRef, window: root })
    bootedView.boot()
    return bootedView
  }

  function applyInit(data) {
    if (!bootedView) boot()
    return bootedView ? bootedView.applyInit(data) : false
  }

  const moduleApi = {
    ELEMENT_IDS,
    EDIT_REASONS,
    EXPORT_POLL_MS,
    SAVE_DEBOUNCE_MS,
    createEditorView,
    boot,
    applyInit,
    getView: () => bootedView,
    normalizeEditorMetadata,
    taskFromAnswer,
    // B08 pure helpers (frame selection, VFR tolerance, canvas sizing, pin metadata).
    frameDurationMs,
    frameDeviation,
    withinOneFrame,
    nearestFrameTime,
    frameSeekTarget,
    locatePinFrame,
    frameCanvasSize,
    buildPinFrameMeta,
    pinFrameStatusKey
  }

  // Auto-boot in the real window; node tests import the module without a document and create
  // their own view, so this guard keeps `require()` side-effect free.
  if (root.document && root.document.getElementById) {
    root.recordingEditor = moduleApi
    try {
      boot()
    } catch (error) {
      // A renderer exception must never leave a window with no content; the fatal banner is
      // rendered by boot when possible, and this log is the diagnostic.
    }
  }

  return moduleApi
})
