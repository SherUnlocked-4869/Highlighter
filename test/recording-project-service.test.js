'use strict'

// Behaviour tests for the persistent recording-project service (contract §5-§7).
//
// Every test runs on a real temporary directory under the OS temp root and needs no
// Electron. The assertions are about observable behaviour: what is on disk, what the
// public projections expose, and what happens on the failure paths - not about which
// private helper was called.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const {
  CHECKPOINT_MIN_BYTES,
  CHECKPOINT_MIN_INTERVAL_MS,
  createRecordingProjectService,
  defaultProjectName
} = require('../main/services/recording-project-service')

const PROBE_METADATA = {
  durationMs: 2010,
  startMs: 0,
  video: { codec: 'vp9', width: 1280, height: 720, frameRate: 30 },
  audio: { exists: true, codec: 'opus', sampleRate: 48000, channels: 2 },
  timebase: 'ms-media-timeline'
}

async function createContext(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'highlighter-recording-project-test-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const clock = { value: 1_700_000_000_000 }
  let counter = 0
  // The trailing-flush timer is never allowed to fire in tests: durability is asserted
  // through explicit checkpoint()/dispose() calls, so no test depends on wall time.
  const timers = {
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {}
  }
  const root = path.join(parent, 'recordings')
  const service = createRecordingProjectService({
    root,
    now: () => clock.value,
    createId: () => `project-${++counter}`,
    timers
  })
  return {
    parent,
    root,
    clock,
    service,
    advance(milliseconds) {
      clock.value += milliseconds
    }
  }
}

async function readManifest(context, projectId) {
  return context.service.readProjectFile(projectId)
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false)
}

test('createProject writes an atomic capturing manifest and returns its directory', async (t) => {
  const context = await createContext(t)
  const { project, directory } = await context.service.createProject({
    mode: 'region',
    captureConfig: {
      frameRate: 60,
      quality: 'high',
      countdown: 0,
      audio: { system: false, microphone: true, microphoneDeviceId: 'mic-1' }
    },
    name: '  My take  '
  })

  assert.equal(project.id, 'project-1')
  assert.equal(path.resolve(directory), path.join(context.root, 'project-1'))
  assert.deepEqual(await fs.readdir(directory), ['project.json'])

  const raw = await readManifest(context, 'project-1')
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.state, 'capturing')
  assert.equal(raw.name, 'My take')
  assert.equal(raw.mode, 'region')
  assert.equal(raw.edit.revision, 1)
  assert.deepEqual(raw.edit.keepRanges, [])
  assert.equal(raw.recovery.cleanStop, false)
  assert.equal(raw.source.fileName, 'capture.webm')
  assert.equal(raw.captureConfig.frameRate, 60)
  assert.equal(raw.captureConfig.quality, 'high')
  assert.equal(raw.captureConfig.countdown, 0)
  assert.equal(raw.captureConfig.audio.microphone, true)
  assert.equal(raw.captureConfig.audio.microphoneDeviceId, 'mic-1')
  assert.deepEqual(await context.service.getProject('project-1'), project)

  // Projections never contain the directory the project actually lives in.
  for (const projection of [context.service.summaryOf(project), context.service.publicProject(project)]) {
    const serialized = JSON.stringify(projection)
    assert.equal(serialized.includes(context.root), false)
    assert.equal(serialized.includes('project.json'), false)
    assert.equal(serialized.includes('capture.webm'), false)
  }
})

test('createProject generates the frozen default name and refuses an unsafe id', async (t) => {
  const context = await createContext(t)
  const { project } = await context.service.createProject({})
  assert.equal(project.name, defaultProjectName(context.clock.value))
  assert.match(project.name, /^ScreenRecording_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/)

  const unsafe = createRecordingProjectService({
    root: context.root,
    now: () => context.clock.value,
    createId: () => '../escape',
    timers: { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} }
  })
  await assert.rejects(() => unsafe.createProject({}), /safe directory name/)
})

test('createProject rolls back the directory when the manifest write fails', async (t) => {
  const context = await createContext(t)
  const failing = createRecordingProjectService({
    root: context.root,
    now: () => context.clock.value,
    createId: () => 'project-broken',
    timers: { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} },
    atomicWriteJson: async () => { throw new Error('disk full') }
  })

  await assert.rejects(() => failing.createProject({}), /disk full/)
  // No manifest-less directory may survive: listProjects() could never surface it and
  // nothing would ever clean it up.
  assert.equal(await exists(path.join(context.root, 'project-broken')), false)
  assert.deepEqual(await fs.readdir(context.root), [])

  // The rollback path does not disturb a subsequent healthy create.
  const healthy = await context.service.createProject({ name: 'healthy' })
  assert.equal(await exists(healthy.directory), true)
  const listing = await context.service.listProjects()
  assert.deepEqual(listing.items.map((item) => item.id), [healthy.project.id])
})

test('listProjects sorts by updatedAt and paginates stably', async (t) => {
  const context = await createContext(t)
  await context.service.createProject({ name: 'first' })
  context.advance(1000)
  await context.service.createProject({ name: 'second' })
  context.advance(1000)
  await context.service.createProject({ name: 'third' })
  context.advance(1000)
  assert.equal((await context.service.renameProject('project-1', 'first renamed')).ok, true)

  const firstPage = await context.service.listProjects({ offset: 0, limit: 2 })
  assert.equal(firstPage.total, 3)
  assert.equal(firstPage.offset, 0)
  assert.equal(firstPage.limit, 2)
  assert.deepEqual(firstPage.items.map((item) => item.id), ['project-1', 'project-3'])
  assert.deepEqual(firstPage.items.map((item) => item.name), ['first renamed', 'third'])

  const secondPage = await context.service.listProjects({ offset: 2, limit: 2 })
  assert.deepEqual(secondPage.items.map((item) => item.id), ['project-2'])
  assert.equal(secondPage.total, 3)

  // Pagination bounds are clamped rather than rejecting a slightly odd request.
  const clamped = await context.service.listProjects({ offset: -5, limit: 100000 })
  assert.equal(clamped.offset, 0)
  assert.equal(clamped.limit, 200)
  assert.equal(clamped.items.length, 3)

  // Summaries are the list shape: no manifest internals, no path.
  const summary = firstPage.items[0]
  assert.equal(summary.thumbnail, false)
  // listProjects() is the lazy-recovery point: a capture left `capturing` by a dead
  // process is reported as recoverable, never as an active recording.
  assert.equal(summary.state, 'recoverable')
  assert.equal(JSON.stringify(summary).includes(context.root), false)
})

test('listProjects lazily turns an interrupted capture into recoverable', async (t) => {
  const context = await createContext(t)
  await context.service.createProject({ name: 'interrupted' })
  context.advance(5000)
  await context.service.createProject({ name: 'sealed' })
  await context.service.sealProject('project-2', { metadata: PROBE_METADATA })
  // Before the first listing the manifest is still `capturing`: lazy recovery only
  // runs when the history is actually read.
  assert.equal((await context.service.getProject('project-1')).state, 'capturing')

  const listing = await context.service.listProjects()
  const interrupted = listing.items.find((item) => item.id === 'project-1')
  assert.equal(interrupted.state, 'recoverable')

  const raw = await readManifest(context, 'project-1')
  assert.equal(raw.state, 'recoverable')
  assert.equal(raw.recovery.errorCode, 'interrupted')
  assert.equal(raw.recovery.cleanStop, false)
  assert.equal(listing.items.find((item) => item.id === 'project-2').state, 'ready')

  // Re-listing must not clobber the recovery information or flip the state back.
  const again = await context.service.listProjects()
  assert.equal(again.items.find((item) => item.id === 'project-1').state, 'recoverable')
  assert.equal((await readManifest(context, 'project-1')).recovery.errorCode, 'interrupted')
})

test('checkpoint is throttled by time and by byte delta, and dispose flushes', async (t) => {
  const context = await createContext(t)
  await context.service.createProject({})

  // First checkpoint is durable immediately (nothing has been written yet).
  assert.equal(await context.service.checkpoint('project-1', { committedByteOffset: 100, lastChunkSequence: 1 }), true)
  let raw = await readManifest(context, 'project-1')
  assert.equal(raw.recovery.committedByteOffset, 100)
  assert.equal(raw.recovery.lastChunkSequence, 1)

  // Same millisecond, small delta: coalesced, manifest NOT rewritten.
  assert.equal(await context.service.checkpoint('project-1', { committedByteOffset: 200, lastChunkSequence: 2 }), false)
  raw = await readManifest(context, 'project-1')
  assert.equal(raw.recovery.committedByteOffset, 100)
  assert.equal(raw.recovery.lastChunkSequence, 1)

  // Just under the interval: still coalesced.
  context.advance(CHECKPOINT_MIN_INTERVAL_MS - 1)
  assert.equal(await context.service.checkpoint('project-1', { committedByteOffset: 300, lastChunkSequence: 3 }), false)

  // Once the interval passed the next call writes.
  context.advance(1)
  assert.equal(await context.service.checkpoint('project-1', { committedByteOffset: 300, lastChunkSequence: 3 }), true)
  raw = await readManifest(context, 'project-1')
  assert.equal(raw.recovery.committedByteOffset, 300)
  assert.equal(raw.recovery.lastChunkSequence, 3)

  // A large byte delta forces a write even in the same millisecond.
  context.advance(1)
  const largeOffset = 300 + CHECKPOINT_MIN_BYTES
  assert.equal(await context.service.checkpoint('project-1', {
    committedByteOffset: largeOffset,
    lastChunkSequence: 4
  }), true)
  raw = await readManifest(context, 'project-1')
  assert.equal(raw.recovery.committedByteOffset, largeOffset)

  // A late, smaller value can never move recovery backwards.
  assert.equal(await context.service.checkpoint('project-1', { committedByteOffset: 5, lastChunkSequence: 1 }), false)
  raw = await readManifest(context, 'project-1')
  assert.equal(raw.recovery.committedByteOffset, largeOffset)
  assert.equal(raw.recovery.lastChunkSequence, 4)

  // A coalesced value survives dispose() - it is buffered, not dropped.
  context.advance(CHECKPOINT_MIN_INTERVAL_MS + 1)
  assert.equal(await context.service.checkpoint('project-1', { committedByteOffset: largeOffset + 10, lastChunkSequence: 5 }), true)
  assert.equal(await context.service.checkpoint('project-1', { committedByteOffset: largeOffset + 20, lastChunkSequence: 6 }), false)
  await context.service.dispose()
  raw = await readManifest(context, 'project-1')
  assert.equal(raw.recovery.committedByteOffset, largeOffset + 20)
  assert.equal(raw.recovery.lastChunkSequence, 6)
  // Disposing twice is harmless.
  await context.service.dispose()
})

test('sealProject folds pending checkpoints, records disk bytes and marks ready', async (t) => {
  const context = await createContext(t)
  const { directory } = await context.service.createProject({})
  const source = path.join(directory, 'capture.webm')
  await fs.writeFile(source, Buffer.alloc(2048, 1))

  assert.equal(await context.service.checkpoint('project-1', { committedByteOffset: 1024, lastChunkSequence: 1 }), true)
  assert.equal(await context.service.checkpoint('project-1', { committedByteOffset: 2048, lastChunkSequence: 2 }), false)

  const sealed = await context.service.sealProject('project-1', {
    metadata: PROBE_METADATA,
    captureOutcome: { video: true, audio: { system: true, microphone: false }, warnings: [] }
  })
  assert.equal(sealed.ok, true)
  assert.equal(sealed.project.state, 'ready')
  assert.equal(sealed.project.source.bytes, 2048)
  assert.equal(sealed.project.media.durationMs, 2010)
  assert.deepEqual(sealed.project.media.video, { width: 1280, height: 720 })
  assert.deepEqual(sealed.project.media.audio, { tracks: 1, codec: 'opus' })
  assert.equal(sealed.project.recovery.committedByteOffset, 2048)
  assert.equal(sealed.project.recovery.lastChunkSequence, 2)
  assert.equal(sealed.project.recovery.cleanStop, true)
  assert.equal(sealed.project.recovery.errorCode, '')
  assert.deepEqual(sealed.project.captureOutcome.audio, { system: true, microphone: false })

  const raw = await readManifest(context, 'project-1')
  assert.equal(raw.state, 'ready')
  assert.equal(raw.media.probedAt, context.clock.value)
})

test('sealProject reports a failed probe without throwing or losing the source', async (t) => {
  const context = await createContext(t)
  const { directory } = await context.service.createProject({ name: 'broken take' })
  const source = path.join(directory, 'capture.webm')
  await fs.writeFile(source, 'partial-media')

  const result = await context.service.sealProject('project-1', { metadata: null })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'probe-failed')
  assert.equal(result.project.state, 'recoverable')
  assert.equal(result.project.recovery.errorCode, 'probe-failed')
  assert.equal(result.project.recovery.cleanStop, true)
  assert.equal(result.project.source.bytes, 13)
  assert.equal(await fs.readFile(source, 'utf8'), 'partial-media')

  const stored = await context.service.getProject('project-1')
  assert.equal(stored.state, 'recoverable')
  assert.equal(stored.recovery.errorCode, 'probe-failed')
  assert.equal((await context.service.listProjects()).items[0].state, 'recoverable')
})

test('updateDraft is compare-and-set and cannot lose a newer revision', async (t) => {
  const context = await createContext(t)
  await context.service.createProject({})
  await context.service.sealProject('project-1', { metadata: PROBE_METADATA })

  const first = await context.service.updateDraft('project-1', {
    expectedRevision: 1,
    edit: {
      keepRanges: [{ id: 'keep-1', startMs: 100, endMs: 1500 }],
      format: 'gif',
      gif: { edge: 640, fps: 20 }
    }
  })
  assert.equal(first.ok, true)
  assert.equal(first.revision, 2)
  assert.equal(first.project.edit.format, 'gif')
  assert.deepEqual(first.project.edit.keepRanges, [{ id: 'keep-1', startMs: 100, endMs: 1500 }])

  const stale = await context.service.updateDraft('project-1', {
    expectedRevision: 1,
    edit: { format: 'mp4' }
  })
  assert.deepEqual(stale, { ok: false, code: 'revision-conflict', revision: 2 })
  assert.equal((await context.service.getProject('project-1')).edit.format, 'gif')

  // A partial draft keeps fields it did not send.
  const partial = await context.service.updateDraft('project-1', { expectedRevision: 2, edit: { format: 'mp4' } })
  assert.equal(partial.ok, true)
  assert.equal(partial.revision, 3)
  assert.equal(partial.project.edit.format, 'mp4')
  assert.deepEqual(partial.project.edit.keepRanges, [{ id: 'keep-1', startMs: 100, endMs: 1500 }])
  assert.deepEqual(partial.project.edit.gif, { edge: 640, fps: 20 })

  // A range outside the probed duration is dropped instead of corrupting the manifest.
  const outOfBounds = await context.service.updateDraft('project-1', {
    expectedRevision: 3,
    edit: { keepRanges: [{ id: 'keep-1', startMs: 0, endMs: 5000 }] }
  })
  assert.equal(outOfBounds.ok, true)
  assert.deepEqual(outOfBounds.project.edit.keepRanges, [])

  assert.deepEqual(await context.service.updateDraft('missing', { expectedRevision: 1, edit: {} }), { ok: false, code: 'not-found' })
  assert.deepEqual(await context.service.updateDraft('project-1', { expectedRevision: 'x', edit: {} }), { ok: false, code: 'invalid-expected-revision' })
})

test('concurrent updateDraft calls cannot both win the same revision', async (t) => {
  const context = await createContext(t)
  await context.service.createProject({})
  const results = await Promise.all([
    context.service.updateDraft('project-1', { expectedRevision: 1, edit: { format: 'gif' } }),
    context.service.updateDraft('project-1', { expectedRevision: 1, edit: { format: 'mp4' } })
  ])
  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.equal(results.filter((result) => result.code === 'revision-conflict').length, 1)
  assert.equal((await context.service.getProject('project-1')).edit.revision, 2)
})

test('renameProject enforces the 1-120 character name rule', async (t) => {
  const context = await createContext(t)
  await context.service.createProject({})
  const original = await context.service.getProject('project-1')
  context.advance(2500)

  const renamed = await context.service.renameProject('project-1', '  Renamed take  ')
  assert.equal(renamed.ok, true)
  assert.equal(renamed.project.name, 'Renamed take')
  assert.equal(renamed.project.updatedAt, original.updatedAt + 2500)
  assert.equal((await readManifest(context, 'project-1')).name, 'Renamed take')

  assert.deepEqual(await context.service.renameProject('project-1', '   '), { ok: false, code: 'invalid-name' })
  assert.deepEqual(await context.service.renameProject('project-1', 'x'.repeat(121)), { ok: false, code: 'invalid-name' })
  assert.deepEqual(await context.service.renameProject('missing', 'name'), { ok: false, code: 'not-found' })
})

test('appendExport keeps the main-process target path internal', async (t) => {
  const context = await createContext(t)
  await context.service.createProject({})
  const targetPath = path.join(context.parent, 'exports', 'Take 1.mp4')

  const appended = await context.service.appendExport('project-1', {
    exportId: 'task-9',
    format: 'mp4',
    fileName: 'Take 1.mp4',
    editRevision: 1,
    targetPath
  })
  assert.equal(appended.ok, true)
  assert.equal(appended.project.exports.length, 1)
  assert.equal(appended.project.exports[0].targetPath, targetPath)
  assert.equal(appended.project.exports[0].exportedAt, context.clock.value)

  const summary = context.service.summaryOf(appended.project)
  assert.equal(summary.exportCount, 1)
  assert.deepEqual(summary.lastExport, {
    format: 'mp4',
    fileName: 'Take 1.mp4',
    exportedAt: context.clock.value
  })

  const publicProject = context.service.publicProject(appended.project)
  assert.deepEqual(Object.keys(publicProject.exports[0]).sort(), [
    'editRevision',
    'exportId',
    'exportedAt',
    'fileName',
    'format'
  ])
  const serialized = JSON.stringify({ summary, publicProject })
  assert.equal(serialized.includes(context.root), false)
  assert.equal(serialized.includes('targetPath'), false)

  assert.deepEqual(await context.service.appendExport('project-1', { format: 'mp4' }), { ok: false, code: 'invalid-export' })
})

test('markRecoverable and markReady drive the recovery flow', async (t) => {
  const context = await createContext(t)
  const { directory } = await context.service.createProject({ name: 'to recover' })
  await fs.writeFile(path.join(directory, 'capture.webm'), 'damaged-tail')

  const recovered = await context.service.markRecoverable('project-1', 'interrupted')
  assert.equal(recovered.ok, true)
  assert.equal(recovered.project.state, 'recoverable')
  assert.equal(recovered.project.recovery.errorCode, 'interrupted')

  const blankCode = await context.service.markRecoverable('project-1', '')
  assert.equal(blankCode.project.recovery.errorCode, 'interrupted')

  // Recovery repairs a new file next to the original; the original is never removed.
  await fs.writeFile(path.join(directory, 'capture.repaired.webm'), 'repaired-media')
  const ready = await context.service.markReady('project-1', {
    fileName: 'capture.repaired.webm',
    metadata: PROBE_METADATA
  })
  assert.equal(ready.ok, true)
  assert.equal(ready.project.state, 'ready')
  assert.equal(ready.project.source.fileName, 'capture.repaired.webm')
  assert.equal(ready.project.source.bytes, 14)
  assert.equal(ready.project.media.durationMs, 2010)
  assert.equal(ready.project.recovery.errorCode, '')
  assert.equal(ready.project.recovery.cleanStop, true)
  assert.equal(await exists(path.join(directory, 'capture.webm')), true)
  assert.equal(await exists(path.join(directory, 'capture.repaired.webm')), true)

  // A traversal-shaped file name is ignored, not repaired into another path.
  const traversal = await context.service.markReady('project-1', { fileName: '../../escape.webm' })
  assert.equal(traversal.project.source.fileName, 'capture.repaired.webm')

  assert.deepEqual(await context.service.markReady('missing', { fileName: 'x.webm' }), { ok: false, code: 'not-found' })
})

test('deleteProject removes the directory, is idempotent, and never escapes its root', async (t) => {
  const context = await createContext(t)
  const { directory } = await context.service.createProject({})
  await fs.writeFile(path.join(directory, 'capture.webm'), 'media')
  const keepPath = path.join(context.root, 'keep.txt')
  await fs.mkdir(context.root, { recursive: true })
  await fs.writeFile(keepPath, 'keep')

  assert.deepEqual(await context.service.deleteProject('project-1'), { ok: true })
  assert.equal(await exists(directory), false)
  assert.equal(await context.service.getProject('project-1'), null)
  assert.deepEqual(await context.service.deleteProject('project-1'), { ok: true })
  assert.equal(await fs.readFile(keepPath, 'utf8'), 'keep')

  // A path-shaped id is rejected before any filesystem call.
  assert.deepEqual(await context.service.deleteProject('../../keep'), { ok: false, code: 'invalid-id' })
  assert.equal(await fs.readFile(keepPath, 'utf8'), 'keep')
})

test('damaged manifests read as null and a hand-edited id is pinned to the directory', async (t) => {
  const context = await createContext(t)
  const { directory } = await context.service.createProject({})
  const manifestPath = path.join(directory, 'project.json')

  await fs.writeFile(manifestPath, '{invalid json')
  assert.equal(await context.service.getProject('project-1'), null)
  assert.equal(await context.service.readProjectFile('project-1'), null)
  assert.deepEqual(await context.service.listProjects(), { items: [], total: 0, offset: 0, limit: 20 })

  // Rebuild a manifest that is valid except for its id: the directory name wins.
  await fs.writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    id: 'some-other-project',
    createdAt: 1,
    updatedAt: 2,
    name: 'hand edited',
    mode: 'display',
    state: 'ready',
    source: { fileName: 'capture.webm' },
    media: {},
    edit: { revision: 1, keepRanges: [] },
    exports: [],
    recovery: { committedByteOffset: 0, lastChunkSequence: 0, cleanStop: true, errorCode: '' }
  }))
  assert.equal((await context.service.getProject('project-1')).id, 'project-1')
  assert.equal((await readManifest(context, 'project-1')).id, 'some-other-project')

  // Non-object JSON is damage, not a project.
  await fs.writeFile(manifestPath, '[1,2,3]')
  assert.equal(await context.service.getProject('project-1'), null)
})

test('sourcePathOf resolves inside the project directory and after a recovery rename', async (t) => {
  const context = await createContext(t)
  const { directory } = await context.service.createProject({})
  assert.equal(await context.service.sourcePathOf('project-1'), path.join(directory, 'capture.webm'))
  assert.equal(await context.service.sourcePathOf('missing'), '')
  assert.equal(await context.service.sourcePathOf('../escape'), '')
  assert.equal(context.service.projectDirectory('../escape'), '')

  await fs.writeFile(path.join(directory, 'capture.repaired.webm'), 'x')
  await context.service.markReady('project-1', { fileName: 'capture.repaired.webm', metadata: PROBE_METADATA })
  assert.equal(await context.service.sourcePathOf('project-1'), path.join(directory, 'capture.repaired.webm'))
})

test('projects survive a service restart and list as ready after sealing', async (t) => {
  const context = await createContext(t)
  const { directory } = await context.service.createProject({ name: 'kept' })
  await fs.writeFile(path.join(directory, 'capture.webm'), 'media')
  await context.service.sealProject('project-1', { metadata: PROBE_METADATA })
  await context.service.checkpoint('project-1', { committedByteOffset: 5, lastChunkSequence: 1 })
  await context.service.dispose()

  const restarted = createRecordingProjectService({
    root: context.root,
    now: () => context.clock.value,
    createId: () => 'project-2',
    timers: { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} }
  })
  t.after(() => restarted.dispose())
  const project = await restarted.getProject('project-1')
  assert.equal(project.state, 'ready')
  assert.equal(project.name, 'kept')
  assert.equal(project.media.durationMs, 2010)
  assert.equal(await restarted.sourcePathOf('project-1'), path.join(directory, 'capture.webm'))
  const listing = await restarted.listProjects()
  assert.deepEqual(listing.items.map((item) => item.id), ['project-1'])
  assert.equal(listing.items[0].state, 'ready')
  assert.equal(await exists(path.join(directory, 'capture.webm')), true)
})

test('checkpoint state for an unknown project is harmless', async (t) => {
  const context = await createContext(t)
  assert.equal(await context.service.checkpoint('missing', { committedByteOffset: 10, lastChunkSequence: 1 }), false)
  await context.service.dispose()
  assert.equal(await context.service.checkpoint('../escape', { committedByteOffset: 10, lastChunkSequence: 1 }), false)
})

test('a concurrent checkpoint cannot overwrite a draft revision', async (t) => {
  const context = await createContext(t)
  await context.service.createProject({})
  await context.service.sealProject('project-1', { metadata: PROBE_METADATA })
  context.advance(2000)

  // Both manifests mutations are read-modify-write; the per-project lock must merge
  // them instead of letting the later writer restore the other's stale fields.
  const [draft, wroteCheckpoint] = await Promise.all([
    context.service.updateDraft('project-1', { expectedRevision: 1, edit: { format: 'gif' } }),
    context.service.checkpoint('project-1', { committedByteOffset: 4096, lastChunkSequence: 3 })
  ])
  assert.equal(draft.ok, true)
  assert.equal(draft.revision, 2)
  assert.equal(wroteCheckpoint, true)

  const project = await context.service.getProject('project-1')
  assert.equal(project.edit.revision, 2)
  assert.equal(project.edit.format, 'gif')
  assert.equal(project.recovery.committedByteOffset, 4096)
  assert.equal(project.recovery.lastChunkSequence, 3)
})
