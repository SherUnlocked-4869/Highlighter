const {
  calculateCropRect,
  transitionRecordingState
} = window.recordingUtils

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

let initData = null
let frameRate = 24
let state = 'idle'
let busy = false
let desktopStream = null
let canvasStream = null
let sourceVideo = null
let canvas = null
let drawRequest = 0
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
}

function setState(nextState) {
  state = nextState
  document.body.dataset.state = state
  startButton.hidden = state !== 'idle'
  pauseButton.hidden = !['recording', 'paused'].includes(state)
  stopButton.hidden = !['recording', 'paused'].includes(state)
  countdownElement.hidden = state !== 'countdown'
  pauseButton.textContent = state === 'paused' ? '继续' : '暂停'
  const labels = {
    idle: '区域已就绪',
    countdown: '即将开始',
    recording: '正在录制',
    paused: '录制已暂停',
    preview: '录制完成',
    saving: '正在生成 MP4'
  }
  statusLabel.textContent = labels[state] || statusLabel.textContent
  statusLabel.removeAttribute('title')
}

function reportError(error) {
  const message = error?.message || String(error || '录制失败')
  errorElement.textContent = message
  statusLabel.textContent = message
  statusLabel.title = message
}

function clearFeedback() {
  errorElement.textContent = ''
  saveProgressElement.textContent = ''
}

function stopSource() {
  if (drawRequest) cancelAnimationFrame(drawRequest)
  drawRequest = 0
  canvasStream?.getTracks().forEach((track) => track.stop())
  desktopStream?.getTracks().forEach((track) => track.stop())
  if (sourceVideo) sourceVideo.srcObject = null
  canvasStream = null
  desktopStream = null
  sourceVideo = null
  canvas = null
}

function waitForMetadata(video) {
  if (video.readyState >= 1 && video.videoWidth && video.videoHeight) return Promise.resolve()
  return new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true })
    video.addEventListener('error', () => reject(new Error('无法读取桌面视频尺寸')), { once: true })
  })
}

async function prepareSource() {
  if (desktopStream && canvasStream) return
  try {
    desktopStream = await navigator.mediaDevices.getUserMedia({
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
    const context = canvas.getContext('2d', { alpha: false })
    const draw = () => {
      context.drawImage(sourceVideo, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.width, crop.height)
      drawRequest = requestAnimationFrame(draw)
    }
    draw()
    canvasStream = canvas.captureStream(frameRate)
  } catch (error) {
    stopSource()
    throw new Error(`无法获取桌面录制画面：${error.message || error}`)
  }
}

function createMediaRecorder() {
  const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || ''
  try {
    return new MediaRecorder(canvasStream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined)
  } catch (error) {
    throw new Error(`无法创建无声视频录制器：${error.message || error}`)
  }
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
    appendError = appendError || new Error(`视频录制失败：${event.error?.message || 'MediaRecorder 错误'}`)
  })
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
  durationMs = elapsedTime()
  await stopMediaRecorder()
  await appendQueue
  if (appendError) throw appendError
  const result = await window.recordAPI.finishSession(sessionId)
  clearInterval(clockTimer)
  stopSource()
  setState(transitionRecordingState(state, 'stop'))
  await window.recordAPI.setFrameState('hidden')
  await window.recordAPI.resizePreview()
  controlView.hidden = true
  previewView.hidden = false
  previewDuration.textContent = formatDuration(durationMs)
  preview.src = result.previewUrl
  preview.load()
  setBusy(false)
}

async function failRecording(error) {
  if (sessionId) await window.recordAPI.cancelSession(sessionId).catch(() => {})
  sessionId = null
  clearInterval(clockTimer)
  stopSource()
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
    pausedAt = Date.now()
    setState(transitionRecordingState(state, 'pause'))
    window.recordAPI.setFrameState('paused')
  } else if (state === 'paused' && recorder.state === 'paused') {
    recorder.resume()
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
    preview.pause()
    preview.removeAttribute('src')
    preview.load()
    previewView.hidden = true
    controlView.hidden = false
    timeElement.textContent = '00:00'
    setState(transitionRecordingState(state, 'rerecord'))
    await runCountdown()
  } catch (error) {
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

window.recordAPI.onSaveProgress((percent) => {
  saveProgressElement.textContent = `正在生成 MP4 · ${Math.max(0, Math.min(100, Number(percent) || 0))}%`
})
window.recordAPI.onInit((data) => {
  initData = data
  frameRate = Number(data.frameRate) || 24
  fpsElement.textContent = `${frameRate} FPS`
  setState('idle')
  window.recordAPI.setFrameState('idle')
})

addEventListener('beforeunload', () => {
  countdownVersion++
  clearInterval(clockTimer)
  stopSource()
})

window.recordAPI.ready()
