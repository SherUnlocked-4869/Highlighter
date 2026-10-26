'use strict'

// Trim preview VIEW for the recording window (feature E3, plan §8.2/§8.3:
// docs/plans/2026-10-25-snow-apps-feature-development-plan.md).
//
// record/trim-controller.js owns the STATE (range, format, GIF budget, task phase). This file
// owns the DOM: it reads the controls, renders the controller's snapshot, drives range playback on
// the preview <video>, and shows the feature-A result bar after a successful export. record.js only
// constructs one view per preview and forwards three events (attach / retranslate / teardown) plus
// the `record:export-progress` push - which is what keeps the recorder's main script from growing
// another three hundred lines of DOM handling.
//
// Why a separate file rather than more code in record.js: the recorder is a window with a big
// existing interaction surface (countdown, compositor, annotations, audio buses). Keeping the trim
// UI in its own module means the E diff is one construction + three calls where the old code lives,
// and the module can be exercised headlessly by a probe script over the real record.html.
//
// Loaded as a classic script by record.html AFTER trim-controller.js; exposes
// `window.recordTrimView.createTrimView`.

;(function initRecordTrimView(root, factory) {
  const controllerModule = typeof module === 'object' && module.exports
    ? require('./trim-controller')
    : root.recordTrimController
  const api = factory(controllerModule)
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.recordTrimView = api
})(typeof globalThis === 'object' ? globalThis : this, (controllerModule) => {
  const {
    GIF_FRAME_RATES,
    formatClock,
    createRecordTrimController,
    errorKey
  } = controllerModule

  // Poll interval for range playback. 80 ms is ~12 samples/s: enough that the pause lands within
  // one source frame of `endMs` at any recorded frame rate, cheap enough to run while encoding.
  const RANGE_PLAY_POLL_MS = 80

  function element(id) {
    return typeof document === 'object' && document ? document.getElementById(id) : null
  }

  function createTrimView({
    api = null,
    translate = (key) => key,
    reportError = () => {},
    clearFeedback = () => {},
    setStatusText = () => {},
    onProgress = () => {},
    onIdle = () => {},
    log = () => {}
  } = {}) {
    if (!api) throw new TypeError('Trim view requires the record API bridge')

    const elements = {
      panel: element('trimPanel'),
      duration: element('trimDuration'),
      selection: element('trimSelection'),
      startRange: element('trimStartRange'),
      endRange: element('trimEndRange'),
      startInput: element('trimStartInput'),
      endInput: element('trimEndInput'),
      playRange: element('trimPlayRange'),
      reset: element('trimReset'),
      format: element('trimFormat'),
      gifEdge: element('trimGifEdge'),
      gifFps: element('trimGifFps'),
      gifMeta: element('trimGifMeta'),
      progress: element('trimProgress'),
      progressBar: element('trimProgressBar'),
      exportButton: element('trimExport'),
      resultBar: element('recordResultBar'),
      resultName: element('recordResultName'),
      resultOpen: element('recordResultOpen'),
      resultCopy: element('recordResultCopy'),
      resultReveal: element('recordResultReveal'),
      resultStatus: element('recordResultStatus'),
      resultDismiss: element('recordResultClose'),
      video: element('preview')
    }

    let controller = null
    let sessionId = ''
    let playTimer = 0
    let receipt = null
    let listenersAttached = false

    // ---------- result bar (feature A contract) ----------

    function setResultStatus(key, isError) {
      if (!elements.resultStatus) return
      elements.resultStatus.textContent = key ? translate(key) : ''
      elements.resultStatus.classList.toggle('hidden', !key)
      elements.resultStatus.classList.toggle('error', isError === true)
    }

    // `receipt` is exactly `{ status:'saved', resultId, fileName, kind }`; a null receipt (a
    // cancelled or failed export) hides the bar and shows nothing, because inventing a success
    // bar for something that was not written is precisely what plan §4.2 forbids.
    function showResultBar(nextReceipt) {
      if (!nextReceipt || nextReceipt.status !== 'saved' ||
          typeof nextReceipt.resultId !== 'string' || !nextReceipt.resultId) {
        receipt = null
        if (elements.resultBar) elements.resultBar.hidden = true
        return false
      }
      receipt = nextReceipt
      if (elements.resultName) {
        elements.resultName.textContent = translate('capture.export-result.saved', {
          fileName: String(nextReceipt.fileName || '')
        })
      }
      setResultStatus('', false)
      if (elements.resultBar) elements.resultBar.hidden = false
      return true
    }

    function hideResultBar() {
      receipt = null
      if (elements.resultBar) elements.resultBar.hidden = true
      setResultStatus('', false)
    }

    async function runResultAction(action) {
      if (!receipt) return { status: 'failed', code: 'result-expired' }
      setResultStatus('capture.export-result.pending', false)
      let result
      try {
        result = await api.exportAction(receipt.resultId, action)
      } catch (error) {
        log('result action failed:', error?.message || error)
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

    // ---------- progress ----------

    function renderProgress(percent) {
      if (!elements.progress || !elements.progressBar) return
      const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
      elements.progress.hidden = false
      elements.progress.setAttribute('aria-valuenow', String(value))
      elements.progressBar.style.width = value > 0 ? `${value}%` : '0'
      onProgress(value)
    }

    function hideProgress() {
      if (elements.progress) {
        elements.progress.hidden = true
        elements.progress.setAttribute('aria-valuenow', '0')
      }
      if (elements.progressBar) elements.progressBar.style.width = '0'
    }

    // ---------- render ----------

    function render() {
      if (!elements.panel) return
      const state = controller ? controller.state() : null
      if (!state) {
        elements.panel.hidden = true
        return
      }
      elements.panel.hidden = false
      const editable = !state.busy
      const totalMs = Math.max(0, state.durationMs)
      const range = state.range
      // Two independent signals for CSS: the format (which GIF-only rows show) and the task state
      // (which drives the indeterminate progress animation). Both are `data-*` so no inline styles
      // are needed and CSP stays as strict as it is now.
      if (typeof document === 'object' && document?.body) {
        document.body.dataset.format = state.format
        if (state.task?.state) document.body.dataset.exportState = state.task.state
        else delete document.body.dataset.exportState
      }

      if (elements.duration) {
        elements.duration.textContent = translate('record.trim.duration', { duration: formatClock(totalMs) })
      }
      if (elements.selection) {
        elements.selection.textContent = translate('record.trim.selection', {
          start: formatClock(range.startMs),
          end: formatClock(range.endMs),
          duration: formatClock(Math.max(0, range.endMs - range.startMs))
        })
      }
      for (const slider of [elements.startRange, elements.endRange]) {
        if (!slider) continue
        slider.max = String(totalMs)
        slider.step = '10'
        slider.disabled = !editable || !totalMs
      }
      if (elements.startRange) elements.startRange.value = String(range.startMs)
      if (elements.endRange) elements.endRange.value = String(range.endMs)
      if (elements.startInput) {
        elements.startInput.value = formatClock(range.startMs)
        elements.startInput.disabled = !editable || !totalMs
      }
      if (elements.endInput) {
        elements.endInput.value = formatClock(range.endMs)
        elements.endInput.disabled = !editable || !totalMs
      }
      if (elements.playRange) {
        elements.playRange.disabled = !editable || !state.canExport
        elements.playRange.textContent = state.playing
          ? translate('record.trim.stop-range')
          : translate('record.trim.play-range')
      }
      if (elements.reset) elements.reset.disabled = !editable || !totalMs
      if (elements.format) {
        elements.format.value = state.format
        elements.format.disabled = !editable
      }
      if (elements.gifEdge) {
        elements.gifEdge.value = String(state.gif.maxEdgePx)
        elements.gifEdge.disabled = !editable
      }
      if (elements.gifFps) {
        elements.gifFps.value = String(state.gif.fps)
        elements.gifFps.disabled = !editable
      }
      if (elements.gifMeta) {
        const budget = state.gifBudget
        elements.gifMeta.textContent = budget.ok
          ? translate('record.trim.gif-frames', { frames: budget.frames })
          : (budget.code ? translate(errorKey(budget.code)) : '')
        elements.gifMeta.classList.toggle('invalid', !budget.ok)
      }
      if (elements.exportButton) {
        // The same button is Export when idle and Cancel while a task runs, so it must stay
        // clickable in BOTH of those states. Disabling it on `!canExport` alone made the only cancel
        // affordance unreachable: `canExport` is false for exactly the `submitting`/`active` phases
        // where `canCancel` becomes true, so the user could start a long encode and then not stop it.
        // Enabled = "this button has an action right now" (export OR cancel), not "export is allowed".
        elements.exportButton.disabled = !state.canExport && !state.canCancel
        elements.exportButton.textContent = state.phase === 'active'
          ? translate(
            state.task?.state === 'publishing'
              ? 'record.trim.finishing'
              : state.task?.state === 'cancelling'
                // A cancel round-trips through the main process (kill the child, clean up the temp
                // file), which takes long enough that leaving the label on "exporting" reads as
                // "my cancel did nothing". Name the state the task is actually in.
                ? 'record.trim.cancelling'
                : 'record.trim.exporting'
          )
          : translate('record.trim.export')
        // While a task runs the same button is the cancel action (the frozen controls make a
        // second export impossible), so its tooltip has to say so.
        elements.exportButton.dataset.action = state.canCancel ? 'cancel' : 'export'
      }

      if (state.phase === 'succeeded') {
        if (state.receipt) showResultBar(state.receipt)
        if (Number.isFinite(state.task?.progress) && state.task.progress >= 100) renderProgress(100)
        setStatusText(translate('record.trim.succeeded'), '')
        hideProgress()
      } else if (state.phase === 'cancelled') {
        setStatusText(translate('record.trim.cancelled'), '')
        hideProgress()
      } else if (state.phase === 'active' || state.phase === 'submitting') {
        const percent = state.task?.progress
        // Plan §8.5: only a published export reports 100%. An encoder that has not reported yet
        // shows the indeterminate bar (value 0 + the CSS animation), never a fake percentage.
        renderProgress(Number.isFinite(percent) && percent > 0 ? percent : 0)
        setStatusText(
          translate(state.task?.state === 'publishing' ? 'record.trim.finishing' : 'record.trim.exporting'),
          ''
        )
      } else {
        hideProgress()
        setStatusText('', '')
      }
      if (state.error) reportError({ i18nKey: errorKey(state.error.code) })
    }

    // ---------- range playback ----------

    function clearPlayTimer() {
      if (!playTimer) return
      clearInterval(playTimer)
      playTimer = 0
    }

    // The controller decides; this only executes. A `seek` decision means the browser landed on a
    // frame before the range (keyframe snapping) and must be moved forward instead of playing the
    // head the user trimmed away.
    function playTick() {
      if (!controller) {
        clearPlayTimer()
        return
      }
      const state = controller.state()
      if (!state.playing) {
        clearPlayTimer()
        return
      }
      const currentMs = Math.round((Number(elements.video?.currentTime) || 0) * 1000)
      const decision = controller.reportTime(currentMs)
      if (decision.action === 'pause') {
        elements.video?.pause?.()
        if (elements.video) elements.video.currentTime = Math.max(0, state.range.endMs) / 1000
        clearPlayTimer()
        render()
        return
      }
      if (decision.action === 'seek' && elements.video) {
        elements.video.currentTime = Math.max(0, decision.toMs) / 1000
      }
    }

    function startRangePlayback() {
      const range = controller?.playRange()
      if (!range || !elements.video) return false
      elements.video.currentTime = Math.max(0, range.startMs) / 1000
      clearPlayTimer()
      playTimer = setInterval(playTick, RANGE_PLAY_POLL_MS)
      const started = elements.video.play?.()
      if (started && typeof started.catch === 'function') started.catch(() => {})
      render()
      return true
    }

    function stopRangePlayback() {
      clearPlayTimer()
      controller?.stopRangePlayback()
      elements.video?.pause?.()
      render()
    }

    // ---------- export actions ----------

    async function exportSelection() {
      if (!controller) return { status: 'failed', code: 'duration-unavailable' }
      const state = controller.state()
      if (state.busy) {
        // A press while a task runs is the cancel action: the control is frozen otherwise, and
        // plan §8.4 needs the cancel reachable from the same place the user pressed export.
        return cancelRunningExport()
      }
      if (state.phase === 'succeeded' || state.phase === 'cancelled') controller.resetAfterExport()
      else if (state.phase === 'failed') controller.prepareRetry()
      hideResultBar()
      clearFeedback()
      const answer = await controller.startExport({
        submit: ({ requestId, request }) => api.exportRecording(sessionId, requestId, request)
      })
      if (answer?.status === 'accepted' && answer.task) controller.applyTask(answer.task)
      render()
      return answer
    }

    async function cancelRunningExport() {
      if (!controller || !controller.state().canCancel) return { ok: false, code: 'publish-in-progress' }
      const answer = await controller.cancelExport({
        cancel: (query) => api.cancelExport(query)
      })
      if (answer?.code === 'publish-in-progress') {
        // The publish point has passed: keep showing the task and say why (plan §8.4). This is a
        // status line, not an error the user caused - styling it red told the user they had done
        // something wrong when they had simply lost a race against a finishing export.
        setResultStatus('record.error.export-publish-in-progress', false)
        return answer
      }
      render()
      return answer
    }

    // Incoming `record:export-progress` push. A task for a different id is ignored by the
    // controller, so a late event from a previous attempt cannot resurrect an old bar.
    function handleTask(task) {
      if (!controller || !task) return false
      const applied = controller.applyTask(task)
      if (applied) render()
      return applied
    }

    // ---------- DOM wiring ----------

    function bind() {
      if (listenersAttached) return
      listenersAttached = true
      elements.startRange?.addEventListener('input', () => {
        controller?.setStart(Number(elements.startRange.value))
        render()
      })
      elements.endRange?.addEventListener('input', () => {
        controller?.setEnd(Number(elements.endRange.value))
        render()
      })
      // `change`, not `input`: a half-typed "00:0" must not be committed as a trim point.
      elements.startInput?.addEventListener('change', () => {
        controller?.setStart(elements.startInput.value)
        render()
      })
      elements.endInput?.addEventListener('change', () => {
        controller?.setEnd(elements.endInput.value)
        render()
      })
      elements.reset?.addEventListener('click', () => {
        controller?.resetRange()
        render()
      })
      elements.format?.addEventListener('change', () => {
        controller?.setFormat(elements.format.value)
        render()
      })
      elements.gifEdge?.addEventListener('change', () => {
        controller?.setGifMaxEdge(Number(elements.gifEdge.value))
        render()
      })
      elements.gifFps?.addEventListener('change', () => {
        controller?.setGifFps(Number(elements.gifFps.value))
        render()
      })
      elements.playRange?.addEventListener('click', () => {
        if (controller?.state().playing) stopRangePlayback()
        else startRangePlayback()
      })
      elements.exportButton?.addEventListener('click', () => {
        exportSelection().catch((error) => reportError(error))
      })
      // Scrubbing during range playback: the playhead is now wherever the user put it and the trim
      // points must NOT follow it (plan §8.2). The controller decides when that ends range mode.
      elements.video?.addEventListener('seeking', () => {
        if (!controller?.state().playing) return
        const positionMs = Math.round((Number(elements.video.currentTime) || 0) * 1000)
        controller.reportTime(positionMs, { fromUser: true })
        render()
      })
      elements.video?.addEventListener('play', () => {
        if (!controller) return
        const state = controller.state()
        if (!state.playing) return
        const positionMs = Math.round((Number(elements.video?.currentTime) || 0) * 1000)
        if (positionMs < state.playing.startMs || positionMs >= state.playing.endMs) {
          controller.stopRangePlayback()
          clearPlayTimer()
          render()
        }
      })
      elements.video?.addEventListener('pause', () => {
        if (!controller?.state().playing) return
        if (controller.state().playing && (Number(elements.video?.currentTime) || 0) * 1000 >= controller.state().playing.endMs) return
        controller.stopRangePlayback()
        clearPlayTimer()
        render()
      })
      elements.resultOpen?.addEventListener('click', () => runResultAction('open'))
      elements.resultCopy?.addEventListener('click', () => runResultAction('copy-path'))
      elements.resultReveal?.addEventListener('click', () => runResultAction('reveal'))
      elements.resultDismiss?.addEventListener('click', () => hideResultBar())
    }

    // ---------- lifecycle ----------

    // Probe the sealed source and build the controller on the REAL metadata. Returns true when the
    // trim UI is usable. A probe failure keeps the panel visible with an explanation and export
    // disabled: exporting a guessed span is exactly what plan §8.1 forbids.
    async function attach(session, estimatedDurationMs = null) {
      bind()
      sessionId = String(session?.id || '')
      receipt = null
      hideResultBar()
      hideProgress()
      let probed
      try {
        probed = await api.probeSession(sessionId, estimatedDurationMs)
      } catch (error) {
        // A thrown probe (rather than an ok:false) used to escape as an unhandled rejection from
        // stopRecording, leaving the panel blank with no explanation. Name it in the log first.
        log('attach: probeSession threw:', error && error.message ? error.message : String(error))
        throw error
      }
      if (!probed?.ok) {
        // One line, once per failed attach: the probe is the single reason the whole trim/export
        // feature is unavailable, so its code must be recoverable from a user's log dump.
        log('attach: probe failed:', probed?.code || 'probe-failed')
      }
      if (!probed?.ok) {
        controller = null
        if (elements.panel) elements.panel.hidden = false
        for (const control of [
          elements.startRange, elements.endRange, elements.startInput, elements.endInput,
          elements.playRange, elements.reset, elements.format, elements.gifEdge,
          elements.gifFps, elements.exportButton
        ]) {
          if (control) control.disabled = true
        }
        reportError({ i18nKey: errorKey(probed?.code || 'probe-failed') })
        return false
      }
      controller = createRecordTrimController({
        sessionId,
        metadata: probed.metadata,
        translate,
        render: { onChange: () => render() },
        log
      })
      clearFeedback()
      render()
      if (elements.selection) elements.selection.title = translate('record.trim.ready')
      return true
    }

    // Language switch: the controller stores keys/values, so one render re-resolves every string
    // (the same rule the audio notice and status label follow).
    function retranslate() {
      render()
      if (receipt) showResultBar(receipt)
    }

    function teardown() {
      clearPlayTimer()
      hideProgress()
      hideResultBar()
      controller = null
      sessionId = ''
      if (elements.panel) elements.panel.hidden = true
      if (typeof document === 'object' && document?.body) {
        delete document.body.dataset.format
        delete document.body.dataset.exportState
      }
      onIdle()
    }

    // The duration the header should display: the probed value when the probe succeeded (it is
    // the file's real length), otherwise the renderer's own estimate as a fallback, clearly the
    // second-best source (plan §8.1 "renderer duration is a UI initial value only").
    function displayDuration(fallbackMs) {
      const probed = controller?.state().durationMs
      if (Number.isFinite(probed) && probed > 0) return formatClock(probed)
      return formatClock(fallbackMs)
    }

    return {
      attach,
      retranslate,
      teardown,
      handleTask,
      displayDuration,
      // Test/debug surface (the runtime probe and the node tests use these).
      exportSelection,
      cancelRunningExport,
      startRangePlayback,
      stopRangePlayback,
      showResultBar,
      hideResultBar,
      runResultAction,
      getController: () => controller,
      getReceipt: () => (receipt ? { ...receipt } : null),
      elements,
      isPanelVisible: () => !!elements.panel && !elements.panel.hidden
    }
  }

  return {
    GIF_FRAME_RATES,
    RANGE_PLAY_POLL_MS,
    createTrimView
  }
})
