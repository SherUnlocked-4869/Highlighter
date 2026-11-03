const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildFfmpegArgs,
  calculateFrameBounds,
  calculateRecordControlSize,
  calculateTranscodeProgress,
  calculateCropRect,
  classifyChunkAck,
  createFramePacer,
  formatDuration,
  normalizeFrameRate,
  normalizeSelectionBounds,
  pickDesktopSource,
  primeSeekablePreview,
  reportStatusFor,
  resolveRecordInit,
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

test('paces high-refresh callbacks to the configured recording FPS', () => {
  const pacer = createFramePacer(24)
  let rendered = 0
  for (let frame = 0; frame < 144; frame++) {
    if (pacer.shouldDraw(frame * 1000 / 144)) rendered++
  }

  assert.equal(rendered, 24)
  assert.deepEqual(pacer.snapshot(), {
    frameRate: 24,
    intervalMs: 1000 / 24,
    callbacks: 144,
    renderedFrames: 24,
    skippedCallbacks: 120
  })
})

test('frame pacing resumes without discarding cumulative metrics', () => {
  const pacer = createFramePacer(30)
  assert.equal(pacer.shouldDraw(0), true)
  assert.equal(pacer.shouldDraw(10), false)
  pacer.reset({ keepStats: true })
  assert.equal(pacer.delayUntilNext(500), 0)
  assert.equal(pacer.shouldDraw(500), true)
  assert.equal(pacer.snapshot().renderedFrames, 2)
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
  // R2 control-bar lifecycle (contract §12): preparing/countdown are real states
  // now, and finalizing can either finish or fall back to a retryable stopped state.
  assert.equal(transitionRecordingState('idle', 'start'), 'preparing')
  assert.equal(transitionRecordingState('preparing', 'ready'), 'countdown')
  assert.equal(transitionRecordingState('preparing', 'record'), 'recording')
  assert.equal(transitionRecordingState('preparing', 'fail'), 'idle')
  assert.equal(transitionRecordingState('countdown', 'countdown-finished'), 'recording')
  assert.equal(transitionRecordingState('countdown', 'cancel'), 'idle')
  assert.equal(transitionRecordingState('recording', 'pause'), 'paused')
  assert.equal(transitionRecordingState('paused', 'resume'), 'recording')
  assert.equal(transitionRecordingState('recording', 'stop'), 'finalizing')
  assert.equal(transitionRecordingState('paused', 'stop'), 'finalizing')
  assert.equal(transitionRecordingState('recording', 'error'), 'paused')
  assert.equal(transitionRecordingState('recording', 'cancel'), 'idle')
  assert.equal(transitionRecordingState('finalizing', 'finished'), 'finished')
  assert.equal(transitionRecordingState('finalizing', 'failed'), 'stopped')
  assert.equal(transitionRecordingState('stopped', 'stop'), 'finalizing')
  assert.equal(transitionRecordingState('stopped', 'cancel'), 'idle')
  // P0-1-T5 (S12): the message is an i18n key plus data, because this module also
  // runs under Node with no locale table loaded.
  assert.throws(
    () => transitionRecordingState('idle', 'pause'),
    (error) => error.message === 'record.error.state-transition-invalid'
      && error.i18nParams.from === 'idle'
      && error.i18nParams.to === 'pause'
  )
})

test('classifies every chunk ACK outcome the renderer must distinguish', () => {
  // The main process ACKs the last accepted sequence (contract §5). Only "last + 1"
  // is healthy; a duplicate is a safe replay and a gap is a fatal write failure.
  assert.equal(classifyChunkAck({ sequence: 1, lastChunkSequence: 0 }), 'ok')
  assert.equal(classifyChunkAck({ sequence: 3, lastChunkSequence: 2 }), 'ok')
  assert.equal(classifyChunkAck({ sequence: 3, lastChunkSequence: 3 }), 'duplicate')
  assert.equal(classifyChunkAck({ sequence: 3, lastChunkSequence: 4 }), 'duplicate')
  assert.equal(classifyChunkAck({ sequence: 3, lastChunkSequence: 1 }), 'gap')
  assert.equal(classifyChunkAck({ sequence: 0, lastChunkSequence: 0 }), 'invalid')
  assert.equal(classifyChunkAck({ sequence: 2, lastChunkSequence: -1 }), 'invalid')
  assert.equal(classifyChunkAck({ sequence: 2 }), 'invalid')
  assert.equal(classifyChunkAck(null), 'invalid')
})

test('resolves the record:init payload and keeps the pre-R2 payload working', () => {
  const current = resolveRecordInit({
    sessionId: 'session-1',
    projectId: 'project-1',
    mode: 'display',
    display: {
      id: '2528732444',
      name: 'DISPLAY2',
      boundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
      pixelSize: { width: 1920, height: 1080 },
      scaleFactor: 1
    },
    selectionBounds: { x: 100, y: 50, width: 641, height: 361 },
    frameRate: 60,
    quality: 'high',
    countdownSeconds: 5,
    fakeCapture: true,
    audio: { system: true, microphone: true, microphoneDeviceId: 'device-1', systemGain: 0.5, microphoneGain: 2 }
  })
  assert.equal(current.sessionId, 'session-1')
  assert.equal(current.projectId, 'project-1')
  assert.equal(current.display.id, '2528732444')
  assert.deepEqual(current.displayBounds, { x: 0, y: 0, width: 1920, height: 1080 })
  assert.deepEqual(current.display.pixelSize, { width: 1920, height: 1080 })
  assert.deepEqual(current.selectionBounds, { x: 100, y: 50, width: 641, height: 361 })
  assert.equal(current.frameRate, 60)
  assert.equal(current.quality, 'high')
  assert.equal(current.countdownSeconds, 5)
  assert.equal(current.fakeCapture, true)
  assert.deepEqual(current.audio, {
    system: true,
    microphone: true,
    microphoneDeviceId: 'device-1',
    systemGain: 0.5,
    microphoneGain: 2
  })

  // The pre-R2 init carried flat audio keys and displayBounds instead of display.
  const legacy = resolveRecordInit({
    sourceId: 'screen:1',
    displayBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    selectionBounds: { x: -1900, y: 20, width: 640, height: 361 },
    frameRate: 30,
    audioSystem: false,
    audioMicrophone: true,
    audioSystemGain: 1,
    audioMicrophoneGain: 0.25
  })
  assert.equal(legacy.sourceId, 'screen:1')
  assert.deepEqual(legacy.displayBounds, { x: -1920, y: 0, width: 1920, height: 1080 })
  assert.deepEqual(legacy.audio, {
    system: false,
    microphone: true,
    microphoneDeviceId: '',
    systemGain: 1,
    microphoneGain: 0.25
  })
  assert.equal(legacy.quality, '')
  assert.equal(legacy.countdownSeconds, 3)
  assert.equal(legacy.fakeCapture, false)
  assert.equal(legacy.frameRate, 30)

  // An empty payload must still normalize to a usable, defaulted shape.
  const empty = resolveRecordInit()
  assert.equal(empty.mode, 'display')
  assert.equal(empty.frameRate, 24)
  assert.deepEqual(empty.selectionBounds, { x: 0, y: 0, width: 0, height: 0 })
  assert.equal(empty.audio.system, true)
  assert.equal(empty.audio.microphone, false)
})

test('formats the control-bar timer and maps UI states to wire statuses', () => {
  assert.equal(formatDuration(0), '00:00')
  assert.equal(formatDuration(999), '00:00')
  assert.equal(formatDuration(12_400), '00:12')
  assert.equal(formatDuration(3_661_000), '61:01')
  assert.equal(formatDuration(-5), '00:00')
  // Contract §9.2: only these five status values travel to the main process. A
  // failed finish keeps reporting "paused" (capture really is not running).
  assert.equal(reportStatusFor('preparing'), 'preparing')
  assert.equal(reportStatusFor('countdown'), 'countdown')
  assert.equal(reportStatusFor('recording'), 'recording')
  assert.equal(reportStatusFor('paused'), 'paused')
  assert.equal(reportStatusFor('stopped'), 'paused')
  assert.equal(reportStatusFor('finalizing'), 'finalizing')
  assert.equal(reportStatusFor('idle'), '')
  assert.equal(reportStatusFor('finished'), '')
  assert.equal(reportStatusFor('nonsense'), '')
})


test('builds silent H.264 fast-start MP4 arguments by default', () => {
  const args = buildFfmpegArgs('input.webm', 'output.mp4')
  assert.deepEqual(args.slice(0, 2), ['-i', 'input.webm'])
  for (const token of ['-an', 'libx264', 'yuv420p', '+faststart', 'output.mp4']) {
    assert.ok(args.includes(token), token)
  }
  assert.equal(args.includes('-c:a'), false)
  assert.equal(args.includes('-map'), false)
})

test('keeps the legacy two-argument call byte-identical to an explicit silent export', () => {
  assert.deepEqual(
    buildFfmpegArgs('input.webm', 'output.mp4'),
    buildFfmpegArgs('input.webm', 'output.mp4', { audio: false })
  )
  assert.deepEqual(
    buildFfmpegArgs('input.webm', 'output.mp4'),
    [
      '-i', 'input.webm',
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      '-nostats',
      '-y', 'output.mp4'
    ]
  )
})

test('maps the recorded audio track as AAC when audio is enabled', () => {
  const args = buildFfmpegArgs('input.webm', 'output.mp4', { audio: true })
  assert.deepEqual(args.slice(0, 14), [
    '-i', 'input.webm',
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '48000',
    '-ac', '2'
  ])
  assert.equal(args.includes('-an'), false)
  for (const token of ['libx264', 'yuv420p', '+faststart', 'output.mp4']) {
    assert.ok(args.includes(token), token)
  }
})

test('honours explicit audio encoding options and ignores junk values', () => {
  const custom = buildFfmpegArgs('input.webm', 'output.mp4', {
    audio: true,
    audioBitrate: '96k',
    audioSampleRate: 44100,
    audioChannels: 1
  })
  assert.deepEqual(custom.slice(6, 14), ['-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '1'])
  const fallback = buildFfmpegArgs('input.webm', 'output.mp4', {
    audio: true,
    audioBitrate: '',
    audioSampleRate: 'x',
    audioChannels: 0
  })
  assert.deepEqual(fallback.slice(6, 14), ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'])
  // Non-object third arguments stay on the silent path instead of throwing.
  assert.ok(buildFfmpegArgs('input.webm', 'output.mp4', null).includes('-an'))
  assert.ok(buildFfmpegArgs('input.webm', 'output.mp4', 'audio').includes('-an'))
})
