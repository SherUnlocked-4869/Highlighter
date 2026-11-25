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

test('C01: refuses an abnormally large chunk instead of buffering it', async (t) => {
  const root = await createRoot(t)
  const { MAX_APPEND_BYTES, RecordingService } = require('../main/services/recording-service')
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg' })
  t.after(() => service.dispose())
  const session = await service.startSession()
  await service.appendChunk(session.id, Buffer.from('first'))
  await assert.rejects(
    () => service.appendChunk(session.id, Buffer.alloc(MAX_APPEND_BYTES + 1), { sequence: 1 }),
    (error) => error.code === 'chunk-too-large' && error.limit === MAX_APPEND_BYTES
  )
  // The refusal is before any sequence bookkeeping: sequence 1 is still free.
  const ack = await service.appendChunk(session.id, Buffer.from('second'), { sequence: 1 })
  assert.equal(ack.lastChunkSequence, 1)
  const preview = await service.finishSession(session.id)
  assert.equal((await fs.readFile(preview.inputPath)).toString(), 'firstsecond')
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

// ---------------------------------------------------------------------------
// R1 recording workbench: persistent-project sessions and chunk sequencing
// (docs/plans/2026-11-03-recording-r1-r3-contracts.md §5).
// ---------------------------------------------------------------------------

test('startSession({directory}) writes into the project directory and never deletes it', async (t) => {
  const root = await createRoot(t)
  const projectDirectory = path.join(root, 'recordings', 'project-1')
  const service = new RecordingService({ tempRoot: path.join(root, 'temp'), ffmpegPath: 'ffmpeg' })
  t.after(() => service.dispose())

  const session = await service.startSession({ directory: projectDirectory, projectId: 'project-1' })
  assert.equal(session.directory, path.resolve(projectDirectory))
  assert.equal(session.inputPath, path.join(path.resolve(projectDirectory), 'capture.webm'))
  const live = service.peekSession(session.id)
  assert.equal(live.ownedDirectory, false)
  assert.equal(live.projectId, 'project-1')

  await service.appendChunk(session.id, Buffer.from('webm'))
  const finished = await service.finishSession(session.id)
  assert.equal(finished.bytesWritten, 4)

  assert.equal(await service.cleanupSession(session.id), true)
  // The session is gone from the table, but the directory belongs to the project:
  // only recording-project-service may delete it.
  assert.equal(service.peekSession(session.id), null)
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'webm')
})

test('registerPersistedSession attaches an existing source without owning it', async (t) => {
  const root = await createRoot(t)
  const directory = path.join(root, 'recordings', 'kept')
  const inputPath = path.join(directory, 'capture.webm')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(inputPath, 'persisted-media')
  const service = new RecordingService({ tempRoot: path.join(root, 'temp'), ffmpegPath: 'ffmpeg' })
  t.after(() => service.dispose())

  const session = await service.registerPersistedSession({
    id: 'project-kept',
    directory,
    inputPath,
    metadata: { durationMs: 2010 },
    projectId: 'kept'
  })
  assert.equal(session.state, 'ready')
  assert.equal(session.ownedDirectory, false)
  assert.equal(session.bytesWritten, 'persisted-media'.length)
  assert.equal(session.projectId, 'kept')
  assert.equal(session.references, 0)
  assert.equal(session.metadata.durationMs, 2010)
  // Idempotent: a second attach returns the live session object.
  assert.equal(await service.registerPersistedSession({ id: 'project-kept', directory, projectId: 'kept' }), session)

  await service.dispose()
  assert.equal(await fs.readFile(inputPath, 'utf8'), 'persisted-media')
})

test('registerPersistedSession keeps the source inside the session directory', async (t) => {
  const root = await createRoot(t)
  const directory = path.join(root, 'recordings', 'guarded')
  await fs.mkdir(directory, { recursive: true })
  const service = new RecordingService({ tempRoot: path.join(root, 'temp'), ffmpegPath: 'ffmpeg' })
  t.after(() => service.dispose())

  await assert.rejects(
    () => service.registerPersistedSession({
      id: 'project-guarded',
      directory,
      inputPath: path.join(root, 'outside.webm')
    }),
    /inside its session directory/
  )
  await assert.rejects(() => service.registerPersistedSession({ id: '', directory }), /needs an id/)
  await assert.rejects(() => service.registerPersistedSession({ id: 'x', directory: '' }), /needs a directory/)
})

test('detachSession releases the session without deleting anything', async (t) => {
  const root = await createRoot(t)
  const directory = path.join(root, 'recordings', 'detached')
  const service = new RecordingService({ tempRoot: path.join(root, 'temp'), ffmpegPath: 'ffmpeg' })
  t.after(() => service.dispose())
  const session = await service.startSession({ directory, projectId: 'detached' })
  await service.appendChunk(session.id, Buffer.from('webm'))
  await service.finishSession(session.id)

  assert.equal(service.detachSession(session.id), true)
  assert.equal(service.peekSession(session.id), null)
  assert.equal(service.detachSession(session.id), false)
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'webm')
})

test('project-owned sessions are detached after the last export reference releases', async (t) => {
  const root = await createRoot(t)
  const directory = path.join(root, 'recordings', 'referenced')
  const inputPath = path.join(directory, 'capture.webm')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(inputPath, 'media-bytes')
  const service = new RecordingService({ tempRoot: path.join(root, 'temp'), ffmpegPath: 'ffmpeg' })
  t.after(() => service.dispose())
  await service.registerPersistedSession({
    id: 'project-referenced',
    directory,
    inputPath,
    metadata: { durationMs: 1 }
  })

  const lease = service.acquireSource('project-referenced')
  const deferred = await service.cleanupSession('project-referenced')
  assert.equal(deferred, false, 'an export still reads the source')
  assert.equal(service.stateOf('project-referenced'), 'closing')
  assert.equal(await fs.readFile(inputPath, 'utf8'), 'media-bytes')

  assert.equal(lease.release(), 0)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(service.peekSession('project-referenced'), null)
  assert.equal(await fs.readFile(inputPath, 'utf8'), 'media-bytes')
})

test('sequenced append chunks are replay-idempotent and gap-strict', async (t) => {
  const root = await createRoot(t)
  const service = new RecordingService({ tempRoot: path.join(root, 'temp'), ffmpegPath: 'ffmpeg' })
  t.after(() => service.dispose())
  const session = await service.startSession({ directory: path.join(root, 'recordings', 'sequenced'), projectId: 'sequenced' })

  assert.deepEqual(await service.appendChunk(session.id, Buffer.from('one'), { sequence: 1 }), {
    committedBytes: 3,
    sequence: 1,
    lastChunkSequence: 1
  })
  assert.deepEqual(await service.appendChunk(session.id, Buffer.from('two'), { sequence: 2 }), {
    committedBytes: 6,
    sequence: 2,
    lastChunkSequence: 2
  })

  // A lost ACK retried with an already accepted sequence must not write twice.
  assert.deepEqual(await service.appendChunk(session.id, Buffer.from('one'), { sequence: 1 }), {
    committedBytes: 6,
    sequence: 1,
    lastChunkSequence: 2
  })
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'onetwo')

  // A skipped sequence is refused before anything is written.
  await assert.rejects(
    () => service.appendChunk(session.id, Buffer.from('four'), { sequence: 4 }),
    (error) => {
      assert.equal(error.code, 'sequence-gap')
      assert.equal(error.expected, 3)
      assert.equal(error.received, 4)
      return true
    }
  )
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'onetwo')
  assert.equal(service.peekSession(session.id).lastChunkSequence, 2)

  await assert.rejects(
    () => service.appendChunk(session.id, Buffer.from('bad'), { sequence: 0 }),
    (error) => error.code === 'invalid-sequence'
  )

  // The legacy unsequenced append path still works after sequenced chunks (compat).
  assert.deepEqual(await service.appendChunk(session.id, Buffer.from('three')), {
    committedBytes: 11,
    sequence: null,
    lastChunkSequence: 2
  })
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'onetwothree')

  const finished = await service.finishSession(session.id)
  assert.equal(finished.bytesWritten, 11)
  assert.equal(finished.projectId, 'sequenced')
})

// ---------------------------------------------------------------------------
// C01 (plan item 02): a full disk must still deliver the part that was written.
// ---------------------------------------------------------------------------

// Delegates to the real fs and can make ONE append fail the way a full disk does:
// half the buffer reaches the file, then the write rejects with ENOSPC.
function createFailureFs({ failSequence = 0, mode = 'partial' } = {}) {
  const real = require('node:fs/promises')
  const state = { calls: 0, hang: null, resolveHang: null }
  const fake = {
    ...real,
    async appendFile(file, buffer) {
      state.calls += 1
      if (state.hang !== null) {
        // A wedged write: the promise never settles until the test releases it.
        await new Promise((resolve) => { state.resolveHang = resolve })
        return real.appendFile(file, buffer)
      }
      if (state.calls !== failSequence) return real.appendFile(file, buffer)
      if (mode === 'nothing') {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
      const half = Math.max(1, Math.floor(buffer.length / 2))
      await real.appendFile(file, buffer.subarray(0, half))
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    }
  }
  return { fs: fake, state }
}

test('C01 (02): a full disk keeps the confirmed prefix, truncates the torn tail and reports the gap', async (t) => {
  const root = await createRoot(t)
  const { fs: failingFs } = createFailureFs({ failSequence: 2 })
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', fs: failingFs })
  t.after(() => service.dispose())
  const session = await service.startSession({ directory: path.join(root, 'recordings', 'disk-full'), projectId: 'disk-full' })

  const first = await service.appendChunk(session.id, Buffer.from('first'), { sequence: 1 })
  assert.equal(first.committedBytes, 5)
  // The second chunk is torn: three of its five bytes reach the file before ENOSPC.
  await assert.rejects(
    () => service.appendChunk(session.id, Buffer.from('secnd'), { sequence: 2 }),
    (error) => error.code === 'ENOSPC'
  )
  // A chunk received after the failure is refused: accepting it would order data that can
  // never be written, and the file must keep a contiguous confirmed prefix.
  await assert.rejects(
    () => service.appendChunk(session.id, Buffer.from('third'), { sequence: 3 }),
    (error) => error.code === 'append-sealed'
  )

  const finished = await service.finishSession(session.id)
  assert.equal(finished.recovered, true, 'the receipt must say the capture was interrupted')
  assert.equal(finished.bytesWritten, 5)
  assert.equal(finished.committedBytes, 5)
  assert.equal(finished.lastChunkSequence, 1, 'only the fully written chunk is confirmed')
  assert.equal(finished.lastReceivedSequence, 2)
  assert.equal(finished.failure.code, 'ENOSPC')
  assert.equal(finished.failure.missingSequenceFrom, 2)
  assert.equal(finished.failure.missingSequenceTo, 2)
  // The torn tail is gone and the confirmed bytes are byte-identical to what was ACKed.
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'first')
  assert.equal((await fs.stat(session.inputPath)).size, 5)

  // Repeating the stop returns the same receipt instead of "the session already ended".
  const repeated = await service.finishSession(session.id)
  assert.equal(repeated.recovered, true)
  assert.equal(repeated.bytesWritten, 5)
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'first')

  // The replayed sequence from before the failure still reads back its ACK and writes nothing.
  const replay = await service.appendChunk(session.id, Buffer.from('first'), { sequence: 1 })
  assert.equal(replay.committedBytes, 5)
  assert.equal(replay.lastChunkSequence, 1)
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'first')
})

test('C01 (02): when the very first chunk fails there is no confirmed media', async (t) => {
  const root = await createRoot(t)
  const { fs: failingFs } = createFailureFs({ failSequence: 1, mode: 'nothing' })
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', fs: failingFs })
  t.after(() => service.dispose())
  const session = await service.startSession({ directory: path.join(root, 'recordings', 'zero'), projectId: 'zero' })
  await assert.rejects(
    () => service.appendChunk(session.id, Buffer.from('only'), { sequence: 1 }),
    (error) => error.code === 'ENOSPC'
  )
  await assert.rejects(
    () => service.finishSession(session.id),
    (error) => {
      assert.equal(error.code, 'no-confirmed-media')
      assert.equal(error.committedBytes, 0)
      assert.equal(error.failure.code, 'ENOSPC')
      return true
    }
  )
  // Retrying says the same thing rather than pretending the session vanished.
  await assert.rejects(
    () => service.finishSession(session.id),
    (error) => error.code === 'no-confirmed-media'
  )
})

test('C01 (02): a write that never returns yields an interrupted receipt without truncating the original', async (t) => {
  const root = await createRoot(t)
  const { fs: hangingFs, state } = createFailureFs({ failSequence: 0 })
  const service = new RecordingService({ tempRoot: root, ffmpegPath: 'ffmpeg', fs: hangingFs })
  t.after(() => service.dispose())
  const session = await service.startSession({ directory: path.join(root, 'recordings', 'wedge'), projectId: 'wedge' })
  await service.appendChunk(session.id, Buffer.from('first'), { sequence: 1 })

  // The second append never settles. A finish must not wait for it forever, and it must
  // not truncate a file whose size can still grow.
  state.hang = true
  const pending = service.appendChunk(session.id, Buffer.from('second'), { sequence: 2 })
  pending.catch(() => {})
  const finished = await service.finishSession(session.id, { timeoutMs: 50 })
  assert.equal(finished.timedOut, true)
  assert.equal(finished.recovered, true)
  assert.equal(finished.failure.code, 'write-timeout')
  assert.equal(finished.bytesWritten, 5, 'only the bytes that actually reached the file')

  // Release the wedged write: it is allowed to finish (the original is never truncated or
  // renamed), and the new bytes are still on disk for the recovery path.
  state.hang = false
  state.resolveHang()
  await pending.catch(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await fs.readFile(session.inputPath, 'utf8'), 'firstsecond')
  // A late sequence after the timeout is refused, so the sealed file cannot grow further.
  await assert.rejects(
    () => service.appendChunk(session.id, Buffer.from('third'), { sequence: 3 }),
    (error) => error.code === 'append-sealed'
  )
})
