const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildFfmpegArgs,
  calculateFrameBounds,
  calculateRecordControlSize,
  calculateTranscodeProgress,
  calculateCropRect,
  normalizeFrameRate,
  normalizeSelectionBounds,
  pickDesktopSource,
  primeSeekablePreview,
  transitionRecordingState
} = require('../record/recording-utils')

test('primes unknown WebM duration by seeking to the tail and resetting', () => {
  const listeners = new Map()
  const video = {
    currentTime: 0,
    duration: Infinity,
    addEventListener(type, handler) { listeners.set(type, handler) },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type)
    }
  }
  const dispose = primeSeekablePreview(video)
  listeners.get('loadedmetadata')()
  assert.equal(video.currentTime, 1e101)
  video.duration = 12.5
  listeners.get('durationchange')()
  assert.equal(video.currentTime, 0)
  assert.equal(listeners.has('timeupdate'), false)
  dispose()
})

test('places the recording frame entirely outside the captured selection', () => {
  assert.deepEqual(
    calculateFrameBounds({ x: 100, y: 50, width: 641, height: 361 }, 2),
    { x: 98, y: 48, width: 645, height: 365 }
  )
})

test('sizes annotation controls responsively inside the display work area', () => {
  assert.deepEqual(calculateRecordControlSize({ width: 1920 }), { width: 760, height: 86 })
  assert.deepEqual(calculateRecordControlSize({ width: 760 }), { width: 760, height: 86 })
  assert.deepEqual(calculateRecordControlSize({ width: 640 }), { width: 640, height: 126 })
  assert.deepEqual(calculateRecordControlSize({ width: 200 }), { width: 320, height: 126 })
})

test('converts ffmpeg elapsed microseconds to a bounded percentage', () => {
  assert.equal(calculateTranscodeProgress(5_000_000, 10_000), 50)
  assert.equal(calculateTranscodeProgress(15_000_000, 10_000), 99)
  assert.equal(calculateTranscodeProgress(-1, 0), 0)
})

test('normalizes FPS to the supported recording set', () => {
  for (const fps of [5, 16, 24, 30, 60]) assert.equal(normalizeFrameRate(fps), fps)
  assert.equal(normalizeFrameRate(25), 24)
  assert.equal(normalizeFrameRate('60'), 60)
})

test('clips a negative-coordinate selection to one display', () => {
  assert.deepEqual(
    normalizeSelectionBounds(
      { x: -1900, y: 20, width: 640, height: 361 },
      { x: -1920, y: 0, width: 1920, height: 1080 }
    ),
    { x: -1900, y: 20, width: 640, height: 361 }
  )
  assert.deepEqual(
    normalizeSelectionBounds(
      { x: -1930, y: -10, width: 100, height: 100 },
      { x: -1920, y: 0, width: 1920, height: 1080 }
    ),
    { x: -1920, y: 0, width: 90, height: 90 }
  )
  assert.throws(() => normalizeSelectionBounds(
    { x: 0, y: 0, width: 15, height: 100 },
    { x: 0, y: 0, width: 1920, height: 1080 }
  ), /至少为 16/)
})

test('maps DIP selection to even video pixels', () => {
  assert.deepEqual(calculateCropRect(
    { width: 3840, height: 2160 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 100, y: 50, width: 641, height: 361 }
  ), { sx: 200, sy: 100, sw: 1282, sh: 722, width: 1282, height: 722 })
})

test('selects the desktop source matching the display id', () => {
  const sources = [{ display_id: '1', id: 'screen:1' }, { display_id: '2', id: 'screen:2' }]
  assert.equal(pickDesktopSource(sources, 2).id, 'screen:2')
  assert.equal(pickDesktopSource([{ display_id: '', id: 'fallback' }], 9).id, 'fallback')
  assert.equal(pickDesktopSource([], 9), null)
})

test('accepts only declared recording state transitions', () => {
  assert.equal(transitionRecordingState('idle', 'start'), 'countdown')
  assert.equal(transitionRecordingState('countdown', 'countdown-finished'), 'recording')
  assert.equal(transitionRecordingState('recording', 'pause'), 'paused')
  assert.equal(transitionRecordingState('paused', 'resume'), 'recording')
  assert.equal(transitionRecordingState('recording', 'stop'), 'preview')
  assert.equal(transitionRecordingState('preview', 'save'), 'saving')
  assert.equal(transitionRecordingState('saving', 'save-failed'), 'preview')
  assert.throws(() => transitionRecordingState('idle', 'pause'), /非法录制状态转换/)
})

test('builds silent H.264 fast-start MP4 arguments', () => {
  const args = buildFfmpegArgs('input.webm', 'output.mp4')
  assert.deepEqual(args.slice(0, 2), ['-i', 'input.webm'])
  for (const token of ['-an', 'libx264', 'yuv420p', '+faststart', 'output.mp4']) {
    assert.ok(args.includes(token), token)
  }
})
