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

  const TRANSITIONS = Object.freeze({
    idle: Object.freeze({ start: 'countdown', cancel: 'cancelled' }),
    countdown: Object.freeze({ 'countdown-finished': 'recording', cancel: 'idle' }),
    recording: Object.freeze({ pause: 'paused', stop: 'preview', cancel: 'cancelled' }),
    paused: Object.freeze({ resume: 'recording', stop: 'preview', cancel: 'cancelled' }),
    preview: Object.freeze({ save: 'saving', rerecord: 'countdown', cancel: 'cancelled' }),
    saving: Object.freeze({ saved: 'saved', 'save-failed': 'preview' })
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
    createFramePacer,
    normalizeFrameRate,
    normalizeSelectionBounds,
    pickDesktopSource,
    primeSeekablePreview,
    transitionRecordingState
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = recordingUtils
  if (globalScope) globalScope.recordingUtils = recordingUtils
})(typeof window !== 'undefined' ? window : null)
