const {
  calculateCropRect,
  classifyChunkAck,
  createCommandDispatcher,
  createFramePacer,
  createRequestId,
  formatDuration,
  localStateForWireStatus,
  readDirectTrackExperiment,
  reportStatusFor,
  resolveRecordInit,
  selectRecorderTrackPlan,
  shouldAdoptMainState,
  shouldBypassComposition,
  transitionRecordingState
} = window.recordingUtils
const {
  ANNOTATION_COLORS,
  ANNOTATION_WIDTHS,
  clearAnnotationSnapshot,
  drawAnnotationSnapshot,
  sanitizeAnnotationSnapshot
} = window.annotationUtils
// Frozen capture-quality table (shared/recording-quality.js, contract §4). The
// renderer never hard-codes bitrate numbers; the module owns the mapping.
const recordingQuality = window.recordingQuality
// C01: the append-queue policy (record/chunk-backpressure.js). Pure and deterministic;
// this file owns the MediaRecorder side effects (pause/resume) it asks for.
const { createChunkBackpressurePolicy } = window.chunkBackpressure

const controlView = document.getElementById('controlView')
const timeElement = document.getElementById('time')
const statusLabel = document.getElementById('statusLabel')
const windowTitleElement = document.getElementById('windowTitle')
const fpsElement = document.getElementById('fps')
const countdownElement = document.getElementById('countdown')
const startButton = document.getElementById('start')
const pauseButton = document.getElementById('pause')
const stopButton = document.getElementById('stop')
const cancelButton = document.getElementById('cancel')
const closeBarButton = document.getElementById('closeBar')
const moreToggleButton = document.getElementById('moreToggle')
const morePanel = document.getElementById('morePanel')
const moreBackButton = document.getElementById('moreBack')
const abandonButton = document.getElementById('abandon')
const discardConfirm = document.getElementById('discardConfirm')
const discardConfirmYes = document.getElementById('discardConfirmYes')
const discardConfirmNo = document.getElementById('discardConfirmNo')
const micMuteButton = document.getElementById('micMute')
const volumeGroup = document.getElementById('volumeGroup')
const volumeMicRow = document.getElementById('volumeMicRow')
const volumeSystem = document.getElementById('volumeSystem')
const volumeMic = document.getElementById('volumeMic')
const errorElement = document.getElementById('recordError')
const saveProgressElement = document.getElementById('saveProgress')
const annotationToolsElement = document.getElementById('annotationTools')
const annotationStyleButton = document.getElementById('annotationStyle')
const annotationPalette = document.getElementById('annotationPalette')
const annotationSwatch = document.getElementById('annotationSwatch')
const annotationWidthMark = document.getElementById('annotationWidthMark')
const annotationUndoButton = document.getElementById('annotationUndo')
const annotationClearButton = document.getElementById('annotationClear')
// B04: the sound-check overlay inside the bar (see the preflight section below).
const preflightButton = document.getElementById('preflight')
const preflightPanel = document.getElementById('preflightPanel')
const preflightAudioElement = document.getElementById('preflightAudio')
const preflightNoteElement = document.getElementById('preflightNote')
const preflightSystemBar = document.getElementById('preflightSystemBar')
const preflightSystemText = document.getElementById('preflightSystemText')
const preflightMicBar = document.getElementById('preflightMicBar')
const preflightMicText = document.getElementById('preflightMicText')
const preflightRetryButton = document.getElementById('preflightRetry')
const preflightCloseButton = document.getElementById('preflightClose')
const preflightSystemOnlyButton = document.getElementById('preflightSystemOnly')
const preflightSilentButton = document.getElementById('preflightSilent')
const preflightMicOnlyButton = document.getElementById('preflightMicOnly')
const annotationToolButtons = [...document.querySelectorAll('[data-annotation-tool]')]
const annotationColorButtons = [...document.querySelectorAll('[data-annotation-color]')]
const annotationWidthButtons = [...document.querySelectorAll('[data-annotation-width]')]

// P0-1-T5 (S12): `shared/i18n.js` is a classic script, so its `t`, `setLanguage`
// and `applyTranslations` bindings are already visible here. They must NOT be
// re-declared (destructuring them from `window` throws "Identifier 't' has
// already been declared", because the runtime's top-level `const`s share this
// script's global lexical scope).

// Degradations are collected as keys (record/audio-mixer.js has no language of
// its own) and only turned into a sentence by renderStatus(). A warning is a
// `record.audio.warning.*` key plus an optional raw detail; nothing here calls
// `t()`, so the descriptor can be stored and re-resolved on a language change.
function audioWarningKey(warning) {
  if (!warning) return null
  const key = typeof warning === 'string' ? warning : warning.code
  if (!key) return null
  const detail = typeof warning === 'string' ? '' : warning.detail
  return { key, params: detail ? { detail } : null }
}

let initData = null
let frameRate = 24
let quality = 'standard'
let countdownSeconds = 3
let state = 'idle'
let busy = false
let moreOpen = false
let desktopStream = null
let canvasStream = null
// C05 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the opt-in
// direct-track experiment records the source video track instead of compositing it.
// `directTrackDecision` is made ONCE before the take starts and never re-wired;
// `recorderStream` is what MediaRecorder receives on that path (null keeps the
// canvas capture stream, exactly as before).
let recorderStream = null
let directTrackDecision = null
let directTrackSourceWatched = false
// Audio bus state (P0-3). `audioRequest` mirrors the frozen record contract:
// system sound defaults to on, the microphone defaults to off (privacy first).
let audioRequest = { system: true, microphone: false, microphoneDeviceId: '', systemGain: 1, microphoneGain: 1 }
let audioOutcome = { system: false, microphone: false }
let audioMix = null
let micStream = null
let audioMixerPromise = null
let audioWarnings = []
let microphoneMuted = false
let micLevel = 0
// The audio degradation notice is stored as a key plus optional params, not as a
// sentence: renderStatus() resolves it in the active language, so a language
// switch no longer leaves the notice in the language it was captured in.
let audioNoticeKey = ''
let audioNoticeParams = null
let failureNotice = null
let audioBitsPerSecond = 160_000
let sourceVideo = null
let canvas = null
let framePacer = createFramePacer(frameRate)
let videoFrameRequest = 0
let fallbackFrameTimer = 0
let manualFrameTimer = 0
let compositorActive = false
let compositorActiveStartedAt = 0
let compositorActiveDurationMs = 0
let compositorScheduler = 'timer'
let recorder = null
let sessionId = ''
let projectId = ''
let appendQueue = Promise.resolve()
let appendError = null
let chunkSequence = 0
let lastAckedSequence = 0
let committedBytes = 0
let chunkFailureAcknowledged = false
// C01: bounds the serial append queue by bytes and by fragmentation age.
const chunkPolicy = createChunkBackpressurePolicy()
let chunkAckTimer = 0
let backpressurePausedAt = 0
// C01: the finish/abandon entries share one finalize. `sealing` stops accepting new
// fragments the moment a finalize or an abandon starts, and `takeGeneration` isolates an
// ACK that arrives after the take was sealed (it must never be credited to the next one).
let sealing = false
let finalizePromise = null
let takeGeneration = 0
let startedAt = 0
let pausedAt = 0
let pausedTotal = 0
// R5 §2.2 event-track clock: wall clock of MediaRecorder.start() and the wall-clock pause spans.
// The main process maps the pointer track's wall timestamps to media time with these, so paused
// time can never be counted as recorded media time.
let mediaStartedAtWall = 0
let pausedIntervals = []
let pauseStartedAtWall = 0
let clockTimer = 0
let countdownVersion = 0
let stateVersion = 0
// Set while adopting a state main already knows about: setState must not report it back.
let suppressStateReport = false
let annotationTool = 'pointer'
let annotationColor = '#ff3b30'
let annotationWidth = 4
let annotationSnapshot = clearAnnotationSnapshot()
let annotationResetVersion = 0
// E2E-only synthetic capture harness (contract §13.5). Real captures never touch it.
let fakeCapture = false
const fakeCaptureStops = []
const fakeAudioNodes = []
// R4 window mode (contract §2.2/§2.4). `captureMode` is 'window' only when the main
// process bound the display-media handler to a window source; display/region keep the
// existing screen-crop path. `windowPixelSize` is the FROZEN output canvas size - the
// captured window may be moved/resized afterwards, the encoding size never changes.
let captureMode = 'display'
let windowCaptureTitle = ''
let windowPixelSize = null
let annotationAllowed = true
// B04: per-take sound check. `preflight` is the pure state machine from
// shared/audio-preflight.js; the streams/context below are its device half and are
// released by releasePreflightDevices() on every exit path.
const audioPreflightModule = window.audioPreflight || null
let preflight = audioPreflightModule ? audioPreflightModule.createPreflight() : null
let preflightPanelOpen = false
let preflightSystemStream = null
let preflightMicStream = null
let preflightContext = null
let preflightAnalysers = null
let preflightSamples = null
let preflightTimer = 0
let preflightAppliedKey = ''
// B04 (plan item 13): every check is a RUN with its own token. The token is what refuses a
// device that is granted after the deadline (or after a cancel): the stream is stopped on
// arrival instead of being held by a check nobody is watching. The ledger also releases the
// previous run's devices when a re-check starts, so one window never holds two checks.
const preflightResources = audioPreflightModule && typeof audioPreflightModule.createPreflightResources === 'function'
  ? audioPreflightModule.createPreflightResources()
  : null
let preflightRun = 0
// Only Windows exposes the system mix through Electron's loopback audio; main
// reports the same condition it uses in the display-media handler.
let preflightLoopback = true
let watchedVideoTrack = null
let sourceLostHandled = false
let sourceHiddenWarning = false

// P0-1-T5 (S12): the table holds i18n keys, not sentences, so a language switch
// re-renders the current state without restarting the recording.
const STATUS_LABELS = {
  idle: 'record.status.idle',
  preparing: 'record.status.preparing',
  countdown: 'record.status.countdown',
  recording: 'record.status.recording',
  paused: 'record.status.paused',
  finalizing: 'record.status.finalizing',
  finished: 'record.status.finished',
  stopped: 'record.status.stopped'
}
// Window captures are not "area ready": the bar names the target window instead.
const WINDOW_IDLE_STATUS = 'record.status.window-idle'

function elapsedTime() {
  if (!startedAt) return 0
  const activePause = pausedAt ? Date.now() - pausedAt : 0
  // C01: a backpressure pause is a real gap in the media timeline, so the clock must not
  // advance through it either - otherwise the timer and the finished video disagree.
  const activeBackpressure = backpressurePausedAt ? Date.now() - backpressurePausedAt : 0
  return Math.max(0, Date.now() - startedAt - pausedTotal - activePause - activeBackpressure)
}

// R5 §2.2 pause spans: every path that stops/starts the MediaRecorder timeline (button, adopted
// tray command, chunk failure) keeps the wall-clock span in sync, so the event-track mapping can
// exclude paused time regardless of how the take was paused.
function openPauseSpan(at = Date.now()) {
  if (!pauseStartedAtWall) pauseStartedAtWall = at
}

function closePauseSpan(at = Date.now()) {
  if (!pauseStartedAtWall) return
  pausedIntervals.push({ startWall: pauseStartedAtWall, endWall: at })
  pauseStartedAtWall = 0
}

// The frozen finish-session timing payload (contract §2.2). A take finished while paused closes its
// open span here: the media timeline never advances during a pause.
function finishTiming() {
  const intervals = pausedIntervals.map((interval) => ({ startWall: interval.startWall, endWall: interval.endWall }))
  if (pauseStartedAtWall) intervals.push({ startWall: pauseStartedAtWall, endWall: Date.now() })
  return { mediaStartedAtWall, pausedIntervals: intervals }
}

function renderClock() {
  timeElement.textContent = formatDuration(elapsedTime())
  if (audioOutcome.microphone && audioMix?.getLevel) {
    micLevel = audioMix.getLevel('microphone')
    micMuteButton.classList.toggle('receiving', !microphoneMuted && micLevel > 0.02)
  }
}

function sameAudioNoticeParams(left, right) {
  const a = left || null
  const b = right || null
  if (!a || !b) return !a && !b
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

// `key` is an i18n key ('' clears the notice) and `params` its interpolation
// values; the sentence itself is only ever built by renderStatus().
function setAudioNotice(key, params = null) {
  const nextKey = String(key || '')
  const nextParams = nextKey ? (params || null) : null
  if (nextKey === audioNoticeKey && sameAudioNoticeParams(audioNoticeParams, nextParams)) return
  audioNoticeKey = nextKey
  audioNoticeParams = nextParams
  renderStatus()
}

function setFailureNotice(key, params = null) {
  const nextKey = String(key || '')
  failureNotice = nextKey ? { key: nextKey, params: params || null } : null
  renderStatus()
}

function noteAudioWarning(warning) {
  if (warning) audioWarnings.push(warning)
}

// The audio degradation notice (microphone lost, no microphone, silent recording ...) is
// appended to whatever the state label shows, so it stays visible while recording. A
// write/finish failure takes precedence over the degradation notice.
function renderStatus() {
  statusLabel.removeAttribute('title')
  const key = captureMode === 'window' && state === 'idle' ? WINDOW_IDLE_STATUS : STATUS_LABELS[state]
  if (!key) return
  const label = t(key)
  const notice = failureNotice
    ? t(failureNotice.key, failureNotice.params)
    : (audioNoticeKey ? t(audioNoticeKey, audioNoticeParams) : '')
  statusLabel.textContent = notice ? `${label} · ${notice}` : label
  if (notice) statusLabel.title = notice
}

// Window mode names the captured window in the status area (truncated by CSS); the full
// title stays available as the tooltip / accessible label.
function renderWindowTitle() {
  const visible = captureMode === 'window' && windowCaptureTitle !== ''
  windowTitleElement.hidden = !visible
  if (!visible) {
    windowTitleElement.textContent = ''
    windowTitleElement.removeAttribute('title')
    windowTitleElement.removeAttribute('aria-label')
    return
  }
  const label = t('record.window.target-label', { title: windowCaptureTitle })
  windowTitleElement.textContent = windowCaptureTitle
  windowTitleElement.title = label
  windowTitleElement.setAttribute('aria-label', label)
}

function describeError(error) {
  if (error?.i18nKey) return t(error.i18nKey, error.i18nParams)
  // recording-utils.js reports failures as keys plus data so it can run headless.
  const key = error?.i18nParams ? error.message : ''
  if (key) return t(key, error.i18nParams)
  return error?.message || String(error || t('record.error.record-failed'))
}

function reportError(error) {
  const message = describeError(error)
  errorElement.textContent = message
  statusLabel.textContent = message
  statusLabel.title = message
}

function clearFeedback() {
  errorElement.textContent = ''
  saveProgressElement.textContent = ''
  failureNotice = null
  renderStatus()
}

function snapshotState() {
  return {
    status: reportStatusFor(state),
    elapsedMs: Math.round(elapsedTime()),
    microphoneMuted,
    stateVersion
  }
}

function reportState() {
  const status = reportStatusFor(state)
  if (!status) return
  stateVersion += 1
  window.recordAPI.reportState({
    sessionId,
    status,
    elapsedMs: Math.round(elapsedTime()),
    microphoneMuted,
    stateVersion
  })
}

// The annotation frame window only exists in display/region mode (contract §2.2), so frame
// state IPC is skipped entirely for window captures instead of failing against a missing window.
function setFrameState(frameState) {
  if (captureMode === 'window') return Promise.resolve(true)
  return window.recordAPI.setFrameState(frameState).catch(() => {})
}

function setBusy(value) {
  busy = !!value
  renderControls()
}

function annotationEnabled() {
  return !busy && ['recording', 'paused'].includes(state) && moreOpen
}

function renderAnnotationControls() {
  // R4: window captures have no frame overlay window, so the entrance is not shown and
  // no annotation command is ever sent (main sets annotation:false in that mode).
  annotationToolsElement.hidden = !annotationAllowed
  if (!annotationAllowed) {
    annotationPalette.hidden = true
    return
  }
  const enabled = annotationEnabled()
  annotationToolButtons.forEach((button) => {
    button.disabled = !enabled
    button.classList.toggle('active', button.dataset.annotationTool === annotationTool)
  })
  annotationStyleButton.disabled = !enabled
  annotationUndoButton.disabled = !enabled || annotationSnapshot.annotations.length === 0
  annotationClearButton.disabled = !enabled || annotationSnapshot.annotations.length === 0
  annotationSwatch.style.background = annotationColor
  annotationWidthMark.textContent = String(annotationWidth)
  annotationColorButtons.forEach((button) => button.classList.toggle('active', button.dataset.annotationColor === annotationColor))
  annotationWidthButtons.forEach((button) => button.classList.toggle('active', Number(button.dataset.annotationWidth) === annotationWidth))
  if (!enabled) annotationPalette.hidden = true
}

function microphoneCaptured() {
  return audioOutcome.microphone === true
}

function renderMicState() {
  const captured = microphoneCaptured()
  const muteKey = microphoneMuted ? 'record.control.mic-unmute' : 'record.control.mic-mute'
  micMuteButton.hidden = !captured
  micMuteButton.setAttribute('aria-pressed', microphoneMuted ? 'true' : 'false')
  micMuteButton.title = t(muteKey)
  micMuteButton.setAttribute('aria-label', t(muteKey))
  micMuteButton.classList.toggle('receiving', captured && !microphoneMuted && micLevel > 0.02)
  if (audioMix?.active) {
    volumeSystem.value = String(audioMix.getBusGain('system'))
    volumeMic.value = String(audioMix.getBusGain('microphone'))
  }
  volumeMicRow.hidden = !captured
  volumeGroup.hidden = !captured && audioOutcome.system !== true
}

function renderControls() {
  const recordingLike = ['recording', 'paused'].includes(state)
  document.body.dataset.mode = captureMode
  document.body.dataset.annotation = annotationAllowed ? 'on' : 'off'
  renderWindowTitle()
  startButton.hidden = state !== 'idle'
  closeBarButton.hidden = state !== 'idle'
  pauseButton.hidden = !recordingLike
  pauseButton.textContent = t(state === 'paused' ? 'record.control.resume' : 'record.control.pause')
  stopButton.hidden = !(recordingLike || state === 'stopped')
  stopButton.textContent = t(state === 'stopped' ? 'record.control.retry-finish' : 'record.control.finish')
  cancelButton.hidden = !['preparing', 'countdown'].includes(state)
  countdownElement.hidden = state !== 'countdown'
  moreToggleButton.hidden = !(recordingLike || state === 'stopped')
  morePanel.hidden = !moreOpen || moreToggleButton.hidden
  moreToggleButton.setAttribute('aria-expanded', moreOpen ? 'true' : 'false')
  document.body.dataset.more = moreOpen ? 'true' : 'false'
  startButton.disabled = busy
  pauseButton.disabled = busy
  stopButton.disabled = busy
  // Cancelling a preparation/countdown is always allowed; it discards nothing yet.
  cancelButton.disabled = busy && !['preparing', 'countdown'].includes(state)
  moreToggleButton.disabled = busy
  closeBarButton.disabled = busy
  moreBackButton.disabled = busy
  abandonButton.disabled = busy || !sessionId
  discardConfirmYes.disabled = busy
  discardConfirmNo.disabled = busy
  renderMicState()
  renderAnnotationControls()
  // A take in progress has no "before start" surface: close and release the check.
  if (state !== 'idle' && preflightPanelOpen) cancelAudioPreflight()
  renderPreflight()
}

function setState(nextState) {
  state = nextState
  document.body.dataset.state = state
  if (!['recording', 'paused', 'stopped'].includes(state)) closeMorePanel()
  renderControls()
  renderStatus()
  // An adopted main-process state is already reflected there; echoing it back would bump
  // the local version and could ping-pong the version guard.
  if (!suppressStateReport) reportState()
}

// ---------------------------------------------------------------------------
// Main-process state reconciliation (contract §9.2)
//
// The bar is the command source, but main owns the command registry and the tray label.
// A lost command push / state push must not leave the two sides disagreeing:
//   * boot pull (record:get-state) restores the bar when it is idle but main still holds
//     a capture (e.g. the renderer was reloaded mid-recording);
//   * record:state-changed echoes a command's POST state, so a lost pause/resume push is
//     applied locally too (the recorder is really paused/resumed, not just the label).
// Both go through the version guard in recording-utils.js: stale / equal / mid-transition
// states are ignored, and adoption never reports a state back.
// ---------------------------------------------------------------------------
function adoptMainState(mainState, options = {}) {
  if (!shouldAdoptMainState({
    mainState,
    localState: state,
    localStateVersion: stateVersion,
    busy,
    reconciliation: options.reconciliation === true
  })) return false
  const nextState = localStateForWireStatus(mainState.status)
  if (!nextState) return false
  const nextVersion = Math.round(Number(mainState.stateVersion))
  const nextElapsed = Math.max(0, Math.round(Number(mainState.elapsedMs) || 0))
  // A lost pause/resume command is repaired for real, not only visually.
  if (nextState === 'paused' && recorder?.state === 'recording') {
    try { recorder.pause() } catch {}
    stopCompositeLoop()
    openPauseSpan()
  } else if (nextState === 'recording' && recorder?.state === 'paused') {
    try { recorder.resume() } catch {}
    startCompositeLoop()
    closePauseSpan()
  }
  // Baseline the clock on main's elapsed time so a reconciled bar shows the real duration.
  startedAt = Date.now() - nextElapsed
  pausedTotal = 0
  pausedAt = nextState === 'paused' ? Date.now() : 0
  stateVersion = nextVersion
  microphoneMuted = mainState.microphoneMuted === true
  audioMix?.setMicrophoneMuted?.(microphoneMuted)
  clearInterval(clockTimer)
  if (nextState === 'recording') clockTimer = setInterval(renderClock, 250)
  suppressStateReport = true
  try {
    setState(nextState)
  } finally {
    suppressStateReport = false
  }
  renderClock()
  return true
}

let reconcileAttempted = false

async function reconcileStateFromMain() {
  if (reconcileAttempted) return
  reconcileAttempted = true
  if (typeof window.recordAPI.getState !== 'function') return
  try {
    const mainState = await window.recordAPI.getState()
    adoptMainState(mainState, { reconciliation: true })
  } catch {
    // A failed pull is not fatal: the bar keeps working from its local state.
  }
}

function openMorePanel() {
  if (moreOpen || !['recording', 'paused', 'stopped'].includes(state)) return
  moreOpen = true
  discardConfirm.hidden = true
  renderControls()
}

function closeMorePanel() {
  moreOpen = false
  discardConfirm.hidden = true
  if (annotationPalette) annotationPalette.hidden = true
  renderControls()
}

function toggleMorePanel() {
  if (moreOpen) closeMorePanel()
  else openMorePanel()
}

function sendAnnotationCommand(action = '') {
  if (!annotationAllowed) return Promise.resolve(true)
  return window.recordAPI.setAnnotationCommand({
    tool: annotationTool,
    color: annotationColor,
    width: annotationWidth,
    action,
    resetVersion: annotationResetVersion
  })
}

async function resetAnnotations() {
  annotationSnapshot = clearAnnotationSnapshot()
  annotationTool = 'pointer'
  annotationResetVersion++
  renderAnnotationControls()
  if (!annotationAllowed) return
  await sendAnnotationCommand('reset')
}

function stopSource() {
  unwatchSourceTracks()
  unwatchDirectTrackSource()
  disposeFakeCapture()
  stopCompositeLoop()
  reportCompositorPerformance()
  if (audioMix) {
    audioMix.dispose()
    audioMix = null
  }
  micStream?.getTracks().forEach((track) => track.stop())
  micStream = null
  canvasStream?.getTracks().forEach((track) => track.stop())
  recorderStream?.getTracks().forEach((track) => track.stop())
  desktopStream?.getTracks().forEach((track) => track.stop())
  if (sourceVideo) sourceVideo.srcObject = null
  canvasStream = null
  recorderStream = null
  directTrackDecision = null
  desktopStream = null
  sourceVideo = null
  canvas = null
}

function disposeFakeCapture() {
  for (const stop of fakeCaptureStops.splice(0)) {
    try { stop() } catch {}
  }
  for (const node of fakeAudioNodes.splice(0)) {
    try { node.oscillator.stop() } catch {}
    try { node.context.close?.() } catch {}
  }
}

// ---------------------------------------------------------------------------
// R4 window mode: frozen canvas + contain fit, target invalidation (contract §2.2/§2.4)
// ---------------------------------------------------------------------------

// Pure 'contain' fit: scale the captured frame into the frozen canvas without changing the
// aspect ratio and centre it, leaving black bars on the two spare sides. Integer output keeps
// the canvas dimensions/edges exact; the compositor fills the canvas black first.
function fitContainRect(frameWidth, frameHeight, canvasWidth, canvasHeight) {
  const frameW = Math.max(1, Math.round(Number(frameWidth) || 0))
  const frameH = Math.max(1, Math.round(Number(frameHeight) || 0))
  const canvasW = Math.max(1, Math.round(Number(canvasWidth) || 0))
  const canvasH = Math.max(1, Math.round(Number(canvasHeight) || 0))
  const scale = Math.min(canvasW / frameW, canvasH / frameH)
  const width = Math.max(1, Math.min(canvasW, Math.round(frameW * scale)))
  const height = Math.max(1, Math.min(canvasH, Math.round(frameH * scale)))
  return {
    x: Math.round((canvasW - width) / 2),
    y: Math.round((canvasH - height) / 2),
    width,
    height,
    scale
  }
}

// Frozen window-mode output size: init.window.pixelSize is authoritative, with the control
// bar's display pixel size and 1280x720 as defensive fallbacks (contract §2.2).
function normalizeWindowPixelSize(size) {
  const width = Math.max(0, Math.round(Number(size?.width) || 0))
  const height = Math.max(0, Math.round(Number(size?.height) || 0))
  if (width >= 2 && height >= 2) return { width, height }
  const fallback = initData?.display?.pixelSize
  if (fallback?.width >= 2 && fallback?.height >= 2) {
    return { width: Math.round(fallback.width), height: Math.round(fallback.height) }
  }
  return { width: 1280, height: 720 }
}

// Aspect stage used by annotation snapshots: display mode keeps the DIP selection space
// (the frame overlay draws in DIP), window mode uses the frozen canvas pixels.
function annotationStageSize() {
  if (captureMode === 'window') {
    return { width: canvas?.width || 1, height: canvas?.height || 1 }
  }
  return {
    width: initData?.selectionBounds?.width || 1,
    height: initData?.selectionBounds?.height || 1
  }
}

function addTrackListener(track, type, handler) {
  try { track.addEventListener(type, handler) } catch {}
}

function watchSourceTracks() {
  unwatchSourceTracks()
  if (captureMode !== 'window') return
  const track = desktopStream?.getVideoTracks?.()[0]
  if (!track) return
  watchedVideoTrack = track
  // The main process polls the window source as well; a track that ends here means no more
  // frames will arrive, which is the same invalidation from the renderer's point of view.
  addTrackListener(track, 'ended', handleVideoTrackEnded)
  addTrackListener(track, 'mute', handleVideoTrackMute)
  addTrackListener(track, 'unmute', handleVideoTrackUnmute)
}

function unwatchSourceTracks() {
  if (!watchedVideoTrack) return
  try {
    watchedVideoTrack.removeEventListener('ended', handleVideoTrackEnded)
    watchedVideoTrack.removeEventListener('mute', handleVideoTrackMute)
    watchedVideoTrack.removeEventListener('unmute', handleVideoTrackUnmute)
  } catch {}
  watchedVideoTrack = null
}

function handleVideoTrackEnded() {
  handleSourceLost({ reason: 'closed' })
}

// Minimized / occluded windows make Chromium mute the captured track (best effort, contract
// §2.2/§7.2). Pause the take and surface the warning; unmuting only clears the warning - the
// user decides when to resume.
function handleVideoTrackMute() {
  if (captureMode !== 'window') return
  if (state === 'recording') pauseRecording()
  if (['recording', 'paused', 'preparing', 'countdown'].includes(state)) {
    sourceHiddenWarning = true
    setFailureNotice('record.warning.source-hidden')
    errorElement.textContent = t('record.warning.source-hidden')
  }
}

function handleVideoTrackUnmute() {
  if (captureMode !== 'window' || !sourceHiddenWarning) return
  sourceHiddenWarning = false
  if (failureNotice?.key === 'record.warning.source-hidden') setFailureNotice('')
  if (errorElement.textContent === t('record.warning.source-hidden')) errorElement.textContent = ''
}

// Target invalidation: keep what was captured. While a take is live this is the normal
// finish path (flush every pending chunk, then let main seal the project); during
// preparation/countdown there is nothing to keep, so the bar returns to ready.
function handleSourceLost(payload = {}) {
  if (sourceLostHandled) return
  const reason = typeof payload?.reason === 'string' && payload.reason ? payload.reason : 'closed'
  if (['recording', 'paused'].includes(state) && sessionId) {
    sourceLostHandled = true
    setFailureNotice('record.warning.source-lost')
    finishRecording().catch((error) => reportError(error))
    return
  }
  if (['preparing', 'countdown'].includes(state)) {
    sourceLostHandled = true
    abortPreparingSource()
    return
  }
  sourceLostHandled = true
  if (reason) {
    setFailureNotice('record.warning.source-lost')
    errorElement.textContent = t('record.warning.source-lost')
  }
}

async function abortPreparingSource() {
  countdownVersion += 1
  clearInterval(clockTimer)
  try {
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  } catch {}
  recorder = null
  stopSource()
  setBusy(false)
  setState('idle')
  setFailureNotice('record.warning.source-lost')
  errorElement.textContent = t('record.warning.source-lost')
  await setFrameState('idle')
}

function renderCompositeFrame(timestamp = performance.now(), force = false) {
  if (!canvas || !sourceVideo || !framePacer.shouldDraw(timestamp, force)) return false
  const context = canvas._recordContext
  if (canvas._recordFit) {
    // Window mode: frozen output canvas, frame letter-boxed ('contain') into it.
    const fit = canvas._recordFit
    context.fillStyle = '#000000'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(
      sourceVideo,
      0, 0, sourceVideo.videoWidth, sourceVideo.videoHeight,
      fit.x, fit.y, fit.width, fit.height
    )
  } else {
    const crop = canvas._recordCrop
    context.drawImage(sourceVideo, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.width, crop.height)
  }
  if (annotationAllowed) drawAnnotationSnapshot(context, annotationSnapshot, annotationStageSize())
  return true
}

function scheduleCompositeFrame() {
  if (!compositorActive || !sourceVideo) return
  if (typeof sourceVideo.requestVideoFrameCallback === 'function') {
    compositorScheduler = 'video-frame'
    videoFrameRequest = sourceVideo.requestVideoFrameCallback((timestamp) => {
      videoFrameRequest = 0
      if (!compositorActive) return
      renderCompositeFrame(timestamp)
      scheduleCompositeFrame()
    })
    return
  }
  compositorScheduler = 'timer'
  fallbackFrameTimer = setTimeout(() => {
    fallbackFrameTimer = 0
    if (!compositorActive) return
    renderCompositeFrame(performance.now())
    scheduleCompositeFrame()
  }, framePacer.intervalMs)
}

function requestCompositeFrame() {
  if (!compositorActive || manualFrameTimer) return
  const delay = framePacer.delayUntilNext(performance.now())
  manualFrameTimer = setTimeout(() => {
    manualFrameTimer = 0
    if (compositorActive) renderCompositeFrame(performance.now())
  }, delay)
}

function startCompositeLoop() {
  if (compositorActive || !sourceVideo || !canvas) return
  compositorActive = true
  compositorActiveStartedAt = performance.now()
  const hasHistory = compositorActiveDurationMs > 0
  framePacer.reset({ keepStats: hasHistory })
  renderCompositeFrame(compositorActiveStartedAt, true)
  scheduleCompositeFrame()
}

function stopCompositeLoop() {
  if (compositorActiveStartedAt) {
    compositorActiveDurationMs += Math.max(0, performance.now() - compositorActiveStartedAt)
    compositorActiveStartedAt = 0
  }
  compositorActive = false
  if (videoFrameRequest && typeof sourceVideo?.cancelVideoFrameCallback === 'function') {
    sourceVideo.cancelVideoFrameCallback(videoFrameRequest)
  }
  videoFrameRequest = 0
  clearTimeout(fallbackFrameTimer)
  fallbackFrameTimer = 0
  clearTimeout(manualFrameTimer)
  manualFrameTimer = 0
}

function reportCompositorPerformance() {
  const stats = framePacer.snapshot()
  if (!stats.renderedFrames || !compositorActiveDurationMs) return
  window.recordAPI.reportPerformance({
    durationMs: compositorActiveDurationMs,
    targetFrameRate: stats.frameRate,
    callbacks: stats.callbacks,
    renderedFrames: stats.renderedFrames,
    skippedCallbacks: stats.skippedCallbacks,
    scheduler: compositorScheduler
  })
  compositorActiveDurationMs = 0
  framePacer.reset()
}

function waitForMetadata(video) {
  if (video.readyState >= 1 && video.videoWidth && video.videoHeight) return Promise.resolve()
  return new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true })
    video.addEventListener('error', () => reject(new Error(t('record.error.desktop-video-unreadable'))), { once: true })
  })
}

function desktopVideoConstraints() {
  return { frameRate: { ideal: frameRate, max: frameRate } }
}

async function acquireDesktopStream() {
  // R4 window mode (contract §2.4): the main-process display-media handler is bound to the
  // selected WINDOW source, so no display/source-id constraint and no screen crop applies.
  // The same handler still attaches loopback audio when asked (system mix, not window-only
  // audio - the copy must never claim otherwise).
  if (captureMode === 'window') {
    const failures = []
    if (typeof navigator.mediaDevices?.getDisplayMedia === 'function') {
      if (audioRequest.system) {
        try {
          return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      } catch (error) {
        failures.push(error)
      }
    }
    throw failures[0] || new Error(t('record.error.desktop-capture-failed', { detail: '' }))
  }
  const failures = []
  if (typeof navigator.mediaDevices?.getDisplayMedia === 'function') {
    // Electron only grants this through `session.setDisplayMediaRequestHandler`; the source
    // cannot be pinned by deviceId, so the main process selects the display with
    // `pickDesktopSource` (record/recording-utils.js). The handler validates the sender and
    // only offers loopback audio when this call asks for it.
    if (audioRequest.system) {
      try {
        return await navigator.mediaDevices.getDisplayMedia({ video: desktopVideoConstraints(), audio: true })
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: desktopVideoConstraints(), audio: false })
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    // Compatibility fallback for builds whose session has no display-media handler yet: the
    // legacy desktop constraint still returns video. It deliberately never requests audio —
    // that legacy form is the known Windows audio bug (electron#42765 / #25120) this change
    // migrates away from, and the missing system track is reported through the audio notice.
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: initData.sourceId,
          minFrameRate: frameRate,
          maxFrameRate: frameRate
        }
      }
    })
  } catch (error) {
    failures.push(error)
    throw failures[0]
  }
}

// ---------------------------------------------------------------------------
// E2E-only synthetic capture source (contract §13.5)
//
// This host cannot initialise desktop duplication, so the whole capture-to-export
// chain is verified with a synthetic source instead. The branch is DEFAULT OFF:
// only the main process sets `fakeCapture` in record:init, and it does so only
// when its own environment carries HIGHLIGHTER_E2E_FAKE_CAPTURE=1. A renderer
// cannot enable it, and every other code path below (compositing, annotations,
// MediaRecorder, chunk ACK, pause, finish) is byte-for-byte the real one.
// ---------------------------------------------------------------------------
function fakeSourceSize() {
  if (captureMode === 'window' && windowPixelSize) {
    return { width: windowPixelSize.width, height: windowPixelSize.height }
  }
  return {
    width: Math.max(2, Math.round(initData.display?.pixelSize?.width || initData.displayBounds.width || 1280)),
    height: Math.max(2, Math.round(initData.display?.pixelSize?.height || initData.displayBounds.height || 720))
  }
}

function createFakeDesktopStream() {
  const size = fakeSourceSize()
  const width = size.width
  const height = size.height
  const surface = document.createElement('canvas')
  surface.width = width
  surface.height = height
  const context = surface.getContext('2d')
  const palette = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#1687ff', '#af52de']
  const startedAtMs = performance.now()
  const draw = () => {
    const elapsed = performance.now() - startedAtMs
    const barWidth = surface.width / palette.length
    palette.forEach((color, index) => {
      context.fillStyle = color
      context.fillRect(Math.round(index * barWidth), 0, Math.ceil(barWidth), surface.height)
    })
    context.fillStyle = 'rgba(0,0,0,.72)'
    context.fillRect(0, surface.height - 64, surface.width, 64)
    context.fillStyle = '#ffffff'
    context.font = `${Math.max(12, Math.round(surface.height / 18))}px Consolas, monospace`
    context.fillText(`E2E ${(elapsed / 1000).toFixed(2)}s`, 16, surface.height - 24)
    context.fillRect(Math.round((elapsed / 12) % surface.width), Math.round(surface.height / 2), 4, 64)
  }
  draw()
  // A timer rather than requestAnimationFrame: the E2E window may be hidden or
  // occluded, and backgroundThrottling is disabled, so this keeps producing frames.
  const frameTimer = setInterval(draw, Math.max(16, Math.round(1000 / Math.max(1, initData.frameRate))))
  const stream = surface.captureStream(initData.frameRate)
  fakeCaptureStops.push(() => clearInterval(frameTimer))
  return stream
}

function createFakeAudioBus(frequency) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (typeof AudioContextClass !== 'function') return null
  const context = new AudioContextClass()
  const destination = context.createMediaStreamDestination()
  const oscillator = context.createOscillator()
  oscillator.type = 'sine'
  oscillator.frequency.value = frequency
  const gain = context.createGain()
  gain.gain.value = 0.04
  oscillator.connect(gain)
  gain.connect(destination)
  oscillator.start()
  fakeAudioNodes.push({ context, oscillator })
  const track = destination.stream.getAudioTracks()[0]
  return track ? { stream: destination.stream, track } : null
}

function loadAudioMixer() {
  if (window.audioMixer) return Promise.resolve(window.audioMixer)
  if (!audioMixerPromise) {
    audioMixerPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'audio-mixer.js'
      script.onload = () => (window.audioMixer
        ? resolve(window.audioMixer)
        : reject(new Error(t('record.error.audio-mixer-exports-missing'))))
      script.onerror = () => reject(new Error(t('record.error.audio-mixer-unavailable')))
      document.head.appendChild(script)
    }).catch((error) => {
      // A missing mixer degrades to a silent video instead of failing the whole recording.
      noteAudioWarning({ code: 'record.audio.warning.mixer-missing', detail: error?.message || String(error) })
      return null
    })
  }
  return audioMixerPromise
}

function microphoneConstraints(mixer, deviceId) {
  if (mixer && typeof mixer.microphoneConstraints === 'function') return mixer.microphoneConstraints({ deviceId })
  const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
  const trimmed = typeof deviceId === 'string' ? deviceId.trim() : ''
  if (trimmed) constraints.deviceId = { exact: trimmed }
  return constraints
}

async function requestMicrophone(constraints) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((track) => track.stop())
    noteAudioWarning({ code: 'record.audio.warning.microphone-track-missing' })
    return null
  }
  return stream
}

async function acquireMicrophone() {
  const mixer = await loadAudioMixer()
  const deviceId = audioRequest.microphoneDeviceId
  try {
    return await requestMicrophone(microphoneConstraints(mixer, deviceId))
  } catch (error) {
    if (deviceId) {
      // The chosen device disappeared between the workbench and the take. Falling back to
      // the default input is allowed, but it must be visible: never silently record a
      // different microphone than the one the user picked (contract §4.1).
      noteAudioWarning({
        code: 'record.audio.warning.microphone-device-fallback',
        detail: error?.message || String(error)
      })
      try {
        return await requestMicrophone(microphoneConstraints(mixer, ''))
      } catch (fallbackError) {
        noteAudioWarning({
          code: 'record.audio.warning.microphone-capture-failed',
          detail: fallbackError?.message || String(fallbackError)
        })
        return null
      }
    }
    noteAudioWarning({ code: 'record.audio.warning.microphone-capture-failed', detail: error?.message || String(error) })
    return null
  }
}

function renderAudioIndicator() {
  const recorded = []
  if (audioOutcome.system) recorded.push(t('record.audio.source.system'))
  if (audioOutcome.microphone) recorded.push(t('record.audio.source.microphone'))
  fpsElement.title = recorded.length
    ? t('record.audio.contains-detail', { sources: recorded.join(' + ') })
    : t('record.audio.contains-none')
}

function applyAudioOutcome(outcome = {}) {
  audioOutcome = { system: !!outcome.system, microphone: !!outcome.microphone }
  renderAudioIndicator()
  // Both the outcome notice and the collected warnings arrive as i18n keys, so
  // only the key (plus its params) is stored; renderStatus() builds the sentence.
  const notice = outcome.notice ? { key: outcome.notice, params: null } : audioWarningKey(audioWarnings[0])
  setAudioNotice(notice ? notice.key : '', notice ? notice.params : null)
  renderMicState()
}

async function attachAudioTracks() {
  audioWarnings = []
  setAudioNotice('')
  microphoneMuted = false
  // The renderer request is the contract: when system sound is off, drop any loopback track
  // the handler may still have attached so a silent recording really has no audio track.
  if (!audioRequest.system && desktopStream) {
    desktopStream.getAudioTracks().forEach((track) => track.stop())
  }
  if (!audioRequest.system && !audioRequest.microphone) {
    applyAudioOutcome({ system: false, microphone: false, notice: '' })
    return
  }
  let systemCaptured = false
  if (fakeCapture) {
    // E2E-only: feed the existing mixer from oscillators instead of a device.
    if (audioRequest.system) {
      const bus = createFakeAudioBus(440)
      if (bus) {
        desktopStream.addTrack(bus.track)
        systemCaptured = true
      } else {
        noteAudioWarning({ code: 'record.audio.warning.microphone-capture-failed', detail: 'fake system audio' })
      }
    }
    if (audioRequest.microphone) {
      const bus = createFakeAudioBus(660)
      micStream = bus ? bus.stream : null
    }
  } else {
    systemCaptured = audioRequest.system && desktopStream?.getAudioTracks().length > 0
    if (audioRequest.microphone) micStream = await acquireMicrophone()
  }
  const microphoneCaptured = micStream?.getAudioTracks().length > 0
  const mixer = await loadAudioMixer()
  let captured = { system: systemCaptured, microphone: !!microphoneCaptured }
  if (mixer) {
    audioBitsPerSecond = Number(mixer.AUDIO_BITS_PER_SECOND) || audioBitsPerSecond
    audioMix = mixer.createAudioMix({
      AudioContextClass: window.AudioContext || window.webkitAudioContext,
      systemStream: systemCaptured ? desktopStream : null,
      micStream: microphoneCaptured ? micStream : null,
      plan: mixer.createGainPlan({
        systemGain: audioRequest.systemGain,
        micGain: audioRequest.microphoneGain
      }),
      onWarn: noteAudioWarning
    })
    if (audioMix.active) {
      // C05: a direct-track take has no canvas stream yet; its recorder stream is
      // assembled below from the source video track plus these mixed audio tracks.
      if (canvasStream) audioMix.tracks.forEach((track) => canvasStream.addTrack(track))
      await audioMix.resume()
      audioMix.setMicrophoneMuted(microphoneMuted)
    } else {
      captured = { system: false, microphone: false }
    }
    applyAudioOutcome(mixer.describeAudioOutcome({
      systemRequested: audioRequest.system,
      microphoneRequested: audioRequest.microphone,
      systemCaptured: captured.system,
      microphoneCaptured: captured.microphone
    }))
    return
  }
  applyAudioOutcome({ system: false, microphone: false, notice: '' })
}

// ---------------------------------------------------------------------------
// C05: direct-track experiment (opt-in, environment only)
//
// The existing pipeline composites every source frame into a canvas and encodes the
// canvas capture stream. For a full-screen take with no annotations, no transform and
// an output size equal to the source, that canvas is a copy of the source, so the
// source video track can be recorded directly. The experiment is enabled ONLY by
// the direct-track environment switch (main forwards it in record:init); it is not a
// setting and the default decision is always the canvas path. The decision is made
// before MediaRecorder exists and is never revisited mid-take: a take that needs
// composition after all is stopped through the normal finish path, not re-wired.
// ---------------------------------------------------------------------------
function directTrackExperimentEnabled() {
  if (initData && initData.directTrackExperiment === true) return true
  // The packaged control bar is sandboxed (no Node integration), so main forwards
  // the environment switch through record:init. This fallback only covers a harness
  // that loads this page with Node integration for measurement.
  try {
    const environment = typeof globalThis.process === 'object' && globalThis.process
      ? globalThis.process.env
      : null
    return readDirectTrackExperiment(environment)
  } catch {
    return false
  }
}

function directTrackTakeActive() {
  return Boolean(directTrackDecision && directTrackDecision.bypass === true)
}

function recorderInputStream() {
  return recorderStream || canvasStream
}

// Freezes the source frame into the output canvas (display crop or window contain fit).
// This is the pre-C05 sizing block, extracted unchanged: both the normal path and the
// defensive direct-track fallback must produce the identical surface.
function buildOutputCanvas() {
  // Deliberately named `canvas`: this is the pre-C05 inline sizing block moved into
  // one place, and the local binding shadows the module-level output canvas.
  const canvas = document.createElement('canvas')
  if (captureMode === 'window') {
    // R4 window mode (contract §2.2): frozen output size from init.window.pixelSize; the
    // captured frames are letter-boxed into it, so a later window resize cannot change
    // the encoded resolution. Even dimensions keep the H.264/VP9 export path valid.
    const width = Math.max(2, Math.round(windowPixelSize?.width || 0))
    const height = Math.max(2, Math.round(windowPixelSize?.height || 0))
    canvas.width = Math.max(2, width - (width % 2))
    canvas.height = Math.max(2, height - (height % 2))
    canvas._recordFit = fitContainRect(sourceVideo.videoWidth, sourceVideo.videoHeight, canvas.width, canvas.height)
  } else {
    const crop = calculateCropRect(
      { width: sourceVideo.videoWidth, height: sourceVideo.videoHeight },
      initData.displayBounds,
      initData.selectionBounds
    )
    canvas.width = crop.width
    canvas.height = crop.height
    canvas._recordCrop = crop
  }
  canvas._recordContext = canvas.getContext('2d', { alpha: false })
  return canvas
}

// The single eligibility decision: full display, nothing annotated yet, no crop / fit
// transform, output size equals the source size, experiment enabled.
function decideDirectTrackTake(sourceSize) {
  let outputSize = null
  let hasTransform = true
  if (captureMode === 'window') {
    outputSize = normalizeWindowPixelSize(windowPixelSize)
  } else {
    const crop = calculateCropRect(sourceSize, initData.displayBounds, initData.selectionBounds)
    outputSize = { width: crop.width, height: crop.height }
    hasTransform = crop.sx !== 0 || crop.sy !== 0
      || crop.sw !== sourceSize.width || crop.sh !== sourceSize.height
      || crop.width !== sourceSize.width || crop.height !== sourceSize.height
  }
  const decision = shouldBypassComposition({
    mode: captureMode === 'window' ? 'window' : (initData?.mode || 'display'),
    annotationCount: annotationSnapshot.annotations.length,
    hasTransform,
    outputSize,
    sourceSize,
    experimentEnabled: directTrackExperimentEnabled()
  })
  return {
    bypass: decision.bypass === true,
    reason: String(decision.reason || ''),
    sourceWidth: sourceSize.width,
    sourceHeight: sourceSize.height
  }
}

// Builds the MediaRecorder input for the direct path: the source video track plus the
// tracks the existing mixer already produced. The selector reports a fallback reason
// instead of throwing, so the caller can restore the composited surface.
function createDirectRecorderStream(mixedAudioTracks) {
  const plan = selectRecorderTrackPlan({
    bypass: true,
    reason: directTrackDecision?.reason || '',
    canvasStream: null,
    sourceStream: desktopStream,
    mixedAudioTracks,
    createStream: (tracks) => new MediaStream(tracks)
  })
  if (!plan.bypass) {
    directTrackDecision = {
      ...directTrackDecision,
      bypass: false,
      reason: plan.reason || 'source-track-missing'
    }
    return null
  }
  directTrackDecision = { ...directTrackDecision, bypass: true, reason: plan.reason || 'eligible' }
  return plan.stream
}

function watchDirectTrackSource() {
  if (directTrackSourceWatched || !sourceVideo) return
  if (typeof sourceVideo.addEventListener !== 'function') return
  directTrackSourceWatched = true
  sourceVideo.addEventListener('resize', handleDirectTrackSourceResize)
}

function unwatchDirectTrackSource() {
  if (!directTrackSourceWatched) return
  directTrackSourceWatched = false
  if (sourceVideo && typeof sourceVideo.removeEventListener === 'function') {
    sourceVideo.removeEventListener('resize', handleDirectTrackSourceResize)
  }
}

// A direct-track take encodes the source track raster itself, so a source size change
// really would change the output size. The composited path freezes its canvas at start,
// which is why this listener only exists for a bypass take.
function handleDirectTrackSourceResize() {
  if (!directTrackTakeActive() || !sourceVideo) return
  const width = Math.round(Number(sourceVideo.videoWidth) || 0)
  const height = Math.round(Number(sourceVideo.videoHeight) || 0)
  if (width < 2 || height < 2) return
  if (width === directTrackDecision.sourceWidth && height === directTrackDecision.sourceHeight) return
  handleDirectTrackCompositionChange('output-size-changed')
}

// A composition change requested mid-take cannot be honoured without swapping tracks
// underneath MediaRecorder. Stop the take through the normal finish path (the written
// part is kept) and report it through the existing error channel; the reason stays on
// the take so a measurement run can tell this apart from a normal finish.
function handleDirectTrackCompositionChange(reason) {
  if (!directTrackTakeActive()) return false
  directTrackDecision = { ...directTrackDecision, reason }
  setFailureNotice('record.error.record-failed')
  errorElement.textContent = t('record.error.record-failed')
  finishRecording().catch((error) => reportError(error))
  return true
}

async function prepareSource() {
  if (desktopStream && (canvasStream || recorderStream)) return
  try {
    desktopStream = fakeCapture ? createFakeDesktopStream() : await acquireDesktopStream()
    sourceVideo = document.createElement('video')
    sourceVideo.muted = true
    sourceVideo.playsInline = true
    sourceVideo.srcObject = desktopStream
    await waitForMetadata(sourceVideo)
    await sourceVideo.play()
    // A source lost while the devices were still starting must not keep preparing.
    if (!desktopStream || state !== 'preparing') {
      stopSource()
      return
    }
    watchSourceTracks()

    const sourceSize = {
      width: Math.round(Number(sourceVideo.videoWidth) || 0),
      height: Math.round(Number(sourceVideo.videoHeight) || 0)
    }
    // C05: the ONE decision point. Source size, output size, transform and the
    // annotation count are all known here, and MediaRecorder does not exist yet.
    directTrackDecision = decideDirectTrackTake(sourceSize)
    canvas = directTrackDecision.bypass ? null : buildOutputCanvas()
    framePacer = createFramePacer(frameRate)
    compositorActiveDurationMs = 0
    if (!directTrackDecision.bypass) {
      renderCompositeFrame(performance.now(), true)
      canvasStream = canvas.captureStream(frameRate)
    }
    await attachAudioTracks()
    if (directTrackDecision.bypass) {
      const mixedAudioTracks = audioMix && audioMix.active ? audioMix.tracks : []
      recorderStream = createDirectRecorderStream(mixedAudioTracks)
      if (recorderStream) {
        watchDirectTrackSource()
      } else {
        // Defensive: the source video track could not be recorded directly. The
        // composited path is the only one that can still produce a take.
        canvas = buildOutputCanvas()
        renderCompositeFrame(performance.now(), true)
        canvasStream = canvas.captureStream(frameRate)
        if (audioMix && audioMix.active) {
          audioMix.tracks.forEach((track) => canvasStream.addTrack(track))
        }
      }
    }
  } catch (error) {
    stopSource()
    throw new Error(t('record.error.desktop-capture-failed', { detail: error.message || String(error) }))
  }
}

function createMediaRecorder() {
  // Opus is preferred whenever an audio track was mixed into the canvas stream; the plain
  // forms stay last so a video-only recording keeps working on builds without Opus support.
  const mimeTypes = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm'
  ]
  const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || ''
  // Contract §12: the quality profile is the only source of the video bitrate; VP9
  // preference is kept from the previous implementation.
  const options = { videoBitsPerSecond: recordingQuality.qualityBitsPerSecond(quality) }
  if (mimeType) options.mimeType = mimeType
  // C05: the direct-track take hands MediaRecorder the source stream built in
  // prepareSource(); every other take keeps the canvas capture stream.
  const stream = recorderInputStream()
  if (stream && stream.getAudioTracks().length) options.audioBitsPerSecond = audioBitsPerSecond
  try {
    return new MediaRecorder(stream, options)
  } catch (error) {
    throw new Error(t('record.error.recorder-create-failed', { detail: error.message || String(error) }))
  }
}

// Hot-swap robustness (P0-3-T5): a bluetooth or headset change either kills the live
// microphone track or removes the device before the next take. Either way the recording
// keeps going and the user is told what the file will actually contain.
function probeMicrophoneAvailability() {
  if (!audioRequest.microphone || typeof navigator.mediaDevices?.enumerateDevices !== 'function') return
  navigator.mediaDevices.enumerateDevices().then((devices) => {
    if (!['idle', 'preparing'].includes(state)) return
    const inputs = (Array.isArray(devices) ? devices : []).filter((device) => device.kind === 'audioinput')
    setAudioNotice(inputs.length ? '' : 'record.error.microphone-not-detected')
  }).catch(() => {})
}

function handleDeviceChange() {
  const microphoneTrack = micStream?.getAudioTracks()[0]
  if (microphoneTrack && microphoneTrack.readyState === 'ended') {
    // 系统声也关着时已无任何音轨，不能照抄"仅保留系统声音"（文案必须与文件实际内容一致）。
    // The keys are stored, not the sentences, so renderStatus() can re-resolve
    // them in whichever language is active when the notice is drawn.
    setAudioNotice(audioRequest.system
      ? 'record.audio.notice.microphone-disconnected-system'
      : 'record.audio.notice.microphone-disconnected-none')
    return
  }
  const systemTrack = desktopStream?.getAudioTracks()[0]
  if (audioRequest.system && systemTrack && systemTrack.readyState === 'ended') {
    setAudioNotice('record.audio.notice.system-interrupted')
    return
  }
  if (!['recording', 'paused'].includes(state)) probeMicrophoneAvailability()
}

function handleRecorderError(event) {
  const error = new Error(t('record.warn.video-failed', {
    detail: event?.error?.message || t('record.warn.mediarecorder')
  }))
  error.code = 'recorder-error'
  error.failureKey = 'record.error.record-failed'
  failChunkStream(error)
}

// Append queue (contract §12): each MediaRecorder timeslice carries a strictly
// increasing sequence and its byte size. The main process ACKs the last accepted
// sequence; a rejected chunk or a gap moves the UI into a paused error state, it
// never keeps counting as if the file were still being written.
//
// C01: the queue is also bounded. Every fragment is offered to the policy before it is
// queued; 32 MiB / 5 s of unacknowledged fragments pause the recorder, 48 MiB (or one
// abnormal fragment) stops buffering and seals the confirmed part instead of growing.
function handleDataAvailable(event) {
  const data = event?.data
  if (!data || !data.size) return
  // A take that already failed (or is sealing) does not queue late fragments.
  if (appendError || sealing) return
  const at = Date.now()
  const sequence = chunkSequence + 1
  const decision = chunkPolicy.enqueue({ sequence, bytes: data.size, at })
  chunkSequence = sequence
  if (decision.action === 'overflow') {
    failChunkStream(backpressureError(decision))
    return
  }
  if (decision.action === 'pause') pauseForWriteBackpressure(at)
  const chunk = { data, sequence, bytes: data.size }
  appendQueue = appendQueue
    .then(() => appendChunkWithAck(chunk))
    .catch((error) => failChunkStream(error))
}

// C01: MediaRecorder is paused, but the take is still "recording" for the user - the
// status label and the buttons stay as they are. The pause span is opened so the frozen
// media timeline and the elapsed clock both skip the wait.
function pauseForWriteBackpressure(at = Date.now()) {
  if (backpressurePausedAt) return false
  if (!recorder || recorder.state !== 'recording' || state !== 'recording') return false
  try { recorder.pause() } catch { return false }
  backpressurePausedAt = at
  openPauseSpan(at)
  return true
}

function resumeAfterWriteBackpressure(at = Date.now()) {
  if (!backpressurePausedAt) return false
  if (!recorder || recorder.state !== 'paused' || state !== 'recording') return false
  try { recorder.resume() } catch { return false }
  pausedTotal += Math.max(0, at - backpressurePausedAt)
  backpressurePausedAt = 0
  closePauseSpan(at)
  return true
}

function backpressureError(decision) {
  const key = decision.reason === 'oversized-chunk' ? 'record.notice.chunk-oversized' : 'record.notice.chunk-overflow'
  const params = { sequence: decision.sequence, confirmed: lastAckedSequence }
  const error = new Error(t(key, params))
  error.code = 'chunk-overflow'
  error.failureKey = key
  error.failureParams = params
  return error
}

// A write that never ACKs is a wedged disk, not a slow one: stop waiting and seal the
// confirmed part so the user keeps a playable file.
function armAckWatchdog(chunk) {
  clearAckWatchdog()
  const timeout = chunkPolicy.config.ackTimeoutMs
  chunkAckTimer = setTimeout(() => {
    chunkAckTimer = 0
    if (appendError) return
    const params = { sequence: chunk.sequence, seconds: Math.round(timeout / 1000), confirmed: lastAckedSequence }
    const error = new Error(t('record.notice.chunk-timeout', params))
    error.code = 'ack-timeout'
    error.failureKey = 'record.notice.chunk-timeout'
    error.failureParams = params
    failChunkStream(error)
  }, timeout)
}

function clearAckWatchdog() {
  if (!chunkAckTimer) return
  clearTimeout(chunkAckTimer)
  chunkAckTimer = 0
}

async function appendChunkWithAck(chunk) {
  if (appendError || sealing) return null
  // C01: the generation this fragment belongs to. A finish bumps it, so a reply that
  // arrives afterwards is dropped instead of rewriting the next take's counters.
  const generation = takeGeneration
  armAckWatchdog(chunk)
  try {
    const arrayBuffer = await chunk.data.arrayBuffer()
    if (generation !== takeGeneration) return null
    const ack = await window.recordAPI.appendChunk(sessionId, arrayBuffer, chunk.sequence, chunk.bytes)
    if (generation !== takeGeneration || appendError || sealing) return null
    const verdict = classifyChunkAck({ sequence: chunk.sequence, lastChunkSequence: ack?.lastChunkSequence })
    if (verdict === 'ok' || verdict === 'duplicate') {
      const ackedSequence = Number(ack?.lastChunkSequence)
      lastAckedSequence = Math.max(lastAckedSequence, Number.isInteger(ackedSequence) ? ackedSequence : chunk.sequence)
      const ackedBytes = Number(ack?.committedBytes)
      if (Number.isFinite(ackedBytes) && ackedBytes >= 0) committedBytes = ackedBytes
      return ack
    }
    const error = new Error(verdict === 'gap'
      ? t('record.notice.chunk-gap', { sequence: chunk.sequence })
      : t('record.notice.chunk-failed', { detail: t('record.error.record-failed') }))
    error.code = verdict === 'gap' ? 'sequence-gap' : 'chunk-rejected'
    error.failureKey = verdict === 'gap' ? 'record.notice.chunk-gap' : 'record.notice.chunk-failed'
    error.failureParams = verdict === 'gap' ? { sequence: chunk.sequence } : { detail: '' }
    throw error
  } finally {
    // A stale fragment must not clear the watchdog or settle the queue of the take that
    // is running now.
    if (generation === takeGeneration) {
      clearAckWatchdog()
      // Even a failed write frees its slot; a successful drain may lift the pause.
      const settlement = chunkPolicy.settle({ sequence: chunk.sequence })
      if (settlement.action === 'resume') resumeAfterWriteBackpressure()
    }
  }
}

// C01: waiting for the append queue is bounded by the same deadline as one ACK. A write
// that will never settle must not hold the stop/abandon path (and with it the window)
// busy forever; the caller seals what was confirmed instead.
async function awaitAppendQueue(timeoutMs = chunkPolicy.config.ackTimeoutMs) {
  const generation = takeGeneration
  let timer = 0
  const drained = await Promise.race([
    appendQueue.then(() => true, () => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, Number(timeoutMs) || 0))
    })
  ])
  if (timer) clearTimeout(timer)
  // A queue from a previous take is not something this take can wait for.
  if (generation !== takeGeneration) return true
  return drained === true
}

// The queue outlived its deadline during a stop: record it as an interruption with the
// same shape the ACK watchdog uses, so the receipt and the notice agree.
function markAppendQueueTimeout() {
  if (appendError || sealing === false) return
  const params = {
    sequence: lastAckedSequence + 1,
    seconds: Math.round(Number(chunkPolicy.config.ackTimeoutMs) / 1000),
    confirmed: lastAckedSequence
  }
  const error = new Error(t('record.notice.chunk-timeout', params))
  error.code = 'ack-timeout'
  error.failureKey = 'record.notice.chunk-timeout'
  error.failureParams = params
  failChunkStream(error)
}

function failChunkStream(error) {
  if (appendError) return
  appendError = error
  setFailureNotice(error?.failureKey || 'record.notice.chunk-failed', error?.failureParams || null)
  errorElement.textContent = describeError(error)
  // Stop pretending the take is healthy: pause immediately and surface the failure.
  // C01: the watchdog and the queue freeze with it; the confirmed sequence is what the
  // user keeps if they choose to seal the confirmed part.
  if (state === 'recording' && recorder && recorder.state === 'recording') {
    try { recorder.pause() } catch {}
    stopCompositeLoop()
    pausedAt = Date.now()
    openPauseSpan(pausedAt)
    setState(transitionRecordingState('recording', 'error'))
    setFrameState('paused')
  }
}

async function startRecorder(fromState) {
  const session = await window.recordAPI.startSession()
  sessionId = session?.id ? String(session.id) : ''
  if (!sessionId) throw new Error(t('record.error.session-start-failed'))
  projectId = session?.projectId ? String(session.projectId) : ''
  appendQueue = Promise.resolve()
  appendError = null
  // C01: a new take gets a new generation and its own queue; a reply from the previous
  // take cannot clear this take's watchdog or settle its policy.
  takeGeneration += 1
  sealing = false
  finalizePromise = null
  clearAckWatchdog()
  chunkPolicy.reset()
  backpressurePausedAt = 0
  chunkSequence = 0
  lastAckedSequence = 0
  committedBytes = 0
  chunkFailureAcknowledged = false
  recorder = createMediaRecorder()
  recorder.addEventListener('dataavailable', handleDataAvailable)
  recorder.addEventListener('error', handleRecorderError)
  if (!directTrackTakeActive()) startCompositeLoop()
  // R5 §2.2: the media timeline starts here, not at the first chunk. Captured BEFORE start() so a
  // synchronous first dataavailable can never be stamped later than the clock.
  mediaStartedAtWall = Date.now()
  pausedIntervals = []
  pauseStartedAtWall = 0
  recorder.start(1000)
  startedAt = Date.now()
  pausedAt = 0
  pausedTotal = 0
  clearInterval(clockTimer)
  clockTimer = setInterval(renderClock, 250)
  renderClock()
  setState(transitionRecordingState(fromState, fromState === 'countdown' ? 'countdown-finished' : 'record'))
  await setFrameState('recording')
  if (sourceLostHandled) {
    // The target vanished while the session was starting: keep what was captured and ask
    // main to seal it instead of recording against a dead track.
    finishRecording().catch((error) => reportError(error))
  }
}

async function stopMediaRecorder() {
  clearAckWatchdog()
  backpressurePausedAt = 0
  if (!recorder || recorder.state === 'inactive') return
  await new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true })
    recorder.stop()
  })
}

async function runCountdown() {
  const version = ++countdownVersion
  setBusy(true)
  clearFeedback()
  sourceLostHandled = false
  sourceHiddenWarning = false
  await resetAnnotations()
  await setFrameState('idle')
  setState(transitionRecordingState('idle', 'start'))
  try {
    await prepareSource()
  } catch (error) {
    if (version !== countdownVersion) return
    throw error
  }
  if (version !== countdownVersion || state !== 'preparing') {
    stopSource()
    return
  }
  const seconds = countdownSeconds
  if (seconds > 0) {
    setState(transitionRecordingState('preparing', 'ready'))
    for (let value = seconds; value >= 1; value--) {
      if (version !== countdownVersion || state !== 'countdown') return
      countdownElement.textContent = String(value)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (version !== countdownVersion || state !== 'countdown') return
  }
  await startRecorder(seconds > 0 ? 'countdown' : 'preparing')
  setBusy(false)
}

async function beginRecording() {
  if (busy || state !== 'idle') return
  // The take needs the same devices: release the probe first, then acquire.
  cancelAudioPreflight()
  try {
    await runCountdown()
  } catch (error) {
    // The user pressing cancel during preparation rejects the pending acquisition;
    // that is a normal cancel, not a recording failure.
    const cancelled = !sessionId && state === 'idle'
    countdownVersion += 1
    clearInterval(clockTimer)
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop()
    } catch {}
    recorder = null
    stopSource()
    if (sessionId) {
      await window.recordAPI.cancelSession(sessionId).catch(() => {})
      sessionId = ''
      projectId = ''
    }
    setBusy(false)
    setState('idle')
    if (!cancelled) reportError(error)
  }
}

async function finishRecording() {
  // C01: the button, the tray and the shortcut all land here. The first caller runs the
  // one finalize; a concurrent second caller joins it, so main is asked exactly once.
  if (finalizePromise) return finalizePromise
  if (busy) return { ok: false, code: 'busy', state: snapshotState() }
  if (!['recording', 'paused', 'stopped'].includes(state)) {
    return { ok: false, code: 'not-recording', state: snapshotState() }
  }
  // A second finish press after a chunk failure is the explicit "keep the written part"
  // acknowledgement required by contract §12 - the first press only surfaces the risk.
  if (state === 'stopped') chunkFailureAcknowledged = true
  finalizePromise = runFinalize()
  try {
    return await finalizePromise
  } finally {
    finalizePromise = null
  }
}

async function runFinalize() {
  setBusy(true)
  await setFrameState('hidden')
  if (state !== 'stopped') {
    stopCompositeLoop()
    await stopMediaRecorder().catch(() => {})
  }
  // C01: the risk is surfaced BEFORE waiting for the queue. Waiting first is what used
  // to leave the bar busy forever behind a write that never settles.
  if (appendError && !chunkFailureAcknowledged) {
    chunkFailureAcknowledged = true
    sealing = true
    if (state !== 'stopped') setState(transitionRecordingState(state, 'stop'))
    setState(transitionRecordingState('finalizing', 'failed'))
    setBusy(false)
    saveProgressElement.textContent = ''
    setFailureNotice('record.notice.chunk-failed-retry')
    return { ok: false, code: 'chunk-failed', state: snapshotState() }
  }
  // From here on no new fragment is accepted: the confirmed prefix is what gets sealed.
  sealing = true
  if (state !== 'stopped') setState(transitionRecordingState(state, 'stop'))
  saveProgressElement.textContent = t('record.status.finalizing')
  // C01: the queue is awaited only for a bounded time. An append that outlives the ACK
  // deadline is reported as an interruption; main keeps the original file and seals the
  // confirmed prefix (or reports that nothing was confirmed).
  if (!(await awaitAppendQueue())) markAppendQueueTimeout()
  let result = null
  try {
    result = await window.recordAPI.finishSession(sessionId, { ...finishTiming(), interrupted: Boolean(appendError) })
  } catch (error) {
    setState(transitionRecordingState('finalizing', 'failed'))
    setBusy(false)
    saveProgressElement.textContent = ''
    reportError(error)
    return { ok: false, code: 'finish-failed', state: snapshotState() }
  }
  if (!result || result.ok !== true) {
    setState(transitionRecordingState('finalizing', 'failed'))
    setBusy(false)
    saveProgressElement.textContent = ''
    const code = result?.code ? String(result.code) : ''
    // C01/02: "nothing was confirmed" is a definite result with its own copy, not the
    // generic finish failure (the user has to know there is no file to recover).
    if (code === 'no-confirmed-media') {
      setFailureNotice('record.notice.no-confirmed-media')
      errorElement.textContent = t('record.notice.no-confirmed-media')
    } else {
      setFailureNotice('record.notice.finish-failed', { detail: code || t('record.error.record-failed') })
    }
    return { ok: false, code: code || 'finish-failed', state: snapshotState() }
  }
  projectId = result.projectId ? String(result.projectId) : projectId
  clearInterval(clockTimer)
  // C01: an interrupted take is still handed to the editor (main seals the confirmed
  // prefix), but the bar must say so instead of claiming a clean save.
  if (result.interrupted) {
    setFailureNotice('record.notice.capture-interrupted', {
      reason: interruptedReasonText(result.code),
      from: Number(result.missingSequenceFrom) || 0,
      to: Number(result.missingSequenceTo) || 0
    })
    errorElement.textContent = t('record.notice.capture-interrupted', {
      reason: interruptedReasonText(result.code),
      from: Number(result.missingSequenceFrom) || 0,
      to: Number(result.missingSequenceTo) || 0
    })
  }
  // The main process owns navigation from here: it seals the project, opens the
  // editor and closes this control bar. The renderer never opens anything itself.
  setState(transitionRecordingState('finalizing', 'finished'))
  saveProgressElement.textContent = ''
  stopSource()
  setBusy(false)
  return { ok: true, state: snapshotState(), interrupted: result.interrupted === true }
}

// Writer failure codes the main process reports on an interrupted receipt. The message
// stays in the locale tables; only the reason travels as a key.
const INTERRUPTED_REASON_KEYS = {
  'ack-timeout': 'record.reason.write-timeout',
  'write-timeout': 'record.reason.write-timeout',
  'chunk-overflow': 'record.reason.queue-overflow',
  'ENOSPC': 'record.reason.disk-full',
  'EACCES': 'record.reason.disk-denied',
  'EPERM': 'record.reason.disk-denied',
  'EIO': 'record.reason.write-failed'
}

function interruptedReasonText(code) {
  const key = INTERRUPTED_REASON_KEYS[String(code || '')]
  return key ? t(key) : (String(code || '') || t('record.reason.write-failed'))
}

async function cancelRecording() {
  if (busy || !['preparing', 'countdown'].includes(state)) return
  countdownVersion += 1
  stopSource()
  setState(transitionRecordingState(state, 'cancel'))
  setBusy(false)
  await setFrameState('idle')
}

async function confirmDiscard() {
  if (busy || !sessionId) return
  setBusy(true)
  discardConfirm.hidden = true
  await setFrameState('hidden')
  // C01: an abandoned take stops queuing fragments immediately, and the cleanup request
  // waits only for the ACK deadline. Main defers deleting a file that is still being
  // written, so no in-flight write can resurrect or tear it.
  sealing = true
  stopCompositeLoop()
  await stopMediaRecorder().catch(() => {})
  await awaitAppendQueue()
  try {
    await window.recordAPI.cancelSession(sessionId)
  } catch {}
  sessionId = ''
  projectId = ''
  clearInterval(clockTimer)
  stopSource()
  countdownVersion += 1
  startedAt = 0
  pausedAt = 0
  pausedTotal = 0
  chunkSequence = 0
  lastAckedSequence = 0
  committedBytes = 0
  appendError = null
  chunkFailureAcknowledged = false
  sealing = false
  clearFeedback()
  timeElement.textContent = '00:00'
  setState(transitionRecordingState(state, 'cancel'))
  setBusy(false)
  await setFrameState('idle')
}

function openDiscardConfirm() {
  if (busy || !sessionId || !['recording', 'paused', 'stopped'].includes(state)) return
  discardConfirm.hidden = false
}

function pauseRecording() {
  if (busy) return { ok: false, code: 'busy', state: snapshotState() }
  if (state === 'paused') return { ok: true, state: snapshotState() }
  if (state !== 'recording' || !recorder || recorder.state !== 'recording') {
    return { ok: false, code: 'not-recording', state: snapshotState() }
  }
  recorder.pause()
  stopCompositeLoop()
  pausedAt = Date.now()
  openPauseSpan(pausedAt)
  setState(transitionRecordingState('recording', 'pause'))
  setFrameState('paused')
  return { ok: true, state: snapshotState() }
}

function resumeRecording() {
  if (busy) return { ok: false, code: 'busy', state: snapshotState() }
  if (state === 'recording') return { ok: true, state: snapshotState() }
  if (state !== 'paused' || !recorder || recorder.state !== 'paused') {
    return { ok: false, code: 'not-paused', state: snapshotState() }
  }
  recorder.resume()
  startCompositeLoop()
  pausedTotal += Date.now() - pausedAt
  closePauseSpan()
  pausedAt = 0
  setState(transitionRecordingState('paused', 'resume'))
  setFrameState('recording')
  return { ok: true, state: snapshotState() }
}

function applyMicrophoneMuted(muted) {
  if (!microphoneCaptured() || !['recording', 'paused'].includes(state)) {
    return { ok: false, code: 'microphone-unavailable', state: snapshotState() }
  }
  const next = muted === true
  if (next === microphoneMuted) return { ok: true, state: snapshotState() }
  microphoneMuted = next
  micLevel = 0
  audioMix?.setMicrophoneMuted?.(microphoneMuted)
  renderMicState()
  reportState()
  return { ok: true, state: snapshotState() }
}

// One arbitration path for buttons, tray and shortcuts (contract §9.2): every
// command goes through the dispatcher, which deduplicates pushed requestIds.
const commandDispatcher = createCommandDispatcher({
  handlers: {
    pause: () => pauseRecording(),
    resume: () => resumeRecording(),
    stop: () => {
      // Acknowledge immediately; sealing + probing can take seconds and main only
      // needs to know the command was accepted.
      finishRecording().catch((error) => reportError(error))
      return { ok: true, state: snapshotState() }
    },
    'set-microphone-muted': (value) => applyMicrophoneMuted(value === true)
  }
})

function applyCommand(request) {
  return commandDispatcher.dispatch(request)
}

// ---------------------------------------------------------------------------
// B04: per-take audio preflight (the "Check sound" entry beside Start)
//
// The workbench verifies the microphone permission before it opens this window
// (it is the only surface that can show the Windows permission path). This bar is
// where the REAL lanes can be sampled, because main's display-media handler only
// serves loopback audio to this window's main frame:
//   * one click opens at most two devices (getDisplayMedia with audio for the
//     system mix, getUserMedia for the microphone) and nothing is opened before
//     that click - the button, not the page, owns the devices;
//   * the sample window is five seconds (shared/audio-preflight.js owns the cap),
//     it can always be cancelled, and every track/context is released on every
//     exit path, including a lost Bluetooth headset;
//   * the panel never claims the system lane is "this window only": Windows
//     loopback is the system mix in window mode too.
// ---------------------------------------------------------------------------
const PREFLIGHT_PROMPT_KEYS = {
  'microphone-denied': 'record.preflight.prompt-microphone-denied',
  'microphone-missing': 'record.preflight.prompt-microphone-missing',
  'microphone-busy': 'record.preflight.prompt-microphone-busy',
  'microphone-lost': 'record.preflight.prompt-microphone-lost',
  'microphone-silent': 'record.preflight.prompt-microphone-silent',
  'microphone-failed': 'record.preflight.prompt-microphone-failed',
  'system-denied': 'record.preflight.prompt-system-denied',
  'system-unavailable': 'record.preflight.prompt-system-unavailable',
  'system-lost': 'record.preflight.prompt-system-lost',
  'system-silent': 'record.preflight.prompt-system-silent',
  'system-failed': 'record.preflight.prompt-system-failed'
}
// The bar can only act on its own start parameters: opening Windows' microphone
// page needs a shell channel this window does not have (the workbench has one).
const PREFLIGHT_ACTION_KEYS = {
  'record-system-only': 'record.preflight.action-system-only',
  'record-silent': 'record.preflight.action-silent',
  'record-microphone-only': 'record.preflight.action-mic-only'
}
const PREFLIGHT_LEVEL_KEYS = {
  good: 'record.preflight.level-good',
  low: 'record.preflight.level-low',
  silent: 'record.preflight.level-silent'
}

function preflightSupported() {
  return Boolean(audioPreflightModule && preflight)
}

function preflightStatus() {
  return preflight ? preflight.status() : null
}

// What this take will actually capture, in the user's words.
function preflightAudioText() {
  const system = audioRequest.system === true
  const microphone = audioRequest.microphone === true
  if (system && microphone) return t('record.preflight.audio-both')
  if (system) return t('record.preflight.audio-system')
  if (microphone) return t('record.preflight.audio-microphone')
  return t('record.preflight.audio-none')
}

function preflightNoteText(status = preflightStatus()) {
  if (preflightAppliedKey) return t(preflightAppliedKey)
  if (status && status.promptCode && PREFLIGHT_PROMPT_KEYS[status.promptCode]) return t(PREFLIGHT_PROMPT_KEYS[status.promptCode])
  if (status && status.active) return t('record.preflight.sample-hint')
  // Window mode never narrows the mix: the loopback track is the system mix, and
  // the copy says so instead of implying "this window only".
  if (audioRequest.system && captureMode === 'window') return t('record.preflight.system-window-note')
  if (audioRequest.system && !preflightLoopback) return t('record.preflight.loopback-unavailable')
  return ''
}

function renderPreflightLane(lane, barElement, textElement, status) {
  if (!barElement || !textElement) return
  const enabled = lane === 'system' ? audioRequest.system === true : audioRequest.microphone === true
  if (!enabled) {
    barElement.style.width = '0%'
    barElement.setAttribute('data-level', 'silent')
    textElement.textContent = t(lane === 'system' ? 'record.preflight.system-off' : 'record.preflight.microphone-off')
    return
  }
  const entry = status && status.lanes ? status.lanes[lane] : null
  if (!entry) {
    textElement.textContent = ''
    barElement.style.width = '0%'
    barElement.setAttribute('data-level', 'silent')
    return
  }
  const percent = audioPreflightModule ? audioPreflightModule.levelPercent(entry.peak) : 0
  barElement.style.width = `${percent}%`
  barElement.setAttribute('data-level', entry.level)
  if (entry.code && PREFLIGHT_PROMPT_KEYS[entry.code]) {
    textElement.textContent = t(PREFLIGHT_PROMPT_KEYS[entry.code])
    return
  }
  if (entry.sampled > 0) {
    textElement.textContent = t(PREFLIGHT_LEVEL_KEYS[entry.level] || 'record.preflight.level-silent')
    return
  }
  // An opened lane with no samples means the meter itself could not run (no
  // WebAudio); say that instead of leaving the cell blank.
  textElement.textContent = status && status.active
    ? t('record.preflight.level-waiting')
    : (entry.opened ? t('record.preflight.meter-unavailable') : '')
}

function renderPreflightActions(status) {
  const actions = status && Array.isArray(status.actions) ? status.actions : []
  const rows = [
    [preflightSystemOnlyButton, 'record-system-only'],
    [preflightMicOnlyButton, 'record-microphone-only'],
    [preflightSilentButton, 'record-silent']
  ]
  for (const [button, action] of rows) {
    if (!button) continue
    button.hidden = !actions.includes(action)
    button.textContent = PREFLIGHT_ACTION_KEYS[action] ? t(PREFLIGHT_ACTION_KEYS[action]) : ''
  }
}

function renderPreflight() {
  if (!preflightButton || !preflightPanel) return
  const status = preflightStatus()
  const active = Boolean(status && status.active)
  preflightButton.hidden = !(state === 'idle' && (audioRequest.system || audioRequest.microphone))
  preflightButton.disabled = busy || !preflightSupported()
  preflightButton.textContent = active ? t('record.preflight.checking') : t('record.preflight.check')
  preflightPanel.hidden = !preflightPanelOpen
  if (preflightRetryButton) {
    preflightRetryButton.disabled = busy || !preflightSupported()
    preflightRetryButton.textContent = active ? t('record.preflight.stop') : t('record.preflight.retry')
  }
  if (preflightCloseButton) preflightCloseButton.disabled = false
  if (!preflightPanelOpen) return
  if (preflightAudioElement) preflightAudioElement.textContent = preflightAudioText()
  if (preflightNoteElement) preflightNoteElement.textContent = preflightNoteText(status)
  renderPreflightLane('system', preflightSystemBar, preflightSystemText, status)
  renderPreflightLane('microphone', preflightMicBar, preflightMicText, status)
  renderPreflightActions(status)
}

// The five-second loop only redraws the two meters; the panel itself stays put so
// the level cannot steal focus or restart the sample.
function renderPreflightMeters() {
  if (!preflightPanelOpen) return
  const status = preflightStatus()
  if (preflightNoteElement) preflightNoteElement.textContent = preflightNoteText(status)
  renderPreflightLane('system', preflightSystemBar, preflightSystemText, status)
  renderPreflightLane('microphone', preflightMicBar, preflightMicText, status)
  renderPreflightActions(status)
}

async function acquirePreflightSystemStream() {
  if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    throw Object.assign(new Error('display media unavailable'), { name: 'NotReadableError' })
  }
  // Same branch the take uses: in window mode main's handler is bound to the
  // selected window, in display/region mode it pins the display. Audio is asked
  // for here, which is what makes the handler attach Windows loopback.
  const stream = captureMode === 'window'
    ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    : await navigator.mediaDevices.getDisplayMedia({ video: desktopVideoConstraints(), audio: true })
  // Chromium requires a video request before it grants the audio track, but the
  // preflight only listens: the stream is never attached to a <video> element, and
  // the video track is released together with the audio by
  // releasePreflightDevices(). Stopping it here instead would risk tearing down the
  // capture device (and with it the audio lane) on some drivers, which would turn a
  // working system mix into a false "no sound".
  return stream
}

async function acquirePreflightMicrophoneStream() {
  const mixer = await loadAudioMixer()
  const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(mixer, audioRequest.microphoneDeviceId), video: false })
  if (!stream || !stream.getAudioTracks().length) {
    for (const track of stream?.getTracks?.() || []) {
      try { track.stop() } catch {}
    }
    throw Object.assign(new Error('no microphone track'), { name: 'NotFoundError' })
  }
  return stream
}

// A Bluetooth headset pulled out mid-check ends its track while the sample is
// still running. Reporting that as "lost" (with its re-check prompt) is honest;
// without this the lane would just read "no sound" and invite a wrong fix.
function watchPreflightTrack(lane, stream) {
  const track = stream?.getAudioTracks?.()[0]
  if (!track || typeof track.addEventListener !== 'function') return
  track.addEventListener('ended', () => {
    if (!preflightSupported() || !preflight.isActive()) return
    preflight.failLane(lane, { name: 'DeviceLost' })
    renderPreflightMeters()
  })
}

function attachPreflightAnalyser(lane, stream) {
  if (!preflightContext || !preflightAnalysers) return
  try {
    const analyser = preflightContext.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0
    preflightContext.createMediaStreamSource(stream).connect(analyser)
    preflightAnalysers[lane] = analyser
  } catch {
    preflightAnalysers[lane] = null
  }
}

function preflightPeak(analyser) {
  if (!analyser || !preflightSamples) return 0
  if (typeof analyser.getFloatTimeDomainData === 'function') {
    analyser.getFloatTimeDomainData(preflightSamples)
    return audioPreflightModule.peakOfFloat(preflightSamples)
  }
  const bytes = new Uint8Array(analyser.fftSize || 1024)
  if (typeof analyser.getByteTimeDomainData === 'function') {
    analyser.getByteTimeDomainData(bytes)
    return audioPreflightModule.peakOfBytes(bytes)
  }
  return 0
}

// The five-second deadline runs for the WHOLE check, not just the sampling phase: the tick
// is armed the moment the run begins, so a permission prompt that never answers still ends
// the run (and releases the devices already opened) inside the budget.
function preflightTick() {
  preflightTimer = 0
  if (!preflightSupported() || !preflight.isActive()) return
  if (preflight.expired()) {
    stopAudioPreflight('done')
    return
  }
  for (const lane of ['system', 'microphone']) {
    const analyser = preflightAnalysers ? preflightAnalysers[lane] : null
    if (analyser) preflight.sample(lane, preflightPeak(analyser))
  }
  renderPreflightMeters()
  preflightTimer = setTimeout(preflightTick, Math.max(50, Math.min(200, preflight.remaining())))
}

// Stops every track and closes the AudioContext. Called on finish, cancel, route
// exit, window close and before a take starts, so a check can never hold a device.
// B04 (13): the resource ledger owns the devices. It also stops a stream that a previous
// run's callback registers after this one ended, which the local variables cannot see.
function releasePreflightDevices() {
  // B04 (13): one owner per device. The ledger stops every adopted stream and closes every
  // adopted context (including one a stale run registers late); the local refs are cleared.
  if (preflightResources) {
    preflightResources.release()
  } else {
    for (const stream of [preflightSystemStream, preflightMicStream]) {
      for (const track of stream?.getTracks?.() || []) {
        try { track.stop() } catch {}
      }
    }
    const context = preflightContext
    if (context && typeof context.close === 'function') {
      try {
        const closing = context.close()
        if (closing && typeof closing.catch === 'function') closing.catch(() => {})
      } catch {}
    }
  }
  preflightSystemStream = null
  preflightMicStream = null
  preflightAnalysers = null
  preflightSamples = null
  preflightContext = null
}

function stopAudioPreflight(outcome = 'done') {
  const wasActive = Boolean(preflight && preflight.isActive())
  if (preflightTimer) {
    clearTimeout(preflightTimer)
    preflightTimer = 0
  }
  if (wasActive) preflight.finish(outcome)
  releasePreflightDevices()
  if (wasActive) preflight.markReleased(Date.now())
  renderPreflight()
}

function cancelAudioPreflight() {
  preflightPanelOpen = false
  preflightAppliedKey = ''
  stopAudioPreflight('cancelled')
}

async function startAudioPreflight() {
  // No init payload means no display-media handler and no device contract yet.
  if (!preflightSupported() || !initData || state !== 'idle') return
  if (preflight.isActive()) {
    stopAudioPreflight('cancelled')
    return
  }
  preflightPanelOpen = true
  preflightAppliedKey = ''
  // Both sources off: nothing to open and nothing to sample, so say so instead of
  // asking for a device the take will not use.
  if (!preflight.begin({ system: audioRequest.system, microphone: audioRequest.microphone })) {
    renderPreflight()
    return
  }
  // B04 (13): the run token. Starting a check invalidates (and releases) the previous one,
  // and every await below checks the token before it stores or starts anything.
  const runToken = preflightResources ? preflightResources.begin() : 0
  preflightRun += 1
  const runGeneration = preflightRun
  const stillCurrent = () => runGeneration === preflightRun && (!preflightResources || preflightResources.isCurrent(runToken))
  // The deadline starts NOW, not when the last device answers. Without this a pending
  // permission prompt (or a hung getDisplayMedia) would hold the system track forever.
  preflightTimer = setTimeout(preflightTick, 0)
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (typeof AudioContextClass === 'function') {
      const context = new AudioContextClass()
      if (!stillCurrent()) {
        try { context.close?.() } catch {}
        return
      }
      preflightContext = context
      if (preflightResources) preflightResources.adoptContext(runToken, context)
      preflightAnalysers = { system: null, microphone: null }
      preflightSamples = new Float32Array(1024)
    }
  } catch {
    preflightContext = null
    preflightAnalysers = null
    preflightSamples = null
  }
  if (preflight.canOpen('system') && preflight.noteOpen('system')) {
    let systemStream = null
    try {
      systemStream = await acquirePreflightSystemStream()
    } catch (error) {
      preflight.failLane('system', error)
    }
    if (systemStream) {
      // A stream granted after the deadline (or after a cancel/re-check) is stopped at
      // once - including the video track getDisplayMedia had to request.
      if (!stillCurrent() || !preflight.isActive() || !(preflightResources ? preflightResources.adoptStream(runToken, systemStream) : true)) {
        for (const track of systemStream.getTracks?.() || []) {
          try { track.stop() } catch {}
        }
        systemStream = null
      } else {
        preflightSystemStream = systemStream
        watchPreflightTrack('system', systemStream)
        attachPreflightAnalyser('system', systemStream)
      }
    }
  }
  // A cancel (or a take the user started) during the first await must not open the
  // second device at all.
  if (!stillCurrent() || !preflight.isActive()) {
    releasePreflightDevices()
    renderPreflight()
    return
  }
  if (preflight.canOpen('microphone') && preflight.noteOpen('microphone')) {
    let micStream = null
    try {
      micStream = await acquirePreflightMicrophoneStream()
    } catch (error) {
      preflight.failLane('microphone', error)
    }
    if (micStream) {
      if (!stillCurrent() || !preflight.isActive() || !(preflightResources ? preflightResources.adoptStream(runToken, micStream) : true)) {
        for (const track of micStream.getTracks?.() || []) {
          try { track.stop() } catch {}
        }
        micStream = null
      } else {
        preflightMicStream = micStream
        watchPreflightTrack('microphone', micStream)
        attachPreflightAnalyser('microphone', micStream)
      }
    }
  }
  if (!stillCurrent() || !preflight.isActive()) {
    releasePreflightDevices()
    renderPreflight()
    return
  }
  if (!preflightAnalysers || (!preflightAnalysers.system && !preflightAnalysers.microphone)) {
    // WebAudio is unavailable: the devices proved what they could (permission and
    // presence), so release them now instead of waiting five seconds for a level
    // that can never be drawn.
    stopAudioPreflight('done')
    return
  }
  preflight.startSampling()
  renderPreflight()
  // The tick was already armed above; sampling now reads the analysers it set up.
}

// Applies one of the panel's prompts to THIS take's start parameters (the same
// audioRequest the recorder reads in attachAudioTracks).
function applyPreflightAction(action) {
  if (!Object.hasOwn(PREFLIGHT_ACTION_KEYS, action)) return
  if (action === 'record-system-only') {
    audioRequest.microphone = false
    audioRequest.microphoneDeviceId = ''
    preflightAppliedKey = 'record.preflight.applied-system-only'
  } else if (action === 'record-microphone-only') {
    audioRequest.system = false
    preflightAppliedKey = 'record.preflight.applied-microphone-only'
  } else {
    audioRequest.system = false
    audioRequest.microphone = false
    audioRequest.microphoneDeviceId = ''
    preflightAppliedKey = 'record.preflight.applied-silent'
  }
  // The running sample no longer describes the take, so end it and release the
  // devices; the summary is what changes, not a stale level.
  stopAudioPreflight('done')
  renderAudioIndicator()
  renderPreflight()
}

startButton.addEventListener('click', () => { beginRecording().catch((error) => reportError(error)) })
preflightButton?.addEventListener('click', () => { startAudioPreflight().catch(() => {}) })
preflightRetryButton?.addEventListener('click', () => {
  if (preflight && preflight.isActive()) stopAudioPreflight('done')
  else startAudioPreflight().catch(() => {})
})
preflightCloseButton?.addEventListener('click', () => cancelAudioPreflight())
for (const [button, action] of [
  [preflightSystemOnlyButton, 'record-system-only'],
  [preflightMicOnlyButton, 'record-microphone-only'],
  [preflightSilentButton, 'record-silent']
]) {
  button?.addEventListener('click', () => applyPreflightAction(action))
}
pauseButton.addEventListener('click', () => {
  applyCommand({ requestId: createRequestId('button'), command: state === 'paused' ? 'resume' : 'pause' })
})
stopButton.addEventListener('click', () => {
  applyCommand({ requestId: createRequestId('button'), command: 'stop' })
})
cancelButton.addEventListener('click', () => { cancelRecording().catch((error) => reportError(error)) })
closeBarButton.addEventListener('click', () => window.recordAPI.close())
micMuteButton.addEventListener('click', () => {
  applyCommand({ requestId: createRequestId('button'), command: 'set-microphone-muted', value: !microphoneMuted })
})
moreToggleButton.addEventListener('click', toggleMorePanel)
moreBackButton.addEventListener('click', closeMorePanel)
abandonButton.addEventListener('click', openDiscardConfirm)
discardConfirmYes.addEventListener('click', () => { confirmDiscard().catch((error) => reportError(error)) })
discardConfirmNo.addEventListener('click', () => { discardConfirm.hidden = true })
volumeSystem.addEventListener('input', () => audioMix?.setBusGain?.('system', Number(volumeSystem.value)))
volumeMic.addEventListener('input', () => audioMix?.setBusGain?.('microphone', Number(volumeMic.value)))

annotationToolButtons.forEach((button) => button.addEventListener('click', () => {
  if (!annotationEnabled()) return
  annotationTool = button.dataset.annotationTool
  renderAnnotationControls()
  sendAnnotationCommand().catch(reportError)
}))
annotationStyleButton.addEventListener('click', (event) => {
  event.stopPropagation()
  if (annotationStyleButton.disabled) return
  annotationPalette.hidden = !annotationPalette.hidden
})
annotationColorButtons.forEach((button) => button.addEventListener('click', () => {
  if (!ANNOTATION_COLORS.includes(button.dataset.annotationColor)) return
  annotationColor = button.dataset.annotationColor
  renderAnnotationControls()
  sendAnnotationCommand().catch(reportError)
}))
annotationWidthButtons.forEach((button) => button.addEventListener('click', () => {
  const width = Number(button.dataset.annotationWidth)
  if (!ANNOTATION_WIDTHS.includes(width)) return
  annotationWidth = width
  renderAnnotationControls()
  sendAnnotationCommand().catch(reportError)
}))
annotationUndoButton.addEventListener('click', () => sendAnnotationCommand('undo').catch(reportError))
annotationClearButton.addEventListener('click', () => sendAnnotationCommand('clear').catch(reportError))
document.addEventListener('click', (event) => {
  if (!annotationPalette.contains(event.target) && event.target !== annotationStyleButton) annotationPalette.hidden = true
})

// Tray / shortcut commands arrive as pushes and land on the same dispatcher as the
// buttons; the result is reported back so the main process can forward the state.
window.recordAPI.onCommand((command) => {
  const requestId = typeof command?.requestId === 'string' ? command.requestId : ''
  applyCommand(command).then((result) => {
    window.recordAPI.reportCommandResult({
      requestId,
      ok: result?.ok !== false,
      state: result?.state || snapshotState(),
      code: result?.code || ''
    })
  }).catch(() => {
    window.recordAPI.reportCommandResult({
      requestId,
      ok: false,
      state: snapshotState(),
      code: 'command-failed'
    })
  })
})
// A post-command state echo from main: adopt only a newer version (a lost pause/resume
// push is repaired here, stale echoes are ignored by the version guard).
window.recordAPI.onStateChanged((mainState) => {
  try {
    adoptMainState(mainState)
  } catch {
    // A malformed push must never break the live bar.
  }
})
window.recordAPI.onAnnotationSnapshot((snapshot) => {
  if (!initData || !annotationAllowed) return
  annotationSnapshot = sanitizeAnnotationSnapshot(snapshot, annotationStageSize())
  renderAnnotationControls()
  requestCompositeFrame()
  // C05: a direct-track take cannot absorb a composited annotation layer. The take
  // is sealed through the normal finish path and the reason is reported; tracks are
  // never swapped underneath MediaRecorder.
  if (directTrackTakeActive() && annotationSnapshot.annotations.length > 0) {
    handleDirectTrackCompositionChange('annotations-present')
  }
})
// R4 window mode invalidation push (contract §2.2): main polls the bound window source while
// this control window is alive and pushes once when the target disappears.
if (typeof window.recordAPI.onSourceLost === 'function') {
  window.recordAPI.onSourceLost((payload) => {
    try {
      handleSourceLost(payload)
    } catch {
      // A malformed invalidation push must never break the live bar.
    }
  })
}
window.recordAPI.onInit((data) => {
  initData = resolveRecordInit(data)
  frameRate = initData.frameRate
  quality = recordingQuality.normalizeQuality(initData.quality)
  countdownSeconds = recordingQuality.normalizeCountdown(initData.countdownSeconds)
  fakeCapture = initData.fakeCapture === true
  captureMode = initData.mode === 'window' ? 'window' : 'display'
  const windowInfo = data && typeof data.window === 'object' ? data.window : null
  windowPixelSize = captureMode === 'window' ? normalizeWindowPixelSize(windowInfo?.pixelSize) : null
  windowCaptureTitle = captureMode === 'window' && typeof windowInfo?.title === 'string'
    ? windowInfo.title.trim()
    : ''
  // Window captures have no frame overlay window (contract §2.2), so annotations are off;
  // display/region recordings keep them unless main explicitly disables them.
  annotationAllowed = captureMode === 'window' ? data.annotation === true : data.annotation !== false
  sourceLostHandled = false
  sourceHiddenWarning = false
  audioRequest = {
    system: initData.audio.system !== false,
    microphone: initData.audio.microphone === true,
    microphoneDeviceId: initData.audio.microphoneDeviceId,
    systemGain: initData.audio.systemGain,
    microphoneGain: initData.audio.microphoneGain
  }
  // B04: main reports the exact condition its display-media handler uses for
  // loopback (`process.platform === 'win32'`), so the check never promises a system
  // lane this build cannot deliver.
  preflightLoopback = data && data.audioLoopback === false ? false : true
  cancelAudioPreflight()
  fpsElement.textContent = `${frameRate} FPS`
  fpsElement.title = audioRequest.system || audioRequest.microphone
    ? t('record.audio.contains')
    : t('record.audio.contains-none')
  setState('idle')
  setFrameState('idle')
  if (fakeCapture) {
    // E2E-only (same gate as the synthetic capture source): lets the runtime probe drive
    // the window-mode invalidation paths that would need a real target window otherwise.
    window.__recordDebug = {
      directTrack: () => (directTrackDecision ? { ...directTrackDecision } : null),
      fitContainRect,
      emitVideoTrackEvent: (type) => {
        const track = watchedVideoTrack || desktopStream?.getVideoTracks?.()[0]
        if (track && typeof track.dispatchEvent === 'function') track.dispatchEvent(new Event(String(type)))
      },
      sourceLost: (reason) => handleSourceLost({ reason: typeof reason === 'string' ? reason : 'closed' })
    }
  }
  // Best-effort: main may still own a capture this (reloaded) bar should show.
  reconcileStateFromMain().catch(() => {})
})

if (typeof navigator.mediaDevices?.addEventListener === 'function') {
  navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)
}

// P0-1-T2/T5: the initial pass translates the markup; the broadcast subscription
// re-renders the dynamic parts (status label, annotation titles, audio notice) too.
applyTranslations()
window.recordAPI.onInterfaceLanguage((language) => {
  setLanguage(language)
  applyTranslations()
  setState(state)
  renderAudioIndicator()
  renderMicState()
  renderPreflight()
  // The hidden-window warning is rendered from a key, so a language switch re-resolves it.
  if (sourceHiddenWarning) errorElement.textContent = t('record.warning.source-hidden')
  else if (sourceLostHandled && failureNotice?.key === 'record.warning.source-lost') {
    errorElement.textContent = t('record.warning.source-lost')
  }
})

addEventListener('beforeunload', () => {
  countdownVersion++
  cancelAudioPreflight()
  clearInterval(clockTimer)
  navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
  stopSource()
})

window.recordAPI.ready()
