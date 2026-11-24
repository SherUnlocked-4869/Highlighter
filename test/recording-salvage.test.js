'use strict'

// D03: salvage of the decodable part of an interrupted recording.
//
// These tests never run FFmpeg: a fake child process writes/keeps the output file and the media
// probe is a pure function. That keeps the suite fast and lets each acceptance sample (clean
// salvage, truncated tail, zero bytes, disk full, timeout, cancel, quota) be injected exactly.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const {
  DEFAULT_MAX_DURATION_MS,
  buildRemuxArgs,
  createRecordingSalvage,
  salvageAssetName
} = require('../main/services/recording-salvage')

const root = path.join(__dirname, '..')
let scratch = ''

test.before(async () => {
  scratch = await fsp.mkdtemp(path.join(root, '.tmp-salvage-'))
})

test.after(async () => {
  await fsp.rm(scratch, { recursive: true, force: true })
})

function hashOf(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function tempLeftovers(directory) {
  return fs.readdirSync(directory).filter((name) => name.startsWith('.salvage-'))
}

async function sample(name, bytes = '0123456789abcdef') {
  const directory = path.join(scratch, name)
  await fsp.mkdir(directory, { recursive: true })
  const sourcePath = path.join(directory, 'capture.webm')
  await fsp.writeFile(sourcePath, Buffer.from(bytes))
  return { directory, sourcePath }
}

// A fake spawn: the LAST argv entry is the output path (FFmpeg's contract), so every behavior can
// write, truncate or ignore that file without knowing the service internals.
function fakeSpawn(run) {
  const calls = []
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killCalls = []
    child.kill = (signal) => {
      child.killCalls.push(signal || 'SIGTERM')
      setImmediate(() => child.emit('close', null, signal || 'SIGKILL'))
    }
    const outputPath = args[args.length - 1]
    const call = { executable, args, options, child, outputPath }
    calls.push(call)
    setImmediate(() => {
      try {
        run(call)
      } catch (error) {
        child.emit('error', error)
      }
    })
    return child
  }
  return { spawnProcess, calls }
}

function probeOk(metadata = {}) {
  const calls = []
  const probe = async (filePath) => {
    calls.push(filePath)
    return {
      ok: true,
      metadata: {
        durationMs: 4200,
        startMs: 0,
        container: 'matroska,webm',
        video: { codec: 'vp9', width: 640, height: 360, frameRate: 30 },
        audio: { exists: true, codec: 'opus', sampleRate: 48000, channels: 2 },
        ...metadata
      }
    }
  }
  probe.calls = calls
  return probe
}

function probeFails(code = 'duration-unavailable') {
  const calls = []
  const probe = async (filePath) => {
    calls.push(filePath)
    return { ok: false, code }
  }
  probe.calls = calls
  return probe
}

function serviceWith({ spawnProcess, probe, getFreeBytes = async () => Infinity, limits = {} } = {}) {
  const service = createRecordingSalvage({
    ffmpegPath: 'ffmpeg-fake',
    spawnProcess,
    probe,
    getFreeBytes,
    log: () => {}
  })
  return { service, limits }
}

test('salvageAssetName stays a safe sibling file name and keeps the media extension', () => {
  assert.equal(salvageAssetName('capture.webm'), 'capture.salvaged.webm')
  assert.equal(salvageAssetName('Screen Recording 1.webm'), 'Screen_Recording_1.salvaged.webm')
  assert.equal(salvageAssetName('capture.salvaged.webm'), 'capture.salvaged.webm')
  assert.equal(salvageAssetName('take.mp4'), 'take.salvaged.mp4')
  assert.equal(salvageAssetName('take.unknown'), 'take.salvaged.webm')
  assert.match(salvageAssetName('../../evil.webm'), /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  assert.doesNotMatch(salvageAssetName('../../evil.webm'), /[\\/]/)
})

test('remux args use stream copy, timestamp repair, the duration ceiling and the byte quota', () => {
  const args = buildRemuxArgs({
    inputPath: 'D:/tmp/source.webm',
    outputPath: 'D:/tmp/output.webm',
    maxDurationMs: 90000,
    maxOutputBytes: 12345,
    sourcePath: 'D:/project/capture.webm'
  })
  assert.equal(args.at(-1), 'D:/tmp/output.webm')
  assert.ok(args.includes('-c') && args[args.indexOf('-c') + 1] === 'copy')
  assert.ok(args.includes('-fflags') && args[args.indexOf('-fflags') + 1] === '+genpts')
  assert.ok(args.includes('-t') && args[args.indexOf('-t') + 1] === '90.000')
  assert.ok(args.includes('-fs') && args[args.indexOf('-fs') + 1] === '12345')
  assert.ok(args.includes('-f') && args[args.indexOf('-f') + 1] === 'webm')
  assert.ok(args.includes('-avoid_negative_ts'))
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0:v:0?'])
})

test('a recoverable sample is remuxed from a same-volume copy, probe-verified and published', async () => {
  const { directory, sourcePath } = await sample('success')
  const beforeHash = hashOf(sourcePath)
  const spawn = fakeSpawn((call) => {
    fs.writeFileSync(call.outputPath, Buffer.from('remuxed-media-part'))
    call.child.emit('close', 0, null)
  })
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })

  const result = await service.salvage({
    sourcePath,
    workingDirectory: directory,
    probe,
    spawnProcess: spawn.spawnProcess,
    limits: { maxDurationMs: 60000, maxOutputBytes: 1024 * 1024 }
  })

  assert.equal(result.ok, true, JSON.stringify(result.reason))
  assert.equal(result.reason, '')
  assert.equal(result.assetPath, path.join(directory, 'capture.salvaged.webm'))
  assert.equal(fs.existsSync(result.assetPath), true)
  assert.equal(fs.readFileSync(result.assetPath, 'utf8'), 'remuxed-media-part')
  assert.equal(result.metadata.durationMs, 4200)
  assert.equal(result.metadata.audio.exists, true)
  assert.equal(result.attempted.copyBytes, Buffer.byteLength('0123456789abcdef'))
  assert.equal(result.attempted.remux.ran, true)
  assert.equal(result.attempted.probe.ok, true)
  assert.equal(spawn.calls.length, 1)
  // FFmpeg only ever saw the temp copy, never the original source.
  const inputIndex = spawn.calls[0].args.indexOf('-i')
  assert.notEqual(spawn.calls[0].args[inputIndex + 1], sourcePath)
  assert.match(spawn.calls[0].args[inputIndex + 1], /[\\/]\.salvage-[^\\/]+[\\/]source\.webm$/)
  // The original bytes and the temp directory are untouched/cleaned.
  assert.equal(hashOf(sourcePath), beforeHash)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('idempotent retry reuses a probe-verified asset without running FFmpeg again', async () => {
  const { directory, sourcePath } = await sample('idempotent')
  const spawn = fakeSpawn((call) => {
    fs.writeFileSync(call.outputPath, Buffer.from('first-result'))
    call.child.emit('close', 0, null)
  })
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })
  const options = {
    sourcePath,
    workingDirectory: directory,
    probe,
    spawnProcess: spawn.spawnProcess,
    limits: { maxDurationMs: 60000 }
  }

  const first = await service.salvage(options)
  assert.equal(first.ok, true)
  assert.equal(first.reused, false)
  const firstBytes = fs.readFileSync(first.assetPath, 'utf8')

  const second = await service.salvage(options)
  assert.equal(second.ok, true)
  assert.equal(second.reused, true)
  assert.equal(second.assetPath, first.assetPath)
  assert.equal(spawn.calls.length, 1, 'a second call must not spawn FFmpeg')
  assert.equal(fs.readFileSync(second.assetPath, 'utf8'), firstBytes)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('concurrent calls for one source share a single in-flight salvage', async () => {
  const { directory, sourcePath } = await sample('concurrent')
  const spawn = fakeSpawn((call) => {
    setTimeout(() => {
      fs.writeFileSync(call.outputPath, Buffer.from('concurrent-result'))
      call.child.emit('close', 0, null)
    }, 10)
  })
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })
  const options = {
    sourcePath,
    workingDirectory: directory,
    probe,
    spawnProcess: spawn.spawnProcess,
    limits: { maxDurationMs: 60000 }
  }

  const results = await Promise.all([service.salvage(options), service.salvage(options), service.salvage(options)])
  assert.equal(results.every((result) => result.ok), true)
  assert.equal(spawn.calls.length, 1)
  const assetPath = results[0].assetPath
  assert.equal(results[1].assetPath, assetPath)
  assert.equal(results[2].assetPath, assetPath)
})

test('zero-byte source fails structurally without spawning FFmpeg and the original stays untouched', async () => {
  const { directory, sourcePath } = await sample('zero-byte', '')
  const beforeHash = hashOf(sourcePath)
  const spawn = fakeSpawn(() => {})
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })

  const result = await service.salvage({ sourcePath, workingDirectory: directory, probe })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'source-empty')
  assert.equal(result.attempted.sourceBytes, 0)
  assert.equal(spawn.calls.length, 0)
  assert.equal(hashOf(sourcePath), beforeHash)
  assert.equal(fs.existsSync(path.join(directory, 'capture.salvaged.webm')), false)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('a source that already carries the salvage name is never overwritten', async () => {
  const directory = path.join(scratch, 'name-conflict')
  await fsp.mkdir(directory, { recursive: true })
  const sourcePath = path.join(directory, 'capture.salvaged.webm')
  await fsp.writeFile(sourcePath, Buffer.from('the-only-copy'))
  const beforeHash = hashOf(sourcePath)
  const spawn = fakeSpawn(() => {})
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })

  const result = await service.salvage({ sourcePath, workingDirectory: directory, probe })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'asset-name-conflict')
  assert.equal(spawn.calls.length, 0)
  assert.equal(hashOf(sourcePath), beforeHash)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('a truncated tail whose remux cannot be probe-verified fails with a reason and cleans temp files', async () => {
  const { directory, sourcePath } = await sample('truncated', 'webm-header-plus-a-half-cluster')
  const beforeHash = hashOf(sourcePath)
  const spawn = fakeSpawn((call) => {
    // FFmpeg can exit 0 with an unusable fragment when the tail is cut mid-cluster; the probe is
    // the authority and must reject it.
    fs.writeFileSync(call.outputPath, Buffer.from('bad'))
    call.child.emit('close', 0, null)
  })
  const probe = probeFails('duration-unavailable')
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })

  const result = await service.salvage({ sourcePath, workingDirectory: directory, probe, spawnProcess: spawn.spawnProcess })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'probe-failed')
  assert.equal(result.attempted.remux.ran, true)
  assert.equal(result.attempted.probe.ok, false)
  assert.equal(result.attempted.probe.code, 'duration-unavailable')
  assert.equal(hashOf(sourcePath), beforeHash)
  assert.equal(fs.existsSync(path.join(directory, 'capture.salvaged.webm')), false)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('disk-full is detected before FFmpeg starts and leaves no temp directory', async () => {
  const { directory, sourcePath } = await sample('disk-full', 'some-media-bytes')
  const beforeHash = hashOf(sourcePath)
  const spawn = fakeSpawn(() => {})
  const probe = probeOk()
  const { service } = serviceWith({
    spawnProcess: spawn.spawnProcess,
    probe,
    getFreeBytes: async () => 0
  })

  const result = await service.salvage({ sourcePath, workingDirectory: directory, probe })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'disk-full')
  assert.equal(result.attempted.freeBytes, 0)
  assert.equal(spawn.calls.length, 0)
  assert.equal(hashOf(sourcePath), beforeHash)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('FFmpeg reporting ENOSPC is mapped to a structured disk-full failure', async () => {
  const { directory, sourcePath } = await sample('enospc')
  const spawn = fakeSpawn((call) => {
    call.child.stderr.emit('data', Buffer.from('av_interleaved_write_frame(): No space left on device'))
    call.child.emit('close', 1, null)
  })
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })

  const result = await service.salvage({ sourcePath, workingDirectory: directory, probe, spawnProcess: spawn.spawnProcess })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'disk-full')
  assert.equal(result.attempted.remux.attempts.length, 1)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('timeout kills the child, removes the temp directory and keeps the original intact', async () => {
  const { directory, sourcePath } = await sample('timeout')
  const beforeHash = hashOf(sourcePath)
  const spawn = fakeSpawn(() => {}) // never writes, never closes
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })

  const result = await service.salvage({
    sourcePath,
    workingDirectory: directory,
    probe,
    spawnProcess: spawn.spawnProcess,
    limits: { timeoutMs: 25, killGraceMs: 20 }
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'timeout')
  assert.equal(spawn.calls.length, 1)
  assert.ok(spawn.calls[0].child.killCalls.length >= 1, 'the child must be killed')
  assert.equal(hashOf(sourcePath), beforeHash)
  assert.equal(fs.existsSync(path.join(directory, 'capture.salvaged.webm')), false)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('AbortSignal cancels the running remux, kills the child and cleans up', async () => {
  const { directory, sourcePath } = await sample('cancel')
  const beforeHash = hashOf(sourcePath)
  const controller = new AbortController()
  const spawn = fakeSpawn(() => {
    setTimeout(() => controller.abort(), 10)
  })
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })
  const stages = []

  const result = await service.salvage({
    sourcePath,
    workingDirectory: directory,
    probe,
    spawnProcess: spawn.spawnProcess,
    signal: controller.signal,
    limits: { killGraceMs: 20 },
    onProgress: (event) => stages.push(event.stage)
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'cancelled')
  assert.equal(spawn.calls.length, 1)
  assert.ok(spawn.calls[0].child.killCalls.length >= 1, 'cancel must kill FFmpeg')
  assert.ok(stages.includes('remux-start'))
  assert.equal(hashOf(sourcePath), beforeHash)
  assert.equal(fs.existsSync(path.join(directory, 'capture.salvaged.webm')), false)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('an already-aborted signal never spawns FFmpeg or creates an asset', async () => {
  const { directory, sourcePath } = await sample('pre-aborted')
  const controller = new AbortController()
  controller.abort()
  const spawn = fakeSpawn(() => {})
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })

  const result = await service.salvage({
    sourcePath,
    workingDirectory: directory,
    probe,
    spawnProcess: spawn.spawnProcess,
    signal: controller.signal
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'cancelled')
  assert.equal(spawn.calls.length, 0)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('the duration ceiling is passed to FFmpeg and enforced on the probe result', async () => {
  const { directory, sourcePath } = await sample('duration-cap')
  const spawn = fakeSpawn((call) => {
    fs.writeFileSync(call.outputPath, Buffer.from('long-output'))
    call.child.emit('close', 0, null)
  })
  const probe = probeOk({ durationMs: 9000 })
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })

  const result = await service.salvage({
    sourcePath,
    workingDirectory: directory,
    probe,
    spawnProcess: spawn.spawnProcess,
    limits: { maxDurationMs: 2000 }
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'duration-exceeds-limit')
  assert.equal(result.attempted.probe.durationMs, 9000)
  const args = spawn.calls[0].args
  assert.equal(args[args.indexOf('-t') + 1], '2.000')
  assert.deepEqual(tempLeftovers(directory), [])
})

test('the byte quota is passed to FFmpeg and an oversized output is rejected', async () => {
  const { directory, sourcePath } = await sample('byte-cap')
  const spawn = fakeSpawn((call) => {
    fs.writeFileSync(call.outputPath, Buffer.alloc(512, 7))
    call.child.emit('close', 0, null)
  })
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })

  const result = await service.salvage({
    sourcePath,
    workingDirectory: directory,
    probe,
    spawnProcess: spawn.spawnProcess,
    limits: { maxOutputBytes: 128 }
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'output-too-large')
  assert.equal(result.attempted.outputBytes, 512)
  const args = spawn.calls[0].args
  assert.equal(args[args.indexOf('-fs') + 1], '128')
  assert.deepEqual(tempLeftovers(directory), [])
})

test('a non-zero remux exit reports ffmpeg-failed with the attempted invocation', async () => {
  const { directory, sourcePath } = await sample('ffmpeg-failed')
  const spawn = fakeSpawn((call) => {
    call.child.stderr.emit('data', Buffer.from('Invalid data found when processing input'))
    call.child.emit('close', 1, null)
  })
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: spawn.spawnProcess, probe })

  const result = await service.salvage({ sourcePath, workingDirectory: directory, probe, spawnProcess: spawn.spawnProcess })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'ffmpeg-failed')
  assert.equal(result.attempted.remux.attempts[0].exitCode, 1)
  assert.match(result.attempted.remux.attempts[0].stderr, /Invalid data/)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('a spawn failure is structured and never throws', async () => {
  const { directory, sourcePath } = await sample('spawn-failed')
  const failingSpawn = () => { throw new Error('spawn EPERM') }
  const probe = probeOk()
  const { service } = serviceWith({ spawnProcess: failingSpawn, probe })

  const result = await service.salvage({ sourcePath, workingDirectory: directory, probe, spawnProcess: failingSpawn })

  assert.equal(result.ok, false)
  assert.equal(result.reason.code, 'spawn-failed')
  assert.match(result.reason.detail, /EPERM/)
  assert.deepEqual(tempLeftovers(directory), [])
})

test('a default duration ceiling of 90 seconds is used when the caller passes none', () => {
  assert.equal(DEFAULT_MAX_DURATION_MS, 90000)
  const args = buildRemuxArgs({
    inputPath: 'in.webm',
    outputPath: 'out.webm',
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
    maxOutputBytes: 1024,
    sourcePath: 'capture.webm'
  })
  assert.equal(args[args.indexOf('-t') + 1], '90.000')
})

// ---------------------------------------------------------------------------
// Domain integration: the recovered asset is attached to the project and the
// original file/checkpoint survive.
// ---------------------------------------------------------------------------

const { createRecordDomain } = require('../main/domains/record')

function createDomainHarness({ directory, project, spawnProcess, probe }) {
  const projects = new Map([[project.id, project]])
  const sessions = new Map()
  const projectService = {
    projects,
    projectDirectory: () => directory,
    sourcePathOf: async (projectId) => {
      const current = projects.get(String(projectId || ''))
      return current ? path.join(directory, current.source.fileName) : ''
    },
    getProject: async (projectId) => projects.get(String(projectId || '')) || null,
    // projectServiceOrNull() identifies the service by this method; creation is not exercised here.
    createProject: async () => ({ project: null, directory }),
    markReady: async (projectId, { fileName, metadata } = {}) => {
      const current = projects.get(String(projectId))
      if (!current) return { ok: false, code: 'not-found' }
      const stat = await fsp.stat(path.join(directory, fileName)).catch(() => null)
      const metadataDuration = Math.max(0, Math.round(Number(metadata?.durationMs) || 0))
      const next = {
        ...current,
        state: 'ready',
        updatedAt: 1234,
        source: { ...current.source, fileName, bytes: stat?.size || 0 },
        media: {
          durationMs: metadataDuration,
          video: { width: Number(metadata?.video?.width) || 0, height: Number(metadata?.video?.height) || 0 },
          audio: { tracks: metadata?.audio?.exists === true ? 1 : 0, codec: metadata?.audio?.codec || '' },
          timebase: 1000,
          probedAt: 99
        },
        recovery: { ...current.recovery, cleanStop: true, errorCode: '' }
      }
      projects.set(String(projectId), next)
      return { ok: true, project: next }
    },
    summaryOf: (value) => ({ id: value.id, name: value.name, state: value.state, durationMs: value.media.durationMs })
  }
  const recordingService = {
    sessions,
    ffmpegPath: 'ffmpeg-fake',
    spawnProcess,
    getProbe: () => probe,
    registerPersistedSession: async ({ id, directory: targetDirectory, inputPath, metadata, projectId }) => {
      const existing = sessions.get(id)
      if (existing) return existing
      const session = {
        id,
        directory: targetDirectory,
        inputPath: inputPath || path.join(targetDirectory, 'capture.webm'),
        projectId,
        state: 'ready',
        references: 0,
        metadata,
        bytesWritten: 0
      }
      sessions.set(id, session)
      return session
    },
    detachSession: (id) => sessions.delete(id)
  }
  const domain = createRecordDomain({
    app: { getPath: () => scratch },
    desktopCapturer: { getSources: async () => [] },
    path,
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => null },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    BrowserWindow: { fromWebContents: () => null },
    rootDirectory: root,
    createLocalWindow: () => { throw new Error('not used') },
    getSettings: () => ({ record: {} }),
    log: () => {},
    assertGameModeDisabled: () => {},
    assertManagedDataWritable: () => {},
    getRecordingService: () => recordingService,
    peekRecordingService: () => recordingService,
    managedRecordingWriters: { track: async (fn) => (typeof fn === 'function' ? fn() : fn), assertOpen: () => {} },
    makeCaptureName: () => 'capture.webm',
    VIDEO_CAPTURE_PREFIX: 'video',
    performanceMonitor: { record: () => {}, snapshot: () => {} },
    getRecordingProjectService: () => projectService,
    getRecordingWorkbench: () => ({})
  })
  return { domain, projects, sessions, controller: domain.createRecordingController() }
}

function recoverableProject(id) {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    name: 'Interrupted take',
    mode: 'display',
    state: 'recoverable',
    captureConfig: {
      target: { mode: 'display', displayId: '', displayName: '', boundsDip: {}, pixelSize: {}, scaleFactor: 1 },
      frameRate: 30,
      quality: 'standard',
      countdown: 3,
      audio: { system: true, microphone: false }
    },
    source: { assetId: 'capture', fileName: 'capture.webm', mediaKind: 'video', mimeType: 'video/webm', bytes: 16 },
    media: { durationMs: 0, video: { width: 0, height: 0 }, audio: { tracks: 0, codec: '' }, timebase: 1000, probedAt: 0 },
    captureOutcome: { video: false, audio: { system: false, microphone: false }, warnings: [] },
    edit: { revision: 1, keepRanges: [], format: 'mp4', gif: { edge: 1280, fps: 15 } },
    exports: [],
    recovery: { committedByteOffset: 999999, lastChunkSequence: 7, cleanStop: false, errorCode: 'interrupted' }
  }
}

test('domain salvage attaches the verified asset and keeps the original checkpoint', async () => {
  const directory = path.join(scratch, 'domain-success')
  await fsp.mkdir(directory, { recursive: true })
  const sourcePath = path.join(directory, 'capture.webm')
  await fsp.writeFile(sourcePath, Buffer.from('damaged-source-bytes'))
  const beforeHash = hashOf(sourcePath)
  const spawn = fakeSpawn((call) => {
    fs.writeFileSync(call.outputPath, Buffer.from('recovered-prefix'))
    call.child.emit('close', 0, null)
  })
  const probe = probeOk({ durationMs: 4200 })
  const project = recoverableProject('project-salvage-domain')
  const { controller, projects, sessions } = createDomainHarness({
    directory,
    project,
    spawnProcess: spawn.spawnProcess,
    probe
  })

  const result = await controller.projectSalvage(null, { projectId: project.id })

  assert.equal(result.ok, true, JSON.stringify(result.reason))
  assert.equal(result.durationMs, 4200)
  assert.equal(result.reused, false)
  assert.equal(result.attempted.remux.ran, true)
  assert.equal(Object.hasOwn(result, 'assetPath'), false, 'the workbench answer must not carry a path')
  assert.equal(result.project.state, 'ready')
  const updated = projects.get(project.id)
  assert.equal(updated.source.fileName, 'capture.salvaged.webm')
  assert.equal(updated.recovery.committedByteOffset, 999999, 'the original checkpoint is preserved')
  assert.equal(updated.recovery.lastChunkSequence, 7)
  assert.equal(updated.media.durationMs, 4200)
  assert.equal(hashOf(sourcePath), beforeHash, 'the original source is untouched')
  assert.equal(fs.existsSync(path.join(directory, 'capture.salvaged.webm')), true)
  assert.equal(sessions.get(project.id).inputPath, path.join(directory, 'capture.salvaged.webm'))

  // A repeated action after the successful attach is idempotent.
  const again = await controller.projectSalvage(null, { projectId: project.id })
  assert.equal(again.ok, true)
  assert.equal(again.reused, true)
  assert.equal(spawn.calls.length, 1, 'the second invocation must not remux again')
  assert.deepEqual(tempLeftovers(directory), [])
})

test('domain salvage failure reports the reason and leaves the project recoverable', async () => {
  const directory = path.join(scratch, 'domain-failure')
  await fsp.mkdir(directory, { recursive: true })
  const sourcePath = path.join(directory, 'capture.webm')
  await fsp.writeFile(sourcePath, Buffer.alloc(0))
  const spawn = fakeSpawn(() => {})
  const probe = probeOk()
  const project = recoverableProject('project-salvage-failure')
  project.source.bytes = 0
  const { controller, projects } = createDomainHarness({
    directory,
    project,
    spawnProcess: spawn.spawnProcess,
    probe
  })

  const result = await controller.projectSalvage(null, { projectId: project.id })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'salvage-failed')
  assert.equal(result.reason.code, 'source-empty')
  assert.equal(result.attempted.sourceBytes, 0)
  assert.equal(spawn.calls.length, 0)
  assert.equal(projects.get(project.id).state, 'recoverable')
  assert.deepEqual(tempLeftovers(directory), [])
})

test('domain salvage refuses a ready project that was never salvaged', async () => {
  const directory = path.join(scratch, 'domain-ready')
  await fsp.mkdir(directory, { recursive: true })
  const project = recoverableProject('project-ready')
  project.state = 'ready'
  const spawn = fakeSpawn(() => {})
  const { controller } = createDomainHarness({
    directory,
    project,
    spawnProcess: spawn.spawnProcess,
    probe: probeOk()
  })

  const result = await controller.projectSalvage(null, { projectId: project.id })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-recoverable')
  assert.equal(result.reason.code, 'not-recoverable')
  assert.equal(spawn.calls.length, 0)
})
