#!/usr/bin/env node
'use strict'

// R0-02 cross-language fixture generator.
//
// Every fixture is produced by CALLING the current JavaScript implementation with
// synthetic, fixed inputs (no user data, no machine paths, no clock, no randomness):
//   * capture-document      -> shared/capture-document.js (+ output style geometry)
//   * recording-project     -> shared/recording-project-schema.js
//   * clipboard-protocol    -> shared/clipboard-protocol.js (encode + decode)
//   * recording-export-options -> shared/recording-export-options.js
//   * settings              -> main/services/settings-normalize.js + settings-defaults
//
// The Rust side reads these files; it never gets a second hand-written copy of the
// expected values. The manifest records one sha256 per case file.
//
// Usage:
//   node scripts/rust/generate-host-fixtures.js --write
//   node scripts/rust/generate-host-fixtures.js --check
//
// Output contract: UTF-8, LF, two-space indentation, insertion-order keys, arrays
// sorted by a stable key, one trailing newline. --check compares every byte and
// reports both stale content and extra files, exiting nonzero on any mismatch.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '..', '..')
const FIXTURES_REL = 'test/fixtures/host-parity'
const FIXTURES_DIR = path.join(ROOT, ...FIXTURES_REL.split('/'))
const MANIFEST_REL = `${FIXTURES_REL}/manifest.json`
const MANIFEST_PATH = path.join(ROOT, ...MANIFEST_REL.split('/'))
const FIXTURES_SCHEMA_VERSION = 1

const FIXED_EPOCH_MS = 1731000000000 // 2024-11-07T18:40:00.000Z, a fixed synthetic instant
const FIXED_DOCUMENT_ID = 'fixture-doc-001'
const FIXED_REVISION_ID = 'fixture-rev-001'
const FIXED_ASSET_ID = 'fixture-asset-001'
const FIXED_PROJECT_ID = 'fixture-project-001'

function absolute(relativePath) {
  return path.join(ROOT, ...relativePath.split('/'))
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function caseShell(format, caseId, source, expect) {
  return {
    schemaVersion: FIXTURES_SCHEMA_VERSION,
    caseId,
    format,
    source: [...source],
    expect
  }
}

function base64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

// ---------------------------------------------------------------------------
// capture-document (format capture-document.v3)
// ---------------------------------------------------------------------------

function captureDocumentCases() {
  const document = require(absolute('shared/capture-document.js'))
  const outputStyle = require(absolute('shared/capture-output-style.js'))
  const format = 'capture-document.v3'
  const source = [
    'shared/capture-document.js',
    'shared/capture-output-style.js',
    'shared/magnifier-geometry.js'
  ]

  function makeDocument({ documentId, revisionId, annotations, style }) {
    return document.normalizeDocument({
      schemaVersion: 3,
      documentId,
      revisionId,
      baseImage: { assetId: FIXED_ASSET_ID, width: 800, height: 600 },
      crop: { x: 0, y: 0, w: 800, h: 600 },
      annotations,
      captureAttachments: {
        cursor: {
          assetId: 'fixture-cursor-001',
          x: 120,
          y: 140,
          width: 24,
          height: 24,
          hotspot: { x: 3, y: 3 }
        }
      },
      captureMetadata: { sourceScaleFactor: 1.25, longCapture: false },
      view: { zoomMultiplier: 1.25, centerX: 400, centerY: 300 },
      source: 'region',
      createdAt: FIXED_EPOCH_MS,
      outputStyle: style
    })
  }

  function invariantsFor(fixtureDocument, extra) {
    const geometry = document.resolveOutputGeometry(fixtureDocument)
    return {
      schemaVersion: fixtureDocument.schemaVersion,
      documentId: fixtureDocument.documentId,
      // Fixture-local revision ordinal. The schema stores `revisionId`; `revision` is
      // the 1-based fixture revision the plan §3 example names.
      revision: 1,
      revisionId: fixtureDocument.revisionId,
      sourceWidth: fixtureDocument.baseImage.width,
      sourceHeight: fixtureDocument.baseImage.height,
      outputWidth: geometry.width,
      outputHeight: geometry.height,
      contentFingerprint: document.documentFingerprint(fixtureDocument),
      ...extra
    }
  }

  const annotated = [
    { type: 'rect', x: 80, y: 90, w: 200, h: 120, color: '#ff3b30', width: 3, fill: 'none', dash: 'solid' },
    { type: 'arrow', x: 120, y: 160, x2: 300, y2: 240, color: '#007aff', width: 3, startHead: false, endHead: true },
    { type: 'text', x: 90, y: 260, text: 'Fixture annotation', color: '#111111', width: 3, fontSize: 24 },
    { type: 'serial', x: 140, y: 320, number: 7, color: '#ff9500', width: 2 },
    {
      type: 'blur',
      x: 400,
      y: 120,
      w: 180,
      h: 140,
      points: [{ x: 400, y: 120 }, { x: 580, y: 260 }],
      color: '#000000',
      width: 4,
      blurGeometry: 'rect',
      alpha: 'medium'
    },
    {
      type: 'magnifier',
      id: 'fixture-magnifier-001',
      color: '#ffffff',
      width: 2,
      sourceRect: { x: 440, y: 300, w: 160, h: 120 },
      lensOrigin: { x: 500, y: 180 },
      factor: 3
    }
  ]

  const plain = makeDocument({
    documentId: FIXED_DOCUMENT_ID,
    revisionId: FIXED_REVISION_ID,
    annotations: annotated,
    style: undefined
  })
  const plainValidation = document.validateDocument(plain)
  if (!plainValidation.ok) throw new Error(`capture-document fixture is invalid: ${JSON.stringify(plainValidation.errors)}`)

  const card = makeDocument({
    documentId: 'fixture-doc-002',
    revisionId: 'fixture-rev-002',
    annotations: annotated.slice(0, 1),
    style: outputStyle.presetStyle('card-light')
  })
  const cardValidation = document.validateDocument(card)
  if (!cardValidation.ok) throw new Error(`capture-document card fixture is invalid: ${JSON.stringify(cardValidation.errors)}`)

  const rawV2 = JSON.parse(JSON.stringify(plain))
  rawV2.schemaVersion = 2
  rawV2.annotations = rawV2.annotations.filter((annotation) => annotation.type !== 'magnifier')
  const upgraded = document.parseDocument(JSON.stringify(rawV2))
  if (!upgraded.ok || upgraded.migratedFrom !== 2) {
    throw new Error(`v2 -> v3 migration fixture failed: ${JSON.stringify(upgraded)}`)
  }

  const missingBaseImage = JSON.parse(JSON.stringify(plain))
  delete missingBaseImage.baseImage
  const invalidIdentity = document.parseDocument(JSON.stringify(missingBaseImage))
  if (invalidIdentity.ok) throw new Error('missing baseImage fixture unexpectedly parsed')
  const unknownVersion = document.parseDocument(JSON.stringify({ schemaVersion: 99, documentId: FIXED_DOCUMENT_ID }))
  if (unknownVersion.ok) throw new Error('unknown schemaVersion fixture unexpectedly parsed')

  return [
    {
      id: 'invalid-missing-base-image',
      case: {
        ...caseShell(format, 'capture-document/invalid-missing-base-image', source, 'invalid'),
        input: missingBaseImage,
        reason: invalidIdentity.code,
        errors: invalidIdentity.errors.map((error) => error.code)
      }
    },
    {
      id: 'invalid-unknown-version',
      case: {
        ...caseShell(format, 'capture-document/invalid-unknown-version', source, 'invalid'),
        input: { schemaVersion: 99, documentId: FIXED_DOCUMENT_ID },
        reason: unknownVersion.code,
        errors: unknownVersion.errors.map((error) => error.code)
      }
    },
    {
      id: 'v2-upgraded',
      case: {
        ...caseShell(format, 'capture-document/v2-upgraded', source, 'valid'),
        input: rawV2,
        document: upgraded.document,
        invariants: invariantsFor(upgraded.document, { migratedFrom: upgraded.migratedFrom })
      }
    },
    {
      id: 'v3-card-light',
      case: {
        ...caseShell(format, 'capture-document/v3-card-light', source, 'valid'),
        document: card,
        invariants: invariantsFor(card, { outputStyle: 'card-light' })
      }
    },
    {
      id: 'v3-plain',
      case: {
        ...caseShell(format, 'capture-document/v3-plain', source, 'valid'),
        document: plain,
        invariants: invariantsFor(plain, { outputStyle: 'original' })
      }
    }
  ]
}

// ---------------------------------------------------------------------------
// recording-project (format recording-project.v1)
// ---------------------------------------------------------------------------

function recordingProjectCases() {
  const schema = require(absolute('shared/recording-project-schema.js'))
  const format = 'recording-project.v1'
  const source = ['shared/recording-project-schema.js']

  function baseProject() {
    return {
      schemaVersion: 1,
      id: FIXED_PROJECT_ID,
      createdAt: FIXED_EPOCH_MS,
      updatedAt: FIXED_EPOCH_MS + 10000,
      name: 'Fixture Recording 001',
      mode: 'display',
      state: 'ready',
      captureConfig: {
        target: {
          mode: 'display',
          displayId: 'fixture-display-001',
          displayName: 'Fixture Display',
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
        assetId: 'fixture-capture-001',
        fileName: 'capture.webm',
        mediaKind: 'video',
        mimeType: 'video/webm',
        bytes: 4096
      },
      media: {
        durationMs: 5000,
        video: { width: 1920, height: 1080 },
        audio: { tracks: 1, codec: 'opus' },
        timebase: 1000,
        probedAt: FIXED_EPOCH_MS
      },
      captureOutcome: {
        video: true,
        audio: { system: true, microphone: false },
        warnings: []
      },
      edit: {
        revision: 3,
        keepRanges: [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 2500 }],
        format: 'mp4',
        gif: { edge: 1280, fps: 15 },
        zoomSegments: [],
        audioGainSegments: []
      },
      exports: [],
      recovery: {
        committedByteOffset: 4096,
        lastChunkSequence: 8,
        cleanStop: true,
        errorCode: ''
      }
    }
  }

  function invariantsFor(project, keepRanges) {
    return {
      schemaVersion: project.schemaVersion,
      projectId: project.id,
      keepRanges: keepRanges.map((range) => [range.startMs, range.endMs])
    }
  }

  const fullRaw = baseProject()
  const full = schema.normalizeProject(fullRaw)
  const fullValidation = schema.validateProject(full)
  if (!fullValidation.ok) throw new Error(`recording-project fixture is invalid: ${JSON.stringify(fullValidation.errors)}`)

  const emptyRaw = baseProject()
  emptyRaw.edit.keepRanges = []
  const empty = schema.normalizeProject(emptyRaw)
  const emptyValidation = schema.validateProject(empty)
  if (!emptyValidation.ok) throw new Error(`empty keepRanges fixture is invalid: ${JSON.stringify(emptyValidation.errors)}`)

  const overlappingRaw = baseProject()
  overlappingRaw.edit.keepRanges = [{ startMs: 0, endMs: 2000 }, { startMs: 1000, endMs: 2500 }]
  const overlapping = schema.validateProject(overlappingRaw)
  if (overlapping.ok) throw new Error('overlapping keepRanges fixture unexpectedly validated')

  const schemaAndSourceRaw = baseProject()
  schemaAndSourceRaw.schemaVersion = 2
  schemaAndSourceRaw.source = {}
  const schemaAndSource = schema.validateProject(schemaAndSourceRaw)
  if (schemaAndSource.ok) throw new Error('invalid schema/source fixture unexpectedly validated')

  return [
    {
      id: 'invalid-overlapping-ranges',
      case: {
        ...caseShell(format, 'recording-project/invalid-overlapping-ranges', source, 'invalid'),
        project: overlappingRaw,
        reason: 'invalid-project',
        errors: overlapping.errors
      }
    },
    {
      id: 'invalid-schema-and-source',
      case: {
        ...caseShell(format, 'recording-project/invalid-schema-and-source', source, 'invalid'),
        project: schemaAndSourceRaw,
        reason: 'invalid-project',
        errors: schemaAndSource.errors
      }
    },
    {
      id: 'valid-empty-keep-ranges',
      case: {
        ...caseShell(format, 'recording-project/valid-empty-keep-ranges', source, 'valid'),
        project: empty,
        invariants: invariantsFor(empty, empty.edit.keepRanges)
      }
    },
    {
      id: 'valid-full',
      case: {
        ...caseShell(format, 'recording-project/valid-full', source, 'valid'),
        project: full,
        invariants: invariantsFor(full, full.edit.keepRanges)
      }
    }
  ]
}

// ---------------------------------------------------------------------------
// clipboard-protocol (format clipboard-protocol.v1)
// ---------------------------------------------------------------------------

function clipboardProtocolCases() {
  const protocol = require(absolute('shared/clipboard-protocol.js'))
  const format = 'clipboard-protocol.v1'
  const source = ['shared/clipboard-protocol.js']

  function decodeChunks(chunks) {
    const decoder = new protocol.FrameDecoder()
    const frames = []
    for (const chunk of chunks) frames.push(...decoder.feed(chunk))
    decoder.finish()
    return frames
  }

  function expectedFramesOf(frames) {
    return frames.map((frame) => ({
      header: JSON.parse(JSON.stringify(frame.header)),
      payloadBase64: base64(frame.payload)
    }))
  }

  function validCase(id, chunks, encodedFrames) {
    // Decode the chunk list (what Rust replays) and the original encoded frames
    // independently, then require the two observations to be identical.
    const decoded = decodeChunks(chunks)
    const encodedDecoded = decodeChunks(encodedFrames.map((frame) => Buffer.from(frame)))
    const expectedFrames = expectedFramesOf(decoded)
    const actualFrames = expectedFramesOf(encodedDecoded)
    if (JSON.stringify(expectedFrames) !== JSON.stringify(actualFrames)) {
      throw new Error(`clipboard fixture ${id} round-trip mismatch`)
    }
    return {
      id,
      case: {
        ...caseShell(format, `clipboard-protocol/${id}`, source, 'valid'),
        kind: 'valid',
        chunks: chunks.map((chunk) => base64(chunk)),
        expectedFrames,
        expectedError: null
      }
    }
  }

  function invalidCase(id, chunks, failAt, error) {
    let thrown = false
    try {
      const decoder = new protocol.FrameDecoder()
      for (const chunk of chunks) decoder.feed(chunk)
      decoder.finish()
    } catch (caught) {
      thrown = caught instanceof Error && caught.message === 'Invalid clipboard protocol frame'
    }
    if (!thrown) throw new Error(`clipboard fixture ${id} did not fail with the protocol error`)
    if (failAt !== 'feed' && failAt !== 'finish') throw new Error(`clipboard fixture ${id}: invalid failAt ${failAt}`)
    return {
      id,
      case: {
        ...caseShell(format, `clipboard-protocol/${id}`, source, 'invalid'),
        kind: 'invalid',
        chunks: chunks.map((chunk) => base64(chunk)),
        reason: error,
        expectedError: error,
        failAt
      }
    }
  }

  const payload = Buffer.from('fixture-payload-v1', 'utf8')
  const helloHeader = { type: 'hello' }
  const dataHeader = { type: 'data', sequence: 1 }
  const helloFrame = protocol.encodeFrame(helloHeader)
  const dataFrame = protocol.encodeFrame(dataHeader, payload)

  // Fragments are fixed byte offsets so the chunks array is byte-for-byte stable.
  const fragmented = [dataFrame.subarray(0, 5), dataFrame.subarray(5, 13), dataFrame.subarray(13)]

  // headerBytes = MAX_HEADER + 1: the decoder rejects after the 9 fixed bytes, so the
  // fixture stays tiny and the chunk does not need to contain a 512 KiB header.
  const headerTooLarge = Buffer.alloc(9)
  headerTooLarge.writeUInt32LE(5 + protocol.MAX_HEADER, 0)
  headerTooLarge[4] = 1
  headerTooLarge.writeUInt32LE(protocol.MAX_HEADER + 1, 5)

  // payloadBytes = MAX_CHUNK + 1 with a legal small header; same 9-byte trick.
  const legalHeaderJson = Buffer.from(JSON.stringify({ type: 'data' }))
  const payloadTooLarge = Buffer.alloc(9)
  payloadTooLarge.writeUInt32LE(5 + legalHeaderJson.length + protocol.MAX_CHUNK + 1, 0)
  payloadTooLarge[4] = 2
  payloadTooLarge.writeUInt32LE(legalHeaderJson.length, 5)

  const sizeBelowMinimum = Buffer.alloc(4)
  sizeBelowMinimum.writeUInt32LE(4, 0)

  const sizeAboveMaximum = Buffer.alloc(4)
  sizeAboveMaximum.writeUInt32LE(protocol.MAX_FRAME + 1, 0)

  const invalidKind = Buffer.from(helloFrame)
  invalidKind[4] = 3

  const nullHeaderBody = Buffer.from('null', 'utf8')
  const nullHeader = Buffer.concat([
    Buffer.from([13, 0, 0, 0, 1, nullHeaderBody.length, 0, 0, 0]),
    nullHeaderBody
  ])

  const invalidJsonBody = Buffer.from('not-json', 'utf8')
  const invalidJsonHeader = Buffer.concat([
    Buffer.from([13, 0, 0, 0, 1, invalidJsonBody.length, 0, 0, 0]),
    invalidJsonBody
  ])

  return [
    validCase('fragmented-frame', fragmented, [dataFrame]),
    invalidCase('header-invalid-json', [invalidJsonHeader], 'feed', 'invalid-frame'),
    invalidCase('header-not-an-object', [nullHeader], 'feed', 'invalid-frame'),
    invalidCase('header-too-large', [headerTooLarge], 'feed', 'invalid-frame'),
    invalidCase('invalid-kind-byte', [invalidKind], 'feed', 'invalid-frame'),
    validCase('multi-frame-single-feed', [Buffer.concat([helloFrame, dataFrame])], [helloFrame, dataFrame]),
    invalidCase('payload-too-large', [payloadTooLarge], 'feed', 'invalid-frame'),
    validCase('single-frame-empty-payload', [helloFrame], [helloFrame]),
    validCase('single-frame-with-payload', [dataFrame], [dataFrame]),
    invalidCase('size-less-than-minimum', [sizeBelowMinimum], 'feed', 'invalid-frame'),
    invalidCase('size-over-max-frame', [sizeAboveMaximum], 'feed', 'invalid-frame'),
    invalidCase('truncated-finish', [dataFrame.subarray(0, dataFrame.length - 1)], 'finish', 'invalid-frame')
  ]
}

// ---------------------------------------------------------------------------
// recording-export-options (format recording-export-options.v1)
// ---------------------------------------------------------------------------

function recordingExportOptionsCases() {
  const options = require(absolute('shared/recording-export-options.js'))
  const format = 'recording-export-options.v1'
  const source = ['shared/recording-export-options.js']

  const limitsCase = {
    ...caseShell(format, 'recording-export-options/limits', source, 'valid'),
    kind: 'limits',
    expectedLimits: {
      queue: {
        maxConcurrentEncodes: options.LIMITS.MAX_ACTIVE_TASKS,
        maxPending: options.LIMITS.MAX_QUEUED_TASKS
      },
      gif: {
        maxDurationMs: options.LIMITS.GIF_MAX_DURATION_MS,
        maxLongEdgePx: options.LIMITS.GIF_MAX_EDGE_PX,
        maxFrames: options.LIMITS.GIF_MAX_FRAMES,
        fps: [...options.GIF_FRAME_RATES]
      },
      segments: {
        maxSegments: options.LIMITS.MAX_SEGMENTS,
        maxSegmentMs: options.LIMITS.MIN_SEGMENT_MS
      }
    }
  }

  const desktopMetadata = {
    durationMs: 5000,
    video: { width: 1920, height: 1080, frameRate: 30 },
    audio: { exists: true }
  }
  const smallMetadata = {
    durationMs: 8000,
    video: { width: 640, height: 360, frameRate: 30 },
    audio: { exists: false }
  }

  function validNormalizeCase(id, request, metadata) {
    const result = options.normalizeExportRequest(request, metadata)
    if (!result.ok) throw new Error(`recording-export-options fixture ${id} unexpectedly failed: ${result.code}`)
    return {
      id,
      case: {
        ...caseShell(format, `recording-export-options/${id}`, source, 'valid'),
        kind: 'normalize',
        request,
        metadata,
        expected: result.value
      }
    }
  }

  function invalidNormalizeCase(id, request, metadata) {
    const result = options.normalizeExportRequest(request, metadata)
    if (result.ok) throw new Error(`recording-export-options fixture ${id} unexpectedly succeeded`)
    return {
      id,
      case: {
        ...caseShell(format, `recording-export-options/${id}`, source, 'invalid'),
        kind: 'normalize',
        request,
        metadata,
        reason: result.code
      }
    }
  }

  const tooLongMetadata = {
    durationMs: 61000,
    video: { width: 1920, height: 1080, frameRate: 30 },
    audio: { exists: false }
  }

  return [
    invalidNormalizeCase(
      'gif-too-long',
      { format: 'gif', gif: { edge: 1280, fps: 15 } },
      tooLongMetadata
    ),
    { id: 'limits', case: limitsCase },
    validNormalizeCase(
      'normalize-gif-clamped',
      { format: 'gif', gif: { edge: 1280, fps: 15 } },
      desktopMetadata
    ),
    validNormalizeCase(
      'normalize-gif-not-upscaled',
      { format: 'gif', gif: { edge: 1280, fps: 15 } },
      smallMetadata
    ),
    validNormalizeCase(
      'normalize-multi-segment',
      {
        format: 'mp4',
        segments: [{ startMs: 1000, endMs: 2000 }, { startMs: 3000, endMs: 3500 }],
        video: { resolution: '720p', quality: 'high', fps: 'source' }
      },
      desktopMetadata
    )
  ]
}

// ---------------------------------------------------------------------------
// settings (format settings.normalize.v1)
// ---------------------------------------------------------------------------

function settingsCases() {
  const { DEFAULT_SETTINGS } = require(absolute('main/services/settings-defaults.js'))
  const { createSettingsNormalizer } = require(absolute('main/services/settings-normalize.js'))
  const format = 'settings.normalize.v1'
  const source = ['main/services/settings-normalize.js', 'main/services/settings-defaults.js']
  // Synthetic data root: a relative fixture path, never a machine absolute path.
  const normalize = createSettingsNormalizer({ defaultHistoryDirectory: 'fixture-data-root/history' })

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  }

  function normalizeCase(id, input) {
    const expected = normalize(JSON.parse(JSON.stringify(input)))
    return {
      id,
      case: {
        ...caseShell(format, `settings/${id}`, source, 'valid'),
        kind: 'normalize',
        input,
        expected
      }
    }
  }

  const overrides = cloneDefaults()
  overrides.language = 'en-US'
  overrides.mainColor = '#abcdef'
  overrides.screenshot.historyDirectory = ''
  overrides.screenshot.annotationColor = 'red'
  overrides.screenshot.annotationWidth = 999

  const legacy = cloneDefaults()
  legacy.language = 'zh-CN'
  legacy.fixedContent = { autoSaveDirectory: 'legacy-fixture-directory' }

  return [
    normalizeCase('normalize-defaults-overrides', overrides),
    normalizeCase('normalize-legacy-autosave-dropped', legacy)
  ]
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function buildGroups() {
  return [
    {
      id: 'capture-document',
      format: 'capture-document.v3',
      generatedFrom: [
        'shared/capture-document.js',
        'shared/capture-output-style.js',
        'shared/magnifier-geometry.js'
      ],
      cases: captureDocumentCases()
    },
    {
      id: 'clipboard-protocol',
      format: 'clipboard-protocol.v1',
      generatedFrom: ['shared/clipboard-protocol.js'],
      cases: clipboardProtocolCases()
    },
    {
      id: 'recording-export-options',
      format: 'recording-export-options.v1',
      generatedFrom: ['shared/recording-export-options.js'],
      cases: recordingExportOptionsCases()
    },
    {
      id: 'recording-project',
      format: 'recording-project.v1',
      generatedFrom: ['shared/recording-project-schema.js'],
      cases: recordingProjectCases()
    },
    {
      id: 'settings',
      format: 'settings.normalize.v1',
      generatedFrom: ['main/services/settings-normalize.js', 'main/services/settings-defaults.js'],
      cases: settingsCases()
    }
  ]
}

function buildFixtureFiles() {
  const groups = buildGroups()
  const files = new Map()
  const manifestGroups = []
  for (const group of groups) {
    const sortedCases = [...group.cases].sort((left, right) => compareStrings(left.id, right.id))
    const manifestCases = []
    for (const entry of sortedCases) {
      const file = `${group.id}/${entry.id}.json`
      const relative = `${FIXTURES_REL}/${file}`
      const bytes = jsonBytes(entry.case)
      files.set(relative, bytes)
      manifestCases.push({ id: entry.id, file, sha256: sha256(bytes) })
    }
    manifestGroups.push({
      id: group.id,
      format: group.format,
      generatedFrom: [...group.generatedFrom],
      cases: manifestCases
    })
  }
  const manifest = {
    schemaVersion: FIXTURES_SCHEMA_VERSION,
    generator: 'scripts/rust/generate-host-fixtures.js',
    groups: manifestGroups
  }
  files.set(MANIFEST_REL, jsonBytes(manifest))
  return files
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const limit = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < limit; index += 1) {
    if (expectedLines[index] === actualLines[index]) continue
    return {
      line: index + 1,
      expected: expectedLines[index] === undefined ? '<end of file>' : expectedLines[index],
      actual: actualLines[index] === undefined ? '<end of file>' : actualLines[index]
    }
  }
  return null
}

function listOnDiskFixtureFiles() {
  if (!fs.existsSync(FIXTURES_DIR)) return []
  const collected = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.isFile() && entry.name.endsWith('.json')) collected.push(path.relative(ROOT, target).split(path.sep).join('/'))
    }
  }
  walk(FIXTURES_DIR)
  return collected.sort(compareStrings)
}

function runCli(argv) {
  const mode = argv.find((argument) => argument === '--write' || argument === '--check')
  if (!mode || argv.length !== 1) {
    process.stderr.write('usage: node scripts/rust/generate-host-fixtures.js --write|--check\n')
    return 2
  }
  const files = buildFixtureFiles()

  if (mode === '--write') {
    for (const [relative, bytes] of files) {
      const target = path.join(ROOT, ...relative.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, bytes)
    }
    process.stdout.write(`wrote ${files.size} fixture files under ${FIXTURES_REL}\n`)
    return 0
  }

  let failures = 0
  for (const [relative, bytes] of [...files.entries()].sort((left, right) => compareStrings(left[0], right[0]))) {
    const target = path.join(ROOT, ...relative.split('/'))
    const expected = bytes.toString('utf8')
    if (!fs.existsSync(target)) {
      process.stderr.write(`missing ${relative}; run --write\n`)
      failures += 1
      continue
    }
    const actual = fs.readFileSync(target, 'utf8')
    if (actual === expected) continue
    failures += 1
    process.stderr.write(`stale ${relative}; run --write\n`)
    process.stderr.write(`  on-disk sha256=${sha256(Buffer.from(actual, 'utf8'))} generated sha256=${sha256(bytes)}\n`)
    const difference = firstDifference(expected, actual)
    if (difference) {
      process.stderr.write(`  first difference at line ${difference.line}:\n`)
      process.stderr.write(`  - generated: ${difference.expected}\n`)
      process.stderr.write(`  + on-disk:   ${difference.actual}\n`)
    }
  }
  for (const relative of listOnDiskFixtureFiles()) {
    if (files.has(relative)) continue
    failures += 1
    process.stderr.write(`unexpected file ${relative}; fixtures are generated, remove it\n`)
  }
  if (failures) {
    process.stderr.write(`${failures} fixture file(s) are not reproducible; run --write\n`)
    return 1
  }
  process.stdout.write(`${MANIFEST_REL} and ${files.size - 1} case files are up to date\n`)
  return 0
}

module.exports = {
  FIXTURES_REL,
  MANIFEST_REL,
  buildFixtureFiles,
  caseShell
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2))
}
