const {
  calculateCropRect,
  createFramePacer,
  primeSeekablePreview,
  transitionRecordingState
} = window.recordingUtils
const {
  ANNOTATION_COLORS,
  ANNOTATION_WIDTHS,
  clearAnnotationSnapshot,
  drawAnnotationSnapshot,
  sanitizeAnnotationSnapshot
} = window.annotationUtils

const controlView = document.getElementById('controlView')
const previewView = document.getElementById('previewView')
const timeElement = document.getElementById('time')
const statusLabel = document.getElementById('statusLabel')
const fpsElement = document.getElementById('fps')
const countdownElement = document.getElementById('countdown')
const startButton = document.getElementById('start')
const pauseButton = document.getElementById('pause')
const stopButton = document.getElementById('stop')
const cancelButton = document.getElementById('cancel')
const preview = document.getElementById('preview')
const previewDuration = document.getElementById('previewDuration')
const saveButton = document.getElementById('saveMp4')
const rerecordButton = document.getElementById('rerecord')
const closePreviewButton = document.getElementById('closePreview')
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
let state = 'idle'
let busy = false
let desktopStream = null
let canvasStream = null
// Audio bus state (P0-3). `audioRequest` mirrors the frozen record settings contract:
// system sound defaults to on, the microphone defaults to off (privacy first).
let audioRequest = { system: true, microphone: false, systemGain: 1, microphoneGain: 1 }
let audioOutcome = { system: false, microphone: false }
let audioMix = null
let micStream = null
let audioMixerPromise = null
let audioWarnings = []
// The audio degradation notice is stored as a key plus optional params, not as a
// sentence: renderStatus() resolves it in the active language, so a language
// switch no longer leaves the notice in the language it was captured in.
let audioNoticeKey = ''
let audioNoticeParams = null
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
let sessionId = null
let appendQueue = Promise.resolve()
let appendError = null
let startedAt = 0
let pausedAt = 0
let pausedTotal = 0
let clockTimer = 0
let durationMs = 0
let countdownVersion = 0
let disposePreviewProbe = () => {}
let annotationTool = 'pointer'
let annotationColor = '#ff3b30'
let annotationWidth = 4
let annotationSnapshot = clearAnnotationSnapshot()
let annotationResetVersion = 0

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function elapsedTime() {
  if (!startedAt) return 0
  const activePause = pausedAt ? Date.now() - pausedAt : 0
  return Math.max(0, Date.now() - startedAt - pausedTotal - activePause)
}

function renderClock() {
  timeElement.textContent = formatDuration(elapsedTime())
}

function setBusy(value) {
  busy = !!value
  startButton.disabled = busy
  pauseButton.disabled = busy
  stopButton.disabled = busy
  saveButton.disabled = busy
  rerecordButton.disabled = busy
  cancelButton.disabled = busy && state !== 'countdown'
  closePreviewButton.disabled = busy
  renderAnnotationControls()
}

function annotationEnabled() {
  return !busy && ['recording', 'paused'].includes(state)
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

// P0-1-T5 (S12): the table holds i18n keys, not sentences, so a language switch
// re-renders the current state without restarting the recording.
const STATUS_LABELS = {
  idle: 'record.status.idle',
  countdown: 'record.status.countdown',
  recording: 'record.status.recording',
  paused: 'record.status.paused',
  preview: 'record.status.preview',
  saving: 'record.status.saving'
}

// The audio degradation notice (microphone lost, no microphone, silent recording ...) is
// appended to whatever the state label shows, so it stays visible while recording.
function renderStatus() {
  statusLabel.removeAttribute('title')
  const key = STATUS_LABELS[state]
  if (!key) return
  const label = t(key)
  const notice = audioNoticeKey ? t(audioNoticeKey, audioNoticeParams) : ''
  statusLabel.textContent = notice ? `${label} · ${notice}` : label
  if (notice) statusLabel.title = notice
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

function noteAudioWarning(warning) {
  if (warning) audioWarnings.push(warning)
}

function setState(nextState) {
  state = nextState
  document.body.dataset.state = state
  startButton.hidden = state !== 'idle'
  pauseButton.hidden = !['recording', 'paused'].includes(state)
  stopButton.hidden = !['recording', 'paused'].includes(state)
  countdownElement.hidden = state !== 'countdown'
  pauseButton.textContent = t(state === 'paused' ? 'record.control.resume' : 'record.control.pause')
  renderStatus()
  renderAnnotationControls()
}

function reportError(error) {
  // recording-utils.js reports failures as keys plus data so it can run headless.
  const key = error?.i18nParams ? error.message : ''
  const message = key
    ? t(key, error.i18nParams)
    : (error?.message || String(error || t('record.error.record-failed')))
  errorElement.textContent = message
  statusLabel.textContent = message
  statusLabel.title = message
}

function clearFeedback() {
  errorElement.textContent = ''
  saveProgressElement.textContent = ''
}

function stopSource() {
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
  framePacer.reset({ keepStats: compositorActiveDurationMs > 0 })
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
    // `pickDesktopSource` (record/recording-utils.js:163) — see the wiring note in the report.
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

async function acquireMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      video: false
    })
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop())
      noteAudioWarning({ code: 'record.audio.warning.microphone-track-missing' })
      return null
    }
    return stream
  } catch (error) {
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
}

async function attachAudioTracks() {
  audioWarnings = []
  setAudioNotice('')
  // The renderer request is the contract: when system sound is off, drop any loopback track
  // the handler may still have attached so a silent recording really has no audio track.
  if (!audioRequest.system && desktopStream) {
    desktopStream.getAudioTracks().forEach((track) => track.stop())
  }
  if (!audioRequest.system && !audioRequest.microphone) {
    applyAudioOutcome({ system: false, microphone: false, notice: '' })
    return
  }
  const systemCaptured = audioRequest.system && desktopStream?.getAudioTracks().length > 0
  if (audioRequest.microphone) micStream = await acquireMicrophone()
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
    desktopStream = await acquireDesktopStream()
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
  const options = { videoBitsPerSecond: 8_000_000 }
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
    if (state !== 'idle' && state !== 'preview') return
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

async function startRecorder() {
  const session = await window.recordAPI.startSession()
  sessionId = session.id
  appendQueue = Promise.resolve()
  appendError = null
  recorder = createMediaRecorder()
  recorder.addEventListener('dataavailable', (event) => {
    if (!event.data?.size) return
    appendQueue = appendQueue
      .then(async () => window.recordAPI.appendChunk(sessionId, await event.data.arrayBuffer()))
      .catch((error) => { appendError = appendError || error })
  })
  recorder.addEventListener('error', (event) => {
    appendError = appendError || new Error(t('record.warn.video-failed', {
      detail: event.error?.message || t('record.warn.mediarecorder')
    }))
  })
  startCompositeLoop()
  recorder.start(1000)
  startedAt = Date.now()
  pausedAt = 0
  pausedTotal = 0
  durationMs = 0
  clearInterval(clockTimer)
  clockTimer = setInterval(renderClock, 250)
  renderClock()
  setState(transitionRecordingState('countdown', 'countdown-finished'))
  await window.recordAPI.setFrameState('recording')
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
  await window.recordAPI.setFrameState('idle')
  await prepareSource()
  if (version !== countdownVersion || state !== 'countdown') {
    stopSource()
    return
  }
  for (const value of [3, 2, 1]) {
    countdownElement.textContent = String(value)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (version !== countdownVersion || state !== 'countdown') return
  }
  await startRecorder()
  setBusy(false)
}

async function beginRecording() {
  if (busy || state !== 'idle') return
  setState(transitionRecordingState(state, 'start'))
  try {
    await runCountdown()
  } catch (error) {
    if (sessionId) await window.recordAPI.cancelSession(sessionId).catch(() => {})
    sessionId = null
    stopSource()
    setState('idle')
    setBusy(false)
    reportError(error)
  }
}

async function finishRecording() {
  if (busy || !['recording', 'paused'].includes(state)) return
  setBusy(true)
  await window.recordAPI.setFrameState('hidden')
  durationMs = elapsedTime()
  stopCompositeLoop()
  await stopMediaRecorder()
  await appendQueue
  if (appendError) {
    // The queue can also reject with a bare IPC error, which carries no wording.
    if (!appendError.message) appendError = new Error(t('record.warn.video-failed', { detail: t('record.warn.mediarecorder') }))
    throw appendError
  }
  const result = await window.recordAPI.finishSession(sessionId)
  clearInterval(clockTimer)
  stopSource()
  setState(transitionRecordingState(state, 'stop'))
  await window.recordAPI.resizePreview()
  controlView.hidden = true
  previewView.hidden = false
  previewDuration.textContent = formatDuration(durationMs)
  disposePreviewProbe()
  preview.src = result.previewUrl
  disposePreviewProbe = primeSeekablePreview(preview)
  preview.load()
  setBusy(false)
}

async function failRecording(error) {
  stopCompositeLoop()
  if (sessionId) await window.recordAPI.cancelSession(sessionId).catch(() => {})
  sessionId = null
  clearInterval(clockTimer)
  stopSource()
  await window.recordAPI.setFrameState('hidden').catch(() => {})
  setState('idle')
  setBusy(false)
  reportError(error)
}

async function cancelRecording() {
  if (state === 'countdown') {
    countdownVersion++
    stopSource()
    setState(transitionRecordingState(state, 'cancel'))
    setBusy(false)
    return
  }
  if (['recording', 'paused'].includes(state)) {
    setBusy(true)
    state = transitionRecordingState(state, 'cancel')
    await window.recordAPI.setFrameState('hidden').catch(() => {})
    stopCompositeLoop()
    await stopMediaRecorder().catch(() => {})
    await appendQueue
    if (sessionId) await window.recordAPI.cancelSession(sessionId).catch(() => {})
    sessionId = null
    stopSource()
  }
  window.recordAPI.close()
}

function togglePause() {
  if (busy || !recorder) return
  if (state === 'recording' && recorder.state === 'recording') {
    recorder.pause()
    stopCompositeLoop()
    pausedAt = Date.now()
    setState(transitionRecordingState(state, 'pause'))
    window.recordAPI.setFrameState('paused')
  } else if (state === 'paused' && recorder.state === 'paused') {
    recorder.resume()
    startCompositeLoop()
    pausedTotal += Date.now() - pausedAt
    pausedAt = 0
    setState(transitionRecordingState(state, 'resume'))
    window.recordAPI.setFrameState('recording')
  }
}

async function saveMp4() {
  if (busy || state !== 'preview') return
  setState(transitionRecordingState(state, 'save'))
  setBusy(true)
  clearFeedback()
  try {
    const outputPath = await window.recordAPI.saveMp4(sessionId, durationMs)
    if (!outputPath) {
      setState(transitionRecordingState(state, 'save-failed'))
      setBusy(false)
      return
    }
    state = transitionRecordingState(state, 'saved')
    window.recordAPI.close()
  } catch (error) {
    setState(transitionRecordingState(state, 'save-failed'))
    setBusy(false)
    reportError(error)
  }
}

async function rerecord() {
  if (busy || state !== 'preview') return
  setBusy(true)
  clearFeedback()
  try {
    await window.recordAPI.restart(sessionId)
  } catch (error) {
    setState('preview')
    setBusy(false)
    reportError(error)
    return
  }
  try {
    sessionId = null
    disposePreviewProbe()
    disposePreviewProbe = () => {}
    preview.pause()
    preview.removeAttribute('src')
    preview.load()
    previewView.hidden = true
    controlView.hidden = false
    timeElement.textContent = '00:00'
    setState(transitionRecordingState(state, 'rerecord'))
    await runCountdown()
  } catch (error) {
    if (sessionId) await window.recordAPI.cancelSession(sessionId).catch(() => {})
    sessionId = null
    stopSource()
    await window.recordAPI.setFrameState('idle').catch(() => {})
    setState('idle')
    setBusy(false)
    reportError(error)
  }
}

startButton.addEventListener('click', beginRecording)
pauseButton.addEventListener('click', togglePause)
stopButton.addEventListener('click', () => finishRecording().catch(failRecording))
cancelButton.addEventListener('click', () => cancelRecording().catch(failRecording))
saveButton.addEventListener('click', saveMp4)
rerecordButton.addEventListener('click', rerecord)
closePreviewButton.addEventListener('click', () => window.recordAPI.close())

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

window.recordAPI.onSaveProgress((percent) => {
  saveProgressElement.textContent = t('record.save.progress', {
    percent: Math.max(0, Math.min(100, Number(percent) || 0))
  })
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
  initData = data
  frameRate = Number(data.frameRate) || 24
  // Frozen settings contract (main/services/settings-defaults.js:68-76): system sound is on
  // unless explicitly disabled, the microphone is off unless explicitly enabled. Missing keys
  // degrade to those same defaults, so this file stays correct before the init payload is
  // extended (see the wiring note in the report).
  audioRequest = {
    system: data.audioSystem !== false,
    microphone: data.audioMicrophone === true,
    systemGain: data.audioSystemGain,
    microphoneGain: data.audioMicrophoneGain
  }
  fpsElement.textContent = `${frameRate} FPS`
  fpsElement.title = audioRequest.system || audioRequest.microphone
    ? t('record.audio.contains')
    : t('record.audio.contains-none')
  setState('idle')
  window.recordAPI.setFrameState('idle')
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
})

addEventListener('beforeunload', () => {
  countdownVersion++
  clearInterval(clockTimer)
  disposePreviewProbe()
  navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
  stopSource()
})

window.recordAPI.ready()
