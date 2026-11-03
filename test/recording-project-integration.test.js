'use strict'

// W1b main-process integration test: the R1-R3 persistence loop without Electron.
//
//   project -> sequence-numbered source chunks -> checkpoint -> probe -> seal
//           -> simulated restart -> persisted session -> REAL MP4 export
//           -> export record -> draft CAS -> re-open -> delete
//
// Everything below the renderer is exercised with the real bundled ffmpeg
// (`ffmpeg-static`): a real WebM is generated, written through RecordingService,
// probed by MediaProbe, sealed into a project, exported by RecordingExportService and
// finally re-probed. The only doubles are the ones the contract explicitly allows to
// be main-process owned (the save-dialog target path and the result registrar).
//
// Guarded: when `ffmpeg-static` is not installed the whole file skips instead of
// failing, exactly like the existing feature-E tests. Scratch files live under a
// gitignored `.tmp*` directory inside the checkout: on a confined host a spawned
// ffmpeg child cannot write to %LOCALAPPDATA%\Temp (see AGENTS.md), so the same
// convention as test/recording-export.test.js is used. The test removes them.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ffmpegPath = (() => {
  try {
    return require('ffmpeg-static')
  } catch {
    return ''
  }
})()
const ffmpegAvailable = !!ffmpegPath && fs.existsSync(ffmpegPath)

const { atomicWriteJson } = require('../main/services/data-root')
const { createMediaProbe } = require('../main/services/recording-probe')
const { RecordingService } = require('../main/services/recording-service')
const { createRecordingProjectService } = require('../main/services/recording-project-service')
const { createRecordingExportService } = require('../main/services/recording-export-service')
const { durationToleranceMs } = require('../shared/recording-export-options')

const FIXTURE_SECONDS = 3
const FIXTURE_WIDTH = 320
const FIXTURE_HEIGHT = 240
const FIXTURE_RATE = 10
const ROOT = path.join(__dirname, '..')
// `.tmp*` is gitignored (AGENTS.md); mkdtemp adds the unique suffix.
const SCRATCH_PREFIX = path.join(ROOT, '.tmp-recording-project-integration-')

const CAPTURE_CONFIG = {
  target: {
    mode: 'display',
    displayId: 'integration-display',
    displayName: 'TEST-DISPLAY',
    boundsDip: { x: 0, y: 0, width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT },
    pixelSize: { width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT },
    scaleFactor: 1
  },
  frameRate: FIXTURE_RATE,
  quality: 'standard',
  countdown: 0,
  audio: {
    system: true,
    microphone: false,
    microphoneDeviceId: '',
    systemGain: 1,
    microphoneGain: 1
  }
}

async function makeScratch(t) {
  const directory = await fsp.mkdtemp(SCRATCH_PREFIX)
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  return {
    directory,
    pathFor: (name) => path.join(directory, name)
  }
}

// A real, seekable WebM: VP8 video (320x240 @ 10 fps) plus an Opus sine track. `testsrc`
// gives deterministic frame content so two runs produce the same structure (not the same
// bytes, but the same probe result), and `-shortest` clips audio to the video duration.
function makeWebmFixture(targetPath) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=${FIXTURE_WIDTH}x${FIXTURE_HEIGHT}:rate=${FIXTURE_RATE}:duration=${FIXTURE_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${FIXTURE_SECONDS}`,
    '-c:v', 'libvpx', '-b:v', '300k',
    '-c:a', 'libopus',
    '-shortest',
    '-y', targetPath
  ]
  const result = spawnSync(ffmpegPath, args, { encoding: 'utf8', timeout: 60000, windowsHide: true })
  assert.equal(result.status, 0, `Unable to build the WebM fixture.\n${result.stderr}`)
  return targetPath
}

function createProjectService(recordingsRoot) {
  return createRecordingProjectService({
    root: recordingsRoot,
    atomicWriteJson,
    log: () => {}
  })
}

// Probe metadata as it is persisted in the project manifest, converted back to the shape
// `registerPersistedSession()`/the export service expects. This is what the record domain
// does in main/domains/record/index.js (`probeMetadataFromProject`).
function metadataFromProject(project) {
  return {
    durationMs: project.media.durationMs,
    startMs: 0,
    durationSource: 'container',
    video: {
      codec: '',
      width: project.media.video.width,
      height: project.media.video.height,
      frameRate: FIXTURE_RATE
    },
    audio: {
      exists: project.media.audio.tracks > 0,
      codec: project.media.audio.codec,
      sampleRate: 48000,
      channels: 1
    },
    timebase: 'ms-media-timeline'
  }
}

function splitBytes(buffer, count) {
  const chunks = []
  const size = Math.ceil(buffer.length / count)
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)))
  }
  return chunks
}

async function waitForTerminal(exporter, taskId, ownerId = null, timeoutMs = 120000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const status = exporter.status(ownerId ? { taskId, ownerId } : { taskId })
    if (!status.ok) throw new Error(`export task ${taskId} is not readable: ${status.code}`)
    if (['succeeded', 'failed', 'cancelled'].includes(status.task.state)) return status.task
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`export task ${taskId} did not settle in ${timeoutMs} ms`)
}

// Runs the capture half of the loop once and shuts both services down, so a test can start
// from the exact on-disk state an application restart would see.
async function seedSealedProject(scratch) {
  const probe = createMediaProbe({ ffmpegPath })
  const recordingsRoot = scratch.pathFor('recordings')
  const projectService = createProjectService(recordingsRoot)
  const recordingService = new RecordingService({
    tempRoot: scratch.pathFor('session-temp'),
    ffmpegPath,
    probe
  })
  const fixturePath = makeWebmFixture(scratch.pathFor('fixture.webm'))
  const fixture = fs.readFileSync(fixturePath)
  const created = await projectService.createProject({ mode: 'display', captureConfig: CAPTURE_CONFIG })
  const session = await recordingService.startSession({
    directory: created.directory,
    projectId: created.project.id
  })
  await recordingService.appendChunk(session.id, fixture)
  await recordingService.finishSession(session.id)
  const probed = await recordingService.probeSession(session.id)
  assert.equal(probed.ok, true, 'the generated fixture must be probeable')
  const sealed = await projectService.sealProject(created.project.id, {
    metadata: probed.metadata,
    captureOutcome: { video: true, audio: { system: true, microphone: false }, warnings: [] }
  })
  assert.equal(sealed.ok, true)
  await projectService.dispose()
  await recordingService.dispose()
  return {
    probe,
    recordingsRoot,
    project: sealed.project,
    directory: created.directory,
    fixture
  }
}

test('capture flow: sequenced chunks, checkpoint, probe and seal the project',
  { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
    const scratch = await makeScratch(t)
    const fixturePath = makeWebmFixture(scratch.pathFor('fixture.webm'))
    const fixture = fs.readFileSync(fixturePath)
    assert.ok(fixture.length > 10_000, 'the fixture must be a non-trivial WebM')

    const probe = createMediaProbe({ ffmpegPath })
    const projectService = createProjectService(scratch.pathFor('recordings'))
    t.after(() => projectService.dispose())
    const recordingService = new RecordingService({
      tempRoot: scratch.pathFor('session-temp'),
      ffmpegPath,
      probe
    })
    t.after(() => recordingService.dispose())

    // 1) project first, then a session that writes into the project directory.
    const created = await projectService.createProject({ mode: 'display', captureConfig: CAPTURE_CONFIG })
    const projectId = created.project.id
    assert.equal(created.project.state, 'capturing')
    assert.equal(path.dirname(created.directory), scratch.pathFor('recordings'))

    const session = await recordingService.startSession({
      directory: created.directory,
      projectId
    })
    const live = recordingService.peekSession(session.id)
    assert.equal(live.ownedDirectory, false, 'the project owns the directory')
    assert.equal(live.projectId, projectId)
    assert.equal(session.inputPath, path.join(created.directory, 'capture.webm'))

    // 2) stream the fixture as sequence-numbered chunks; every ACK reports the cumulative
    //    committed byte count and the accepted sequence.
    const chunks = splitBytes(fixture, 4)
    let committed = 0
    for (const [index, chunk] of chunks.entries()) {
      const sequence = index + 1
      committed += chunk.length
      const ack = await recordingService.appendChunk(session.id, chunk, { sequence })
      assert.deepEqual(ack, { committedBytes: committed, sequence, lastChunkSequence: sequence })
    }
    assert.deepEqual(fs.readFileSync(session.inputPath), fixture, 'chunks must be written in order')

    // 3) a replayed sequence returns the current ACK without writing the chunk twice.
    const replay = await recordingService.appendChunk(session.id, chunks[0], { sequence: 1 })
    assert.deepEqual(replay, {
      committedBytes: fixture.length,
      sequence: 1,
      lastChunkSequence: chunks.length
    })
    assert.equal(fs.statSync(session.inputPath).size, fixture.length, 'a replay must not duplicate bytes')

    // 4) a skipped sequence is refused before anything is written.
    await assert.rejects(
      () => recordingService.appendChunk(session.id, Buffer.from('gap'), { sequence: chunks.length + 2 }),
      (error) => {
        assert.equal(error.code, 'sequence-gap')
        assert.equal(error.expected, chunks.length + 1)
        return true
      }
    )
    assert.equal(fs.statSync(session.inputPath).size, fixture.length)

    // 5) the first checkpoint is durable immediately, but it is an ACK-independent write:
    //    the project manifest is still `capturing` until sealProject().
    assert.equal(await projectService.checkpoint(projectId, {
      committedByteOffset: fixture.length,
      lastChunkSequence: chunks.length
    }), true)
    const checkpointed = await projectService.getProject(projectId)
    assert.equal(checkpointed.state, 'capturing')
    assert.equal(checkpointed.recovery.committedByteOffset, fixture.length)
    assert.equal(checkpointed.recovery.lastChunkSequence, chunks.length)
    assert.equal(checkpointed.recovery.cleanStop, false)

    // 6) finish with the REAL probe, then seal with that metadata.
    const finished = await recordingService.finishSession(session.id)
    assert.equal(finished.bytesWritten, fixture.length)
    const probed = await recordingService.probeSession(session.id, { crossCheckMs: FIXTURE_SECONDS * 1000 })
    assert.equal(probed.ok, true)
    assert.ok(Math.abs(probed.metadata.durationMs - FIXTURE_SECONDS * 1000) <= 250,
      `fixture duration ${probed.metadata.durationMs} ms should be about ${FIXTURE_SECONDS * 1000} ms`)

    const sealed = await projectService.sealProject(projectId, {
      metadata: probed.metadata,
      captureOutcome: { video: true, audio: { system: true, microphone: false }, warnings: [] }
    })
    assert.equal(sealed.ok, true)
    const project = sealed.project
    assert.equal(project.state, 'ready')
    assert.equal(project.source.bytes, fixture.length)
    assert.equal(project.source.fileName, 'capture.webm')
    assert.deepEqual(project.media.video, { width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT })
    assert.deepEqual(project.media.audio, { tracks: 1, codec: 'opus' })
    assert.ok(Math.abs(project.media.durationMs - FIXTURE_SECONDS * 1000) <= 250)
    assert.equal(project.recovery.cleanStop, true)
    assert.equal(project.recovery.errorCode, '')
    assert.equal(project.recovery.committedByteOffset, fixture.length)
    assert.equal(project.recovery.lastChunkSequence, chunks.length)
    assert.deepEqual(project.captureOutcome.audio, { system: true, microphone: false })

    // 7) public projections stay path-free after sealing.
    const summary = projectService.summaryOf(project)
    const publicProject = projectService.publicProject(project)
    for (const projection of [summary, publicProject]) {
      const serialized = JSON.stringify(projection)
      assert.equal(serialized.includes(scratch.directory), false)
      assert.equal(serialized.includes('capture.webm'), false)
      assert.equal(serialized.includes('targetPath'), false)
    }
    assert.equal(summary.durationMs, project.media.durationMs)
    assert.equal(summary.width, FIXTURE_WIDTH)
    assert.equal(summary.height, FIXTURE_HEIGHT)
    assert.equal(summary.hasAudio, true)
  })

test('restart flow: persisted project exports, draft survives reopen, delete keeps the export',
  { skip: !ffmpegAvailable && 'ffmpeg-static is not installed' }, async (t) => {
    const scratch = await makeScratch(t)
    const seeded = await seedSealedProject(scratch)
    const projectId = seeded.project.id
    const projectDirectory = seeded.directory
    const sourcePath = path.join(projectDirectory, 'capture.webm')
    const exportTarget = scratch.pathFor('exports/trimmed.mp4')
    assert.equal(fs.readFileSync(sourcePath).length, seeded.fixture.length)

    // 1) simulated application restart: brand-new service instances over the same root.
    const projectService = createProjectService(seeded.recordingsRoot)
    t.after(() => projectService.dispose())
    const recordingService = new RecordingService({
      tempRoot: scratch.pathFor('session-temp-restart'),
      ffmpegPath,
      probe: createMediaProbe({ ffmpegPath })
    })
    t.after(() => recordingService.dispose())

    const listing = await projectService.listProjects()
    assert.deepEqual(listing.items.map((item) => item.id), [projectId])
    assert.equal(listing.items[0].state, 'ready')
    const reopenedProject = await projectService.getProject(projectId)
    assert.equal(reopenedProject.recovery.cleanStop, true)
    assert.equal(reopenedProject.state, 'ready')
    assert.equal(await projectService.sourcePathOf(projectId), sourcePath)

    // 2) re-attach the source the way the editor/openEditor path does.
    const attached = await recordingService.registerPersistedSession({
      id: projectId,
      directory: projectDirectory,
      inputPath: sourcePath,
      metadata: metadataFromProject(reopenedProject),
      projectId
    })
    assert.equal(attached.state, 'ready')
    assert.equal(attached.ownedDirectory, false)
    assert.equal(attached.bytesWritten, seeded.fixture.length)

    // 3) REAL export through the shared task service, with a frozen half-open range.
    const probe = seeded.probe
    const registrations = []
    const exporter = createRecordingExportService({
      getRecordingService: () => recordingService,
      probe,
      registerResult: ({ filePath, kind, requestId, ownerId }) => {
        registrations.push({ filePath, kind, requestId, ownerId })
        return {
          status: 'saved',
          resultId: 'integration-result-1',
          fileName: path.basename(filePath),
          kind
        }
      },
      log: () => {}
    })
    t.after(() => exporter.dispose())

    const range = { startMs: 600, endMs: 1600 }
    const submitted = await exporter.submit({
      sessionId: projectId,
      requestId: 'integration-export-1',
      request: { format: 'mp4', range },
      targetPath: exportTarget,
      ownerId: 'integration-test'
    })
    assert.equal(submitted.ok, true, JSON.stringify(submitted))
    const settled = await waitForTerminal(exporter, submitted.task.taskId, 'integration-test')
    assert.equal(settled.state, 'succeeded', JSON.stringify(settled.error || null))
    assert.equal(settled.receipt.status, 'saved')
    assert.equal(settled.receipt.kind, 'mp4')
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].kind, 'mp4')
    assert.deepEqual(registrations[0].requestId, 'integration-export-1')

    // The published MP4 is real media: it probes with the requested shortened span.
    assert.equal(fs.existsSync(exportTarget), true)
    assert.ok(fs.statSync(exportTarget).size > 0)
    const published = await probe.probe(exportTarget)
    assert.equal(published.ok, true)
    assert.deepEqual(
      [published.metadata.video.width, published.metadata.video.height],
      [FIXTURE_WIDTH, FIXTURE_HEIGHT]
    )
    assert.equal(published.metadata.audio.exists, true, 'the mixed audio track must be preserved')
    const spanMs = range.endMs - range.startMs
    assert.ok(Math.abs(published.metadata.durationMs - spanMs) <= durationToleranceMs(spanMs),
      `published duration ${published.metadata.durationMs} ms is within tolerance of ${spanMs} ms`)
    // The export never damages the source it read.
    assert.equal(fs.readFileSync(sourcePath).length, seeded.fixture.length)

    // 4) the export record is attached to the project, but its main-process target path
    //    never appears in a public projection.
    const recorded = await projectService.appendExport(projectId, {
      exportId: settled.taskId,
      format: 'mp4',
      fileName: 'trimmed.mp4',
      exportedAt: Date.now(),
      editRevision: reopenedProject.edit.revision,
      targetPath: exportTarget
    })
    assert.equal(recorded.ok, true)
    assert.equal(recorded.project.exports.length, 1)
    assert.equal(recorded.project.exports[0].targetPath, exportTarget)
    const publicAfterExport = projectService.publicProject(recorded.project)
    assert.equal(publicAfterExport.exportCount, 1)
    assert.deepEqual(publicAfterExport.lastExport, {
      format: 'mp4',
      fileName: 'trimmed.mp4',
      exportedAt: recorded.project.exports[0].exportedAt
    })
    assert.deepEqual(Object.keys(publicAfterExport.exports[0]).sort(), [
      'editRevision',
      'exportId',
      'exportedAt',
      'fileName',
      'format'
    ])
    assert.equal(JSON.stringify(publicAfterExport).includes(exportTarget), false)

    // 5) draft CAS: a stale revision loses, then the accepted draft survives a re-open.
    const draft = await projectService.updateDraft(projectId, {
      expectedRevision: 1,
      edit: { keepRanges: [{ id: 'keep-1', startMs: range.startMs, endMs: range.endMs }], format: 'mp4' }
    })
    assert.equal(draft.ok, true)
    assert.equal(draft.revision, 2)
    assert.deepEqual(
      await projectService.updateDraft(projectId, { expectedRevision: 1, edit: { format: 'gif' } }),
      { ok: false, code: 'revision-conflict', revision: 2 }
    )

    const reopenedService = createProjectService(seeded.recordingsRoot)
    t.after(() => reopenedService.dispose())
    const persisted = await reopenedService.getProject(projectId)
    assert.equal(persisted.edit.revision, 2)
    assert.equal(persisted.edit.format, 'mp4')
    assert.deepEqual(persisted.edit.keepRanges, [{ id: 'keep-1', startMs: range.startMs, endMs: range.endMs }])

    // 6) deleting the project removes the source directory but never the user's export.
    const exportSize = fs.statSync(exportTarget).size
    assert.deepEqual(await projectService.deleteProject(projectId), { ok: true })
    assert.equal(fs.existsSync(projectDirectory), false)
    assert.equal(fs.existsSync(exportTarget), true, 'a user export is not owned by the project')
    assert.equal(fs.statSync(exportTarget).size, exportSize)
    assert.equal(await projectService.getProject(projectId), null)
    // Idempotent: an interrupted/retried delete reports success again.
    assert.deepEqual(await projectService.deleteProject(projectId), { ok: true })
  })
