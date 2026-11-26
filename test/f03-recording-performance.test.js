'use strict'

// F03 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §3.3):
// recording capture and video export performance.
//
//   1. RecordingService.appendChunk used fs.appendFile(path) -> one open/write/close per
//      fragment. A capture now holds ONE FileHandle (1 open + N writes + 1 close) and closes
//      it from every finish/interrupt/dispose path while keeping the C01/02 contracts
//      (confirmed sequence, committed offset, torn-tail truncation).
//   2. The demo export graph built one `-loop 1 -i ripple.png` input + scale/overlay per
//      click (30 clicks = 30 inputs + 60 filter nodes). Mergeable click windows are now
//      packed into <=2 looped inputs and <=4 filter nodes with `enable='between(t,a,b)'`
//      style expressions; the expressions are evaluated in-test and compared against the
//      per-click semantics at key time points.
//   3. libx264/libvpx-vp9 were hardcoded. The service probes h264_nvenc/h264_qsv/h264_amf
//      (`-encoders` + a one-frame smoke encode), caches the answer, prefers hardware when it
//      initialises, and falls back to libx264 on every failure path (probe miss, probe throw,
//      hardware encode error) without changing the output extension or audio mapping.
//
// All processes here are fakes: no real ffmpeg, no real GPU, no device dependency.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const { RecordingService } = require('../main/services/recording-service')
const {
  buildExportArgs,
  normalizeExportRequest
} = require('../shared/recording-export-options')
const {
  buildFfmpegArgs,
  normalizeVideoEncoder,
  parseFfmpegEncoders,
  pickHardwareEncoder,
  videoEncoderArgs
} = require('../record/recording-utils')

async function createRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'highlighter-f03-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

// ---------------------------------------------------------------------------
// 1. Persistent FileHandle
// ---------------------------------------------------------------------------

// Wraps the real fs and counts open/write/close on the handle the service holds. appendFile
// is intentionally left untouched: an fs that overrides it is treated as a C01 fault-injection
// seam and keeps the legacy path (see the fallback test below).
function createCountingFs({ failOnWrite = 0 } = {}) {
  const real = require('node:fs/promises')
  const counts = { open: 0, write: 0, close: 0 }
  const fake = {
    ...real,
    async open(target, flags) {
      counts.open += 1
      const handle = await real.open(target, flags)
      let writeIndex = 0
      return {
        async write(buffer) {
          writeIndex += 1
          counts.write += 1
          if (failOnWrite === writeIndex) {
            // A torn write: part of the fragment reaches the file, then ENOSPC.
            const half = Math.max(1, Math.floor(buffer.length / 2))
            await handle.write(buffer.subarray(0, half))
            throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
          }
          return handle.write(buffer)
        },
        async close() {
          counts.close += 1
          return handle.close()
        }
      }
    }
  }
  return { fs: fake, counts }
}

test('F03: a capture with N chunks performs one open, N writes and one close', async (t) => {
  const root = await createRoot(t)
  const { fs: countingFs, counts } = createCountingFs()
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', fs: countingFs })
  t.after(() => service.dispose())

  const session = await service.startSession()
  assert.equal(counts.open, 1, 'the capture opens exactly one persistent handle')
  const chunks = ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'chunk-5']
  let expectedBytes = 0
  for (const [index, chunk] of chunks.entries()) {
    const ack = await service.appendChunk(session.id, Buffer.from(chunk), { sequence: index + 1 })
    expectedBytes += chunk.length
    assert.equal(ack.committedBytes, expectedBytes)
  }
  assert.equal(counts.write, chunks.length, 'one handle.write per fragment, no appendFile')
  assert.equal(counts.close, 0, 'the handle stays open while capturing')

  const finished = await service.finishSession(session.id)
  assert.equal(counts.close, 1, 'finishSession closes the handle exactly once')
  assert.equal(finished.bytesWritten, expectedBytes)
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), chunks.join(''))
  assert.equal(service.peekSession(session.id).fileHandle, null)

  // A repeated stop returns the same receipt and must not close again.
  const repeated = await service.finishSession(session.id)
  assert.equal(repeated.bytesWritten, expectedBytes)
  assert.equal(counts.close, 1)
})

test('F03: an interrupted capture closes its handle and keeps the confirmed bytes', async (t) => {
  const root = await createRoot(t)
  const { fs: countingFs, counts } = createCountingFs()
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', fs: countingFs })
  t.after(() => service.dispose())

  // Project-owned directory so the bytes can be inspected after the cleanup.
  const directory = path.join(root, 'recordings', 'interrupted')
  const session = await service.startSession({ directory })
  await service.appendChunk(session.id, Buffer.from('first-chunk'), { sequence: 1 })
  assert.equal(counts.open, 1)
  assert.equal(await service.cleanupSession(session.id), true)
  assert.equal(counts.close, 1, 'cleanupSession closes the capture handle')
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'first-chunk', 'written bytes survive the interrupt')
})

test('F03: a torn persistent write keeps the confirmed prefix and reports the gap', async (t) => {
  const root = await createRoot(t)
  const { fs: countingFs, counts } = createCountingFs({ failOnWrite: 2 })
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', fs: countingFs })
  t.after(() => service.dispose())

  const session = await service.startSession({ directory: path.join(root, 'recordings', 'disk-full') })
  await service.appendChunk(session.id, Buffer.from('first'), { sequence: 1 })
  // The second fragment is torn: three of six bytes land before ENOSPC, like the C01 path.
  await assert.rejects(
    () => service.appendChunk(session.id, Buffer.from('secnd2'), { sequence: 2 }),
    (error) => error.code === 'ENOSPC'
  )
  await assert.rejects(
    () => service.appendChunk(session.id, Buffer.from('third2'), { sequence: 3 }),
    (error) => error.code === 'append-sealed'
  )

  const finished = await service.finishSession(session.id)
  assert.equal(finished.recovered, true)
  assert.equal(finished.bytesWritten, 5, 'only the fully written fragment is confirmed')
  assert.equal(finished.committedBytes, 5)
  assert.equal(finished.lastChunkSequence, 1)
  assert.equal(finished.failure.code, 'ENOSPC')
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'first', 'the torn tail is truncated away')
  assert.equal(counts.open, 1)
  assert.equal(counts.close, 1, 'the failed capture still closes its handle exactly once')

  // Dispose after the failure must not close the handle a second time.
  await service.dispose()
  assert.equal(counts.close, 1)
})

test('F03: an injected fs without open() falls back to appendFile per chunk', async (t) => {
  const root = await createRoot(t)
  const real = require('node:fs/promises')
  const counts = { appendFile: 0, openCalls: 0 }
  const fakeFs = {
    ...real,
    open: undefined,
    async appendFile(target, buffer) {
      counts.appendFile += 1
      return real.appendFile(target, buffer)
    }
  }
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', fs: fakeFs })
  t.after(() => service.dispose())

  const session = await service.startSession()
  assert.equal(service.peekSession(session.id).persistentWrites, false)
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    await service.appendChunk(session.id, Buffer.from(`f${sequence}`), { sequence })
  }
  assert.equal(counts.appendFile, 3, 'a fs without open() keeps the legacy appendFile seam')
  const finished = await service.finishSession(session.id)
  assert.equal(finished.bytesWritten, 6)
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'f1f2f3')
})

// ---------------------------------------------------------------------------
// 2. Ripple packing
// ---------------------------------------------------------------------------

function evaluateFfmpegExpression(expression, atSeconds, { W, H, w, h }) {
  // The generated expressions only use if()/between()/min()/max() and the frame variables,
  // all of which map 1:1 onto JavaScript once if() is renamed.
  const js = String(expression).replace(/\bif\s*\(/g, 'ffif(')
  // eslint-disable-next-line no-new-func -- test-local evaluator for ffmpeg expressions
  const fn = new Function(
    't', 'W', 'H', 'w', 'h',
    'const ffif = (condition, whenTrue, whenFalse) => (condition ? whenTrue : whenFalse);' +
    'const between = (value, low, high) => (value >= low && value <= high);' +
    'const min = Math.min; const max = Math.max;' +
    `return (${js});`
  )
  return fn(atSeconds, W, H, w, h)
}

function buildDemoExport(clicks, { durationMs = 60000, metadata = null } = {}) {
  const probeMetadata = metadata || {
    durationMs,
    video: { width: 640, height: 360, frameRate: 30 },
    audio: { exists: true }
  }
  const normalized = normalizeExportRequest({
    format: 'mp4',
    segments: [{ startMs: 0, endMs: durationMs }],
    video: { resolution: 'source', quality: 'standard', fps: 'source' },
    demo: {
      style: { enabled: true, background: '#0f1115', padding: 0.08, radius: 12, shadow: true, ripples: true },
      zooms: [],
      clicks
    }
  }, probeMetadata)
  assert.equal(normalized.ok, true, JSON.stringify(normalized))
  const value = normalized.value
  const assets = {
    bgPath: '/tmp/f03-task.bg.png',
    maskPath: '/tmp/f03-task.mask.png',
    ripplePath: '/tmp/f03-task.ripple.png'
  }
  const built = buildExportArgs({ ...value, inputPath: 'in.webm', outputPath: 'out.mp4', demoAssets: assets })
  const args = built.args
  const graph = args[args.indexOf('-filter_complex') + 1]
  return { value, args, graph, assets }
}

function rippleInputCount(args, assets) {
  return args.filter((value) => value === assets.ripplePath).length
}

// Counts only the two nodes each lane contributes (scale, overlay), not the later canvas
// node that merely consumes the lane's output label.
function rippleFilterNodes(graph) {
  return graph.split(';').filter((node) => (
    /format=rgba\[ripple\d+\]$/.test(node) || /\[rippleOverlay\d+\]$/.test(node)
  ))
}

function extractLane(graph, laneIndex) {
  const scale = new RegExp(
    `scale=w='([^']*)':h='([^']*)':eval=frame,format=rgba\\[ripple${laneIndex}\\]`
  ).exec(graph)
  const overlay = new RegExp(
    `overlay=x='([^']*)':y='([^']*)':enable='([^']*)':format=auto:shortest=1\\[rippleOverlay${laneIndex}\\]`
  ).exec(graph)
  if (!scale || !overlay) return null
  return {
    size: scale[1],
    width: scale[2],
    x: overlay[1],
    y: overlay[2],
    enable: overlay[3]
  }
}

function betweenTerm(startMs, endMs) {
  return `between(t,${(startMs / 1000).toFixed(6)},${(endMs / 1000).toFixed(6)})`
}

test('F03: 30 mergeable click ripples collapse into one input and two filter nodes', () => {
  const clicks = Array.from({ length: 30 }, (_, index) => ({
    tMs: 500 + index * 1200,
    x: 0.2 + (index % 5) * 0.1,
    y: 0.3,
    button: 0
  }))
  const { args, graph, assets } = buildDemoExport(clicks)

  assert.equal(rippleInputCount(args, assets), 1, 'one looped ring input serves all 30 clicks')
  const nodes = rippleFilterNodes(graph)
  assert.equal(nodes.length, 2, 'one scale + one overlay node instead of 30 + 30')
  assert.ok(nodes.length <= 4, `ripple filter node count must stay <= 4, got ${nodes.length}`)

  const lane = extractLane(graph, 0)
  assert.ok(lane, 'lane 0 must exist')
  // Every click window is present exactly once in the packed expressions.
  for (const click of clicks) {
    const window = betweenTerm(click.tMs, click.tMs + 600)
    assert.ok(lane.enable.includes(window), `enable expression is missing ${window}`)
    assert.ok(lane.size.includes(`(t-${(click.tMs / 1000).toFixed(6)})`), `size expression is missing click ${click.tMs}`)
    assert.ok(lane.x.includes(`${click.x.toFixed(4)}*W-w/2`), `x expression is missing click ${click.tMs}`)
  }
  assert.equal(lane.enable.split('between(t,').length - 1, 30, 'one between() term per click')
})

test('F03: packed ripple expressions match the per-click graph at key time points', () => {
  const clicks = Array.from({ length: 30 }, (_, index) => ({
    tMs: 500 + index * 1200,
    x: 0.2 + (index % 5) * 0.1,
    y: 0.3,
    button: 0
  }))
  const { value, graph } = buildDemoExport(clicks)
  const lane = extractLane(graph, 0)
  assert.ok(lane, 'lane 0 must exist')
  const W = value.demo.canvasWidth
  const H = value.demo.canvasHeight
  const canvas = { W, H, w: 0, h: 0 }

  for (const click of clicks) {
    // Use the same integer-millisecond time base the expressions are formatted from, so the
    // inclusive `between` boundary is not lost to float addition.
    const midTime = (click.tMs + 300) / 1000
    // Mid-animation: 300 ms into the 600 ms growth -> 0.35 + 0.65 * 0.5.
    const midSize = evaluateFfmpegExpression(lane.size, midTime, { ...canvas, w: 0, h: 0 })
    assert.ok(Math.abs(midSize - 96 * (0.35 + 0.65 * 0.5)) < 1e-6, `size at mid-animation of click ${click.tMs}`)
    assert.equal(evaluateFfmpegExpression(lane.enable, midTime, canvas), 1, `enabled at click ${click.tMs}`)
    const expectedX = click.x * W - midSize / 2
    const actualX = evaluateFfmpegExpression(lane.x, midTime, { ...canvas, w: midSize, h: midSize })
    assert.ok(Math.abs(actualX - expectedX) < 1e-6, `x at mid-animation of click ${click.tMs}`)
    const expectedY = click.y * H - midSize / 2
    const actualY = evaluateFfmpegExpression(lane.y, midTime, { ...canvas, w: midSize, h: midSize })
    assert.ok(Math.abs(actualY - expectedY) < 1e-6, `y at mid-animation of click ${click.tMs}`)
    // The end of the window is still part of it (`between` is inclusive), like the
    // historical per-click enable expression.
    assert.equal(
      evaluateFfmpegExpression(lane.enable, (click.tMs + 600) / 1000, canvas),
      1,
      `enabled at window end of click ${click.tMs}`
    )
    // ...and 1 ms later it is off; the scale lane falls back to its 2x2 placeholder.
    const afterEnd = (click.tMs + 601) / 1000
    assert.equal(evaluateFfmpegExpression(lane.enable, afterEnd, canvas), 0, `disabled after click ${click.tMs}`)
    assert.equal(evaluateFfmpegExpression(lane.size, afterEnd, canvas), 2)
  }
})

test('F03: a single click keeps the exact historical per-click ripple graph', () => {
  const { args, graph } = buildDemoExport([{ tMs: 1000, x: 0.4, y: 0.5, button: 0 }])
  assert.equal(graph.includes("[3:v]scale=w='96*(0.35+0.65*min(1,max(0,(t-1.000000)/0.6)))'"), true)
  assert.equal(
    graph.includes("overlay=x='0.4000*W-w/2':y='0.5000*H-h/2':enable='between(t,1.000000,1.600000)'"),
    true
  )
  assert.equal(rippleFilterNodes(graph).length, 2)
  assert.equal(args.includes('-c:v'), true)
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264', 'no encoder hint keeps the software path')
})

test('F03: two concurrent ripple lanes stay within four filter nodes', () => {
  const clicks = [
    { tMs: 0, x: 0.2, y: 0.3 },
    { tMs: 300, x: 0.9, y: 0.3 },
    { tMs: 1200, x: 0.3, y: 0.3 },
    { tMs: 1500, x: 0.8, y: 0.3 }
  ].map((click) => ({ ...click, button: 0 }))
  const { args, graph, assets } = buildDemoExport(clicks, { durationMs: 5000 })

  assert.equal(rippleInputCount(args, assets), 2, 'two overlapping lanes need two looped inputs')
  const nodes = rippleFilterNodes(graph)
  assert.ok(nodes.length <= 4, `two lanes must stay within 4 nodes, got ${nodes.length}`)
  const lane0 = extractLane(graph, 0)
  const lane1 = extractLane(graph, 1)
  assert.ok(lane0 && lane1)
  // Greedy packing by start time: 0 ms / 1200 ms share lane 0, 300 ms / 1500 ms share lane 1.
  assert.ok(lane0.enable.includes(betweenTerm(0, 600)))
  assert.ok(lane0.enable.includes(betweenTerm(1200, 1800)))
  assert.equal(lane0.enable.includes(betweenTerm(300, 900)), false)
  assert.ok(lane1.enable.includes(betweenTerm(300, 900)))
  assert.ok(lane1.enable.includes(betweenTerm(1500, 2100)))
})

test('F03: a burst whose overlap order cannot be preserved keeps the per-click chain', () => {
  // 0/300 overlap, then 800/1100 overlap, ...: greedy packing puts 300 ms in lane 1 and
  // 800 ms in lane 0, so lane-major compositing would paint the later ring first at the
  // intersection. That is a rounding-visible regression, so the exact per-click chain is kept.
  const clicks = [0, 300, 800, 1100, 1600, 1900].map((tMs, index) => ({
    tMs,
    x: 0.2 + (index % 4) * 0.1,
    y: 0.3,
    button: 0
  }))
  const { args, graph, assets } = buildDemoExport(clicks, { durationMs: 5000 })
  assert.equal(rippleInputCount(args, assets), clicks.length, 'order-preserving merge is impossible here')
  for (const click of clicks) {
    assert.ok(graph.includes(`enable='between(t,${(click.tMs / 1000).toFixed(6)},${((click.tMs + 600) / 1000).toFixed(6)})'`))
  }
  assert.equal(rippleFilterNodes(graph).length, clicks.length * 2)
})

test('F03: a three-deep ripple burst falls back to the exact per-click chain', () => {
  const clicks = [0, 100, 200].map((tMs, index) => ({ tMs, x: 0.2 + index * 0.1, y: 0.3, button: 0 }))
  const { args, graph, assets } = buildDemoExport(clicks, { durationMs: 5000 })

  // Three rings are on screen together at once: packing two lanes would change the composite,
  // so the historical one-input-per-click chain is kept (still pixel-identical).
  assert.equal(rippleInputCount(args, assets), 3, 'unmergeable overlap keeps one input per click')
  for (const [index, click] of clicks.entries()) {
    assert.ok(
      graph.includes(`enable='between(t,${(click.tMs / 1000).toFixed(6)},${((click.tMs + 600) / 1000).toFixed(6)})'`),
      `per-click window of click ${index} must be exact`
    )
  }
  assert.equal(rippleFilterNodes(graph).length, 6)
})

// ---------------------------------------------------------------------------
// 3. Hardware encoder probe + fallback
// ---------------------------------------------------------------------------

const NVENC_LISTING = [
  ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
  ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder',
  ' V....D h264_amf             AMD AMF H.264 Encoder',
  ' A....D aac                  AAC (Advanced Audio Coding)'
].join('\n')

function fakeEncoderChild({ stdout = '', code = 0, emitError = '' } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  queueMicrotask(() => {
    if (emitError) {
      child.emit('error', new Error(emitError))
      return
    }
    if (stdout) {
      child.stdout.emit('data', Buffer.from(stdout))
      child.stderr.emit('data', Buffer.from(stdout))
    }
    child.emit('close', code)
  })
  return child
}

// Fake `ffmpeg -encoders` + one-frame smoke encoder. `smokeCode(encoder)` decides whether a
// compiled hardware encoder really initialises on this "machine".
function createFakeEncoderSpawn({ listing = NVENC_LISTING, smokeCode = () => 1, throwOnSpawn = false } = {}) {
  const calls = []
  const spawn = (_executable, args) => {
    calls.push([...args])
    if (throwOnSpawn) throw new Error('spawn EPERM')
    if (args.includes('-encoders')) return fakeEncoderChild({ stdout: listing, code: 0 })
    const encoderIndex = args.indexOf('-c:v')
    const encoder = encoderIndex === -1 ? '' : args[encoderIndex + 1]
    return fakeEncoderChild({ code: smokeCode(encoder) })
  }
  return { spawn, calls }
}

// Transcode fake: records argv, writes the expected MP4 (or fails the first N attempts).
function createFakeTranscodeSpawn({ failFirst = 0 } = {}) {
  const calls = []
  const spawn = (_executable, args) => {
    calls.push([...args])
    const attempt = calls.length
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(async () => {
      if (attempt <= failFirst) {
        child.emit('close', 1)
        return
      }
      await fs.writeFile(args[args.length - 1], 'mp4-bytes')
      child.emit('close', 0)
    })
    return child
  }
  return { spawn, calls }
}

async function createReadySession(t, serviceOptions = {}) {
  const root = await createRoot(t)
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', ...serviceOptions })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await service.appendChunk(session.id, Buffer.from('webm-source'), { sequence: 1 })
  await service.finishSession(session.id)
  return { root, service, session }
}

test('F03: encoder listing parsing prefers nvenc > qsv > amf and never invents one', () => {
  const names = parseFfmpegEncoders(NVENC_LISTING)
  assert.deepEqual([...names].sort(), ['h264_amf', 'h264_nvenc', 'libx264'])
  assert.equal(pickHardwareEncoder(names), 'h264_nvenc', 'priority order is NVENC > QSV > AMF')
  const qsv = parseFfmpegEncoders(' V....D h264_qsv             H.264 / AVC (Intel Quick Sync Video)')
  assert.equal(pickHardwareEncoder(qsv), 'h264_qsv')
  assert.equal(pickHardwareEncoder(parseFfmpegEncoders(' V....D libx264 libx264')), '')
  assert.equal(pickHardwareEncoder(new Set()), '')
  // Unknown/absent names degrade to libx264 so the argv shape can never depend on the probe.
  assert.equal(normalizeVideoEncoder('h264_amf'), 'h264_amf')
  assert.equal(normalizeVideoEncoder('vaapi_h264'), 'libx264')
  assert.equal(normalizeVideoEncoder(''), 'libx264')
})

test('F03: the default MP4 argv is byte-identical to libx264 and the hint only swaps -c:v', () => {
  const legacy = buildFfmpegArgs('input.webm', 'output.mp4', { audio: true })
  assert.deepEqual(
    legacy.slice(0, 14),
    ['-i', 'input.webm', '-map', '0:v:0', '-map', '0:a?', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2']
  )
  assert.deepEqual(videoEncoderArgs(undefined, 23), ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'])
  const hardware = buildFfmpegArgs('input.webm', 'output.mp4', { audio: true, videoEncoder: 'h264_nvenc' })
  assert.equal(hardware[hardware.indexOf('-c:v') + 1], 'h264_nvenc')
  // The audio mapping and the container flags are untouched by the encoder choice.
  assert.deepEqual(
    hardware.slice(0, 14),
    legacy.slice(0, 14)
  )
  assert.equal(hardware.includes('+faststart'), true)
  assert.equal(hardware[hardware.length - 1], 'output.mp4')
})

test('F03: buildExportArgs accepts a probed hardware encoder without changing the muxer or audio', () => {
  const metadata = { durationMs: 5000, video: { width: 640, height: 360, frameRate: 30 }, audio: { exists: true } }
  const normalized = normalizeExportRequest({
    format: 'mp4',
    segments: [{ startMs: 0, endMs: 2000 }],
    video: { resolution: 'source', quality: 'standard', fps: 'source' }
  }, metadata).value
  const software = buildExportArgs({ ...normalized, inputPath: 'in.webm', outputPath: 'out.mp4' })
  const hardware = buildExportArgs({ ...normalized, inputPath: 'in.webm', outputPath: 'out.mp4', videoEncoder: 'h264_qsv' })
  assert.equal(software.args[software.args.indexOf('-c:v') + 1], 'libx264')
  assert.equal(hardware.args[hardware.args.indexOf('-c:v') + 1], 'h264_qsv')
  // Same target, same expected shape, same MP4 flags and AAC mapping: only the encoder cluster
  // differs, so the publish verification still sees the same file contract.
  assert.deepEqual(hardware.expected, software.expected)
  assert.equal(hardware.args[hardware.args.length - 1], 'out.mp4')
  assert.deepEqual(
    hardware.args.slice(hardware.args.indexOf('-map', hardware.args.indexOf('-map') + 1), hardware.args.indexOf('-c:v')),
    ['-map', '[outa]', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2']
  )
  // A WebM encode has no H.264 option: the hint is ignored and VP9 stays.
  const webm = normalizeExportRequest({
    format: 'webm',
    segments: [{ startMs: 0, endMs: 1000 }],
    video: { resolution: '720p', quality: 'standard', fps: 'source' }
  }, metadata).value
  const webmBuilt = buildExportArgs({ ...webm, inputPath: 'in.webm', outputPath: 'out.webm', videoEncoder: 'h264_nvenc' })
  assert.equal(webmBuilt.args[webmBuilt.args.indexOf('-c:v') + 1], 'libvpx-vp9')
})

test('F03: a hardware probe hit is cached and used by the next export', async (t) => {
  const encoderSpawn = createFakeEncoderSpawn({ smokeCode: (encoder) => (encoder === 'h264_nvenc' ? 0 : 1) })
  const transcode = createFakeTranscodeSpawn()
  const { root, service, session } = await createReadySession(t, {
    encoderSpawn: encoderSpawn.spawn,
    spawnProcess: transcode.spawn
  })

  const probe = await service.probeVideoEncoders()
  assert.equal(probe.ok, true)
  assert.equal(probe.encoder, 'h264_nvenc')
  assert.equal(probe.hardwareEncoder, 'h264_nvenc')
  assert.equal(service.getVideoEncoder(), 'h264_nvenc')
  // One `-encoders` listing + one smoke encode for NVENC; QSV/AMF are never probed after a hit.
  assert.equal(encoderSpawn.calls.length, 2)
  assert.deepEqual(encoderSpawn.calls[0].slice(-1), ['-encoders'])
  assert.equal(encoderSpawn.calls[1][encoderSpawn.calls[1].indexOf('-c:v') + 1], 'h264_nvenc')

  // Cached: a second probe and the export reuse the answer without respawning the probe.
  const cached = await service.probeVideoEncoders()
  assert.equal(cached.encoder, 'h264_nvenc')
  assert.equal(cached.cached, true)
  assert.equal(encoderSpawn.calls.length, 2)

  const target = path.join(root, 'hardware.mp4')
  assert.equal(await service.transcode(session.id, target, () => {}, { audio: true }), target)
  assert.equal(transcode.calls.length, 1)
  const args = transcode.calls[0]
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_nvenc')
  // Extension / audio mapping are the same contract as the software path.
  assert.equal(args[args.length - 1], target)
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0:v:0'])
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
  assert.equal(await fs.readFile(target, 'utf8'), 'mp4-bytes')
})

test('F03: a compiled-but-unusable hardware encoder falls back to libx264', async (t) => {
  // The build lists NVENC, but the smoke encode exits non-zero (no GPU / driver): exactly the
  // situation `-encoders` alone cannot see.
  const encoderSpawn = createFakeEncoderSpawn({ smokeCode: () => 1, listing: NVENC_LISTING })
  const transcode = createFakeTranscodeSpawn()
  const { root, service, session } = await createReadySession(t, {
    encoderSpawn: encoderSpawn.spawn,
    spawnProcess: transcode.spawn
  })

  const probe = await service.probeVideoEncoders()
  assert.equal(probe.ok, true)
  assert.equal(probe.encoder, 'libx264')
  assert.equal(probe.hardwareEncoder, '')
  assert.deepEqual(probe.candidates, ['h264_nvenc', 'h264_amf'])
  assert.equal(service.getVideoEncoder(), 'libx264')

  const target = path.join(root, 'software.mp4')
  assert.equal(await service.transcode(session.id, target), target)
  const args = transcode.calls[0]
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264')
  assert.equal(args.includes('-an'), true, 'the legacy silent mapping is preserved')
})

test('F03: a throwing encoder probe falls back to libx264 and cannot fail the export', async (t) => {
  const encoderSpawn = createFakeEncoderSpawn({ throwOnSpawn: true })
  const transcode = createFakeTranscodeSpawn()
  const { root, service, session } = await createReadySession(t, {
    encoderSpawn: encoderSpawn.spawn,
    spawnProcess: transcode.spawn
  })

  const probe = await service.probeVideoEncoders()
  assert.equal(probe.ok, false)
  assert.equal(probe.encoder, 'libx264', 'a thrown probe never rejects and never picks hardware')
  assert.equal(probe.hardwareEncoder, '')
  assert.equal(probe.error, 'encoder-probe-spawn-failed')

  const target = path.join(root, 'probe-throw.mp4')
  assert.equal(await service.transcode(session.id, target, () => {}, { audio: true }), target)
  const args = transcode.calls[0]
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264')
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
  assert.equal(await fs.readFile(target, 'utf8'), 'mp4-bytes')
})

test('F03: a failed hardware encode is retried once with libx264 and keeps the same target', async (t) => {
  // Probe says NVENC is usable, but the real encode fails (driver busy). The export must
  // retry once with software encoding instead of reporting the failure to the user.
  const transcode = createFakeTranscodeSpawn({ failFirst: 1 })
  const { root, service, session } = await createReadySession(t, {
    encoderProbe: async () => ({ encoder: 'h264_nvenc', candidates: ['h264_nvenc'] }),
    spawnProcess: transcode.spawn
  })

  const target = path.join(root, 'fallback.mp4')
  assert.equal(await service.transcode(session.id, target, () => {}, { audio: true }), target)
  assert.equal(transcode.calls.length, 2, 'one hardware attempt + one software retry')
  assert.equal(transcode.calls[0][transcode.calls[0].indexOf('-c:v') + 1], 'h264_nvenc')
  assert.equal(transcode.calls[1][transcode.calls[1].indexOf('-c:v') + 1], 'libx264')
  // Both attempts address the same .mp4 target with the same audio mapping: the fallback is
  // invisible in the output contract.
  for (const args of transcode.calls) {
    assert.equal(args[args.length - 1], target)
    assert.ok(args[args.length - 1].endsWith('.mp4'))
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0:v:0'])
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
  }
  assert.equal(await fs.readFile(target, 'utf8'), 'mp4-bytes')
  assert.equal(service.stateOf(session.id), 'ready')
})
