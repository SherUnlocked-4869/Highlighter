#!/usr/bin/env node
'use strict'

// R0-02 host contract extractor.
//
// Builds contracts/host/host-contracts.json from the CURRENT JavaScript sources:
//   * roles / pages / handles / listeners come from main/services/ipc-security.js
//     (IPC_SURFACES) and the root preload*.js files;
//   * methods / kinds / channels / return shapes are observed by running each
//     preload inside a `vm` sandbox with a recording `electron` stub (no Electron,
//     no window, no network);
//   * error codes come from the deny branches in main/services/ipc-security.js and
//     the block reasons in main/services/window-security.js;
//   * resource limits come from the shared / main modules that own them (with a
//     static source fallback and a recorded `extraction` mode);
//   * shared schema versions come from the modules or from the SQL text.
//
// Everything that cannot be resolved is written to a knownGaps array (per role or
// top level) together with the source location, never silently dropped.
//
// Usage:
//   node scripts/rust/extract-host-contracts.js --write
//   node scripts/rust/extract-host-contracts.js --check
//
// The output is deterministic: UTF-8, LF, two-space indentation, insertion-order
// keys, arrays sorted by a stable key, one trailing newline, no timestamps, no
// machine paths, no working-tree-dependent values. The declared baseline commit is
// the one named by the R0 plan; the actual `git rev-parse HEAD` is only printed as
// a hint so --check keeps working after a commit.

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { execFileSync } = require('child_process')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '..', '..')
const OUTPUT_REL = 'contracts/host/host-contracts.json'
const OUTPUT_PATH = path.join(ROOT, OUTPUT_REL)
const CONTRACTS_SCHEMA_VERSION = 1
const PLAN_REL = 'docs/plans/2026-11-10-rust-migration-development-plan.md'
// R0 plan §1 (docs/plans/2026-11-10-rust-migration-development-plan.md:5).
const BASELINE_COMMIT = '3df712976fdeeef1f1dce47a81995cfabdee8ee9'
// R0 baseline host recorded by the plan / contract-format example (§3). This is a
// declaration, not `process.versions.node`, so --check output is host independent.
const BASELINE_NODE = '24.22.1'

const METHOD_CANDIDATE_ARGUMENTS = [
  [() => {}],
  [],
  ['https://fixture.invalid/host-contracts'],
  [1],
  [true],
  [1, 'fixture-id', true],
  [{}, {}],
  ['fixture-id', 'fixture-name', {}],
  [Buffer.alloc(0)]
]

const DENY_MEANINGS = Object.freeze({
  'missing-or-destroyed-sender': 'the IPC sender is missing or already destroyed',
  'non-top-level-frame': 'the IPC message did not come from the sender main frame',
  'unregistered-window': 'the sender window was not registered by createSecureWindow',
  'invalid-window-owner': 'the sender does not belong to the registered BrowserWindow',
  'sender-url-mismatch': 'the sender URL is not the registered local page',
  'page-not-allowed': 'the registered page path has no IPC policy for this channel',
  'window-owner-mismatch': 'authorizeRole denied this window for the channel role'
})

const BLOCK_MEANINGS = Object.freeze({
  'blocked-navigation': 'navigation to a non-allowed local URL was prevented',
  'blocked-webview': 'a webview attachment was prevented',
  'blocked-window-open': 'window.open was denied'
})

// §9.1 "首批继承的硬限制": the eight inherited limits, each with the symbol that owns
// the value. `staticPatterns` is only used when the module cannot be loaded without
// Electron; the extraction mode is recorded on every entry.
const RESOURCE_LIMIT_SPECS = Object.freeze([
  {
    id: 'capture.commit-receipts',
    source: 'main/services/capture-document-service.js',
    symbols: ['MAX_RECEIPTS_PER_DOCUMENT'],
    build: (module) => ({ maxReceiptsPerDocument: module.MAX_RECEIPTS_PER_DOCUMENT }),
    staticPatterns: { maxReceiptsPerDocument: /const MAX_RECEIPTS_PER_DOCUMENT = (\d+)/ }
  },
  {
    id: 'clipboard.protocol',
    source: 'shared/clipboard-protocol.js',
    symbols: ['MAX_FRAME', 'MAX_HEADER', 'MAX_CHUNK'],
    build: (module) => ({
      maxFrameBytes: module.MAX_FRAME,
      maxHeaderBytes: module.MAX_HEADER,
      maxPayloadChunkBytes: module.MAX_CHUNK
    }),
    staticPatterns: {
      maxFrameBytes: /const MAX_FRAME = ([0-9*\s()]+)/,
      maxHeaderBytes: /const MAX_HEADER = ([0-9*\s()]+)/,
      maxPayloadChunkBytes: /const MAX_CHUNK = ([0-9*\s()]+)/
    }
  },
  {
    id: 'clipboard.thumbnail-cache',
    source: 'main/services/clipboard-thumbnail-cache.js',
    symbols: ['DEFAULT_MAX_BYTES', 'DEFAULT_MAX_ENTRIES'],
    build: (module) => ({
      maxBytes: module.DEFAULT_MAX_BYTES,
      maxEntries: module.DEFAULT_MAX_ENTRIES
    }),
    staticPatterns: {
      maxBytes: /const DEFAULT_MAX_BYTES = ([0-9*\s()]+)/,
      maxEntries: /const DEFAULT_MAX_ENTRIES = ([0-9*\s()]+)/
    }
  },
  {
    id: 'long-capture',
    source: 'main/services/long-capture-session.js',
    symbols: ['MAX_LONG_EDGE', 'MAX_PIXELS'],
    build: (module) => ({
      maxLongEdgePx: module.MAX_LONG_EDGE,
      maxPixels: module.MAX_PIXELS
    }),
    staticPatterns: {
      maxLongEdgePx: /const MAX_LONG_EDGE = (\d+)/,
      maxPixels: /const MAX_PIXELS = (\d+)/
    }
  },
  {
    id: 'recording.event-track',
    source: 'shared/recording-demo.js',
    symbols: ['POINTER_LIMIT', 'CLICKS_LIMIT'],
    build: (module) => ({
      maxPointerEvents: module.POINTER_LIMIT,
      maxClickEvents: module.CLICKS_LIMIT
    }),
    staticPatterns: {
      maxPointerEvents: /const POINTER_LIMIT = (\d+)/,
      maxClickEvents: /const CLICKS_LIMIT = (\d+)/
    }
  },
  {
    id: 'recording.export-queue',
    source: 'shared/recording-export-options.js',
    symbols: ['LIMITS.MAX_ACTIVE_TASKS', 'LIMITS.MAX_QUEUED_TASKS'],
    build: (module) => ({
      maxConcurrentEncodes: module.LIMITS.MAX_ACTIVE_TASKS,
      maxPending: module.LIMITS.MAX_QUEUED_TASKS
    }),
    staticPatterns: {
      maxConcurrentEncodes: /MAX_ACTIVE_TASKS:\s*(\d+)/,
      maxPending: /MAX_QUEUED_TASKS:\s*(\d+)/
    }
  },
  {
    id: 'recording.gif',
    source: 'shared/recording-export-options.js',
    symbols: [
      'LIMITS.GIF_MAX_DURATION_MS',
      'LIMITS.GIF_MAX_EDGE_PX',
      'LIMITS.GIF_MAX_FRAMES',
      'GIF_FRAME_RATES'
    ],
    build: (module) => ({
      maxDurationMs: module.LIMITS.GIF_MAX_DURATION_MS,
      maxLongEdgePx: module.LIMITS.GIF_MAX_EDGE_PX,
      maxFrames: module.LIMITS.GIF_MAX_FRAMES,
      fps: [...module.GIF_FRAME_RATES]
    }),
    staticPatterns: {
      maxDurationMs: /GIF_MAX_DURATION_MS:\s*(\d+)/,
      maxLongEdgePx: /GIF_MAX_EDGE_PX:\s*(\d+)/,
      maxFrames: /GIF_MAX_FRAMES:\s*(\d+)/,
      fps: /const GIF_FRAME_RATES = Object\.freeze\((\[[^\]]*\])\)/
    }
  },
  {
    id: 'recording.segments',
    source: 'shared/recording-export-options.js',
    symbols: ['LIMITS.MAX_SEGMENTS', 'LIMITS.MIN_SEGMENT_MS'],
    build: (module) => ({
      maxSegments: module.LIMITS.MAX_SEGMENTS,
      maxSegmentMs: module.LIMITS.MIN_SEGMENT_MS
    }),
    staticPatterns: {
      maxSegments: /MAX_SEGMENTS:\s*(\d+)/,
      maxSegmentMs: /MIN_SEGMENT_MS:\s*(\d+)/
    }
  }
])

const SHARED_SCHEMA_SPECS = Object.freeze([
  {
    document: 'capture-document',
    path: 'shared/capture-document.js',
    module: 'shared/capture-document.js',
    versionSymbol: 'SCHEMA_VERSION',
    tests: ['test/capture-document.test.js', 'test/capture-document-service.test.js']
  },
  {
    document: 'clipboard-db',
    path: 'native/clipboard/src/storage.rs',
    versionSymbol: 'PRAGMA user_version',
    versionFromUserVersion: true,
    userVersionFrom: 'native/clipboard/src/storage.rs',
    schemaPath: 'native/clipboard/src/schema-v2.sql',
    tests: ['native/clipboard/tests/schema_migration.rs', 'test/clipboard-protocol.test.js']
  },
  {
    document: 'data-root-marker',
    path: 'main/services/data-root-migration.js',
    module: 'main/services/data-root-migration.js',
    versionSymbol: 'MARKER_VERSION',
    staticPattern: /const MARKER_VERSION = (\d+)/,
    tests: ['test/data-root-migration.test.js']
  },
  {
    document: 'recording-project',
    path: 'shared/recording-project-schema.js',
    module: 'shared/recording-project-schema.js',
    versionSymbol: 'SCHEMA_VERSION',
    tests: ['test/recording-project-schema.test.js']
  },
  {
    document: 'settings-normalize',
    path: 'main/services/settings-normalize.js',
    version: null,
    versionSymbol: null,
    normalizeSymbol: 'createSettingsNormalizer',
    tests: ['test/settings-normalize.test.js']
  },
  {
    document: 'usage-db',
    path: 'main/services/usage-store.js',
    module: 'main/services/usage-store.js',
    versionSymbol: 'SCHEMA_VERSION',
    userVersionFrom: 'main/services/usage-store.js',
    tests: ['test/usage-store.test.js']
  }
])

function absolute(relativePath) {
  return path.join(ROOT, ...relativePath.split('/'))
}

// 生成的合同必须与 Windows/macOS checkout 的行尾无关：CRLF 会改变字节级 --check 与
// sha256 结果（CI 的 windows runner 会做 autocrlf 转换），因此所有文本读取统一归一化。
function normalizeText(value) {
  return value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

function readSource(relativePath) {
  return normalizeText(fs.readFileSync(absolute(relativePath), 'utf8'))
}

function fileExists(relativePath) {
  return fs.existsSync(absolute(relativePath))
}

function lineOf(source, index) {
  let line = 1
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareStrings)
}

// ---------------------------------------------------------------------------
// Static source scanning helpers
// ---------------------------------------------------------------------------

function listFilesRecursive(directory, predicate, collected = []) {
  if (!fs.existsSync(directory)) return collected
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) listFilesRecursive(target, predicate, collected)
    else if (entry.isFile() && predicate(entry.name)) collected.push(target)
  }
  return collected
}

function relativeFromRoot(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/')
}

function listPreloadFiles() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^preload.*\.js$/.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareStrings)
}

function preloadFileForRole(role) {
  return role === 'main' ? 'preload.js' : `preload-${role}.js`
}

function extractExposedGlobal(source) {
  const match = /contextBridge\.exposeInMainWorld\(\s*'([^']+)'/.exec(source)
  return match ? match[1] : ''
}

// Method definitions in the exposed object: two-space indented properties whose value
// is an arrow function or a traditional function. Signatures are single-line in every
// current preload, and the extractor asserts that this scan covers every method that
// the executed object actually exposes.
function scanMethodDefinitions(source) {
  const definitions = new Map()
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^ {2}([A-Za-z_$][\w$]*)\s*:\s*(?:\(([^)]*)\)\s*=>|function\s*\(([^)]*)\))/.exec(lines[index])
    if (!match) continue
    const params = (match[2] !== undefined ? match[2] : match[3] || '').trim()
    definitions.set(match[1], { line: index + 1, params })
  }
  return definitions
}

function scanSubscriptions(source) {
  const subscriptions = new Map()
  const pattern = /ipcRenderer\.on\(\s*'([^']+)'/g
  let match = pattern.exec(source)
  while (match) {
    if (!subscriptions.has(match[1])) subscriptions.set(match[1], lineOf(source, match.index))
    match = pattern.exec(source)
  }
  return subscriptions
}

function scanDenyCodes() {
  const source = readSource('main/services/ipc-security.js')
  const pattern = /deny\(\s*channel\s*,\s*'([a-z0-9-]+)'/g
  const found = new Map()
  let match = pattern.exec(source)
  while (match) {
    if (!found.has(match[1])) {
      found.set(match[1], {
        code: match[1],
        source: `main/services/ipc-security.js:${lineOf(source, match.index)}`,
        direction: 'deny',
        meaning: DENY_MEANINGS[match[1]] || 'authorization denied'
      })
    }
    match = pattern.exec(source)
  }
  return found
}

function scanBlockCodes() {
  const source = readSource('main/services/window-security.js')
  const pattern = /reportBlocked\([^,]+,\s*[^,]+,\s*'([a-z0-9-]+)'\)/g
  const found = new Map()
  let match = pattern.exec(source)
  while (match) {
    if (!found.has(match[1])) {
      found.set(match[1], {
        code: match[1],
        source: `main/services/window-security.js:${lineOf(source, match.index)}`,
        direction: 'block',
        meaning: BLOCK_MEANINGS[match[1]] || 'blocked by window security'
      })
    }
    match = pattern.exec(source)
  }
  return found
}

// ---------------------------------------------------------------------------
// Preload execution inside a vm sandbox
// ---------------------------------------------------------------------------

function runPreload(preloadRel) {
  const calls = []
  const exposed = []
  let exposedGlobal = ''
  let exposedApi = null
  const sandbox = {
    console,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    require: (name) => {
      if (name !== 'electron') throw new Error(`preload unexpectedly requires '${name}'`)
      return {
        contextBridge: {
          exposeInMainWorld: (globalName, api) => {
            exposedGlobal = globalName
            exposedApi = api
            exposed.push(globalName)
          }
        },
        ipcRenderer: {
          invoke: (channel, ...args) => {
            calls.push({ method: 'invoke', channel, args })
            return Promise.resolve(undefined)
          },
          send: (channel, ...args) => {
            calls.push({ method: 'send', channel, args })
          },
          on: (channel) => {
            calls.push({ method: 'on', channel })
            return () => {}
          },
          removeListener: (channel) => {
            calls.push({ method: 'removeListener', channel })
          }
        }
      }
    },
    module: { exports: {} },
    exports: {}
  }
  vm.createContext(sandbox)
  vm.runInContext(readSource(preloadRel), sandbox, { filename: preloadRel })
  if (exposed.length !== 1) {
    throw new Error(`${preloadRel} must expose exactly one global, found ${exposed.length}`)
  }
  return {
    globalObject: exposedGlobal,
    api: exposedApi,
    // Shared recording array: every ipcRenderer call made after module evaluation is
    // appended here, so probeMethod() can clear and read it per synthetic invocation.
    calls,
    // ipcRenderer.on() calls that ran while the module body was evaluated.
    moduleLevelSubscriptions: calls.filter((call) => call.method === 'on').map((call) => call.channel)
  }
}

function probeMethod(method, recorder) {
  let lastError = null
  for (const args of METHOD_CANDIDATE_ARGUMENTS) {
    recorder.length = 0
    let result
    try {
      result = method(...args)
    } catch (error) {
      lastError = error
      result = undefined
    }
    if (recorder.length) return { calls: recorder.slice(), result, error: null }
  }
  return { calls: [], result: undefined, error: lastError }
}

function classifyCalls(calls) {
  const ipcCalls = calls.filter((call) => call.method !== 'removeListener')
  if (!ipcCalls.length) return null
  const channels = uniqueSorted(ipcCalls.map((call) => call.channel))
  const methods = uniqueSorted(ipcCalls.map((call) => call.method))
  return { channels, methods, first: ipcCalls[0] }
}

const KIND_BY_IPC_METHOD = Object.freeze({ invoke: 'invoke', send: 'send', on: 'subscribe' })

// ---------------------------------------------------------------------------
// Test evidence index
// ---------------------------------------------------------------------------

function buildChannelTestIndex() {
  const testDirectory = path.join(ROOT, 'test')
  const files = fs.readdirSync(testDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => entry.name)
    .sort(compareStrings)
  const contents = files.map((name) => ({
    file: `test/${name}`,
    text: normalizeText(fs.readFileSync(path.join(testDirectory, name), 'utf8'))
  }))
  return function testsForChannel(channel) {
    const needles = [`'${channel}'`, `"${channel}"`, `\`${channel}\``]
    return contents
      .filter((entry) => needles.some((needle) => entry.text.includes(needle)))
      .map((entry) => entry.file)
  }
}

// ---------------------------------------------------------------------------
// Resource limits / shared schemas
// ---------------------------------------------------------------------------

function evaluateStaticLiteral(text) {
  return vm.runInNewContext(`(${text})`, {})
}

function loadModule(relativePath) {
  return require(absolute(relativePath))
}

function extractResourceLimit(spec) {
  try {
    const module = loadModule(spec.source)
    return { value: spec.build(module), extraction: 'module' }
  } catch (error) {
    const source = readSource(spec.source)
    const value = {}
    for (const [key, pattern] of Object.entries(spec.staticPatterns || {})) {
      const match = pattern.exec(source)
      if (!match) {
        throw new Error(`cannot extract resource limit ${spec.id}.${key} from ${spec.source}: ${error.message}`)
      }
      value[key] = evaluateStaticLiteral(match[1].trim())
    }
    return { value, extraction: 'static' }
  }
}

function extractSqliteUserVersion(relativePath, pattern) {
  const source = readSource(relativePath)
  const match = pattern.exec(source)
  if (!match) throw new Error(`cannot extract user_version from ${relativePath}`)
  return Number(match[1])
}

function existingTests(candidates) {
  return candidates.filter((candidate) => fileExists(candidate))
}

function buildResourceLimits() {
  return RESOURCE_LIMIT_SPECS
    .map((spec) => {
      const { value, extraction } = extractResourceLimit(spec)
      return {
        id: spec.id,
        value,
        source: spec.source,
        symbols: [...spec.symbols],
        extraction
      }
    })
    .sort((left, right) => compareStrings(left.id, right.id))
}

function buildSharedSchemas() {
  const entries = []
  for (const spec of SHARED_SCHEMA_SPECS) {
    const entry = {
      document: spec.document,
      path: spec.path
    }
    let version = null
    let extraction = 'module'
    if (spec.module) {
      const value = loadModule(spec.module)[spec.versionSymbol]
      if (value !== undefined) version = Number(value)
      else if (spec.staticPattern) extraction = 'static'
    } else if (Object.hasOwn(spec, 'version')) {
      version = spec.version
    }
    if (version === null && spec.staticPattern) {
      const match = spec.staticPattern.exec(readSource(spec.path))
      if (!match) throw new Error(`cannot extract ${spec.document} ${spec.versionSymbol} from ${spec.path}`)
      version = Number(match[1])
      extraction = 'static'
    }
    entry.version = version
    entry.versionSymbol = spec.versionSymbol
    entry.extraction = extraction
    if (spec.userVersionFrom) {
      if (spec.userVersionFrom.endsWith('.rs')) {
        entry.userVersion = extractSqliteUserVersion(spec.userVersionFrom, /PRAGMA\s+user_version\s*=\s*(\d+)/)
        if (spec.versionFromUserVersion) entry.version = entry.userVersion
      } else {
        // main/services/usage-store.js writes PRAGMA user_version = SCHEMA_VERSION.
        entry.userVersion = version
      }
    }
    if (spec.schemaPath) entry.schemaPath = spec.schemaPath
    if (spec.normalizeSymbol) entry.normalizeSymbol = spec.normalizeSymbol
    entry.tests = existingTests(spec.tests || [])
    entries.push(entry)
  }
  return entries.sort((left, right) => compareStrings(left.document, right.document))
}

// ---------------------------------------------------------------------------
// Auxiliary windows (preload/page pairs outside IPC_SURFACES)
// ---------------------------------------------------------------------------

function findAuxiliaryWindows(registeredPages, roleNames) {
  const sources = [
    path.join(ROOT, 'main.js'),
    ...listFilesRecursive(path.join(ROOT, 'main'), (name) => name.endsWith('.js'))
  ].sort(compareStrings)
  const registeredBasenames = new Set(registeredPages.map((page) => path.basename(page)))
  const found = new Map()
  for (const file of sources) {
    const relative = relativeFromRoot(file)
    const source = normalizeText(fs.readFileSync(file, 'utf8'))
    const preloadRefs = []
    const preloadPattern = /preload(?:-([a-z0-9-]+))?\.js/g
    let preloadMatch = preloadPattern.exec(source)
    while (preloadMatch) {
      preloadRefs.push(preloadMatch[1] || 'main')
      preloadMatch = preloadPattern.exec(source)
    }
    const htmlPattern = /['"]([A-Za-z0-9_.\-/]*\.html)['"]/g
    let htmlMatch = htmlPattern.exec(source)
    while (htmlMatch) {
      const reference = htmlMatch[1]
      const basename = path.basename(reference)
      if (registeredBasenames.has(basename)) {
        htmlMatch = htmlPattern.exec(source)
        continue
      }
      let page = ''
      if (reference.includes('/') && fileExists(reference)) {
        page = reference
      } else {
        const candidates = fs.readdirSync(ROOT, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .map((entry) => `${entry.name}/${basename}`)
          .filter((candidate) => fileExists(candidate))
          .sort(compareStrings)
        if (candidates.length === 1) page = candidates[0]
      }
      const line = lineOf(source, htmlMatch.index)
      const id = page || basename
      const entry = found.get(id) || { page: id, basenames: new Set(), roles: new Set(), sources: [] }
      entry.basenames.add(basename)
      for (const role of preloadRefs) {
        if (roleNames.includes(role)) entry.roles.add(role)
      }
      entry.sources.push(`${relative}:${line}`)
      found.set(id, entry)
      htmlMatch = htmlPattern.exec(source)
    }
  }
  return [...found.values()]
    .map((entry) => ({
      kind: 'auxiliary-window-not-in-ipc-surfaces',
      page: entry.page,
      basenames: [...entry.basenames].sort(compareStrings),
      roles: [...entry.roles].sort(compareStrings),
      sources: uniqueSorted(entry.sources),
      reason: 'the preload page is not registered in IPC_SURFACES, so every IPC channel from it is denied by page-not-allowed'
    }))
    .sort((left, right) => compareStrings(left.page, right.page))
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function permissionsDifference(role, kind, channel, surface) {
  const handles = surface.handles || []
  const listeners = surface.listeners || []
  if (kind === 'invoke' && !handles.includes(channel)) {
    return { kind: 'channel-not-in-handles', role, methodChannel: channel }
  }
  if (kind === 'send' && !listeners.includes(channel)) {
    return { kind: 'channel-not-in-listeners', role, methodChannel: channel }
  }
  if (kind === 'send' && handles.includes(channel)) {
    return { kind: 'channel-kind-mismatch', role, methodChannel: channel, expected: 'listeners' }
  }
  if (kind === 'invoke' && listeners.includes(channel)) {
    return { kind: 'channel-kind-mismatch', role, methodChannel: channel, expected: 'handles' }
  }
  return null
}

function extractRole(surface, preloadRel, testsForChannel) {
  const source = readSource(preloadRel)
  const execution = runPreload(preloadRel)
  const definitions = scanMethodDefinitions(source)
  const staticSubscriptions = scanSubscriptions(source)
  const knownGaps = []
  const methods = []
  const receives = []

  const exposedNames = Object.keys(execution.api).sort(compareStrings)
  for (const name of exposedNames) {
    if (!definitions.has(name)) {
      knownGaps.push({
        kind: 'method-definition-unparsed',
        role: surface.role,
        method: name,
        source: `${preloadRel}:0`,
        reason: 'the exposed method was found at runtime but its definition line could not be located in the source'
      })
    }
  }
  for (const name of [...definitions.keys()].sort(compareStrings)) {
    if (!exposedNames.includes(name)) {
      knownGaps.push({
        kind: 'method-not-exposed',
        role: surface.role,
        method: name,
        source: `${preloadRel}:${definitions.get(name).line}`,
        reason: 'the static scan found a method that the executed exposeInMainWorld object does not contain'
      })
    }
  }

  for (const name of exposedNames) {
    const definition = definitions.get(name) || { line: 0, params: '' }
    const probe = probeMethod(execution.api[name], execution.calls)
    const classified = classifyCalls(probe.calls)
    if (!classified) {
      knownGaps.push({
        kind: 'method-not-resolved',
        role: surface.role,
        method: name,
        source: `${preloadRel}:${definition.line}`,
        reason: probe.error
          ? `no IPC channel observed; the last synthetic call threw: ${probe.error.message}`
          : 'no IPC channel observed when the method was called with synthetic arguments'
      })
      continue
    }
    if (classified.channels.length > 1 || classified.methods.length > 1) {
      knownGaps.push({
        kind: 'method-multiple-channels',
        role: surface.role,
        method: name,
        source: `${preloadRel}:${definition.line}`,
        channels: classified.channels,
        ipcMethods: classified.methods,
        reason: 'one exposed method used more than one IPC channel or call kind; the contract records the first observed call'
      })
    }
    const channel = classified.first.channel
    const kind = KIND_BY_IPC_METHOD[classified.first.method]
    const params = definition.params.replace(/\s+/g, ' ').trim()
    const returns = kind === 'invoke'
      ? 'Promise<unknown>'
      : kind === 'send'
        ? 'void'
        : (typeof probe.result === 'function' ? 'unsubscribe function' : 'void')
    methods.push({
      name,
      kind,
      channel,
      call: `(${params})`,
      returns,
      source: `${preloadRel}:${definition.line}`,
      tests: testsForChannel(channel)
    })
    if (kind === 'subscribe' && !receives.includes(channel)) receives.push(channel)
    const difference = permissionsDifference(surface.role, kind, channel, surface)
    if (difference) {
      knownGaps.push({
        ...difference,
        method: name,
        source: `${preloadRel}:${definition.line}`,
        reason: `the ${kind} channel is not registered in IPC_SURFACES.${surface.role}.${kind === 'invoke' ? 'handles' : 'listeners'}`
      })
    }
  }

  for (const channel of uniqueSorted(execution.moduleLevelSubscriptions)) {
    receives.push(channel)
    knownGaps.push({
      kind: 'module-level-subscription',
      role: surface.role,
      channel,
      source: `${preloadRel}:${staticSubscriptions.get(channel) || 0}`,
      reason: 'the subscription is registered while the preload module body runs, so it is not attributable to one exposed method'
    })
  }

  methods.sort((left, right) => compareStrings(left.name, right.name))
  knownGaps.sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)))
  return {
    role: surface.role,
    page: surface.page,
    preload: preloadRel,
    globalObject: execution.globalObject,
    methods,
    surface: {
      handles: uniqueSorted(surface.handles || []),
      listeners: uniqueSorted(surface.listeners || []),
      receives: uniqueSorted(receives)
    },
    knownGaps
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildHostContracts() {
  const pkg = require(path.join(ROOT, 'package.json'))
  const { IPC_SURFACES } = require(path.join(ROOT, 'main/services/ipc-security.js'))
  const testsForChannel = buildChannelTestIndex()

  const roles = []
  const topLevelGaps = []
  const usedPreloads = new Set()
  const surfacesByRole = new Map(IPC_SURFACES.map((surface) => [surface.role, surface]))

  for (const surface of IPC_SURFACES) {
    const preloadRel = preloadFileForRole(surface.role)
    if (!fileExists(preloadRel)) {
      topLevelGaps.push({
        kind: 'preload-file-missing',
        role: surface.role,
        preload: preloadRel,
        reason: 'IPC_SURFACES declares the role but the conventional preload file does not exist'
      })
      continue
    }
    usedPreloads.add(preloadRel)
    roles.push(extractRole(surface, preloadRel, testsForChannel))
  }

  for (const preloadRel of listPreloadFiles()) {
    if (usedPreloads.has(preloadRel)) continue
    topLevelGaps.push({
      kind: 'preload-without-role',
      preload: preloadRel,
      globalObject: extractExposedGlobal(readSource(preloadRel)),
      reason: 'the preload exposes a global object but no IPC_SURFACES role maps to it'
    })
  }

  roles.sort((left, right) => compareStrings(left.role, right.role))

  const registeredPages = IPC_SURFACES.map((surface) => surface.page)
  const auxiliaryWindows = findAuxiliaryWindows(registeredPages, IPC_SURFACES.map((surface) => surface.role))
  topLevelGaps.push(...auxiliaryWindows)

  // Cross-check: every IPC_SURFACES role made it into the output once.
  for (const surface of IPC_SURFACES) {
    if (!roles.some((entry) => entry.role === surface.role)) {
      topLevelGaps.push({
        kind: 'role-missing-from-output',
        role: surface.role,
        reason: 'IPC_SURFACES declared the role but no role entry was extracted'
      })
    }
  }

  const errorCodes = [...scanDenyCodes().values(), ...scanBlockCodes().values()]
    .sort((left, right) => compareStrings(left.code, right.code))

  const plan = readSource(PLAN_REL)
  if (!plan.includes(BASELINE_COMMIT)) {
    throw new Error(`the declared baseline commit ${BASELINE_COMMIT} is not named in ${PLAN_REL}`)
  }

  return {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'highlighter.host-contracts',
    status: 'r0-draft',
    baseline: {
      appVersion: pkg.version,
      gitCommit: BASELINE_COMMIT,
      electron: String(pkg.devDependencies.electron),
      node: BASELINE_NODE
    },
    roles,
    errorCodes,
    resourceLimits: buildResourceLimits(),
    sharedSchemas: buildSharedSchemas(),
    knownGaps: topLevelGaps.sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)))
  }
}

function renderHostContracts(contracts) {
  return `${JSON.stringify(contracts, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

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

function printHeadHint() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const short = head.slice(0, 12)
    if (head !== BASELINE_COMMIT) {
      process.stderr.write(`note: declared baseline commit ${BASELINE_COMMIT.slice(0, 12)}; working HEAD is ${short}\n`)
    }
  } catch {
    // git is not required: the contract must build on a source archive too.
  }
}

function runCli(argv) {
  const mode = argv.find((argument) => argument === '--write' || argument === '--check')
  if (!mode || argv.length !== 1) {
    process.stderr.write('usage: node scripts/rust/extract-host-contracts.js --write|--check\n')
    return 2
  }
  const contracts = buildHostContracts()
  const text = renderHostContracts(contracts)
  const bytes = Buffer.byteLength(text, 'utf8')

  if (mode === '--write') {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
    fs.writeFileSync(OUTPUT_PATH, text, 'utf8')
    const methodCount = contracts.roles.reduce((sum, role) => sum + role.methods.length, 0)
    process.stdout.write(`wrote ${OUTPUT_REL}: ${contracts.roles.length} roles, ${methodCount} methods, ${bytes} bytes\n`)
    printHeadHint()
    return 0
  }

  const expected = fs.existsSync(OUTPUT_PATH) ? normalizeText(fs.readFileSync(OUTPUT_PATH, 'utf8')) : null
  if (expected === null) {
    process.stderr.write(`missing ${OUTPUT_REL}; run --write\n`)
    return 1
  }
  if (expected === text) {
    const methodCount = contracts.roles.reduce((sum, role) => sum + role.methods.length, 0)
    process.stdout.write(`${OUTPUT_REL} is up to date (${contracts.roles.length} roles, ${methodCount} methods, ${bytes} bytes)\n`)
    return 0
  }
  const sha = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
  process.stderr.write(`stale ${OUTPUT_REL}; run --write\n`)
  process.stderr.write(`  on-disk sha256=${sha(expected)} generated sha256=${sha(text)}\n`)
  const difference = firstDifference(text, expected)
  if (difference) {
    process.stderr.write(`  first difference at line ${difference.line}:\n`)
    process.stderr.write(`  - generated: ${difference.expected}\n`)
    process.stderr.write(`  + on-disk:   ${difference.actual}\n`)
  }
  return 1
}

module.exports = {
  BASELINE_COMMIT,
  CONTRACTS_SCHEMA_VERSION,
  OUTPUT_REL,
  buildHostContracts,
  renderHostContracts,
  // Exported for test/host-contracts.test.js (read-only helpers, no side effects).
  listPreloadFiles,
  preloadFileForRole,
  runPreload,
  scanBlockCodes,
  scanDenyCodes
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2))
}
