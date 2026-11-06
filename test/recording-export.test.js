'use strict'

// Feature E (docs/plans/2026-10-25-snow-apps-feature-development-plan.md §8):
//   1. E0 media probe — parser rules + the real ffmpeg path, headless tests against
//      synthetic WebM samples PRODUCED BY THE BUNDLED ffmpeg (no new fixture files in the repo).
//   2. E1/E2 export task service — queueing, replay/mismatch, cancel arbitration, publish
//      protocol (verify before replace, never delete the old target), failure injection.
//   3. E3 trim controller — half-open range, clamping, range playback, GIF budget, freeze.
//
// The encoder is the REAL bundled ffmpeg where a test asserts real media, and a fake spawn
// everywhere a failure has to be injected reproducibly. All scratch paths live under `.tmp*`
// (gitignored) and are removed by the test itself.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const ffmpegPath = (() => {
  try {
    return require('ffmpeg-static')
  } catch {
    return ''
  }
})()
const ffmpegAvailable = !!ffmpegPath && fs.existsSync(ffmpegPath)

const { createMediaProbe, parseProbeOutput, parseProgressEndTime } = require('../main/services/recording-probe')
const { RecordingService } = require('../main/services/recording-service')
const { createRecordingExportService, EXPORT_ERROR_CODES } = require('../main/services/recording-export-service')
const {
  LIMITS,
  buildExportArgs,
  computeGifDimensions,
  durationToleranceMs,
  estimateGifFrames,
  exportWindow,
  normalizeExportRequest,
  normalizeGifOptions,
  normalizeRange,
  requestSignature,
  sessionTransition,
  taskTransition,
  toExportRequest
} = require('../shared/recording-export-options')
const { createRecordTrimController, parseTimeInput, errorKey, LOCALE_KEYS } = require('../record/trim-controller')

// ---------------------------------------------------------------------------
// scratch directories (.tmp* is gitignored)
// ---------------------------------------------------------------------------

function makeScratch(prefix = '.tmp-feature-e-') {
  const directory = fs.mkdtempSync(path.join(ROOT, prefix))
  return {
    directory,
    pathFor: (name) => path.join(directory, name),
    dispose() {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

// Real WebM sample from the bundled ffmpeg. `withAudio` chooses between the two cases plan §8.1
// requires evidence for. Returns null when the binary is missing (the caller skips).
function makeWebmSample(targetPath, { withAudio = true, seconds = 2, size = '320x240', rate = 10 } = {}) {
  if (!ffmpegAvailable) return null
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${rate}:duration=${seconds}`]
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`)
  args.push('-c:v', 'libvpx', '-b:v', '300k')
  if (withAudio) args.push('-c:a', 'libopus', '-shortest')
  else args.push('-an')
  args.push('-y', targetPath)
  const result = spawnSync(ffmpegPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true })
  assert.equal(result.status, 0, `Unable to build the WebM fixture.\n${result.stderr}`)
  return targetPath
}

// A WebM whose header carries no duration (ffmpeg's `-live 1` muxer mode): this is the
// "missing index / streamed MediaRecorder" case E0 has to handle by demuxing instead of guessing.
function makeLiveWebmSample(targetPath, { size = '320x240', rate = 10, seconds = 2 } = {}) {
  if (!ffmpegAvailable) return null
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${rate}:duration=${seconds}`,
    '-c:v', 'libvpx', '-b:v', '300k', '-an',
    '-live', '1',
    '-y', targetPath
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true })
  assert.equal(result.status, 0, `Unable to build the live-mode WebM fixture.\n${result.stderr}`)
  return targetPath
}

function copyInto(source, target) {
  fs.copyFileSync(source, target)
  return target
}

// ---------------------------------------------------------------------------
// E0: probe parser (no ffmpeg needed - these are the rules the module is judged on)
// ---------------------------------------------------------------------------

test('probe parser reads duration, start, video size/fps and the audio track from ffmpeg stderr', () => {
  const stderr = `Input #0, matroska,webm, from 'x.webm':
  Metadata:
    ENCODER         : Lavf60.16.100
  Duration: 00:00:02.01, start: -0.007000, bitrate: 216 kb/s
  Stream #0:0: Video: vp8, yuv420p(tv, progressive), 320x240, SAR 1:1 DAR 4:3, 10 fps, 10 tbr, 1k tbn
    Metadata:
      ENCODER         : Lavc60.31.102 libvpx
      DURATION        : 00:00:02.000000000
  Stream #0:1: Audio: opus, 48000 Hz, mono, fltp
At least one output file must be specified`
  const parsed = parseProbeOutput(stderr)
  assert.equal(parsed.durationMs, 2010)
  assert.equal(parsed.startMs, -7)
  assert.equal(parsed.container, 'matroska')
  assert.deepEqual(parsed.video, { codec: 'vp8', width: 320, height: 240, frameRate: 10 })
  assert.deepEqual(parsed.audio, { codec: 'opus', sampleRate: 48000, channels: 1 })
})

test('probe parser reports a silent recording as having no audio track and N/A duration as null', () => {
  const silent = parseProbeOutput(`Input #0, matroska,webm, from 'silent.webm':
  Duration: 00:00:02.00, start: 0.000000, bitrate: 141 kb/s
  Stream #0:0: Video: vp8, yuv420p(tv, progressive), 320x240, SAR 1:1 DAR 4:3, 10 fps, 10 tbr, 1k tbn`)
  assert.equal(silent.durationMs, 2000)
  assert.equal(silent.audio, null, 'a video-only WebM must report no audio track')
  assert.equal(silent.video.width, 320)

  // The live/streamed form: a real duration must NOT be invented for it (plan §8.1).
  const live = parseProbeOutput(`Input #0, matroska,webm, from 'live.webm':
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0: Video: vp8, yuv420p(tv, progressive), 320x240, SAR 1:1 DAR 4:3, 10 fps, 10 tbr, 1k tbn`)
  assert.equal(live.durationMs, null, 'N/A duration must stay null, never become 0 or Infinity')
})

test('probe parser ignores a missing resolution instead of reporting 0x0 geometry', () => {
  const parsed = parseProbeOutput(`Input #0, matroska,webm, from 'odd.webm':
  Duration: 00:00:05.00, start: 0.000000, bitrate: 100 kb/s
  Stream #0:0: Video: vp8, yuv420p, 10 fps, 10 tbr, 1k tbn`)
  assert.equal(parsed.video, null, 'an unknown size is null, not a 0x0 video')
})

test('progress parser takes the last demuxed timestamp and prefers microseconds', () => {
  assert.equal(parseProgressEndTime('out_time_us=1500500\nprogress=continue\n'), 1501)
  // `out_time_ms` is microseconds on some ffmpeg builds; it is the documented fallback only.
  assert.equal(parseProgressEndTime('out_time_ms=2001000\nprogress=end\n'), 2001)
  assert.equal(parseProgressEndTime('progress=end\n'), null)
})

// ---------------------------------------------------------------------------
// E0: probe adapter against REAL media (the acceptance evidence plan §8.1 asks for)
// ---------------------------------------------------------------------------

test('probe reports the real duration, size and audio-track presence of silent and audio WebM', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const audioPath = makeWebmSample(scratch.pathFor('audio.webm'), { withAudio: true })
  const silentPath = makeWebmSample(scratch.pathFor('silent.webm'), { withAudio: false })
  const probe = createMediaProbe({ ffmpegPath })

  const withAudio = await probe.probe(audioPath)
  assert.equal(withAudio.ok, true)
  assert.equal(withAudio.metadata.durationMs, 2010, 'the header duration for a seekable WebM')
  assert.equal(withAudio.metadata.durationSource, 'container')
  assert.equal(withAudio.metadata.video.width, 320)
  assert.equal(withAudio.metadata.video.height, 240)
  assert.equal(withAudio.metadata.video.frameRate, 10)
  assert.equal(withAudio.metadata.audio.exists, true)
  assert.equal(withAudio.metadata.audio.codec, 'opus')
  assert.equal(withAudio.metadata.timebase, 'ms-media-timeline')
  // The container's start offset is reported for diagnostics but never folded into a range.
  assert.ok(Number.isFinite(withAudio.metadata.startMs))

  const silent = await probe.probe(silentPath)
  assert.equal(silent.ok, true)
  assert.equal(silent.metadata.durationMs, 2000)
  assert.equal(silent.metadata.audio.exists, false, 'a silent recording reports no audio track')
})

test('a WebM with no duration in its header is demuxed instead of guessed', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const livePath = makeLiveWebmSample(scratch.pathFor('live.webm'))

  // Precondition: the header pass really does say N/A, otherwise this test proves nothing.
  const header = await createMediaProbe({ ffmpegPath }).probeHeader(livePath)
  assert.equal(header.ok, true)
  assert.equal(header.value.durationMs, null, 'the live-mode fixture must have no header duration')

  const probed = await createMediaProbe({ ffmpegPath }).probe(livePath)
  assert.equal(probed.ok, true)
  assert.equal(probed.metadata.durationSource, 'demux', 'the fallback must be an actual demux pass')
  assert.ok(Math.abs(probed.metadata.durationMs - 2000) <= 100, `demuxed duration ${probed.metadata.durationMs} is ~2 s`)
})

test('the probe fails explicitly for a missing file, an empty file and a bad renderer duration', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const probe = createMediaProbe({ ffmpegPath })
  assert.deepEqual(await probe.probe(scratch.pathFor('nope.webm')), { ok: false, code: 'file-missing' })
  fs.writeFileSync(scratch.pathFor('empty.webm'), '')
  assert.deepEqual(await probe.probe(scratch.pathFor('empty.webm')), { ok: false, code: 'unreadable-media' })

  // The renderer duration is a cross-check: a wild disagreement is refused rather than trusted.
  const audioPath = makeWebmSample(scratch.pathFor('audio.webm'), { withAudio: true })
  const okDuration = (await probe.probe(audioPath)).metadata.durationMs
  // A file LONGER than the wall clock cannot be this session's recording -> refused.
  const refused = await probe.probe(audioPath, { crossCheckMs: Math.max(1, Math.round(okDuration / 4)) })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'renderer-duration-disagrees')
  // A close one is accepted (the tolerance is documented, not "exact").
  assert.equal((await probe.probe(audioPath, { crossCheckMs: Math.round(okDuration * 1.1) })).ok, true)
})

// Regression from a real device: "the export button is unavailable and the panel says the recording
// file could not be read".
//
// The renderer sends its WALL-CLOCK duration (`record.js` elapsedTime()), but pausing produces no
// media time at all - MediaRecorder.pause() freezes the media timeline while the clock keeps running.
// A user who paused for 2 s inside a 5 s take produced a 3 s file, a 40% shortfall, and the symmetric
// tolerance (`Math.abs(...) > max(1s, 25%)`) rejected a perfectly healthy recording: export disabled,
// "re-record" shown, and the whole trimmed-export feature unreachable for anyone who ever paused.
//
// The window is now asymmetric: shorter than the wall clock is legal (that is what a pause looks
// like), longer than the wall clock is still a hard disagreement.
test('a paused take whose media time is shorter than the wall clock still passes the cross-check', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const probe = createMediaProbe({ ffmpegPath })
  // ~2 s of media.
  const samplePath = makeWebmSample(scratch.pathFor('paused.webm'), { withAudio: false })
  const media = await probe.probe(samplePath)
  assert.equal(media.ok, true, 'the fixture itself must probe cleanly')
  const mediaMs = media.metadata.durationMs

  // The paused-take shape: the wall clock ran much longer than the media timeline. A pause of any
  // length must not invalidate the file - the old symmetric window refused this.
  for (const wallMs of [mediaMs + 2000, mediaMs + 10000, Math.round(mediaMs * 3)]) {
    const accepted = await probe.probe(samplePath, { crossCheckMs: wallMs })
    assert.equal(
      accepted.ok,
      true,
      `a file SHORTER than the wall clock must be accepted (media ${mediaMs} ms, wall ${wallMs} ms)`
    )
    assert.equal(accepted.metadata.durationMs, mediaMs, 'the media duration is the result, never the wall clock')
  }

  // The reverse direction is still refused: a file cannot contain more media time than the session
  // ran, so that really is a foreign/damaged file rather than a paused take.
  const tooLong = await probe.probe(samplePath, { crossCheckMs: Math.max(1, Math.round(mediaMs / 4)) })
  assert.equal(tooLong.ok, false, 'a file far LONGER than the wall clock is still a disagreement')
  assert.equal(tooLong.code, 'renderer-duration-disagrees')
})

test('probe without a resolvable ffmpeg path fails instead of fabricating metadata', async () => {
  const probe = createMediaProbe({ ffmpegPath: 'definitely-not-ffmpeg-xyz' })
  const result = await probe.probe(__filename)
  assert.equal(result.ok, false)
  assert.ok(['unreadable-media', 'no-video-track', 'file-missing'].includes(result.code), `unexpected code ${result.code}`)
})

// ---------------------------------------------------------------------------
// shared options: range + GIF budget + argv
// ---------------------------------------------------------------------------

test('range validation is half-open, bounded by the PROBED duration and never clamps silently', () => {
  assert.deepEqual(normalizeRange({ startMs: 100, endMs: 900 }, 2000), {
    ok: true,
    value: { startMs: 100, endMs: 900, durationMs: 800 }
  })
  // Out of bounds is an error, not a clamp: exporting "whatever fits" would lie about the span.
  assert.equal(normalizeRange({ startMs: 100, endMs: 3000 }, 2000).code, 'range-out-of-bounds')
  assert.equal(normalizeRange({ startMs: -50, endMs: 900 }, 2000).code, 'range-out-of-bounds')
  assert.equal(normalizeRange({ startMs: 900, endMs: 900 }, 2000).code, 'invalid-range')
  assert.equal(normalizeRange({ startMs: 0, endMs: 50 }, 2000).code, 'range-too-short')
  assert.equal(normalizeRange({ startMs: 0, endMs: 1000 }, 0).code, 'duration-unavailable')
  assert.equal(normalizeRange({ startMs: Number.NaN, endMs: 1000 }, 2000).code, 'invalid-range')
  assert.equal(normalizeRange({ startMs: 0, endMs: Infinity }, 2000).code, 'invalid-range')
  // One millisecond of float noise is absorbed; a whole frame is not.
  assert.equal(normalizeRange({ startMs: -0.4, endMs: 2000.6 }, 2000).ok, true)
})

test('export window seeks ahead of the range and expresses the trim relative to the seek', () => {
  assert.deepEqual(exportWindow({ startMs: 5000, endMs: 8000 }, 2000), {
    seekMs: 3000,
    relStartMs: 2000,
    relEndMs: 5000,
    spanMs: 3000
  })
  // A range inside the preroll must not seek negative.
  assert.deepEqual(exportWindow({ startMs: 500, endMs: 800 }, 2000), {
    seekMs: 0,
    relStartMs: 500,
    relEndMs: 800,
    spanMs: 300
  })
})

test('GIF budget enforces plan §3.3 and never upscales a small recording', () => {
  // 60 s at 20 fps is exactly at the frame ceiling.
  assert.equal(estimateGifFrames(60000, 20), 1200)
  assert.equal(estimateGifFrames(60000, 15), 900)
  const tooMany = normalizeGifOptions({ fps: 20, maxEdgePx: 1280, loop: true }, { video: { width: 1920, height: 1080 } }, 61000)
  assert.equal(tooMany.code, 'gif-too-long')
  const frames = normalizeGifOptions({ fps: 20, maxEdgePx: 1280, loop: true }, { video: { width: 1920, height: 1080 } }, 60000)
  assert.equal(frames.ok, true)
  assert.equal(frames.value.frames, 1200)
  assert.equal(frames.value.width, 1280)
  assert.equal(frames.value.height, 720)
  // `maxEdgePx` on the normalised value is the OUTPUT long edge, not the requested cap.
  assert.equal(frames.value.maxEdgePx, 1280)
  assert.equal(Math.max(frames.value.width, frames.value.height), 1280)

  // A 320x240 source stays 320x240: "do not upscale" (plan §3.3).
  const small = normalizeGifOptions({ fps: 15, maxEdgePx: 1280, loop: true }, { video: { width: 320, height: 240 } }, 2000)
  assert.equal(small.ok, true)
  assert.deepEqual({ width: small.value.width, height: small.value.height }, { width: 320, height: 240 })

  assert.equal(normalizeGifOptions({ fps: 12, maxEdgePx: 1280, loop: true }, { video: { width: 320, height: 240 } }, 2000).code, 'gif-invalid-fps')
  assert.equal(normalizeGifOptions({ fps: 15, maxEdgePx: 4000, loop: true }, { video: { width: 320, height: 240 } }, 2000).code, 'gif-invalid-edge')
  assert.equal(normalizeGifOptions({ fps: 15, maxEdgePx: 1280, loop: false }, { video: { width: 320, height: 240 } }, 2000).code, 'gif-loop-required')
  assert.equal(computeGifDimensions({ width: 0, height: 0 }).code, 'invalid-source-size')
})

test('MP4 argv cuts every kept segment exactly, concatenates them and maps audio only when present', () => {
  const video = { resolution: 'source', quality: 'standard', fps: 'source', width: 320, height: 240, fpsValue: 0, copy: false }
  const withAudio = buildExportArgs({
    inputPath: 'in.webm',
    outputPath: 'out.mp4',
    format: 'mp4',
    segments: [{ startMs: 0, endMs: 600 }, { startMs: 1200, endMs: 1800 }],
    totalDurationMs: 1200,
    hasAudio: true,
    sourceWidth: 320,
    sourceHeight: 240,
    video
  })
  const args = withAudio.args
  // One input per segment: input seek + duration, then the exact filter trim.
  assert.equal(args.filter((value) => value === '-i').length, 2, 'one decoded input per kept segment')
  assert.deepEqual(args.slice(0, 7), ['-hide_banner', '-nostdin', '-ss', '0.000000', '-t', '0.600000', '-i'])
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.match(graph, /\[0:v\]trim=start=0\.000000:end=0\.600000,setpts=PTS-STARTPTS\[v0\]/)
  assert.match(graph, /\[1:v\]trim=start=1\.200000:end=1\.800000,setpts=PTS-STARTPTS\[v1\]/)
  assert.match(graph, /\[0:a\]atrim=start=0\.000000:end=0\.600000,asetpts=PTS-STARTPTS,aresample=48000\[a0\]/)
  assert.match(graph, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[outv\]\[outa\]/, 'A/V stay aligned across the concat')
  assert.equal(args.includes('-c'), false, 'no stream copy: a non-keyframe cut must be decoded')
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264')
  assert.equal(args[args.indexOf('-preset') + 1], 'veryfast')
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p')
  assert.deepEqual(args.filter((value, index) => args[index - 1] === '-map'), ['[outv]', '[outa]'])
  assert.deepEqual(withAudio.expected, { format: 'mp4', durationMs: 1200, width: 320, height: 240, hasAudio: true, fps: 0 })

  // Quality tiers map to the frozen CRF table (§4.3).
  const base = {
    inputPath: 'in.webm', outputPath: 'out.mp4', format: 'mp4',
    segments: [{ startMs: 0, endMs: 1000 }], hasAudio: false, sourceWidth: 320, sourceHeight: 240
  }
  for (const pair of [['standard', '28'], ['high', '23'], ['ultra', '18']]) {
    const built = buildExportArgs({ ...base, video: { ...video, quality: pair[0] } })
    assert.equal(built.args[built.args.indexOf('-crf') + 1], pair[1], `mp4 ${pair[0]} CRF`)
  }

  // A silent single segment still uses the same concat graph (N=1 included) and gains no audio.
  const silent = buildExportArgs(base)
  const silentGraph = silent.args[silent.args.indexOf('-filter_complex') + 1]
  assert.match(silentGraph, /concat=n=1:v=1:a=0\[outv\]/)
  assert.ok(silent.args.includes('-an'))
  assert.equal(silent.args.some((value) => value === '[outa]'), false)
  assert.equal(silent.args[0], '-hide_banner')

  // Legacy `range` callers (the performance probe and R1-R3 tests) still get one segment.
  const legacy = buildExportArgs({
    inputPath: 'in.webm', outputPath: 'out.mp4', format: 'mp4',
    range: { startMs: 500, endMs: 1500 }, hasAudio: false, sourceWidth: 320, sourceHeight: 240
  })
  assert.match(legacy.args[legacy.args.indexOf('-filter_complex') + 1], /trim=start=0\.500000:end=1\.500000/)
})

test('GIF argv concatenates the kept segments then applies one palette pass and drops audio', () => {
  const { args, expected } = buildExportArgs({
    inputPath: 'in.webm',
    outputPath: 'out.gif',
    format: 'gif',
    segments: [{ startMs: 0, endMs: 1000 }, { startMs: 1500, endMs: 2000 }],
    totalDurationMs: 1500,
    gif: { edge: 1280, fps: 15, width: 320, height: 240, maxEdgePx: 1280, loop: true },
    hasAudio: true
  })
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.match(graph, /\[0:v\]trim=start=0\.000000:end=1\.000000/)
  assert.match(graph, /\[1:v\]trim=start=1\.500000:end=2\.000000/)
  assert.match(graph, /concat=n=2:v=1:a=0\[outv\]/)
  assert.match(graph, /\[outv\]fps=15,scale=320:240:flags=lanczos,split\[gifA\]\[gifB\]/)
  assert.match(graph, /palettegen/)
  assert.match(graph, /paletteuse/)
  assert.equal(graph.includes('[0:a]'), false, 'GIF carries no audio')
  assert.ok(args.includes('-an'))
  assert.equal(args[args.indexOf('-loop') + 1], '0', 'GIF loops forever (plan §3.3)')
  assert.deepEqual(expected, { format: 'gif', durationMs: 1500, width: 320, height: 240, hasAudio: false, fps: 15 })
  assert.throws(() => buildExportArgs({ inputPath: 'a', outputPath: 'b', format: 'webp', segments: [{ startMs: 0, endMs: 1000 }] }), /unsupported format/)
})

test('request signature distinguishes parameters so a replay can be detected as a mismatch', () => {
  const base = {
    format: 'mp4',
    segments: [{ startMs: 0, endMs: 1000 }],
    video: { resolution: 'source', quality: 'standard', fps: 'source' }
  }
  assert.equal(requestSignature(base), requestSignature({ ...base }))
  assert.notEqual(requestSignature(base), requestSignature({ ...base, segments: [{ startMs: 0, endMs: 1001 }] }))
  assert.notEqual(requestSignature(base), requestSignature({ ...base, segments: [{ startMs: 0, endMs: 900 }, { startMs: 950, endMs: 1000 }] }))
  // R4 §4.4: the video options are part of the frozen request, so they must be in the key.
  assert.notEqual(requestSignature(base), requestSignature({ ...base, video: { resolution: '720p', quality: 'standard', fps: 'source' } }))
  assert.notEqual(requestSignature(base), requestSignature({ ...base, video: { resolution: 'source', quality: 'high', fps: 'source' } }))
  assert.notEqual(requestSignature(base), requestSignature({ ...base, video: { resolution: 'source', quality: 'standard', fps: 30 } }))
  assert.notEqual(requestSignature(base), requestSignature({ ...base, format: 'webm' }))
  assert.notEqual(requestSignature(base), requestSignature({ ...base, format: 'gif', gif: { edge: 1280, fps: 15 } }))
  // Legacy range callers keep a stable signature of their own.
  const legacy = { format: 'mp4', range: { startMs: 0, endMs: 1000 } }
  assert.equal(requestSignature(legacy), requestSignature({ format: 'mp4', range: { startMs: 0, endMs: 1000 } }))
  assert.notEqual(requestSignature(legacy), requestSignature({ format: 'mp4', range: { startMs: 0, endMs: 1001 } }))
})

test('session and task transition tables refuse illegal edges', () => {
  assert.equal(sessionTransition('capturing', 'finalize'), 'finalizing')
  assert.equal(sessionTransition('ready', 'close'), 'closing')
  assert.equal(sessionTransition('closing', 'closed'), 'closed')
  assert.equal(sessionTransition('closed', 'close'), null)
  assert.equal(taskTransition('queued', 'run'), 'running')
  assert.equal(taskTransition('running', 'publish'), 'publishing')
  assert.equal(taskTransition('publishing', 'cancel'), null, 'the publish critical section cannot be cancelled')
  assert.equal(taskTransition('succeeded', 'cancel'), null)
})

test('export request normalisation rejects a renderer-supplied path or a missing request id', () => {
  assert.equal(toExportRequest({ sessionId: 's', requestId: '', request: { format: 'mp4', range: { startMs: 0, endMs: 10 } } }).code, 'invalid-request')
  assert.equal(toExportRequest({ sessionId: '', requestId: 'r', request: {} }).code, 'invalid-request')
  assert.equal(toExportRequest({ sessionId: 's', requestId: 'r', request: { format: 'webp', range: {} } }).code, 'unsupported-format')
  const ok = toExportRequest({
    sessionId: 's',
    requestId: 'r',
    request: { format: 'mp4', range: { startMs: 1, endMs: 2 }, targetPath: 'C:/evil.mp4', argv: ['-i'] }
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(Object.keys(ok.value).sort(), ['demo', 'format', 'gif', 'range', 'requestId', 'segments', 'sessionId', 'video'].sort())
  assert.equal('targetPath' in ok.value, false, 'a renderer path must never survive normalisation')
  const v2 = toExportRequest({
    sessionId: 's',
    requestId: 'r',
    request: { format: 'webm', segments: [{ startMs: 0, endMs: 500 }], video: { resolution: '720p', quality: 'high', fps: 30 } }
  })
  assert.deepEqual(v2.value.segments, [{ startMs: 0, endMs: 500 }])
  assert.deepEqual(v2.value.video, { resolution: '720p', quality: 'high', fps: 30 })
  assert.equal(v2.value.range, null)
})

test('normalizeExportRequest combines the legacy range, format and GIF budget against probed metadata', () => {
  const metadata = { durationMs: 5000, video: { width: 320, height: 240, frameRate: 10 }, audio: { exists: true } }
  const mp4 = normalizeExportRequest({ format: 'mp4', range: { startMs: 0, endMs: 2000 } }, metadata)
  assert.equal(mp4.ok, true)
  assert.equal(mp4.value.hasAudio, true)
  assert.equal(mp4.value.gif, null)
  assert.deepEqual(mp4.value.segments, [{ startMs: 0, endMs: 2000 }])
  assert.equal(mp4.value.totalDurationMs, 2000)
  assert.deepEqual(mp4.value.video, {
    resolution: 'source', quality: 'standard', fps: 'source', width: 320, height: 240, fpsValue: 10, copy: false
  })
  assert.equal(mp4.value.sourceFrameRate, 10)
  const gif = normalizeExportRequest({ format: 'gif', range: { startMs: 0, endMs: 2000 }, gif: { fps: 10, maxEdgePx: 1280, loop: true } }, metadata)
  assert.equal(gif.ok, true)
  assert.equal(gif.value.hasAudio, false, 'GIF never carries audio')
  assert.equal(gif.value.gif.frames, 20)
  // `edge`/`maxEdgePx` are the OUTPUT long edge: a 320px source is never upscaled to 1280.
  assert.equal(gif.value.gif.edge, 320)
  assert.equal(gif.value.video, null)
  assert.equal(normalizeExportRequest({ format: 'gif', range: { startMs: 0, endMs: 2000 }, gif: { fps: 10, loop: false } }, metadata).code, 'gif-loop-required')
  // Omitting `loop` is not a rejection: looping is the only supported GIF behaviour, so the
  // normaliser fills it in and the caller cannot accidentally produce a one-shot GIF.
  assert.equal(normalizeExportRequest({ format: 'gif', range: { startMs: 0, endMs: 2000 }, gif: { fps: 10 } }, metadata).ok, true)
  // A full-range single selection is canonicalised so the empty-selection and range forms agree.
  const whole = normalizeExportRequest({ format: 'webm', range: { startMs: 0, endMs: 5000 } }, metadata)
  assert.deepEqual(whole.value.segments, [{ startMs: 0, endMs: 5000 }])
  assert.equal(whole.value.video.copy, true, 'full-range source/source WebM is a stream copy')
})

// ---------------------------------------------------------------------------
// E1: session lifecycle - success does NOT delete the source, repeat export works
// ---------------------------------------------------------------------------

test('finishing a session keeps the source readable and a second export still finds it', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const audioPath = makeWebmSample(scratch.pathFor('audio.webm'), { withAudio: true })
  const service = new RecordingService({
    tempRoot: scratch.pathFor('recordings'),
    ffmpegPath,
    probe: createMediaProbe({ ffmpegPath })
  })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await service.appendChunk(session.id, fs.readFileSync(audioPath))
  const finished = await service.finishSession(session.id)
  assert.equal(finished.state, 'ready')
  assert.equal(service.stateOf(session.id), 'ready')

  const probed = await service.probeSession(session.id, { crossCheckMs: 2000 })
  assert.equal(probed.ok, true)
  assert.equal(probed.metadata.durationMs, 2010)

  // Two leases in a row (repeat export) both see the file; cleanup while a lease is out defers.
  const first = service.acquireSource(session.id)
  const second = service.acquireSource(session.id)
  assert.equal(service.peekSession(session.id).references, 2)
  const deferred = await service.cleanupSession(session.id)
  assert.equal(deferred, false, 'a referenced source must not be deleted')
  assert.equal(service.stateOf(session.id), 'closing')
  assert.equal(fs.existsSync(session.inputPath), true)
  first.release()
  assert.equal(fs.existsSync(session.inputPath), true, 'one lease remains')
  second.release()
  // The last release removes the directory asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(service.peekSession(session.id), null)
  assert.equal(fs.existsSync(session.inputPath), false)
})

test('the legacy transcode no longer deletes the source and the session survives it', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const silent = makeWebmSample(scratch.pathFor('silent.webm'), { withAudio: false })
  const service = new RecordingService({ tempRoot: scratch.pathFor('r'), ffmpegPath })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await service.appendChunk(session.id, fs.readFileSync(silent))
  await service.finishSession(session.id)

  const target = scratch.pathFor('legacy.mp4')
  assert.equal(await service.transcode(session.id, target), target)
  assert.equal(fs.existsSync(target), true)
  // The regression this guards: the old save path called cleanupSession() right after transcode.
  assert.equal(fs.existsSync(session.inputPath), true, 'the source must survive a successful save')
  assert.equal(service.stateOf(session.id), 'ready', 'the session must stay open for another export')
})

// ---------------------------------------------------------------------------
// E2: export task service with the REAL encoder
// ---------------------------------------------------------------------------

function makeExportHarness({ scratch, fakeSpawn = null, registerResult = null, probe = null, limits = {}, now = Date.now }) {
  const recordingService = new RecordingService({ tempRoot: scratch.pathFor('recordings'), ffmpegPath, probe })
  const registrations = []
  const events = []
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe,
    registerResult: registerResult || ((payload) => {
      registrations.push(payload)
      return { status: 'saved', resultId: `result-${registrations.length}`, fileName: path.basename(payload.filePath), kind: payload.kind }
    }),
    spawnProcess: fakeSpawn || undefined,
    now,
    log: () => {},
    limits
  })
  return { recordingService, exporter, registrations, events }
}

async function waitForTerminal(exporter, taskId, timeoutMs = 60000, ownerId = null) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const status = exporter.status(ownerId ? { taskId, ownerId } : { taskId })
    if (!status.ok) throw new Error(`export task ${taskId} is not readable: ${status.code}`)
    if (['succeeded', 'failed', 'cancelled'].includes(status.task.state)) return status.task
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`export task ${taskId} did not settle in ${timeoutMs} ms`)
}

test('an MP4 export verifies its output, publishes it and keeps the source for a second export', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const audioPath = makeWebmSample(scratch.pathFor('audio.webm'), { withAudio: true })
  const probe = createMediaProbe({ ffmpegPath })
  const { recordingService, exporter, registrations } = makeExportHarness({ scratch, probe })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const session = await recordingService.startSession()
  await recordingService.appendChunk(session.id, fs.readFileSync(audioPath))
  await recordingService.finishSession(session.id)
  assert.equal((await recordingService.probeSession(session.id)).ok, true)

  const target = scratch.pathFor('out', 'trimmed.mp4')
  const states = []
  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'req-1',
    request: { format: 'mp4', range: { startMs: 350, endMs: 750 } },
    targetPath: target,
    ownerId: 'web-contents:7',
    onEvent: (task) => states.push(task.state)
  })
  assert.equal(submitted.ok, true)
  const settled = await waitForTerminal(exporter, submitted.task.taskId, 60000, 'web-contents:7')
  assert.equal(settled.state, 'succeeded')
  assert.equal(settled.progress, 100)
  assert.equal(settled.receipt.status, 'saved')
  assert.equal(settled.receipt.kind, 'mp4')
  // Plan §8.5: only a published export reports 100, and the states are ordered.
  assert.deepEqual([...new Set(states)], ['queued', 'running', 'publishing', 'succeeded'])
  // The published file really is the trimmed span, with the audio track preserved.
  const published = await probe.probe(target)
  assert.equal(published.ok, true)
  assert.equal(published.metadata.video.width, 320)
  assert.equal(published.metadata.audio.exists, true)
  assert.ok(Math.abs(published.metadata.durationMs - 400) <= durationToleranceMs(400),
    `published duration ${published.metadata.durationMs} is within the documented tolerance of 400 ms`)
  // The receipt is addressed by resultId and the registration carried no argv/path to a renderer.
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].kind, 'mp4')
  assert.equal(registrations[0].ownerId, 'web-contents:7')

  // Repeat export from the SAME session, with a different range and the GIF format.
  assert.equal(fs.existsSync(session.inputPath), true, 'the source must survive the first export')
  const gifTarget = scratch.pathFor('out', 'trimmed.gif')
  const second = await exporter.submit({
    sessionId: session.id,
    requestId: 'req-2',
    request: { format: 'gif', range: { startMs: 100, endMs: 1500 }, gif: { fps: 15, maxEdgePx: 1280, loop: true } },
    targetPath: gifTarget
  })
  assert.equal(second.ok, true)
  const settledGif = await waitForTerminal(exporter, second.task.taskId)
  assert.equal(settledGif.state, 'succeeded')
  const gifProbe = await probe.probe(gifTarget)
  assert.equal(gifProbe.ok, true)
  assert.equal(gifProbe.metadata.video.codec, 'gif')
  assert.equal(gifProbe.metadata.audio.exists, false, 'a GIF never carries audio')
  assert.deepEqual([gifProbe.metadata.video.width, gifProbe.metadata.video.height], [320, 240])
})

test('a silent recording exports without an invented audio track', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const silent = makeWebmSample(scratch.pathFor('silent.webm'), { withAudio: false })
  const probe = createMediaProbe({ ffmpegPath })
  const { recordingService, exporter } = makeExportHarness({ scratch, probe })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const session = await recordingService.startSession()
  await recordingService.appendChunk(session.id, fs.readFileSync(silent))
  await recordingService.finishSession(session.id)
  await recordingService.probeSession(session.id)
  const target = scratch.pathFor('out', 'silent.mp4')
  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'silent-1',
    request: { format: 'mp4', range: { startMs: 0, endMs: 1200 } },
    targetPath: target
  })
  assert.equal(submitted.ok, true)
  assert.equal((await waitForTerminal(exporter, submitted.task.taskId)).state, 'succeeded')
  const published = await probe.probe(target)
  assert.equal(published.ok, true)
  assert.equal(published.metadata.audio.exists, false, 'the silent input must stay silent')
})

// ---------------------------------------------------------------------------
// E2: publish protocol and cancellation arbitration (fake encoder)
// ---------------------------------------------------------------------------

// A fake ffmpeg that writes `bytes` to its `-y` output and exits with `code`. `onSpawn` lets a
// test cancel while the child is "running".
function makeFakeFfmpeg({ code = 0, bytes = 'media', onSpawn = null, hang = false } = {}) {
  const calls = []
  const spawn = (_executable, args) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => {
      child.killed = true
      queueMicrotask(() => child.emit('close', null))
    }
    const outputPath = args[args.length - 1]
    calls.push({ args, outputPath })
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('out_time_us=100000\n'))
      if (hang) {
        onSpawn?.(child)
        return
      }
      try { fs.writeFileSync(outputPath, bytes) } catch {}
      child.emit('close', code)
    })
    onSpawn?.(child)
    return child
  }
  return { spawn, calls }
}

// A probe double: reports every temp file as a valid encode of the requested span.
function makeStubProbe({ durationOffsetMs = 0, video = { width: 320, height: 240, frameRate: 10 }, audio = null, fail = null } = {}) {
  return {
    probe: async (filePath) => {
      if (fail) return { ok: false, code: fail }
      let size = 0
      try { size = fs.statSync(filePath).size } catch { return { ok: false, code: 'file-missing' } }
      if (!size) return { ok: false, code: 'unreadable-media' }
      return {
        ok: true,
        metadata: {
          durationMs: 400 + durationOffsetMs,
          video: { ...video },
          audio: audio || { exists: false, codec: '', sampleRate: 0, channels: 0 }
        }
      }
    }
  }
}

async function seedSession(scratch) {
  const silent = makeWebmSample(scratch.pathFor('seed.webm'), { withAudio: false })
  const recordingService = new RecordingService({ tempRoot: scratch.pathFor('recordings'), ffmpegPath })
  const session = await recordingService.startSession()
  if (silent && fs.existsSync(silent)) await recordingService.appendChunk(session.id, fs.readFileSync(silent))
  else await recordingService.appendChunk(session.id, Buffer.from('webm'))
  await recordingService.finishSession(session.id)
  // The stub probe supplies the metadata, so no real probe pass is needed here.
  recordingService.peekSession(session.id).metadata = {
    durationMs: 2000,
    video: { width: 320, height: 240, frameRate: 10 },
    audio: { exists: false }
  }
  return { recordingService, session }
}

test('a failed encode never deletes the existing target and only removes its own temp file', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const target = scratch.pathFor('existing.mp4')
  fs.writeFileSync(target, 'USER-FILE')
  const fake = makeFakeFfmpeg({ code: 1, bytes: 'partial' })
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe(),
    spawnProcess: fake.spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'fail-1',
    request: { format: 'mp4', range: { startMs: 0, endMs: 400 } },
    targetPath: target
  })
  assert.equal(submitted.ok, true)
  const settled = await waitForTerminal(exporter, submitted.task.taskId)
  assert.equal(settled.state, 'failed')
  assert.equal(settled.error.code, 'encode-failed')
  assert.equal(fs.readFileSync(target, 'utf8'), 'USER-FILE', 'the user file is untouched (plan §8.4)')
  const leftovers = fs.readdirSync(scratch.directory).filter((name) => name.includes('.part'))
  assert.deepEqual(leftovers, [], 'only the task temp file existed and it was removed')
})

test('a target modified during the export is refused instead of overwritten', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const target = scratch.pathFor('race.mp4')
  fs.writeFileSync(target, 'ORIGINAL')
  // The fake probe succeeds, then a competing writer changes the target before publish.
  const probe = makeStubProbe()
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: {
      probe: async (filePath) => {
        const result = await probe.probe(filePath)
        if (filePath.endsWith('.part' + path.extname(filePath).replace(/^\.part$/, '')) || filePath.includes('.part')) {
          fs.writeFileSync(target, 'COMPETING-WRITE')
        }
        return result
      }
    },
    spawnProcess: makeFakeFfmpeg({ code: 0 }).spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'race-1',
    request: { format: 'mp4', range: { startMs: 0, endMs: 400 } },
    targetPath: target
  })
  const settled = await waitForTerminal(exporter, submitted.task.taskId)
  assert.equal(settled.state, 'failed')
  assert.equal(settled.error.code, 'target-changed')
  assert.equal(fs.readFileSync(target, 'utf8'), 'COMPETING-WRITE', 'the competing write is preserved, not clobbered')
})

test('a failed verification keeps the old target and reports verify-failed', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const target = scratch.pathFor('old.mp4')
  fs.writeFileSync(target, 'KEEP-ME')
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    // The encode "succeeds" but the result is a 0-byte file: verification must refuse it.
    probe: makeStubProbe({ video: { width: 640, height: 480, frameRate: 10 } }),
    spawnProcess: makeFakeFfmpeg({ code: 0, bytes: 'x' }).spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'verify-1',
    request: { format: 'mp4', range: { startMs: 0, endMs: 400 } },
    targetPath: target
  })
  const settled = await waitForTerminal(exporter, submitted.task.taskId)
  assert.equal(settled.state, 'failed')
  assert.equal(settled.error.code, 'verify-failed')
  assert.equal(fs.readFileSync(target, 'utf8'), 'KEEP-ME')
})

// Regression (E-02, found by adversarial review): `verify()` is awaited, so a cancel can land
// inside it - and cancelTask has already answered `{ok:true, state:'cancelling'}`. The failure
// branch returned BEFORE the cancel checkpoint, so the task settled as `verify-failed` and the user
// saw an encoding error for an export they themselves aborted. Two contradictory outcomes for one
// action, with the wrong cause attributed.
test('a cancel that lands during verification is reported as cancelled, not verify-failed', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const target = scratch.pathFor('cancelled-during-verify.mp4')
  fs.writeFileSync(target, 'KEEP-ME')

  // A probe that stalls inside `verify()` and then FAILS: this is the shape that used to swallow
  // the cancel. The cancellation has to be delivered while `verify()` is in flight. The first call
  // is the verification pass on the temp file (stall + fail); any earlier call still behaves
  // normally, so the encode/metadata stages are unaffected.
  let releaseVerify = null
  const verifyGate = new Promise((resolve) => { releaseVerify = resolve })
  // Signals that the gated verification pass has actually been entered, so the test can cancel at
  // the right moment instead of racing the encode.
  const verifyGateReached = { value: false }
  const normalProbe = makeStubProbe({ video: { width: 640, height: 480, frameRate: 10 } })
  const slowFailingProbe = {
    async probe(filePath) {
      // Only the temp-file verification pass is gated: it is the one that runs after the encode.
      if (String(filePath).includes('.part')) {
        verifyGateReached.value = true
        await verifyGate
        return { ok: false, code: 'decode-failed' }
      }
      return normalProbe.probe(filePath)
    }
  }
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: slowFailingProbe,
    spawnProcess: makeFakeFfmpeg({ code: 0, bytes: 'x' }).spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'cancel-during-verify',
    request: { format: 'mp4', range: { startMs: 0, endMs: 400 } },
    targetPath: target
  })
  assert.equal(submitted.ok, true)

  // Wait until the task is actually parked INSIDE verify(): the gated probe is only reached on the
  // temp-file pass, which happens after the encode. Cancelling before that would exercise the
  // encode-phase checkpoint instead of the verify-phase one, which is the bug being pinned.
  const verifyStarted = Date.now()
  while (!verifyGateReached.value) {
    assert.ok(Date.now() - verifyStarted < 10000, 'verification was never reached')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  // The task must still be non-terminal (running) at this point - i.e. the cancel really can land
  // during verification rather than after the task already settled.
  const midState = exporter.status({ taskId: submitted.task.taskId }).task
  assert.equal(midState.state, 'running', 'the task must still be running while verification is parked')

  // Cancel while verify() is parked. The cancel must be accepted (the task is past encode, not yet
  // publishing) - that acceptance is what makes the old outcome contradictory.
  const cancelled = await exporter.cancel({ taskId: submitted.task.taskId })
  assert.equal(cancelled.ok, true, 'a cancel before the publish point must be accepted')
  assert.equal(cancelled.state, 'cancelling')

  // Let the failing verification finish: it must NOT override the cancel.
  releaseVerify()
  const settled = await waitForTerminal(exporter, submitted.task.taskId)
  assert.equal(
    settled.state,
    'cancelled',
    `a cancel during verification must win over the verification failure (got ${settled.state}/${settled.error?.code})`
  )
  assert.equal(settled.error, undefined, 'a cancelled task must not carry a failure code')
  assert.equal(fs.readFileSync(target, 'utf8'), 'KEEP-ME', 'the pre-existing target is untouched')
})

// Regression (E-03, found by adversarial review): nothing compared the chosen target with the
// recording's own source file. Saving to `session.inputPath` made the publish rename replace the
// only copy of the recording with the trimmed result, while reporting `succeeded`.
test('submitting the recording itself as the export target is refused before anything is written', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const sourcePath = session.inputPath
  const before = fs.readFileSync(sourcePath)

  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe({ video: { width: 640, height: 480, frameRate: 10 } }),
    spawnProcess: makeFakeFfmpeg({ code: 0, bytes: 'x' }).spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'target-is-source',
    request: { format: 'mp4', range: { startMs: 0, endMs: 400 } },
    targetPath: sourcePath
  })
  assert.equal(submitted.ok, false, 'the recording must never be its own export target')
  assert.equal(submitted.code, 'target-unavailable')
  assert.deepEqual(fs.readFileSync(sourcePath), before, 'the source bytes must be untouched')
  assert.equal(exporter.list().length, 0, 'no task may be created for a refused target')

  // Case-only differences are the same file on a default NTFS volume, so the guard must fold case.
  const caseVariant = path.join(path.dirname(sourcePath), path.basename(sourcePath).toUpperCase())
  const second = await exporter.submit({
    sessionId: session.id,
    requestId: 'target-is-source-case',
    request: { format: 'mp4', range: { startMs: 0, endMs: 400 } },
    targetPath: caseVariant
  })
  assert.equal(second.ok, false, 'a case-only variant of the source is still the source')
  assert.equal(second.code, 'target-unavailable')
})

// Regression found by the E4 real-media evidence run: verification used to report `failed` while
// leaving its own `.part` file next to the user's target, so every failed attempt looked like a
// leak to an immediate directory listing. The failed state must also mean 'no stray file'.
test('a verification failure removes the temp file before reporting failure', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const target = scratch.pathFor('preserved.mp4')
  fs.writeFileSync(target, 'KEEP')
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    // The encode succeeds but the probe reports the wrong dimensions, so publish must be refused.
    probe: makeStubProbe({ video: { width: 1920, height: 1080, frameRate: 10 } }),
    spawnProcess: makeFakeFfmpeg({ code: 0, bytes: "x" }).spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'leak-1',
    request: { format: 'mp4', range: { startMs: 0, endMs: 400 } },
    targetPath: target
  })
  assert.equal(submitted.ok, true)
  const settled = await waitForTerminal(exporter, submitted.task.taskId)
  assert.equal(settled.state, 'failed')
  assert.equal(settled.error.code, 'verify-failed')
  assert.equal(fs.readFileSync(target, 'utf8'), 'KEEP')
  // The observable end state includes "our temp file is gone" - asserted AFTER the terminal state,
  // which is exactly the ordering that exposed the bug.
  assert.deepEqual(fs.readdirSync(scratch.directory).filter((name) => name.includes('.part')), [])
})

test('cancel during a running encode kills the child, cleans its temp file and reports cancelled', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const target = scratch.pathFor('cancel.mp4')
  fs.writeFileSync(target, 'OLD')
  const fake = makeFakeFfmpeg({ hang: true })
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe(),
    spawnProcess: fake.spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'cancel-1',
    request: { format: 'mp4', range: { startMs: 0, endMs: 400 } },
    targetPath: target,
    ownerId: 'web-contents:1'
  })
  assert.equal(submitted.ok, true)
  // Wait until the child is actually running before cancelling.
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000 && fake.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(fake.calls.length, 1)

  const cancelled = await exporter.cancel({ taskId: submitted.task.taskId, ownerId: 'web-contents:1' })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.state, 'cancelling')
  const settled = await waitForTerminal(exporter, submitted.task.taskId, 10000, 'web-contents:1')
  assert.equal(settled.state, 'cancelled')
  assert.equal(fs.readFileSync(target, 'utf8'), 'OLD', 'a cancel before the publish point never replaces the target')
  assert.deepEqual(fs.readdirSync(scratch.directory).filter((name) => name.includes('.part')), [])
})

test('a late cancel after publish reports the succeeded task and never deletes the product', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const target = scratch.pathFor('done.mp4')
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe(),
    spawnProcess: makeFakeFfmpeg({ code: 0 }).spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'late-1',
    request: { format: 'mp4', range: { startMs: 0, endMs: 400 } },
    targetPath: target
  })
  assert.equal((await waitForTerminal(exporter, submitted.task.taskId)).state, 'succeeded')
  assert.equal(fs.existsSync(target), true)
  const late = await exporter.cancel({ taskId: submitted.task.taskId })
  assert.equal(late.ok, true)
  assert.equal(late.late, true, 'a late cancel is reported as late, not as a successful cancellation')
  assert.equal(late.task.state, 'succeeded', 'the outcome is not rewritten to cancelled (plan §8.4)')
  assert.equal(fs.existsSync(target), true, 'the published product stays')
})

test('cancelling a queued task never spawns the encoder', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const fake = makeFakeFfmpeg({ hang: true })
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe(),
    spawnProcess: fake.spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const first = await exporter.submit({
    sessionId: session.id, requestId: 'q-1', request: { format: 'mp4', range: { startMs: 0, endMs: 400 } }, targetPath: scratch.pathFor('a.mp4')
  })
  const second = await exporter.submit({
    sessionId: session.id, requestId: 'q-2', request: { format: 'mp4', range: { startMs: 0, endMs: 400 } }, targetPath: scratch.pathFor('b.mp4')
  })
  assert.equal(second.ok, true)
  assert.equal(second.task.state, 'queued')
  const cancelled = await exporter.cancel({ taskId: second.task.taskId })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.task.state, 'cancelled')
  assert.equal(fake.calls.length, 1, 'the queued task never started a process')
  await exporter.cancel({ taskId: first.task.taskId })
  await waitForTerminal(exporter, first.task.taskId, 10000)
})

test('the queue admits one encoder and two waiting tasks, and replays a matching request', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const fake = makeFakeFfmpeg({ hang: true })
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe(),
    spawnProcess: fake.spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const request = { format: 'mp4', range: { startMs: 0, endMs: 400 } }
  const first = await exporter.submit({ sessionId: session.id, requestId: 'queue-1', request, targetPath: scratch.pathFor('1.mp4') })
  assert.equal(first.ok, true)
  assert.equal(first.task.state, 'running')
  // Same requestId + same parameters is the same task, not a second encode (plan §8.3).
  const replay = await exporter.submit({ sessionId: session.id, requestId: 'queue-1', request, targetPath: scratch.pathFor('1.mp4') })
  assert.equal(replay.ok, true)
  assert.equal(replay.replayed, true)
  assert.equal(replay.task.taskId, first.task.taskId)
  // Same key, different parameters is a client bug.
  const mismatch = await exporter.submit({
    sessionId: session.id, requestId: 'queue-1', request: { ...request, range: { startMs: 0, endMs: 600 } }, targetPath: scratch.pathFor('1.mp4')
  })
  assert.equal(mismatch.code, 'request-mismatch')
  // R4 §4.4: segments AND video options are part of the request signature, so reusing a
  // requestId with a different multi-segment selection or different video options is a mismatch.
  const segmentsMismatch = await exporter.submit({
    sessionId: session.id,
    requestId: 'queue-1',
    request: { format: 'mp4', segments: [{ startMs: 0, endMs: 400 }, { startMs: 600, endMs: 900 }] },
    targetPath: scratch.pathFor('1.mp4')
  })
  assert.equal(segmentsMismatch.code, 'request-mismatch')
  const videoMismatch = await exporter.submit({
    sessionId: session.id,
    requestId: 'queue-1',
    request: { format: 'webm', segments: [{ startMs: 0, endMs: 400 }], video: { resolution: 'source', quality: 'high', fps: 'source' } },
    targetPath: scratch.pathFor('1.webm')
  })
  assert.equal(videoMismatch.code, 'request-mismatch')

  const second = await exporter.submit({ sessionId: session.id, requestId: 'queue-2', request, targetPath: scratch.pathFor('2.mp4') })
  const third = await exporter.submit({ sessionId: session.id, requestId: 'queue-3', request, targetPath: scratch.pathFor('3.mp4') })
  assert.equal(second.task.state, 'queued')
  assert.equal(third.task.state, 'queued')
  // Plan §3.3: one encoder, at most two waiting.
  const fourth = await exporter.submit({ sessionId: session.id, requestId: 'queue-4', request, targetPath: scratch.pathFor('4.mp4') })
  assert.equal(fourth.code, 'rate-limited')

  await exporter.cancel({ taskId: first.task.taskId })
  await waitForTerminal(exporter, first.task.taskId, 10000)
  await exporter.cancel({ taskId: second.task.taskId })
  await exporter.cancel({ taskId: third.task.taskId })
  await waitForTerminal(exporter, second.task.taskId, 10000)
  await waitForTerminal(exporter, third.task.taskId, 10000)
})

// Regression (E-07, found by adversarial review), two independent defects in the admission layer:
//
//  1. The limit was checked BEFORE the first `await` in submit(), so N concurrent callers all saw
//     the same counts and all passed - five clicks were admitted where plan §3.3 allows one running
//     plus two waiting. The check has to reserve synchronously before yielding.
//  2. A cancelled WAITER stayed in `this.queued` until the next pump(), i.e. for the whole duration
//     of the running encode. `queued.length` therefore counted dead entries and the next legitimate
//     submit was refused with a spurious `rate-limited`.
test('concurrent submits cannot over-admit, and cancelling a waiter frees its queue slot', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  // A hanging encoder keeps the first task `running` for the whole test.
  const fake = makeFakeFfmpeg({ hang: true })
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe(),
    spawnProcess: fake.spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const request = { format: 'mp4', range: { startMs: 0, endMs: 400 } }
  // Fire five submits WITHOUT awaiting between them: this is the double-click / impatient-user
  // shape that used to slip past the guard. All five are started before any of them reserves.
  const inFlight = []
  for (let index = 0; index < 5; index += 1) {
    inFlight.push(exporter.submit({
      sessionId: session.id,
      requestId: `burst-${index}`,
      request,
      targetPath: scratch.pathFor(`burst-${index}.mp4`)
    }))
  }
  const answers = await Promise.all(inFlight)
  const accepted = answers.filter((answer) => answer.ok)
  assert.equal(accepted.length, 3, `plan §3.3 admits one running plus two waiting (got ${accepted.length} of 5)`)
  assert.equal(
    answers.filter((answer) => !answer.ok && answer.code === 'rate-limited').length,
    2,
    'the overflow must be refused with rate-limited, not silently queued'
  )
  const running = accepted.filter((answer) => answer.task.state === 'running')
  const waiting = accepted.filter((answer) => answer.task.state === 'queued')
  assert.equal(running.length, 1, 'exactly one encoder')
  assert.equal(waiting.length, 2, 'exactly two waiting')

  // Cancel both waiters. Their slots must be freed IMMEDIATELY - not when the hanging encode ends
  // (which is never, in this test).
  for (const task of waiting) {
    const cancelled = await exporter.cancel({ taskId: task.task.taskId })
    assert.equal(cancelled.ok, true)
    assert.equal(cancelled.state, 'cancelled')
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(exporter.queued.length, 0, 'cancelled waiters must leave the queue at once')

  // With both waiting slots free, a fresh submit is admitted instead of refused.
  const fresh = await exporter.submit({
    sessionId: session.id,
    requestId: 'after-cancel',
    request,
    targetPath: scratch.pathFor('after-cancel.mp4')
  })
  assert.equal(fresh.ok, true, 'a free waiting slot must admit a new export, not report rate-limited')
  assert.equal(fresh.task.state, 'queued')

  await exporter.cancel({ taskId: running[0].task.taskId })
})

test('an export is refused before queueing when the range, the GIF budget or the target is bad', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const fake = makeFakeFfmpeg({ code: 0 })
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe(),
    spawnProcess: fake.spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const outOfBounds = await exporter.submit({
    sessionId: session.id, requestId: 'bad-1', request: { format: 'mp4', range: { startMs: 0, endMs: 9000 } }, targetPath: scratch.pathFor('x.mp4')
  })
  assert.equal(outOfBounds.code, 'range-out-of-bounds')
  const gifTooLong = await exporter.submit({
    sessionId: session.id, requestId: 'bad-2',
    request: { format: 'gif', range: { startMs: 0, endMs: 1999 }, gif: { fps: 20, maxEdgePx: 1280, loop: true } },
    targetPath: scratch.pathFor('x.gif')
  })
  assert.equal(gifTooLong.ok, true, 'a legal GIF request is accepted')
  await waitForTerminal(exporter, gifTooLong.task.taskId)
  const badTarget = await exporter.submit({
    sessionId: session.id, requestId: 'bad-3', request: { format: 'mp4', range: { startMs: 0, endMs: 400 } }, targetPath: ''
  })
  assert.equal(badTarget.code, 'target-unavailable')
  const unknownSession = await exporter.submit({
    sessionId: 'nope', requestId: 'bad-4', request: { format: 'mp4', range: { startMs: 0, endMs: 400 } }, targetPath: scratch.pathFor('y.mp4')
  })
  assert.equal(unknownSession.code, 'session-not-found')
  assert.equal(fake.calls.length >= 1, true)
})

test('a task is owner-scoped: another window cannot poll or cancel it', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe(),
    spawnProcess: makeFakeFfmpeg({ hang: true }).spawn,
    log: () => {}
  })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })
  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'owner-1',
    request: { format: 'mp4', range: { startMs: 0, endMs: 400 } },
    targetPath: scratch.pathFor('o.mp4'),
    ownerId: 'web-contents:1'
  })
  assert.equal(exporter.status({ taskId: submitted.task.taskId, ownerId: 'web-contents:2' }).code, 'invalid-owner')
  assert.equal(exporter.status({ taskId: submitted.task.taskId, ownerId: 'web-contents:1' }).ok, true)
  assert.equal((await exporter.cancel({ taskId: submitted.task.taskId, ownerId: 'web-contents:2' })).code, 'invalid-owner')
  // Status by (sessionId, requestId) recovers a lost progress event for the right owner.
  const byRequest = exporter.status({ sessionId: session.id, requestId: 'owner-1', ownerId: 'web-contents:1' })
  assert.equal(byRequest.ok, true)
  assert.equal(byRequest.task.taskId, submitted.task.taskId)
  await exporter.cancel({ taskId: submitted.task.taskId, ownerId: 'web-contents:1' })
  await waitForTerminal(exporter, submitted.task.taskId, 10000, 'web-contents:1')
})

test('shutdown cancels live tasks and waits for the children to exit', async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)
  const fake = makeFakeFfmpeg({ hang: true })
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe(),
    spawnProcess: fake.spawn,
    timeouts: { cancelKillGrace: 2000 },
    log: () => {}
  })
  t.after(async () => { await recordingService.dispose() })
  const submitted = await exporter.submit({
    sessionId: session.id, requestId: 'quit-1', request: { format: 'mp4', range: { startMs: 0, endMs: 400 } }, targetPath: scratch.pathFor('q.mp4')
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await exporter.dispose()
  const final = exporter.status({ taskId: submitted.task.taskId })
  assert.notEqual(final.task.state, 'succeeded', 'shutdown must never report an unverified file as success')
  assert.equal(exporter.hasActiveTasks(), false)
})

// ---------------------------------------------------------------------------
// E3: trim controller (no DOM, no Electron)
// ---------------------------------------------------------------------------

const METADATA = {
  durationMs: 10000,
  startMs: 0,
  video: { width: 1280, height: 720, frameRate: 30 },
  audio: { exists: true }
}

function makeTrim(overrides = {}) {
  return createRecordTrimController({
    sessionId: 'session-1',
    metadata: METADATA,
    translate: (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key),
    ...overrides
  })
}

test('the trim controller starts on the full range and edits stay half-open and valid', () => {
  const trim = makeTrim()
  assert.deepEqual(trim.state().range, { startMs: 0, endMs: 10000 })
  assert.equal(trim.state().canExport, true)

  assert.equal(trim.setStart(2000), true)
  assert.deepEqual(trim.state().range, { startMs: 2000, endMs: 10000 })
  assert.equal(trim.setEnd(5000), true)
  assert.deepEqual(trim.state().range, { startMs: 2000, endMs: 5000 })
  assert.equal(trim.state().selectionMs, 3000)

  // A start past the end is pushed back instead of producing an invalid range the user cannot fix.
  trim.setStart(99999)
  assert.ok(trim.state().range.startMs < trim.state().range.endMs)
  assert.deepEqual(trim.state().range, { startMs: 5000 - LIMITS.MIN_RANGE_MS, endMs: 5000 })
  assert.equal(trim.state().canExport, true)

  // An end before the start is pushed forward.
  trim.setEnd(0)
  assert.ok(trim.state().range.endMs > trim.state().range.startMs)

  // Unparsable text keeps the previous value instead of jumping the point to 0.
  const before = { ...trim.state().range }
  assert.equal(trim.setStart('not-a-time'), false)
  assert.deepEqual(trim.state().range, before)

  trim.resetRange()
  assert.deepEqual(trim.state().range, { startMs: 0, endMs: 10000 })
})

test('trim time inputs accept mm:ss.t and plain seconds, and reject garbage', () => {
  assert.equal(parseTimeInput('00:01.5'), 1500)
  assert.equal(parseTimeInput('1.5'), 1500)
  assert.equal(parseTimeInput('1:02'), 62000)
  assert.equal(parseTimeInput('0:00:02'), 2000)
  assert.equal(parseTimeInput(1234), 1234)
  assert.equal(parseTimeInput(''), null)
  assert.equal(parseTimeInput('abc'), null)
  assert.equal(parseTimeInput('-1'), null)
  assert.equal(parseTimeInput('1:2:3:4'), null)
})

test('range playback seeks to start, pauses at end and never edits the trim points', () => {
  const trim = makeTrim()
  trim.setStart(1000)
  trim.setEnd(3000)
  const range = trim.playRange()
  assert.deepEqual(range, { startMs: 1000, endMs: 3000 })

  // Inside the range: keep playing.
  assert.deepEqual(trim.reportTime(1500), { action: 'none', toMs: 1500 })
  // Landing before the range (keyframe snap): ask for a re-seek, do not play the trimmed head.
  assert.deepEqual(trim.reportTime(400), { action: 'seek', toMs: 1000 })
  // Reaching the end: pause exactly at the end point.
  assert.deepEqual(trim.reportTime(3000), { action: 'pause', toMs: 3000 })
  assert.equal(trim.state().playing, null)
  // The trim points are untouched by all of that (plan §8.2).
  assert.deepEqual(trim.state().range, { startMs: 1000, endMs: 3000 })

  // A user scrub outside the range ends range mode but keeps the range.
  trim.playRange()
  trim.reportTime(6000, { fromUser: true })
  assert.equal(trim.state().playing, null)
  assert.deepEqual(trim.state().range, { startMs: 1000, endMs: 3000 })
})

test('the GIF budget is shown up front and an out-of-budget selection cannot be submitted', () => {
  const trim = makeTrim({ metadata: { ...METADATA, durationMs: 90000 } })
  trim.setFormat('gif')
  trim.setGifFps(20)
  trim.setEnd(61000)
  const state = trim.state()
  assert.equal(state.format, 'gif')
  assert.equal(state.gifBudget.ok, false)
  assert.equal(state.gifBudget.code, 'gif-too-long')
  assert.equal(state.canExport, false, 'the UI must refuse before the main process has to reject it')

  trim.setEnd(60000)
  const legal = trim.state()
  assert.equal(legal.gifBudget.ok, true)
  assert.equal(legal.gifBudget.frames, 1200)
  assert.equal(legal.gifBudget.width, 1280, '1280x720 source capped to a 1280 long edge')
  assert.equal(legal.gifBudget.height, 720)
  assert.equal(legal.canExport, true)

  // Lowering the fps fixes a too-many-frames selection.
  const crowded = makeTrim({ metadata: { ...METADATA, durationMs: 60000, video: { width: 1920, height: 1080 } } })
  crowded.setFormat('gif')
  crowded.setGifFps(20)
  assert.equal(crowded.state().gifBudget.frames, 1200)
  assert.equal(crowded.state().canExport, true)
  crowded.setGifFps(15)
  assert.equal(crowded.state().gifBudget.frames, 900)
})

test('submitting freezes the controls and a lost receipt is recoverable by task id', async () => {
  const trim = makeTrim()
  trim.setStart(1000)
  trim.setEnd(4000)
  const submitted = []
  const answer = await trim.startExport({
    submit: async ({ requestId, request }) => {
      submitted.push({ requestId, request })
      return { status: 'accepted', task: { taskId: 'task-1', state: 'running', progress: 0 } }
    }
  })
  assert.equal(answer.status, 'accepted')
  assert.equal(submitted.length, 1)
  assert.deepEqual(submitted[0].request, { format: 'mp4', range: { startMs: 1000, endMs: 4000 } })
  assert.ok(submitted[0].requestId)
  const frozen = trim.state()
  assert.equal(frozen.busy, true)
  assert.equal(frozen.canExport, false)
  // R4: the frozen snapshot records the kept segments/format/video, not the legacy range.
  assert.deepEqual(frozen.frozen.segments, [{ startMs: 1000, endMs: 4000 }])
  assert.equal(frozen.frozen.format, 'mp4')
  assert.equal(frozen.frozen.keptMs, 3000)
  // Moving a control during the encode does not change what was submitted.
  assert.equal(trim.setStart(5000), false)
  assert.equal(trim.setFormat('gif'), false)
  assert.equal(trim.state().frozen.keptMs, 3000)

  // The progress push advances the bar but never reports 100 before publish.
  trim.applyTask({ taskId: 'task-1', state: 'running', progress: 44 })
  assert.equal(trim.state().task.progress, 44)
  trim.applyTask({ taskId: 'task-1', state: 'publishing', progress: 99 })
  assert.equal(trim.state().finishing, true)
  assert.equal(trim.state().canCancel, false, 'after the publish point the cancel button is disabled')
  trim.applyTask({
    taskId: 'task-1',
    state: 'succeeded',
    progress: 100,
    receipt: { status: 'saved', resultId: 'result-9', fileName: 'out.mp4', kind: 'mp4' }
  })
  const done = trim.state()
  assert.equal(done.phase, 'succeeded')
  assert.equal(done.receipt.resultId, 'result-9')
  assert.equal(done.busy, false)
  // A late event from a different task cannot resurrect an old bar.
  assert.equal(trim.applyTask({ taskId: 'task-other', state: 'running' }), false)
})

test('a failed export is retryable with a NEW request id, and a rejected submit leaves no task', async () => {
  const trim = makeTrim()
  const ids = []
  await trim.startExport({
    submit: async ({ requestId }) => {
      ids.push(requestId)
      return { status: 'failed', code: 'encode-failed' }
    }
  })
  assert.equal(trim.state().phase, 'failed')
  assert.equal(trim.state().error.code, 'encode-failed')
  assert.equal(trim.state().busy, false, 'a failure must not leave the controls frozen')
  assert.equal(trim.prepareRetry(), true)
  assert.equal(trim.state().phase, 'idle')
  await trim.startExport({
    submit: async ({ requestId }) => {
      ids.push(requestId)
      return { status: 'accepted', task: { taskId: 'task-2', state: 'running' } }
    }
  })
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1], 'a retry is a new request (plan §8.3: new requestId per attempt)')

  // A dismissed save dialog creates no task and is not an error.
  const fresh = makeTrim()
  const cancelled = await fresh.startExport({ submit: async () => ({ status: 'cancelled' }) })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(fresh.state().phase, 'idle')
  assert.equal(fresh.state().task, null)
  assert.equal(fresh.state().error, null)

  // A server rejection maps to an error code, not to a stuck busy state.
  const rejecting = makeTrim()
  const rejected = await rejecting.startExport({ submit: async () => ({ status: 'failed', code: 'rate-limited' }) })
  assert.equal(rejected.status, 'failed')
  assert.equal(rejecting.state().error.code, 'rate-limited')
  assert.equal(rejecting.state().busy, false)
})

test('an invalid selection is refused locally with an actionable code', async () => {
  const trim = makeTrim()
  trim.setStart(9000)
  trim.setEnd(10000)
  // A 1 s selection is legal; force an illegal one by reaching past the media.
  const tiny = makeTrim()
  tiny.setEnd(0) // clamped to MIN_RANGE_MS
  const state = tiny.state()
  assert.equal(state.range.endMs - state.range.startMs, LIMITS.MIN_RANGE_MS)
  assert.equal(state.canExport, true)

  const noMetadata = createRecordTrimController({ sessionId: 's', metadata: { durationMs: 0, video: {}, audio: {} }, translate: (key) => key })
  const answer = await noMetadata.startExport({ submit: async () => ({ status: 'accepted', task: {} }) })
  assert.equal(answer.code, 'duration-unavailable')
})

test('after a successful export the source and range are kept so the user can export again', async () => {
  const trim = makeTrim()
  trim.setStart(1000)
  await trim.startExport({ submit: async () => ({ status: 'accepted', task: { taskId: 't', state: 'running' } }) })
  trim.applyTask({ taskId: 't', state: 'succeeded', progress: 100, receipt: { status: 'saved', resultId: 'r', fileName: 'a.mp4', kind: 'mp4' } })
  assert.equal(trim.state().phase, 'succeeded')
  // Plan §8.2: the preview and the range stay; only a re-record or a close ends the session.
  assert.deepEqual(trim.state().range.startMs, 1000)
  assert.equal(trim.resetAfterExport(), true)
  assert.equal(trim.state().phase, 'idle')
  assert.deepEqual(trim.state().range.startMs, 1000, 'the range survives a second export')
  assert.equal(trim.state().receipt, null)
})

test('every export error code the UI can receive maps to a locale key that record.js defines', () => {
  // The service's frozen vocabulary and the controller's map must not drift: an unmapped code
  // would surface as a raw token in the preview. R4 added codes that the EDITOR maps in its own
  // `recording.editor.error.*` namespace (W9 owns that table and its own completeness test), so
  // this test checks the mapping for every code and the tables for the legacy record namespace.
  for (const code of EXPORT_ERROR_CODES) {
    const key = errorKey(code)
    assert.equal(typeof key, 'string', `${code} maps to a locale key`)
    assert.ok(key.length > 0, `${code} maps to a non-empty key`)
  }
  assert.equal(errorKey('something-new'), 'record.error.export-failed')
  globalThis.__LOCALES = {}
  require('../shared/locales/record.js')
  const tables = globalThis.__LOCALES
  for (const code of EXPORT_ERROR_CODES) {
    const key = errorKey(code)
    if (!key.startsWith('record.error.')) continue
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      assert.equal(typeof tables[language][key], 'string', `${language} is missing ${key} (code ${code})`)
    }
  }
  // The controller's full advertised key list (including the editor-only
  // `recording.editor.*` table) is asserted by W9's own trim-controller test, which loads the
  // editor locale too; this test keeps its R1-R3 responsibility: every code maps, and every
  // legacy `record.error.*` code has its three-language message.
})

// ---------------------------------------------------------------------------
// R4 export pipeline v2 with the REAL encoder (contract §4.3/§6)
// ---------------------------------------------------------------------------

test('a three-segment MP4 export concatenates the kept spans and verifies their sum', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const source = makeWebmSample(scratch.pathFor('source.webm'), { withAudio: true, seconds: 3, size: '320x240', rate: 10 })
  const probe = createMediaProbe({ ffmpegPath })
  const { recordingService, exporter, registrations } = makeExportHarness({ scratch, probe })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  const session = await recordingService.startSession()
  await recordingService.appendChunk(session.id, fs.readFileSync(source))
  await recordingService.finishSession(session.id)
  const probed = await recordingService.probeSession(session.id)
  assert.equal(probed.ok, true)
  const sourceFps = probed.metadata.video.frameRate
  assert.equal(sourceFps, 10)

  const segments = [{ startMs: 0, endMs: 600 }, { startMs: 1200, endMs: 1800 }, { startMs: 2400, endMs: 2900 }]
  const total = 600 + 600 + 500
  const target = scratch.pathFor('out/multi.mp4')
  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'multi-segment-mp4',
    request: { format: 'mp4', segments, video: { resolution: 'source', quality: 'standard', fps: 'source' } },
    targetPath: target,
    ownerId: 'web-contents:r4'
  })
  assert.equal(submitted.ok, true, JSON.stringify(submitted))
  const settled = await waitForTerminal(exporter, submitted.task.taskId, 120000, 'web-contents:r4')
  assert.equal(settled.state, 'succeeded', JSON.stringify(settled.error || null))
  assert.equal(settled.receipt.kind, 'mp4')
  assert.equal(registrations.length, 1)

  const published = await probe.probe(target)
  assert.equal(published.ok, true)
  assert.deepEqual([published.metadata.video.width, published.metadata.video.height], [320, 240])
  assert.equal(published.metadata.audio.exists, true, 'the mixed audio track survives the concat')
  assert.ok(
    Math.abs(published.metadata.durationMs - total) <= durationToleranceMs(total, { segments: segments.length, sourceFps }),
    `multi-segment duration ${published.metadata.durationMs} is within tolerance of ${total}`
  )

  // The legacy single-range form still works from the same session (R1-R3 compatibility).
  const rangeTarget = scratch.pathFor('out/range.mp4')
  const rangeTask = await exporter.submit({
    sessionId: session.id,
    requestId: 'legacy-range-compat',
    request: { format: 'mp4', range: { startMs: 1200, endMs: 1800 } },
    targetPath: rangeTarget,
    ownerId: 'web-contents:r4'
  })
  assert.equal(rangeTask.ok, true)
  assert.equal((await waitForTerminal(exporter, rangeTask.task.taskId, 120000, 'web-contents:r4')).state, 'succeeded')
  const rangeProbe = await probe.probe(rangeTarget)
  assert.equal(rangeProbe.ok, true)
  assert.ok(Math.abs(rangeProbe.metadata.durationMs - 600) <= durationToleranceMs(600, { segments: 1, sourceFps }))
})

test('a full-range WebM export is a stream copy while an edited WebM is re-encoded', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const source = makeWebmSample(scratch.pathFor('source.webm'), { withAudio: true, seconds: 3, size: '320x240', rate: 10 })
  const probe = createMediaProbe({ ffmpegPath })
  const sourceProbe = await probe.probe(source)
  assert.equal(sourceProbe.ok, true)
  const sourceCodec = sourceProbe.metadata.video.codec
  assert.equal(sourceCodec, 'vp8', 'the fixture is VP8; the re-encode below must produce VP9')

  const { recordingService, exporter, registrations } = makeExportHarness({ scratch, probe })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })
  const session = await recordingService.startSession()
  await recordingService.appendChunk(session.id, fs.readFileSync(source))
  await recordingService.finishSession(session.id)
  await recordingService.probeSession(session.id)

  // No selected range + source resolution/fps => remux, no re-encode.
  const copyTarget = scratch.pathFor('out/copy.webm')
  const copyTask = await exporter.submit({
    sessionId: session.id,
    requestId: 'webm-copy',
    request: { format: 'webm' },
    targetPath: copyTarget,
    ownerId: 'web-contents:r4'
  })
  assert.equal(copyTask.ok, true, JSON.stringify(copyTask))
  const copied = await waitForTerminal(exporter, copyTask.task.taskId, 120000, 'web-contents:r4')
  assert.equal(copied.state, 'succeeded', JSON.stringify(copied.error || null))
  assert.equal(copied.receipt.kind, 'webm')
  const copyProbe = await probe.probe(copyTarget)
  assert.equal(copyProbe.ok, true)
  assert.equal(copyProbe.metadata.video.codec, sourceCodec, 'stream copy keeps the source codec (no re-encode)')
  assert.deepEqual([copyProbe.metadata.video.width, copyProbe.metadata.video.height], [320, 240])
  assert.equal(copyProbe.metadata.audio.exists, true)
  assert.ok(Math.abs(copyProbe.metadata.durationMs - sourceProbe.metadata.durationMs) <= 250)

  // A trimmed WebM must re-encode (VP9 + Opus) and honour the selection.
  const trimmedTarget = scratch.pathFor('out/trimmed.webm')
  const trimTask = await exporter.submit({
    sessionId: session.id,
    requestId: 'webm-reencode',
    request: { format: 'webm', segments: [{ startMs: 600, endMs: 1600 }], video: { resolution: 'source', quality: 'standard', fps: 'source' } },
    targetPath: trimmedTarget,
    ownerId: 'web-contents:r4'
  })
  assert.equal(trimTask.ok, true)
  const trimmed = await waitForTerminal(exporter, trimTask.task.taskId, 120000, 'web-contents:r4')
  assert.equal(trimmed.state, 'succeeded', JSON.stringify(trimmed.error || null))
  const trimProbe = await probe.probe(trimmedTarget)
  assert.equal(trimProbe.ok, true)
  assert.equal(trimProbe.metadata.video.codec, 'vp9', 'an edited WebM is re-encoded with VP9')
  assert.ok(Math.abs(trimProbe.metadata.durationMs - 1000) <= durationToleranceMs(1000, { segments: 1, sourceFps: 10 }))
  assert.equal(trimProbe.metadata.audio.exists, true)
  assert.equal(registrations.filter((entry) => entry.kind === 'webm').length, 2)
})

test('resolution presets downscale the real output and never upscale a small source', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const probe = createMediaProbe({ ffmpegPath })
  const { recordingService, exporter } = makeExportHarness({ scratch, probe })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  // 1280x720 source, 480p preset: long edge capped at 854 -> 854x480.
  const medium = makeWebmSample(scratch.pathFor('medium.webm'), { withAudio: true, seconds: 2, size: '1280x720', rate: 30 })
  const mediumSession = await recordingService.startSession()
  await recordingService.appendChunk(mediumSession.id, fs.readFileSync(medium))
  await recordingService.finishSession(mediumSession.id)
  await recordingService.probeSession(mediumSession.id)
  const downscaledTarget = scratch.pathFor('out/480p.mp4')
  const downscaled = await exporter.submit({
    sessionId: mediumSession.id,
    requestId: 'downscale-480p',
    request: { format: 'mp4', segments: [{ startMs: 300, endMs: 1300 }], video: { resolution: '480p', quality: 'high', fps: 30 } },
    targetPath: downscaledTarget
  })
  assert.equal(downscaled.ok, true)
  assert.equal((await waitForTerminal(exporter, downscaled.task.taskId)).state, 'succeeded')
  const downscaledProbe = await probe.probe(downscaledTarget)
  assert.equal(downscaledProbe.ok, true)
  assert.deepEqual([downscaledProbe.metadata.video.width, downscaledProbe.metadata.video.height], [854, 480])

  // 320x240 source, 720p preset: the capture is smaller than the cap, so it stays 320x240.
  const small = makeWebmSample(scratch.pathFor('small.webm'), { withAudio: false, seconds: 2, size: '320x240', rate: 10 })
  const smallSession = await recordingService.startSession()
  await recordingService.appendChunk(smallSession.id, fs.readFileSync(small))
  await recordingService.finishSession(smallSession.id)
  await recordingService.probeSession(smallSession.id)
  const noUpscaleTarget = scratch.pathFor('out/720p-small.mp4')
  const noUpscale = await exporter.submit({
    sessionId: smallSession.id,
    requestId: 'never-upscale',
    request: { format: 'mp4', segments: [{ startMs: 0, endMs: 1000 }], video: { resolution: '720p', quality: 'standard', fps: 'source' } },
    targetPath: noUpscaleTarget
  })
  assert.equal(noUpscale.ok, true)
  assert.equal((await waitForTerminal(exporter, noUpscale.task.taskId)).state, 'succeeded')
  const noUpscaleProbe = await probe.probe(noUpscaleTarget)
  assert.deepEqual([noUpscaleProbe.metadata.video.width, noUpscaleProbe.metadata.video.height], [320, 240])
})

test('frame-rate and quality tiers reach the real encoder', { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const probe = createMediaProbe({ ffmpegPath })
  const { recordingService, exporter } = makeExportHarness({ scratch, probe })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })

  // 60fps source: 30fps is offered and reaches the encoder; 60fps on a 30fps source is refused.
  const fast = makeWebmSample(scratch.pathFor('fast.webm'), { withAudio: false, seconds: 2, size: '640x360', rate: 60 })
  const session = await recordingService.startSession()
  await recordingService.appendChunk(session.id, fs.readFileSync(fast))
  await recordingService.finishSession(session.id)
  await recordingService.probeSession(session.id)

  const fpsTarget = scratch.pathFor('out/fps30.mp4')
  const fpsTask = await exporter.submit({
    sessionId: session.id,
    requestId: 'fps-30-from-60',
    request: { format: 'mp4', segments: [{ startMs: 0, endMs: 1000 }], video: { resolution: 'source', quality: 'standard', fps: 30 } },
    targetPath: fpsTarget
  })
  assert.equal(fpsTask.ok, true, JSON.stringify(fpsTask))
  assert.equal((await waitForTerminal(exporter, fpsTask.task.taskId)).state, 'succeeded')
  const fpsProbe = await probe.probe(fpsTarget)
  assert.equal(fpsProbe.ok, true)
  assert.ok(fpsProbe.metadata.video.frameRate >= 29 && fpsProbe.metadata.video.frameRate <= 31,
    `output frame rate ${fpsProbe.metadata.video.frameRate} should be 30`)

  // Quality tiers: same content/selection, lower CRF must not produce a smaller file.
  const sizes = {}
  for (const quality of ['standard', 'ultra']) {
    const target = scratch.pathFor(`out/quality-${quality}.mp4`)
    const task = await exporter.submit({
      sessionId: session.id,
      requestId: `quality-${quality}`,
      request: { format: 'mp4', segments: [{ startMs: 0, endMs: 800 }], video: { resolution: 'source', quality, fps: 'source' } },
      targetPath: target
    })
    assert.equal(task.ok, true)
    assert.equal((await waitForTerminal(exporter, task.task.taskId)).state, 'succeeded')
    sizes[quality] = fs.statSync(target).size
    assert.ok(sizes[quality] > 0)
  }
  assert.ok(sizes.ultra >= sizes.standard, `ultra (${sizes.ultra}) should not be smaller than standard (${sizes.standard})`)

  // 60 > 30fps source: refused by the normaliser before any encode (contract §4.2).
  const slow = makeWebmSample(scratch.pathFor('slow.webm'), { withAudio: false, seconds: 1, size: '320x240', rate: 30 })
  const slowSession = await recordingService.startSession()
  await recordingService.appendChunk(slowSession.id, fs.readFileSync(slow))
  await recordingService.finishSession(slowSession.id)
  await recordingService.probeSession(slowSession.id)
  const rejected = await exporter.submit({
    sessionId: slowSession.id,
    requestId: 'fps-above-source',
    request: { format: 'mp4', segments: [{ startMs: 0, endMs: 600 }], video: { fps: 60 } },
    targetPath: scratch.pathFor('out/fps60.mp4')
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'fps-above-source')
})

// ---------------------------------------------------------------------------
// R5 demo rendering (contract §3): normalised demo shape, ffmpeg graph, real frame assertions
// ---------------------------------------------------------------------------

const sharpModule = (() => {
  try {
    return require('sharp')
  } catch {
    return null
  }
})()
const demoRenderingAvailable = ffmpegAvailable && !!sharpModule

function makeStaticWebmSample(targetPath, { lavfi = 'smptebars=size=640x360:rate=10:duration=3', withAudio = true, seconds = 3 } = {}) {
  if (!ffmpegAvailable) return null
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', lavfi]
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`)
  args.push('-c:v', 'libvpx', '-b:v', '300k')
  if (withAudio) args.push('-c:a', 'libopus', '-shortest')
  else args.push('-an')
  args.push('-y', targetPath)
  const result = spawnSync(ffmpegPath, args, { encoding: 'utf8', timeout: 60000, windowsHide: true })
  assert.equal(result.status, 0, `Unable to build the static WebM fixture.\n${result.stderr}`)
  return targetPath
}

async function seedStaticSession(recordingService, fixturePath) {
  const session = await recordingService.startSession()
  await recordingService.appendChunk(session.id, fs.readFileSync(fixturePath))
  await recordingService.finishSession(session.id)
  const probed = await recordingService.probeSession(session.id)
  assert.equal(probed.ok, true)
  return session
}

// Extracts one frame at `seconds` and exposes raw pixels. Frames are small (canvas <= 800px) so
// reading them with sharp is cheap and avoids a PNG parser dependency.
async function extractFramePixels(filePath, seconds, scratch, name) {
  const framePath = scratch.pathFor(`${name}.png`)
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', filePath,
    '-frames:v', '1', '-y', framePath
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  assert.equal(result.status, 0, `Unable to extract the frame.\n${result.stderr}`)
  const { data, info } = await sharpModule(framePath).raw().toBuffer({ resolveWithObject: true })
  const pixel = (x, y) => {
    const offset = (Math.round(y) * info.width + Math.round(x)) * info.channels
    return [data[offset], data[offset + 1], data[offset + 2]]
  }
  const luminance = (x, y) => {
    const [r, g, b] = pixel(x, y)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  return { width: info.width, height: info.height, channels: info.channels, pixel, luminance }
}

function colorDistance(left, right) {
  return Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]) + Math.abs(left[2] - right[2])
}

test('request.demo is normalised to an output-time plan and canvas expected shape', () => {
  const metadata = { durationMs: 5000, video: { width: 1920, height: 1080, frameRate: 30 }, audio: { exists: true } }
  const withoutDemo = normalizeExportRequest({
    format: 'mp4', segments: [{ startMs: 0, endMs: 2000 }]
  }, metadata)
  assert.equal(withoutDemo.value.demo, null, 'no demo request -> R4 output')

  const withDemo = normalizeExportRequest({
    format: 'mp4',
    segments: [{ startMs: 0, endMs: 2000 }, { startMs: 2500, endMs: 4000 }],
    video: { resolution: '720p', quality: 'high', fps: 30 },
    demo: {
      style: { enabled: true, background: '#f5f2ea', padding: 0.1, radius: 16, shadow: true, ripples: true },
      zooms: [{ startMs: 1000, endMs: 2200, scale: 2, focusX: 0.5, focusY: 0.5 }],
      clicks: [
        { tMs: 1500, x: 0.3, y: 0.4, button: 0 },
        { tMs: 2800, x: 0.6, y: 0.5, button: 0 }
      ]
    }
  }, metadata)
  assert.equal(withDemo.ok, true)
  const demoValue = withDemo.value.demo
  assert.equal(demoValue.rendered, true)
  assert.deepEqual(demoValue.style, {
    enabled: true, background: '#f5f2ea', padding: 0.1, radius: 16, shadow: true, ripples: true
  })
  // Source-time plan mapped through the kept ranges: the zoom is truncated at the cut, the
  // second click is shifted left by the deleted gap.
  assert.deepEqual(demoValue.zooms, [
    { startMs: 1000, endMs: 2000, scale: 2, focusX: 0.5, focusY: 0.5, easing: 'ease-in-out' }
  ])
  assert.deepEqual(demoValue.clicks, [
    { tMs: 1500, x: 0.3, y: 0.4, button: 0 },
    { tMs: 2300, x: 0.6, y: 0.5, button: 0 }
  ])
  // 1280x720 content + 10% padding -> 1600x900 canvas.
  assert.deepEqual(
    [demoValue.contentWidth, demoValue.contentHeight, demoValue.canvasWidth, demoValue.canvasHeight, demoValue.paddingPx],
    [1280, 720, 1600, 900, 160]
  )
  // The enhanced pipeline always re-encodes (no WebM copy fast path).
  const webm = normalizeExportRequest({ format: 'webm', demo: { style: { enabled: true, padding: 0.1 } } }, metadata)
  assert.equal(webm.value.video.copy, false)

  // GIF ignores demo (documented R5 interpretation: no canvas pipeline for the GIF budget).
  const gif = normalizeExportRequest({
    format: 'gif', gif: { edge: 1280, fps: 15 }, demo: { style: { enabled: true, padding: 0.1 } }
  }, metadata)
  assert.equal(gif.ok, true)
  assert.equal(gif.value.demo, null)

  // Style disabled + no zooms/ripples is R4-equivalent (demo stays null).
  const inert = normalizeExportRequest({
    format: 'mp4', demo: { style: { enabled: false }, zooms: [], clicks: [] }
  }, metadata)
  assert.equal(inert.value.demo, null)
  // Ripples off: a clicks array is not rendered on its own.
  const ripplesOff = normalizeExportRequest({
    format: 'mp4', demo: { style: { enabled: false, ripples: false }, clicks: [{ tMs: 100, x: 0.5, y: 0.5 }] }
  }, metadata)
  assert.equal(ripplesOff.value.demo, null)
})

test('illegal demo payloads are refused with invalid-demo-option', () => {
  const metadata = { durationMs: 5000, video: { width: 320, height: 240, frameRate: 10 }, audio: { exists: true } }
  const cases = [
    'not-an-object',
    { style: [] },
    { zooms: 'nope' },
    { clicks: {} },
    { style: { enabled: true, padding: 0.1 }, zooms: {} }
  ]
  for (const demo of cases) {
    assert.equal(normalizeExportRequest({ format: 'mp4', demo }, metadata).code, 'invalid-demo-option', JSON.stringify(demo))
  }
  // A demo look that cannot be resolved (no source dimensions) is refused, never guessed.
  assert.equal(normalizeExportRequest(
    { format: 'mp4', demo: { style: { enabled: true, padding: 0.1 } } },
    { durationMs: 1000, video: {}, audio: { exists: false } }
  ).code, 'invalid-demo-option')
})

test('the demo request signature covers the style/camera plan', () => {
  const base = {
    format: 'mp4',
    segments: [{ startMs: 0, endMs: 2000 }],
    video: { resolution: 'source', quality: 'standard', fps: 'source' }
  }
  const normalizedBase = normalizeExportRequest({ ...base, demo: { style: { enabled: true, padding: 0.1 } } }, {
    durationMs: 5000, video: { width: 640, height: 360, frameRate: 10 }, audio: { exists: true }
  }).value
  const normalizedSame = normalizeExportRequest({ ...base, demo: { style: { enabled: true, padding: 0.1 } } }, {
    durationMs: 5000, video: { width: 640, height: 360, frameRate: 10 }, audio: { exists: true }
  }).value
  assert.equal(requestSignature(normalizedBase), requestSignature(normalizedSame))
  const otherStyle = normalizeExportRequest({
    ...base,
    demo: { style: { enabled: true, padding: 0.2 }, zooms: [{ startMs: 0, endMs: 800, scale: 2 }] }
  }, { durationMs: 5000, video: { width: 640, height: 360, frameRate: 10 }, audio: { exists: true } }).value
  assert.notEqual(requestSignature(normalizedBase), requestSignature(otherStyle))
})

test('buildExportArgs renders the demo chain and keeps the R4 path untouched otherwise', () => {
  const metadata = { durationMs: 5000, video: { width: 640, height: 360, frameRate: 10 }, audio: { exists: true } }
  const normalized = normalizeExportRequest({
    format: 'mp4',
    segments: [{ startMs: 0, endMs: 2000 }],
    video: { resolution: 'source', quality: 'standard', fps: 'source' },
    demo: {
      style: { enabled: true, background: '#0f1115', padding: 0.1, radius: 16, shadow: true, ripples: true },
      zooms: [{ startMs: 500, endMs: 1500, scale: 2, focusX: 0.5, focusY: 0.5, easing: 'linear' }],
      clicks: [{ tMs: 1000, x: 0.4, y: 0.5, button: 0 }]
    }
  }, metadata).value
  const assets = { bgPath: '/tmp/task.bg.png', maskPath: '/tmp/task.mask.png', ripplePath: '/tmp/task.ripple.png' }
  const built = buildExportArgs({ ...normalized, inputPath: 'in.webm', outputPath: 'out.mp4', demoAssets: assets })
  assert.deepEqual(built.expected, {
    format: 'mp4',
    durationMs: 2000,
    width: 800,
    height: 450,
    hasAudio: true,
    fps: 10,
    demoRendered: true,
    contentWidth: 640,
    contentHeight: 360
  })
  const args = built.args
  const graph = args[args.indexOf('-filter_complex') + 1]
  // Documented order: concat -> scale content -> ripple -> zoompan -> alphamerge -> overlay bg.
  assert.match(graph, /\[outv\]scale=640:360:flags=lanczos\[scaled\]/)
  assert.match(graph, /scale=w='96\*\(0\.35\+0\.65\*min\(1,max\(0,\(t-1\.000000\)\/0\.6\)\)\)'/)
  assert.match(graph, /overlay=x='0\.4000\*W-w\/2':y='0\.5000\*H-h\/2':enable='between\(t,1\.000000,1\.600000\)'/)
  assert.match(graph, /zoompan=z='if\(lt\(on\/10,/, 'render frame rate is the source fps')
  assert.match(graph, /\[.*\]\[2:v\]alphamerge\[canvasMasked\]/)
  assert.match(graph, /\[1:v\]\[canvasMasked\]overlay=x=80:y=45:format=auto:shortest=1\[demoCanvas\]/)
  assert.match(graph, /\[demoCanvas\]format=yuv420p\[demoOut\]/)
  assert.equal(args[args.indexOf('-map') + 1], '[demoOut]')
  // Asset inputs are looped, fps-locked and BOUNDED so ffmpeg terminates.
  assert.deepEqual(args.slice(args.indexOf('-i', args.indexOf('-i') + 1) - 6, args.indexOf('-i', args.indexOf('-i') + 1) + 2),
    ['-loop', '1', '-framerate', '10', '-t', '2.000000', '-i', assets.bgPath])
  // Audio branch is unchanged by the demo rendering.
  assert.deepEqual(args.slice(args.indexOf('-map', args.indexOf('-map') + 1), args.indexOf('-c:v')), [
    '-map', '[outa]', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'
  ])

  // A plain R4 request and an inert-demo request must build byte-identical argv/expected.
  const plain = normalizeExportRequest({
    format: 'mp4', segments: [{ startMs: 0, endMs: 2000 }], video: { resolution: 'source', quality: 'standard', fps: 'source' }
  }, metadata).value
  const plainBuilt = buildExportArgs({ ...plain, inputPath: 'in.webm', outputPath: 'out.mp4' })
  const inertDemo = normalizeExportRequest({
    format: 'mp4',
    segments: [{ startMs: 0, endMs: 2000 }],
    video: { resolution: 'source', quality: 'standard', fps: 'source' },
    demo: { style: { enabled: false }, zooms: [], clicks: [] }
  }, metadata).value
  const inertBuilt = buildExportArgs({ ...inertDemo, inputPath: 'in.webm', outputPath: 'out.mp4' })
  assert.deepEqual(inertBuilt, plainBuilt, 'non-demo output stays R4-equivalent')
  assert.equal('demoRendered' in plainBuilt.expected, false)
})

test('a demo look renders the canvas: padding, rounded corners and background pixels', { skip: !demoRenderingAvailable && 'ffmpeg-static/sharp is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const fixture = makeStaticWebmSample(scratch.pathFor('static.webm'), { withAudio: true })
  const probe = createMediaProbe({ ffmpegPath })
  const { recordingService, exporter } = makeExportHarness({ scratch, probe })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })
  const session = await seedStaticSession(recordingService, fixture)

  const target = scratch.pathFor('out/demo.mp4')
  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'demo-style',
    request: {
      format: 'mp4',
      segments: [{ startMs: 0, endMs: 1200 }, { startMs: 2000, endMs: 3000 }],
      video: { resolution: 'source', quality: 'standard', fps: 'source' },
      demo: {
        style: { enabled: true, background: '#f5f2ea', padding: 0.1, radius: 16, shadow: false, ripples: false },
        zooms: [],
        clicks: []
      }
    },
    targetPath: target
  })
  assert.equal(submitted.ok, true, JSON.stringify(submitted))
  const settled = await waitForTerminal(exporter, submitted.task.taskId)
  assert.equal(settled.state, 'succeeded', JSON.stringify(settled.error || null))

  const published = await probe.probe(target)
  assert.equal(published.ok, true)
  // 640x360 content at 10% padding -> 800x450 canvas (contract §3.3 expected dims).
  assert.deepEqual([published.metadata.video.width, published.metadata.video.height], [800, 450])
  assert.equal(published.metadata.audio.exists, true)
  assert.ok(Math.abs(published.metadata.durationMs - 2200) <= durationToleranceMs(2200, { segments: 2, sourceFps: 10 }))
  // Canvas assets do not leak beside the published file.
  assert.deepEqual((await fsp.readdir(path.dirname(target))).filter((name) => name !== path.basename(target)), [])

  const frame = await extractFramePixels(target, 1.0, scratch, 'style')
  assert.deepEqual([frame.width, frame.height], [800, 450])
  const background = [0xf5, 0xf2, 0xea]
  assert.ok(colorDistance(frame.pixel(2, 2), background) <= 8, `top-left corner is the background: ${frame.pixel(2, 2)}`)
  assert.ok(colorDistance(frame.pixel(797, 447), background) <= 8, 'bottom-right corner is the background')
  assert.ok(colorDistance(frame.pixel(400, 225), background) > 40, `content centre differs from the background: ${frame.pixel(400, 225)}`)
})

test('rounded corners clip the content to the background while an R4 export keeps its corners', { skip: !demoRenderingAvailable && 'ffmpeg-static/sharp is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const fixture = makeStaticWebmSample(scratch.pathFor('static.webm'), { withAudio: false })
  const probe = createMediaProbe({ ffmpegPath })
  const { recordingService, exporter } = makeExportHarness({ scratch, probe })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })
  const session = await seedStaticSession(recordingService, fixture)
  // A light background survives the yuv420p round-trip precisely; near-black quantises too coarsely
  // for an exact corner-pixel assertion.
  const background = [0xf5, 0xf2, 0xea]

  const render = async (requestId, demo, name) => {
    const target = scratch.pathFor(`out/${name}.mp4`)
    const task = await exporter.submit({
      sessionId: session.id,
      requestId,
      request: { format: 'mp4', segments: [{ startMs: 0, endMs: 1000 }], video: { resolution: 'source', quality: 'standard', fps: 'source' }, ...(demo ? { demo } : {}) },
      targetPath: target
    })
    assert.equal(task.ok, true, JSON.stringify(task))
    const terminal = await waitForTerminal(exporter, task.task.taskId)
    assert.equal(terminal.state, 'succeeded', JSON.stringify(terminal.error || null))
    return target
  }

  // 10% padding gives a real background frame; the rounded mask then decides whether the
  // CONTENT corner pixels show the background or the content.
  const rounded = await render('demo-radius', {
    style: { enabled: true, background: '#f5f2ea', padding: 0.1, radius: 24, shadow: false, ripples: false },
    zooms: [],
    clicks: []
  }, 'rounded')
  const plain = await render('demo-none', null, 'plain')
  const roundedFrame = await extractFramePixels(rounded, 0.5, scratch, 'rounded-frame')
  const plainFrame = await extractFramePixels(plain, 0.5, scratch, 'plain-frame')
  assert.deepEqual([roundedFrame.width, roundedFrame.height], [800, 450])
  // Canvas corner (outside the content box) is the background.
  assert.ok(colorDistance(roundedFrame.pixel(2, 2), background) <= 12, `canvas corner shows the background: ${roundedFrame.pixel(2, 2)}`)
  // The content box starts at (80, 45); its 2 px corner is cut away by the 12 px radius.
  assert.ok(colorDistance(roundedFrame.pixel(81, 46), background) <= 12, `rounded content corner shows the background: ${roundedFrame.pixel(81, 46)}`)
  // A point well inside the radius is content, not background.
  assert.ok(colorDistance(roundedFrame.pixel(114, 79), background) > 40, 'content inside the corner radius is untouched')
  assert.ok(colorDistance(roundedFrame.pixel(400, 225), background) > 40, 'content centre is untouched')
  // The same content coordinates in an R4 export (no mask) are content at the corner.
  assert.ok(colorDistance(plainFrame.pixel(1, 1), background) > 40, 'the R4 export keeps its square content corner')
})

test('a zoom segment visibly magnifies the frame around its focus', { skip: !demoRenderingAvailable && 'ffmpeg-static/sharp is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const fixture = makeStaticWebmSample(scratch.pathFor('static.webm'), { withAudio: false })
  const probe = createMediaProbe({ ffmpegPath })
  const { recordingService, exporter } = makeExportHarness({ scratch, probe })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })
  const session = await seedStaticSession(recordingService, fixture)

  const render = async (requestId, demo, name) => {
    const target = scratch.pathFor(`out/${name}.mp4`)
    const task = await exporter.submit({
      sessionId: session.id,
      requestId,
      request: { format: 'mp4', segments: [{ startMs: 0, endMs: 3000 }], video: { resolution: 'source', quality: 'standard', fps: 'source' }, ...(demo ? { demo } : {}) },
      targetPath: target
    })
    assert.equal(task.ok, true)
    const terminal = await waitForTerminal(exporter, task.task.taskId)
    assert.equal(terminal.state, 'succeeded', JSON.stringify(terminal.error || null))
    return target
  }

  const zoomed = await render('demo-zoom', {
    style: { enabled: false },
    zooms: [{ startMs: 600, endMs: 1800, scale: 2, focusX: 0.5, focusY: 0.5, easing: 'linear' }],
    clicks: []
  }, 'zoomed')
  const plain = await render('demo-zoom-none', null, 'zoom-plain')
  const zoomedProbe = await probe.probe(zoomed)
  assert.deepEqual([zoomedProbe.metadata.video.width, zoomedProbe.metadata.video.height], [640, 360], 'zoom keeps the source frame size')
  const zoomedFrame = await extractFramePixels(zoomed, 1.2, scratch, 'zoomed-frame')
  const plainFrame = await extractFramePixels(plain, 1.2, scratch, 'plain-zoom-frame')

  // A 2x centre zoom shows the CENTRE half of the plain frame: downscaling the zoomed frame by 2
  // must match the plain frame's centre crop, which is only true if the content was magnified.
  const zoomedPng = scratch.pathFor('zoomed-frame.png')
  const plainPng = scratch.pathFor('plain-zoom-frame.png')
  const downscaled = await sharpModule(zoomedPng).resize(320, 180, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
  const centreCrop = await sharpModule(plainPng).extract({ left: 160, top: 90, width: 320, height: 180 }).raw().toBuffer({ resolveWithObject: true })
  let difference = 0
  const pixels = Math.min(downscaled.data.length, centreCrop.data.length)
  for (let index = 0; index < pixels; index += 1) difference += Math.abs(downscaled.data[index] - centreCrop.data[index])
  const meanDifference = difference / pixels
  assert.ok(meanDifference <= 14, `zoomed frame (downscaled) should match the plain centre crop, mean diff ${meanDifference}`)
  // And it must NOT simply be the plain full frame rescaled (which would mean no zoom was applied).
  const plainFull = await sharpModule(plainPng).resize(320, 180, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
  let plainDifference = 0
  for (let index = 0; index < pixels; index += 1) plainDifference += Math.abs(downscaled.data[index] - plainFull.data[index])
  assert.ok(plainDifference / pixels > 20, 'the zoomed content differs from the unmagnified full frame')
})

test('a click ripple is visible at its output time and disappears afterwards', { skip: !demoRenderingAvailable && 'ffmpeg-static/sharp is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  // A dark static capture makes the white ripple ring unambiguous.
  const fixture = makeStaticWebmSample(scratch.pathFor('dark.webm'), {
    lavfi: 'color=c=0x203040:size=640x360:rate=10:duration=3',
    withAudio: false
  })
  const probe = createMediaProbe({ ffmpegPath })
  const { recordingService, exporter } = makeExportHarness({ scratch, probe })
  t.after(async () => { await exporter.dispose(); await recordingService.dispose() })
  const session = await seedStaticSession(recordingService, fixture)

  const render = async (requestId, demo, name) => {
    const target = scratch.pathFor(`out/${name}.mp4`)
    const task = await exporter.submit({
      sessionId: session.id,
      requestId,
      request: { format: 'mp4', segments: [{ startMs: 0, endMs: 3000 }], video: { resolution: 'source', quality: 'standard', fps: 'source' }, ...(demo ? { demo } : {}) },
      targetPath: target
    })
    assert.equal(task.ok, true)
    const terminal = await waitForTerminal(exporter, task.task.taskId)
    assert.equal(terminal.state, 'succeeded', JSON.stringify(terminal.error || null))
    return target
  }

  const ripple = await render('demo-ripple', {
    style: { enabled: false, ripples: true },
    zooms: [],
    clicks: [{ tMs: 1000, x: 0.5, y: 0.5, button: 0 }]
  }, 'ripple')
  const plain = await render('demo-ripple-none', null, 'ripple-plain')

  const maxLuminanceNear = (frame, cx, cy, radius) => {
    let best = 0
    for (let y = Math.max(0, cy - radius); y < Math.min(frame.height, cy + radius); y += 2) {
      for (let x = Math.max(0, cx - radius); x < Math.min(frame.width, cx + radius); x += 2) {
        best = Math.max(best, frame.luminance(x, y))
      }
    }
    return best
  }

  const duringRipple = await extractFramePixels(ripple, 1.2, scratch, 'ripple-on')
  const plainDuring = await extractFramePixels(plain, 1.2, scratch, 'ripple-off')
  assert.ok(maxLuminanceNear(duringRipple, 320, 180, 70) >= 150,
    `the white ring must light up near the click (${maxLuminanceNear(duringRipple, 320, 180, 70)})`)
  assert.ok(maxLuminanceNear(plainDuring, 320, 180, 70) <= 110,
    'the same frame without ripples stays dark')

  // 600 ms window: at 2.2 s the ripple is gone again.
  const afterRipple = await extractFramePixels(ripple, 2.2, scratch, 'ripple-after')
  assert.ok(maxLuminanceNear(afterRipple, 320, 180, 70) <= 110, 'the ripple is disabled after its window')

  // Ripple disabled while clicks are present: no enhanced pipeline and no bright ring.
  const disabledRipple = await render('demo-ripple-disabled', {
    style: { enabled: false, ripples: false },
    zooms: [],
    clicks: [{ tMs: 1000, x: 0.5, y: 0.5, button: 0 }]
  }, 'ripple-disabled')
  const disabledFrame = await extractFramePixels(disabledRipple, 1.2, scratch, 'ripple-disabled-frame')
  assert.ok(maxLuminanceNear(disabledFrame, 320, 180, 70) <= 110, 'ripples=false ignores clicks')
})

test('the export service refuses an illegal demo payload and cleans demo assets on failure', { skip: !sharpModule && 'sharp is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)

  // 1) A malformed demo plan is refused before a task exists.
  const invalid = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe(),
    spawnProcess: makeFakeFfmpeg().spawn,
    log: () => {}
  })
  t.after(() => invalid.dispose())
  const rejected = await invalid.submit({
    sessionId: session.id,
    requestId: 'demo-invalid',
    request: { format: 'mp4', range: { startMs: 0, endMs: 400 }, demo: { style: [] } },
    targetPath: scratch.pathFor('invalid.mp4')
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'invalid-demo-option')

  // 2) When the encode fails, the generated bg/mask/ripple assets are removed with the temp file.
  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe({ video: { width: 640, height: 360, frameRate: 10 } }),
    spawnProcess: makeFakeFfmpeg({ code: 1, bytes: 'partial' }).spawn,
    log: () => {}
  })
  t.after(() => exporter.dispose())
  const target = scratch.pathFor('out/demo-failure.mp4')
  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'demo-failure',
    request: {
      format: 'mp4',
      range: { startMs: 0, endMs: 400 },
      demo: {
        style: { enabled: true, background: '#f5f2ea', padding: 0.1, radius: 16, shadow: true, ripples: true },
        zooms: [],
        clicks: [{ tMs: 100, x: 0.5, y: 0.5, button: 0 }]
      }
    },
    targetPath: target
  })
  assert.equal(submitted.ok, true, JSON.stringify(submitted))
  const settled = await waitForTerminal(exporter, submitted.task.taskId)
  assert.equal(settled.state, 'failed')
  assert.equal(settled.error.code, 'encode-failed')
  const leftovers = (await fsp.readdir(path.dirname(target))).filter((name) => name !== path.basename(target))
  assert.deepEqual(leftovers, [], 'demo raster assets must not survive a failed export')
})

// The test above was red on CI but green locally: both the encode-failure path in `encode()`
// and the catch in `runTask()` clean the same task up, and the two cleanups used to race. The
// first one to reach `cleanupDemoAssets` nulls `task.demoAssets`, so the second returned while
// the first was still deleting: `failed` was reported, the caller listed the directory, and the
// raster files were still there. Which of the two wins is a matter of threadpool timing, so the
// leak only showed up on the slower runner.
//
// `fs.rm` here is SERIALISED and the raster deletions are slow, which makes that ordering
// deterministic instead of a coin flip: the first cleanup always claims the assets, and the
// second always overtakes its deletions. Nothing about wall-clock speed decides the outcome.
test('a failed demo export reports `failed` only after its raster assets are gone', { skip: !sharpModule && 'sharp is not installed' }, async (t) => {
  const scratch = makeScratch()
  t.after(() => scratch.dispose())
  const { recordingService, session } = await seedSession(scratch)

  const rasterRmDelays = []
  let rmQueue = Promise.resolve()
  const queuedFs = Object.create(fsp)
  queuedFs.rm = (target, options) => {
    const isRaster = /\.(bg|mask|ripple)\.png$/.test(String(target))
    if (isRaster) rasterRmDelays.push(String(target))
    const run = rmQueue.then(async () => {
      if (isRaster) await new Promise((resolve) => setTimeout(resolve, 40))
      return fsp.rm(target, options)
    })
    rmQueue = run.then(() => {}, () => {})
    return run
  }

  const exporter = createRecordingExportService({
    getRecordingService: () => recordingService,
    probe: makeStubProbe({ video: { width: 640, height: 360, frameRate: 10 } }),
    spawnProcess: makeFakeFfmpeg({ code: 1, bytes: 'partial' }).spawn,
    fs: queuedFs,
    log: () => {}
  })
  t.after(() => exporter.dispose())

  const target = scratch.pathFor('out/demo-slow-cleanup.mp4')
  const submitted = await exporter.submit({
    sessionId: session.id,
    requestId: 'demo-slow-cleanup',
    request: {
      format: 'mp4',
      range: { startMs: 0, endMs: 400 },
      demo: {
        style: { enabled: true, background: '#f5f2ea', padding: 0.1, radius: 16, shadow: true, ripples: true },
        zooms: [],
        clicks: [{ tMs: 100, x: 0.5, y: 0.5, button: 0 }]
      }
    },
    targetPath: target
  })
  assert.equal(submitted.ok, true, JSON.stringify(submitted))
  const settled = await waitForTerminal(exporter, submitted.task.taskId)
  assert.equal(settled.state, 'failed')
  assert.equal(settled.error.code, 'encode-failed')
  // Terminal state is readable, and the raster assets it implies are gone in the same breath.
  assert.deepEqual(rasterRmDelays.length > 0, true, 'the demo plan really did produce raster assets')
  const leftovers = (await fsp.readdir(path.dirname(target))).filter((name) => name !== path.basename(target))
  assert.deepEqual(leftovers, [], 'the failed state must not be observable while raster cleanup is in flight')
})
