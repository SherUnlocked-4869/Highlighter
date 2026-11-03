'use strict'

// Behaviour tests for the frozen R4 export contract v2
// (docs/plans/2026-11-03-recording-r4-contracts.md §4): multi-segment selection, resolution/
// quality/fps normalisation, the WebM copy fast path, ffmpeg assembly and the published-file
// expectations. These are pure value/argv tests - no ffmpeg is spawned here; the real-encoder
// coverage lives in test/recording-export.test.js and test/recording-project-integration.test.js.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const options = require('../shared/recording-export-options')

const METADATA = {
  durationMs: 5000,
  video: { width: 1920, height: 1080, frameRate: 30 },
  audio: { exists: true }
}

function normalize(request, metadata = METADATA) {
  return options.normalizeExportRequest(request, metadata)
}

test('the frozen v2 constants are exported for the main process and the editor UI', () => {
  assert.deepEqual([...options.EXPORT_FORMATS], ['mp4', 'gif', 'webm'])
  assert.deepEqual({ ...options.RESOLUTION_PRESETS }, { '1080p': 1920, '720p': 1280, '480p': 854 })
  assert.deepEqual([...options.RESOLUTIONS], ['source', '1080p', '720p', '480p'])
  assert.deepEqual([...options.VIDEO_QUALITY_LEVELS], ['standard', 'high', 'ultra'])
  assert.deepEqual([...options.VIDEO_FRAME_RATES], [30, 60])
  assert.equal(options.MAX_SEGMENTS, 20)
  assert.equal(options.LIMITS.MAX_SEGMENTS, 20)
  assert.equal(options.LIMITS.MIN_SEGMENT_MS, options.LIMITS.MIN_RANGE_MS)
  assert.deepEqual({ ...options.DEFAULT_VIDEO }, { resolution: 'source', quality: 'standard', fps: 'source' })
  assert.deepEqual({ ...options.VIDEO_CRF.mp4 }, { standard: 28, high: 23, ultra: 18 })
  assert.deepEqual({ ...options.VIDEO_CRF.webm }, { standard: 34, high: 28, ultra: 22 })
})

test('computeVideoOutput treats presets as long-edge caps and never upscales', () => {
  // 720p from 1920x1080: long edge 1280 -> 1280x720.
  assert.deepEqual(options.computeVideoOutput({ sourceWidth: 1920, sourceHeight: 1080, resolution: '720p' }).value, {
    resolution: '720p', width: 1280, height: 720, scale: 1280 / 1920, upscaled: false
  })
  // 480p from 1280x720: cap 854 -> 854x480 (even).
  const small = options.computeVideoOutput({ sourceWidth: 1280, sourceHeight: 720, resolution: '480p' }).value
  assert.deepEqual([small.width, small.height], [854, 480])
  // A preset larger than the source is the identity (no upscale).
  assert.deepEqual(
    options.computeVideoOutput({ sourceWidth: 320, sourceHeight: 240, resolution: '720p' }).value,
    { resolution: '720p', width: 320, height: 240, scale: 1, upscaled: false }
  )
  // 'source' keeps the frame; odd sizes are rounded to the nearest even dimension (codec requirement).
  assert.deepEqual(
    options.computeVideoOutput({ sourceWidth: 1280, sourceHeight: 720, resolution: 'source' }).value,
    { resolution: 'source', width: 1280, height: 720, scale: 1, upscaled: false }
  )
  assert.deepEqual(
    [options.computeVideoOutput({ sourceWidth: 641, sourceHeight: 361, resolution: 'source' }).value.width,
      options.computeVideoOutput({ sourceWidth: 641, sourceHeight: 361, resolution: 'source' }).value.height],
    [642, 362]
  )
  assert.equal(options.computeVideoOutput({ sourceWidth: 0, sourceHeight: 0, resolution: 'source' }).code, 'invalid-source-size')
  assert.equal(options.computeVideoOutput({ sourceWidth: 800, sourceHeight: 600, resolution: '4k' }).code, 'invalid-video-option')
})

test('normalizeSegments sorts, allows touching ranges and rejects illegal selections', () => {
  const sorted = options.normalizeSegments([
    { startMs: 1200, endMs: 1800 },
    { startMs: 0, endMs: 600 }
  ], 5000)
  assert.equal(sorted.ok, true)
  assert.deepEqual(sorted.value.segments, [{ startMs: 0, endMs: 600 }, { startMs: 1200, endMs: 1800 }])
  assert.equal(sorted.value.totalDurationMs, 1200)

  // Adjacent segments are legal and never merged (the cut point must stay visible).
  const touching = options.normalizeSegments([{ startMs: 0, endMs: 500 }, { startMs: 500, endMs: 900 }], 5000)
  assert.equal(touching.ok, true)
  assert.deepEqual(touching.value.segments, [{ startMs: 0, endMs: 500 }, { startMs: 500, endMs: 900 }])

  // Empty array = whole recording (contract §4.1) and is canonicalised to [0,duration].
  const whole = options.normalizeSegments([], 5000)
  assert.deepEqual(whole.value.segments, [{ startMs: 0, endMs: 5000 }])
  assert.equal(whole.value.totalDurationMs, 5000)

  assert.equal(options.normalizeSegments([
    { startMs: 0, endMs: 1000 },
    { startMs: 900, endMs: 1500 }
  ], 5000).code, 'overlapping-segments')
  assert.equal(options.normalizeSegments([{ startMs: 0, endMs: 50 }], 5000).code, 'range-too-short')
  assert.equal(options.normalizeSegments([{ startMs: 0, endMs: 6000 }], 5000).code, 'range-out-of-bounds')
  // One millisecond of float slack is clamped, not rejected.
  assert.deepEqual(options.normalizeSegments([{ startMs: 0, endMs: 5001 }], 5000).value.segments, [{ startMs: 0, endMs: 5000 }])
  assert.equal(options.normalizeSegments([{ startMs: 900, endMs: 800 }], 5000).code, 'invalid-range')
  assert.equal(options.normalizeSegments([null], 5000).code, 'invalid-range')
  assert.equal(options.normalizeSegments('nope', 5000).code, 'invalid-range')
  const tooMany = Array.from({ length: 21 }, (_value, index) => ({ startMs: index * 200, endMs: index * 200 + 150 }))
  assert.equal(options.normalizeSegments(tooMany, 5000).code, 'too-many-segments')
  assert.equal(options.normalizeSegments([{ startMs: 0, endMs: 600 }], 0).code, 'duration-unavailable')
})

test('normalizeExportRequest rejects ambiguous selections and applies video defaults', () => {
  assert.equal(normalize({ format: 'mp4', segments: [], range: { startMs: 0, endMs: 1000 } }).code, 'ambiguous-selection')
  assert.equal(normalize({ format: 'webp' }).code, 'unsupported-format')
  assert.equal(options.normalizeExportRequest({ format: 'mp4' }, { durationMs: 0 }).code, 'duration-unavailable')

  const mp4 = normalize({ format: 'mp4' })
  assert.equal(mp4.ok, true)
  assert.deepEqual(mp4.value.segments, [{ startMs: 0, endMs: 5000 }])
  assert.equal(mp4.value.totalDurationMs, 5000)
  assert.deepEqual(mp4.value.video, {
    resolution: 'source', quality: 'standard', fps: 'source',
    width: 1920, height: 1080, fpsValue: 30, copy: false
  })
  assert.equal(mp4.value.hasAudio, true)
  assert.equal(mp4.value.gif, null)
  assert.equal(mp4.value.sourceFrameRate, 30)

  // Legacy single range still works and canonicalises a full-range selection.
  const legacy = normalize({ format: 'mp4', range: { startMs: 1000, endMs: 3000 } })
  assert.deepEqual(legacy.value.segments, [{ startMs: 1000, endMs: 3000 }])
  assert.equal(legacy.value.totalDurationMs, 2000)

  // Multi-segment total is the sum of the kept spans.
  const multi = normalize({
    format: 'mp4',
    segments: [{ startMs: 0, endMs: 600 }, { startMs: 1200, endMs: 1800 }, { startMs: 3000, endMs: 3600 }]
  })
  assert.equal(multi.value.totalDurationMs, 1800)

  // Unknown dimensions: source-resolution mp4 keeps the historical "no dimension check" value.
  const unknown = options.normalizeExportRequest({ format: 'mp4' }, { durationMs: 1000, video: {}, audio: { exists: false } })
  assert.equal(unknown.ok, true)
  assert.deepEqual([unknown.value.video.width, unknown.value.video.height], [0, 0])
})

test('video resolution/quality/fps follow contract §4.2', () => {
  const downscaled = normalize({
    format: 'mp4',
    video: { resolution: '720p', quality: 'high', fps: 30 }
  })
  assert.equal(downscaled.ok, true)
  assert.deepEqual(downscaled.value.video, {
    resolution: '720p', quality: 'high', fps: 30,
    width: 1280, height: 720, fpsValue: 30, copy: false
  })

  // fps above the source is refused; at or below the source is fine.
  assert.equal(normalize({ format: 'mp4', video: { fps: 60 } }).code, 'fps-above-source')
  const sixty = options.normalizeExportRequest(
    { format: 'mp4', video: { fps: 30 } },
    { durationMs: 2000, video: { width: 640, height: 360, frameRate: 60 }, audio: { exists: false } }
  )
  assert.equal(sixty.ok, true)
  assert.equal(sixty.value.video.fpsValue, 30)
  // Source fps unknown: the user's choice is allowed and becomes the output rate.
  const unknownRate = options.normalizeExportRequest(
    { format: 'webm', video: { resolution: 'source', quality: 'standard', fps: 60 } },
    { durationMs: 2000, video: { width: 640, height: 360 }, audio: { exists: true } }
  )
  assert.equal(unknownRate.ok, true)
  assert.equal(unknownRate.value.video.fpsValue, 60)

  // Enum violations are explicit, never clamped.
  assert.equal(normalize({ format: 'mp4', video: { resolution: '4k' } }).code, 'invalid-video-option')
  assert.equal(normalize({ format: 'mp4', video: { quality: 'cinema' } }).code, 'invalid-video-option')
  assert.equal(normalize({ format: 'mp4', video: { fps: 25 } }).code, 'invalid-video-option')
  assert.equal(normalize({ format: 'mp4', video: { resolution: '1080p' } }).ok, true, 'source 1080p is a no-op preset')
})

test('the WebM copy fast path requires full range + source resolution + source fps', () => {
  const copy = normalize({ format: 'webm' })
  assert.equal(copy.ok, true)
  assert.equal(copy.value.video.copy, true)
  assert.deepEqual([copy.value.video.width, copy.value.video.height], [1920, 1080])

  // quality is ignored on the copy path, so it must not break eligibility.
  assert.equal(normalize({ format: 'webm', video: { quality: 'ultra' } }).value.video.copy, true)
  // A trimmed selection, a downscaled preset or a frame-rate change forces a re-encode.
  assert.equal(normalize({ format: 'webm', segments: [{ startMs: 0, endMs: 4000 }] }).value.video.copy, false)
  assert.equal(normalize({ format: 'webm', video: { resolution: '720p' } }).value.video.copy, false)
  assert.equal(normalize({ format: 'webm', video: { fps: 30 } }).value.video.copy, false)
  // The legacy full-range single range is the same thing as no selection.
  const viaRange = normalize({ format: 'webm', range: { startMs: 0, endMs: 5000 } })
  assert.equal(viaRange.value.video.copy, true)
  assert.deepEqual(viaRange.value.segments, [{ startMs: 0, endMs: 5000 }])
  // mp4 never uses the copy path.
  assert.equal(normalize({ format: 'mp4' }).value.video.copy, false)
})

test('GIF ignores video options and budgets the TOTAL kept duration', () => {
  const gif = normalize({
    format: 'gif',
    segments: [{ startMs: 0, endMs: 600 }, { startMs: 1200, endMs: 1800 }],
    gif: { edge: 1280, fps: 15 },
    video: { resolution: '720p', quality: 'high', fps: 30 }
  })
  assert.equal(gif.ok, true)
  assert.equal(gif.value.video, null, 'GIF ignores video options')
  assert.equal(gif.value.gif.fps, 15)
  assert.equal(gif.value.gif.edge, 1280, 'edge is the OUTPUT long edge (1920x1080 capped at 1280)')
  assert.deepEqual([gif.value.gif.width, gif.value.gif.height], [1280, 720])
  assert.equal(gif.value.gif.frames, 18)
  assert.equal(gif.value.hasAudio, false)

  // The 60s budget applies to total kept duration, not the source duration.
  const metadata = { durationMs: 120000, video: { width: 640, height: 360 }, audio: { exists: false } }
  assert.equal(options.normalizeExportRequest(
    { format: 'gif', segments: [{ startMs: 0, endMs: 30000 }, { startMs: 40000, endMs: 80000 }], gif: { fps: 15 } },
    metadata
  ).code, 'gif-too-long')
})

test('durationToleranceMs extends per extra segment and per GIF quantisation', () => {
  assert.equal(options.durationToleranceMs(400), 250)
  assert.equal(options.durationToleranceMs(1200), 250)
  assert.equal(options.durationToleranceMs(10000), 500)
  // One 30fps frame of allowance per EXTRA segment.
  assert.equal(options.durationToleranceMs(1200, { segments: 3, sourceFps: 30 }), 250 + 2 * 34)
  // A 10fps source is one 100ms boundary per extra segment.
  assert.equal(options.durationToleranceMs(1200, { segments: 2, sourceFps: 10 }), 250 + 100)
  // GIF adds its own quantisation allowance.
  assert.equal(options.durationToleranceMs(1200, { isGif: true }), 250 + 200)
  // Unknown source fps still uses the conservative 30fps floor.
  assert.equal(options.durationToleranceMs(1200, { segments: 2, sourceFps: 0 }), 250 + 34)
})

test('WebM copy argv is the exact remux command and expected shape', () => {
  const built = options.buildExportArgs({
    inputPath: 'C:\\in\\capture.webm',
    outputPath: 'C:\\out\\edited.webm',
    format: 'webm',
    segments: [{ startMs: 0, endMs: 5000 }],
    totalDurationMs: 5000,
    hasAudio: true,
    sourceWidth: 1920,
    sourceHeight: 1080,
    video: { resolution: 'source', quality: 'standard', fps: 'source', width: 1920, height: 1080, fpsValue: 30, copy: true }
  })
  assert.deepEqual(built.args, [
    '-hide_banner', '-nostdin', '-i', 'C:\\in\\capture.webm',
    '-map', '0', '-c', 'copy', '-y', 'C:\\out\\edited.webm'
  ])
  assert.deepEqual(built.expected, {
    format: 'webm', durationMs: 5000, width: 1920, height: 1080, hasAudio: true, fps: 30
  })
})

test('WebM re-encode argv uses VP9 CRF + Opus and applies fps/scale filters', () => {
  const built = options.buildExportArgs({
    inputPath: 'in.webm',
    outputPath: 'out.webm',
    format: 'webm',
    segments: [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 3000 }],
    totalDurationMs: 2000,
    hasAudio: true,
    sourceWidth: 1920,
    sourceHeight: 1080,
    video: { resolution: '720p', quality: 'high', fps: 30, width: 1280, height: 720, fpsValue: 30, copy: false }
  })
  const graph = built.args[built.args.indexOf('-filter_complex') + 1]
  assert.match(graph, /\[0:v\]trim=start=0\.000000:end=1\.000000,setpts=PTS-STARTPTS,fps=30,scale=1280:720:flags=lanczos\[v0\]/)
  assert.match(graph, /\[1:v\]trim=start=2\.000000:end=3\.000000/)
  assert.match(graph, /\[0:a\]atrim=start=0\.000000:end=1\.000000,asetpts=PTS-STARTPTS,aresample=48000\[a0\]/)
  assert.match(graph, /concat=n=2:v=1:a=1\[outv\]\[outa\]/)
  assert.equal(built.args[built.args.indexOf('-c:v') + 1], 'libvpx-vp9')
  assert.equal(built.args[built.args.indexOf('-b:v') + 1], '0')
  assert.equal(built.args[built.args.indexOf('-row-mt') + 1], '1')
  assert.equal(built.args[built.args.indexOf('-crf') + 1], '28')
  assert.equal(built.args[built.args.indexOf('-c:a') + 1], 'libopus')
  assert.equal(built.args[built.args.indexOf('-b:a') + 1], '128k')
  assert.equal(built.args.includes('-movflags'), false)
  assert.deepEqual(built.expected, {
    format: 'webm', durationMs: 2000, width: 1280, height: 720, hasAudio: true, fps: 30
  })
})

test('buildExportArgs stays path/branch safe and keeps the legacy range form working', () => {
  assert.throws(() => options.buildExportArgs({ format: 'mp4' }), /input and output paths/)
  assert.throws(() => options.buildExportArgs({ inputPath: 'a', outputPath: 'b', format: 'avi', segments: [{ startMs: 0, endMs: 100 }] }), /unsupported format/)
  assert.throws(() => options.buildExportArgs({ inputPath: 'a', outputPath: 'b', format: 'mp4' }), /empty selection/)
  const legacy = options.buildExportArgs({
    inputPath: 'in.webm', outputPath: 'out.mp4', format: 'mp4',
    range: { startMs: 500, endMs: 1500 }, hasAudio: false, sourceWidth: 320, sourceHeight: 240
  })
  assert.equal(legacy.args.filter((value) => value === '-i').length, 1)
  assert.deepEqual(legacy.expected, {
    format: 'mp4', durationMs: 1000, width: 0, height: 0, hasAudio: false, fps: 0
  })
  // The argv is always a string array - no shell string, no renderer-controlled flag.
  assert.equal(legacy.args.every((value) => typeof value === 'string'), true)
})

test('the module loads as a classic browser script and exposes the UI helpers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'recording-export-options.js'), 'utf8')
  const sandbox = { globalThis: null }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox)
  const browser = sandbox.recordingExportOptions
  assert.equal(typeof browser, 'object')
  assert.equal(typeof browser.computeVideoOutput, 'function')
  assert.equal(typeof browser.normalizeExportRequest, 'function')
  assert.equal(browser.MAX_SEGMENTS, 20)
  assert.deepEqual({ ...browser.RESOLUTION_PRESETS }, { '1080p': 1920, '720p': 1280, '480p': 854 })
  assert.deepEqual(
    browser.computeVideoOutput({ sourceWidth: 1920, sourceHeight: 1080, resolution: '720p' }).value.width,
    1280
  )
})
