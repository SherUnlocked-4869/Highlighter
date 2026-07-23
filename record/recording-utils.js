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

  function transitionRecordingState(state, event) {
    const next = TRANSITIONS[state]?.[event]
    if (!next) throw new Error(`非法录制状态转换：${state} -> ${event}`)
    return next
  }

  function buildFfmpegArgs(inputPath, outputPath) {
    return [
      '-i', inputPath,
      '-an',
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
    normalizeFrameRate,
    normalizeSelectionBounds,
    pickDesktopSource,
    transitionRecordingState
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = recordingUtils
  if (globalScope) globalScope.recordingUtils = recordingUtils
})(typeof window !== 'undefined' ? window : null)
