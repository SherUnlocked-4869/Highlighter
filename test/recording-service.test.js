const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { RecordingService } = require('../main/services/recording-service')

async function createRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'highlighter-recording-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('writes chunks in call order and finalizes a preview file', async (t) => {
  const root = await createRoot(t)
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg' })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await Promise.all([
    service.appendChunk(session.id, Buffer.from('one')),
    service.appendChunk(session.id, Buffer.from('two'))
  ])
  const preview = await service.finishSession(session.id)
  assert.equal((await fs.readFile(preview.inputPath)).toString(), 'onetwo')
  assert.match(preview.previewUrl, /^file:/)
})

test('keeps input but deletes partial MP4 when conversion fails', async (t) => {
  const root = await createRoot(t)
  const fakeSpawn = () => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(async () => {
      await fs.writeFile(path.join(root, 'failed.mp4'), 'partial')
      child.stderr.emit('data', Buffer.from('conversion failed'))
      child.emit('close', 1)
    })
    return child
  }
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', spawnProcess: fakeSpawn })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await service.appendChunk(session.id, Buffer.from('webm'))
  await service.finishSession(session.id)
  const output = path.join(root, 'failed.mp4')
  await assert.rejects(() => service.transcode(session.id, output), /MP4 转码失败/)
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'webm')
  await assert.rejects(() => fs.access(output))
})

test('reports ffmpeg progress and returns the completed MP4', async (t) => {
  const root = await createRoot(t)
  const progress = []
  const fakeSpawn = (_executable, args) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(async () => {
      child.stderr.emit('data', Buffer.from('out_time_ms=500000\nprogress=continue\n'))
      await fs.writeFile(args.at(-1), 'mp4')
      child.emit('close', 0)
    })
    return child
  }
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', spawnProcess: fakeSpawn })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await service.appendChunk(session.id, Buffer.from('webm'))
  await service.finishSession(session.id)
  const output = path.join(root, 'saved.mp4')
  assert.equal(await service.transcode(session.id, output, (value) => progress.push(value)), output)
  assert.deepEqual(progress, [500000])
  assert.equal(await fs.readFile(output, 'utf8'), 'mp4')
})

test('parses progress from standard ffmpeg time output', async (t) => {
  const root = await createRoot(t)
  const progress = []
  const fakeSpawn = (_executable, args) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(async () => {
      child.stderr.emit('data', Buffer.from('frame=15 time=00:00:00.50 bitrate=1000kbits/s'))
      await fs.writeFile(args.at(-1), 'mp4')
      child.emit('close', 0)
    })
    return child
  }
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', spawnProcess: fakeSpawn })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await service.appendChunk(session.id, Buffer.from('webm'))
  await service.finishSession(session.id)
  await service.transcode(session.id, path.join(root, 'saved.mp4'), (value) => progress.push(value))
  assert.deepEqual(progress, [500_000])
})

test('forwards audio transcoding options to ffmpeg', async (t) => {
  const root = await createRoot(t)
  const calls = []
  const fakeSpawn = (_executable, args) => {
    calls.push(args)
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(async () => {
      await fs.writeFile(args.at(-1), 'mp4')
      child.emit('close', 0)
    })
    return child
  }
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', spawnProcess: fakeSpawn })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await service.appendChunk(session.id, Buffer.from('webm'))
  await service.finishSession(session.id)

  await service.transcode(session.id, path.join(root, 'audio.mp4'), () => {}, { audio: true })
  const withAudio = calls.at(-1)
  assert.equal(withAudio.includes('-an'), false)
  assert.deepEqual(withAudio.slice(withAudio.indexOf('-map'), withAudio.indexOf('-map') + 2), ['-map', '0:v:0'])
  assert.equal(withAudio[withAudio.indexOf('-c:a') + 1], 'aac')
  assert.equal(withAudio[withAudio.indexOf('-b:a') + 1], '160k')
  assert.deepEqual(withAudio.slice(withAudio.indexOf('-ar'), withAudio.indexOf('-ar') + 4), ['-ar', '48000', '-ac', '2'])

  await service.transcode(session.id, path.join(root, 'silent.mp4'), () => {}, { audio: false })
  assert.ok(calls.at(-1).includes('-an'))

  // The legacy three-argument call stays silent.
  await service.transcode(session.id, path.join(root, 'legacy.mp4'))
  assert.ok(calls.at(-1).includes('-an'))
  assert.equal(calls.at(-1).includes('-c:a'), false)
})

test('cleanup removes only the selected session directory', async (t) => {
  const root = await createRoot(t)
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg' })
  const first = await service.startSession()
  const second = await service.startSession()
  await service.cleanupSession(first.id)
  await assert.rejects(() => fs.access(first.directory))
  await fs.access(second.directory)
  await service.dispose()
})

// Regression from a real device: "after recording I can Save MP4, but the trim panel says the
// recording file could not be read (00:00.0) and the Export button never enables".
//
// Root cause: the media probe was only ever wired into the EXPORT queue. The RecordingService was
// constructed in main.js WITHOUT a `probe`, so every `probeSession()` returned `probe-unavailable`.
// `transcode()` (Save MP4) never probes, which is exactly why saving kept working while trimming did
// not - an asymmetry no existing test could see, because EVERY test constructed the service without a
// probe and never called probeSession at all.
test('a service built without a probe reports probe-unavailable instead of a guessed duration', async (t) => {
  const root = await createRoot(t)
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg' })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await service.appendChunk(session.id, Buffer.from('webm'))
  await service.finishSession(session.id)
  // The failure must be explicit and distinguishable - never a fabricated zero/guessed duration.
  assert.deepEqual(await service.probeSession(session.id, { crossCheckMs: 1000 }), { ok: false, code: 'probe-unavailable' })
})

test('the production recording-service wiring supplies a media probe (main.js)', () => {
  // main.js is the only place that decides what the shipping RecordingService gets. A missing probe
  // there silently disables the whole trim/export feature while everything else keeps working, so the
  // wiring itself is asserted rather than trusted.
  const mainSource = require('node:fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const start = mainSource.indexOf('function getRecordingService()')
  assert.ok(start > 0, 'getRecordingService() must exist')
  const end = mainSource.indexOf('\n}', start)
  const body = mainSource.slice(start, end)
  assert.match(body, /new RecordingService\(\{/, 'the service must be constructed there')
  assert.match(
    body,
    /probe:\s*createRecordingMediaProbe\(/,
    'the production RecordingService must be given the media probe, or probeSession() always fails'
  )
  // And the factory must be imported from the bootstrap module that owns probe construction.
  const importMatch = /const \{([^}]*)\} = require\('\.\/main\/services\/feature-services-bootstrap'\)/.exec(mainSource)
  assert.ok(importMatch, 'main.js must import from feature-services-bootstrap')
  assert.match(importMatch[1], /createRecordingMediaProbe/, 'the probe factory must be in that import list')
})

test('the probe factory builds a real MediaProbe usable by the recording service', () => {
  const { createRecordingMediaProbe } = require('../main/services/feature-services-bootstrap')
  assert.equal(typeof createRecordingMediaProbe, 'function')
  const probe = createRecordingMediaProbe({ getFfmpegPath: () => 'ffmpeg', log: () => {} })
  assert.equal(typeof probe.probe, 'function', 'the factory must return something with probe()')
})
