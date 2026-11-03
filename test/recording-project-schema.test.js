'use strict'

// Behaviour tests for the frozen recording-project schema (contract §7).
// The schema is a pure module: no fs, no clock, no Electron - so these tests are
// value-level and need nothing from the environment.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const schema = require('../shared/recording-project-schema')
const recordingQuality = require('../shared/recording-quality')

// An absolute root that must never appear in a public projection. The manifest keeps
// it only in the export targetPath (main-process-only field).
const PROJECT_ROOT = path.resolve('D:/workspace/Highlighter-data/recordings')
const PROJECT_DIRECTORY = path.join(PROJECT_ROOT, '11111111-2222-3333-4444-555555555555')

function fixture(overrides = {}) {
  return {
    schemaVersion: 1,
    id: '11111111-2222-3333-4444-555555555555',
    createdAt: 1_762_000_000_000,
    updatedAt: 1_762_000_001_000,
    name: 'ScreenRecording_2026-11-03_17-00-00',
    mode: 'display',
    state: 'ready',
    captureConfig: {
      target: {
        mode: 'display',
        displayId: '2528732444',
        displayName: 'DISPLAY2',
        boundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
        pixelSize: { width: 1920, height: 1080 },
        scaleFactor: 1
      },
      frameRate: 30,
      quality: 'standard',
      countdown: 3,
      audio: {
        system: true,
        microphone: false,
        microphoneDeviceId: '',
        systemGain: 1,
        microphoneGain: 1
      }
    },
    source: {
      assetId: 'capture',
      fileName: 'capture.webm',
      mediaKind: 'video',
      mimeType: 'video/webm',
      bytes: 1234
    },
    media: {
      durationMs: 2010,
      video: { width: 1920, height: 1080 },
      audio: { tracks: 1, codec: 'opus' },
      timebase: 1000,
      probedAt: 1_762_000_001_000
    },
    captureOutcome: { video: true, audio: { system: true, microphone: false }, warnings: [] },
    edit: {
      revision: 2,
      keepRanges: [{ id: 'keep-1', startMs: 100, endMs: 1500 }],
      format: 'mp4',
      gif: { edge: 1280, fps: 15 }
    },
    exports: [{
      exportId: 'task-1',
      format: 'mp4',
      fileName: 'out.mp4',
      exportedAt: 1_762_000_002_000,
      editRevision: 2,
      targetPath: path.join(PROJECT_DIRECTORY, 'out.mp4')
    }],
    recovery: {
      committedByteOffset: 1234,
      lastChunkSequence: 2,
      cleanStop: true,
      errorCode: ''
    },
    ...overrides
  }
}

test('exports the frozen schema constants', () => {
  assert.equal(schema.SCHEMA_VERSION, 1)
  assert.equal(schema.PROJECT_FILE_NAME, 'project.json')
  assert.equal(schema.SOURCE_FILE_NAME, 'capture.webm')
  assert.deepEqual([...schema.PROJECT_MODES], ['display', 'region', 'window'])
  assert.deepEqual([...schema.PROJECT_STATES], ['capturing', 'ready', 'recoverable', 'deleting', 'deleted'])
  assert.deepEqual([...schema.EXPORT_FORMATS], ['mp4', 'gif', 'webm'])
  assert.equal(schema.NAME_MAX_LENGTH, 120)
})

test('quality/countdown enums match shared/recording-quality.js', () => {
  // The schema duplicates the quality enum to stay a dependency-free classic script;
  // this assertion is the contract that the two copies cannot drift.
  assert.deepEqual([...schema.QUALITY_LEVELS], [...recordingQuality.QUALITY_LEVELS])
  assert.deepEqual([...schema.COUNTDOWN_OPTIONS], [...recordingQuality.COUNTDOWN_OPTIONS])
  assert.equal(schema.DEFAULT_QUALITY, recordingQuality.DEFAULT_QUALITY)
  assert.equal(schema.DEFAULT_COUNTDOWN, recordingQuality.DEFAULT_COUNTDOWN)
})

test('normalizes the frozen manifest example without changing legal values', () => {
  const project = schema.normalizeProject(fixture())

  assert.equal(project.schemaVersion, 1)
  assert.equal(project.id, fixture().id)
  assert.equal(project.state, 'ready')
  assert.equal(project.mode, 'display')
  assert.equal(project.name, 'ScreenRecording_2026-11-03_17-00-00')
  assert.equal(project.source.fileName, 'capture.webm')
  assert.equal(project.media.durationMs, 2010)
  assert.equal(project.captureConfig.frameRate, 30)
  assert.equal(project.edit.revision, 2)
  assert.deepEqual(project.edit.keepRanges, [{ id: 'keep-1', startMs: 100, endMs: 1500 }])
  assert.equal(project.exports.length, 1)
  // The internal-only target path survives normalization ...
  assert.equal(project.exports[0].targetPath, fixture().exports[0].targetPath)
  // ... and normalization is idempotent.
  assert.deepEqual(schema.normalizeProject(project), project)
})

test('window mode (R4) round-trips while old display/region manifests stay valid', () => {
  // The record domain passes mode:'window' for a window capture (§2.2); the schema must keep it.
  const windowProject = schema.normalizeProject(fixture({
    mode: 'window',
    captureConfig: {
      target: { mode: 'window', displayId: '', displayName: 'Visual Studio Code', boundsDip: {}, pixelSize: {}, scaleFactor: 1 },
      frameRate: 30,
      quality: 'standard',
      countdown: 3,
      audio: { system: true, microphone: false, microphoneDeviceId: '', systemGain: 1, microphoneGain: 1 }
    }
  }))
  assert.equal(windowProject.mode, 'window')
  assert.equal(windowProject.captureConfig.target.mode, 'window')
  assert.equal(schema.projectSummary(windowProject).mode, 'window')
  assert.deepEqual(schema.validateProject(fixture({ mode: 'window' })), { ok: true, errors: [] })
  // R1-R3 manifests are untouched by the additive enum member.
  for (const mode of ['display', 'region']) {
    assert.equal(schema.normalizeProject(fixture({ mode })).mode, mode)
    assert.deepEqual(schema.validateProject(fixture({ mode })), { ok: true, errors: [] })
  }
  // An unknown mode still falls back to 'display' instead of being persisted.
  assert.equal(schema.normalizeProject(fixture({ mode: 'camera' })).mode, 'display')
})

test('normalization never throws and repairs junk manifests into safe defaults', () => {
  for (const input of [null, undefined, 42, 'x', [], {}]) {
    const project = schema.normalizeProject(input)
    assert.equal(project.schemaVersion, 1)
    assert.equal(project.id, '')
    assert.equal(project.name, schema.DEFAULT_PROJECT_NAME)
    assert.equal(project.mode, 'display')
    // An unreadable state must never be claimed as `ready`.
    assert.equal(project.state, 'recoverable')
    assert.equal(project.source.fileName, schema.SOURCE_FILE_NAME)
    assert.deepEqual(project.edit.keepRanges, [])
    assert.deepEqual(project.exports, [])
    assert.equal(project.recovery.cleanStop, false)
  }
})

test('normalization applies enums, limits and integer rules', () => {
  const project = schema.normalizeProject(fixture({
    state: 'exploded',
    mode: 'camera',
    name: `  ${'n'.repeat(200)}  `,
    captureConfig: { frameRate: 999, quality: 'cinema', countdown: 7 },
    media: { durationMs: -4.6, video: { width: -1, height: 10.4 }, audio: { tracks: 99 } },
    recovery: { committedByteOffset: -3, lastChunkSequence: -1, cleanStop: 'yes', errorCode: 'bad code!' }
  }))

  assert.equal(project.state, 'recoverable')
  assert.equal(project.mode, 'display')
  assert.equal(project.name.length, schema.NAME_MAX_LENGTH)
  assert.equal(project.captureConfig.frameRate, 30)
  assert.equal(project.captureConfig.quality, 'standard')
  assert.equal(project.captureConfig.countdown, 3)
  assert.equal(project.media.durationMs, 0)
  assert.equal(project.media.video.width, 0)
  assert.equal(project.media.video.height, 10)
  assert.equal(project.recovery.committedByteOffset, 0)
  assert.equal(project.recovery.lastChunkSequence, 0)
  assert.equal(project.recovery.cleanStop, false)
  assert.equal(project.recovery.errorCode, 'badcode')
})

test('source.fileName only ever holds one relative file name', () => {
  const rejected = [
    '../escape.webm',
    '..\\escape.webm',
    'C:\\Users\\me\\capture.webm',
    '/tmp/capture.webm',
    'sub/capture.webm',
    '.hidden.webm',
    '',
    '   '
  ]
  for (const fileName of rejected) {
    assert.equal(schema.normalizeProject(fixture({ source: { fileName } })).source.fileName, 'capture.webm', fileName)
  }
  assert.equal(schema.normalizeProject(fixture({ source: { fileName: 'capture.repaired.webm' } })).source.fileName, 'capture.repaired.webm')
  assert.equal(schema.normalizeFileName('a.mp4', ''), 'a.mp4')
  assert.equal(schema.normalizeFileName(null, 'fallback.webm'), 'fallback.webm')
})

test('keep ranges are sorted, non-overlapping, half-open and duration-bounded', () => {
  assert.deepEqual(schema.normalizeKeepRanges([], 2010), [])

  const normalized = schema.normalizeKeepRanges([
    { id: 'b', startMs: 500, endMs: 900 },
    { id: 'a', startMs: 100, endMs: 400 },
    { id: 'overlap', startMs: 300, endMs: 600 },
    { id: 'inverted', startMs: 900, endMs: 900 },
    { id: 'outside', startMs: 1800, endMs: 2500 }
  ], 2010)
  assert.deepEqual(normalized, [
    { id: 'a', startMs: 100, endMs: 400 },
    { id: 'b', startMs: 500, endMs: 900 }
  ])

  // Without a known duration only structural legality is enforced (no upper bound).
  assert.deepEqual(schema.normalizeKeepRanges([{ startMs: 0, endMs: 99_999 }], 0), [
    { id: 'keep-1', startMs: 0, endMs: 99_999 }
  ])
  // Fractional milliseconds are rounded; non-object entries are dropped.
  assert.deepEqual(schema.normalizeKeepRanges([null, { startMs: 10.6, endMs: 20.2 }], 0), [
    { id: 'keep-1', startMs: 11, endMs: 20 }
  ])
})

test('mediaFromMetadata converts a real probe result and rejects a failed probe', () => {
  const media = schema.mediaFromMetadata({
    durationMs: 2010.4,
    video: { width: 1920, height: 1080, frameRate: 30 },
    audio: { exists: true, codec: 'opus' }
  }, 1234)
  assert.deepEqual(media, {
    durationMs: 2010,
    video: { width: 1920, height: 1080 },
    audio: { tracks: 1, codec: 'opus' },
    timebase: 1000,
    probedAt: 1234
  })

  assert.equal(schema.mediaFromMetadata(null, 1234), null)
  assert.equal(schema.mediaFromMetadata({ durationMs: 0 }, 1234), null)
  assert.equal(schema.mediaFromMetadata({ durationMs: -5 }, 1234), null)
  assert.equal(schema.mediaFromMetadata({ durationMs: 500, audio: { exists: false } }, 1).audio.tracks, 0)
})

test('normalizeEdit clamps gif/format options and preserves partial drafts', () => {
  // R4: 'webm' is a legal edit/export format now (additive enum member, no schema bump).
  const webm = schema.normalizeEdit({
    revision: 7,
    keepRanges: [],
    format: 'webm',
    gif: { edge: 9000, fps: 13 }
  }, 1000)
  assert.equal(webm.revision, 7)
  assert.equal(webm.format, 'webm')
  assert.equal(webm.gif.edge, 1280)
  assert.equal(webm.gif.fps, 15)

  // An unknown format is still clamped to the safe default instead of being persisted.
  const unknown = schema.normalizeEdit({ revision: 8, format: 'avi' }, 0)
  assert.equal(unknown.format, 'mp4')

  const second = schema.normalizeEdit({ revision: 9, format: 'gif', gif: { edge: 640, fps: 20 } }, 0)
  assert.equal(second.format, 'gif')
  assert.equal(second.gif.edge, 640)
  assert.equal(second.gif.fps, 20)
})

test('ProjectSummary is path-free and carries the list fields', () => {
  const summary = schema.projectSummary(fixture())
  assert.deepEqual(Object.keys(summary).sort(), [
    'audio',
    'bytes',
    'createdAt',
    'durationMs',
    'exportCount',
    'frameRate',
    'hasAudio',
    'height',
    'id',
    'lastExport',
    'mode',
    'name',
    'quality',
    'state',
    'thumbnail',
    'updatedAt',
    'width'
  ])
  assert.equal(summary.durationMs, 2010)
  assert.equal(summary.width, 1920)
  assert.equal(summary.height, 1080)
  assert.equal(summary.bytes, 1234)
  assert.equal(summary.hasAudio, true)
  assert.deepEqual(summary.audio, { system: true, microphone: false })
  assert.equal(summary.exportCount, 1)
  assert.deepEqual(summary.lastExport, { format: 'mp4', fileName: 'out.mp4', exportedAt: 1_762_000_002_000 })
  assert.equal(summary.thumbnail, false)

  const serialized = JSON.stringify(summary)
  assert.equal(serialized.includes(PROJECT_ROOT), false)
  assert.equal(serialized.includes('targetPath'), false)
  assert.equal(serialized.includes('capture.webm'), false)
  // A bare export file name is allowed (it is a name, not a path); a directory is not.
  assert.equal(serialized.includes('out.mp4'), true)
})

test('ProjectPublic exposes editor data but never a path', () => {
  const project = schema.projectPublic(fixture())
  assert.equal(project.schemaVersion, 1)
  assert.deepEqual(Object.keys(project.source).sort(), ['bytes', 'mediaKind', 'mimeType'])
  assert.deepEqual(project.media.video, { width: 1920, height: 1080 })
  assert.equal(project.edit.revision, 2)
  assert.deepEqual(project.recovery, { cleanStop: true, errorCode: '' })
  assert.deepEqual(Object.keys(project.exports[0]).sort(), [
    'editRevision',
    'exportId',
    'exportedAt',
    'fileName',
    'format'
  ])
  assert.equal(project.lastExport.format, 'mp4')

  const serialized = JSON.stringify(project)
  assert.equal(serialized.includes(PROJECT_ROOT), false)
  assert.equal(serialized.includes(PROJECT_DIRECTORY), false)
  assert.equal(serialized.includes('targetPath'), false)
  // Drive-letter style absolute paths would also have to include a separator; the
  // public captureConfig/display fields are ids and names, not paths.
  assert.equal(serialized.includes('\\\\'), false)
  assert.equal(serialized.includes('/workspace/'), false)
})

test('validateProject reports structural problems it will not repair silently', () => {
  assert.deepEqual(schema.validateProject(fixture()), { ok: true, errors: [] })
  const webmRecord = fixture({ exports: [{ exportId: 'task-webm-1', format: 'webm', fileName: 'out.webm', exportedAt: 1, editRevision: 2 }] })
  assert.deepEqual(schema.validateProject(webmRecord), { ok: true, errors: [] })
  assert.equal(schema.projectSummary(webmRecord).lastExport.format, 'webm')
  assert.equal(schema.projectPublic(webmRecord).exports[0].format, 'webm')
  assert.equal(schema.validateProject(null).ok, false)

  const cases = [
    [{ schemaVersion: 2 }, 'unsupported-schema-version'],
    [{ id: '../../escape' }, 'invalid-id'],
    [{ mode: 'camera' }, 'invalid-mode'],
    [{ state: 'exploded' }, 'invalid-state'],
    [{ name: '' }, 'invalid-name'],
    [{ source: { fileName: 'sub/capture.webm' } }, 'invalid-source-file-name'],
    [{ media: { durationMs: 1.5 } }, 'invalid-media-duration'],
    [{ edit: { revision: 0, keepRanges: [] } }, 'invalid-edit-revision'],
    [{ edit: { revision: 1, keepRanges: [{ startMs: 10, endMs: 5 }] } }, 'invalid-keep-range'],
    [{ edit: { revision: 1, keepRanges: [{ startMs: 0, endMs: 9999 }] } }, 'keep-range-out-of-bounds'],
    [{ exports: [{ exportId: 't1', format: 'avi' }] }, 'invalid-export-format'],
    [{ recovery: { committedByteOffset: 0, lastChunkSequence: 0, cleanStop: 'yes' } }, 'invalid-clean-stop']
  ]
  for (const [patch, expected] of cases) {
    const result = schema.validateProject(fixture(patch))
    assert.equal(result.ok, false, expected)
    assert.ok(result.errors.includes(expected), `${expected} not in ${result.errors.join(', ')}`)
  }
})

test('project ids cannot escape their directory', () => {
  for (const id of ['11111111-2222-3333-4444-555555555555', 'project-1', 'A_b-9']) {
    assert.equal(schema.isValidProjectId(id), true, id)
  }
  for (const id of ['', '../escape', '..', 'a/b', 'a\\b', '.hidden', 'a b', 'x'.repeat(129), null, 42]) {
    assert.equal(schema.isValidProjectId(id), false, String(id))
  }
})

test('the module loads as a classic browser script and installs one global', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'recording-project-schema.js'), 'utf8')
  const sandbox = { globalThis: null }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox)
  assert.equal(typeof sandbox.recordingProjectSchema, 'object')
  assert.equal(typeof sandbox.recordingProjectSchema.normalizeProject, 'function')
  assert.equal(sandbox.recordingProjectSchema.SCHEMA_VERSION, 1)
  const browserSummary = sandbox.recordingProjectSchema.projectSummary(fixture())
  assert.equal(browserSummary.durationMs, 2010)
})
