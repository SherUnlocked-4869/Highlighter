const {
  calculateCropRect,
  classifyChunkAck,
  createCommandDispatcher,
  createFramePacer,
  createRequestId,
  formatDuration,
  localStateForWireStatus,
  reportStatusFor,
  resolveRecordInit,
  shouldAdoptMainState,
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

const controlView = document.getElementById('controlView')
const timeElement = document.getElementById('time')
const statusLabel = document.getElementById('statusLabel')
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
const annotationStyleButton = document.getElementById('annotationStyle')
const annotationPalette = document.getElementById('annotationPalette')
const annotationSwatch = document.getElementById('annotationSwatch')
const annotationWidthMark = document.getElementById('annotationWidthMark')
const annotationUndoButton = document.getElementById('annotationUndo')
const annotationClearButton = document.getElementById('annotationClear')
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
let startedAt = 0
let pausedAt = 0
let pausedTotal = 0
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

function elapsedTime() {
  if (!startedAt) return 0
  const activePause = pausedAt ? Date.now() - pausedAt : 0
  return Math.max(0, Date.now() - startedAt - pausedTotal - activePause)
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
  const key = STATUS_LABELS[state]
  if (!key) return
  const label = t(key)
  const notice = failureNotice
    ? t(failureNotice.key, failureNotice.params)
    : (audioNoticeKey ? t(audioNoticeKey, audioNoticeParams) : '')
  statusLabel.textContent = notice ? `${label} · ${notice}` : label
  if (notice) statusLabel.title = notice
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

function setBusy(value) {
  busy = !!value
  renderControls()
}

function annotationEnabled() {
  return !busy && ['recording', 'paused'].includes(state) && moreOpen
}

function renderAnnotationControls() {
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
  } else if (nextState === 'recording' && recorder?.state === 'paused') {
    try { recorder.resume() } catch {}
    startCompositeLoop()
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
  await sendAnnotationCommand('reset')
}

function stopSource() {
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
  desktopStream?.getTracks().forEach((track) => track.stop())
  if (sourceVideo) sourceVideo.srcObject = null
  canvasStream = null
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

function renderCompositeFrame(timestamp = performance.now(), force = false) {
  if (!canvas || !sourceVideo || !framePacer.shouldDraw(timestamp, force)) return false
  const context = canvas._recordContext
  const crop = canvas._recordCrop
  context.drawImage(sourceVideo, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.width, crop.height)
  drawAnnotationSnapshot(context, annotationSnapshot, {
    width: initData.selectionBounds.width,
    height: initData.selectionBounds.height
  })
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
function createFakeDesktopStream() {
  const width = Math.max(2, Math.round(initData.display?.pixelSize?.width || initData.displayBounds.width || 1280))
  const height = Math.max(2, Math.round(initData.display?.pixelSize?.height || initData.displayBounds.height || 720))
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
      audioMix.tracks.forEach((track) => canvasStream.addTrack(track))
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

async function prepareSource() {
  if (desktopStream && canvasStream) return
  try {
    desktopStream = fakeCapture ? createFakeDesktopStream() : await acquireDesktopStream()
    sourceVideo = document.createElement('video')
    sourceVideo.muted = true
    sourceVideo.playsInline = true
    sourceVideo.srcObject = desktopStream
    await waitForMetadata(sourceVideo)
    await sourceVideo.play()

    const crop = calculateCropRect(
      { width: sourceVideo.videoWidth, height: sourceVideo.videoHeight },
      initData.displayBounds,
      initData.selectionBounds
    )
    canvas = document.createElement('canvas')
    canvas.width = crop.width
    canvas.height = crop.height
    canvas._recordCrop = crop
    canvas._recordContext = canvas.getContext('2d', { alpha: false })
    framePacer = createFramePacer(frameRate)
    compositorActiveDurationMs = 0
    renderCompositeFrame(performance.now(), true)
    canvasStream = canvas.captureStream(frameRate)
    await attachAudioTracks()
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
  if (canvasStream?.getAudioTracks().length) options.audioBitsPerSecond = audioBitsPerSecond
  try {
    return new MediaRecorder(canvasStream, options)
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
function handleDataAvailable(event) {
  const data = event?.data
  if (!data || !data.size) return
  chunkSequence += 1
  const chunk = { data, sequence: chunkSequence, bytes: data.size }
  appendQueue = appendQueue
    .then(() => appendChunkWithAck(chunk))
    .catch((error) => failChunkStream(error))
}

async function appendChunkWithAck(chunk) {
  if (appendError) return null
  const arrayBuffer = await chunk.data.arrayBuffer()
  const ack = await window.recordAPI.appendChunk(sessionId, arrayBuffer, chunk.sequence, chunk.bytes)
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
}

function failChunkStream(error) {
  if (appendError) return
  appendError = error
  setFailureNotice(error?.failureKey || 'record.notice.chunk-failed', error?.failureParams || null)
  errorElement.textContent = describeError(error)
  // Stop pretending the take is healthy: pause immediately and surface the failure.
  if (state === 'recording' && recorder && recorder.state === 'recording') {
    try { recorder.pause() } catch {}
    stopCompositeLoop()
    pausedAt = Date.now()
    setState(transitionRecordingState('recording', 'error'))
    window.recordAPI.setFrameState('paused').catch(() => {})
  }
}

async function startRecorder(fromState) {
  const session = await window.recordAPI.startSession()
  sessionId = session?.id ? String(session.id) : ''
  if (!sessionId) throw new Error(t('record.error.session-start-failed'))
  projectId = session?.projectId ? String(session.projectId) : ''
  appendQueue = Promise.resolve()
  appendError = null
  chunkSequence = 0
  lastAckedSequence = 0
  committedBytes = 0
  chunkFailureAcknowledged = false
  recorder = createMediaRecorder()
  recorder.addEventListener('dataavailable', handleDataAvailable)
  recorder.addEventListener('error', handleRecorderError)
  startCompositeLoop()
  recorder.start(1000)
  startedAt = Date.now()
  pausedAt = 0
  pausedTotal = 0
  clearInterval(clockTimer)
  clockTimer = setInterval(renderClock, 250)
  renderClock()
  setState(transitionRecordingState(fromState, fromState === 'countdown' ? 'countdown-finished' : 'record'))
  await window.recordAPI.setFrameState('recording').catch(() => {})
}

async function stopMediaRecorder() {
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
  await resetAnnotations()
  await window.recordAPI.setFrameState('idle').catch(() => {})
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
  if (busy) return { ok: false, code: 'busy', state: snapshotState() }
  if (!['recording', 'paused', 'stopped'].includes(state)) {
    return { ok: false, code: 'not-recording', state: snapshotState() }
  }
  // A second finish press after a chunk failure is the explicit "keep the written part"
  // acknowledgement required by contract §12 - the first press only surfaces the risk.
  if (state === 'stopped') chunkFailureAcknowledged = true
  setBusy(true)
  await window.recordAPI.setFrameState('hidden').catch(() => {})
  if (state !== 'stopped') {
    stopCompositeLoop()
    await stopMediaRecorder().catch(() => {})
    // Stopping must wait for every pending chunk before asking main to seal the
    // project, otherwise the tail of the recording could be sealed away.
    await appendQueue.catch(() => {})
  }
  setState(transitionRecordingState(state, 'stop'))
  saveProgressElement.textContent = t('record.status.finalizing')
  if (appendError && !chunkFailureAcknowledged) {
    chunkFailureAcknowledged = true
    setState(transitionRecordingState('finalizing', 'failed'))
    setBusy(false)
    saveProgressElement.textContent = ''
    setFailureNotice('record.notice.chunk-failed-retry')
    return { ok: false, code: 'chunk-failed', state: snapshotState() }
  }
  let result = null
  try {
    result = await window.recordAPI.finishSession(sessionId)
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
    setFailureNotice('record.notice.finish-failed', { detail: code || t('record.error.record-failed') })
    return { ok: false, code: code || 'finish-failed', state: snapshotState() }
  }
  projectId = result.projectId ? String(result.projectId) : projectId
  clearInterval(clockTimer)
  // The main process owns navigation from here: it seals the project, opens the
  // editor and closes this control bar. The renderer never opens anything itself.
  setState(transitionRecordingState('finalizing', 'finished'))
  saveProgressElement.textContent = ''
  stopSource()
  setBusy(false)
  return { ok: true, state: snapshotState() }
}

async function cancelRecording() {
  if (busy || !['preparing', 'countdown'].includes(state)) return
  countdownVersion += 1
  stopSource()
  setState(transitionRecordingState(state, 'cancel'))
  setBusy(false)
  await window.recordAPI.setFrameState('idle').catch(() => {})
}

async function confirmDiscard() {
  if (busy || !sessionId) return
  setBusy(true)
  discardConfirm.hidden = true
  await window.recordAPI.setFrameState('hidden').catch(() => {})
  stopCompositeLoop()
  await stopMediaRecorder().catch(() => {})
  await appendQueue.catch(() => {})
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
  clearFeedback()
  timeElement.textContent = '00:00'
  setState(transitionRecordingState(state, 'cancel'))
  setBusy(false)
  await window.recordAPI.setFrameState('idle').catch(() => {})
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
  setState(transitionRecordingState('recording', 'pause'))
  window.recordAPI.setFrameState('paused').catch(() => {})
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
  pausedAt = 0
  setState(transitionRecordingState('paused', 'resume'))
  window.recordAPI.setFrameState('recording').catch(() => {})
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

startButton.addEventListener('click', () => { beginRecording().catch((error) => reportError(error)) })
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
  if (!initData) return
  annotationSnapshot = sanitizeAnnotationSnapshot(snapshot, {
    width: initData.selectionBounds.width,
    height: initData.selectionBounds.height
  })
  renderAnnotationControls()
  requestCompositeFrame()
})
window.recordAPI.onInit((data) => {
  initData = resolveRecordInit(data)
  frameRate = initData.frameRate
  quality = recordingQuality.normalizeQuality(initData.quality)
  countdownSeconds = recordingQuality.normalizeCountdown(initData.countdownSeconds)
  fakeCapture = initData.fakeCapture === true
  audioRequest = {
    system: initData.audio.system !== false,
    microphone: initData.audio.microphone === true,
    microphoneDeviceId: initData.audio.microphoneDeviceId,
    systemGain: initData.audio.systemGain,
    microphoneGain: initData.audio.microphoneGain
  }
  fpsElement.textContent = `${frameRate} FPS`
  fpsElement.title = audioRequest.system || audioRequest.microphone
    ? t('record.audio.contains')
    : t('record.audio.contains-none')
  setState('idle')
  window.recordAPI.setFrameState('idle').catch(() => {})
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
})

addEventListener('beforeunload', () => {
  countdownVersion++
  clearInterval(clockTimer)
  navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
  stopSource()
})

window.recordAPI.ready()
