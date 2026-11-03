(function initRecordingUtils(globalScope) {
  const SUPPORTED_FRAME_RATES = new Set([5, 16, 24, 30, 60])

  function finite(value, fallback = 0) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  function normalizeFrameRate(value) {
    const parsed = finite(value)
    return SUPPORTED_FRAME_RATES.has(parsed) ? parsed : 24
  }

  function createFramePacer(value, options = {}) {
    const frameRate = normalizeFrameRate(value)
    const intervalMs = 1000 / frameRate
    const toleranceMs = Math.max(0, finite(options.toleranceMs, 0.75))
    let nextFrameAt = null
    let callbacks = 0
    let renderedFrames = 0
    let skippedCallbacks = 0

    function shouldDraw(timestamp, force = false) {
      const now = finite(timestamp)
      callbacks++
      if (force || nextFrameAt === null) {
        nextFrameAt = now + intervalMs
        renderedFrames++
        return true
      }
      if (now + toleranceMs < nextFrameAt) {
        skippedCallbacks++
        return false
      }
      do {
        nextFrameAt += intervalMs
      } while (nextFrameAt <= now + toleranceMs)
      renderedFrames++
      return true
    }

    function delayUntilNext(timestamp) {
      if (nextFrameAt === null) return 0
      return Math.max(0, nextFrameAt - finite(timestamp))
    }

    function reset({ keepStats = false } = {}) {
      nextFrameAt = null
      if (!keepStats) {
        callbacks = 0
        renderedFrames = 0
        skippedCallbacks = 0
      }
    }

    function snapshot() {
      return {
        frameRate,
        intervalMs,
        callbacks,
        renderedFrames,
        skippedCallbacks
      }
    }

    return { delayUntilNext, intervalMs, reset, shouldDraw, snapshot }
  }

  function normalizeSelectionBounds(selection = {}, display = {}) {
    const displayX = finite(display.x)
    const displayY = finite(display.y)
    const displayWidth = Math.max(0, finite(display.width))
    const displayHeight = Math.max(0, finite(display.height))
    const selectionX = finite(selection.x)
    const selectionY = finite(selection.y)
    const selectionWidth = Math.max(0, finite(selection.width))
    const selectionHeight = Math.max(0, finite(selection.height))
    const left = Math.max(displayX, selectionX)
    const top = Math.max(displayY, selectionY)
    const right = Math.min(displayX + displayWidth, selectionX + selectionWidth)
    const bottom = Math.min(displayY + displayHeight, selectionY + selectionHeight)
    const result = {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(right - left),
      height: Math.round(bottom - top)
    }
    if (result.width < 16 || result.height < 16) {
      throw new Error('录制区域宽高至少为 16 像素')
    }
    return result
  }

  function even(value) {
    return Math.max(16, Math.floor(finite(value) / 2) * 2)
  }

  function calculateFrameBounds(selection = {}, borderWidth = 2) {
    const border = Math.max(1, Math.round(finite(borderWidth, 2)))
    return {
      x: Math.round(finite(selection.x) - border),
      y: Math.round(finite(selection.y) - border),
      width: Math.max(1, Math.round(finite(selection.width) + border * 2)),
      height: Math.max(1, Math.round(finite(selection.height) + border * 2))
    }
  }

  function calculateRecordControlSize(workArea = {}) {
    const availableWidth = Math.max(320, Math.round(finite(workArea.width, 760)))
    const width = Math.min(760, availableWidth)
    return { width, height: width < 700 ? 126 : 86 }
  }

  function calculateCropRect(video = {}, display = {}, selection = {}) {
    const displayWidth = finite(display.width)
    const displayHeight = finite(display.height)
    if (displayWidth <= 0 || displayHeight <= 0) throw new Error('显示器尺寸无效')
    const scaleX = finite(video.width) / displayWidth
    const scaleY = finite(video.height) / displayHeight
    if (scaleX <= 0 || scaleY <= 0) throw new Error('录制视频尺寸无效')
    const sx = Math.max(0, Math.round((finite(selection.x) - finite(display.x)) * scaleX))
    const sy = Math.max(0, Math.round((finite(selection.y) - finite(display.y)) * scaleY))
    const sw = even(finite(selection.width) * scaleX)
    const sh = even(finite(selection.height) * scaleY)
    return { sx, sy, sw, sh, width: sw, height: sh }
  }

  function calculateTranscodeProgress(elapsedMicroseconds, durationMs) {
    const elapsed = finite(elapsedMicroseconds)
    const duration = finite(durationMs)
    if (elapsed <= 0 || duration <= 0) return 0
    return Math.max(0, Math.min(99, Math.round(elapsed * 100 / (duration * 1000))))
  }

  function primeSeekablePreview(video) {
    if (!video || typeof video.addEventListener !== 'function') return () => {}
    let active = true
    function cleanup() {
      if (!active) return
      active = false
      video.removeEventListener('loadedmetadata', probe)
      video.removeEventListener('durationchange', reset)
      video.removeEventListener('timeupdate', reset)
    }
    function reset() {
      if (!Number.isFinite(Number(video.duration)) || Number(video.duration) <= 0) return
      cleanup()
      video.currentTime = 0
    }
    function probe() {
      if (Number.isFinite(Number(video.duration)) && Number(video.duration) > 0) {
        cleanup()
        return
      }
      video.addEventListener('durationchange', reset)
      video.addEventListener('timeupdate', reset)
      try { video.currentTime = 1e101 } catch { cleanup() }
    }
    video.addEventListener('loadedmetadata', probe, { once: true })
    return cleanup
  }

  function pickDesktopSource(sources, displayId) {
    const list = Array.isArray(sources) ? sources : []
    return list.find((source) => String(source.display_id) === String(displayId)) || list[0] || null
  }

  // Control-bar state machine (contract §12): the capture session moves
  // idle -> preparing -> countdown -> recording <-> paused -> finalizing, with a
  // `stopped` holding state when finalizing failed (finish can be retried) and a
  // terminal `finished` state once the main process has sealed the project.
  // Countdown 0 skips `countdown` via preparing -> recording. `error` pauses a live
  // recording when a chunk write fails; it never pretends the take is still healthy.
  const TRANSITIONS = Object.freeze({
    idle: Object.freeze({ start: 'preparing' }),
    preparing: Object.freeze({ ready: 'countdown', record: 'recording', cancel: 'idle', fail: 'idle' }),
    countdown: Object.freeze({ 'countdown-finished': 'recording', cancel: 'idle' }),
    recording: Object.freeze({ pause: 'paused', stop: 'finalizing', error: 'paused', cancel: 'idle' }),
    paused: Object.freeze({ resume: 'recording', stop: 'finalizing', error: 'paused', cancel: 'idle' }),
    finalizing: Object.freeze({ finished: 'finished', failed: 'stopped' }),
    stopped: Object.freeze({ stop: 'finalizing', cancel: 'idle' }),
    finished: Object.freeze({ cancel: 'idle' })
  })

  // P0-1-T5 (S12): the message is an i18n key and the values travel as data — this
  // module also runs under Node (test/recording-utils.test.js) where no locale table
  // is loaded, so it must not carry a sentence. The caller resolves it with `t()`.
  function transitionRecordingState(state, event) {
    const next = TRANSITIONS[state]?.[event]
    if (!next) {
      const error = new Error('record.error.state-transition-invalid')
      error.i18nParams = { from: state, to: event }
      throw error
    }
    return next
  }

  // `record:state` wire statuses (contract §9.2). UI-only states either map onto the
  // closest wire value (a failed finish is still "not recording") or return '' so the
  // renderer reports nothing for them.
  const REPORT_STATUS = Object.freeze({
    preparing: 'preparing',
    countdown: 'countdown',
    recording: 'recording',
    paused: 'paused',
    stopped: 'paused',
    finalizing: 'finalizing'
  })

  function reportStatusFor(state) {
    return REPORT_STATUS[state] || ''
  }

  // Reverse map for adopting a state the main process pushed (contract §9.2): the wire
  // only knows the five live statuses, the bar also has idle/finished/stopped local ones.
  const WIRE_STATE = Object.freeze({
    preparing: 'preparing',
    countdown: 'countdown',
    recording: 'recording',
    paused: 'paused',
    finalizing: 'finalizing'
  })
  // A lost tray/shortcut command is repaired from the echo of the command's effect: only
  // the pause/resume pair is a command echo the bar can adopt without fighting its own
  // countdown/finalizing transitions.
  const COMMAND_ECHO_STATUSES = Object.freeze(['recording', 'paused'])
  // Boot reconciliation may restore any state in which main still owns a live capture.
  const RECONCILE_STATUSES = Object.freeze(['recording', 'paused', 'finalizing'])

  function localStateForWireStatus(status) {
    return WIRE_STATE[status] || ''
  }

  // Version guard for a main-process state push (record:state-changed) or a boot pull
  // (record:get-state). A push is usable only when:
  //   * it carries a real status and a NEWER stateVersion than the bar (stale echoes are
  //     ignored, so the local state machine is never rolled back);
  //   * the bar is not busy / mid-transition (preparing/countdown/finalizing are locally
  //     driven and must not be overwritten);
  //   * it is a command echo (local and wire status are the live pause/resume pair) or a
  //     boot reconciliation (the bar is still idle but main believes a capture exists).
  function shouldAdoptMainState(options = {}) {
    const source = options && typeof options === 'object' ? options : {}
    const mainState = source.mainState && typeof source.mainState === 'object' ? source.mainState : null
    if (!mainState) return false
    const wireStatus = typeof mainState.status === 'string' ? mainState.status : ''
    if (!localStateForWireStatus(wireStatus)) return false
    const nextVersion = Number(mainState.stateVersion)
    if (!Number.isInteger(nextVersion) || nextVersion < 1) return false
    const localVersion = Math.round(Number(source.localStateVersion) || 0)
    if (!Number.isFinite(localVersion) || nextVersion <= localVersion) return false
    const localState = typeof source.localState === 'string' ? source.localState : ''
    if (source.reconciliation === true) {
      // "The renderer is idle but main still holds a capture": restore the bar's view.
      return localState === 'idle' && RECONCILE_STATUSES.includes(wireStatus)
    }
    if (source.busy === true) return false
    return COMMAND_ECHO_STATUSES.includes(localState) && COMMAND_ECHO_STATUSES.includes(wireStatus)
  }

  function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(finite(milliseconds) / 1000))
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }

  // Chunk sequences start at 1 and are strictly increasing (contract §5). The ACK
  // carries the main process' last accepted sequence; the renderer treats a gap as a
  // fatal write failure (paused + surfaced error) instead of continuing to pretend.
  function classifyChunkAck(ack = {}) {
    const source = ack && typeof ack === 'object' ? ack : {}
    const sent = Number(source.sequence)
    const acked = Number(source.lastChunkSequence)
    if (!Number.isInteger(sent) || sent < 1) return 'invalid'
    if (!Number.isInteger(acked) || acked < 0) return 'invalid'
    if (acked >= sent) return 'duplicate'
    if (acked === sent - 1) return 'ok'
    return 'gap'
  }

  let requestCounter = 0

  // Local command ids for button presses; pushed (tray/shortcut) commands carry a
  // main-process id instead. Uniqueness only has to hold for one control-bar lifetime.
  function createRequestId(prefix = 'local') {
    requestCounter += 1
    return `${prefix}-${Date.now().toString(36)}-${requestCounter.toString(36)}`
  }

  // Command arbitration (contract §9.2): every command - button, tray or shortcut -
  // lands on one dispatcher. A repeated requestId returns the first result, so a
  // double key-press cannot toggle pause twice; handlers own the state checks and
  // return `{ ok, state, code }`.
  function createCommandDispatcher(options = {}) {
    const source = options && typeof options === 'object' ? options : {}
    const handlers = source.handlers && typeof source.handlers === 'object' ? source.handlers : {}
    const maxRemembered = Number.isInteger(source.maxRemembered) && source.maxRemembered > 0
      ? source.maxRemembered
      : 64
    const remembered = new Map()

    function remember(requestId, result) {
      remembered.set(requestId, result)
      if (remembered.size > maxRemembered) {
        const oldest = remembered.keys().next().value
        if (oldest !== undefined) remembered.delete(oldest)
      }
      return result
    }

    function dispatch(request = {}) {
      const payload = request && typeof request === 'object' ? request : {}
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
      const command = typeof payload.command === 'string' ? payload.command : ''
      if (!requestId) return Promise.resolve({ ok: false, code: 'invalid-request' })
      if (remembered.has(requestId)) return remembered.get(requestId)
      const handler = handlers[command]
      if (typeof handler !== 'function') {
        return remember(requestId, Promise.resolve({ ok: false, code: 'unsupported-command' }))
      }
      let result
      try {
        result = Promise.resolve(handler(payload.value, command, payload))
      } catch (error) {
        result = Promise.resolve({ ok: false, code: 'command-failed', detail: String(error?.message || error) })
      }
      const normalized = result.then(
        (value) => (value && typeof value === 'object' ? value : { ok: true }),
        () => ({ ok: false, code: 'command-failed' })
      )
      return remember(requestId, normalized)
    }

    return { dispatch, has: (requestId) => remembered.has(requestId), size: () => remembered.size }
  }

  function isRecordObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  function normalizeBounds(value) {
    const source = isRecordObject(value) ? value : {}
    return {
      x: Math.round(finite(source.x)),
      y: Math.round(finite(source.y)),
      width: Math.max(0, Math.round(finite(source.width))),
      height: Math.max(0, Math.round(finite(source.height)))
    }
  }

  function text(value, fallback = '') {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    return trimmed || fallback
  }

  // Normalized `record:init` payload (contract §9.2). `record.js` owns the DOM, so
  // the shape read here is the one place the control bar can be wrong about its own
  // configuration; it also accepts the pre-R2 payload (flat audio keys / displayBounds)
  // while the main process and this renderer land in separate workstreams. New fields
  // always win over the legacy fallbacks.
  function resolveRecordInit(data = {}) {
    const raw = isRecordObject(data) ? data : {}
    const display = isRecordObject(raw.display) ? raw.display : null
    const legacyBounds = normalizeBounds(raw.displayBounds)
    const displayBounds = display && isRecordObject(display.boundsDip)
      ? normalizeBounds(display.boundsDip)
      : legacyBounds
    const pixelSize = display && isRecordObject(display.pixelSize)
      ? {
          width: Math.max(0, Math.round(finite(display.pixelSize.width))),
          height: Math.max(0, Math.round(finite(display.pixelSize.height)))
        }
      : null
    const audio = isRecordObject(raw.audio)
      ? {
          system: raw.audio.system !== false,
          microphone: raw.audio.microphone === true,
          microphoneDeviceId: text(raw.audio.microphoneDeviceId),
          systemGain: raw.audio.systemGain,
          microphoneGain: raw.audio.microphoneGain
        }
      : {
          system: raw.audioSystem !== false,
          microphone: raw.audioMicrophone === true,
          microphoneDeviceId: text(raw.audioMicrophoneDeviceId),
          systemGain: raw.audioSystemGain,
          microphoneGain: raw.audioMicrophoneGain
        }
    return {
      sessionId: text(raw.sessionId),
      projectId: text(raw.projectId),
      mode: text(raw.mode, 'display'),
      display: display
        ? {
            id: text(display.id),
            name: text(display.name),
            boundsDip: displayBounds,
            pixelSize,
            scaleFactor: Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1
          }
        : null,
      displayBounds,
      selectionBounds: isRecordObject(raw.selectionBounds)
        ? normalizeBounds(raw.selectionBounds)
        : displayBounds,
      sourceId: text(raw.sourceId),
      frameRate: normalizeFrameRate(raw.frameRate),
      quality: text(raw.quality),
      countdownSeconds: raw.countdownSeconds !== undefined
        ? raw.countdownSeconds
        : (raw.countdown !== undefined ? raw.countdown : 3),
      // E2E-only synthetic capture source (contract §13.5). The main process sets this
      // only from HIGHLIGHTER_E2E_FAKE_CAPTURE=1; a renderer cannot enable it itself.
      fakeCapture: raw.fakeCapture === true,
      audio
    }
  }

  // Audio defaults mirror the frozen record settings contract: system sound on, AAC 160 kbps
  // at 48 kHz stereo. `audio:false` (and the legacy two-argument call) keeps the silent `-an`
  // path, so every existing caller stays byte-compatible.
  const AUDIO_ARG_DEFAULTS = Object.freeze({
    audio: false,
    audioBitrate: '160k',
    audioSampleRate: 48000,
    audioChannels: 2
  })

  function normalizeAudioArgs(options) {
    const source = options && typeof options === 'object' ? options : {}
    const bitrate = typeof source.audioBitrate === 'string' && source.audioBitrate.trim()
      ? source.audioBitrate.trim()
      : AUDIO_ARG_DEFAULTS.audioBitrate
    const sampleRate = Number(source.audioSampleRate)
    const channels = Number(source.audioChannels)
    return {
      audio: source.audio === true,
      audioBitrate: bitrate,
      audioSampleRate: Number.isFinite(sampleRate) && sampleRate > 0
        ? Math.round(sampleRate)
        : AUDIO_ARG_DEFAULTS.audioSampleRate,
      audioChannels: Number.isFinite(channels) && channels > 0
        ? Math.round(channels)
        : AUDIO_ARG_DEFAULTS.audioChannels
    }
  }

  function audioArgs(audio) {
    if (!audio.audio) return ['-an']
    // `0:a?` keeps a silent recording valid if the WebM carried no audio track.
    return [
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:a', 'aac',
      '-b:a', audio.audioBitrate,
      '-ar', String(audio.audioSampleRate),
      '-ac', String(audio.audioChannels)
    ]
  }

  function buildFfmpegArgs(inputPath, outputPath, options) {
    const audio = normalizeAudioArgs(options)
    return [
      '-i', inputPath,
      ...audioArgs(audio),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      '-nostats',
      '-y', outputPath
    ]
  }

  const recordingUtils = {
    buildFfmpegArgs,
    calculateCropRect,
    calculateFrameBounds,
    calculateRecordControlSize,
    calculateTranscodeProgress,
    classifyChunkAck,
    createCommandDispatcher,
    createFramePacer,
    createRequestId,
    formatDuration,
    localStateForWireStatus,
    normalizeFrameRate,
    normalizeSelectionBounds,
    pickDesktopSource,
    primeSeekablePreview,
    reportStatusFor,
    resolveRecordInit,
    shouldAdoptMainState,
    transitionRecordingState
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = recordingUtils
  if (globalScope) globalScope.recordingUtils = recordingUtils
})(typeof window !== 'undefined' ? window : null)
