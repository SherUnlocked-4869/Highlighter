'use strict'

// R0-02 contract + fixture gate.
//
// Covers:
//   * the committed contracts/host/host-contracts.json is what the extractor builds
//     from the current sources and both generated artifacts pass --check;
//   * every IPC_SURFACES role / preload global / exposed preload method is either
//     contracted or has a recorded knownGap (no silent omissions);
//   * invoke channels are in `handles`, send channels are in `listeners`;
//   * the eight §9.1 limits and the §5.1 schema versions still match the source
//     constants (a JS change that forgets the contract fails here);
//   * every fixture manifest sha256 matches, every case replays through the current
//     JS implementation, and the fixtures carry no machine paths or credentials.
//
// No Electron, no network, no GUI.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const CONTRACT_REL = 'contracts/host/host-contracts.json'
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL)
const FIXTURES_REL = 'test/fixtures/host-parity'
const FIXTURES_DIR = path.join(ROOT, FIXTURES_REL)
const MANIFEST_PATH = path.join(FIXTURES_DIR, 'manifest.json')
const MANIFEST_REL = `${FIXTURES_REL}/manifest.json`
const EXTRACTOR = path.join(ROOT, 'scripts/rust/extract-host-contracts.js')
const GENERATOR = path.join(ROOT, 'scripts/rust/generate-host-fixtures.js')

const extractor = require(EXTRACTOR)
const generator = require(GENERATOR)

const CAPTURE_DOCUMENT = require(path.join(ROOT, 'shared/capture-document.js'))
const CLIPBOARD_PROTOCOL = require(path.join(ROOT, 'shared/clipboard-protocol.js'))
const RECORDING_EXPORT = require(path.join(ROOT, 'shared/recording-export-options.js'))
const RECORDING_PROJECT = require(path.join(ROOT, 'shared/recording-project-schema.js'))
const THUMBNAIL_CACHE = require(path.join(ROOT, 'main/services/clipboard-thumbnail-cache.js'))
const LONG_CAPTURE = require(path.join(ROOT, 'main/services/long-capture-session.js'))
const RECORDING_DEMO = require(path.join(ROOT, 'shared/recording-demo.js'))
const CAPTURE_DOCUMENT_SERVICE = require(path.join(ROOT, 'main/services/capture-document-service.js'))
const USAGE_STORE = require(path.join(ROOT, 'main/services/usage-store.js'))
const SETTINGS_NORMALIZE = require(path.join(ROOT, 'main/services/settings-normalize.js'))
const SETTINGS_DEFAULTS = require(path.join(ROOT, 'main/services/settings-defaults.js'))

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function fileBytes(relativePath) {
  return fs.readFileSync(path.join(ROOT, ...relativePath.split('/')))
}

// 夹具以 LF 入库；CI 的 Windows checkout 可能转成 CRLF，sha256 校验按规范化文本计算。
function normalizeText(value) {
  return value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function walkJsonFiles(directory, collected = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) walkJsonFiles(target, collected)
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      collected.push(path.relative(ROOT, target).split(path.sep).join('/'))
    }
  }
  return collected
}

const contract = readJson(CONTRACT_PATH)
const built = extractor.buildHostContracts()

test('both generated artifacts pass their --check entry point', () => {
  for (const script of [EXTRACTOR, GENERATOR]) {
    const result = spawnSync(process.execPath, [script, '--check'], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(
      result.status,
      0,
      `${path.basename(script)} --check failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )
  }
})

test('the committed contract equals what the extractor builds from the sources', () => {
  assert.deepEqual(contract, built)
  assert.equal(contract.schemaVersion, 1)
  assert.equal(contract.kind, 'highlighter.host-contracts')
  assert.equal(contract.status, 'r0-draft')
})

test('baseline versions name package.json, the plan and the R0 host', () => {
  const pkg = readJson(path.join(ROOT, 'package.json'))
  assert.equal(contract.baseline.appVersion, pkg.version)
  assert.equal(contract.baseline.electron, String(pkg.devDependencies.electron))
  assert.match(contract.baseline.gitCommit, /^[0-9a-f]{40}$/)
  const plan = fs.readFileSync(
    path.join(ROOT, 'docs/plans/2026-11-10-rust-migration-development-plan.md'),
    'utf8'
  )
  assert.ok(plan.includes(contract.baseline.gitCommit), 'baseline.gitCommit is not named by the R0 plan')
  assert.match(contract.baseline.node, /^\d+\.\d+\.\d+$/)
})

test('13 IPC_SURFACES roles are all present with their page', () => {
  const { IPC_SURFACES } = require(path.join(ROOT, 'main/services/ipc-security.js'))
  assert.equal(IPC_SURFACES.length, 13)
  assert.deepEqual(
    contract.roles.map((role) => role.role),
    [...IPC_SURFACES.map((surface) => surface.role)].sort()
  )
  for (const surface of IPC_SURFACES) {
    const role = contract.roles.find((entry) => entry.role === surface.role)
    assert.ok(role, `role ${surface.role} is missing`)
    assert.equal(role.page, surface.page, `${surface.role} page drifted`)
    assert.deepEqual(role.surface.handles, sortedUnique(surface.handles || []))
    assert.deepEqual(role.surface.listeners, sortedUnique(surface.listeners || []))
  }
})

test('every preload global object is covered exactly once', () => {
  const preloadFiles = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^preload.*\.js$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  assert.equal(preloadFiles.length, 13)
  const covered = sortedUnique([
    ...contract.roles.map((role) => role.preload),
    ...contract.knownGaps.filter((gap) => gap.kind === 'preload-without-role').map((gap) => gap.preload)
  ])
  assert.deepEqual(covered, preloadFiles)
  for (const role of contract.roles) {
    assert.ok(role.preload.startsWith('preload'), `${role.role} has no preload file`)
    assert.ok(fs.existsSync(path.join(ROOT, role.preload)), `${role.preload} does not exist`)
  }
})

test('every preload method is contracted or recorded as a known gap', () => {
  for (const role of contract.roles) {
    const execution = extractor.runPreload(role.preload)
    const exposed = Object.keys(execution.api).sort()
    assert.equal(role.globalObject, execution.globalObject, `${role.role} global object drifted`)
    assert.ok(
      fs.readFileSync(path.join(ROOT, role.preload), 'utf8').includes(`exposeInMainWorld('${role.globalObject}'`),
      `${role.preload} no longer exposes ${role.globalObject}`
    )
    const contracted = role.methods.map((method) => method.name)
    const gaps = role.knownGaps.filter((gap) => typeof gap.method === 'string').map((gap) => gap.method)
    assert.deepEqual(
      sortedUnique([...contracted, ...gaps]),
      exposed,
      `${role.role} has preload methods missing from both methods[] and knownGaps[]`
    )
    for (const method of role.methods) {
      assert.ok(['invoke', 'send', 'subscribe'].includes(method.kind), `${role.role}.${method.name} has bad kind`)
      assert.ok(method.source.startsWith(`${role.preload}:`), `${role.role}.${method.name} source is not in ${role.preload}`)
      assert.match(method.source.slice(role.preload.length + 1), /^[0-9]+$/)
      assert.ok(method.call.startsWith('(') && method.call.endsWith(')'), `${role.role}.${method.name} call is malformed`)
      if (method.kind === 'invoke') assert.equal(method.returns, 'Promise<unknown>')
      else if (method.kind === 'send') assert.equal(method.returns, 'void')
      else assert.ok(['unsubscribe function', 'void'].includes(method.returns))
      for (const testFile of method.tests) {
        assert.ok(fs.existsSync(path.join(ROOT, testFile)), `${method.tests} entry ${testFile} does not exist`)
      }
    }
  }
})

test('channel permissions are consistent with IPC_SURFACES', () => {
  for (const role of contract.roles) {
    const handles = new Set(role.surface.handles)
    const listeners = new Set(role.surface.listeners)
    for (const method of role.methods) {
      if (method.kind === 'invoke') {
        assert.ok(handles.has(method.channel), `${role.role}.${method.name} invokes ${method.channel} but it is not in handles`)
      }
      if (method.kind === 'send') {
        assert.ok(listeners.has(method.channel), `${role.role}.${method.name} sends ${method.channel} but it is not in listeners`)
      }
      if (method.kind === 'subscribe') {
        assert.ok(role.surface.receives.includes(method.channel), `${role.role}.${method.name} subscribes ${method.channel} but it is not in receives`)
      }
    }
  }
})

test('known gaps and auxiliary windows carry a reason and a source location', () => {
  for (const gap of [...contract.roles.flatMap((role) => role.knownGaps), ...contract.knownGaps]) {
    assert.equal(typeof gap.kind, 'string')
    assert.equal(typeof gap.reason, 'string')
    assert.ok(gap.reason.length > 0, `gap ${gap.kind} has no reason`)
    assert.ok(gap.source || gap.sources, `gap ${gap.kind} has no source location`)
  }
  const toolbar = contract.roles.find((role) => role.role === 'toolbar')
  assert.ok(toolbar.knownGaps.some((gap) => gap.method === 'onSelection' && gap.kind === 'method-not-resolved'))
  assert.ok(toolbar.knownGaps.some((gap) => gap.channel === 'selection:text' && gap.kind === 'module-level-subscription'))
  const printWindow = contract.knownGaps.find((gap) => gap.page === 'capture/print.html')
  assert.ok(printWindow, 'capture/print.html auxiliary window is not registered')
  assert.deepEqual(printWindow.roles, ['capture'])
  assert.ok(printWindow.sources.includes('main/services/pdf-export.js:381'))
})

test('the eight §9.1 resource limits read back the source constants', () => {
  const expected = {
    'capture.commit-receipts': {
      maxReceiptsPerDocument: CAPTURE_DOCUMENT_SERVICE.MAX_RECEIPTS_PER_DOCUMENT
    },
    'clipboard.protocol': {
      maxFrameBytes: CLIPBOARD_PROTOCOL.MAX_FRAME,
      maxHeaderBytes: CLIPBOARD_PROTOCOL.MAX_HEADER,
      maxPayloadChunkBytes: CLIPBOARD_PROTOCOL.MAX_CHUNK
    },
    'clipboard.thumbnail-cache': {
      maxBytes: THUMBNAIL_CACHE.DEFAULT_MAX_BYTES,
      maxEntries: THUMBNAIL_CACHE.DEFAULT_MAX_ENTRIES
    },
    'long-capture': {
      maxLongEdgePx: LONG_CAPTURE.MAX_LONG_EDGE,
      maxPixels: LONG_CAPTURE.MAX_PIXELS
    },
    'recording.event-track': {
      maxPointerEvents: RECORDING_DEMO.POINTER_LIMIT,
      maxClickEvents: RECORDING_DEMO.CLICKS_LIMIT
    },
    'recording.export-queue': {
      maxConcurrentEncodes: RECORDING_EXPORT.LIMITS.MAX_ACTIVE_TASKS,
      maxPending: RECORDING_EXPORT.LIMITS.MAX_QUEUED_TASKS
    },
    'recording.gif': {
      maxDurationMs: RECORDING_EXPORT.LIMITS.GIF_MAX_DURATION_MS,
      maxLongEdgePx: RECORDING_EXPORT.LIMITS.GIF_MAX_EDGE_PX,
      maxFrames: RECORDING_EXPORT.LIMITS.GIF_MAX_FRAMES,
      fps: [...RECORDING_EXPORT.GIF_FRAME_RATES]
    },
    'recording.segments': {
      maxSegments: RECORDING_EXPORT.LIMITS.MAX_SEGMENTS,
      maxSegmentMs: RECORDING_EXPORT.LIMITS.MIN_SEGMENT_MS
    }
  }
  assert.deepEqual(contract.resourceLimits.map((limit) => limit.id), Object.keys(expected).sort())
  for (const limit of contract.resourceLimits) {
    assert.deepEqual(limit.value, expected[limit.id], `${limit.id} drifted from the source constant`)
    assert.ok(fs.existsSync(path.join(ROOT, limit.source)), `${limit.id} source ${limit.source} does not exist`)
    assert.ok(Array.isArray(limit.symbols) && limit.symbols.length > 0)
    assert.ok(['module', 'static'].includes(limit.extraction))
  }
})

test('the §5.1 shared schema versions read back the source constants', () => {
  const byDocument = new Map(contract.sharedSchemas.map((entry) => [entry.document, entry]))
  assert.deepEqual([...byDocument.keys()].sort(), [
    'capture-document',
    'clipboard-db',
    'data-root-marker',
    'recording-project',
    'settings-normalize',
    'usage-db'
  ])
  assert.equal(byDocument.get('capture-document').version, CAPTURE_DOCUMENT.SCHEMA_VERSION)
  assert.equal(byDocument.get('recording-project').version, RECORDING_PROJECT.SCHEMA_VERSION)
  assert.equal(byDocument.get('usage-db').version, USAGE_STORE.SCHEMA_VERSION)
  assert.equal(byDocument.get('usage-db').userVersion, USAGE_STORE.SCHEMA_VERSION)
  assert.equal(byDocument.get('clipboard-db').version, 2)
  assert.equal(byDocument.get('clipboard-db').userVersion, 2)
  assert.match(fs.readFileSync(path.join(ROOT, byDocument.get('clipboard-db').path), 'utf8'), /PRAGMA user_version=2/)
  assert.equal(byDocument.get('data-root-marker').version, 3)
  const dataRootSource = fs.readFileSync(path.join(ROOT, byDocument.get('data-root-marker').path), 'utf8')
  assert.match(dataRootSource, /const MARKER_VERSION = 3/)
  assert.equal(byDocument.get('settings-normalize').version, null)
  assert.equal(byDocument.get('settings-normalize').normalizeSymbol, 'createSettingsNormalizer')
  for (const entry of contract.sharedSchemas) {
    assert.ok(fs.existsSync(path.join(ROOT, entry.path)), `${entry.document} path ${entry.path} does not exist`)
    for (const testFile of entry.tests) {
      assert.ok(fs.existsSync(path.join(ROOT, testFile)), `${entry.document} test ${testFile} does not exist`)
    }
  }
})

test('errorCodes cover every deny and block branch with a source line', () => {
  const expectedCodes = sortedUnique([
    ...extractor.scanDenyCodes().keys(),
    ...extractor.scanBlockCodes().keys()
  ])
  assert.deepEqual(contract.errorCodes.map((entry) => entry.code), expectedCodes)
  for (const entry of contract.errorCodes) {
    assert.match(entry.source, /^main\/services\/(ipc-security|window-security)\.js:[0-9]+$/)
    assert.ok(['deny', 'block'].includes(entry.direction))
    assert.ok(entry.meaning.length > 0)
  }
  const deny = contract.errorCodes.filter((entry) => entry.direction === 'deny').map((entry) => entry.code)
  assert.ok(deny.includes('window-owner-mismatch'))
  assert.ok(deny.includes('page-not-allowed'))
})

test('fixture manifest hashes match the case files', () => {
  const manifest = readJson(MANIFEST_PATH)
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.generator, 'scripts/rust/generate-host-fixtures.js')
  assert.deepEqual(manifest.groups.map((group) => group.id), [
    'capture-document',
    'clipboard-protocol',
    'recording-export-options',
    'recording-project',
    'settings'
  ])
  const listed = []
  for (const group of manifest.groups) {
    for (const file of group.generatedFrom) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${group.id} generatedFrom ${file} does not exist`)
    }
    assert.deepEqual([...group.cases.map((entry) => entry.id)].sort(), group.cases.map((entry) => entry.id))
    for (const entry of group.cases) {
      const relative = `${FIXTURES_REL}/${entry.file}`
      listed.push(relative)
      const bytes = fileBytes(relative)
      assert.equal(sha256(Buffer.from(normalizeText(bytes.toString('utf8')), 'utf8')), entry.sha256, `${relative} sha256 does not match the manifest`)
      const parsed = JSON.parse(normalizeText(bytes.toString('utf8')))
      assert.equal(parsed.schemaVersion, 1)
      assert.equal(parsed.caseId, `${group.id}/${entry.id}`)
      assert.equal(parsed.format, group.format)
      assert.deepEqual(parsed.source, group.generatedFrom)
      assert.ok(['valid', 'invalid'].includes(parsed.expect), `${relative} has no valid expect`)
      if (parsed.expect === 'invalid') {
        assert.equal(typeof parsed.reason, 'string')
        assert.ok(parsed.reason.length > 0, `${relative} invalid case has no reason`)
      } else {
        assert.equal(parsed.reason, undefined)
      }
    }
  }
  assert.deepEqual(
    walkJsonFiles(FIXTURES_DIR).sort(),
    sortedUnique([MANIFEST_REL, ...listed])
  )
})

function scanFixtureData(value, pathParts, findings) {
  if (typeof value === 'string') {
    if (/^[A-Za-z]:[\\/]/.test(value)) findings.push(`${pathParts.join('.')}: windows absolute path`)
    if (
      value.includes('\\Users\\') ||
      value.includes('\\AppData\\') ||
      value.includes('/home/') ||
      value.includes('/Users/') ||
      value.startsWith('file://')
    ) {
      findings.push(`${pathParts.join('.')}: user profile path or file url`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanFixtureData(entry, [...pathParts, String(index)], findings))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'apiKey' && typeof entry === 'string' && entry !== '') {
        findings.push(`${pathParts.join('.')}: non-empty apiKey`)
      }
      scanFixtureData(entry, [...pathParts, key], findings)
    }
  }
}

test('fixtures carry no machine paths or credentials', () => {
  for (const relative of walkJsonFiles(FIXTURES_DIR)) {
    const parsed = JSON.parse(fileBytes(relative).toString('utf8'))
    const findings = []
    scanFixtureData(parsed, [], findings)
    assert.deepEqual(findings, [], `${relative} leaks machine-specific or secret data`)
  }
})

test('clipboard-protocol fixtures replay in the JS decoder', () => {
  const manifest = readJson(MANIFEST_PATH)
  const group = manifest.groups.find((entry) => entry.id === 'clipboard-protocol')
  assert.ok(group.cases.length >= 11, 'clipboard-protocol must keep at least 11 cases')
  for (const entry of group.cases) {
    const fixture = readJson(path.join(FIXTURES_DIR, entry.file))
    const chunks = fixture.chunks.map((chunk) => Buffer.from(chunk, 'base64'))
    if (fixture.kind === 'valid') {
      const decoder = new CLIPBOARD_PROTOCOL.FrameDecoder()
      const frames = []
      for (const chunk of chunks) frames.push(...decoder.feed(chunk))
      decoder.finish()
      assert.deepEqual(
        frames.map((frame) => ({
          header: frame.header,
          payloadBase64: Buffer.from(frame.payload).toString('base64')
        })),
        fixture.expectedFrames,
        `${fixture.caseId} decoded frames differ`
      )
      assert.equal(fixture.expectedError, null)
    } else {
      const decoder = new CLIPBOARD_PROTOCOL.FrameDecoder()
      let threwDuringFeed = false
      try {
        for (const chunk of chunks) decoder.feed(chunk)
      } catch (error) {
        threwDuringFeed = true
        assert.equal(error.message, 'Invalid clipboard protocol frame')
      }
      if (fixture.failAt === 'feed') {
        assert.ok(threwDuringFeed, `${fixture.caseId} was expected to fail during feed`)
      } else {
        assert.equal(fixture.failAt, 'finish')
        assert.equal(threwDuringFeed, false, `${fixture.caseId} failed before finish()`)
        assert.throws(() => decoder.finish(), /Invalid clipboard protocol frame/)
      }
      assert.equal(fixture.expectedError, 'invalid-frame')
    }
  }
})

test('capture-document fixtures replay in the JS parser', () => {
  const manifest = readJson(MANIFEST_PATH)
  const group = manifest.groups.find((entry) => entry.id === 'capture-document')
  assert.ok(group.cases.length >= 3)
  for (const entry of group.cases) {
    const fixture = readJson(path.join(FIXTURES_DIR, entry.file))
    if (fixture.expect === 'invalid') {
      const parsed = CAPTURE_DOCUMENT.parseDocument(JSON.stringify(fixture.input))
      assert.equal(parsed.ok, false, `${fixture.caseId} unexpectedly parsed`)
      assert.equal(parsed.code, fixture.reason, `${fixture.caseId} error code drifted`)
      assert.deepEqual(parsed.errors.map((error) => error.code), fixture.errors)
      continue
    }
    const validation = CAPTURE_DOCUMENT.validateDocument(fixture.document)
    assert.equal(validation.ok, true, `${fixture.caseId} is not a valid v3 document: ${JSON.stringify(validation.errors)}`)
    if (fixture.input) {
      const parsed = CAPTURE_DOCUMENT.parseDocument(JSON.stringify(fixture.input))
      assert.equal(parsed.ok, true, `${fixture.caseId} did not upgrade: ${JSON.stringify(parsed.errors)}`)
      assert.equal(parsed.migratedFrom, fixture.invariants.migratedFrom)
      assert.deepEqual(parsed.document, fixture.document, `${fixture.caseId} upgraded shape drifted`)
    }
    assert.equal(fixture.document.schemaVersion, fixture.invariants.schemaVersion)
    assert.equal(fixture.document.documentId, fixture.invariants.documentId)
    assert.equal(fixture.document.revisionId, fixture.invariants.revisionId)
    assert.equal(fixture.document.baseImage.width, fixture.invariants.sourceWidth)
    assert.equal(fixture.document.baseImage.height, fixture.invariants.sourceHeight)
    const geometry = CAPTURE_DOCUMENT.resolveOutputGeometry(fixture.document)
    assert.equal(geometry.width, fixture.invariants.outputWidth, `${fixture.caseId} output width drifted`)
    assert.equal(geometry.height, fixture.invariants.outputHeight, `${fixture.caseId} output height drifted`)
    assert.equal(
      CAPTURE_DOCUMENT.documentFingerprint(fixture.document),
      fixture.invariants.contentFingerprint,
      `${fixture.caseId} content fingerprint drifted`
    )
  }
})

test('recording-project fixtures replay in the JS validator', () => {
  const manifest = readJson(MANIFEST_PATH)
  const group = manifest.groups.find((entry) => entry.id === 'recording-project')
  assert.ok(group.cases.length >= 3)
  for (const entry of group.cases) {
    const fixture = readJson(path.join(FIXTURES_DIR, entry.file))
    const validation = RECORDING_PROJECT.validateProject(fixture.project)
    if (fixture.expect === 'invalid') {
      assert.equal(validation.ok, false, `${fixture.caseId} unexpectedly validated`)
      assert.deepEqual(validation.errors, fixture.errors)
      assert.equal(fixture.reason, 'invalid-project')
      continue
    }
    assert.equal(validation.ok, true, `${fixture.caseId} is invalid: ${JSON.stringify(validation.errors)}`)
    assert.deepEqual(RECORDING_PROJECT.normalizeProject(fixture.project), fixture.project, `${fixture.caseId} is not canonical`)
    assert.equal(fixture.project.schemaVersion, fixture.invariants.schemaVersion)
    assert.equal(fixture.project.id, fixture.invariants.projectId)
    assert.deepEqual(
      fixture.project.edit.keepRanges.map((range) => [range.startMs, range.endMs]),
      fixture.invariants.keepRanges
    )
  }
})

test('recording-export-options fixtures replay in the JS normalizer', () => {
  const manifest = readJson(MANIFEST_PATH)
  const group = manifest.groups.find((entry) => entry.id === 'recording-export-options')
  for (const entry of group.cases) {
    const fixture = readJson(path.join(FIXTURES_DIR, entry.file))
    if (fixture.kind === 'limits') {
      assert.deepEqual(fixture.expectedLimits.queue, {
        maxConcurrentEncodes: RECORDING_EXPORT.LIMITS.MAX_ACTIVE_TASKS,
        maxPending: RECORDING_EXPORT.LIMITS.MAX_QUEUED_TASKS
      })
      assert.deepEqual(fixture.expectedLimits.gif, {
        maxDurationMs: RECORDING_EXPORT.LIMITS.GIF_MAX_DURATION_MS,
        maxLongEdgePx: RECORDING_EXPORT.LIMITS.GIF_MAX_EDGE_PX,
        maxFrames: RECORDING_EXPORT.LIMITS.GIF_MAX_FRAMES,
        fps: [...RECORDING_EXPORT.GIF_FRAME_RATES]
      })
      assert.deepEqual(fixture.expectedLimits.segments, {
        maxSegments: RECORDING_EXPORT.LIMITS.MAX_SEGMENTS,
        maxSegmentMs: RECORDING_EXPORT.LIMITS.MIN_SEGMENT_MS
      })
      continue
    }
    const result = RECORDING_EXPORT.normalizeExportRequest(fixture.request, fixture.metadata)
    if (fixture.expect === 'invalid') {
      assert.equal(result.ok, false, `${fixture.caseId} unexpectedly normalised`)
      assert.equal(result.code, fixture.reason)
      continue
    }
    assert.equal(result.ok, true, `${fixture.caseId} failed: ${result.code}`)
    assert.deepEqual(result.value, fixture.expected, `${fixture.caseId} normalised value drifted`)
  }
})

test('settings fixtures replay in the JS normalizer', () => {
  const manifest = readJson(MANIFEST_PATH)
  const group = manifest.groups.find((entry) => entry.id === 'settings')
  assert.ok(group, 'settings fixture group is missing')
  assert.ok(SETTINGS_DEFAULTS.DEFAULT_SETTINGS && typeof SETTINGS_DEFAULTS.DEFAULT_SETTINGS === 'object')
  const normalize = SETTINGS_NORMALIZE.createSettingsNormalizer({ defaultHistoryDirectory: 'fixture-data-root/history' })
  for (const entry of group.cases) {
    const fixture = readJson(path.join(FIXTURES_DIR, entry.file))
    assert.deepEqual(normalize(JSON.parse(JSON.stringify(fixture.input))), fixture.expected, `${fixture.caseId} drifted`)
  }
})

test('generation is deterministic across two runs', () => {
  assert.equal(
    extractor.renderHostContracts(extractor.buildHostContracts()),
    extractor.renderHostContracts(extractor.buildHostContracts())
  )
  const first = generator.buildFixtureFiles()
  const second = generator.buildFixtureFiles()
  assert.deepEqual([...first.keys()].sort(), [...second.keys()].sort())
  for (const [relative, bytes] of first) {
    assert.deepEqual(second.get(relative), bytes, `${relative} is not deterministic`)
  }
})
