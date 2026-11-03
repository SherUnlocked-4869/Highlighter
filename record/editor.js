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
    'export-progress', 'export-progress-bar',
    'preview-video',
    'recovery-banner', 'recovery-message', 'recovery-retry', 'recovery-reveal',
    'draft-conflict', 'draft-conflict-message', 'draft-reload',
    'timeline', 'timeline-track', 'timeline-selection', 'timeline-segments', 'timeline-playhead',
    'handle-start', 'handle-end',
    'timeline-duration', 'range-selection', 'empty-selection-hint',
    'range-start-input', 'range-end-input', 'play-range',
    'split-at-playhead', 'delete-segment', 'reset-edits', 'undo-edit', 'redo-edit',
    'export-format', 'gif-edge', 'gif-fps', 'gif-budget',
    'export-resolution', 'export-quality', 'export-fps', 'export-output-size',
    'result-bar', 'result-name', 'result-kind', 'result-open', 'result-address', 'result-reveal',
    'result-status', 'result-dismiss',
    'cancel-export', 'error-text'
  ])

  // Reasons emitted by the trim controller that represent a USER EDIT and therefore need an
  // autosave. Playback, task progress and project reloads must not write a draft.
  // Reasons emitted by the trim controller that represent a committed USER EDIT and therefore
  // need an autosave. Drag moves are transient until commitEdit() emits 'edit-committed';
  // playback, export progress and project reloads must not write a draft.
  const EDIT_REASONS = new Set([
    'start', 'end', 'reset', 'format', 'gif-fps', 'gif-size',
    'split', 'delete-segment', 'reset-edits', 'boundary', 'junction',
    'edit-committed', 'undo', 'redo'
  ])
  // Autosave debounce. Contract §11: <= 500 ms.
  const SAVE_DEBOUNCE_MS = 400
  // Status polling covers a dropped `record:export-progress` push (contract §9.3 allows a
  // query by taskId/requestId). ~1 s is cheap for one running encode.
  const EXPORT_POLL_MS = 900
  // Range playback sampling, same cadence the preview view used.
  const RANGE_PLAY_POLL_MS = 80
  // If the main process never sends `record-editor:init`, say so instead of rendering a
  // permanently blank project. Long enough for a slow first paint, short enough to notice.
  const INIT_TIMEOUT_MS = 5000
  const RECOVERY_KEYS = Object.freeze({
    'probe-failed': 'recording.editor.recovery.probe-failed',
    interrupted: 'recording.editor.recovery.interrupted',
    'duration-unavailable': 'recording.editor.recovery.duration-unavailable'
  })

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
      metadata = normalizeEditorMetadata(data.metadata || nextProject.media)
      recovery = data.recovery && typeof data.recovery === 'object'
        ? { state: data.recovery.state === 'recoverable' ? 'recoverable' : 'ready', errorCode: typeof data.recovery.errorCode === 'string' ? data.recovery.errorCode : '' }
        : { state: 'ready', errorCode: '' }
      if (typeof data.sourceUrl === 'string' && data.sourceUrl) sourceUrl = data.sourceUrl
      fatalCode = ''
      renameOpen = false
      hideDraftConflict()
      clearError()

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
      render()
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
      const bar = element('export-progress-bar')
      if (!progress) return
      const active = !!snapshot && (snapshot.phase === 'submitting' || snapshot.phase === 'active')
      progress.hidden = !active
      if (!active) {
        progress.setAttribute('aria-valuenow', '0')
        if (bar) bar.style.width = '0'
        return
      }
      const percent = Math.max(0, Math.min(100, Math.round(finite(snapshot.task?.progress) || 0)))
      progress.setAttribute('aria-valuenow', String(percent))
      if (bar) bar.style.width = percent > 0 ? `${percent}%` : '0'
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
      const player = video()
      const duration = state()?.durationMs || 0
      if (!player || !(duration > 0)) return
      const target = Math.max(0, Math.min(Math.round(milliseconds), duration))
      player.currentTime = target / 1000
      if (state()?.playing) controller.reportTime(target, { fromUser: true })
      updatePlayhead()
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
      on(element('export-button'), 'click', () => { runSafely(exportSelection()) })
      on(element('cancel-export'), 'click', () => { runSafely(cancelRunningExport()) })
      on(element('result-open'), 'click', () => runSafely(runResultAction('open')))
      on(element('result-address'), 'click', () => runSafely(runResultAction('copy-path')))
      on(element('result-reveal'), 'click', () => runSafely(runResultAction('reveal')))
      on(element('result-dismiss'), 'click', () => hideResultBar())
      on(element('recovery-retry'), 'click', () => { runSafely(retryRecovery()) })
      on(element('recovery-reveal'), 'click', () => { runSafely(revealSource()) })
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
      on(windowRef, 'pagehide', () => {
        // Contract §11: flush the draft before the window goes away. The IPC promise may not
        // settle after the renderer is destroyed, so this is best-effort by design.
        if (controller && controller.state().draft.dirty) flushDraft()
      })
    }


    function destroy() {
      if (destroyed) return
      destroyed = true
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
      isRecoveryVisible: () => !!element('recovery-banner') && !element('recovery-banner').hidden,
      isDraftConflictVisible: () => !!element('draft-conflict') && !element('draft-conflict').hidden,
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
    taskFromAnswer
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
      if (root.console && typeof root.console.error === 'function') root.console.error('recording editor boot failed', error)
    }
  }

  return moduleApi
})
